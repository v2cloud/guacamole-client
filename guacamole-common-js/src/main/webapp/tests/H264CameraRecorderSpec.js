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

describe('Guacamole.H264CameraRecorder congestion control', function() {

    var limits = Guacamole.H264CameraRecorder._congestionLimits;
    var isCongested = Guacamole.H264CameraRecorder._isCongested;

    // The steady-state budget used by the recorder
    var BUDGET = 8;

    it('sizes the window as delay budget + one frame + steady-state budget', function() {
        var l = limits(3, 9, BUDGET);
        expect(l.enter).toBe(3 + 9 + 8);
        expect(l.exit).toBe(3 + 9 + 4);
    });

    /* Regression: a single 720p keyframe (~50 KB = 9 blobs of 6048 bytes)
     * exceeds the 8-blob steady-state budget on its own. Without the
     * one-frame floor this read as permanent congestion and froze the
     * stream at resolutions above 640x480. */
    it('never counts a single largest frame as congestion', function() {
        var keyframeBlobs = 9;

        // Without room for the frame itself, the keyframe reads as congestion
        expect(isCongested(keyframeBlobs, false, limits(0, 0, BUDGET)))
            .toBe(true);

        // With the frame included in the window, it does not
        expect(isCongested(keyframeBlobs, false, limits(0, keyframeBlobs, BUDGET)))
            .toBe(false);
    });

    it('applies hysteresis between the enter and exit limits', function() {
        var l = limits(0, 9, BUDGET); // enter 17, exit 13

        // Not congested until the enter limit is exceeded
        expect(isCongested(17, false, l)).toBe(false);
        expect(isCongested(18, false, l)).toBe(true);

        // Once congested, stays congested until the backlog drains below exit
        expect(isCongested(17, true, l)).toBe(true);
        expect(isCongested(14, true, l)).toBe(true);
        expect(isCongested(13, true, l)).toBe(false);
    });

});

describe('Guacamole.H264CameraRecorder adaptive quality', function() {

    var stepQuality = Guacamole.H264CameraRecorder._stepQuality;

    var TUNING = {
        stepDown: 0.7,
        stepUp: 0.1,
        minScale: 0.25,
        adjustIntervalMs: 1000,
        recoverMs: 4000
    };

    var freshState = function freshState() {
        return {
            qualityScale: 1,
            lastCongestedMs: 0,
            lastQualityAdjustMs: 0
        };
    };

    it('steps down multiplicatively while overloaded', function() {
        var next = stepQuality(freshState(), true, 10000, TUNING);
        expect(next.changed).toBe(true);
        expect(next.qualityScale).toBeCloseTo(0.7, 10);
        expect(next.lastCongestedMs).toBe(10000);
    });

    it('rate-limits steps to one per adjust interval', function() {
        var state = freshState();
        state.lastQualityAdjustMs = 10000;

        // Too soon after the last adjustment: no step, but congestion noted
        var next = stepQuality(state, true, 10500, TUNING);
        expect(next.changed).toBe(false);
        expect(next.qualityScale).toBe(1);
        expect(next.lastCongestedMs).toBe(10500);

        // After the interval elapses, the step is taken
        next = stepQuality(state, true, 11000, TUNING);
        expect(next.changed).toBe(true);
    });

    it('never steps below the minimum scale', function() {
        var state = freshState();
        state.qualityScale = 0.3;

        var next = stepQuality(state, true, 10000, TUNING);
        expect(next.qualityScale).toBe(TUNING.minScale);

        // Already at the floor: no further change
        state.qualityScale = TUNING.minScale;
        next = stepQuality(state, true, 20000, TUNING);
        expect(next.changed).toBe(false);
        expect(next.qualityScale).toBe(TUNING.minScale);
    });

    it('recovers only after the link has been clear for recoverMs', function() {
        var state = freshState();
        state.qualityScale = 0.5;
        state.lastCongestedMs = 10000;

        // Clear, but not yet for recoverMs: no recovery
        var next = stepQuality(state, false, 13000, TUNING);
        expect(next.changed).toBe(false);

        // Clear long enough: additive recovery step
        next = stepQuality(state, false, 14000, TUNING);
        expect(next.changed).toBe(true);
        expect(next.qualityScale).toBeCloseTo(0.6, 10);
    });

    it('caps recovery at full quality and then stops changing', function() {
        var state = freshState();
        state.qualityScale = 0.95;

        var next = stepQuality(state, false, 10000, TUNING);
        expect(next.qualityScale).toBe(1);

        // At full quality with a clear link, the state machine is idle
        state.qualityScale = 1;
        next = stepQuality(state, false, 20000, TUNING);
        expect(next.changed).toBe(false);
        expect(next.qualityScale).toBe(1);
    });

    it('refreshes the congestion timestamp while overloaded even at the floor', function() {
        var state = freshState();
        state.qualityScale = TUNING.minScale;
        state.lastCongestedMs = 5000;

        var next = stepQuality(state, true, 10000, TUNING);
        expect(next.lastCongestedMs).toBe(10000);
    });

});
