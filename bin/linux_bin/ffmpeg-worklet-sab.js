/**
 * SharedArrayBuffer-based AudioWorklet Processor
 * 
 * Reads audio from a ring buffer instead of receiving chunks via postMessage.
 * This eliminates MessagePort memory retention issues.
 * 
 * Ring Buffer Layout:
 * - controlBuffer (Int32Array): [writePtr, readPtr, state, sampleRate, channels, loopEnabled, loopStart, loopEnd, totalFrames]
 * - audioBuffer (Float32Array): interleaved stereo samples
 * 
 * State flags:
 * - 0: stopped
 * - 1: playing
 * - 2: paused
 */

const CONTROL = {
  WRITE_PTR: 0,      // Main thread writes here (in frames)
  READ_PTR: 1,       // Worklet reads here (in frames)
  STATE: 2,          // 0=stopped, 1=playing, 2=paused
  SAMPLE_RATE: 3,    // Audio sample rate
  CHANNELS: 4,       // Number of channels (always 2 for now)
  LOOP_ENABLED: 5,   // 1=loop, 0=no loop
  LOOP_START: 6,     // Loop start frame
  LOOP_END: 7,       // Loop end frame (also total frames if no loop)
  TOTAL_FRAMES: 8,   // Total frames in file
  UNDERRUN_COUNT: 9, // Underrun counter
  START_TIME_HI: 10, // Scheduled start time (high 32 bits of float64)
  START_TIME_LO: 11, // Scheduled start time (low 32 bits of float64)
  PLAYBACK_RATE: 12, // Playback rate multiplier (1000 = 1.0x, stored as int)
  SIZE: 13           // Total control buffer size
};

const STATE = {
  STOPPED: 0,
  PLAYING: 1,
  PAUSED: 2
};

class FFmpegSABProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    this.controlBuffer = null;  // Int32Array view of SharedArrayBuffer
    this.audioBuffer = null;    // Float32Array view of SharedArrayBuffer
    this.ringSize = 0;          // Ring buffer size in frames
    this.channels = 2;
    this.isReady = false;
    this.hasEnded = false;
    this.framesPlayed = 0;
    this.startTime = 0;
    this.readPosition = 0;      // Fractional frame position for pitch shifting
    
    // Fade state (prevents clicks on transitions)
    this.lastState = 0;             // Previous state to detect transitions
    this.isFadingOut = false;       // Currently fading out?
    this.isFadingIn = false;        // Currently fading in?
    this.fadeSamplesRemaining = 0;  // Samples left in fade
    this.fadeSamplesTotal = 0;      // Total samples for fade-in calculation
    this.defaultFadeSamples = 480;  // 10ms at 48kHz
    
    this.port.onmessage = this.onMessage.bind(this);
  }

  onMessage(event) {
    const data = event.data;
    
    switch (data.type) {
      case 'init':
        // Receive SharedArrayBuffers from main thread
        this.controlBuffer = new Int32Array(data.controlSAB);
        this.audioBuffer = new Float32Array(data.audioSAB);
        this.ringSize = data.ringSize | 0;
        this.channels = Atomics.load(this.controlBuffer, CONTROL.CHANNELS) || 2;
        this.isReady = true;
        this.hasEnded = false;
        this.framesPlayed = 0;
        break;
      
      case 'reset':
        // Reset state but keep same SABs
        this.hasEnded = false;
        this.framesPlayed = 0;
        break;
      
      case 'seek':
        // Seek: reset frame counter (player tracks offset separately)
        this.hasEnded = false;
        this.framesPlayed = 0;
        break;
        
      case 'dispose':
        // Clear all state
        this.isReady = false;
        this.shouldTerminate = true;  // Signal process() to return false
        this.controlBuffer = null;
        this.audioBuffer = null;
        this.ringSize = 0;
        this.channels = 2;
        this.hasEnded = false;
        this.framesPlayed = 0;
        this.startTime = 0;
        // Remove message handler to break any reference cycles
        this.port.onmessage = null;
        break;
    }
  }

  process(inputs, outputs, parameters) {
    // If disposed, return false to terminate processor permanently
    if (this.shouldTerminate) {
      return false;
    }
    
    if (!this.isReady || !this.controlBuffer || !this.audioBuffer) {
      // Output silence
      const output = outputs[0];
      if (output && output[0]) {
        output[0].fill(0);
        if (output[1]) output[1].fill(0);
      }
      return true;
    }

    const output = outputs[0];
    const channel0 = output[0];
    const channel1 = output[1] || output[0];
    const blockSize = channel0.length;

    // Read state atomically
    const state = Atomics.load(this.controlBuffer, CONTROL.STATE);
    
    // Detect transitions and trigger fades
    if (this.lastState !== STATE.PLAYING && state === STATE.PLAYING && !this.isFadingIn) {
      // Starting playback: fade in
      this.isFadingIn = true;
      this.fadeSamplesRemaining = this.defaultFadeSamples;
      this.fadeSamplesTotal = this.defaultFadeSamples;
    } else if (this.lastState === STATE.PLAYING && state !== STATE.PLAYING && !this.isFadingOut) {
      // Stopping playback: fade out
      this.isFadingOut = true;
      this.fadeSamplesRemaining = this.defaultFadeSamples;
      this.fadeSamplesTotal = this.defaultFadeSamples;
    }
    this.lastState = state;
    
    // Stopped or paused: output silence (after fade completes)
    if (state !== STATE.PLAYING && !this.isFadingOut) {
      channel0.fill(0);
      channel1.fill(0);
      this.isFadingIn = false;
      return true;
    }

    // Check scheduled start time
    const startTimeHi = Atomics.load(this.controlBuffer, CONTROL.START_TIME_HI);
    const startTimeLo = Atomics.load(this.controlBuffer, CONTROL.START_TIME_LO);
    // Reconstruct float64 from two int32s
    const startTimeView = new DataView(new ArrayBuffer(8));
    startTimeView.setInt32(0, startTimeHi, true);
    startTimeView.setInt32(4, startTimeLo, true);
    const scheduledStart = startTimeView.getFloat64(0, true);
    
    if (scheduledStart > 0 && currentTime < scheduledStart) {
      // Not yet time to start
      channel0.fill(0);
      channel1.fill(0);
      return true;
    }

    // Read pointers
    const writePtr = Atomics.load(this.controlBuffer, CONTROL.WRITE_PTR);
    const readPtr = Atomics.load(this.controlBuffer, CONTROL.READ_PTR);
    const loopEnabled = Atomics.load(this.controlBuffer, CONTROL.LOOP_ENABLED);
    const totalFrames = Atomics.load(this.controlBuffer, CONTROL.TOTAL_FRAMES);
    
    // Calculate available frames (handle wrap-around)
    let available = writePtr - readPtr;
    if (available < 0) available += this.ringSize;
    
    // Process samples
    let framesRead = 0;
    let localReadPtr = readPtr;
    
    for (let i = 0; i < blockSize; i++) {
      if (framesRead >= available) {
        // Underrun - no data available
        channel0[i] = 0;
        channel1[i] = 0;
        Atomics.add(this.controlBuffer, CONTROL.UNDERRUN_COUNT, 1);
      } else {
        // Read interleaved samples from ring buffer
        const bufferIndex = (localReadPtr % this.ringSize) * this.channels;
        let sampleL = this.audioBuffer[bufferIndex];
        let sampleR = this.audioBuffer[bufferIndex + 1];
        
        // Apply fade in/out (prevents clicks on transitions)
        if (this.isFadingIn) {
          // Fade in: start at 0, ramp up to 1
          const fadeFactor = 1.0 - (this.fadeSamplesRemaining / this.fadeSamplesTotal);
          sampleL *= fadeFactor;
          sampleR *= fadeFactor;
          this.fadeSamplesRemaining--;
          if (this.fadeSamplesRemaining <= 0) {
            this.isFadingIn = false;
          }
        } else if (this.isFadingOut) {
          // Fade out: start at 1, ramp down to 0
          const fadeFactor = this.fadeSamplesRemaining / this.fadeSamplesTotal;
          sampleL *= fadeFactor;
          sampleR *= fadeFactor;
          this.fadeSamplesRemaining--;
          if (this.fadeSamplesRemaining <= 0) {
            this.isFadingOut = false;
          }
        }
        
        channel0[i] = sampleL;
        channel1[i] = sampleR;
        
        localReadPtr++;
        framesRead++;
        this.framesPlayed++;
      }
    }
    
    // Update read pointer atomically
    Atomics.store(this.controlBuffer, CONTROL.READ_PTR, localReadPtr % this.ringSize);
    
    // Check for end of file
    if (!loopEnabled && this.framesPlayed >= totalFrames && !this.hasEnded) {
      this.hasEnded = true;
      this.port.postMessage({ type: 'ended' });
    }
    
    // Send position update periodically (every ~50ms = 2400 frames at 48kHz)
    if (this.framesPlayed % 2400 < blockSize) {
      this.port.postMessage({ 
        type: 'position', 
        frames: this.framesPlayed,
        readPtr: localReadPtr
      });
    }

    return true;
  }
}

registerProcessor('ffmpeg-stream-sab', FFmpegSABProcessor);
