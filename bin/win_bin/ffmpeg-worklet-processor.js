/**
 * FFmpeg Stream Processor with Chunk-Based Gapless Looping
 * 
 * This file must be loaded as an AudioWorklet module.
 * 
 * Simple approach:
 * 1. First chunk is stored as "loop chunk"
 * 2. Chunks are queued and played in order
 * 3. Last chunk is marked via EOF message
 * 4. After playing last chunk, immediately play stored loop chunk
 * 5. Continue with incoming chunks (which start from chunk 1)
 */
class FFmpegStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Chunk queue: each item is { samples: Float32Array, isLast: boolean }
    this.chunks = [];
    this.currentChunk = null;
    this.currentChunkIndex = 0;
    this.currentChunkIsLast = false;
    
    // Loop chunk (copy of first chunk)
    this.loopChunk = null;
    this.loopChunkIndex = 0;
    this.playingLoopChunk = false;
    
    // State
    this.loopEnabled = false;
    this.framesPlayed = 0;
    this.hasEnded = false;  // Track if we've already fired the 'ended' event
    this.reachedEOF = false;  // True after playing the last (EOF-marked) chunk

    // Position reporting (time-based; sampleRate is the AudioContext rate)
    this._posEveryFrames = Math.max(256, Math.round(sampleRate * 0.05));
    this._lastPosFrames = 0;
    this._blockCounter = 0;
    this._posEveryBlocks = Math.max(1, Math.round(this._posEveryFrames / 128));
    
    this.port.onmessage = this.onMessage.bind(this);
  }
  
  onMessage(event) {
    switch (event.data.type) {
      case 'chunk':
        // Regular chunk
        this.chunks.push({
          samples: event.data.samples,
          isLast: false
        });
        break;
        
      case 'eof':
        // Mark the last chunk in queue as the final one
        if (this.chunks.length > 0) {
          this.chunks[this.chunks.length - 1].isLast = true;
        } else if (this.currentChunk) {
          // Current chunk is the last
          this.currentChunkIsLast = true;
        }
        break;
        
      case 'loopChunk':
        // Store the first chunk for looping
        this.loopChunk = event.data.samples;
        break;
        
      case 'setLoop':
        this.loopEnabled = event.data.enabled;
        break;
        
      case 'clear':
        this.chunks = [];
        this.currentChunk = null;
        this.currentChunkIndex = 0;
        this.currentChunkIsLast = false;
        this.loopChunkIndex = 0;
        this.playingLoopChunk = false;
        this.hasEnded = false;  // Reset the ended flag on clear
        this.reachedEOF = false;  // Reset EOF flag on clear (e.g., seek)
        break;
        
      case 'resetPosition':
        this.framesPlayed = 0;
        break;
        
      case 'setPosition':
        this.framesPlayed = event.data.frames;
        break;
    }
  }
  
  // Get next chunk from queue
  loadNextChunk() {
    if (this.chunks.length === 0) {
      return false;
    }
    const chunkData = this.chunks.shift();
    this.currentChunk = chunkData.samples;
    this.currentChunkIndex = 0;
    this.currentChunkIsLast = chunkData.isLast;
    return true;
  }
  
  process(inputs, outputs, parameters) {
    this._blockCounter++;
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    
    const channel0 = output[0];
    const channel1 = output[1];
    if (!channel0 || !channel1) return true;
    
    for (let i = 0; i < channel0.length; i++) {
      let left = 0, right = 0;
      let gotSample = false;
      
      if (this.playingLoopChunk) {
        // Playing the stored loop chunk
        if (this.loopChunk && this.loopChunkIndex < this.loopChunk.length) {
          left = this.loopChunk[this.loopChunkIndex];
          right = this.loopChunk[this.loopChunkIndex + 1];
          this.loopChunkIndex += 2;
          gotSample = true;
        }
        
        // Loop chunk finished - switch back to regular chunks
        if (this.loopChunkIndex >= this.loopChunk.length) {
          this.playingLoopChunk = false;
          this.loopChunkIndex = 0;
          // Try to load next regular chunk
          if (!this.currentChunk || this.currentChunkIndex >= this.currentChunk.length) {
            this.loadNextChunk();
          }
        }
      } else {
        // Normal playback from chunk queue
        
        // Need new chunk?
        if (!this.currentChunk || this.currentChunkIndex >= this.currentChunk.length) {
          // Current chunk finished - mark EOF if this was the last chunk
          if (this.currentChunkIsLast) {
            this.reachedEOF = true;
          }

          if (this.currentChunkIsLast && this.loopEnabled && this.loopChunk) {
            // This was the last chunk and looping is on - play loop chunk
            this.playingLoopChunk = true;
            this.loopChunkIndex = 0;
            this.framesPlayed = 0;
            this.currentChunkIsLast = false;
            this.reachedEOF = false;
            
            // Notify main thread
            this.port.postMessage({ type: 'loopStarted' });
            
            // Get sample from loop chunk
            if (this.loopChunk && this.loopChunkIndex < this.loopChunk.length) {
              left = this.loopChunk[this.loopChunkIndex];
              right = this.loopChunk[this.loopChunkIndex + 1];
              this.loopChunkIndex += 2;
              gotSample = true;
            }
          } else {
            // Try to load next chunk from queue
            if (this.loadNextChunk()) {
              left = this.currentChunk[this.currentChunkIndex];
              right = this.currentChunk[this.currentChunkIndex + 1];
              this.currentChunkIndex += 2;
              gotSample = true;
            }
          }
        } else {
          // Continue current chunk
          left = this.currentChunk[this.currentChunkIndex];
          right = this.currentChunk[this.currentChunkIndex + 1];
          this.currentChunkIndex += 2;
          gotSample = true;
        }
      }
      
      channel0[i] = left;
      channel1[i] = right;
      
      if (gotSample) {
        this.framesPlayed++;
      } else if (this.reachedEOF && !this.loopEnabled && !this.hasEnded) {
        // No data, EOF reached, and not looping - we're done (fire only once)
        this.hasEnded = true;
        this.port.postMessage({ type: 'ended' });
      }
    }
    
    // Report position periodically
    // IMPORTANT: also report while outputting silence so the main thread can observe
    // queue depth and refill, otherwise streaming can deadlock after underruns.
    if ((this.framesPlayed - this._lastPosFrames >= this._posEveryFrames) || (this._blockCounter % this._posEveryBlocks === 0)) {
      if (this.framesPlayed > this._lastPosFrames) this._lastPosFrames = this.framesPlayed;
      this.port.postMessage({ 
        type: 'position',
        frames: this.framesPlayed,
        queuedChunks: this.chunks.length
      });
    }
    
    return true;
  }
}

registerProcessor('ffmpeg-stream', FFmpegStreamProcessor);
