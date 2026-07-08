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

/* global Guacamole, expect, spyOn */

/**
 * Tests covering the pointer capture behavior of {@link Guacamole.Mouse}.
 *
 * The capture is essential for multi-monitor sessions: while a mouse button
 * is held, setPointerCapture keeps mouse events flowing to the window even
 * after the cursor crosses the window's edge. Without it, a remote drag
 * (button held) stops receiving events at the edge of the monitor's window,
 * the remote desktop sees the button stall, and the drag auto-cancels,
 * making it impossible to drag an application from one monitor's window into
 * another's. These specs guard that the capture is taken on pointerdown and
 * released on pointerup.
 */
describe("Guacamole.Mouse pointer capture", function MousePointerCaptureSpec() {

    var element;

    beforeEach(function setup() {
        element = document.createElement("div");
        document.body.appendChild(element);
        spyOn(element, "setPointerCapture");
        spyOn(element, "releasePointerCapture");
        new Guacamole.Mouse(element);
    });

    afterEach(function teardown() {
        if (element.parentNode)
            element.parentNode.removeChild(element);
    });

    it("captures the pointer on pointerdown so a drag survives leaving the window", function () {
        element.dispatchEvent(new PointerEvent("pointerdown",
                { pointerId: 7, bubbles: true }));
        expect(element.setPointerCapture).toHaveBeenCalledWith(7);
    });

    it("releases the capture on pointerup after a captured drag", function () {
        // Drive the full lifecycle: a button-down (which captures) followed by
        // the matching pointerup (which releases). Asserting the capture here as
        // well ties the release to a preceding capture, so a change that drops
        // setPointerCapture fails this test rather than letting a bare
        // pointerup release pass in isolation.
        element.dispatchEvent(new PointerEvent("pointerdown",
                { pointerId: 7, bubbles: true }));
        expect(element.setPointerCapture).toHaveBeenCalledWith(7);

        element.dispatchEvent(new PointerEvent("pointerup",
                { pointerId: 7, bubbles: true }));
        expect(element.releasePointerCapture).toHaveBeenCalledWith(7);
    });

});
