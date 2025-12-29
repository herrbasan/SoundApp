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
  SIZE: 12
};

const STATE = {
  STOPPED: 0,
  PLAYING: 1,
  PAUSED: 2
};

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
   * @param {number} [ringSeconds=2] - Ring buffer size in seconds
   * @param {number} [threadCount=0] - Decoder threads (0=auto)
   * @param {boolean} [connectDestination=true] - Auto-connect to destination
   */
  constructor(audioContext, workletPath = null, ringSeconds = 2, threadCount = 0, connectDestination = true) {
    this.audioContext = audioContext;
    this.workletPath = workletPath;
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
    
    this.onEndedCallback = null;
    this.workletReady = false;
    this.feedTimer = null;
    this.isDisposed = false;
    
    // Position tracking (for getCurrentTime)
    this._posMsgAt = 0;        // AudioContext time when last position message received
    this._posMsgFrames = 0;    // Frames played at that time
    this._seekOffset = 0;      // Seek offset in seconds
    
    // Chunk size for feeding (in frames)
    this.chunkFrames = 4096;
  }

  dispose() {
    if (this.isDisposed) return;
    this.stop();
    this.isDisposed = true;
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch(e) {}
    }
    this.audioContext = null;
    this.gainNode = null;
  }

  get volume() {
    return this.gainNode ? this.gainNode.gain.value : 1;
  }

  set volume(val) {
    if (this.gainNode) this.gainNode.gain.value = val;
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
    Atomics.store(this.controlBuffer, CONTROL.TOTAL_FRAMES, this.totalFrames);
    Atomics.store(this.controlBuffer, CONTROL.UNDERRUN_COUNT, 0);
    Atomics.store(this.controlBuffer, CONTROL.START_TIME_HI, 0);
    Atomics.store(this.controlBuffer, CONTROL.START_TIME_LO, 0);
    
    // Create or reuse worklet node
    // Reuse worklet node if we're reusing SABs (same buffers, just reset state)
    if (this.workletNode && !needNewSAB) {
      // Just reset the worklet state, no new node needed
      this.workletNode.port.postMessage({ type: 'reset' });
    } else {
      // Need new worklet node - clean up old one first
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'dispose' });
        try { this.workletNode.disconnect(); } catch(e) {}
        this.workletNode.port.onmessage = null;
        this.workletNode = null;
      }
      
      this.workletNode = new AudioWorkletNode(this.audioContext, 'ffmpeg-stream-sab', {
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

  _fillRingBuffer() {
    if (!this.decoder || !this.controlBuffer || !this.audioBuffer) return 0;
    
    const writePtr = Atomics.load(this.controlBuffer, CONTROL.WRITE_PTR);
    const readPtr = Atomics.load(this.controlBuffer, CONTROL.READ_PTR);
    
    // Calculate how much space is available
    let used = writePtr - readPtr;
    if (used < 0) used += this.ringSize;
    const available = this.ringSize - used - 1; // -1 to distinguish full from empty
    
    if (available <= 0) return 0;
    
    // Decode in chunks
    const framesToRead = Math.min(available, this.chunkFrames);
    const samplesToRead = framesToRead * this._channels;
    
    const result = this.decoder.read(samplesToRead);
    if (result.samplesRead <= 0) {
      // EOF
      if (this.isLoop) {
        this.decoder.seek(0);
      }
      return 0;
    }
    
    const framesRead = Math.floor(result.samplesRead / this._channels);
    
    // Write to ring buffer (handle wrap-around)
    let localWritePtr = writePtr;
    for (let i = 0; i < framesRead; i++) {
      const srcIdx = i * this._channels;
      const dstIdx = (localWritePtr % this.ringSize) * this._channels;
      
      this.audioBuffer[dstIdx] = result.buffer[srcIdx];
      this.audioBuffer[dstIdx + 1] = result.buffer[srcIdx + 1];
      
      localWritePtr++;
    }
    
    // Update write pointer atomically
    Atomics.store(this.controlBuffer, CONTROL.WRITE_PTR, localWritePtr % this.ringSize);
    return framesRead;
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
    
    this._fillRingBuffer();
    
    // Continue feeding at ~20ms intervals
    this.feedTimer = setTimeout(() => this._startFeedLoop(), 20);
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
    
    // Set scheduled start time
    this._setScheduledStart(when);
    
    // Set state to playing
    Atomics.store(this.controlBuffer, CONTROL.STATE, STATE.PLAYING);
    
    if (this.isPlaying) return;
    
    this.isPlaying = true;
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
    
    // Disconnect worklet to stop CPU usage while paused
    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch(e) {}
    }
  }

  resume() {
    this.play();
  }

  seek(seconds) {
    if (!this.decoder || !this.controlBuffer) return false;
    
    const success = this.decoder.seek(seconds);
    if (success) {
      // Reset ring buffer pointers
      Atomics.store(this.controlBuffer, CONTROL.WRITE_PTR, 0);
      Atomics.store(this.controlBuffer, CONTROL.READ_PTR, 0);
      
      // Reset position tracking
      this._seekOffset = seconds;
      this._posMsgAt = 0;
      this._posMsgFrames = 0;
      
      // Tell worklet to reset its internal counters
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'seek', offsetFrames: Math.floor(seconds * this._sampleRate) });
      }
      
      // Aggressively refill buffer to avoid underruns after seek
      for (let i = 0; i < 16; i++) {
        const read = this._fillRingBuffer();
        if (read <= 0) break;
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

  stop(keepDecoder = false) {
    this.pause();
    
    if (this.controlBuffer) {
      Atomics.store(this.controlBuffer, CONTROL.STATE, STATE.STOPPED);
      Atomics.store(this.controlBuffer, CONTROL.WRITE_PTR, 0);
      Atomics.store(this.controlBuffer, CONTROL.READ_PTR, 0);
    }
    
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'dispose' });
      try { this.workletNode.disconnect(); } catch(e) {}
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
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
