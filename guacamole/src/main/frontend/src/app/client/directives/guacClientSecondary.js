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
 * A directive for the guacamole client on secondary monitors.
 */
angular.module('client').directive('guacClientSecondary', [function guacClient() {

    const directive = {
        restrict: 'E',
        replace: true,
        templateUrl: 'app/client/templates/guacClient.html'
    };

    directive.scope = {

        /**
         * The client to display within this guacClient directive.
         * 
         * @type ManagedClient
         */
        client : '=',

    };

    directive.controller = ['$scope', '$injector', '$element',
        function guacClientController($scope, $injector, $element) {

        // Required types
        const ClipboardData     = $injector.get('ClipboardData');

        // Required services
        const $document         = $injector.get('$document');
        const $window           = $injector.get('$window');
        const clipboardService  = $injector.get('clipboardService');
        const guacManageMonitor = $injector.get('guacManageMonitor');

        /**
         * The current Guacamole client instance.
         * 
         * @type Guacamole.Client 
         */
        const client = new Guacamole.Client(new Guacamole.Tunnel());

        /**
         * The display of the current Guacamole client instance.
         * 
         * @type Guacamole.Display
         */
        const display = client.getDisplay();

        /**
         * The element associated with the display of the current
         * Guacamole client instance.
         *
         * @type Element
         */
        const displayElement = display.getElement();

        /**
         * The element which must contain the Guacamole display element.
         *
         * @type Element
         */
        const displayContainer = $element.find('.display')[0];

        /**
         * The main containing element for the entire directive.
         * 
         * @type Element
         */
        const main = $element[0];

        /**
         * The tracked mouse.
         *
         * @type Guacamole.Mouse
         */
        const mouse = new Guacamole.Mouse(displayContainer);

        /**
         * The latest known mouse state.
         * 
         * @type Object
         */
        const mouseState = {};

        /**
         * The keyboard.
         * 
         * @type Guacamole.Keyboard
         */
        const keyboard = new Guacamole.Keyboard($document[0]);

        // Set client instance on guacManageMonitor service
        guacManageMonitor.setClient(client);

        // Remove any existing display
        displayContainer.innerHTML = "";

        // Add display element
        displayContainer.appendChild(displayElement);

        // Do nothing when the display element is clicked on
        displayElement.onclick = function(e) {
            e.preventDefault();
            return false;
        };

        /**
         * Re-fits this monitor's display canvas to the popup container. The
         * display's internal width and height only become valid after the
         * server-side multi-monitor layout update is applied, so this is
         * invoked both on popup resize and from the onLayoutChange callback
         * once those dimensions are known. Scales by min(wRatio, hRatio) to
         * preserve the desktop aspect ratio (letterbox rather than stretch).
         */
        const applyScale = function applyScale() {
            const dispW = Math.max(display.getWidth(),  1);
            const dispH = Math.max(display.getHeight(), 1);
            const scale = Math.min(
                main.offsetWidth  / dispW,
                main.offsetHeight / dispH
            );
            if (isFinite(scale) && scale > 0)
                display.scale(scale);
        };

        /* Re-fit the display when the layout-applied callback fires, covering
         * popup-container changes that do not alter the canvas size. */
        guacManageMonitor.onLayoutChange = applyScale;

        /* Re-fit whenever the canvas itself is resized. Guacamole fires
         * onresize from within the resize task, once the display dimensions
         * are valid, so the scale is always recomputed against real
         * dimensions. This covers both the initial render after a monitor is
         * added and any later resize. */
        display.onresize = applyScale;

        /* Throttle state for the cross-window 'size' broadcast. A continuous
         * window drag fires mainElementResized every animation frame. Relaying
         * each frame to the primary makes it run its full sendSize bookkeeping
         * and monitorsInfos echo per frame, which can saturate the primary's
         * main thread until it can no longer answer guacd's sync heartbeat, at
         * which point guacd aborts the connection with "User is not
         * responding". The effect is greatest for a left or top monitor, whose
         * drag changes both the window origin (screenX/screenY) and its size
         * every frame. Coalescing to a leading and trailing send keeps the
         * relay quiet during the drag. Local scaling (applyScale) remains
         * per-frame, as it has no cross-window cost and keeps the resize
         * visually smooth. */
        let sizeBroadcastTimer = null;
        const SIZE_BROADCAST_DEBOUNCE = 150;

        /* The '.client-main' container's overflow stays hidden so the scaled
         * canvas never shows scrollbars. The element is constant, so it is
         * resolved once on the first resize frame and reused rather than
         * re-queried every animation frame of a drag. */
        let clientMain = null;

        const broadcastSize = function broadcastSize() {
            /* Only broadcast a real size. mainElementResized also runs before
             * the popup's DOM has laid out, when offsetWidth/Height are 0. A
             * 0x0 broadcast makes the primary emit width=0/height=0, which
             * guacd treats as a monitor-close serialized to x_position 0,
             * targeting the primary. Monitor close is instead signalled by the
             * 'monitorClose' broadcast on window unload. */
            if (!(main.offsetWidth && main.offsetHeight))
                return;

            /* Broadcast the CSS size. The primary converts it to wire (device)
             * pixels using the session DPR it pinned at connect. guacd divides
             * every monitor's wire size by that single session DPI, so the
             * conversion must use the primary's pinned value rather than this
             * window's own devicePixelRatio, which differs on a different-DPI
             * monitor and would offset this monitor by ownDPR/sessionDpr
             * (cross-DPI overlap). Performing the conversion on the primary
             * means this window never needs the DPR, avoiding any race against
             * the pinned value. */
            guacManageMonitor.pushBroadcastMessage('size', {
                width:     main.offsetWidth,
                height:    main.offsetHeight,
                top:       $window.screenY,
                left:      $window.screenX,
                monitorId: guacManageMonitor.monitorId,
            });
        };

        // Adjust the display scaling according to the window size.
        $scope.mainElementResized = function mainElementResized() {

            /* Relay the size to the primary on a leading and trailing throttle
             * that re-arms each frame, so a continuous drag sends one update at
             * the start and one once it settles rather than one per frame. */
            if (sizeBroadcastTimer === null)
                broadcastSize();                 // leading edge
            if (sizeBroadcastTimer !== null)
                clearTimeout(sizeBroadcastTimer);
            sizeBroadcastTimer = setTimeout(function () {
                sizeBroadcastTimer = null;
                broadcastSize();                 // trailing edge (settle)
            }, SIZE_BROADCAST_DEBOUNCE);

            /* Apply immediate scaling so there is visible feedback before the
             * server-side layout update arrives. The post-layout applyScale()
             * invocation corrects any drift once the display's internal
             * dimensions update. This is local and inexpensive, so it runs
             * per-frame. */
            applyScale();

            // Remove scrollbars; resolved and set once, constant thereafter.
            if (!clientMain) {
                clientMain = $document[0].querySelector('.client-main');
                if (clientMain)
                    clientMain.style.overflow = 'hidden';
            }

        }

        /* Cancel the pending trailing 'size' broadcast when this directive's
         * scope is torn down (for example, an in-popup route change) so the
         * timer cannot fire broadcastSize() after teardown. */
        $scope.$on('$destroy', function () {
            if (sizeBroadcastTimer !== null) {
                clearTimeout(sizeBroadcastTimer);
                sizeBroadcastTimer = null;
            }
        });

        // Ready for resize
        $scope.mainElementResized();

        // Handle any received clipboard data
        client.onclipboard = function clientClipboardReceived(stream, mimetype) {

            let reader;

            // If the received data is text, read it as a simple string
            if (/^text\//.exec(mimetype)) {

                reader = new Guacamole.StringReader(stream);

                // Assemble received data into a single string
                let data = '';
                reader.ontext = function textReceived(text) {
                    data += text;
                };

                // Set clipboard contents once stream is finished
                reader.onend = function textComplete() {
                    clipboardService.setClipboard(new ClipboardData({
                        source : 'secondaryMonitor',
                        type : mimetype,
                        data : data
                    }))['catch'](angular.noop);
                };

            }

            // Otherwise read the clipboard data as a Blob
            else {
                reader = new Guacamole.BlobReader(stream, mimetype);
                reader.onend = function blobComplete() {
                    clipboardService.setClipboard(new ClipboardData({
                        source : 'secondaryMonitor',
                        type : mimetype,
                        data : reader.getBlob()
                    }))['catch'](angular.noop);
                };
            }

        };        

        // Mirror the remote cursor shape onto this window's display element
        // as a CSS cursor, so cursor shapes (resize, hand, I-beam) update on
        // secondary windows as they do for the primary in guacClient.js via
        // client.managedDisplay.cursor.
        //
        // When mouse.setCursor succeeds, the hardware cursor renders the
        // visible cursor and the software cursor layer is hidden to avoid
        // drawing the cursor twice.
        let localCursor = false;
        display.oncursor = function onCursorChange(cursorCanvas, hotspotX, hotspotY) {
            localCursor = mouse.setCursor(cursorCanvas, hotspotX, hotspotY);
            if (localCursor)
                display.showCursor(false);
        };

        // Move mouse on screen and send mouse events to main window
        mouse.onEach(['mousedown', 'mouseup', 'mousemove'], function sendMouseEvent(e) {

            // Show the software cursor layer only if the CSS hardware
            // cursor failed to apply.
            display.showCursor(!localCursor);

            /* e.state.x/y are CSS pixels relative to the display element, as
             * Guacamole.Position.fromClientPosition applies no scaling. The
             * canvas is rendered at display.getScale(), the ratio of element
             * CSS pixels to canvas device pixels, which folds in this
             * monitor's devicePixelRatio. Dividing by the scale recovers
             * canvas (desktop device-pixel) coordinates. Without it the
             * position is only correct when scale == 1 (a 100%-DPI monitor
             * sized 1:1) and is off by 1/scale on scaled or HiDPI monitors, or
             * whenever the popup is smaller than its desktop region. The
             * primary applies this within sendMouseState(state, true); the
             * relayed secondary path applies its own window's scale here. */
            const scale = display.getScale() || 1;
            const localX = e.state.x / scale;
            const localY = e.state.y / scale;

            // Update client-side cursor at the local mouse position
            display.moveCursor(localX, localY);

            // Click on actual display instead of the first
            const displayOffsetX = guacManageMonitor.getOffsetX();
            const displayOffsetY = guacManageMonitor.getOffsetY();

            // Convert mouse state to serializable object
            mouseState.down = e.state.down;
            mouseState.up = e.state.up;
            mouseState.left = e.state.left;
            mouseState.middle = e.state.middle;
            mouseState.right = e.state.right;
            mouseState.x = localX + displayOffsetX;
            mouseState.y = localY + displayOffsetY;

            /* Mark the monitor offset as already applied, so the primary's
             * sendMouseState() does not add offsetX/Y a second time. */
            mouseState.offsetProcessed = true;

            // Send mouse state to main window
            guacManageMonitor.pushBroadcastMessage('mouseState', mouseState);
        });

        // Hide software cursor when mouse leaves display
        mouse.on('mouseout', function() {
            if (!display) return;
            display.showCursor(false);
        });

        // Send keydown events to main window
        keyboard.onkeydown = function (keysym) {
            guacManageMonitor.pushBroadcastMessage('keydown', keysym);
        };

        // Send keyup events to main window
        keyboard.onkeyup = function (keysym) {
            guacManageMonitor.pushBroadcastMessage('keyup', keysym);
        };

    }];

    return directive;

}]);
