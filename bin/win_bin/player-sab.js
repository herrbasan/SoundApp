/**
 * SharedArrayBuffer-based FFmpeg Streaming Player
 * 
 * Uses a ring buffer shared between main thread and AudioWorklet
 * to avoid postMessage memory retention issues.
 * 
 * Key differences from postMessage version:
 * - Creates fixed-size SharedArrayBuffers on open()
 * - Writes decoded audio directly to ring buffer
 * - Uses Atomics for thread-safe coordination
 * - No per-chunk allocations or message copies
 */

'use strict';

const path = require('path');

let FFmpegDecoder = null;

// Control buffer layout (must match worklet)
const CONTROL = {
  WRITE_PTR: 0,
  READ_PTR: 1,
  STATE: 2,
  SAMPLE_RATE: 3,
  CHANNELS: 4,
  LOOP_ENABLED: 5,
  LOOP_START: 6,
  LOOP_END: 7,
  TOTAL_FRAMES: 8,
  UNDERRUN_COUNT: 9,
  START_TIME_HI: 10,
  START_TIME_LO: 11,
  PLAYBACK_RATE: 12,
  SIZE: 13
};

const STATE = {
  STOPPED: 0,
  PLAYING: 1,
  PAUSED: 2
};

// Fade durations for smooth transitions (in seconds)
const FADE_OUT_DURATION = 0.012;  // 12ms fade out
const FADE_IN_DURATION = 0.015;   // 15ms fade in

/**
 * Get the path to the SAB worklet processor file.
 */
function getWorkletPath() {
  return path.join(__dirname, 'ffmpeg-worklet-sab.js');
}

/**
 * SharedArrayBuffer-based streaming player
 */
class FFmpegStreamPlayerSAB {
  /**
   * Set the decoder class (call once before creating instances)
   */
  static setDecoder(DecoderClass) {
    FFmpegDecoder = DecoderClass;
  }

  /**
   * @param {AudioContext} audioContext
   * @param {string} [workletPath] - Path to SAB worklet
   * @param {string} [processorName='ffmpeg-stream-sab'] - AudioWorkletProcessor name
   * @param {number} [ringSeconds=2] - Ring buffer size in seconds
   * @param {number} [threadCount=0] - Decoder threads (0=auto)
   * @param {boolean} [connectDestination=true] - Auto-connect to destination
   */
  constructor(audioContext, workletPath = null, processorName = 'ffmpeg-stream-sab', ringSeconds = 2, threadCount = 0, connectDestination = true) {
    this.audioContext = audioContext;
    this.workletPath = workletPath;
    this.processorName = processorName;
    this.ringSeconds = ringSeconds;
    this.threadCount = threadCount | 0;
    
    this.decoder = null;
    this.workletNode = null;
    this.gainNode = audioContext.createGain();
    if (connectDestination) {
      this.gainNode.connect(audioContext.destination);
    }
    
    // SharedArrayBuffers
    this.controlSAB = null;
    this.audioSAB = null;
    this.controlBuffer = null;  // Int32Array view
    this.audioBuffer = null;    // Float32Array view
    this.ringSize = 0;          // In frames
    
    // State
    this.isPlaying = false;
    this.isLoaded = false;
    this.isLoop = false;
    this.filePath = null;
    this.duration = 0;
    this._sampleRate = 44100;
    this._channels = 2;
    this.totalFrames = 0;
    this._playbackRate = 1.0;
    this._targetVolume = 1.0;

    // End-of-track tracking (important for reliable playlist advance)
    // Worklet compares framesPlayed (relative to current position) against CONTROL.TOTAL_FRAMES.
    this._framesWritten = 0;     // Frames decoded+written since last open/seek
    this._targetFrames = 0;      // Frames expected to play from current position (estimate, then corrected at EOF)
    this._eof = false;
    
    this.onEndedCallback = null;
    this.workletReady = false;
    this.feedTimer = null;
    this.isDisposed = false;
    
    // Position tracking (for getCurrentTime)
    this._posMsgAt = 0;        // AudioContext time when last position message received
    this._posMsgFrames = 0;    // Frames played at that time
    this._seekOffset = 0;      // Seek offset in seconds

    // Mixer UI expects these (best-effort diagnostics)
    this.currentFrames = 0;
    this._queuedChunks = 0;
    this._underrunFrames = 0;

    // Feeding / buffering settings
    this.prebufferSize = 10;      // Target queue depth in chunks (compatible with old UI setting)
    this.chunkSeconds = 0.10;     // Decode granularity target (seconds)
    this.chunkFrames = 4096;      // Will be recomputed on open() based on sample rate
    this.feedIntervalMs = 20;     // Feeder cadence (ms)
    this._feedNextAtMs = 0;
  }

  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    
    // Stop feed timer first
    if (this.feedTimer) {
      clearTimeout(this.feedTimer);
      this.feedTimer = null;
    }
    
    // Dispose worklet - send message, disconnect, remove listener
    if (this.workletNode) {
      try { this.workletNode.port.postMessage({ type: 'dispose' }); } catch(e) {}
      try { this.workletNode.disconnect(); } catch(e) {}
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }
    
    // Disconnect gain node from destination
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch(e) {}
      this.gainNode = null;
    }
    
    // Close decoder and release native resources
    if (this.decoder) {
      try { this.decoder.close(); } catch(e) {}
      this.decoder = null;
    }
    
    // Clear all SAB references
    this.controlSAB = null;
    this.audioSAB = null;
    this.controlBuffer = null;
    this.audioBuffer = null;
    this.ringSize = 0;
    
    // Clear all callbacks
    this.onEndedCallback = null;
    
    // Clear context reference (don't close it - not our responsibility)
    this.audioContext = null;
    
    // Reset all state
    this.isPlaying = false;
    this.isLoaded = false;
    this.filePath = null;
    this.duration = 0;
  }

  get volume() {
    return this.gainNode ? this.gainNode.gain.value : 1;
  }

  set volume(val) {
    this._targetVolume = val;
    if (this.gainNode) this.gainNode.gain.value = val;
  }

  setPlaybackRate(semitones) {
    semitones = Math.max(-24, Math.min(24, semitones | 0));
    this.setPlaybackRateRatio(Math.pow(2, semitones / 12.0));
  }

  // Set absolute playback-rate multiplier (1.0 = normal).
  // Used by Pitch&Time to implement time-stretch without RubberBand tempo.
  setPlaybackRateRatio(rate) {
    rate = +rate;
    if (!isFinite(rate) || rate <= 0) return;
    // Clamp to a sane range (worklet supports fractional interpolation).
    if (rate < 0.25) rate = 0.25;
    if (rate > 4.0) rate = 4.0;
    this._playbackRate = rate;
    if (this.controlBuffer) {
      const rateInt = Math.round(this._playbackRate * 1000) | 0;
      Atomics.store(this.controlBuffer, CONTROL.PLAYBACK_RATE, rateInt);
    }
  }

  getPlaybackRate() {
    return this._playbackRate;
  }


  connect(node, outputIndex = 0, inputIndex = 0) {
    this.gainNode.connect(node, outputIndex, inputIndex);
  }

  async init(workletUrl = null) {
    if (this.workletReady) return;
    const url = workletUrl || this.workletPath || getWorkletPath();
    try {
      await this.audioContext.audioWorklet.addModule(url);
      this.workletReady = true;
    } catch (e) {
      if (!e.message.includes('already been registered')) {
        throw e;
      }
      this.workletReady = true;
    }
  }

  async open(filePath, workletUrl = null) {
    if (this.isDisposed) throw new Error('Player disposed');
    
    if (!this.workletReady) {
      await this.init(workletUrl);
    }

    // Stop but keep SABs for potential reuse
    this.stop(true);

    // Reset position tracking for new file
    this._seekOffset = 0;
    this._posMsgAt = 0;
    this._posMsgFrames = 0;

    if (!FFmpegDecoder) {
      throw new Error('FFmpegDecoder not set. Call FFmpegStreamPlayerSAB.setDecoder() first.');
    }

    // Create/reuse decoder
    if (!this.decoder) {
      this.decoder = new FFmpegDecoder();
    }
    
    const ctxRate = this.audioContext.sampleRate | 0;
    if (!this.decoder.open(filePath, ctxRate, this.threadCount)) {
      throw new Error(`Failed to open: ${filePath}`);
    }


    this.filePath = filePath;
    this._sampleRate = this.decoder.getSampleRate() || ctxRate;
    this._channels = this.decoder.getChannels() || 2;
    this.duration = this.decoder.getDuration() || 0;
    this.totalFrames = Math.floor(this.duration * this._sampleRate);

    // Recompute chunk size for this sample rate (keep it aligned to the worklet block size)
    let cf = (this._sampleRate * this.chunkSeconds) | 0;
    cf = (cf + 127) & ~127; // align to 128 frames
    if (cf < 2048) cf = 2048;
    this.chunkFrames = cf;

    // Reset end tracking for a new file
    this._framesWritten = 0;
    this._targetFrames = this.totalFrames;
    this._eof = false;
    
    // Calculate ring buffer size
    const neededRingSize = Math.ceil(this.ringSeconds * this._sampleRate);
    const neededAudioBufferSize = neededRingSize * this._channels;
    
    // Reuse existing SABs if they're the right size, otherwise create new ones
    const needNewSAB = !this.audioSAB || 
                       !this.controlSAB || 
                       this.ringSize !== neededRingSize ||
                       (this.audioSAB.byteLength / 4) !== neededAudioBufferSize;
    
    if (needNewSAB) {
      // Release old references before creating new ones
      this.controlSAB = null;
      this.audioSAB = null;
      this.controlBuffer = null;
      this.audioBuffer = null;
      
      this.ringSize = neededRingSize;
      
      // Create SharedArrayBuffers
      this.controlSAB = new SharedArrayBuffer(CONTROL.SIZE * 4);
      this.audioSAB = new SharedArrayBuffer(neededAudioBufferSize * 4);
    } else {
      this.ringSize = neededRingSize;
    }
    this.controlBuffer = new Int32Array(this.controlSAB);
    this.audioBuffer = new Float32Array(this.audioSAB);
    
    // Initialize control buffer
    Atomics.store(this.controlBuffer, CONTROL.WRITE_PTR, 0);
    Atomics.store(this.controlBuffer, CONTROL.READ_PTR, 0);
    Atomics.store(this.controlBuffer, CONTROL.STATE, STATE.STOPPED);
    Atomics.store(this.controlBuffer, CONTROL.SAMPLE_RATE, this._sampleRate);
    Atomics.store(this.controlBuffer, CONTROL.CHANNELS, this._channels);
    Atomics.store(this.controlBuffer, CONTROL.LOOP_ENABLED, this.isLoop ? 1 : 0);
    Atomics.store(this.controlBuffer, CONTROL.LOOP_START, 0);
    Atomics.store(this.controlBuffer, CONTROL.LOOP_END, this.totalFrames);
    // TOTAL_FRAMES is interpreted by the worklet as "frames to play" from current position.
    // Keep it in sync, especially for seek() and for formats where duration is slightly off.
    Atomics.store(this.controlBuffer, CONTROL.TOTAL_FRAMES, this._targetFrames);
    Atomics.store(this.controlBuffer, CONTROL.UNDERRUN_COUNT, 0);
    Atomics.store(this.controlBuffer, CONTROL.START_TIME_HI, 0);
    Atomics.store(this.controlBuffer, CONTROL.START_TIME_LO, 0);
    const rateInt = Math.round(this._playbackRate * 1000) | 0;
    Atomics.store(this.controlBuffer, CONTROL.PLAYBACK_RATE, rateInt);

    
    // Create or reuse worklet node
    // Reuse worklet node if we're reusing SABs (same buffers, just reset state)
    if (this.workletNode && !needNewSAB) {
      // Just reset the worklet state, no new node needed
      this.workletNode.port.postMessage({ type: 'reset' });
      // Reconnect (was disconnected in stop)
      try { this.workletNode.connect(this.gainNode); } catch(e) {}
    } else {
      // Need new worklet node - clean up old one first
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'dispose' });
        try { this.workletNode.disconnect(); } catch(e) {}
        this.workletNode.port.onmessage = null;
        this.workletNode = null;
      }
      
      this.workletNode = new AudioWorkletNode(this.audioContext, this.processorName || 'ffmpeg-stream-sab', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      
      this.workletNode.port.onmessage = (event) => {
        switch (event.data.type) {
          case 'ended':
            if (!this.isLoop && this.onEndedCallback) {
              this.onEndedCallback();
            }
            break;
          case 'position':
            // Track position for getCurrentTime
            this._posMsgAt = this.audioContext.currentTime;
            this._posMsgFrames = event.data.frames | 0;
            this.currentFrames = this._posMsgFrames | 0;
            break;
        }
      };
      
      // Send SharedArrayBuffers to worklet
      this.workletNode.port.postMessage({
        type: 'init',
        controlSAB: this.controlSAB,
        audioSAB: this.audioSAB,
        ringSize: this.ringSize
      });
      
      // Connect audio graph
      this.workletNode.connect(this.gainNode);
    }
    
    // Pre-fill the ring buffer
    this._fillRingBuffer();
    
    this.isLoaded = true;
    
    return {
      duration: this.duration,
      sampleRate: this._sampleRate,
      channels: this._channels
    };
  }

  _getBufferedFrames(writePtr, readPtr) {
    let buffered = (writePtr | 0) - (readPtr | 0);
    if (buffered < 0) buffered += this.ringSize;
    return buffered;
  }

  _updateDiagnosticsFromControl(writePtr, readPtr) {
    if (!this.controlBuffer) return;
    const buffered = this._getBufferedFrames(writePtr, readPtr);
    const cf = this.chunkFrames | 0;
    this._queuedChunks = cf > 0 ? ((buffered / cf) | 0) : 0;
    this._underrunFrames = Atomics.load(this.controlBuffer, CONTROL.UNDERRUN_COUNT) | 0;
  }

  _pump(maxChunks = 4) {
    if (!this.decoder || !this.controlBuffer || !this.audioBuffer || !this.ringSize) return 0;
    let totalRead = 0;

    // Target buffering (low/high watermark) expressed as chunks
    let pb = (this.prebufferSize | 0);
    if (pb <= 0) pb = 10;
    const cf = this.chunkFrames | 0;
    let low = pb * cf;
    if (low < (cf * 2)) low = cf * 2;
    let high = low + (cf * 2);
    const cap = (this.ringSize - 1) | 0;
    if (high > cap) high = cap;
    if (low > cap) low = cap;

    for (let i = 0; i < maxChunks; i++) {
      const writePtr = Atomics.load(this.controlBuffer, CONTROL.WRITE_PTR) | 0;
      const readPtr = Atomics.load(this.controlBuffer, CONTROL.READ_PTR) | 0;
      const buffered = this._getBufferedFrames(writePtr, readPtr);
      if (buffered >= high) {
        this._updateDiagnosticsFromControl(writePtr, readPtr);
        break;
      }

      // Space available in ring
      const available = this.ringSize - buffered - 1;
      if (available <= 0) {
        this._updateDiagnosticsFromControl(writePtr, readPtr);
        break;
      }

      const framesToRead = Math.min(available, cf);
      const samplesToRead = framesToRead * this._channels;
      const result = this.decoder.read(samplesToRead);
      if (result.samplesRead <= 0) {
        // EOF
        if (this.isLoop) {
          this.decoder.seek(0);
          this._framesWritten = 0;
          this._eof = false;
        }
        else {
          this._eof = true;
          Atomics.store(this.controlBuffer, CONTROL.TOTAL_FRAMES, this._framesWritten | 0);
        }
        this._updateDiagnosticsFromControl(writePtr, readPtr);
        break;
      }

      const framesRead = Math.floor((result.samplesRead | 0) / this._channels);
      if (framesRead <= 0) {
        this._updateDiagnosticsFromControl(writePtr, readPtr);
        break;
      }

      // Track produced frames (relative to current open/seek position)
      this._framesWritten += framesRead;

      // Fast ring write (two-part copy for wrap)
      const samplesRead = framesRead * this._channels;
      const src = result.buffer;
      const srcView = (src.subarray ? src.subarray(0, samplesRead) : src);

      const writeFrame = writePtr;
      const dst0 = writeFrame * this._channels;
      const framesToEnd = this.ringSize - writeFrame;
      const samplesToEnd = framesToEnd * this._channels;
      if (samplesRead <= samplesToEnd) {
        this.audioBuffer.set(srcView, dst0);
      } else {
        this.audioBuffer.set(srcView.subarray(0, samplesToEnd), dst0);
        this.audioBuffer.set(srcView.subarray(samplesToEnd, samplesRead), 0);
      }

      const newWrite = (writeFrame + framesRead) % this.ringSize;
      Atomics.store(this.controlBuffer, CONTROL.WRITE_PTR, newWrite);

      totalRead += framesRead;
      if (buffered + framesRead >= low) {
        // Good enough; don't monopolize the JS thread
        this._updateDiagnosticsFromControl(newWrite, readPtr);
        break;
      }
    }

    return totalRead;
  }

  _fillRingBuffer() {
    if (!this.decoder || !this.controlBuffer || !this.audioBuffer) return 0;
    return this._pump(1);
  }

  /**
   * Aggressively fill the ring buffer (for compatibility with harness)
   * @param {number} [targetFrames] - Frames to try to buffer
   * @param {number} [maxChunks=128] - Max chunk reads
   */
  _fillQueue(targetFrames, maxChunks = 128) {
    if (!this.decoder || !this.controlBuffer) return;
    targetFrames = targetFrames || this.ringSize;
    let totalRead = 0;
    for (let i = 0; i < maxChunks; i++) {
      const read = this._fillRingBuffer();
      if (read <= 0) break;
      totalRead += read;
      if (totalRead >= targetFrames) break;
    }
  }

  _startFeedLoop() {
    if (this.isDisposed || !this.isPlaying) return;

    // Fill toward our target buffer depth; no-op when already sufficiently buffered
    this._pump(4);

    // Drift-corrected scheduling (avoids long-term drift from chained setTimeout)
    const interval = (this.feedIntervalMs | 0) > 0 ? (this.feedIntervalMs | 0) : 20;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!this._feedNextAtMs || (now - this._feedNextAtMs) > (interval * 10)) {
      this._feedNextAtMs = now + interval;
    } else {
      this._feedNextAtMs += interval;
    }
    let delay = this._feedNextAtMs - now;
    if (delay < 0) delay = 0;
    this.feedTimer = setTimeout(() => this._startFeedLoop(), delay);
  }

  _setScheduledStart(when) {
    if (!this.controlBuffer) return;
    
    // Store float64 as two int32s
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, when, true);
    Atomics.store(this.controlBuffer, CONTROL.START_TIME_HI, view.getInt32(0, true));
    Atomics.store(this.controlBuffer, CONTROL.START_TIME_LO, view.getInt32(4, true));
  }

  async play(when = 0) {
    if (this.isDisposed || !this.isLoaded) return;
    
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    
    // Reconnect worklet if disconnected (from pause)
    if (this.workletNode && this.gainNode) {
      try { this.workletNode.connect(this.gainNode); } catch(e) {}
    }
    
    // Smooth fade in from silence to avoid click
    if (this.gainNode) {
      const now = this.audioContext.currentTime;
      const gain = this.gainNode.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(0, now);
      gain.linearRampToValueAtTime(this._targetVolume, now + FADE_IN_DURATION);
    }
    
    // Set scheduled start time
    this._setScheduledStart(when);
    
    // Set state to playing
    Atomics.store(this.controlBuffer, CONTROL.STATE, STATE.PLAYING);
    
    if (this.isPlaying) return;
    
    this.isPlaying = true;
    this._feedNextAtMs = 0;
    this._startFeedLoop();
  }

  pause() {
    this.isPlaying = false;
    
    if (this.feedTimer) {
      clearTimeout(this.feedTimer);
      this.feedTimer = null;
    }
    
    if (this.controlBuffer) {
      Atomics.store(this.controlBuffer, CONTROL.STATE, STATE.PAUSED);
    }
    
    // Smooth fade out before disconnecting to avoid click
    if (this.gainNode && this.workletNode) {
      const now = this.audioContext.currentTime;
      const gain = this.gainNode.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + FADE_OUT_DURATION);
      
      // Disconnect after fade completes to stop CPU usage
      setTimeout(() => {
        if (!this.isPlaying && this.workletNode) {
          try { this.workletNode.disconnect(); } catch(e) {}
        }
      }, FADE_OUT_DURATION * 1000 + 5);
    }
  }

  resume() {
    this.play();
  }

  seek(seconds) {
    if (!this.decoder || !this.controlBuffer) return false;
    
    // Quick fade out/in to mask seek discontinuity
    const wasPlaying = this.isPlaying;
    if (this.gainNode && wasPlaying) {
      const now = this.audioContext.currentTime;
      const gain = this.gainNode.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + FADE_OUT_DURATION * 0.5);  // Half-speed fade for seeks
    }
    
    const success = this.decoder.seek(seconds);
    if (success) {
      // Reset ring buffer pointers
      Atomics.store(this.controlBuffer, CONTROL.WRITE_PTR, 0);
      Atomics.store(this.controlBuffer, CONTROL.READ_PTR, 0);
      
      // Reset position tracking
      this._seekOffset = seconds;
      this._posMsgAt = 0;
      this._posMsgFrames = 0;

      // Worklet frame counter resets on seek, so TOTAL_FRAMES must represent remaining frames.
      this._framesWritten = 0;
      this._eof = false;
      this._targetFrames = Math.max(0, (this.totalFrames | 0) - Math.floor(seconds * this._sampleRate));
      Atomics.store(this.controlBuffer, CONTROL.TOTAL_FRAMES, this._targetFrames | 0);
      
      // Tell worklet to reset its internal counters
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'seek', offsetFrames: Math.floor(seconds * this._sampleRate) });
      }
      
      // Aggressively refill buffer to avoid underruns after seek
      for (let i = 0; i < 16; i++) {
        const read = this._fillRingBuffer();
        if (read <= 0) break;
      }
      
      // Fade back in if was playing
      if (this.gainNode && wasPlaying) {
        const now = this.audioContext.currentTime;
        const gain = this.gainNode.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(0, now + FADE_OUT_DURATION * 0.5);
        gain.linearRampToValueAtTime(this._targetVolume, now + FADE_OUT_DURATION * 0.5 + FADE_IN_DURATION * 0.7);
      }
    }
    return success;
  }

  getCurrentTime() {
    if (!this.controlBuffer || !this._sampleRate) return 0;
    
    // Use position messages from worklet for accurate tracking
    let frames = this._posMsgFrames | 0;
    
    if (this.isPlaying && this.audioContext && isFinite(this.audioContext.currentTime)) {
      const tNow = this.audioContext.currentTime;
      const tMsg = this._posMsgAt;
      // Extrapolate from last position message
      const dt = tNow - tMsg;
      if (tMsg > 0 && dt > 0 && dt < 0.20) {
        frames = (this._posMsgFrames | 0) + Math.floor(dt * this._sampleRate);
      }
    }
    
    // framesPlayed in worklet is relative to seek position, add offset
    const time = this._seekOffset + (frames / this._sampleRate);
    
    if (this.isLoop && this.duration > 0) {
      return time % this.duration;
    }
    
    return Math.min(time, this.duration);
  }

  getDuration() {
    return this.duration || 0;
  }

  setLoop(loop) {
    this.isLoop = loop;
    if (this.controlBuffer) {
      Atomics.store(this.controlBuffer, CONTROL.LOOP_ENABLED, loop ? 1 : 0);
    }
  }

  onEnded(callback) {
    this.onEndedCallback = callback;
  }
  
  fadeOut() {
    if (!this.gainNode) return Promise.resolve();
    return new Promise(resolve => {
      const now = this.audioContext.currentTime;
      const gain = this.gainNode.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + FADE_OUT_DURATION);
      setTimeout(resolve, FADE_OUT_DURATION * 1000);
    });
  }

  stop(keepDecoder = false) {
    // Stop playback state first
    this.isPlaying = false;
    
    // Clear feed timer
    if (this.feedTimer) {
      clearTimeout(this.feedTimer);
      this.feedTimer = null;
    }
    
    // Update control buffer state
    if (this.controlBuffer) {
      Atomics.store(this.controlBuffer, CONTROL.STATE, STATE.STOPPED);
      Atomics.store(this.controlBuffer, CONTROL.WRITE_PTR, 0);
      Atomics.store(this.controlBuffer, CONTROL.READ_PTR, 0);
    }
    
    // Handle worklet based on keepDecoder flag
    if (this.workletNode) {
      if (keepDecoder) {
        // Just disconnect to stop CPU, keep node alive for reuse
        try { this.workletNode.disconnect(); } catch(e) {}
      } else {
        // Full dispose - send message, disconnect, remove listener, null reference
        try { this.workletNode.port.postMessage({ type: 'dispose' }); } catch(e) {}
        try { this.workletNode.disconnect(); } catch(e) {}
        this.workletNode.port.onmessage = null;
        this.workletNode = null;
      }
    }
    
    // Clear SAB references to allow GC (unless we might reuse them)
    if (!keepDecoder) {
      this.controlSAB = null;
      this.audioSAB = null;
      this.controlBuffer = null;
      this.audioBuffer = null;
      this.ringSize = 0;
    }
    
    // Always close and clear decoder - it will be recreated on next open()
    if (this.decoder) {
      try { this.decoder.close(); } catch(e) {}
      this.decoder = null;
    }
    
    this.isLoaded = false;
  }

  /**
   * Get diagnostic info
   */
  getDiagnostics() {
    if (!this.controlBuffer) return null;
    
    const writePtr = Atomics.load(this.controlBuffer, CONTROL.WRITE_PTR);
    const readPtr = Atomics.load(this.controlBuffer, CONTROL.READ_PTR);
    const underruns = Atomics.load(this.controlBuffer, CONTROL.UNDERRUN_COUNT);
    
    let buffered = writePtr - readPtr;
    if (buffered < 0) buffered += this.ringSize;
    
    return {
      ringSize: this.ringSize,
      ringSizeSeconds: this.ringSize / this._sampleRate,
      writePtr,
      readPtr,
      bufferedFrames: buffered,
      bufferedSeconds: buffered / this._sampleRate,
      underrunCount: underruns,
      fillPercent: (buffered / this.ringSize) * 100
    };
  }
}

module.exports = {
  FFmpegStreamPlayerSAB,
  getWorkletPath
};
