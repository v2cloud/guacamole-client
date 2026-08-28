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
 * A service for adding additional monitors and handle instructions transfer.
 */
angular.module('client').factory('guacManageMonitor', ['$injector',
    function guacManageMonitor($injector) {

    // Required services
    const $window          = $injector.get('$window');
    const $rootScope       = $injector.get('$rootScope');
    const guacFullscreen   = $injector.get('guacFullscreen');
    const clipboardService = $injector.get('clipboardService');

    // Required types
    const ClipboardData = $injector.get('ClipboardData');

    /**
     * Additionals monitors windows opened.
     * 
     * @type Object.<Number, Window>
     */
    const monitors = {};

    /**
     * The type of this monitor (default = primary).
     * 
     * @type String
     */
    let monitorType = "primary";

    /**
     * The current Guacamole client instance.
     * 
     * @type Guacamole.Client 
     */
    let client = null;

    /**
     * The display of the current Guacamole client instance.
     * 
     * @type Guacamole.Display
     */
    let display = null;

    /**
     * The broadcast channel used for communications between all windows.
     * 
     * @type BroadcastChannel
     */
    let broadcast = null;

    /**
     * The primary monitor's 'fullscreenchange' listener, kept so init() and
     * shutdown() can detach it.
     *
     * @type Function
     */
    let fullscreenChangeHandler = null;

    /**
     * Deregistration function for the $rootScope 'guacClipboard' listener
     * added by init() on secondary monitor windows, or null if no listener
     * is currently registered.
     *
     * @type Function
     */
    let clipboardListener = null;

    /**
     * Deregistration function for the 'clipboardSyncInProgress' listener
     * added by init(), or null if none is registered.
     *
     * @type Function
     */
    let clipboardSyncListener = null;

    /**
     * Whether a read of this window's local clipboard is in flight.
     *
     * @type Boolean
     */
    let clipboardReadPending = false;

    /**
     * Mouse states held during a clipboard read, in the order they occurred.
     *
     * @type Object[]
     */
    const heldMouseStates = [];

    /**
     * Timer releasing held mouse states if the read never completes.
     *
     * @type Number
     */
    let holdTimer = null;

    /**
     * The maximum number of secondary monitors allowed.
     *
     * @type Number
     */
    let maxSecondaryMonitors = 0;

    /**
     * Store the last additional monitor id.
     * 
     * @type Number
     */
    let lastMonitorId = 0;

    /**
     * Object containing monitors informations.
     *
     * @type Object
     * @property {Number} count
     *     The number of monitors, including the main window.
     * @property {Object.<Number, Number>} map
     *     A map of monitor id to position.
     * @property {Object.<Number, Object>} details
     *     Details of each browser window, including width, height, etc.
     * @property {Object.<Number, Object>} rendered
     *     Details of each rendered monitor, including width, height, etc.
     *     This is used to display what is expected by guacd.
     */
    let monitorsInfos = {
        count: 1,
        map: {},
        details: {},
        rendered: {},
    };

    /**
     * Per-monitor layout override populated by applyLayoutOverride() when
     * the user applies a layout from the Display Settings UI modal. Each
     * entry is { leftOffset: number, topOffset: number }. When a
     * monitor's id is present, sendAllSizes uses these values verbatim.
     * When a monitor's id is absent, sendAllSizes falls back to the
     * cumulative layout for that monitor.
     *
     * Offsets here are in committed (Windows) space: the space guacd lays
     * monitors out in (committed = details / sessionDpr), where it places
     * offsets verbatim. All sendAllSizes offset math therefore pairs these with
     * committed widths (service.committedDims) rather than raw device-px
     * details; mixing the two spaces produces gaps or overlaps whenever
     * devicePixelRatio is not 1.
     *
     * @type {Object.<string, { leftOffset: number, topOffset: number }>}
     */
    let layoutOverride = {};

    /* Debounce timer for the resize-driven sendAllSizes path. A popup-window
     * resize fires many resize events; without coalescing, each one sends a
     * full set of per-monitor size instructions to guacd (and a BroadcastChannel
     * relay). Debouncing collapses a resize burst into a single send shortly
     * after it settles. The Apply path and the monitor-close re-send call
     * sendAllSizes directly (not debounced) so they stay immediate. */
    let sendAllSizesTimer = null;
    let sendAllSizesPending = false;
    let sendAllSizesPendingId;
    /* Settle window for the trailing send. Long enough that frames of a
     * continuous drag (~16ms apart) and brief hand jitter keep resetting it,
     * so the desktop resizes once the user pauses rather than every frame. */
    const SEND_ALL_SIZES_DEBOUNCE = 150;

    /**
     * Set of monitor ids (string keys) that guacd has acknowledged by
     * including them in at least one multimon-layout broadcast. Used by
     * onmultimonlayout to decide whether a monitor missing from an incoming
     * layout should be closed: a monitor that has never been confirmed (e.g.
     * just added by addMonitor, with guacd not yet caught up) is not torn down
     * by a layout that was already in flight when it was added, so a
     * freshly-opened popup added right after connecting does not close itself
     * immediately. Cleared in closeMonitor.
     *
     * @type {Object.<string, boolean>}
     */
    let confirmedMonitors = {};

    /* Serialize the Add Screen action. Each add grows the combined desktop,
     * forcing a Windows DesktopResize; firing several in quick succession packs
     * many desktop-growth resizes together, which on FreeRDP 2 can deliver a
     * resize mid-paint and crash the RDP child (guac_rdp_gdi_desktop_resize's
     * "open paint context" path). While a just-added monitor is still awaiting
     * guacd's first layout acknowledgement (confirmedMonitors), further adds are
     * blocked so the desktop grows one settled step at a time. addPendingId
     * holds the monitor id being awaited; the timer is a safety net that
     * releases the lock if guacd never acknowledges (e.g. the popup is closed
     * before it renders). */
    let addPendingId = null;
    let addPendingTimer = null;
    const ADD_SETTLE_TIMEOUT = 5000;

    function releaseAddPending() {
        const wasPending = addPendingId !== null;
        addPendingId = null;
        if (addPendingTimer !== null) {
            clearTimeout(addPendingTimer);
            addPendingTimer = null;
        }
        /* The lock is usually released outside Angular's digest, from the
         * setTimeout safety net or the BroadcastChannel layout-ack handler
         * (broadcast.onmessage runs without $apply). Schedule a digest so the
         * Add button's ng-disabled (canAddScreen -> addInFlight) re-evaluates
         * and the button re-enables; otherwise it stays disabled until some
         * unrelated digest fires. $evalAsync schedules a digest whether or not
         * one is running. */
        if (wasPending)
            $rootScope.$evalAsync();
    }

    /**
     * Wire positions of monitors closed while no client was attached
     * (e.g. a monitorClose relayed right after a reload of the primary
     * tab). The 0x0 close sentinel for these could not be sent at close
     * time; setClient replays them so guacd does not keep a phantom
     * monitor. Reset in shutdown().
     *
     * @type {number[]}
     */
    let pendingCloseSentinels = [];

    /**
     * The session's device-pixel-ratio, pinned at connect time to exactly
     * the value the connect handshake sent to guacd (GUAC_DPI / 96), or
     * null before the first connect. guacd divides every monitor's wire
     * size by that DPI for the whole session, so all committed-space math
     * must use the same constant. Reset in shutdown().
     *
     * @type {?number}
     */
    let sessionDpr = null;

    const service = {};

    /**
     * Attributes of the monitor
     *
     * @type Object.<Number>
     */
    service.monitorId = 0;

    /**
     * Returns the live monitorsInfos object.
     *
     * Cross-monitor copy operations are decomposed server-side, so
     * clients only need read access to monitor metadata for layout
     * decisions (offset arithmetic, top-offset broadcasts, etc.).
     *
     * @return {Object}
     *     The shared monitorsInfos object. Callers must treat `count`,
     *     `map`, `rendered`, and `details` as read-only.
     */
    service.getMonitorsInfos = function getMonitorsInfos() {
        return monitorsInfos;
    };

    /**
     * Returns a snapshot of monitorsInfos converted to Windows-logical
     * pixels (device px / sessionDpr, rounded). `count` and `map` pass
     * through unchanged. Used by the layout-editor modal so every number
     * it shows and every offset the user types is in the same units
     * Windows reports, rather than the device-px values on the wire.
     *
     * Returns a fresh object each call; callers must not bind to it in a
     * way that re-invokes per digest (snapshot once on modal open).
     *
     * @returns {!Object}
     *     A logical-space copy of monitorsInfos.
     */
    service.getMonitorsInfosLogical = function getMonitorsInfosLogical() {

        /* Return the modal view in committed (real Windows) space so the
         * numbers it shows match what guacd and Windows use.
         *  - details width/height are device px (offsetWidth * dpr). Convert
         *    via committedDims so the modal's "current size" matches guacd
         *    exactly (floor, width evened, both dims min-200); round(/dpr)
         *    could show a width up to 2px or a height 1px off from the render.
         *  - details left/top are the popup window's screen coordinates
         *    (window.screenX/Y, CSS px), a different space that is
         *    informational only and never used for wire-offset math. Passed
         *    through unconverted.
         *  - rendered is already guacd's echoed committed layout, so it is
         *    passed through unchanged; dividing it by dpr again would
         *    under-report every value by the DPR factor. */
        function detailsToCommitted(src) {
            var dst = {};
            for (var id in src) {
                if (!Object.prototype.hasOwnProperty.call(src, id))
                    continue;
                var m = src[id];
                var cd = service.committedDims(id);
                dst[id] = {
                    width:  cd.width,
                    height: cd.height,
                    left:   m.left ?? 0,
                    top:    m.top  ?? 0
                };
            }
            return dst;
        }

        return {
            count:    monitorsInfos.count,
            map:      angular.copy(monitorsInfos.map),
            details:  detailsToCommitted(monitorsInfos.details),
            rendered: angular.copy(monitorsInfos.rendered)
        };
    };

    /**
     * Returns a monitor's committed (logical) dimensions: the size guacd
     * renders it at, derived the same way guacd derives it from the device-px
     * size on the wire. Wire offset math uses these rather than raw details,
     * because guacd places offsets verbatim in this committed space; computing
     * offsets from device px leaves a gap or overlap of the DPR factor on
     * mixed-DPI layouts.
     *
     * These must match guacd exactly, or a contiguous edge lands one pixel off
     * and Windows silently rejects the MS-RDPEDISP layout. guacd converts
     * device to logical with integer truncation (guac_rdp_user_size_handler,
     * input.c):
     *
     *     logical = device * resolution / optimal_resolution   // C int divide = floor
     *
     * then evens the width only (width &= ~1) and clamps both dimensions up to
     * GUAC_RDP_DISP_MIN_SIZE = 200 (disp.c). Since sessionDpr ==
     * optimal/resolution, guacd is reproduced with:
     *
     *     width  = floor(device / sessionDpr) & ~1   (min 200)
     *     height = floor(device / sessionDpr)        (min 200; height is not evened)
     *
     * Both mins matter: the device size on the wire is itself floored at 200
     * (clampDim), so on a HiDPI display a short window floors its committed
     * height below 200 (e.g. 200/2.0 = 100) while guacd renders it at 200.
     * Omitting the height min packs a stacked neighbor against an under-sized
     * height and overlaps guacd's render, which Windows rejects.
     *
     * Use floor, not round. Rounding can desync the height by one pixel from
     * guacd's truncation (e.g. round(device/dpr)=953 vs guacd's floor=952), so
     * a top monitor packed at top_offset=-953 lands at bottom-edge=-1, a
     * one-pixel gap above the primary. The width does not exhibit this because
     * both sides even it, whereas the height is evened by neither. The committed
     * size is also not snapped to the echoed monitorsInfos.rendered[id]: with
     * floor, the estimate already equals guacd's logical size for the size being
     * sent, and the echo is the previous logical size, stale and off by one
     * while a resize is in flight.
     *
     * @param {!(string|number)} id
     * @returns {!{width: number, height: number}}
     */
    service.committedDims = function committedDims(id) {
        var dpr = service.getSessionDpr();
        var d = monitorsInfos.details[id] || { width: 0, height: 0 };
        var w = Math.floor((d.width || 0) / dpr);
        var h = Math.floor((d.height || 0) / dpr);
        return {
            width:  (w < 200 ? 200 : w) & ~1,
            height: (h < 200 ? 200 : h)
        };
    };

    /**
     * The scope identifier used to namespace this session's
     * BroadcastChannel. Set by init() and read by addMonitor() so the
     * secondary window URL carries the same scope.
     *
     * @type String
     */
    let monitorScope = '';

    /**
     * Init the monitor type and broadcast channel used for bidirectional
     * communications between primary and secondary monitor windows.
     *
     * @param {String} type
     *     The type of the monitor. "primary" if not given.
     *
     * @param {String} [scope]
     *     A scope identifier (typically the connection / connection-group
     *     identifier from the route) used to namespace the BroadcastChannel.
     *     Parallel Guacamole sessions opened in the same browser origin
     *     (e.g. tabs for VM1 and VM2) must use distinct scope values to
     *     avoid cross-talk on the shared 'guac_monitors' channel name;
     *     otherwise drawing instructions and monitorsInfos broadcasts from
     *     one session would land in the other session's secondary windows.
     *     If omitted, an empty scope is used, which preserves the
     *     single-connection behavior.
     */
    service.init = function init(type, scope) {

        // Change the monitor type
        if (type) monitorType = type;

        if (scope !== undefined && scope !== null)
            monitorScope = String(scope);

        /* init() can run more than once per window, with a different monitor
         * type, so release the previous run's listeners here rather than in
         * the branch that registered each one. */
        if (fullscreenChangeHandler) {
            document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
            fullscreenChangeHandler = null;
        }

        if (clipboardListener) {
            clipboardListener();
            clipboardListener = null;
        }

        if (clipboardSyncListener) {
            clipboardSyncListener();
            clipboardSyncListener = null;
        }

        /* Otherwise a hold from the previous run has nothing left to release
         * it, including on the unsupported-browser return below. */
        clearMouseHold();

        if (monitorType == "primary") {

            // Listen on fullscreenchange instead of hooking setFullscreenMode()
            // so ESC also reaches the secondaries.
            fullscreenChangeHandler = function fullscreenChangeHandler() {
                service.pushBroadcastMessage('fullscreen', !!guacFullscreen.isInFullscreenMode());
            };

            document.addEventListener('fullscreenchange', fullscreenChangeHandler);
        }

        // Create broadcast if supported
        if (!service.supported())
            return;

        /* Channel name is scoped per session so parallel connections on
         * the same browser origin do not share monitor state. The leading
         * "guac_monitors" prefix is retained for compatibility with
         * single-session deployments where scope is empty. */
        const channelName = 'guac_monitors:' + monitorScope;

        /* init() can run multiple times in an SPA, so close the previous
         * broadcast channel (if any) before reassigning so a stale
         * onmessage handler does not keep firing against an outdated
         * controller's closure state. */
        if (broadcast !== null)
            broadcast.close();
        broadcast = new BroadcastChannel(channelName);

        /**
         * Handle messages sent by secondary monitors windows on this
         * session's scoped guac_monitors channel.
         *
         * @param {Event} e
         *     Received message event.
         */
        broadcast.onmessage = messageHandlers[monitorType];

        /* indexController reads the local clipboard on load/copy/cut/focus in
         * every window, including this one, and clipboardService broadcasts
         * the result. Only the primary has a tunnel, so without this listener
         * a secondary's read is discarded and the session keeps whatever the
         * primary last sent. Registered after the channel, having nowhere to
         * relay to without one. */
        if (monitorType !== "primary") {

            clipboardListener = $rootScope.$on('guacClipboard',
                function localClipboardChanged(event, data) {
                    service.pushClipboard(data);
                });

            // Mouse states are held for the duration of a local read
            clipboardSyncListener = $rootScope.$on('clipboardSyncInProgress',
                function clipboardSyncChanged(event, inProgress) {

                    clipboardReadPending = !!inProgress;

                    if (!clipboardReadPending)
                        flushMouseStates();

                });

        }

    };

    /**
     * Returns the scope identifier that was passed to init().
     *
     * @return {String}
     *     The scope identifier (empty string if none was provided).
     */
    service.getScope = function getScope() {
        return monitorScope;
    };

    /**
     * Returns the session's device-pixel ratio: the number of physical
     * device pixels per Windows-logical pixel for this RDP session. Equal
     * to the primary window's devicePixelRatio, floored at 1. Used to
     * convert between the device-px values on the wire
     * (monitorsInfos.details / .rendered) and the Windows-logical values
     * shown in the layout-editor modal.
     *
     * @returns {!number}
     *     The session DPR (>= 1).
     */
    service.getSessionDpr = function getSessionDpr() {

        // Pinned at connect: the value guacd actually divides by.
        if (sessionDpr !== null)
            return sessionDpr;

        // Pre-connect fallback only: live read, floored at 1.
        var dpr = $window.devicePixelRatio;
        if (typeof dpr !== 'number' || !isFinite(dpr) || dpr < 1)
            return 1;
        return dpr;
    };

    /**
     * Pin the session DPR to the value the connect handshake sent
     * (GUAC_DPI / 96). guacd divides every monitor's wire size by that DPI
     * for the whole session, so all committed-space math must use the same
     * constant. Reading devicePixelRatio live would drift as soon as the
     * primary window moves to a different-DPI monitor or the browser zoom
     * changes, making every offset and size estimate disagree with guacd by
     * the drift ratio, so monitors would render shifted into the wrong windows.
     *
     * @param {number} dpr
     *     The session device pixel ratio (connect-time GUAC_DPI / 96).
     *     Invalid or sub-1 values are coerced to 1.
     */
    service.setSessionDpr = function setSessionDpr(dpr) {
        sessionDpr = (typeof dpr === 'number' && isFinite(dpr) && dpr >= 1)
            ? dpr : 1;
    };

    /**
     * Set the maximum number of secondary monitors allowed.
     *
     * @param {Number} secondaryMonitorsAllowed
     *     The maximum number of secondary monitors allowed.
     */
    service.setMaxSecondaryMonitors = function setMaxSecondaryMonitors(amount) {
        maxSecondaryMonitors = amount;
    }

    /**
     * Ensure that the limit of open monitors is not reached.
     * 
     * @returns {boolean}
     *     true when the limit of opened monitors is reached, false otherwise.
     */
    service.monitorLimitReached = function monitorLimitReached() {

        // Max open monitors allowed (add 1 for the primary monitor)
        const maxMonitors = maxSecondaryMonitors + 1;

        // Prevent opening of too many monitors
        return service.getMonitorCount() >= maxMonitors;

    };

    /**
     * Whether there is no room to add another screen without exceeding guacd's
     * combined-desktop cap. A new screen appends to the right of the current
     * layout (top-aligned), so it can only render if the remaining horizontal
     * budget (GUAC_DISPLAY_MAX_WIDTH minus the current right edge) can hold at
     * least a minimum-size monitor. When the budget is smaller, even the
     * clamp-to-fit recovery (sendAllSizes) cannot make the new screen visible,
     * so the Add action is blocked rather than opening a popup that cannot
     * render. Uses the committed layout guacd is currently rendering
     * (monitorsInfos.rendered).
     *
     * @returns {boolean} true when adding another screen has no usable room.
     */
    service.addRoomExhausted = function addRoomExhausted() {
        var rects = {};
        var any = false;
        for (var id in monitorsInfos.details) {
            if (!Object.prototype.hasOwnProperty.call(monitorsInfos.details, id))
                continue;
            var cd = service.committedDims(id);
            var r = monitorsInfos.rendered[id] || {};
            rects[id] = {
                width:  cd.width,
                height: cd.height,
                left:   (typeof r.left === 'number') ? r.left : 0,
                top:    (typeof r.top  === 'number') ? r.top  : 0
            };
            any = true;
        }
        if (!any) return false;   // nothing rendered yet; allow
        var ext = layoutExtent(rects);
        return (GUAC_DISPLAY_MAX_WIDTH - ext.maxRight) < 200;   // < one min-size monitor
    };

    /**
     * Check if the browser supports the BroadcastChannel API.
     *
     * @returns {boolean}
     *     true if the BroadcastChannel API is supported, false otherwise.
     */
    service.supported = function supported() {

        if (!window.BroadcastChannel) {
            console.warn("BroadcastChannel is not supported by this browser.");
            return false;
        }

        return true;
    }

    /**
     * Handlers for instructions received on broadcast channel.
     */
    const messageHandlers = {

        "primary": function primary(message) {

            /* The channel is opened at controller construction but the
             * client is only attached on focus (setClient), so input/size
             * messages arriving in that gap (e.g. right after a reload of
             * the primary tab while secondaries are open) must not throw.
             * Monitor bookkeeping below has no such dependency. */
            if (client) {

                // Resize from a secondary window. It broadcasts its CSS size;
                // convert to wire (device) px with the session DPR pinned at
                // connect, because guacd divides every monitor's wire size by
                // that single session DPI.
                if (message.data.size) {
                    const s = message.data.size;
                    const dpr = service.getSessionDpr();
                    service.sendSize(client, {
                        width:     s.width  * dpr,
                        height:    s.height * dpr,
                        top:       s.top,
                        left:      s.left,
                        monitorId: s.monitorId,
                    });
                }

                // Mouse state changed on secondary screen
                if (message.data.mouseState)
                    client.sendMouseState(message.data.mouseState);

                // Key down on secondary screen
                if (message.data.keydown)
                    client.sendKeyEvent(1, message.data.keydown);

                // Key up on secondary screen
                if (message.data.keyup)
                    client.sendKeyEvent(0, message.data.keyup);

            }

            // Additional window unloaded
            if (message.data.monitorClose)
                service.closeMonitor(message.data.monitorClose);

            // CTRL+ALT+SHIFT pressed on secondary window
            if (message.data.guacMenu && service.menuShown)
                service.menuShown();

            /* A secondary's local clipboard, relayed here because only this
             * window has a tunnel. setInternalClipboard() stores it (where
             * ManagedClient finds it for a newly-attached client) and
             * broadcasts to guacClient, which writes the tunnel. The local
             * clipboard is left alone -- this data is already its content.
             *
             * $broadcast dispatches whether or not a digest is running, so
             * the tunnel write happens synchronously. Nothing on that path
             * touches scope today; the $evalAsync() is how this file's other
             * out-of-digest entry points hand control back (see
             * releaseAddPending). */
            if (message.data.clipboard) {
                clipboardService.setInternalClipboard(new ClipboardData({
                    type : message.data.clipboard.type,
                    data : message.data.clipboard.data
                }));
                $rootScope.$evalAsync();
            }

        },

        "secondary": function secondaryMonitor(message) {

            /* Buffer draw handlers until this window has applied its first
             * layout (setMonitorSize + client.offsetX/Y). Draws relayed
             * before the layout land on a 0x0 canvas at offset 0 and never
             * become visible, so the secondary would open black. Once the
             * layout arrives the queue is flushed in order so every draw is
             * applied with the correct canvas size and offsets, and the
             * post-resize repaint of this monitor's region (which arrives
             * after the layout) renders live. */
            /* Validate the relayed handler shape before acting. BroadcastChannel
             * is same-origin-only (no injection vector), but a malformed or
             * early message must not throw, and a draw must not run before
             * this window's client exists. */
            var relayed = message.data.handler;
            if (relayed && typeof relayed.opcode === 'string') {
                if (!service._layoutReady) {
                    service._handlerQueue = service._handlerQueue || [];
                    service._handlerQueue.push(relayed);
                }
                else if (client)
                    client.runHandler(relayed.opcode, relayed.parameters);
            }

            if (message.data.monitorsInfos)
                monitorsInfos = message.data.monitorsInfos;

            /* The primary received a multimon-layout from guacd and relayed
             * it to this window. Apply it first (sets setMonitorSize +
             * offsets), then flush any draws that were buffered before the
             * layout. The flush is gated on the layout actually applying: if
             * this window's client/display are not attached yet, the layout is
             * skipped and the queue must stay buffered, since marking ready
             * here would drain the draws into a null client and leave the
             * secondary unable to recover its display. The primary relays a
             * layout on every guacd layout instruction, so a skipped one
             * is recovered by the next. */
            if (message.data.multimonLayout) {

                var applied = onmultimonlayout(message.data.multimonLayout);

                if (applied && !service._layoutReady) {
                    service._layoutReady = true;
                    var queued = service._handlerQueue || [];
                    for (var qi = 0; qi < queued.length; qi++)
                        client.runHandler(queued[qi].opcode,
                                          queued[qi].parameters);
                    service._handlerQueue = [];
                }

                /* Force-drain queued display tasks (the explicit default-
                 * layer resize from onmultimonlayout plus any buffered
                 * draws). This window is not a connected Guacamole client,
                 * so it only receives a server 'sync' (which triggers a
                 * flush) when the desktop changes again. After adding a
                 * monitor the desktop is often static, leaving the resize
                 * and draws queued indefinitely and the canvas at 0x0.
                 *
                 * Draining the resize task here fires display.onresize,
                 * which recomputes the scale against the now-valid canvas
                 * dimensions (see guacClientSecondary). No manual rescale
                 * is needed; the onresize hook is the single, reliable
                 * scale trigger. */
                if (applied) display.flush();
            }

            // Full screen mode instructions
            if (message.data.fullscreen !== undefined) {

                // setFullscreenMode require explicit user action
                if (message.data.fullscreen) {
                    if (!guacFullscreen.isInFullscreenMode() && service.openConsentButton)
                        service.openConsentButton();
                }

                // Close fullscreen mode instantly
                else
                    guacFullscreen.setFullscreenMode(false);

            }
        }

    }

    /**
     * Add button to request user consent before enabling fullscreen mode to
     * comply with the setFullscreenMode requirements that require explicit
     * user action. The button is removed after a few seconds if the user does
     * not click on it.
     */
    service.openConsentButton = null;

    /**
     * Optional callback fired after a multimon-layout update is applied
     * locally. Used by secondary monitor directives to re-fit their
     * display scale to the popup container after setMonitorSize has
     * updated the canvas dimensions.
     */
    service.onLayoutChange = null;

    /**
     * Optional callback fired (on the primary) after a multimon-layout
     * update has been applied locally, in addition to onLayoutChange. Lets
     * the layout-editor modal re-snapshot its logical view so the
     * "Windows currently has" columns refresh after Apply without reopening.
     * Separate from onLayoutChange so the primary modal and the secondary
     * window's scale hook do not clobber each other.
     */
    service.onMonitorsInfoUpdate = null;

    /**
     * Optional callback fired (on the primary) when a monitor's size had to be
     * clamped so the combined desktop stays within guacd's 8192×8192 surface
     * cap (a resize/add would otherwise white-clip). The controller uses this to
     * notify the user (with a link to Configure Layout). Fired once per clamp
     * "episode" (see extentClampActive). Receives { monitorId }.
     */
    service.onExtentClamped = null;

    /* Debounce flag for onExtentClamped: true while the layout is being kept
     * within the cap by clamping, so a continuous popup drag fires the notice
     * once. Reset when a send no longer needs clamping. */
    let extentClampActive = false;

    /**
     * Open or close Guacamole menu (ctrl+alt+shift).
     */
    service.menuShown = null;

    /**
     * Set the current Guacamole Client
     * 
     * @param {Guacamole.Client} guac_client
     *     The guacamole client where to send instructions.
     */
    service.setClient = function setClient(guac_client) {

        client  = guac_client;
        display = client.getDisplay();

        client.onmultimonlayout = onmultimonlayout;

        // Close all secondary monitors on client disconnect
        if (monitorType === "primary")
            client.ondisconnect = service.closeAllMonitors;

        /* Replay any close sentinels deferred while no client was
         * attached, then re-sync the surviving monitors, so guacd's
         * layout matches this window's state. */
        if (pendingCloseSentinels.length) {
            for (var i = 0; i < pendingCloseSentinels.length; i++)
                client.sendSize(0, 0, pendingCloseSentinels[i], 0);
            pendingCloseSentinels = [];
            sendAllSizes(client);
        }

    }

    /**
     * Push broadcast message containing instructions that allows additional
     * monitor windows to draw display, resize window and more.
     * 
     * @param {!string} type
     *     The type of message (ex: handler, fullscreen, resize)
     *
     * @param {*} content
     *     The content of the message, can contain any type of serializable
     *     content.
     */
    service.pushBroadcastMessage = function pushBroadcastMessage(type, content) {

        // No channel (unsupported browser, or already shut down)
        if (!broadcast)
            return;

        // Send only if there are other monitors to receive this message
        if (monitorType === "primary" && service.getMonitorCount() <= 1)
            return;

        // Format message content
        const message = {
            [type]: content
        };

        // Send message on the broadcast channel
        broadcast.postMessage(message);

    };

    /**
     * The longest a mouse state is held waiting for a clipboard read. A read
     * takes ~10ms, or ~100ms more on the fallback path, so this expires only
     * when one reports neither success nor failure. Capped because input
     * matters more than a possibly-stale paste.
     *
     * @type Number
     */
    service.CLIPBOARD_HOLD_TIMEOUT = 250;

    /**
     * Relay every held mouse state, in the order the states occurred.
     */
    const flushMouseStates = function flushMouseStates() {

        if (holdTimer !== null) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }

        while (heldMouseStates.length)
            service.pushBroadcastMessage('mouseState', heldMouseStates.shift());

    };

    /**
     * Discard any held mouse states and reset the hold.
     */
    const clearMouseHold = function clearMouseHold() {

        if (holdTimer !== null) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }

        heldMouseStates.length = 0;
        clipboardReadPending = false;

    };

    /**
     * Relay a mouse state to the primary window, holding it while a local
     * clipboard read is in flight.
     *
     * A context-menu paste is issued by a click, and the local clipboard is
     * read asynchronously on focus, so a click relayed before that read
     * completes pastes the previous content. guacClient gates the primary's
     * own mouse events the same way.
     *
     * One queue rather than a timer per state, so a state arriving after the
     * read completes cannot overtake one still waiting and relay a mouseup
     * ahead of its mousedown.
     *
     * @param {Object} mouseState
     *     The mouse state to relay. Only its fields are sent, so the caller
     *     may reuse the object across events.
     */
    service.pushMouseState = function pushMouseState(mouseState) {

        // Nothing to wait for: relay with no added latency
        if (!clipboardReadPending && !heldMouseStates.length) {
            service.pushBroadcastMessage('mouseState', mouseState);
            return;
        }

        /* Copied: callers reuse one object per event, so a queued reference
         * would collapse to the last state. */
        heldMouseStates.push(angular.extend({}, mouseState));

        if (holdTimer === null)
            holdTimer = setTimeout(function holdExpired() {
                holdTimer = null;
                /* End the hold, not just this batch: otherwise a read that
                 * never completes arms a fresh hold per event, batching input
                 * at the cap forever. A later completion flushes nothing. */
                clipboardReadPending = false;
                flushMouseStates();
            }, service.CLIPBOARD_HOLD_TIMEOUT);

    };

    /**
     * Relay a local clipboard change to the primary window, so it reaches the
     * remote session. A secondary's Guacamole.Client is built on the abstract
     * Guacamole.Tunnel, whose sendMessage() is a no-op, so it cannot reach
     * guacd itself -- the same reason its input is relayed.
     *
     * Data carrying a source came from the session and is ignored; relaying
     * it would echo it straight back to guacd. Only a local clipboard read,
     * which clipboardService leaves untagged, is relayed.
     *
     * @param {ClipboardData} data
     *     The clipboard data the local clipboard now holds.
     */
    service.pushClipboard = function pushClipboard(data) {

        /* The primary broadcasts 'guacClipboard' as it sends its own
         * clipboard; relaying that would bounce between the windows. */
        if (monitorType === "primary")
            return;

        // Nothing to relay, or data that came from the remote session
        if (!data || data.source)
            return;

        /* Plain fields: the channel structured-clones its message, dropping
         * the ClipboardData prototype, and the receiver rebuilds it. A Blob
         * clones intact, though one rarely gets here -- readText() yields ''
         * for an image-only clipboard, so an image copy relays '' and clears
         * the remote clipboard. The primary does the same today; fix both at
         * once. */
        service.pushBroadcastMessage('clipboard', {
            type : data.type,
            data : data.data
        });

    };

/**
 * Open an additional monitor window at the convention position
 * (primary's right edge, default 1024x768). Physical placement and
 * logical arrangement are handled later by the Display Settings UI.
 */
service.addMonitor = function addMonitor() {

    // Serialize: ignore a new add while the previous one is still being
    // acknowledged by guacd (the button is also disabled in this state). This
    // keeps the desktop growing one settled step at a time, avoiding the rapid
    // desktop-growth resizes that can crash the RDP child mid-paint.
    if (addPendingId !== null)
        return;

    // Defense in depth: never open a popup that cannot fit within guacd's
    // combined-desktop cap (the buttons are also disabled in this state).
    if (service.addRoomExhausted()) {
        console.warn('[multimon] addMonitor: no room for another screen within '
            + GUAC_DISPLAY_MAX_WIDTH + '×' + GUAC_DISPLAY_MAX_HEIGHT
            + ' — not opening.');
        if (typeof service.onExtentClamped === 'function')
            service.onExtentClamped({ monitorId: null, reason: 'add-no-room' });
        return;
    }

    // New monitor id
    lastMonitorId++;

    /* New window parameters. The scope segment carries the parent
     * session's scope into the secondary window so it joins the same
     * BroadcastChannel as primary and does not see traffic from
     * other parallel sessions in this browser origin. The windowId
     * also includes the scope so window.open does not reuse a
     * window already opened by a different parallel session. */
    const scopeSegment = encodeURIComponent(monitorScope);
    const windowUrl  = './#/secondaryMonitor/' + scopeSegment + '/' + lastMonitorId;
    const windowId   = 'monitor-' + scopeSegment + '-' + lastMonitorId;
    /* Size the popup to 60% of the primary's CSS dimensions so it
     * opens visibly smaller than the primary (easier to grab and
     * drag) while still scaling with the primary's display, instead
     * of a fixed 1024×768 that can be larger than the primary on a
     * small monitor or much smaller on a large one. Falls back to a
     * 60%-of-1024×768 default if innerWidth/innerHeight are not
     * available. */
    const popupW = Math.round(($window.innerWidth  || 1024) * 0.6);
    const popupH = Math.round(($window.innerHeight || 768)  * 0.6);
    const windowSize = 'width=' + popupW + ',height=' + popupH;

    // Open new window
    const popup = $window.open(windowUrl, windowId, windowSize);

    /* A popup blocker returns null. Storing it would create a phantom
     * monitor that inflates getMonitorCount(), shifts later monitors'
     * wire positions, and can never be closed (closeMonitor requires a
     * window object to act on). Roll back the id and notify instead. */
    if (!popup) {
        lastMonitorId--;
        if (typeof service.onExtentClamped === 'function')
            service.onExtentClamped({ monitorId: null, reason: 'popup-blocked' });
        return;
    }

    monitors[lastMonitorId] = popup;

    /* Hold the Add lock until guacd acknowledges this monitor (cleared in
     * onmultimonlayout) or the safety timeout fires. */
    addPendingId = lastMonitorId;
    if (addPendingTimer !== null)
        clearTimeout(addPendingTimer);
    addPendingTimer = setTimeout(releaseAddPending, ADD_SETTLE_TIMEOUT);

};

/**
 * Whether a just-added monitor is still awaiting guacd's first layout
 * acknowledgement. The Add Screen button stays disabled while this is true so
 * monitors are added one settled step at a time.
 *
 * @returns {!boolean}
 */
service.addInFlight = function addInFlight() {
    return addPendingId !== null;
};

    /**
     * Apply a wire layout declared by the Display Settings UI. Overrides
     * the automatic cumulative layout for each monitor present in the
     * layout object. Triggers an immediate sendAllSizes so guacd
     * receives the new layout right away.
     *
     * @param {Object.<string, {leftOffset: number, topOffset: number}>} layout
     *     Map of monitor id (stringified) to its declared offsets.
     *     Primary (id "0") must be at (0, 0) per MS-RDPEDISP; the UI enforces
     *     this implicitly by anchoring relative to primary's tile, so this
     *     function does not re-validate.
     */
    service.applyLayoutOverride = function applyLayoutOverride(layout) {
        if (!layout) return;

        /* The modal works in committed (Windows) space, the same space
         * guacd places offsets in (verbatim) and that layoutOverride stores.
         * So the offsets are stored as-is, with no DPR conversion. Replace the
         * entire override so monitors removed from the UI's tile set fall
         * back to the cumulative layout. */
        layoutOverride = {};
        for (var id in layout) {
            if (!Object.prototype.hasOwnProperty.call(layout, id))
                continue;
            var offsets = layout[id];
            if (offsets && typeof offsets.leftOffset === 'number'
                        && typeof offsets.topOffset === 'number') {
                layoutOverride[id] = {
                    leftOffset: Math.round(offsets.leftOffset),
                    topOffset:  Math.round(offsets.topOffset)
                };
            }
        }

        /* Resend sizes with the new layout if a client is connected. */
        if (client)
            sendAllSizes(client);
    };

    /**
     * Returns a shallow copy of the current layout override so the UI can
     * seed itself with the last-applied state when reopening. Empty
     * object when no override has been applied yet.
     *
     * @returns {Object}
     *     Map of monitor id → {leftOffset, topOffset}.
     */
    service.getLayoutOverride = function getLayoutOverride() {
        const copy = {};
        for (const id of Object.keys(layoutOverride)) {
            copy[id] = {
                leftOffset: layoutOverride[id].leftOffset,
                topOffset:  layoutOverride[id].topOffset
            };
        }
        return copy;
    };

    /**
     * Returns the current layout override in the coordinate space the
     * layout-editor modal works in. layoutOverride is stored in committed
     * (Windows) space, which is also the modal's space, so the override is
     * returned as-is. Kept as a named accessor so the modal has a single
     * seam for the override snapshot.
     *
     * @returns {!Object}
     *     Map of monitor id -> {leftOffset, topOffset} in committed px.
     */
    service.getLayoutOverrideLogical = function getLayoutOverrideLogical() {
        return service.getLayoutOverride();
    };

    /**
     * Close an additional monitor based on its id.
     *
     * @param {!number} monitorId
     *     The monitor ID to close.
     */
    service.closeMonitor = function closeMonitor(monitorId) {

        // Monitor not found
        if (!(monitorId in monitors))
            return;

        // Close monitor (entry may be falsy if the window is already gone)
        if (monitors[monitorId] && !monitors[monitorId].closed)
            monitors[monitorId].close();

        // Delete monitor
        delete monitors[monitorId];
        delete layoutOverride[monitorId];
        delete confirmedMonitors[monitorId];

        // If the monitor being closed is the one being awaited, release the
        // Add lock so the button does not stay disabled (e.g. a popup closed
        // before guacd ever acknowledged it).
        if (String(addPendingId) === String(monitorId))
            releaseAddPending();

        // Notify guacd that a monitor has been closed
        service.sendSize(client, {
            width: 0,
            height: 0,
            top: 0,
            monitorId: monitorId,
        });

    }

    /**
     * Close all additional monitors.
     */
    service.closeAllMonitors = function closeAllMonitors() {

        // Loop on all existing monitors
        for (const key in monitors)
            service.closeMonitor(key);

        /* No monitors remain, so cancel any pending trailing resize send so it
         * cannot fire sendSize on a possibly-disconnected client after teardown
         * (closeAllMonitors is also the terminal-state and unload teardown
         * path, neither of which calls shutdown()). */
        if (sendAllSizesTimer !== null) {
            clearTimeout(sendAllSizesTimer);
            sendAllSizesTimer = null;
        }
        sendAllSizesPending = false;

    };

    /**
     * Tear down the service for the destroyed client view: close the
     * BroadcastChannel, cancel any pending resend timer, and release the
     * optional callback closures. Symmetric to init(); call it from the
     * controller's $destroy (in addition to closeAllMonitors) so an open
     * channel and notifier closures do not outlive the controller that
     * created them when navigating away from the client. Idempotent.
     */
    service.shutdown = function shutdown() {

        if (broadcast !== null) {
            broadcast.close();
            broadcast = null;
        }

        if (sendAllSizesTimer !== null) {
            clearTimeout(sendAllSizesTimer);
            sendAllSizesTimer = null;
        }
        sendAllSizesPending = false;
        sendAllSizesPendingId = undefined;
        releaseAddPending();
        extentClampActive = false;
        pendingCloseSentinels = [];
        sessionDpr = null;

        // Reset the secondary-window draw buffering so a re-init starts
        // from a clean "no layout applied yet" state.
        service._layoutReady = false;
        service._handlerQueue = [];

        // Drop the fullscreenchange listener added in init().
        if (fullscreenChangeHandler) {
            document.removeEventListener('fullscreenchange', fullscreenChangeHandler);
            fullscreenChangeHandler = null;
        }

        // Drop the 'guacClipboard' listener added in init().
        if (clipboardListener) {
            clipboardListener();
            clipboardListener = null;
        }

        // Drop the 'clipboardSyncInProgress' listener added in init()
        if (clipboardSyncListener) {
            clipboardSyncListener();
            clipboardSyncListener = null;
        }

        clearMouseHold();

        // Release closures that captured the (now destroyed) controller scope.
        service.onMonitorsInfoUpdate = null;
        service.onExtentClamped      = null;
        service.onLayoutChange       = null;
        service.menuShown            = null;
        service.openConsentButton    = null;

    };

    /**
     * Get open monitors count.
     *
     * @returns {!number}
     *     Actual count of monitors.
     */
    service.getMonitorCount = function getMonitorCount() {
        // Return additionals monitors count + 1 for the main window
        return Object.keys(monitors).length + 1;
    };

    /**
     * Clamp a monitor dimension to the MS-RDPEDISP §2.2.2.2.1 valid range
     * [200, 8192]. When isWidth is true, also strip the low bit: the Width
     * must be even per spec, and Windows silently rejects the entire
     * layout PDU if any monitor's Width is odd.
     *
     * Order matters: clamp first, then strip. Clamping first keeps the
     * [200, 8192] floor explicit rather than relying on a later clamp to
     * re-raise a value the strip had pushed just below the minimum.
     */
    function clampDim(v, isWidth) {
        v = Math.max(200, Math.min(8192, Math.round(v)));
        if (isWidth) v &= ~1;
        return v;
    }

    /* Public geometry helper (also used by directives and tests). */
    service.clampDim = clampDim;

    /*
     * Maximum dimensions of the combined multi-monitor virtual desktop, mirrored
     * 1:1 from guacd's GUAC_DISPLAY_MAX_WIDTH / GUAC_DISPLAY_MAX_HEIGHT in
     * guacamole-server/src/libguac/guacamole/display-constants.h. guacd
     * composites every monitor into one display surface capped at these
     * dimensions; a bounding box larger than this is silently clipped, and the
     * region past the edge renders white. Both are currently 8192, but are kept
     * as separate width/height to track the backend exactly and to survive a
     * future change where they differ. Distinct from clampDim's per-monitor 8192
     * cap (GUAC_RDP_DISP_MAX_SIZE), which limits each screen, not the whole
     * desktop.
     */
    var GUAC_DISPLAY_MAX_WIDTH  = 8192;
    var GUAC_DISPLAY_MAX_HEIGHT = 8192;

    service.GUAC_DISPLAY_MAX_WIDTH  = GUAC_DISPLAY_MAX_WIDTH;
    service.GUAC_DISPLAY_MAX_HEIGHT = GUAC_DISPLAY_MAX_HEIGHT;

    /**
     * The combined bounding box of all monitors, in the caller's pixel space
     * (logical for the modal, device for the wire). Each monitor is a rect
     * {left, top, width, height}. Returns the overall extent plus its bounds:
     * { width, height, minLeft, minTop, maxRight, maxBottom }. An empty map
     * yields a zero-size extent at the origin.
     */
    function layoutExtent(monitors) {
        var minLeft = Infinity, minTop = Infinity;
        var maxRight = -Infinity, maxBottom = -Infinity;
        var any = false;
        for (var id in monitors) {
            if (!Object.prototype.hasOwnProperty.call(monitors, id)) continue;
            any = true;
            var m = monitors[id];
            if (m.left < minLeft) minLeft = m.left;
            if (m.top  < minTop)  minTop  = m.top;
            if (m.left + m.width  > maxRight)  maxRight  = m.left + m.width;
            if (m.top  + m.height > maxBottom) maxBottom = m.top  + m.height;
        }
        if (!any)
            return { width: 0, height: 0, minLeft: 0, minTop: 0,
                     maxRight: 0, maxBottom: 0 };
        return {
            width:     maxRight - minLeft,
            height:    maxBottom - minTop,
            minLeft:   minLeft,
            minTop:    minTop,
            maxRight:  maxRight,
            maxBottom: maxBottom
        };
    }

    /* Public geometry helper (also used by directives and tests). */
    service.layoutExtent = layoutExtent;

    /**
     * Geometry helpers for layout validation/arrangement. All operate on
     * rects of the shape {left, top, width, height} in a single consistent
     * pixel space (the caller's: logical for the modal, device for the
     * wire). right = left+width, bottom = top+height.
     */
    function rectsOverlap(a, b) {
        return a.left < b.left + b.width && b.left < a.left + a.width
            && a.top  < b.top  + b.height && b.top  < a.top  + a.height;
    }

    function shareEdge(a, b) {
        var aR = a.left + a.width,  aB = a.top + a.height;
        var bR = b.left + b.width,  bB = b.top + b.height;
        var vTouch = (aR === b.left || a.left === bR)
                  && a.top < bB && b.top < aB;
        var hTouch = (aB === b.top || a.top === bB)
                  && a.left < bR && b.left < aR;
        return vTouch || hTouch;
    }

    /**
     * A monitor is valid iff it overlaps no other monitor AND shares an
     * edge segment with at least one other monitor (MS-RDPEDISP requires a
     * gap-free, overlap-free, edge-connected layout). A lone monitor (no
     * others) is trivially valid.
     */
    function monitorValid(id, monitors) {
        var m = monitors[id];
        var connected = false;
        var any = false;
        for (var oid in monitors) {
            if (!Object.prototype.hasOwnProperty.call(monitors, oid) || oid === id)
                continue;
            any = true;
            var o = monitors[oid];
            if (rectsOverlap(m, o)) return false;
            if (shareEdge(m, o)) connected = true;
        }
        return any ? connected : true;
    }

    /**
     * The set of monitor ids reachable from the primary (id 0) by walking
     * shared, non-overlapping edges (a flood-fill). MS-RDPEDISP requires all
     * monitors to form one connected component anchored at the primary.
     * monitorValid only checks that a monitor touches some sibling, which a
     * cluster that has floated away from the primary (e.g. after resizing the
     * middle of an above/left stack) still satisfies even though it is globally
     * invalid. This exposes that case: any non-primary id missing from the
     * returned set is detached and must be re-attached.
     *
     * @returns {!Object.<string, boolean>} map of reachable id -> true.
     */
    function reachableFromPrimary(monitors) {
        var reached = {};
        if (!monitors['0']) {
            /* No primary in this map, so there is nothing to anchor to; treat
             * all as reachable so the caller does not churn. */
            for (var k in monitors)
                if (Object.prototype.hasOwnProperty.call(monitors, k)) reached[k] = true;
            return reached;
        }
        reached['0'] = true;
        var queue = ['0'];
        while (queue.length) {
            var cur = queue.shift();
            var m = monitors[cur];
            for (var oid in monitors) {
                if (!Object.prototype.hasOwnProperty.call(monitors, oid)
                        || reached[oid] || oid === cur)
                    continue;
                var o = monitors[oid];
                if (!rectsOverlap(m, o) && shareEdge(m, o)) {
                    reached[oid] = true;
                    queue.push(oid);
                }
            }
        }
        return reached;
    }

    /* Public geometry helper (also used by directives and tests). */
    service.rectsOverlap = rectsOverlap;
    service.shareEdge = shareEdge;
    service.monitorValid = monitorValid;
    service.reachableFromPrimary = reachableFromPrimary;

    /**
     * Clamp `pos` (the moved monitor's near coordinate on one axis, with
     * extent `size`) into the range that keeps a >=1px shared-edge segment
     * with a neighbor spanning [oStart, oStart+oExtent] on that axis.
     */
    function clampSpan(pos, oStart, oExtent, size) {
        var min = oStart - size + 1;
        var max = oStart + oExtent - 1;
        return Math.max(min, Math.min(max, pos));
    }

    /* Public geometry helper (also used by directives and tests). */
    service.clampSpan = clampSpan;

    /**
     * Auto-arrange the moved monitor to a valid layout (no gap, no overlap,
     * edge-connected). Mutates monitors[movedId] in place. Returns true if
     * it moved. Implemented as four steps: skip-if-valid,
     * snap-to-nearest-neighbor, third-monitor overlap resolution, and a
     * guaranteed-valid flush-right fallback.
     */
    function arrangeMoved(monitors, movedId) {
        var m = monitors[movedId];
        var others = [];
        for (var oid in monitors) {
            if (Object.prototype.hasOwnProperty.call(monitors, oid) && oid !== movedId)
                others.push(monitors[oid]);
        }
        if (others.length === 0) return false;

        // Step 0: already valid, so leave as-is.
        if (monitorValid(movedId, monitors)) return false;

        var startLeft = m.left, startTop = m.top;

        // Step 1: snap flush to the nearest neighbor edge.
        var best = null;
        for (var i = 0; i < others.length; i++) {
            var o = others[i];
            var cands = [
                { left: o.left + o.width,  top: clampSpan(m.top, o.top, o.height, m.height) }, // right of O
                { left: o.left - m.width,  top: clampSpan(m.top, o.top, o.height, m.height) }, // left of O
                { left: clampSpan(m.left, o.left, o.width, m.width), top: o.top + o.height },   // below O
                { left: clampSpan(m.left, o.left, o.width, m.width), top: o.top - m.height }     // above O
            ];
            for (var c = 0; c < cands.length; c++) {
                var dx = cands[c].left - startLeft, dy = cands[c].top - startTop;
                var cost = dx * dx + dy * dy;
                if (best === null || cost < best.cost)
                    best = { left: cands[c].left, top: cands[c].top, cost: cost };
            }
        }
        m.left = best.left;
        m.top  = best.top;

        // Step 2: resolve overlaps from the snap. Re-check all other monitors
        // each pass, since sliding past one can re-introduce overlap with
        // another, bounded to avoid pathological non-convergence. Each pass
        // moves M to the nearest non-overlapping flush position relative to the
        // current conflicting monitor.
        var passes = 0;
        var maxPasses = others.length + 1;
        while (passes++ < maxPasses) {
            var conflict = null;
            for (var s = 0; s < others.length; s++) {
                if (rectsOverlap(m, others[s])) { conflict = others[s]; break; }
            }
            if (!conflict) break;
            var cand = [
                { left: m.left, top: conflict.top + conflict.height }, // below conflict
                { left: m.left, top: conflict.top - m.height },        // above conflict
                { left: conflict.left + conflict.width, top: m.top },  // right of conflict
                { left: conflict.left - m.width,  top: m.top }         // left of conflict
            ];
            var bestSlide = null;
            for (var k = 0; k < cand.length; k++) {
                var trial = { left: cand[k].left, top: cand[k].top,
                              width: m.width, height: m.height };
                if (rectsOverlap(trial, conflict)) continue;
                var dx = cand[k].left - m.left, dy = cand[k].top - m.top;
                var dist = dx * dx + dy * dy;
                if (bestSlide === null || dist < bestSlide.dist)
                    bestSlide = { left: cand[k].left, top: cand[k].top, dist: dist };
            }
            if (bestSlide === null) break; // cannot clear this one; Step 3 fallback
            m.left = bestSlide.left;
            m.top  = bestSlide.top;
        }

        // Step 3: guaranteed-valid fallback. If still overlapping anything,
        // place flush to the right of the rightmost monitor, top-aligned to
        // the origin. Always non-overlapping and edge-connected.
        var stillBad = false;
        for (var q = 0; q < others.length; q++) {
            if (rectsOverlap(m, others[q])) { stillBad = true; break; }
        }
        if (stillBad) {
            var maxRight = 0;
            for (var r = 0; r < others.length; r++)
                maxRight = Math.max(maxRight, others[r].left + others[r].width);
            m.left = maxRight;
            m.top  = 0;
        }

        return m.left !== startLeft || m.top !== startTop;
    }

    /**
     * Full-layout auto-repair. Snaps the moved monitor to a valid position
     * (honoring where the user dropped it), then re-flows every other monitor
     * left invalid by that move or resize (an orphaned leaf, a gap, an overlap)
     * until the whole layout is gap-free, overlap-free and edge-connected.
     *
     * arrangeMoved fixes only the moved monitor. Moving the middle monitor of a
     * strip leaves the downstream leaf disconnected, which the editor would
     * flag and the user would have to fix by hand. Re-flowing every affected
     * monitor instead makes the editor behave like Windows Display Settings,
     * where the layout cannot be left in an invalid state.
     *
     * The primary (id 0) and the moved monitor stay fixed as anchors; all
     * other invalid monitors are re-snapped (via arrangeMoved, which has a
     * guaranteed-valid flush-right fallback, so the repair always converges).
     * Already-valid monitors are left exactly where they are. Mutates
     * `monitors` in place. Returns true if anything moved.
     */
    function arrangeAll(monitors, movedId) {
        var changedAny = false;
        var moved = movedId != null ? String(movedId) : null;

        // Place the moved monitor first, honoring where the user dropped it.
        if (moved && monitors[moved] && arrangeMoved(monitors, moved))
            changedAny = true;

        // Non-primary ids, sorted for deterministic repair order.
        var ids = [];
        for (var id in monitors) {
            if (Object.prototype.hasOwnProperty.call(monitors, id) && Number(id) !== 0)
                ids.push(id);
        }
        ids.sort(function (a, b) { return Number(a) - Number(b); });

        // Repair pass: re-flow each monitor that is overlapping or not connected
        // to the primary's component, until the whole layout is one valid,
        // primary-anchored group. Re-attaching is done against only the
        // currently-reachable set, so a detached monitor rejoins the primary's
        // component instead of latching onto another floating monitor (e.g. the
        // sibling it drifted away from when the middle of a stack was resized).
        // Bounded, since arrangeMoved's flush-right fallback guarantees
        // convergence.
        //
        // The moved monitor is not hard-skipped: the upfront arrangeMoved above
        // already honored the drop, and the `valid && reached` early-continue
        // below keeps a validly-placed anchor exactly where the user put it. But
        // if re-flowing a sibling strands the moved monitor (it had snapped flush
        // to a detached sibling that then got pulled back to the primary), the
        // anchor must be re-attached too; otherwise it is left floating and the
        // layout is invalid.
        var maxPasses = (ids.length + 1) * 3;
        var pass = 0;
        var dirty = true;
        while (dirty && pass++ < maxPasses) {
            dirty = false;
            for (var i = 0; i < ids.length; i++) {
                var mid = ids[i];
                // Recompute connectivity each step: once one detached monitor
                // re-attaches, the next one should be able to snap onto IT (so a
                // stack rebuilds in order), not just onto the primary.
                var reached = reachableFromPrimary(monitors);
                // Valid only if it does not overlap and is attached to the primary.
                if (monitorValid(mid, monitors) && reached[mid]) continue;

                /* Snap against only the primary-connected monitors (plus
                 * itself): excluding floating siblings forces it to re-attach to
                 * the primary's component rather than to the detached cluster. */
                var sub = {};
                for (var rid in monitors) {
                    if (Object.prototype.hasOwnProperty.call(monitors, rid)
                            && (reached[rid] || rid === mid))
                        sub[rid] = monitors[rid];
                }
                if (arrangeMoved(sub, mid)) { dirty = true; changedAny = true; }
            }
        }
        return changedAny;
    }

    /* Public geometry helper (also used by directives and tests). */
    service.arrangeAll = arrangeAll;

    /**
     * Canonical layout validator/corrector. Takes a map of monitor id ->
     * {width, height, left, top} in device-px (wire) space and returns a
     * corrected copy guaranteed to satisfy the MS-RDPEDISP dimension and
     * primary-anchor rules:
     *
     *   - width  clamped to [200, 8192] and forced even
     *   - height clamped to [200, 8192]
     *   - primary (id 0) anchored at left=0, top=0
     *
     * Inputs are assumed to be finite numbers (they originate from
     * monitorsInfos.details, which is always populated with finite
     * device-px values); non-finite input is not guarded here.
     *
     * By default only these rules apply. Snap-to-edge, overlap push, and
     * gap pull are opt-in via opts.arrange (see below).
     *
     * Pure: does not mutate its input and reads no external state.
     *
     * @param {!Object.<string, {width:number,height:number,left:number,top:number}>} monitors
     *     The proposed layout, in device-px space.
     *
     * @returns {!{monitors: Object, warnings: string[], changed: boolean}}
     *     The corrected layout, any warnings that could not be auto-corrected
     *     (currently: the combined desktop exceeding guacd's surface cap), and
     *     whether any value changed.
     */
    function normalizeLayout(monitors, opts) {
        var out = {};
        var changed = false;

        /* Even-width forcing is a device/wire requirement (MS-RDPEDISP
         * §2.2.2.2.1: the layout PDU Width must be even). It is incorrect in
         * logical space: the modal arranges in Windows-logical px and uses
         * the un-evened logical width for its tiles, so evening here would
         * make a flush snap land 1px off (e.g. a 437-wide monitor evened to
         * 436 snaps flush-left to -436, but the 437-wide tile then overlaps
         * primary by 1px, a false "overlap" warning). Callers in logical
         * space pass opts.evenWidth === false; wire-space callers keep the
         * default even-forcing. guacd also enforces width &= ~1
         * server-side, so the wire stays spec-valid regardless. */
        var forceEven = !(opts && opts.evenWidth === false);

        for (var id in monitors) {
            if (!Object.prototype.hasOwnProperty.call(monitors, id))
                continue;

            var m = monitors[id];
            var w = clampDim(m.width, forceEven);
            var h = clampDim(m.height, false);
            var left = m.left;
            var top  = m.top;

            // Primary is always anchored at the origin.
            if (Number(id) === 0) {
                left = 0;
                top  = 0;
            }

            if (w !== m.width || h !== m.height
                    || left !== m.left || top !== m.top)
                changed = true;

            out[id] = { width: w, height: h, left: left, top: top };
        }

        /* Optional auto-arrange: snap the moved monitor to a valid position
         * and re-flow any other monitor left invalid (orphaned/gap/overlap),
         * so the whole layout ends valid, not just the moved one. Opt-in so
         * callers that only need clamping keep the plain clamp/anchor
         * behavior. movedId is the anchor (kept where the user placed it);
         * when absent/primary, every invalid monitor is repaired against the
         * primary anchor. */
        if (opts && opts.arrange) {
            var movedId = (opts.movedId != null && Number(opts.movedId) !== 0
                           && out[opts.movedId]) ? String(opts.movedId) : null;
            if (arrangeAll(out, movedId))
                changed = true;
        }

        /* Combined-extent check: guacd composites all monitors into one display
         * surface capped at GUAC_DISPLAY_MAX_WIDTH × GUAC_DISPLAY_MAX_HEIGHT.
         * A bounding box larger than that is silently clipped (white past the
         * edge). Per-monitor dims are already clamped above, but the combined
         * extent is not, so it is surfaced as a warning (each axis vs its own
         * cap). Unlike gap/overlap, this is not auto-repairable by re-flowing,
         * so it is reported, not corrected. */
        var warnings = [];
        var ext = layoutExtent(out);
        if (ext.width > GUAC_DISPLAY_MAX_WIDTH
                || ext.height > GUAC_DISPLAY_MAX_HEIGHT)
            warnings.push('Combined desktop is ' + ext.width + '×'
                + ext.height + ' px — the maximum is '
                + GUAC_DISPLAY_MAX_WIDTH + '×' + GUAC_DISPLAY_MAX_HEIGHT
                + '. Move screens into a more compact arrangement (e.g. a grid '
                + 'instead of one row) or remove a screen.');

        return { monitors: out, warnings: warnings, changed: changed };
    }

    /* Public layout validator/corrector (also used by the layout editor). */
    service.normalizeLayout = normalizeLayout;

    /**
     * Send size event to guacd and update monitorsInfos object.
     *
     * @param {Guacamole.Client|null} requestedClient
     *     The Guacamole client to send the size to. This is needed for
     *     connection groups with multiple clients. May be null when no
     *     client is attached yet; monitor state is still updated and
     *     broadcast, but wire sends are skipped (a close's 0x0 sentinel
     *     is deferred and replayed by setClient).
     * @param {Object} size
     *     The size object containing width, height, top and monitorId.
     */
    service.sendSize = function sendSize(requestedClient, size) {

        const monitorPosition = monitorsInfos.map[size.monitorId];

        // Treat (0, 0) as the close sentinel; do not clamp it up to 200.
        const isClose = (size.width === 0 || size.height === 0);
        const w = isClose ? 0 : clampDim(size.width, true);
        const h = isClose ? 0 : clampDim(size.height, false);

        updateMonitorsInfos({
            id:     size.monitorId,
            width:  w,
            height: h,
            left:   size.left,
            top:    size.top,
        });

        // Without a connected client (e.g. a monitor close relayed before
        // the primary's client is attached) skip the wire sends; the
        // monitorsInfos update above and the broadcast below still run so
        // window state stays consistent. A close's 0x0 sentinel is
        // remembered and replayed by setClient; otherwise guacd would
        // keep the closed monitor indefinitely (sendAllSizes only re-sends
        // surviving monitors).
        if (!requestedClient) {
            if (isClose && monitorPosition != null)
                pendingCloseSentinels.push(monitorPosition);
            service.pushBroadcastMessage('monitorsInfos', monitorsInfos);
            return;
        }

        // Monitor has been closed
        if (isClose) {
            requestedClient.sendSize(0, 0, monitorPosition, 0);
            /* Re-send the remaining monitors with a re-validated layout.
             * Closing a monitor, especially a middle one, otherwise leaves
             * the others at their stale offsets in guacd, with a gap where the
             * closed monitor was; Windows silently rejects that layout and the
             * screens show artifacts. sendAllSizes re-packs and repairs before
             * it submits (see the auto-validate pass there). */
            sendAllSizes(requestedClient);
        }

        // Send new size to guacd using a leading edge plus a settle timer that
        // re-arms on every resize. The first resize after an idle gap applies
        // immediately (responsive); every subsequent resize pushes the settle
        // deadline out, so a continuous drag stays silent until the user pauses
        // for SEND_ALL_SIZES_DEBOUNCE ms, then exactly one trailing send applies
        // the final size. A continuous drag therefore costs one leading plus one
        // trailing send, not one per frame.
        //
        // The settle timer must re-arm rather than expire on a fixed interval. A
        // fixed interval lets a full layout build, validate, and wire send run
        // every frame on the main thread, which floods the browser-to-guacd
        // channel; guacd's input thread then reads no instruction within its
        // timeout and aborts the user with "User is not responding," dropping
        // the connection mid-drag.
        else {
            const changedId = size.monitorId;

            // Leading edge only on the idle-to-active transition.
            if (sendAllSizesTimer === null)
                sendAllSizes(requestedClient, changedId);   // leading edge
            else {
                sendAllSizesPending = true;          // coalesce: remember latest
                sendAllSizesPendingId = changedId;
            }

            // (Re)arm the settle timer on every resize so the trailing send
            // fires once, after the drag stops.
            if (sendAllSizesTimer !== null)
                clearTimeout(sendAllSizesTimer);
            sendAllSizesTimer = setTimeout(function () {
                sendAllSizesTimer = null;
                if (sendAllSizesPending) {
                    sendAllSizesPending = false;
                    sendAllSizes(requestedClient, sendAllSizesPendingId);  // trailing edge
                }
            }, SEND_ALL_SIZES_DEBOUNCE);
        }

        // Push informations to all monitors
        service.pushBroadcastMessage('monitorsInfos', monitorsInfos);

    }

    /**
     * Get the X offset of a monitor within the combined desktop. Equal to
     * the monitor's rendered.left minus the lowest rendered.left across
     * all monitors, so the leftmost monitor has offset 0 and others are
     * positive. Supports non-linear layouts (e.g. a secondary positioned
     * to the left of primary will yield primary.offsetX > 0 and
     * secondary.offsetX = 0).
     *
     * Example: primary at rendered.left=0 width 1920, secondary at
     * rendered.left=-1080. Lowest left = -1080. primary.offsetX = 0 -
     * (-1080) = 1080. secondary.offsetX = -1080 - (-1080) = 0.
     *
     * @param {Number|String} [monitorId=service.monitorId]
     *     The monitor id to query. Defaults to this window's monitor.
     *
     * @return {number}
     *     The X offset of the given monitor, in pixels.
     */
    service.getOffsetX = function getOffsetX(monitorId) {

        if (monitorId === undefined)
            monitorId = service.monitorId;

        const currentLeft = monitorsInfos.rendered[monitorId]?.left ?? 0;
        return currentLeft - getLowestLeftOffset();
    };

    /**
     * Get the Y offset of a monitor within the combined desktop. Equal to
     * the monitor's rendered.top minus the lowest rendered.top across all
     * monitors (so the topmost monitor has offset 0 and others are
     * positive).
     *
     * @param {Number|String} [monitorId=service.monitorId]
     *     The monitor id to query. Defaults to this window's monitor.
     *
     * @return {number}
     *     The Y offset of the given monitor, in pixels.
     */
    service.getOffsetY = function getOffsetY(monitorId) {

        if (monitorId === undefined)
            monitorId = service.monitorId;

        const currentOffset = monitorsInfos.rendered[monitorId]?.top ?? 0;
        return currentOffset - getLowestTopOffset();
    };

    /**
     * Send the size of all monitors to guacd. This is used to update the
     * monitor sizes in guacd when a new monitor is added or updated.
     *
     * This function loops through all monitors and sends their sizes to guacd
     * using the client.sendSize method. The size includes width, height,
     * monitor position and top offset.
     *
     * @param {Guacamole.Client} requestedClient
     *     The Guacamole client to send the sizes to.
     */
    function sendAllSizes(requestedClient, changedId) {

        /* Restricted non-linear layout: a negative leftOffset is not
         * rendered correctly through FreeRDP and the server-side layout
         * path, so one is never sent. Without an explicit user layout
         * (see layoutOverride below), the offset argument is omitted
         * entirely so guacd uses its cumulative left-to-right layout. */
        const primaryWidth = service.committedDims(0).width;

        /* When a custom layout is active (the user applied positions via the
         * Display Settings UI), every monitor must be sent with an explicit
         * offset. A newly-opened monitor has no override entry yet; sending
         * it as INT_MIN (cumulative fallback) while the others are explicit
         * makes guacd place it by summing widths left-to-right, which
         * collides or gaps against the real positions (e.g. a left-of-primary
         * monitor) and yields a layout Windows rejects, visible as a white,
         * mispositioned secondary. Each not-yet-overridden monitor is given a
         * contiguous default: just past the current rightmost edge,
         * top-aligned with primary. The user can then move it in the UI. */
        const overrideActive = Object.keys(layoutOverride).length > 0;
        const fallbackOffset = {};
        if (overrideActive) {
            let maxRight = primaryWidth;
            for (const oid of Object.keys(layoutOverride)) {
                const w = service.committedDims(oid).width;
                const right = layoutOverride[oid].leftOffset + w;
                if (right > maxRight) maxRight = right;
            }
            let cum = maxRight;
            for (const id of Object.keys(monitorsInfos.details)) {
                if (Number(id) === 0 || layoutOverride[id]) continue;
                fallbackOffset[id] = { leftOffset: cum, topOffset: 0 };
                cum += service.committedDims(id).width;
            }
        }

        /* Resize auto-fix: when a monitor's size just changed and a custom
         * layout is active, its stored override offset was computed for the
         * previous size and may now overlap or gap a neighbor (e.g. a
         * left-of-primary monitor that grew or shrank). Re-arrange just that
         * monitor in committed space and persist the corrected offset so the
         * modal reflects it. arrangeMoved skips already-valid monitors, so this
         * is a no-op in the normal case. The modal-Apply path passes no
         * changedId and is unaffected.
         *
         * Coordinate space: guacd renders every monitor at committed =
         * details / sessionDpr and places offsets verbatim in that committed
         * space. layoutOverride already holds committed-space offsets (the modal
         * works in committed space and applyLayoutOverride stores its values
         * unconverted). So the arrange map uses committed widths (committedDims =
         * details/dpr) and committed offsets (layoutOverride verbatim), both
         * already in the same space. evenWidth:false because even-forcing is a
         * device-wire concern handled by sendSize and guacd, and is incorrect in
         * committed/logical space. */
        if (overrideActive && changedId != null
                && Number(changedId) !== 0 && layoutOverride[changedId]
                && monitorsInfos.details[changedId]) {
            const pc = service.committedDims(0);
            const cmap = { 0: { width: pc.width, height: pc.height, left: 0, top: 0 } };
            for (const oid of Object.keys(layoutOverride)) {
                if (!monitorsInfos.details[oid]) continue;
                const cd = service.committedDims(oid);
                cmap[oid] = {
                    width:  cd.width,
                    height: cd.height,
                    left:   layoutOverride[oid].leftOffset,
                    top:    layoutOverride[oid].topOffset
                };
            }
            const fixed = normalizeLayout(cmap,
                    { arrange: true, movedId: String(changedId), evenWidth: false });
            const fm = fixed.monitors[changedId];
            if (fm)
                layoutOverride[changedId] = { leftOffset: fm.left, topOffset: fm.top };
        }

        /* Compute the offset each monitor will be sent at (committed space).
         * Priority: explicit UI override, then contiguous fallback (only when a
         * custom layout is active), then cumulative-only (undefined, linear,
         * with guacd laying out itself). Applied to every id including the
         * primary, so the no-override path still omits leftOffset (undefined)
         * and guacd lays out linearly itself; the primary is not special-cased
         * to 0 here. */
        const finalOffset = {};
        for (const id of Object.keys(monitorsInfos.details)) {
            const override = layoutOverride[id];
            const fallback = fallbackOffset[id];
            finalOffset[id] = {
                leftOffset: override ? override.leftOffset
                          : fallback ? fallback.leftOffset
                          : undefined,
                topOffset:  override ? override.topOffset
                          : fallback ? fallback.topOffset
                          : 0
            };
        }

        /* Auto-validate before submit: never hand guacd a gap or overlap
         * layout, which Windows silently rejects, making every screen show
         * artifacts. This is the safety net for invalidity the per-action
         * arrange cannot see, most importantly closing a middle monitor, where
         * the remaining monitors keep stale offsets with a gap where it was (the
         * close re-send reaches here with no changedId, so the resize auto-fix
         * above cannot catch it). Build the committed-space layout, re-flow every
         * invalid monitor to a gap-free, overlap-free, edge-connected position,
         * and submit the corrected offsets. This is a no-op for an already-valid
         * layout (byte-identical wire). Skipped on the cumulative-only path
         * (offsets undefined, with guacd laying out linearly itself). When a
         * custom layout is active, persist the correction so the modal and
         * subsequent sends stay consistent. */
        const offsetsKnown = Object.keys(finalOffset).every(function (id) {
            return finalOffset[id].leftOffset != null && finalOffset[id].topOffset != null;
        });
        if (offsetsKnown && Object.keys(monitorsInfos.details).length > 1) {
            const vmap = {};
            for (const id of Object.keys(finalOffset)) {
                const cd = service.committedDims(id);
                vmap[id] = { width: cd.width, height: cd.height,
                             left: finalOffset[id].leftOffset, top: finalOffset[id].topOffset };
            }
            const repaired = normalizeLayout(vmap, { arrange: true, evenWidth: false }).monitors;
            for (const id of Object.keys(repaired)) {
                if (Number(id) === 0) continue;
                finalOffset[id] = { leftOffset: repaired[id].left, topOffset: repaired[id].top };
                if (overrideActive && layoutOverride[id])
                    layoutOverride[id] = { leftOffset: repaired[id].left, topOffset: repaired[id].top };
            }
        }

        /* Combined-extent enforcement, in committed space: the space guacd
         * composites in and that the editor checks (sizes via committedDims,
         * not raw device details, so the cap matches at any DPR).
         *
         * guacd caps its single composited surface at GUAC_DISPLAY_MAX_WIDTH ×
         * GUAC_DISPLAY_MAX_HEIGHT and silently clips the overflow to white. The
         * editor blocks Apply for an over-cap layout; this handles the
         * non-modal paths (a direct popup resize, or a newly-added screen)
         * which have no Apply button to gate. When the just-changed monitor
         * pushed the desktop over the cap, that monitor is clamped to fit (the
         * same silent coercion clampDim already applies for even-width and
         * [200,8192]) and the layout is re-flowed, so the desktop stays valid
         * and fully rendered instead of going blank. This is position-agnostic:
         * shrinking the victim and re-running the arrange packer (movedId =
         * victim, so it stays put and neighbours snap to it) handles
         * right/left/above/below/middle on either axis. */
        function committedRects(victimW, victimH) {
            function dimsOf(id) {
                if (victimW != null && String(id) === String(changedId))
                    return { width: victimW, height: victimH };
                return service.committedDims(id);
            }
            /* Fill any monitor that has no explicit offset (the cumulative-only
             * path sends undefined and lets guacd pack left-to-right) by
             * simulating that same packing; otherwise every rect collapses to
             * the origin and a genuine overflow (e.g. adding a 4th wide screen
             * with no editor override) goes undetected. Order by wire position
             * (monitorsInfos.map), matching guacd's get_left_offset. */
            const ids = Object.keys(monitorsInfos.details);
            const byPos = ids.slice().sort(function (a, b) {
                return (monitorsInfos.map[a] || 0) - (monitorsInfos.map[b] || 0);
            });
            const cumLeft = {};
            let cum = 0;
            for (const pid of byPos) { cumLeft[pid] = cum; cum += dimsOf(pid).width; }

            const rects = {};
            for (const id of ids) {
                const cd = dimsOf(id);
                const fo = finalOffset[id];
                rects[id] = {
                    width:  cd.width,
                    height: cd.height,
                    left:   (fo && fo.leftOffset != null) ? fo.leftOffset : cumLeft[id],
                    top:    (fo && fo.topOffset  != null) ? fo.topOffset  : 0
                };
            }
            return rects;
        }

        let ext = layoutExtent(committedRects());
        let clampVictim = null;   // {width, height} in committed px, or null
        if (ext.width > GUAC_DISPLAY_MAX_WIDTH || ext.height > GUAC_DISPLAY_MAX_HEIGHT) {

            /* Clamp only the changed non-primary monitor. (No offsetsKnown
             * gate: committedRects treats an undefined primary offset as 0 and
             * normalizeLayout anchors the primary, so the cumulative-only
             * case, where all offsets are undefined and every rect sits at 0,0
             * with an extent within the cap, never reaches here.) */
            const canClamp = changedId != null && Number(changedId) !== 0
                && monitorsInfos.details[changedId];

            if (canClamp) {
                const vd = service.committedDims(changedId);
                let vw = vd.width, vh = vd.height;
                for (let pass = 0; pass < 4; pass++) {
                    if (ext.width  > GUAC_DISPLAY_MAX_WIDTH)
                        vw = clampDim(vw - (ext.width  - GUAC_DISPLAY_MAX_WIDTH), true);
                    if (ext.height > GUAC_DISPLAY_MAX_HEIGHT)
                        vh = clampDim(vh - (ext.height - GUAC_DISPLAY_MAX_HEIGHT), false);
                    const fixed = normalizeLayout(committedRects(vw, vh),
                            { arrange: true, movedId: String(changedId), evenWidth: false }).monitors;
                    for (const fid of Object.keys(fixed)) {
                        if (Number(fid) === 0) continue;
                        finalOffset[fid] = { leftOffset: fixed[fid].left, topOffset: fixed[fid].top };
                    }
                    ext = layoutExtent(fixed);   // fixed carries the victim at vw×vh
                    if (ext.width <= GUAC_DISPLAY_MAX_WIDTH
                            && ext.height <= GUAC_DISPLAY_MAX_HEIGHT) break;
                    if (vw <= 200 && vh <= 200) break;   // victim cannot shrink further
                }
                if (ext.width <= GUAC_DISPLAY_MAX_WIDTH
                        && ext.height <= GUAC_DISPLAY_MAX_HEIGHT)
                    clampVictim = { width: vw, height: vh };
            }

            if (!clampVictim) {
                /* Could not fit by clamping the changed monitor (no changedId,
                 * primary changed, or the victim alone cannot absorb it). Keep
                 * the last good layout untouched; still inform the user. */
                console.warn('[multimon] sendAllSizes: combined desktop '
                    + ext.width + '×' + ext.height + ' px exceeds guacd cap '
                    + GUAC_DISPLAY_MAX_WIDTH + '×' + GUAC_DISPLAY_MAX_HEIGHT
                    + ' — kept last good layout.');
                if (!extentClampActive) {
                    extentClampActive = true;
                    if (typeof service.onExtentClamped === 'function')
                        service.onExtentClamped({ monitorId: changedId });
                }
                return;
            }

            console.warn('[multimon] sendAllSizes: clamped monitor ' + changedId
                + ' to ' + clampVictim.width + '×' + clampVictim.height
                + ' (committed) to keep the desktop within ' + GUAC_DISPLAY_MAX_WIDTH
                + '×' + GUAC_DISPLAY_MAX_HEIGHT + '.');
            if (!extentClampActive) {
                extentClampActive = true;
                if (typeof service.onExtentClamped === 'function')
                    service.onExtentClamped({ monitorId: changedId });
            }
        }
        else {
            /* In range, so close any clamp episode so a later overflow re-notifies. */
            extentClampActive = false;
        }

        /* Send sizes. The wire encoding is asymmetric by guacd's contract
         * (guac_rdp_user_size_handler in input.c):
         *   - width/height are scaled by resolution/optimal_resolution
         *     (device to logical) and the logical width is then evened
         *     (width &= ~1), so send device px (monitorsInfos.details).
         *   - top_offset/left_offset are used verbatim (not scaled), so send
         *     committed/logical px (finalOffset, the committed-space layout).
         * Offsets were packed against committedDims, which is evened to match
         * guacd's logical even-clamp (see committedDims), so a monitor's
         * committed edge lands exactly on guacd's evened logical width, with
         * no 1px gap. A clamped victim is sent at its reduced device size
         * (committed * dpr); monitorsInfos.details is intentionally not
         * mutated, so shrinking the window later simply fits with no clamp.
         * Use Math.ceil (not round) for the committed-to-device conversion:
         * guacd recovers the logical size as floor(device / dpr), and ceil is
         * the smallest device size whose floor lands back exactly on the
         * committed value the neighbors were packed against. round can land a
         * half-pixel low on fractional DPRs (e.g. committed 795 * 1.75 = 1391.25,
         * round 1391, guacd floor(1391/1.75) = 794), leaving a 1px gap Windows
         * rejects; ceil(1391.25) = 1392, floor(1392/1.75) = 795, exact. */
        const clampDpr = service.getSessionDpr();
        for (const [id, details] of Object.entries(monitorsInfos.details)) {
            const topOffset  = finalOffset[id] ? finalOffset[id].topOffset  : 0;
            const leftOffset = finalOffset[id] ? finalOffset[id].leftOffset : undefined;

            let sendW = details.width, sendH = details.height;
            if (clampVictim && String(id) === String(changedId)) {
                sendW = Math.ceil(clampVictim.width  * clampDpr);
                sendH = Math.ceil(clampVictim.height * clampDpr);
            }

            requestedClient.sendSize(
                sendW,
                sendH,
                monitorsInfos.map[id],
                topOffset,
                leftOffset
            );
        }
    }

    /**
     * Get the lowest rendered.left value across all monitors. Used to
     * normalize each monitor's left offset to a non-negative range
     * starting at 0, supporting layouts where a non-primary monitor
     * sits to the left of primary in Windows coordinates.
     *
     * @return {number}
     *     The lowest rendered.left, or 0 if no monitor has a left
     *     value.
     */
    function getLowestLeftOffset() {
        let lowestLeftValue = monitorsInfos.rendered[0]?.left ?? 0;

        for (const [_, rendered] of Object.entries(monitorsInfos.rendered)) {
            if (rendered?.left < lowestLeftValue) {
                lowestLeftValue = rendered.left;
            }
        }

        return lowestLeftValue;
    }

    /**
     * Get the lowest top value of all monitors. This is used to calculate the
     * Y offset of the current monitor.
     *
     * @return {number}
     *     The lowest top value of all monitors, in pixels.
     */
    function getLowestTopOffset() {
        let lowestTopValue = monitorsInfos.rendered[0]?.top ?? 0;

        // Loop through all monitors to find the highest monitor
        for (const [_, rendered] of Object.entries(monitorsInfos.rendered)) {
            if (rendered?.top < lowestTopValue) {
                lowestTopValue = rendered.top;
            }
        }

        return lowestTopValue;
    }

    /**
     * Update monitorsInfos object with current monitors count and map.
     *
     * @param {Object} monitorDetails
     *     Optional monitor details to update the monitorsInfos object.
     */
    function updateMonitorsInfos(monitorDetails) {

        monitorsInfos.count = service.getMonitorCount();

        // The main window would represent 0
        let monitorPosition = 1;

        // Generate monitors map (id => position), main window is always at
        // position 0
        monitorsInfos.map[0] = 0;
        for (const monitorKey in monitors) {
            monitorsInfos.map[monitorKey] = monitorPosition++;
        }

        // Set monitor details if provided
        if (!monitorDetails)
            return;

        // If width or height is 0, remove monitor details
        if (monitorDetails.width === 0 || monitorDetails.height === 0) {
            delete monitorsInfos.details[monitorDetails.id];
            delete monitorsInfos.rendered[monitorDetails.id];
            delete monitorsInfos.map[monitorDetails.id];
        }
        // Update or add monitor details
        else {
            const monitorId = monitorDetails.id;
            monitorsInfos.details[monitorId] = {
                width:  monitorDetails.width,
                height: monitorDetails.height,
                top:    monitorDetails.top,
                left:   monitorDetails.left,
            };
        }        

    };

    /**
     * Handle the multimonitor layout event. This is used to update the
     * monitorsInfos object when the layout changes.
     *
     * @param {Object} layout
     *     An object describing the layout of monitors.
     *
     * @returns {!boolean}
     *     true if the layout was applied, false if it was skipped (no
     *     layout, or this window's client/display not yet attached).
     *     The secondary message handler uses this to keep its draw
     *     buffering active until a layout has actually been applied.
     */
    function onmultimonlayout(layout) {
        if (!layout)
            return false;

        /* A layout can be relayed to a secondary window before its dummy
         * client/display have been attached by the directive (template
         * load is asynchronous); applying it would throw and skip the
         * buffered-draw flush. The primary re-broadcasts on every guacd
         * layout, so a skipped early layout is recovered naturally. */
        if (!client || !display)
            return false;

        // First pass: update every monitor's rendered region. All
        // monitors must be current before offsets are computed, because
        // service.getOffsetX/getOffsetY iterate the full rendered set
        // (e.g. the lowest top across all monitors). Computing them mid-
        // loop would use partially-stale data, and those offsets are
        // applied directly to the display element's canvas position via
        // setMonitorSize, so a stale value during the loop would stick
        // visually until the next layout update.
        /* Monitors absent from the relayed layout are collected here and
         * closed after the first pass, not mid-loop. closeMonitor re-enters
         * sendSize -> sendAllSizes (and rebuilds monitorsInfos.map); running
         * that while the loop is still refreshing the surviving monitors'
         * rendered regions would pack survivors against a half-updated state
         * and emit a redundant wire layout. Deferring keeps the removal to a
         * single sweep over a fully-consistent layout. */
        const toClose = [];

        for (const [id, pos] of Object.entries(monitorsInfos.map)) {

            // If the monitor is not in the layout, guacd either dropped it
            // or has not caught up with a just-added monitor. Only close it
            // if guacd previously acknowledged it (confirmedMonitors): a
            // never-yet-confirmed monitor absent from an in-flight layout is
            // a race, not a real removal; closing it would tear down the
            // freshly-opened popup.
            if (!layout[pos]) {
                if (confirmedMonitors[id])
                    toClose.push(id);
                continue;
            }

            // guacd has acknowledged this monitor in a layout.
            confirmedMonitors[id] = true;

            if (!monitorsInfos.rendered[id])
                monitorsInfos.rendered[id] = {};

            monitorsInfos.rendered[id].width  = layout[pos].width;
            monitorsInfos.rendered[id].height = layout[pos].height;
            monitorsInfos.rendered[id].top    = layout[pos].top;
            monitorsInfos.rendered[id].left   = layout[pos].left;

        }

        /* Now that every surviving monitor's rendered region is current,
         * drop the monitors guacd removed (one settled sendAllSizes each). */
        for (let ci = 0; ci < toClose.length; ci++)
            service.closeMonitor(toClose[ci]);

        /* Release the Add lock once guacd has acknowledged the just-added
         * monitor: its desktop-growth resize has settled, so the next add is
         * safe. */
        if (addPendingId !== null && confirmedMonitors[addPendingId])
            releaseAddPending();

        // Second pass: with all rendered values now current, apply the
        // monitor clip to this window's display and update the client's
        // offsetX/Y so subsequent drawing instructions land at the right
        // place within this window's clamped canvas.
        const myId = String(service.monitorId);
        if (monitorsInfos.rendered[myId]) {
            const myWidth  = monitorsInfos.rendered[myId].width;
            const myHeight = monitorsInfos.rendered[myId].height;

            display.setMonitorSize(myWidth, myHeight);

            /* setMonitorSize only sets the clamp used by future resizes; it
             * does not size the canvas. A secondary window's canvas is fed
             * solely by relayed instructions, so without an explicit resize
             * its default layer stays 0x0 and every draw is invisible, so the
             * secondary opens black. Size it directly here. The primary's
             * canvas is sized authoritatively by guacd, so this is done only
             * for secondaries, to avoid fighting the server-driven size. */
            if (monitorType === "secondary")
                display.resize(display.getDefaultLayer(), myWidth, myHeight);
        }

        // Inform the client of the current monitor offsets so all
        // drawing handlers (and the sendMouseState path) translate
        // full-desktop coordinates to this window's local canvas
        // correctly.
        client.offsetX = service.getOffsetX();
        client.offsetY = service.getOffsetY();

        /* Relay the layout to secondary monitor windows. Only the primary's
         * Guacamole client is connected to guacd, so secondaries never see
         * multimon-layout instructions unless they are forwarded. Without this,
         * a popup-window resize on a secondary would leave its display canvas at
         * the pre-resize dimensions, visible as a white margin around the
         * rendered desktop area. */
        if (monitorType === "primary")
            service.pushBroadcastMessage('multimonLayout', layout);

        /* Notify the host directive so it can re-fit display.scale to
         * the popup container; setMonitorSize updated the canvas dims
         * above, so any scale computed before this point is stale. */
        if (typeof service.onLayoutChange === 'function')
            service.onLayoutChange();

        /* Additional notifier (primary) so the layout-editor modal can
         * re-snapshot its logical "Windows currently has" view after guacd
         * commits a layout. Separate from onLayoutChange so the two hooks
         * do not clobber each other. */
        if (typeof service.onMonitorsInfoUpdate === 'function')
            service.onMonitorsInfoUpdate();

        return true;

    }

    // Close additional monitors when window is unloaded
    $window.addEventListener('unload', service.closeAllMonitors);

    return service;

}]);
