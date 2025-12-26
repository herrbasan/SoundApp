/**
 * FFmpeg Audio Players
 * 
 * Provides two player classes for audio playback using FFmpegDecoder:
 * - FFmpegStreamPlayer: Streaming playback with gapless looping
 * - FFmpegBufferedPlayer: Full decode to AudioBuffer (simpler, higher memory)
 * 
 * @example
 * const { FFmpegDecoder, FFmpegStreamPlayer } = require('ffmpeg-napi-interface');
 * 
 * // Create AudioContext; decoder output will be configured to match its sampleRate
 * const audioContext = new AudioContext({ sampleRate: 48000 });
 * 
 * // Create player
 * FFmpegStreamPlayer.setDecoder(FFmpegDecoder);
 * const player = new FFmpegStreamPlayer(audioContext);
 * 
 * // Load and play
 * await player.open('./music.flac');
 * player.setLoop(true);
 * await player.play();
 */

const path = require('path');

const DEBUG = !!(process && process.env && process.env.FFMPEG_NAPI_DEBUG);

/**
 * Get the path to the AudioWorklet processor file.
 * This file must be served/accessible to load via audioContext.audioWorklet.addModule()
 * 
 * @returns {string} Absolute path to ffmpeg-worklet-processor.js
 */
function getWorkletPath() {
  return path.join(__dirname, 'ffmpeg-worklet-processor.js');
}

let FFmpegDecoder = null;

/**
 * Streaming player with chunk-based gapless looping
 * 
 * Uses AudioWorklet for low-latency streaming playback.
 * Supports sample-accurate gapless looping by storing the first chunk
 * and replaying it seamlessly when the file ends.
 */
class FFmpegStreamPlayer {
  /**
   * Set the decoder class to use (call once before creating instances)
   * @param {typeof FFmpegDecoder} DecoderClass
   */
  static setDecoder(DecoderClass) {
    FFmpegDecoder = DecoderClass;
  }

  /**
   * @param {AudioContext} audioContext - Playback clock for the AudioWorklet (its sampleRate drives time)
   * @param {string} [workletPath] - Path to worklet file (for custom serving scenarios)
   * @param {number} [prebufferSize] - Target queue depth in chunks (takes effect on next open/play)
   * @param {number} [threadCount] - Number of decoder threads (0 = auto, uses all CPU cores)
   * @param {boolean} [connectDestination=true] - Whether to connect to audioContext.destination automatically
   */
  constructor(audioContext, workletPath = null, prebufferSize = 10, threadCount = 0, connectDestination = true) {
    this.audioContext = audioContext;
    this.workletPath = workletPath;
    this.threadCount = threadCount | 0;
    this.decoder = null;
    this.workletNode = null;
    this.gainNode = audioContext.createGain();
    if (connectDestination) {
      this.gainNode.connect(audioContext.destination);
    }
    this.decodeTimer = null;
    this.isPlaying = false;
    this.isLoaded = false;
    this.isLoop = false;
    this.filePath = null;
    this.onEndedCallback = null;
    this.workletReady = false;
    this.duration = 0;
    this._sampleRate = 44100;
    this._channels = 2;
    
    // Position tracking
    this.currentFrames = 0;
    this.totalFramesInFile = 0;
    this._underrunFrames = 0;
    this._posMsgAt = 0;
    this._posMsgFrames = 0;
    
    // Chunk + buffering settings (time-based to behave consistently across sample rates)
    this.chunkSeconds = 0.10;
    this.chunkFrames = 0;
    this.chunkSize = 0; // samples per chunk (interleaved)
    this._prebufferSize = (prebufferSize | 0) > 0 ? (prebufferSize | 0) : 10;
    this._queuedChunks = 0;
    this._queueEstimate = 0;
    
    // Loop chunk tracking
    this.loopChunkFrames = 0; // actual frames in loop chunk
    
    // State
    this.decoderEOF = false;
  }

  /** @type {number} */
  get prebufferSize() {
    return this._prebufferSize;
  }

  set prebufferSize(val) {
    const n = val | 0;
    this._prebufferSize = n > 0 ? n : 1;
  }

  _recomputeChunkSize() {
    const sr = (this.audioContext && this.audioContext.sampleRate) ? this.audioContext.sampleRate : this._sampleRate;
    const frames = Math.max(256, Math.round(sr * this.chunkSeconds));
    this.chunkFrames = frames;
    this.chunkSize = frames * this._channels;
  }

  _fillQueue(targetChunks, maxChunks = 64) {
    if (!this.decoder || !this.workletNode || this.decoderEOF) return;
    let queued = this._queueEstimate | 0;
    const target = targetChunks | 0;
    
    // Limit how many chunks we decode in one burst to prevent blocking the main thread,
    // especially when multiple players are active (mixer).
    const burst = Math.min(maxChunks, target - queued);
    
    for (let i = 0; i < burst && queued < target && !this.decoderEOF; i++) {
      const eofBefore = this.decoderEOF;
      this._decodeAndSendChunk();
      if (this.decoderEOF && !eofBefore) break;
      queued++;
    }
    this._queueEstimate = queued;
  }

  /** @type {number} */
  get volume() {
    return this.gainNode.gain.value;
  }

  set volume(val) {
    this.gainNode.gain.value = val;
  }

  /**
   * Connect the player's output to an AudioNode
   * @param {AudioNode} node 
   * @param {number} [outputIndex=0]
   * @param {number} [inputIndex=0]
   */
  connect(node, outputIndex = 0, inputIndex = 0) {
    this.gainNode.connect(node, outputIndex, inputIndex);
  }

  /**
   * Initialize the AudioWorklet (called automatically by open())
   * @param {string} [workletUrl] - URL/path to load worklet from
   */
  async init(workletUrl = null) {
    if (this.workletReady) return;

    const url = workletUrl || this.workletPath || './ffmpeg-worklet-processor.js';
    
    try {
      await this.audioContext.audioWorklet.addModule(url);
      this.workletReady = true;
    } catch (err) {
      console.error('Failed to load FFmpeg worklet:', err);
      throw err;
    }
  }

  /**
   * Open a file for playback (does not start playing)
   * @param {string} filePath - Path to audio file
   * @param {string} [workletUrl] - URL/path to worklet (if not set in constructor)
   * @returns {Promise<{duration: number, sampleRate: number, channels: number}>}
   */
  async open(filePath, workletUrl = null) {
    if (!this.workletReady) {
      await this.init(workletUrl);
    }

    this.stop();

    if (!FFmpegDecoder) {
      throw new Error('FFmpegDecoder not set. Call FFmpegStreamPlayer.setDecoder(FFmpegDecoder) first.');
    }

    this.decoder = new FFmpegDecoder();
    const ctxRate = (this.audioContext && this.audioContext.sampleRate) ? (this.audioContext.sampleRate | 0) : 44100;
    const threads = (this.threadCount | 0);
    if (!this.decoder.open(filePath, ctxRate, threads)) {
      throw new Error('Failed to open file with FFmpeg decoder');
    }

    const decRate = this.decoder.getSampleRate() | 0;
    if (decRate !== ctxRate) {
      this.decoder.close();
      throw new Error('Decoder output sample rate (' + decRate + 'Hz) does not match AudioContext sampleRate (' + ctxRate + 'Hz)');
    }

    if (DEBUG) console.log('[FFmpegStreamPlayer] open:', { ctxRate, decRate, chunkSeconds: this.chunkSeconds });

    this.filePath = filePath;
    this.duration = this.decoder.getDuration();
    this._sampleRate = decRate;
    this._channels = this.decoder.getChannels();
    this._recomputeChunkSize();
    if (DEBUG) console.log('[FFmpegStreamPlayer] chunk:', { chunkFrames: this.chunkFrames, chunkSize: this.chunkSize, channels: this._channels });
    this.totalFramesInFile = Math.floor(this.duration * this._sampleRate);
    this.decoderEOF = false;
    this.currentFrames = 0;
    this._posMsgAt = 0;
    this._posMsgFrames = 0;
    this.isLoaded = true;
    this._queuedChunks = 0;
    this._queueEstimate = 0;

    // Create worklet node
    this.workletNode = new AudioWorkletNode(this.audioContext, 'ffmpeg-stream', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });

    this.workletNode.port.onmessage = (event) => {
      switch (event.data.type) {
        case 'position':
          this.currentFrames = event.data.frames;
          this._posMsgFrames = this.currentFrames;
          this._posMsgAt = (this.audioContext && isFinite(this.audioContext.currentTime)) ? this.audioContext.currentTime : 0;
          if (event.data.queuedChunks !== undefined) {
            this._queuedChunks = event.data.queuedChunks | 0;
            this._queueEstimate = this._queuedChunks;
          }
          if (event.data.underrunFrames !== undefined) {
            this._underrunFrames = event.data.underrunFrames | 0;
          }
          break;
          
        case 'loopStarted':
          // Worklet is playing loop chunk (chunk 0)
          // Seek to start and skip first chunk to ensure sample-accurate positioning
          this.decoder.seek(0);
          // Read and discard first chunk (same as loopChunk) to get to chunk 1 position
          this.decoder.read(this.loopChunkFrames * this._channels);
          this.decoderEOF = false;
          this._queuedChunks = 0;
          this._queueEstimate = 0;
          // Burst-fill queue while loopChunk is playing
          this._fillQueue(this._prebufferSize);
          break;
          
        case 'ended':
          this.isPlaying = false;
          if (this.onEndedCallback) {
            this.onEndedCallback();
          }
          break;
      }
    };

    // Read first chunk and send as loop chunk
    this._sendLoopChunk();
    
    // Send current loop state
    this.workletNode.port.postMessage({ type: 'setLoop', enabled: this.isLoop });

    return {
      duration: this.duration,
      sampleRate: this._sampleRate,
      channels: this._channels
    };
  }

  /**
   * Read first chunk, send to worklet as both loopChunk AND first regular chunk
   * @private
   */
  _sendLoopChunk() {
    const result = this.decoder.read(this.chunkSize);
    
    if (result.samplesRead > 0) {
      // Track actual size
      this.loopChunkFrames = result.samplesRead / this._channels;
      
      // Make a copy for the loop chunk
      const loopChunk = new Float32Array(result.samplesRead);
      loopChunk.set(result.buffer.subarray(0, result.samplesRead));
      
      // Send as loop chunk (for gapless looping)
      this.workletNode.port.postMessage({ 
        type: 'loopChunk', 
        samples: loopChunk 
      });
      
      // Also send as first regular chunk (for initial playback)
      this.workletNode.port.postMessage({
        type: 'chunk',
        samples: loopChunk
      });

      // Worklet queue now has at least the first chunk enqueued
      this._queuedChunks = 1;
      this._queueEstimate = 1;
    }
    
    // Decoder is now positioned at chunk 1
    this.decoderEOF = false;
  }

  /**
   * Start or resume playback
   * @param {number} [when=0] - AudioContext time to start playback
   */
  async play(when = 0) {
    if (!this.isLoaded) {
      throw new Error('No file loaded. Call open() first.');
    }

    // Allow re-triggering play() to update start time even if already playing
    // if (this.isPlaying) return;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Connect audio graph
    this.workletNode.connect(this.gainNode);
    
    // If we are starting from 0, ensure worklet knows
    if (this.currentFrames === 0) {
      this.workletNode.port.postMessage({ type: 'resetPosition' });
    }

    // Set scheduled start time
    this.workletNode.port.postMessage({ type: 'startAt', time: when });

    if (this.isPlaying) return;

    // Pre-buffer ONLY ONE chunk synchronously if we don't have any yet.
    // If seek() was called just before play(), we already have a chunk (queueEstimate > 0).
    if (this._queueEstimate === 0) {
      this._fillQueue(this._prebufferSize, 1);
    }

    this.isPlaying = true;
    this._startFeedLoop();
  }

  /**
   * Decode one chunk and send to worklet
   * @private
   */
  _decodeAndSendChunk() {
    if (!this.decoder || !this.workletNode || this.decoderEOF) return;
    
    const result = this.decoder.read(this.chunkSize);
    
    if (result.samplesRead > 0) {
      this.workletNode.port.postMessage({
        type: 'chunk',
        samples: result.buffer.subarray(0, result.samplesRead)
      });
    } else {
      // EOF - signal worklet so it marks last queued chunk
      this.decoderEOF = true;
      this.workletNode.port.postMessage({ type: 'eof' });
    }
  }

  /**
   * Continuously feed data to the worklet
   * @private
   */
  _startFeedLoop() {
    if (!this.isPlaying) return;

    if (!this.decoderEOF) {
      // Keep queue around the configured target depth.
      // Decode only one chunk per tick to keep the main thread responsive.
      if ((this._queueEstimate | 0) < (this._prebufferSize | 0)) {
        this._fillQueue(this._prebufferSize, 1);
      }
    }

    this.decodeTimer = setTimeout(() => this._startFeedLoop(), 20);
  }

  /**
   * Set callback for when playback ends (non-looping)
   * @param {Function} callback
   */
  onEnded(callback) {
    this.onEndedCallback = callback;
  }

  /**
   * Get current playback position in seconds
   * @returns {number}
   */
  getCurrentTime() {
    let frames = this.currentFrames | 0;
    if (this.isPlaying && this.audioContext && isFinite(this.audioContext.currentTime)) {
      const tNow = this.audioContext.currentTime;
      const tMsg = this._posMsgAt;
      // Worklet reports 'position' roughly every 50ms. Without compensation, different
      // worklets will be out-of-phase and appear to drift by up to ~50ms.
      // Extrapolate from the last received frame count using AudioContext time.
      const dt = (tNow - tMsg);
      // Only extrapolate when we recently received a position and the queue was not empty
      // (queue empty increases underrun risk and framesPlayed may pause).
      if (tMsg > 0 && dt > 0 && dt < 0.20 && (this._queuedChunks | 0) > 0) {
        frames = (this._posMsgFrames | 0) + Math.floor(dt * this._sampleRate);
      }
    }
    const time = frames / this._sampleRate;
    
    if (this.isLoop && this.duration > 0) {
      return time % this.duration;
    }
    
    return Math.min(time, this.duration);
  }

  /**
   * Pause playback
   */
  pause() {
    if (this.isPlaying) {
      this.isPlaying = false;

      if (this.decodeTimer) {
        clearTimeout(this.decodeTimer);
        this.decodeTimer = null;
      }

      if (this.workletNode) {
        this.workletNode.disconnect();
      }
    }
  }

  /**
   * Resume playback
   */
  resume() {
    this.play();
  }

  /**
   * Seek to position in seconds
   * @param {number} seconds
   * @returns {boolean} true if successful
   */
  seek(seconds) {
    if (!this.decoder) return false;

    const success = this.decoder.seek(seconds);
    if (success) {
      this.decoderEOF = false;

      this._queuedChunks = 0;
      this._queueEstimate = 0;

      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'clear' });
        
        const frames = Math.floor(seconds * this._sampleRate);
        this.workletNode.port.postMessage({ type: 'setPosition', frames: frames });
        this.currentFrames = frames;
        this._posMsgFrames = frames;
        this._posMsgAt = (this.audioContext && isFinite(this.audioContext.currentTime)) ? this.audioContext.currentTime : 0;
        
        // Pre-buffer ONLY ONE chunk synchronously to ensure immediate start without blocking.
        // We do this even if not playing, so the worklet is "primed" for an atomic start.
        this._fillQueue(this._prebufferSize, 1);
      }
    }
    return success;
  }

  /**
   * Get file duration in seconds
   * @returns {number}
   */
  getDuration() {
    return this.duration || 0;
  }

  /**
   * Enable or disable looping
   * @param {boolean} loop
   */
  setLoop(loop) {
    this.isLoop = loop;
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'setLoop', enabled: loop });
    }
  }

  /**
   * Stop playback and release resources
   */
  stop() {
    this.pause();

    if (this.workletNode) {
      // Clear message handler to break closure references and prevent memory leaks
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }

    this.isLoaded = false;
    this.decoderEOF = false;
    this.currentFrames = 0;
    this._posMsgAt = 0;
    this._posMsgFrames = 0;
  }
}


/**
 * Buffered player - decodes entire file to AudioBuffer
 * 
 * Simpler implementation using Web Audio's native AudioBufferSourceNode.
 * Uses more memory (entire file decoded upfront) but has perfect looping.
 */
class FFmpegBufferedPlayer {
  /**
   * Set the decoder class to use (call once before creating instances)
   * @param {typeof FFmpegDecoder} DecoderClass
   */
  static setDecoder(DecoderClass) {
    FFmpegDecoder = DecoderClass;
  }

  /**
   * @param {AudioContext} audioContext
   * @param {number} [threadCount] - Number of decoder threads (0 = auto)
   */
  constructor(audioContext, threadCount = 0) {
    this.audioContext = audioContext;
    this.threadCount = threadCount | 0;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.gainNode = audioContext.createGain();
    this.gainNode.connect(audioContext.destination);
    this.isPlaying = false;
    this.isLoaded = false;
    this.isLoop = false;
    this.startTime = 0;
    this.pausedAt = 0;
    this.duration = 0;
    this.onEndedCallback = null;
    this._sampleRate = 44100;
  }

  /** @type {number} */
  get volume() {
    return this.gainNode.gain.value;
  }

  set volume(val) {
    this.gainNode.gain.value = val;
  }

  /**
   * Initialize (no-op for buffered player)
   */
  async init() {
    // No initialization needed for buffered player
  }

  /**
   * Open and decode entire file
   * @param {string} filePath - Path to audio file
   * @returns {Promise<{duration: number, sampleRate: number, channels: number}>}
   */
  async open(filePath) {
    this.stop();

    if (!FFmpegDecoder) {
      throw new Error('FFmpegDecoder not set. Call FFmpegBufferedPlayer.setDecoder(FFmpegDecoder) first.');
    }

    const decoder = new FFmpegDecoder();
    const ctxRate = (this.audioContext && this.audioContext.sampleRate) ? (this.audioContext.sampleRate | 0) : 44100;
    const threads = (this.threadCount | 0);
    if (!decoder.open(filePath, ctxRate, threads)) {
      throw new Error('Failed to open file with FFmpeg decoder');
    }

    this.duration = decoder.getDuration();
    this._sampleRate = decoder.getSampleRate();
    if ((this._sampleRate | 0) !== (ctxRate | 0)) {
      decoder.close();
      throw new Error('Decoder output sample rate (' + this._sampleRate + 'Hz) does not match AudioContext sampleRate (' + ctxRate + 'Hz)');
    }

    if (DEBUG) console.log('[FFmpegBufferedPlayer] open:', { ctxRate, decRate: this._sampleRate });
    const channels = decoder.getChannels();

    // Decode entire file
    const chunks = [];
    let totalSamples = 0;

    while (true) {
      const result = decoder.read((ctxRate * channels) | 0);
      if (result.samplesRead === 0) break;
      
      const chunk = new Float32Array(result.samplesRead);
      chunk.set(result.buffer.subarray(0, result.samplesRead));
      chunks.push(chunk);
      totalSamples += result.samplesRead;
    }

    decoder.close();

    // Create AudioBuffer
    const frames = totalSamples / channels;
    this.audioBuffer = this.audioContext.createBuffer(channels, frames, this._sampleRate);

    // Deinterleave into channels
    let offset = 0;
    const left = this.audioBuffer.getChannelData(0);
    const right = channels > 1 ? this.audioBuffer.getChannelData(1) : left;

    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += channels) {
        const frameIndex = offset + (i / channels);
        if (frameIndex < frames) {
          left[frameIndex] = chunk[i];
          if (channels > 1) {
            right[frameIndex] = chunk[i + 1];
          }
        }
      }
      offset += chunk.length / channels;
    }

    this.isLoaded = true;
    this.pausedAt = 0;

    return {
      duration: this.duration,
      sampleRate: this._sampleRate,
      channels: channels
    };
  }

  /**
   * Start or resume playback
   */
  async play() {
    if (!this.isLoaded || !this.audioBuffer) {
      throw new Error('No file loaded. Call open() first.');
    }

    if (this.isPlaying) return;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this._createSourceNode();
    this.sourceNode.start(0, this.pausedAt);
    this.startTime = this.audioContext.currentTime - this.pausedAt;
    this.isPlaying = true;
  }

  /**
   * @private
   */
  _createSourceNode() {
    if (this.sourceNode) {
      this.sourceNode.disconnect();
    }

    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.loop = this.isLoop;
    this.sourceNode.connect(this.gainNode);

    this.sourceNode.onended = () => {
      if (!this.isLoop && this.isPlaying) {
        this.isPlaying = false;
        this.pausedAt = 0;
        if (this.onEndedCallback) {
          this.onEndedCallback();
        }
      }
    };
  }

  /**
   * Set callback for when playback ends (non-looping)
   * @param {Function} callback
   */
  onEnded(callback) {
    this.onEndedCallback = callback;
  }

  /**
   * Get current playback position in seconds
   * @returns {number}
   */
  getCurrentTime() {
    if (!this.isPlaying) {
      return this.pausedAt;
    }
    
    const elapsed = this.audioContext.currentTime - this.pausedAt;
    
    if (this.isLoop && this.duration > 0) {
      return elapsed % this.duration;
    }
    
    return Math.min(elapsed, this.duration);
  }

  /**
   * Pause playback
   */
  pause() {
    if (this.isPlaying && this.sourceNode) {
      this.pausedAt = this.getCurrentTime();
      this.sourceNode.onended = null;  // Clear handler to break closure
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.sourceNode = null;
      this.isPlaying = false;
    }
  }

  /**
   * Resume playback
   */
  resume() {
    this.play();
  }

  /**
   * Seek to position in seconds
   * @param {number} seconds
   * @returns {boolean} true if successful
   */
  seek(seconds) {
    const wasPlaying = this.isPlaying;
    
    if (this.isPlaying && this.sourceNode) {
      this.sourceNode.onended = null;  // Clear handler to break closure
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.sourceNode = null;
      this.isPlaying = false;
    }

    this.pausedAt = Math.max(0, Math.min(seconds, this.duration));

    if (wasPlaying) {
      this.play();
    }

    return true;
  }

  /**
   * Get file duration in seconds
   * @returns {number}
   */
  getDuration() {
    return this.duration || 0;
  }

  /**
   * Enable or disable looping
   * @param {boolean} loop
   */
  setLoop(loop) {
    this.isLoop = loop;
    if (this.sourceNode) {
      this.sourceNode.loop = loop;
    }
  }

  /**
   * Stop playback and release resources
   */
  stop() {
    if (this.sourceNode) {
      // Clear event handler to break closure references
      this.sourceNode.onended = null;
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    this.isPlaying = false;
    this.pausedAt = 0;
    this.audioBuffer = null;
    this.isLoaded = false;
  }
}

module.exports = {
  FFmpegStreamPlayer,
  FFmpegBufferedPlayer,
  getWorkletPath
};
