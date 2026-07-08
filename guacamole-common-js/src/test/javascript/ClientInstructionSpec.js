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

/* global Guacamole, expect, spyOn, jasmine */

/**
 * Tests covering instruction dispatch within {@link Guacamole.Client},
 * focusing on handlers modified for multi-monitor support. These guard
 * against parameter-index regressions: each instruction's coordinate
 * parameters must be read from the documented positions of the
 * Guacamole protocol, with the per-monitor offset applied only to
 * default-layer (layer 0) operations.
 */
describe("Guacamole.Client instruction dispatch", function ClientInstructionSpec() {

    var client;
    var display;

    beforeEach(function setup() {
        client = new Guacamole.Client(new Guacamole.Tunnel());
        display = client.getDisplay();
    });

    describe('"start" (path start)', function () {

        it("begins the path at the instruction's x/y parameters", function () {
            spyOn(display, 'moveTo');
            client.runHandler('start', ['0', '100', '200']);
            expect(display.moveTo).toHaveBeenCalledWith(
                    display.getDefaultLayer(), 100, 200);
        });

        it("applies the monitor offset to default-layer coordinates", function () {
            client.offsetX = 30;
            client.offsetY = 40;
            spyOn(display, 'moveTo');
            client.runHandler('start', ['0', '100', '200']);
            expect(display.moveTo).toHaveBeenCalledWith(
                    display.getDefaultLayer(), 70, 160);
        });

        it("does not apply the monitor offset to non-default layers", function () {
            client.offsetX = 30;
            client.offsetY = 40;
            spyOn(display, 'moveTo');
            client.runHandler('start', ['1', '100', '200']);
            expect(display.moveTo).toHaveBeenCalledWith(
                    jasmine.anything(), 100, 200);
        });

    });

});
