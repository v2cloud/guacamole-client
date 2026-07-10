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

var Guacamole = Guacamole || {};

/**
 * Abstract camera recorder which streams H.264 video data to an underlying
 * Guacamole.OutputStream. It is up to implementations of this class to provide
 * some means of handling this Guacamole.OutputStream. Data produced by the
 * recorder is to be sent along the provided stream immediately.
 *
 * @constructor
 */
Guacamole.CameraRecorder = function CameraRecorder() {

    /**
     * Callback which is invoked when the camera recording process has stopped
     * and the underlying Guacamole stream has been closed normally. Camera will
     * only resume recording if a new Guacamole.CameraRecorder is started. This
     * Guacamole.CameraRecorder instance MAY NOT be reused.
     *
     * @event
     */
    this.onclose = null;

    /**
     * Callback which is invoked when the camera recording process cannot
     * continue due to an error, if it has started at all. The underlying
     * Guacamole stream is automatically closed. Future attempts to record
     * camera should not be made, and this Guacamole.CameraRecorder instance
     * MAY NOT be reused.
     *
     * @event
     */
    this.onerror = null;

    /**
     * Callback invoked when the recorder has determined the set of formats
     * supported by the underlying camera (resolution and frame rate pairs).
     *
     * @event
     * @param {!Array.<Object>} formats
     *     Array describing the supported formats. Each element contains
     *     at least {width, height, fpsNumerator, fpsDenominator}.
     * @param {string} deviceName
     *     The label/name of the camera device, if available.
     */
    this.oncapabilities = null;

};

/**
 * Determines whether the given mimetype is supported by any built-in
 * implementation of Guacamole.CameraRecorder, and thus will be properly handled
 * by Guacamole.CameraRecorder.getInstance().
 *
 * @param {!string} mimetype
 *     The mimetype to check.
 *
 * @returns {!boolean}
 *     true if the given mimetype is supported by any built-in
 *     Guacamole.CameraRecorder, false otherwise.
 */
Guacamole.CameraRecorder.isSupportedType = function isSupportedType(mimetype) {

    return Guacamole.H264CameraRecorder.isSupportedType(mimetype);

};

/**
 * Returns a list of all mimetypes supported by any built-in
 * Guacamole.CameraRecorder, in rough order of priority. Beware that only the
 * core mimetypes themselves will be listed. Any mimetype parameters, even
 * required ones, will not be included in the list.
 *
 * @returns {!string[]}
 *     A list of all mimetypes supported by any built-in
 *     Guacamole.CameraRecorder, excluding any parameters.
 */
Guacamole.CameraRecorder.getSupportedTypes = function getSupportedTypes() {

    return Guacamole.H264CameraRecorder.getSupportedTypes();

};

/**
 * Returns an instance of Guacamole.CameraRecorder providing support for the
 * given video format. If support for the given video format is not available,
 * null is returned.
 *
 * @param {!Guacamole.OutputStream} stream
 *     The Guacamole.OutputStream to send video data through.
 *
 * @param {!string} mimetype
 *     The mimetype of the video data to be sent along the provided stream.
 *
 * @return {Guacamole.CameraRecorder}
 *     A Guacamole.CameraRecorder instance supporting the given mimetype and
 *     writing to the given stream, or null if support for the given mimetype
 *     is absent.
 */
Guacamole.CameraRecorder.getInstance = function getInstance(stream, mimetype) {

    // Use H.264 camera recorder if possible
    if (Guacamole.H264CameraRecorder.isSupportedType(mimetype))
        return new Guacamole.H264CameraRecorder(stream, mimetype);

    // No support for given mimetype
    return null;

};

/**
 * Implementation of Guacamole.CameraRecorder providing support for H.264
 * format video. This recorder relies on the WebCodecs API and requires
 * browser-level support for H.264 encoding.
 *
 * @constructor
 * @augments Guacamole.CameraRecorder
 * @param {!Guacamole.OutputStream} stream
 *     The Guacamole.OutputStream to write video data to.
 *
 * @param {!string} mimetype
 *     The mimetype of the video data to send along the provided stream, which
 *     must be "application/rdpecam+h264".
 */
Guacamole.H264CameraRecorder = function H264CameraRecorder(stream, mimetype) {

    /**
     * Reference to this H264CameraRecorder.
     *
     * @private
     * @type {!Guacamole.H264CameraRecorder}
     */
    var recorder = this;

    /** The format of video this recorder will encode. */
    var format = {
        width: 640,
        height: 480,
        frameRate: 30,
        /** Optional browser device ID to target a specific camera */
        deviceId: undefined
    };

    /**
     * Monotonic PTS last emitted downstream (milliseconds).
     *
     * @private
     * @type {?number}
     */
    var lastOutputPtsMs = null;

    /**
     * Tracks whether capability information has already been reported
     * upstream for this recorder.
     *
     * @private
     * @type {boolean}
     */
    var capabilitiesReported = false;

    /**
     * Candidate formats which will be offered if supported by the camera.
     *
     * @private
     * @type {!Array.<{width:number,height:number,fps:!Array.<number>}>}
     */
    var CAPABILITY_CANDIDATES = [
        { width: 640,  height: 480,  fps: [30, 15] },
        { width: 320,  height: 240,  fps: [30, 15] },
        { width: 1280, height: 720,  fps: [30]      },
        { width: 1920, height: 1080, fps: [30]      }
    ];

    /**
     * Returns whether the provided dimension capability includes the given
     * value. Capabilities may be expressed as ranges, arrays, or omitted.
     *
     * @private
     */
    var capabilitySupportsValue = function capabilitySupportsValue(capability, value) {
        if (!capability)
            return true;

        if (Array.isArray(capability))
            return capability.indexOf(value) !== -1;

        if (typeof capability === 'object') {
            if (typeof capability.max === 'number' && value > capability.max)
                return false;
            if (typeof capability.min === 'number' && value < capability.min)
                return false;
            if (typeof capability.step === 'number' && typeof capability.min === 'number') {
                var step = capability.step;
                if (step > 0 && ((value - capability.min) % step) !== 0)
                    return false;
            }
        }

        return true;
    };

    /**
     * Builds a list of supported formats from the provided
     * MediaTrackCapabilities. The resulting list is guaranteed to contain at
     * least the currently requested format.
     *
     * @private
     */
    var buildSupportedFormats = function buildSupportedFormats(capabilities) {
        var formats = [];
        var seen = {};

        var pushFormat = function pushFormat(width, height, fpsNum, fpsDen) {
            var key = width + 'x' + height + '@' + fpsNum + '/' + fpsDen;
            if (seen[key])
                return;

            seen[key] = true;
            formats.push({
                width: width,
                height: height,
                fpsNumerator: fpsNum,
                fpsDenominator: fpsDen
            });
        };

        CAPABILITY_CANDIDATES.forEach(function(candidate) {
            if (!capabilitySupportsValue(capabilities.width, candidate.width))
                return;
            if (!capabilitySupportsValue(capabilities.height, candidate.height))
                return;

            candidate.fps.forEach(function(fps) {
                if (!capabilitySupportsValue(capabilities.frameRate, fps))
                    return;
                pushFormat(candidate.width, candidate.height, fps, 1);
            });
        });

        if (!formats.length) {
            pushFormat(format.width, format.height,
                typeof format.frameRate === 'number' && format.frameRate > 0 ? format.frameRate : 30, 1);
        }

        return formats;
    };

    /**
     * Reports the supported formats upstream exactly once if the recorder
     * consumer has provided an oncapabilities handler.
     *
     * @private
     */
    var reportCapabilities = function reportCapabilities(track) {
        if (capabilitiesReported || !track || typeof track.getCapabilities !== 'function')
            return;

        try {
            var caps = track.getCapabilities();
            var formats = buildSupportedFormats(caps || {});
            if (recorder.oncapabilities && formats.length) {
                // Extract device name from track label, if available
                var deviceName = (track && track.label) ? track.label : '';
                recorder.oncapabilities(formats, deviceName);
            }
            capabilitiesReported = true;
        }
        catch (e) {}
    };

    /**
     * The video stream provided by the browser, if allowed. If no stream has
     * yet been received, this will be null.
     *
     * @private
     * @type {MediaStream}
     */
    var mediaStream = null;

    /**
     * The video encoder instance.
     *
     * @private
     * @type {VideoEncoder}
     */
    var encoder = null;

    /**
     * The media stream track processor.
     *
     * @private
     * @type {MediaStreamTrackProcessor}
     */
    var processor = null;

    /**
     * The readable stream reader.
     *
     * @private
     * @type {ReadableStreamDefaultReader}
     */
    var reader = null;

    /**
     * Parsed AVCC decoder configuration containing length size and parameter sets.
     *
     * @private
     * @type {{ lengthSize: number, sps: Uint8Array[], pps: Uint8Array[] }|null}
     */
    var decoderConfig = null;

    /**
     * Parses an AVCC decoder configuration record to extract lengthSize, SPS, and PPS.
     *
     * @private
     * @param {ArrayBuffer} avcc
     *     The AVCC decoder configuration (decoderConfig.description).
     *
     * @returns {{ lengthSize: number, sps: Uint8Array[], pps: Uint8Array[] }}
     *     Parsed configuration for conversion to Annex B.
     */
    var parseAvccDecoderConfig = function parseAvccDecoderConfig(avcc) {
        var view = new DataView(avcc);
        var offset = 0;

        /* configurationVersion, AVCProfileIndication, profile_compatibility, AVCLevelIndication */
        offset += 4;

        /* lengthSizeMinusOne (lower 2 bits) */
        var lengthSizeMinusOne = view.getUint8(offset) & 0x03;
        offset += 1;
        var lengthSize = (lengthSizeMinusOne & 0x03) + 1;

        /* numOfSequenceParameterSets (lower 5 bits) */
        var numSps = view.getUint8(offset) & 0x1F;
        offset += 1;

        var spsList = [];
        for (var i = 0; i < numSps; i++) {
            if (offset + 2 > view.byteLength) break;
            var spsLen = view.getUint16(offset);
            offset += 2;
            if (offset + spsLen > view.byteLength) break;
            spsList.push(new Uint8Array(avcc, offset, spsLen));
            offset += spsLen;
        }

        /* numOfPictureParameterSets */
        var ppsList = [];
        if (offset < view.byteLength) {
            var numPps = view.getUint8(offset);
            offset += 1;
            for (var j = 0; j < numPps; j++) {
                if (offset + 2 > view.byteLength) break;
                var ppsLen = view.getUint16(offset);
                offset += 2;
                if (offset + ppsLen > view.byteLength) break;
                ppsList.push(new Uint8Array(avcc, offset, ppsLen));
                offset += ppsLen;
            }
        }

        var config = { lengthSize: lengthSize, sps: [], pps: [] };
        for (var s = 0; s < spsList.length; s++) {
            var spsCopy = new Uint8Array(spsList[s].length);
            spsCopy.set(spsList[s]);
            config.sps.push(spsCopy);
        }
        for (var p = 0; p < ppsList.length; p++) {
            var ppsCopy = new Uint8Array(ppsList[p].length);
            ppsCopy.set(ppsList[p]);
            config.pps.push(ppsCopy);
        }

        return config;
    };


    /**
     * Whether to force the next frame to be a keyframe.
     *
     * @private
     * @type {boolean}
     */
    var needKeyframe = true;

    /**
     * Interval in milliseconds to request periodic IDR frames.
     *
     * @private
     * @type {number}
     */
    var forceIdrIntervalMs = (typeof window !== 'undefined' && window.GUAC_RDPECAM_FORCE_IDR_MS) ?
            (parseInt(window.GUAC_RDPECAM_FORCE_IDR_MS, 10) || 2000) : 2000;

    /**
     * Maximum capture frame rate when software-encoding, overridable via
     * window.GUAC_RDPECAM_SW_MAX_FPS for tuning.
     *
     * @private
     * @type {number}
     */
    var swMaxFps = (typeof window !== 'undefined' && window.GUAC_RDPECAM_SW_MAX_FPS) ?
            (parseInt(window.GUAC_RDPECAM_SW_MAX_FPS, 10) || 10) : 10;

    /**
     * Encoder bitrate, in bits per second, when software-encoding,
     * overridable via window.GUAC_RDPECAM_SW_BITRATE for tuning.
     *
     * @private
     * @type {number}
     */
    var swBitrate = (typeof window !== 'undefined' && window.GUAC_RDPECAM_SW_BITRATE) ?
            (parseInt(window.GUAC_RDPECAM_SW_BITRATE, 10) || 800000) : 800000;

    /**
     * Wall-clock timestamp (ms) of last observed keyframe.
     *
     * Initialize to current time instead of 0 to prevent race condition.
     * If initialized to 0 (epoch), encoding loop may process frame 2 before frame 1's
     * output callback updates lastKeyframeWallMs, causing frame 2 to see stale value
     * and incorrectly request keyframe when checking (Date.now() - 0) >= 2000ms.
     * This prevents consecutive I-frames that Windows Media Foundation decoder rejects.
     *
     * @private
     * @type {number}
     */
    var lastKeyframeWallMs = Date.now();

    /**
     * Marks that the next encoded frame should request a keyframe.
     *
     * @private
     */
    var requireKeyframe = function requireKeyframe() {
        needKeyframe = true;
    };

    /**
     * Marks that a keyframe has just been produced, clearing any outstanding
     * request and updating the periodic IDR timer baseline.
     *
     * @private
     */
    var markKeyframeObserved = function markKeyframeObserved() {
        needKeyframe = false;
        lastKeyframeWallMs = Date.now();
    };

    /**
     * Baseline PTS (in microseconds) for normalizing chunk timestamps to start at 0.
     * Set to the timestamp of the first chunk received after encoding starts.
     *
     * @private
     * @type {number|null}
     */
    var baselinePtsUs = null;

    /**
     * Guacamole.ArrayBufferWriter wrapped around the video output stream
     * provided when this Guacamole.H264CameraRecorder was created.
     *
     * @private
     * @type {!Guacamole.ArrayBufferWriter}
     */
    var writer = new Guacamole.ArrayBufferWriter(stream);

    /**
     * The Guacamole output stream underlying this recorder. Kept under a
     * distinct name, as the getUserMedia callback parameter shadows
     * "stream" within streamReceived().
     *
     * @private
     * @type {!Guacamole.OutputStream}
     */
    var guacStream = stream;

    /**
     * The maximum number of unacknowledged blobs tolerated before frames
     * are dropped rather than encoded. Eight blobs is roughly half a second
     * of video at 800 kbps.
     *
     * @private
     * @constant
     * @type {number}
     */
    var BACKPRESSURE_MAX_UNACKED_BLOBS = 8;

    /**
     * Number of protocol blobs sent on the video stream that have not yet
     * been acknowledged by the server.
     *
     * @private
     * @type {number}
     */
    var unackedBlobs = 0;

    /**
     * Whether frames are currently being skipped due to link congestion.
     * Used only to log state transitions.
     *
     * @private
     * @type {boolean}
     */
    var backpressured = false;

    writer.onack = function blobAcknowledged(status) {
        if (unackedBlobs > 0)
            unackedBlobs--;
    };

    /**
     * Builds the RDPECAM frame header.
     *
     * @private
     * @param {Object} params
     *     Parameters for the frame header.
     *
     * @param {boolean} params.keyframe
     *     Whether this is a keyframe.
     *
     * @param {number} params.ptsMs
     *     Presentation timestamp in milliseconds.
     *
     * @param {number} params.payloadLen
     *     Length of the payload in bytes.
     *
     * @returns {ArrayBuffer}
     *     The frame header as ArrayBuffer.
     */
    var buildFrameHeader = function buildFrameHeader(params) {
        var header = new ArrayBuffer(12);
        var view = new DataView(header);
        
        view.setUint8(0, 1); // version
        view.setUint8(1, params.keyframe ? 1 : 0); // flags (bit0: keyframe)
        view.setUint16(2, 0, true); // reserved (little-endian)
        view.setUint32(4, params.ptsMs, true); // pts_ms (little-endian)
        view.setUint32(8, params.payloadLen, true); // payload_len (little-endian)
        
        return header;
    };

    /**
     * Concatenates multiple ArrayBuffers.
     *
     * @private
     * @param {...ArrayBuffer} buffers
     *     The buffers to concatenate.
     *
     * @returns {ArrayBuffer}
     *     The concatenated buffer.
     */
    var concatBuffers = function concatBuffers() {
        var totalLength = 0;
        for (var i = 0; i < arguments.length; i++) {
            totalLength += arguments[i].byteLength;
        }
        
        var result = new Uint8Array(totalLength);
        var offset = 0;
        
        for (var i = 0; i < arguments.length; i++) {
            result.set(new Uint8Array(arguments[i]), offset);
            offset += arguments[i].byteLength;
        }
        
        return result.buffer;
    };

    /**
     * getUserMedia() callback which handles successful retrieval of a
     * video stream (successful start of recording).
     *
     * @private
     * @param {!MediaStream} stream
     *     A MediaStream which provides access to video data read from the
     *     user's local camera device.
     */
    var streamReceived = function streamReceived(stream) {

        /**
         * Whether encoding has already been retried with software encoding
         * after a fatal encoder error. Only one retry is attempted per
         * capture session (see also
         * Guacamole.H264CameraRecorder._hardwareFailedAtMs).
         *
         * @type {boolean}
         */
        var triedSoftwareFallback = false;

        /* The camera may not honor the requested format exactly. Use the
         * actual track settings for the encoder configuration. */
        var track = stream.getVideoTracks()[0];
        var trackSettings = (track && typeof track.getSettings === 'function')
                ? track.getSettings() : {};
        var captureWidth     = trackSettings.width     || format.width;
        var captureHeight    = trackSettings.height    || format.height;
        var captureFrameRate = trackSettings.frameRate || format.frameRate;

        var encoderOutput = function encoderOutput(chunk, meta) {
                if (meta && meta.decoderConfig && meta.decoderConfig.description)
                    decoderConfig = parseAvccDecoderConfig(meta.decoderConfig.description);

                if (chunk.type === 'key')
                    markKeyframeObserved();

                // Extract AVCC encoded data from browser
                var chunkData = new Uint8Array(chunk.byteLength);
                chunk.copyTo(chunkData);

                // Convert AVCC to Annex B (prepend SPS/PPS on keyframes)
                var payload = Guacamole.H264AnnexBUtil.avccToAnnexB(
                    chunkData,
                    chunk.type === 'key',
                    decoderConfig
                );

                if (!payload || payload.length === 0)
                    return;

                var payloadSize = payload.length;

                // Ignore empty frames - nothing to send downstream
                if (!payloadSize)
                    return;

                if (baselinePtsUs === null)
                    baselinePtsUs = chunk.timestamp;

                var relativePtsUs = chunk.timestamp - baselinePtsUs;
                var relativePtsMs = Math.max(0, Math.round(relativePtsUs / 1000));

                /* If source timestamps jump backwards (device reset, resume
                 * from sleep, etc.), re-baseline such that the outgoing pts
                 * continues by one frame step. The clamp below would
                 * otherwise pin all further frames to the same pts. */
                if (lastOutputPtsMs !== null && relativePtsMs + 1000 < lastOutputPtsMs) {
                    var frameStepMs = Math.round(1000 / (captureFrameRate || 30));
                    baselinePtsUs = chunk.timestamp - (lastOutputPtsMs + frameStepMs) * 1000;
                    relativePtsUs = chunk.timestamp - baselinePtsUs;
                    relativePtsMs = Math.max(0, Math.round(relativePtsUs / 1000));
                }

                /* Never emit a pts earlier than the previous frame's. */
                if (lastOutputPtsMs !== null && relativePtsMs < lastOutputPtsMs)
                    relativePtsMs = lastOutputPtsMs;

                lastOutputPtsMs = relativePtsMs;

                var header = buildFrameHeader({
                    keyframe: chunk.type === 'key',
                    ptsMs: relativePtsMs,
                    payloadLen: payloadSize
                });

                var payloadBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payloadSize);
                var frameData = concatBuffers(header, payloadBuffer);

                unackedBlobs += Math.ceil(frameData.byteLength / writer.blobLength);
                writer.sendData(frameData);
        };

        /* Invoked on fatal encoder errors, after which the codec is closed
         * and unusable. Retry once with software encoding, otherwise stop
         * the capture entirely. */
        var encoderError = function encoderError(e) {

            console.warn('Guacamole.H264CameraRecorder: video encoder error:', e);

            if (!triedSoftwareFallback && effectiveEncoderConfig
                    && effectiveEncoderConfig.hardwareAcceleration !== 'prefer-software') {
                triedSoftwareFallback = true;

                /* Remember the failure so that future capture sessions use
                 * software encoding directly. */
                Guacamole.H264CameraRecorder._hardwareFailedAtMs = Date.now();

                try {
                    effectiveEncoderConfig = buildConfig('prefer-software');
                    encoder = new VideoEncoder({ output: encoderOutput, error: encoderError });
                    encoder.configure(effectiveEncoderConfig);
                    requireKeyframe();
                    console.warn('Guacamole.H264CameraRecorder: retrying with software encoding: '
                            + JSON.stringify(effectiveEncoderConfig));
                    return;
                }
                catch (retryError) {
                    console.warn('Guacamole.H264CameraRecorder: software fallback failed:', retryError);
                }
            }

            stopVideoCapture();
            if (recorder.onerror)
                recorder.onerror();

        };

        // Create video encoder
        encoder = new VideoEncoder({
            output: encoderOutput,
            error: encoderError
        });

        // Select appropriate AVC level based on resolution
        var selectLevelIdcHex = function(width, height) {
            var mbW = Math.ceil((width || 0) / 16);
            var mbH = Math.ceil((height || 0) / 16);
            var mbPerFrame = mbW * mbH;
            if (mbPerFrame <= 1620) return '1E';   // Level 3.0
            if (mbPerFrame <= 3600) return '1F';   // Level 3.1
            if (mbPerFrame <= 8192) return '28';   // Level 4.0
            return '29';                            // Level 4.1 fallback
        };

        /* Hardware encoding uses High profile. Software encoding uses
         * Constrained Baseline, which is what Chrome's software encoder
         * (OpenH264) produces. */
        var codecFor = function codecFor(hwPref) {
            var profile = (hwPref === 'prefer-software') ? 'avc1.42E0' : 'avc1.6400';
            return profile + selectLevelIdcHex(captureWidth, captureHeight);
        };

        // Calculate optimal bitrate based on resolution height
        // Matches FreeRDP's bitrate recommendations for RDPECAM
        // Source: https://livekit.io/webrtc/bitrate-guide (webcam streaming)
        var defaultBitrate;
        if (captureHeight >= 1080) {
            defaultBitrate = 2700000;  // 2.7 Mbps for 1080p
        } else if (captureHeight >= 720) {
            defaultBitrate = 1250000;  // 1.25 Mbps for 720p
        } else if (captureHeight >= 480) {
            defaultBitrate = 700000;   // 700 kbps for 480p
        } else if (captureHeight >= 360) {
            defaultBitrate = 400000;   // 400 kbps for 360p
        } else if (captureHeight >= 240) {
            defaultBitrate = 170000;   // 170 kbps for 240p
        } else {
            defaultBitrate = 100000;   // 100 kbps for lower resolutions
        }

        /* Builds the encoder configuration for the given hardware
         * preference. Software encoding uses realtime latency mode and a
         * lower bitrate, matching the parameters used by the old WebRTC
         * camera implementation. */
        var buildConfig = function buildConfig(hwPref) {
            var software = (hwPref === 'prefer-software');
            return {
                codec: codecFor(hwPref),
                width: captureWidth,
                height: captureHeight,
                framerate: captureFrameRate,
                hardwareAcceleration: hwPref,
                latencyMode: software ? 'realtime' : 'quality',
                bitrate: software ? swBitrate : defaultBitrate,
                bitrateMode: 'variable'
            };
        };

        /* Determines the hardwareAcceleration preference for this session.
         * Hardware failures may be transient (encoder sessions exhausted,
         * driver reset, etc.), so software encoding is used for a while
         * after a failure, after which hardware support is re-probed via
         * isConfigSupported(). */
        var chooseEncoderPreference = function chooseEncoderPreference() {

            var failedAt = Guacamole.H264CameraRecorder._hardwareFailedAtMs;
            if (!failedAt)
                return Promise.resolve('prefer-hardware');

            var sinceFailure = Date.now() - failedAt;
            if (sinceFailure < Guacamole.H264CameraRecorder._HW_RETRY_INTERVAL_MS) {
                console.warn('Guacamole.H264CameraRecorder: hardware encoding '
                        + 'unavailable (failed ' + Math.round(sinceFailure / 1000)
                        + 's ago), using software encoding');
                return Promise.resolve('prefer-software');
            }

            return VideoEncoder.isConfigSupported(buildConfig('prefer-hardware'))
                .then(function probed(result) {
                    if (result && result.supported) {
                        Guacamole.H264CameraRecorder._hardwareFailedAtMs = 0;
                        return 'prefer-hardware';
                    }
                    Guacamole.H264CameraRecorder._hardwareFailedAtMs = Date.now();
                    console.warn('Guacamole.H264CameraRecorder: hardware encoding '
                            + 'still unavailable, using software encoding');
                    return 'prefer-software';
                }, function probeFailed() {
                    Guacamole.H264CameraRecorder._hardwareFailedAtMs = Date.now();
                    return 'prefer-software';
                });

        };

        var effectiveEncoderConfig = null;

        /* Choose the encoder preference and configure the encoder. The
         * frame pump below starts immediately, but drops frames until the
         * encoder has been configured. */
        chooseEncoderPreference().then(function configureEncoder(hwPref) {

            var encoderConfig = buildConfig(hwPref);
            effectiveEncoderConfig = encoderConfig;
            try {
                encoder.configure(encoderConfig);
            }
            catch (configureError) {
                if (encoderConfig.colorSpace) {
                    effectiveEncoderConfig = Object.assign({}, encoderConfig);
                    delete effectiveEncoderConfig.colorSpace;
                    encoder.configure(effectiveEncoderConfig);
                }
                else
                    throw configureError;
            }

            console.info('Guacamole.H264CameraRecorder: encoder configured: '
                    + JSON.stringify(effectiveEncoderConfig));

        }).catch(function encoderSetupFailed(e) {
            console.warn('Guacamole.H264CameraRecorder: failed to configure video encoder:', e);
            stopVideoCapture();
            if (recorder.onerror)
                recorder.onerror();
        });

        // Create track processor
        reportCapabilities(track);
        processor = new MediaStreamTrackProcessor({ track: track });
        reader = processor.readable.getReader();

        /* Encoding loop. Frames are dropped (but always closed) while the
         * encoder is unavailable or the link is congested. The loop ends
         * when the reader is canceled by stopVideoCapture(). */
        (async function() {
            while (true) {
                var result = await reader.read();
                if (result.done) break;
                var frame = result.value;
                try {

                    /* Data held by the video-delay feature is unacknowledged
                     * but is not congestion. Raise the limit by the amount
                     * the configured delay keeps in flight. */
                    var delayMs = (typeof guacStream.getVideoDelayMs === 'function')
                            ? guacStream.getVideoDelayMs() : 0;
                    var bitrate = (effectiveEncoderConfig && effectiveEncoderConfig.bitrate) || 800000;

                    /* The backlog cannot drain below the delay budget while
                     * the delay is active (1.5x allows for keyframe bursts),
                     * so hysteresis applies only to the margin above it. */
                    var delayBudgetBlobs = delayMs > 0
                            ? Math.ceil((delayMs / 1000) * bitrate * 1.5 / 8 / writer.blobLength) : 0;
                    var enterLimit = delayBudgetBlobs + BACKPRESSURE_MAX_UNACKED_BLOBS;
                    var exitLimit = delayBudgetBlobs
                            + Math.floor(BACKPRESSURE_MAX_UNACKED_BLOBS / 2);

                    var congested = backpressured
                            ? unackedBlobs > exitLimit
                            : unackedBlobs > enterLimit;
                    if (congested !== backpressured) {
                        backpressured = congested;
                        console.warn('Guacamole.H264CameraRecorder: ' + (congested
                                ? 'link congested (' + unackedBlobs
                                    + ' blobs unacknowledged, limit ' + enterLimit
                                    + '), skipping frames'
                                : 'link recovered, resuming encoding'));
                    }

                    if (!congested && encoder && encoder.state === 'configured') {
                        var wantPeriodicIdr = (Date.now() - lastKeyframeWallMs) >= forceIdrIntervalMs;
                        var requestKey = needKeyframe || wantPeriodicIdr;
                        encoder.encode(frame, { keyFrame: !!requestKey });
                    }
                }
                finally {
                    frame.close();
                }
            }
        })().catch(function pumpTerminated(e) {
            console.warn('Guacamole.H264CameraRecorder: frame pump terminated:', e);
        });

        // Save stream for later cleanup
        mediaStream = stream;

    };

    /**
     * getUserMedia() callback which handles camera recording denial. The
     * underlying Guacamole output stream is closed, and the failure to
     * record is noted using onerror.
     *
     * @private
     */
    var streamDenied = function streamDenied() {

        // Simply end stream if camera access is not allowed
        writer.sendEnd();

        // Notify of closure
        if (recorder.onerror)
            recorder.onerror();

    };

    /**
     * Requests access to the user's camera and begins capturing video. All
     * received video data is encoded as H.264 and forwarded to the
     * Guacamole stream underlying this Guacamole.H264CameraRecorder. This
     * function must be invoked ONLY ONCE per instance of
     * Guacamole.H264CameraRecorder.
     *
     * @private
     */
    var beginVideoCapture = async function beginVideoCapture() {

        /* Check for hardware H.264 support before the first capture, so
         * that the capture constraints below already reflect software
         * encoding where applicable. Runtime hardware failures are still
         * handled by the encoderError fallback. */
        if (!Guacamole.H264CameraRecorder._hardwareFailedAtMs) {
            try {
                var hwProbe = await VideoEncoder.isConfigSupported({
                    codec: 'avc1.640028',
                    width: 1280,
                    height: 720,
                    framerate: 30,
                    hardwareAcceleration: 'prefer-hardware',
                    bitrate: 1250000
                });
                if (!hwProbe || !hwProbe.supported) {
                    Guacamole.H264CameraRecorder._hardwareFailedAtMs = Date.now();
                    console.warn('Guacamole.H264CameraRecorder: no hardware '
                            + 'H.264 encoder on this machine, using software encoding');
                }
            }
            catch (probeError) {
                Guacamole.H264CameraRecorder._hardwareFailedAtMs = Date.now();
            }
        }

        /* This session will use software encoding: cap the capture at
         * 640x480@10. The RDP host requests samples at well under 10 fps in
         * practice, so capturing faster only produces frames which are
         * ultimately discarded server-side. Never scales the format up. */
        var failedAt = Guacamole.H264CameraRecorder._hardwareFailedAtMs;
        if (failedAt && (Date.now() - failedAt)
                < Guacamole.H264CameraRecorder._HW_RETRY_INTERVAL_MS) {
            if (format.width > 640)          format.width = 640;
            if (format.height > 480)         format.height = 480;
            if (format.frameRate > swMaxFps) format.frameRate = swMaxFps;
        }

        // Attempt to retrieve a video input stream from the browser
        var videoConstraints = {
            width: format.width,
            height: format.height,
            frameRate: format.frameRate
        };
        if (format.deviceId) {
            try {
                videoConstraints.deviceId = { exact: format.deviceId };
            } catch (e) {
                // Fallback: string assignment if object form not supported
                videoConstraints.deviceId = format.deviceId;
            }
        }
        var promise = navigator.mediaDevices.getUserMedia({ 'video': videoConstraints });

        // Handle stream creation/rejection via Promise
        if (promise && promise.then)
            promise.then(streamReceived, streamDenied);

    };

    /**
     * Stops capturing video, if the capture has started, freeing all associated
     * resources. If the capture has not started, this function simply ends the
     * underlying Guacamole stream.
     *
     * @private
     */
    var stopVideoCapture = function stopVideoCapture() {

        // Attempt graceful shutdown in order: reader, encoder, tracks
        try { if (reader && reader.cancel) reader.cancel(); } catch (e) {}
        try { if (reader && reader.releaseLock) reader.releaseLock(); } catch (e) {}

        /* flush() and close() throw (or return a rejected promise) unless the
         * codec is still configured — it may already have closed itself on a
         * fatal encoder error. */
        try {
            if (encoder && encoder.state === 'configured') {
                var flushed = encoder.flush();
                if (flushed && flushed.catch)
                    flushed.catch(function ignoreAbortedFlush() {});
            }
        } catch (e) {}
        try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (e) {}

        // Reset PTS baseline and frame tracking so next encoding session starts fresh
        baselinePtsUs = null;
        
        lastOutputPtsMs = null;
        requireKeyframe();
        lastKeyframeWallMs = Date.now();

        // Stop capture
        if (mediaStream) {
            try {
                var tracks = mediaStream.getTracks();
                for (var i = 0; i < tracks.length; i++)
                    tracks[i].stop();
            } catch (e) {}
        }

        // Remove references to now-unneeded components
        processor = null;
        reader = null;
        encoder = null;
        mediaStream = null;

        // End stream
        writer.sendEnd();

    };

    
    /**
     * Resets timing state so the next encoded frame becomes the new baseline.
     */
    this.resetTimeline = function resetTimeline() {
        baselinePtsUs = null;
        lastOutputPtsMs = null;
        
        requireKeyframe();
    };

    /**
     * Updates desired capture format (width/height/frameRate).
     *
     * @param {Object} c
     *     Optional constraints to override the current format.
     * @param {number} [c.width]
     *     Override width in pixels.
     * @param {number} [c.height]
     *     Override height in pixels.
     * @param {number} [c.frameRate]
     *     Override frame rate (frames per second).
     */
    this.setFormat = function setFormat(c) {
        if (!c) return;
        if (typeof c.width === 'number')  format.width  = c.width;
        if (typeof c.height === 'number') format.height = c.height;
        if (typeof c.frameRate === 'number') format.frameRate = c.frameRate;
        if (c.deviceId) format.deviceId = c.deviceId;
    };
    /**
     * Starts the camera recording process.
     */
    this.start = function start() {
        if (!mediaStream) {
            beginVideoCapture().catch(function captureStartFailed(e) {
                console.warn('Guacamole.H264CameraRecorder: failed to begin video capture:', e);
                streamDenied();
            });
        }
    };

    /**
     * Stops the camera recording process.
     */
    this.stop = function stop() {
        stopVideoCapture();
    };

    /**
     * Requests that the next encoded frame be a keyframe. Invoked when the
     * server signals that it has discarded buffered frames and needs a
     * keyframe to resume decoding.
     */
    this.requestKeyframe = function requestKeyframe() {
        requireKeyframe();
    };

};

Guacamole.H264CameraRecorder.prototype = new Guacamole.CameraRecorder();

/**
 * The time of the most recent fatal hardware encoder error, in milliseconds
 * since the epoch, or 0 if hardware encoding has not failed. New capture
 * sessions use software encoding while the failure is recent (see
 * _HW_RETRY_INTERVAL_MS), after which hardware support is re-probed.
 *
 * @private
 * @type {number}
 */
Guacamole.H264CameraRecorder._hardwareFailedAtMs = 0;

/**
 * How long, in milliseconds, software encoding is used after a hardware
 * encoder failure before hardware support is re-probed.
 *
 * @private
 * @constant
 * @type {number}
 */
Guacamole.H264CameraRecorder._HW_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Determines whether the given mimetype is supported by
 * Guacamole.H264CameraRecorder.
 *
 * @param {!string} mimetype
 *     The mimetype to check.
 *
 * @returns {!boolean}
 *     true if the given mimetype is supported by Guacamole.H264CameraRecorder,
 *     false otherwise.
 */
Guacamole.H264CameraRecorder.isSupportedType = function isSupportedType(mimetype) {

    // Check for WebCodecs support
    if (!window.VideoEncoder || !window.MediaStreamTrackProcessor)
        return false;

    return mimetype === 'application/rdpecam+h264';

};

/**
 * Returns a list of all mimetypes supported by Guacamole.H264CameraRecorder.
 *
 * @returns {!string[]}
 *     A list of all mimetypes supported by Guacamole.H264CameraRecorder.
 */
Guacamole.H264CameraRecorder.getSupportedTypes = function getSupportedTypes() {

    // Check for WebCodecs support
    if (!window.VideoEncoder || !window.MediaStreamTrackProcessor)
        return [];

    return ['application/rdpecam+h264'];

};
