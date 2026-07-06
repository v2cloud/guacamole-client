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
 * The controller for the page used to display secondary monitors.
 */
angular.module('client').controller('secondaryMonitorController', ['$scope', '$injector', '$routeParams',
    function clientController($scope, $injector, $routeParams) {

    // Required services
    const $window           = $injector.get('$window');
    const guacFullscreen    = $injector.get('guacFullscreen');
    const guacManageMonitor = $injector.get('guacManageMonitor');

    /**
     * ID of this monitor.
     *
     * @type {!String}
     */
    const monitorId = $routeParams.id;

    /**
     * Scope identifier matching the parent (primary) session. Carried in
     * the URL so this secondary window joins the same BroadcastChannel
     * scope as its primary and does not see traffic from other parallel
     * Guacamole connections in the browser origin.
     *
     * @type {!String}
     */
    const monitorScope = $routeParams.scope || '';

    /**
     * Opening the Guacamole menu requires Ctrl+Alt+Shift. Each of these keys
     * has several possible keysyms.
     */
    const SHIFT_KEYS  = {0xFFE1 : true, 0xFFE2 : true},
          ALT_KEYS    = {0xFFE9 : true, 0xFFEA : true, 0xFE03 : true,
                         0xFFE7 : true, 0xFFE8 : true},
          CTRL_KEYS   = {0xFFE3 : true, 0xFFE4 : true},
          MENU_KEYS   = angular.extend({}, SHIFT_KEYS, ALT_KEYS, CTRL_KEYS);

    guacManageMonitor.init("secondary", monitorScope);
    guacManageMonitor.monitorId = monitorId;

    guacManageMonitor.openConsentButton = function openConsentButton() {

        // Show prompt (raised from outside Angular's digest)
        $scope.$evalAsync(function () {
            $scope.showFullscreenConsent = true;
        });

    };

    // Enter fullscreen, then hide the prompt
    $scope.enableFullscreenMode = function enableFullscreenMode() {
        guacFullscreen.setFullscreenMode(true);
        $scope.showFullscreenConsent = false;
    };

    $scope.declineFullscreenMode = function declineFullscreenMode() {
        $scope.showFullscreenConsent = false;
    };

    /**
     * Returns whether the shortcut for showing/hiding the Guacamole menu
     * (Ctrl+Alt+Shift) has been pressed.
     *
     * @param {Guacamole.Keyboard} keyboard
     *     The Guacamole.Keyboard object tracking the local keyboard state.
     *
     * @returns {boolean}
     *     true if Ctrl+Alt+Shift has been pressed, false otherwise.
     */  
    const isMenuShortcutPressed = function isMenuShortcutPressed(keyboard) {

        // The shortcut has not been pressed if any key other than Ctrl, Alt,
        // or Shift is currently held down
        if (_.findKey(keyboard.pressed, (_, keysym) => !MENU_KEYS[keysym]))
            return false;

        // Verify that one of each required key is held, regardless of
        // left/right location on the keyboard
        return !!(
                _.findKey(SHIFT_KEYS, (_, keysym) => keyboard.pressed[keysym])
                && _.findKey(ALT_KEYS,   (_, keysym) => keyboard.pressed[keysym])
                && _.findKey(CTRL_KEYS,  (_, keysym) => keyboard.pressed[keysym])
        );

    };

    // Opening the Guacamole menu after Ctrl+Alt+Shift, preventing those
    // keypresses from reaching any Guacamole client
    $scope.$on('guacBeforeKeydown', function incomingKeydown(event, keysym, keyboard) {

        // Toggle menu if menu shortcut (Ctrl+Alt+Shift) is pressed
        if (isMenuShortcutPressed(keyboard)) {
        
            // Don't send this key event through to the client, and release
            // all other keys involved in performing this shortcut
            event.preventDefault();
            keyboard.reset();
            
            // Toggle the menu
            $scope.$apply(function() {
                guacManageMonitor.pushBroadcastMessage('guacMenu', true);
            });

        }

    });

    // Send monitor-close event to broadcast channel on window unload
    $window.addEventListener('beforeunload', function unloadWindow() {
        guacManageMonitor.pushBroadcastMessage('monitorClose', monitorId);
    });

}]);
