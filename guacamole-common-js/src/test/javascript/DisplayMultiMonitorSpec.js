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

/* global Guacamole, expect */

/**
 * Tests covering the multi-monitor display behavior of
 * {@link Guacamole.Display}.
 *
 * In the current architecture, cross-monitor copy decomposition is
 * handled server-side (guacd rewrites cross-monitor `copy` plan ops
 * into IMG so the destination region is transmitted as fresh pixel
 * data). Connected clients therefore use the upstream
 * single-canvas-per-monitor model: setMonitorSize(w, h) clamps the
 * underlying default-layer canvas to the monitor's dimensions on the
 * next resize, getWidth/getHeight return those dimensions, and there
 * is no per-window full-desktop canvas.
 *
 * Single-monitor sessions never call setMonitorSize and behave exactly
 * as upstream.
 *
 * Note: these specs require a real DOM (Display constructs canvas
 * elements via document.createElement). The Karma + Firefox CI runner
 * provides one. To run them locally:
 *
 *     mvn -pl guacamole-common-js test -DskipTests=false
 *
 * (Requires firefox to be installed.)
 */
describe("Guacamole.Display multi-monitor", function DisplayMultiMonitorSpec() {

    var display;
    var displayElement;

    beforeEach(function setup() {
        display = new Guacamole.Display();
        displayElement = display.getElement();
        document.body.appendChild(displayElement);
    });

    afterEach(function teardown() {
        if (displayElement && displayElement.parentNode)
            displayElement.parentNode.removeChild(displayElement);
    });

    describe("backwards compatibility (single monitor)", function () {

        it("getWidth/getHeight return the canvas dimensions when setMonitorSize is never called", function (done) {

            display.resize(display.getDefaultLayer(), 1920, 1080);

            /* Tasks queued via scheduleTask only execute on frame flush.
             * Flush explicitly so the resize applies before assertion. */
            display.flush(function () {
                expect(display.getWidth()).toBe(1920);
                expect(display.getHeight()).toBe(1080);
                done();
            });

        });

    });

    describe("setMonitorSize (multimon)", function () {

        it("clamps the next layer resize to the monitor dimensions", function (done) {

            /* Before any resize, declare this window represents a single
             * 1920x1080 monitor. The full desktop reported by the server
             * will be larger (e.g. two side-by-side monitors), but this
             * window's underlying canvas must stay sized to this
             * monitor's portion only. */
            display.setMonitorSize(1920, 1080);

            /* Server-reported full desktop is 3840x1080 (two monitors). */
            display.resize(display.getDefaultLayer(), 3840, 1080);

            display.flush(function () {
                /* Canvas is clamped to the monitor's size, not the full
                 * desktop. getWidth/getHeight reflect that. */
                expect(display.getWidth()).toBe(1920);
                expect(display.getHeight()).toBe(1080);
                done();
            });

        });

        it("getWidth/getHeight return the clamped monitor dimensions", function (done) {

            display.setMonitorSize(1080, 1920); // portrait monitor
            display.resize(display.getDefaultLayer(), 3000, 1920);

            display.flush(function () {
                expect(display.getWidth()).toBe(1080);
                expect(display.getHeight()).toBe(1920);
                done();
            });

        });

        it("does not clamp buffer or child layer resizes", function (done) {

            display.setMonitorSize(1920, 1080);

            /* Buffers (negative layer indices) and child layers hold
             * off-screen surfaces such as RDP bitmap/glyph caches whose
             * dimensions are unrelated to the monitor's size — the clamp
             * must apply to the default layer only. */
            var buffer = display.createBuffer();
            var child  = display.createLayer();
            display.resize(buffer, 3840, 2160);
            display.resize(child,  3840, 2160);

            display.flush(function () {
                expect(buffer.width).toBe(3840);
                expect(buffer.height).toBe(2160);
                expect(child.width).toBe(3840);
                expect(child.height).toBe(2160);
                done();
            });

        });

    });

});
