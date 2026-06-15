/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Directive: monitor-layout-editor
 *
 * Renders a tile canvas where each open monitor appears as a draggable
 * rectangle. The user arranges tiles to declare the virtual monitor layout
 * Windows should see. Apply emits a layout object back to the parent.
 *
 * Bindings:
 *  - monitors-infos: a Windows-logical snapshot of the monitor info
 *    (guacManageMonitor.getMonitorsInfosLogical(), captured by the host
 *    controller when the modal opens; read-only, and not mutated by the
 *    directive).
 *  - on-apply: callback fired with { layout } when the user clicks Apply
 *  - on-cancel: callback fired when the user clicks Cancel
 */
angular.module('client').directive('monitorLayoutEditor', ['$document', 'guacManageMonitor',
    function monitorLayoutEditor($document, guacManageMonitor) {

    return {
        restrict: 'E',
        replace: true,
        templateUrl: 'app/client/templates/monitorLayoutEditor.html',
        scope: {
            monitorsInfos: '=',
            initialOverride: '=',
            onApply: '&',
            onClose: '&',
            onAddScreen: '&',
            canAddScreen: '&'
        },
        link: function (scope, element) {

            // Canvas dimensions (CSS pixels for the tile canvas). Width fills
            // the modal (measured live); height adapts to the layout's aspect
            // ratio within this band. Both are recomputed every buildTiles().
            scope.canvasWidth = 800;
            scope.canvasHeight = 400;
            var CANVAS_MIN_H = 340;   // room to drag monitors above/below
            var CANVAS_MAX_H = 560;   // keep the canvas from dominating the modal
            // Upper bound on the auto-fit (open) real-px to canvas-px scale.
            // Without it a one- or two-monitor layout fills the whole canvas
            // (large tiles, no room to arrange). At 0.1 a 1920px monitor renders
            // as a 192px tile. Many or large monitors fit below this cap, so
            // they still never clip. Manual zoom (below) may exceed it up to
            // SCALE_MAX.
            var MAX_SCALE = 0.1;
            // Hard bounds on the user-controlled zoom. SCALE_MAX allows zooming
            // in past the auto-fit cap for fine placement; SCALE_MIN keeps
            // zoom-out from collapsing the layout to nothing.
            var SCALE_MIN = 0.005;
            var SCALE_MAX = 0.4;
            var ZOOM_STEP = 1.25;     // per zoom-button press

            // Real-pixels-per-tile-pixel scale. The canvas is a viewport: tiles
            // render at primaryOrigin + logicalOffset * scale. Auto-fit sets
            // this on open, the zoom buttons adjust it, and pan translates all
            // tiles.
            scope.scale = 0.1;
            // Zoom readout (percent of the auto-fit-on-open scale), shown in the
            // toolbar. 100% is the framing chosen when the modal opened.
            scope.zoomPercent = 100;
            var fitScaleRef = 0.1;    // the auto-fit scale, used as the 100% ref

            // The recessed canvas element, used to measure the width actually
            // available inside the modal so the preview fills it responsively.
            var canvasEl = null;
            function availableCanvasWidth() {
                if (!canvasEl) canvasEl = element[0].querySelector('.layout-canvas');
                // getBoundingClientRect reflects the real rendered width (the
                // canvas is width:100% of the modal); clientWidth can read 0
                // before first layout.
                var c = canvasEl && canvasEl.getBoundingClientRect
                    ? canvasEl.getBoundingClientRect().width : 0;
                if (c && c > 0) return Math.round(c);
                // Not laid out yet: fall back to the modal's content width
                // (host clientWidth minus its horizontal padding), then 800.
                var host = element[0] && element[0].clientWidth;
                if (host && host > 0) return Math.max(320, host - 44);
                return 800;
            }

            // Tiles in canvas-pixel space
            scope.tiles = [];

            // Cached derived state. Recomputed on mutation rather than in
            // template expressions, since an expression that returns a fresh
            // reference every digest drives ng-repeat into $rootScope:infdig.
            scope.wireLayout = {};
            scope.warningMsgs = [];   // [{ key, values }], translated in the template
            // True when the edited layout differs from what Windows currently
            // has (Apply would change something). Drives the footer status line,
            // the Apply button state, and the changed-row highlight.
            scope.modified = false;
            // Snapshot of the applied layout (per-id offsets), captured on open
            // and after Apply. modified means the current layout differs from
            // this.
            var baselineLayout = null;
            function setBaseline() {
                baselineLayout = {};
                for (var id in scope.wireLayout) {
                    if (Object.prototype.hasOwnProperty.call(scope.wireLayout, id))
                        baselineLayout[id] = {
                            leftOffset: scope.wireLayout[id].leftOffset,
                            topOffset:  scope.wireLayout[id].topOffset
                        };
                }
                scope.modified = false;
                for (var i = 0; i < scope.tiles.length; i++) scope.tiles[i].changed = false;
            }

            // Currently-dragging tile id, or null
            scope.dragging = null;
            var dragOffset = { x: 0, y: 0 };

            // Currently-selected tile id (for keyboard nudge), or null
            scope.selectedId = null;

            scope.selectTile = function selectTile(tile) {
                scope.selectedId = tile.id;
            };

            /**
             * Read-only accessor for the "Windows currently has" columns.
             * Returns the requested field from monitorsInfos.rendered[id].
             * The bound monitorsInfos is the logical snapshot taken when the
             * modal opened (device px / sessionDpr), so this is in the same
             * Windows-logical units the user enters, not the raw device-px wire
             * values. Returns '—' if no rendered info exists yet. Returns a
             * primitive, never an object reference: binding to functions that
             * return fresh objects sends Angular's digest into infdig.
             */
            scope.rendered = function rendered(id, key) {
                var rs = scope.monitorsInfos && scope.monitorsInfos.rendered;
                if (!rs || !rs[id] || rs[id][key] === undefined) return '—';
                return rs[id][key];
            };

            /**
             * Rebuild scope.tiles from monitorsInfos.details. Lays out the
             * primary at center and stacks the others to the right
             * cumulatively. Called on initial activation and whenever
             * monitorsInfos.details changes shape.
             */
            function buildTiles(skipOverride) {

                var details = scope.monitorsInfos && scope.monitorsInfos.details;
                if (!details) { scope.tiles = []; return; }

                var rendered = scope.monitorsInfos && scope.monitorsInfos.rendered;

                var ids = Object.keys(details).sort(function (a, b) {
                    return Number(a) - Number(b);
                });
                if (ids.length === 0) { scope.tiles = []; return; }

                /* Tile dimensions come from monitorsInfos.rendered (the layout
                 * guacd actually committed) when available, falling back to
                 * monitorsInfos.details only for a freshly-added monitor guacd
                 * has not echoed yet. rendered is the authoritative,
                 * internally-consistent source; details is the client's
                 * reported size, which for the primary can carry an extra
                 * devicePixelRatio factor (the primary reaches guacd via the
                 * connect handshake, not the size-opcode path, so its details
                 * and committed geometry diverge by the session DPR). Sourcing
                 * dims from rendered keeps the primary tile consistent in width
                 * with secondaries seeded from rendered, so the whole canvas
                 * stays in one space and contiguous monitors do not appear to
                 * overlap. */
                function dimsFor(id) {
                    var r = rendered && rendered[id];
                    if (r && typeof r.width === 'number' && r.width > 0
                          && typeof r.height === 'number' && r.height > 0)
                        return r;
                    return details[id];
                }

                /* ---- Pass 1: seed a real-pixel layout map (Windows-logical
                 * px, offsets relative to the primary anchored at 0,0).
                 *
                 * Priority per non-primary monitor:
                 *   1. initialOverride: the user's last-applied layout.
                 *   2. monitorsInfos.rendered: the live committed layout from
                 *      guacd (covers a newly-opened monitor not yet in any
                 *      override).
                 *   3. cumulative default: packed left-to-right after the
                 *      monitors placed so far.
                 * skipOverride (Reset) ignores 1 and 2 and uses only the clean
                 * cumulative default. */
                var ov = scope.initialOverride;
                var map = {};
                var packX = 0;   // running right edge for the cumulative default
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    var d = dimsFor(id);
                    var w = d.width || 1920, h = d.height || 1080;
                    var left, top;

                    if (Number(id) === 0) {
                        left = 0; top = 0;
                    } else {
                        var entry = (!skipOverride && ov && typeof ov === 'object') ? ov[id] : null;
                        var hasEntry = entry
                            && typeof entry.leftOffset === 'number'
                            && typeof entry.topOffset === 'number';
                        if (!hasEntry && !skipOverride && rendered && rendered[id]
                                && typeof rendered[id].left === 'number'
                                && typeof rendered[id].top === 'number') {
                            entry = { leftOffset: rendered[id].left, topOffset: rendered[id].top };
                            hasEntry = true;
                        }
                        if (hasEntry) { left = entry.leftOffset; top = entry.topOffset; }
                        else { left = packX; top = 0; }   // cumulative default
                    }

                    map[id] = { width: w, height: h, left: left, top: top };
                    packX = Math.max(packX, left + w);
                }

                /* ---- Pass 2: re-flow to the canonical valid arrangement
                 * (gap-free, overlap-free, primary-anchored) so the modal shows
                 * the same layout the wire sends, rather than a stale-override
                 * or mid-resize gap that would raise a spurious warning. No-op
                 * for an already-valid layout. Skipped on Reset (the cumulative
                 * default is already valid). */
                if (!skipOverride) {
                    var arr = guacManageMonitor.normalizeLayout(
                            map, { arrange: true, evenWidth: false }).monitors;
                    if (arr) map = arr;
                }

                /* ---- Pass 3: render into the viewport.
                 * Auto-fit (re-frame, re-center, re-derive canvas height) runs
                 * only on a structural change: the modal opening, a Reset, or
                 * the set of monitors changing (add/remove). Otherwise (a live
                 * resize, or a re-render after the user has zoomed/panned) the
                 * current viewport is preserved so the user's zoom and pan are
                 * kept; the tiles are simply re-placed at the current scale and
                 * origin. */
                var idSig = ids.join(',');
                var structural = skipOverride || lastIdSig === null || idSig !== lastIdSig;
                lastIdSig = idSig;

                var origin = structural ? null : currentOrigin();
                if (origin) placeTiles(map, origin.x, origin.y);
                else fitAndPlace(map, true);

                /* Re-baseline on a build that reflects the applied layout (open,
                 * add/remove, live resize) so it opens in sync. A Reset
                 * (skipOverride) is a user change that still needs applying, so
                 * it does not re-baseline and reads as modified. */
                if (!skipOverride) setBaseline();

                /* Start watching the canvas's rendered size (idempotent) so a
                 * post-open layout settle (scrollbar/zoom) re-fits. */
                watchCanvasSize();
            }

            // Monitor id-set of the last build, to decide fit-vs-preserve above.
            var lastIdSig = null;

            /** Current viewport origin = the primary tile's canvas position
             *  (primary is logical 0,0). Null before the first build. */
            function currentOrigin() {
                var p = scope.tiles && scope.tiles.find(function (t) { return t.isPrimary; });
                return p ? { x: p.x, y: p.y } : null;
            }

            /**
             * Position scope.tiles from a logical map at the current scale, with
             * the primary anchored at (originX, originY): render the viewport
             * without changing zoom or canvas size. This is the no-fit sibling
             * of fitAndPlace, used for every interactive arrange and for
             * preserving the view on a live re-render.
             *
             * @param {!Object} map  id -> { width, height, left, top } (logical px)
             */
            function placeTiles(map, originX, originY) {
                var ids = Object.keys(map).sort(function (a, b) {
                    return Number(a) - Number(b);
                });
                if (ids.length === 0) { scope.tiles = []; recompute(); return; }
                var scale = scope.scale;
                var newTiles = [];
                for (var j = 0; j < ids.length; j++) {
                    var jid = ids[j];
                    var jm = map[jid];
                    newTiles.push({
                        id: jid,
                        x: originX + jm.left * scale,
                        y: originY + jm.top  * scale,
                        width:  jm.width  * scale,
                        height: jm.height * scale,
                        isPrimary: Number(jid) === 0,
                        realWidth:  jm.width  || 0,
                        realHeight: jm.height || 0
                    });
                }
                scope.tiles = newTiles;
                recompute();
            }

            /**
             * Auto-fit: measure the layout's 2-D bounding box, choose a scale
             * that frames it inside the canvas on both axes (capped at MAX_SCALE
             * so a small monitor count does not render oversized), center it,
             * and render. Establishes the zoom reference (100%). Used on open,
             * Reset, and monitor add/remove. Manual zoom and pan afterwards are
             * left in place.
             *
             * @param {!Object} map  id -> { width, height, left, top } (logical px)
             * @param {boolean} recomputeCanvasDims  also re-measure canvas W/H.
             */
            function fitAndPlace(map, recomputeCanvasDims) {
                var ids = Object.keys(map).sort(function (a, b) {
                    return Number(a) - Number(b);
                });
                if (ids.length === 0) { scope.tiles = []; recompute(); return; }

                // Bounding box of the layout (canonical helper, the same math
                // the service's validator/extent uses, kept in one place).
                var ext = guacManageMonitor.layoutExtent(map);
                var minX = ext.minLeft, minY = ext.minTop;
                var bboxW = Math.max(1, ext.width);
                var bboxH = Math.max(1, ext.height);

                var PAD = 28;   // breathing room inside the canvas (px, both sides)

                if (recomputeCanvasDims) {
                    var availW = availableCanvasWidth();
                    scope.canvasWidth = availW;
                    /* Canvas height is the larger of a comfortable landscape
                     * height (~0.45 * width, so wide strips keep vertical room
                     * to drag monitors above/below) and the layout's own
                     * aspect-ratio height (so a tall stack gets a taller canvas
                     * and larger tiles), clamped to a sane band. */
                    var aspect = bboxH / bboxW;
                    var aspectH    = Math.round((availW - PAD) * aspect + PAD);
                    var landscapeH = Math.round(availW * 0.45);
                    scope.canvasHeight = Math.max(CANVAS_MIN_H, Math.min(CANVAS_MAX_H,
                            Math.max(landscapeH, aspectH)));
                }

                var fitScale = Math.min(
                    (scope.canvasWidth  - PAD) / bboxW,
                    (scope.canvasHeight - PAD) / bboxH,
                    MAX_SCALE
                );
                if (!isFinite(fitScale) || fitScale <= 0) fitScale = 0.1;
                scope.scale = fitScale;
                fitScaleRef = fitScale;       // this framing == 100% zoom
                scope.zoomPercent = 100;

                // Center the framed layout: primary (logical 0,0) sits at origin.
                var contentW = bboxW * fitScale, contentH = bboxH * fitScale;
                var originX = (scope.canvasWidth  - contentW) / 2 - minX * fitScale;
                var originY = (scope.canvasHeight - contentH) / 2 - minY * fitScale;
                placeTiles(map, originX, originY);
            }

            /* ---- Viewport pan + zoom -------------------------------------
             * The canvas is a viewport over the monitor coordinate space. Pan
             * and zoom are pure view transforms: they move and scale every tile
             * together, leaving each tile's offset relative to the primary (and
             * therefore wireLayout) unchanged. This is what allows placing a
             * monitor on a crowded side: zoom out to open space, pan to reach
             * it, drop the monitor there. */

            /** Translate every tile by (dx,dy) canvas px (no clamp). */
            function panBy(dx, dy) {
                for (var i = 0; i < scope.tiles.length; i++) {
                    scope.tiles[i].x += dx;
                    scope.tiles[i].y += dy;
                }
            }

            /** Zoom by `factor` about the canvas center, clamped to
             *  [SCALE_MIN, SCALE_MAX]. Scales each tile's position (about the
             *  center) and size plus scope.scale by the same amount, so logical
             *  offsets stay invariant. */
            function zoomBy(factor) {
                var target = Math.max(SCALE_MIN, Math.min(SCALE_MAX, scope.scale * factor));
                var f = target / scope.scale;
                if (Math.abs(f - 1) < 1e-9) return;
                var cx = scope.canvasWidth / 2, cy = scope.canvasHeight / 2;
                for (var i = 0; i < scope.tiles.length; i++) {
                    var t = scope.tiles[i];
                    t.x = cx + (t.x - cx) * f;
                    t.y = cy + (t.y - cy) * f;
                    t.width  *= f;
                    t.height *= f;
                }
                scope.scale = target;
                scope.zoomPercent = fitScaleRef > 0
                    ? Math.round(scope.scale / fitScaleRef * 100) : 100;
            }

            scope.zoomIn  = function zoomIn()  { zoomBy(ZOOM_STEP);     recompute(); };
            scope.zoomOut = function zoomOut() { zoomBy(1 / ZOOM_STEP); recompute(); };
            scope.canZoomIn  = function () { return scope.scale < SCALE_MAX - 1e-9; };
            scope.canZoomOut = function () { return scope.scale > SCALE_MIN + 1e-9; };

            /* Build a logical-px layout map ({id:{width,height,left,top}}) from
             * the current tile positions, relative to the primary at (0,0).
             * Shared by fitView and autoArrange. */
            function tilesToLogicalMap(primary) {
                var map = {};
                for (var i = 0; i < scope.tiles.length; i++) {
                    var t = scope.tiles[i];
                    map[t.id] = {
                        width:  t.realWidth,
                        height: t.realHeight,
                        left:   Math.round((t.x - primary.x) / scope.scale),
                        top:    Math.round((t.y - primary.y) / scope.scale)
                    };
                }
                return map;
            }

            /** Re-frame the current arrangement so every screen is visible and
             *  centered, resetting zoom and pan. Recovers the view when the
             *  tiles have been panned or zoomed out of sight. Re-uses the
             *  auto-fit path on the layout derived from the current tiles. */
            scope.fitView = function fitView() {
                var primary = scope.tiles.find(function (t) { return t.isPrimary; });
                if (!primary) return;
                fitAndPlace(tilesToLogicalMap(primary), true);   // re-frame, recenter, reset zoom to 100%
            };

            /**
             * Auto-arrange the just-moved tile to a valid layout (no gap, no
             * overlap) by round-tripping the current tile positions through the
             * canonical normalizeLayout(arrange) in logical px, then writing the
             * corrected positions back to the tiles. Arrangement is centralized
             * in the pure service function. This makes the modal behave like
             * the Windows Display Settings panel: the layout can never have a
             * gap or overlap. Windows silently rejects such MS-RDPEDISP layouts,
             * whereas xrdp tolerates them, so Linux VMs accept them but Windows
             * VMs do not.
             *
             * With a movedId, that tile is the anchor (kept where the user
             * dropped it) and everything else re-flows around it. With no
             * movedId, the whole layout is re-flowed to the canonical valid
             * arrangement (re-attaching any detached or gapped monitor to the
             * primary), used when seeding the modal so it shows the same layout
             * the wire computes.
             */
            function autoArrange(movedId) {
                var primary = scope.tiles.find(function (t) { return t.isPrimary; });
                if (!primary) return;

                // Build a logical-px layout map from current tile positions.
                var map = tilesToLogicalMap(primary);

                /* evenWidth:false: the modal arranges in Windows-logical px and
                 * renders tiles at their un-evened logical width, so the arrange
                 * math must use those same widths. Forcing even width here would
                 * snap a flush edge 1px off and trip a false overlap warning.
                 * Even width is enforced on the device wire by sendSize/guacd,
                 * not in this logical-space arrange. */
                var opts = { arrange: true, evenWidth: false };
                if (movedId != null) opts.movedId = String(movedId);
                var result = guacManageMonitor.normalizeLayout(map, opts);

                /* Re-place at the current viewport (scale and origin preserved):
                 * the arrange may have moved tiles, but the user's zoom and pan
                 * are kept rather than auto-re-fitting, which would yank the
                 * view. If the arrangement grows beyond the canvas, the user
                 * zooms out or pans to see it, per the viewport model. */
                placeTiles(result.monitors, primary.x, primary.y);
            }

            /**
             * Recompute wireLayout, warningMsgs, and the per-tile warn flag
             * from current tile positions. Called after every mutation
             * (buildTiles, mouse drag). Not called from a template expression,
             * which would re-trigger the digest infinitely.
             */
            function recompute() {
                var primary = scope.tiles.find(function (t) { return t.isPrimary; });
                var layout = {};
                var msgs = [];
                for (var i = 0; i < scope.tiles.length; i++) {
                    var t = scope.tiles[i];
                    var leftOff = primary
                        ? Math.round((t.x - primary.x) / scope.scale) : 0;
                    var topOff = primary
                        ? Math.round((t.y - primary.y) / scope.scale) : 0;
                    layout[t.id] = { leftOffset: leftOff, topOffset: topOff };
                    t.warn = false;
                }

                /* MS-RDPEDISP validity check: Windows silently rejects any
                 * layout where monitors overlap or where a monitor is not part
                 * of the primary's edge-connected group (xrdp/Linux is lenient,
                 * Windows is strict).
                 *
                 * This uses the same logical-space validity the wire enforces
                 * (rectsOverlap + reachableFromPrimary) rather than a separate
                 * canvas-pixel geometry test. A per-tile pixel check would
                 * false-warn on layouts the wire considers valid: at larger
                 * scales, sub-pixel rounding flips the edge-adjacency tolerance
                 * and flags a contiguous layout as gapped. Checking in integer
                 * logical px (the values actually sent) keeps the modal's
                 * warnings in lock-step with the wire. */
                var lmap = {};
                for (var p = 0; p < scope.tiles.length; p++) {
                    var pt = scope.tiles[p];
                    lmap[pt.id] = {
                        width:  pt.realWidth,
                        height: pt.realHeight,
                        left:   layout[pt.id].leftOffset,
                        top:    layout[pt.id].topOffset
                    };
                }
                var reach = guacManageMonitor.reachableFromPrimary(lmap);
                for (var a = 0; a < scope.tiles.length; a++) {
                    var ta = scope.tiles[a];
                    if (ta.isPrimary) continue;

                    var overlaps = false;
                    for (var b = 0; b < scope.tiles.length; b++) {
                        if (a === b) continue;
                        if (guacManageMonitor.rectsOverlap(lmap[ta.id], lmap[scope.tiles[b].id])) {
                            overlaps = true;
                            break;
                        }
                    }

                    if (overlaps) {
                        ta.warn = true;
                        msgs.push({ key: 'CLIENT.WARNING_MONITOR_OVERLAP',
                                    values: { ID: ta.id } });
                    } else if (!reach[ta.id]) {
                        ta.warn = true;
                        msgs.push({ key: 'CLIENT.WARNING_MONITOR_GAP',
                                    values: { ID: ta.id } });
                    }
                }

                /* Combined-extent check: guacd composites every monitor into one
                 * display surface capped at GUAC_DISPLAY_MAX_WIDTH x
                 * GUAC_DISPLAY_MAX_HEIGHT. A bounding box larger than that is
                 * silently clipped, and the region past the edge renders white.
                 * Unlike gap/overlap (which the wire auto-repairs), this cannot
                 * be fixed by re-flowing, since a row stays the same width, so
                 * it blocks Apply rather than only warning. The specific screens
                 * that fall partly outside the renderable window are flagged so
                 * the user sees which ones go white. */
                var W = guacManageMonitor.GUAC_DISPLAY_MAX_WIDTH;
                var H = guacManageMonitor.GUAC_DISPLAY_MAX_HEIGHT;
                var ext = guacManageMonitor.layoutExtent(lmap);
                scope.overLimit = (ext.width > W || ext.height > H);
                if (scope.overLimit) {
                    msgs.push({ key: 'CLIENT.WARNING_LAYOUT_TOO_LARGE',
                                values: { WIDTH: ext.width, HEIGHT: ext.height,
                                          MAXWIDTH: W, MAXHEIGHT: H } });
                    for (var e = 0; e < scope.tiles.length; e++) {
                        var et = scope.tiles[e];
                        var er = lmap[et.id];
                        if ((er.left - ext.minLeft + er.width)  > W
                                || (er.top - ext.minTop + er.height) > H)
                            et.warn = true;
                    }
                }

                scope.wireLayout = layout;

                /* Modified state: does the edited layout differ from the
                 * baseline (the applied layout captured on open and after
                 * Apply)? If so, Apply would change something, so surface it
                 * (footer status, Apply emphasis) and flag which screens differ
                 * (changed-row gutter). Compared editor-space to editor-space,
                 * so committed/even-width rounding never false-flags as
                 * modified. baselineLayout is null only during the first build,
                 * before setBaseline runs, which is treated as clean. */
                var modified = false;
                for (var k = 0; k < scope.tiles.length; k++) {
                    var tk = scope.tiles[k];
                    tk.changed = false;
                    if (tk.isPrimary || !baselineLayout) continue;
                    var cur = layout[tk.id];
                    var base = baselineLayout[tk.id];
                    if (!base || cur.leftOffset !== base.leftOffset
                              || cur.topOffset  !== base.topOffset) {
                        tk.changed = true;
                        modified = true;
                    }
                }
                scope.modified = modified;
                scope.warningMsgs = msgs;
            }

            /**
             * Signature of the live monitor geometry: the set of monitors plus
             * each one's device size and committed (rendered) rect. Used to keep
             * the editor in sync with all windows. Whenever any of this changes
             * (a monitor added or removed, or a monitor resized or repositioned
             * by a popup-window resize, the service's resize auto-fix, or the
             * close re-flow), the tiles are rebuilt so the canvas always mirrors
             * the live layout, not only on a monitor-count change. Returns a
             * primitive string so $watch compares by value (no infdig).
             * buildTiles does not mutate any of these inputs, so the watch
             * settles in one pass.
             */
            function layoutSignature() {
                var mi = scope.monitorsInfos;
                if (!mi || !mi.details) return '';
                var r = mi.rendered || {};
                var ids = Object.keys(mi.details).sort(function (a, b) {
                    return Number(a) - Number(b);
                });
                var sig = '';
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    var d = mi.details[id] || {};
                    var rr = r[id] || {};
                    sig += id + '#' + (d.width || 0) + 'x' + (d.height || 0)
                         + '@' + (rr.left || 0) + ',' + (rr.top || 0)
                         + ',' + (rr.width || 0) + ',' + (rr.height || 0) + ';';
                }
                return sig;
            }

            // Initial build + rebuild whenever the live geometry changes.
            scope.$watch(layoutSignature, function () { buildTiles(); });

            /* Re-frame to the canvas's current width, skipping mid-drag/pan.
             * A width change is a pure view concern: re-fit the viewport around
             * the current tiles (tilesToLogicalMap, as fitView does). Re-seeding
             * via buildTiles here would discard unsaved edits (tiles re-read
             * from the applied layout) and reset the modified flag mid-edit. The
             * $evalAsync coalesces bursts into the next digest. Shared by both
             * triggers below. */
            function refitToWidth() {
                if (scope.dragging !== null || scope.panning) return;
                scope.$evalAsync(function () {
                    var primary = scope.tiles
                        && scope.tiles.find(function (t) { return t.isPrimary; });
                    if (primary)
                        fitAndPlace(tilesToLogicalMap(primary), true);
                    else {
                        lastIdSig = null;
                        buildTiles();
                    }
                });
            }

            /* Two triggers re-frame to the available width:
             *  - window resize (the modal is width-responsive, and this is also
             *    the no-ResizeObserver fallback), and
             *  - the canvas's own width settling or changing, which a window
             *    'resize' does not cover: a scrollbar appearing or browser zoom
             *    can change the canvas width a frame after the first measure.
             *    ResizeObserver re-fits automatically, on width only so that
             *    canvasHeight changes made by the re-fit itself do not loop. */
            window.addEventListener('resize', refitToWidth);
            var canvasRO = null, lastObservedW = 0;
            function watchCanvasSize() {
                if (canvasRO || typeof ResizeObserver === 'undefined') return;
                if (!canvasEl) canvasEl = element[0].querySelector('.layout-canvas');
                if (!canvasEl) return;
                lastObservedW = Math.round(canvasEl.getBoundingClientRect().width);
                canvasRO = new ResizeObserver(function () {
                    var w = Math.round(canvasEl.getBoundingClientRect().width);
                    if (Math.abs(w - lastObservedW) <= 1) return;  // ignore height-only (the re-fit itself)
                    lastObservedW = w;
                    refitToWidth();
                });
                canvasRO.observe(canvasEl);
            }
            scope.$on('$destroy', function () {
                window.removeEventListener('resize', refitToWidth);
                if (canvasRO) canvasRO.disconnect();
            });

            // Pan state: pointer position at the previous pan mousemove.
            scope.panning = false;
            var panLast = { x: 0, y: 0 };

            /**
             * Mouse down on a tile starts dragging it. The dragOffset captures
             * where on the tile the pointer grabbed so the tile does not snap to
             * the pointer location. stopPropagation keeps the canvas-background
             * pan handler from also firing.
             */
            scope.startDrag = function startDrag(event, tile) {
                if (event.button !== 0) return;   // left button only
                event.preventDefault();
                if (event.stopPropagation) event.stopPropagation();
                scope.dragging = tile.id;
                var rect = element[0].querySelector('.layout-canvas').getBoundingClientRect();
                dragOffset.x = event.clientX - rect.left - tile.x;
                dragOffset.y = event.clientY - rect.top - tile.y;
            };

            /**
             * Mouse down on empty canvas space starts a viewport pan. Fires only
             * for the canvas background itself; a mousedown on a tile is caught
             * by startDrag, which stops propagation.
             */
            scope.startPan = function startPan(event) {
                if (event.button !== 0) return;   // left button only
                if (event.target !== event.currentTarget) return; // clicked a tile/child
                event.preventDefault();
                scope.panning = true;
                scope.selectedId = null;          // empty-canvas click deselects
                panLast.x = event.clientX;
                panLast.y = event.clientY;
            };

            function onMouseMove(event) {
                // Viewport pan: translate every tile by the pointer delta.
                if (scope.panning) {
                    var pdx = event.clientX - panLast.x;
                    var pdy = event.clientY - panLast.y;
                    panLast.x = event.clientX;
                    panLast.y = event.clientY;
                    scope.$apply(function () { panBy(pdx, pdy); recompute(); });
                    return;
                }

                if (scope.dragging === null) return;
                var rect = element[0].querySelector('.layout-canvas').getBoundingClientRect();
                var tile = scope.tiles.find(function (t) { return t.id === scope.dragging; });
                if (!tile) return;
                var newX = event.clientX - rect.left - dragOffset.x;
                var newY = event.clientY - rect.top - dragOffset.y;

                /* Dragging the main screen moves the whole group together (a
                 * pan): every tile shifts by the same delta, so offsets relative
                 * to the primary, and thus the wire layout, are unchanged. The
                 * empty-canvas background drag pans as well. No clamp, since the
                 * canvas is a viewport. */
                if (tile.isPrimary) {
                    var dx = newX - tile.x;
                    var dy = newY - tile.y;
                    scope.$apply(function () { panBy(dx, dy); recompute(); });
                    return;
                }

                /* A secondary screen drags freely with no clamp, so it can be
                 * placed on a crowded side; the layout re-flows on drop. */
                scope.$apply(function () {
                    tile.x = newX;
                    tile.y = newY;
                    recompute();
                });
            }

            function onMouseUp() {
                if (scope.panning) {
                    scope.$apply(function () { scope.panning = false; });
                    return;
                }
                if (scope.dragging !== null) {
                    scope.$apply(function () {
                        var draggedId = scope.dragging;
                        scope.dragging = null;
                        var tile = scope.tiles.find(
                            function (t) { return t.id === draggedId; });
                        if (tile) {
                            /* Main-screen drag is a whole-group pan: relative
                             * offsets are unchanged, so the layout's validity is
                             * unchanged. Skip auto-arrange, which would otherwise
                             * re-anchor on the moved primary. A secondary drop
                             * re-flows to a valid arrangement. */
                            if (!tile.isPrimary) autoArrange(tile.id);
                            recompute();
                        }
                    });
                }
            }

            /**
             * Global key listener that nudges the selected tile by 1 real
             * pixel per press (Shift = 10 px for coarse moves). Ignored while
             * typing in a coordinate input so the inputs remain usable.
             *
             * Uses document.activeElement rather than event.target, because
             * once an $apply causes an ng-repeat re-render, event.target can
             * become a stale node detached from the DOM. Guards scope.$apply
             * with $$phase so a keydown that fires while an unrelated digest is
             * in flight does not throw "$digest already in progress" and
             * silently drop the nudge.
             */
            function onKeyDown(event) {
                var keyCode = event.keyCode;
                if (keyCode < 37 || keyCode > 40) return;
                if (scope.selectedId === null) return;

                /* Yield arrow keys only to the modal's own coordinate inputs,
                 * so the user can edit a number normally. The yield is limited
                 * to those inputs rather than every focused input or textarea:
                 * the hidden keyboard-sink <textarea> holds focus while the
                 * client is focused, and a broad input/textarea guard would let
                 * that sink swallow the nudge entirely. activeElement gives the
                 * truly-focused element rather than whatever bubbled. */
                var active = document.activeElement;
                if (active && active.classList
                        && active.classList.contains('coord-input'))
                    return;

                var tile = null;
                for (var i = 0; i < scope.tiles.length; i++) {
                    if (scope.tiles[i].id === scope.selectedId) {
                        tile = scope.tiles[i];
                        break;
                    }
                }
                if (!tile || tile.isPrimary) return;

                event.preventDefault();

                var step = event.shiftKey ? 10 : 1;
                var dx = (keyCode === 39 ? 1 : 0) - (keyCode === 37 ? 1 : 0);
                var dy = (keyCode === 40 ? 1 : 0) - (keyCode === 38 ? 1 : 0);

                /* No canvas-bounds clamp: the canvas is a viewport, so a nudge
                 * may move a tile toward or past an edge to reach a new side.
                 * autoArrange below keeps the layout valid, and the viewport
                 * pans or zooms to follow. */
                var newX = tile.x + dx * step * scope.scale;
                var newY = tile.y + dy * step * scope.scale;

                if (newX === tile.x && newY === tile.y) return;

                /* Auto-arrange after each nudge so arrow keys can never leave
                 * an invalid (gap/overlap) layout. The arrange skips a tile
                 * that is already valid, so sliding along a shared edge moves
                 * freely; only a nudge that would break validity is snapped
                 * back to the nearest valid position. Same path as drag. */
                function mutate() {
                    tile.x = newX;
                    tile.y = newY;
                    autoArrange(tile.id);
                    recompute();
                }

                if (scope.$root.$$phase) mutate();
                else scope.$apply(mutate);
            }

            $document.on('mousemove', onMouseMove);
            $document.on('mouseup', onMouseUp);
            $document.on('keydown', onKeyDown);
            scope.$on('$destroy', function () {
                $document.off('mousemove', onMouseMove);
                $document.off('mouseup', onMouseUp);
                $document.off('keydown', onKeyDown);
            });

            /**
             * Bound to ng-change on the per-tile coord input fields.
             * Reads the (already-updated) wireLayout[tile.id] values
             * back into tile.x/tile.y so the canvas tile follows the
             * numeric input. Then recompute() re-derives wireLayout
             * (idempotent modulo rounding) and refreshes warnings.
             */
            scope.onWireChange = function onWireChange(tile) {
                if (tile.isPrimary) return;
                var primary = scope.tiles.find(function (t) { return t.isPrimary; });
                if (!primary) return;
                var wl = scope.wireLayout[tile.id];
                if (!wl) return;
                var leftOff = Number(wl.leftOffset);
                var topOff  = Number(wl.topOffset);
                if (!isFinite(leftOff) || !isFinite(topOff)) return;
                tile.x = primary.x + leftOff * scope.scale;
                tile.y = primary.y + topOff  * scope.scale;
                autoArrange(tile.id);
                recompute();
            };

            scope.addScreen = function addScreen() {
                scope.onAddScreen();
            };

            scope.apply = function apply() {
                scope.onApply({ layout: scope.wireLayout });
                /* The just-applied layout is the new clean baseline. Flip the
                 * indicator to in sync immediately rather than waiting for the
                 * wire round-trip and server settle to echo back. */
                setBaseline();
            };

            /* Reset re-arranges the tiles to the clean default layout (ignoring
             * any saved/active override) so the user can recover from a messy
             * arrangement. It only repositions; the user still clicks Apply to
             * commit, keeping the "Apply commits, Close dismisses" model. */
            scope.resetLayout = function resetLayout() {
                buildTiles(true);
            };

            /* Dismiss the modal. Edits that weren't Applied are discarded
             * (the tiles re-seed from the live layout on the next open). */
            scope.close = function close() {
                scope.onClose();
            };

        }
    };

}]);
