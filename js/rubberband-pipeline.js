'use strict';

class RubberbandPipeline {
    constructor(audioContext, ffmpegDecoder, playerPath, workletPath, rubberbandWorkletPath, threadCount) {
        this.ctx = audioContext;
        this.ffmpegDecoder = ffmpegDecoder;
        this.playerPath = playerPath;
        this.workletPath = workletPath;
        this.rubberbandWorkletPath = rubberbandWorkletPath;
        this.threadCount = threadCount;
        
        this.player = null;
        this.rubberbandNode = null;
        this.gainNode = null;
        
        this.currentPitch = 1.0;
        this.currentTempo = 1.0;
        this.currentVolume = 1.0;
        this.isLoop = false;
        this.isConnected = false;
        this.filePath = null;

        this.options = {
            highQuality: true,
            transients: 'smooth',
            detector: 'soft',
            formantPreserved: false
        };
        
        // Position tracking from rubberband output (not FFmpeg input)
        this._rubberbandOutputFrames = 0;
        this._rubberbandPositionAt = 0;
        this._seekOffset = 0;
        
        // Warmup state
        this._isWarmedUp = false;
        this._targetVolumeAfterWarmup = 1.0;
        
        // Delay first play after file change to let rubberband stabilize (100ms)
        this._needsStartupDelay = true;
        this._playTimeout = null;
        this._isDisposing = false;
        
        this.initialized = false;
    }

    async init() {
        if(this.initialized) return;

        // 1. Create Gain Node (disconnected - will be connected when pipeline is active)
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = this.currentVolume;

        // 2. Load Rubberband Worklet
        try {
            await this.ctx.audioWorklet.addModule(this.rubberbandWorkletPath);
        } catch(e) {
            // Ignore if already registered, otherwise throw
            if(!e.message || !e.message.includes('already been registered')) {
                console.error('Failed to load Rubberband worklet:', e);
                throw e;
            }
        }

        // Reset disposal flag
        this._isDisposing = false;
        
        // 3. Create Rubberband Node
        try {
            this.rubberbandNode = new AudioWorkletNode(this.ctx, 'realtime-pitch-shift-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                processorOptions: { 
                    blockSize: 4096,
                    highQuality: true 
                }
            });

            this.rubberbandNode.connect(this.gainNode);
            
            // Listen for messages from the worklet (position, warmup)
            this.rubberbandNode.port.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    const event = data[0];
                    const payload = data[1];
                    
                    switch (event) {
                        case 'position':
                            // Track rubberband output frames for debug/logging only
                            // We use player's position as ground truth for getCurrentTime
                            this._rubberbandOutputFrames = payload | 0;
                            this._rubberbandPositionAt = this.ctx.currentTime;
                            break;
                        case 'warmed-up':
                            // Ramp volume up now that rubberband is producing real output
                            if (!this._isWarmedUp) {
                                this._isWarmedUp = true;
                                this._rampUpVolume();
                            }
                            break;
                    }
                } catch (err) {
                    console.error('[RubberbandPipeline] Error parsing worklet message:', err);
                }
            };
        } catch(e) {
            console.error('Rubberband node creation failed:', e);
            throw e;
        }

        // 4. Create Player (FFmpeg Source)
        try {
            let FFmpegDecoder = this.ffmpegDecoder;
            if(FFmpegDecoder && FFmpegDecoder.FFmpegDecoder) FFmpegDecoder = FFmpegDecoder.FFmpegDecoder;

            const { FFmpegStreamPlayerSAB } = require(this.playerPath);
            
            if(FFmpegStreamPlayerSAB.setDecoder) FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);

			// Constructor: (audioContext, workletPath, processorName, ringSeconds, threadCount, connectDestination)
			this.player = new FFmpegStreamPlayerSAB(this.ctx, this.workletPath, 'ffmpeg-stream-sab', 2, this.threadCount, false);
            
            await this.player.init();
            this.player.connect(this.rubberbandNode);
        } catch(e) {
            console.error('Player init failed:', e);
            throw e;
        }
        
        this.setPitch(this.currentPitch);
        this.setTempo(this.currentTempo);
        this.setOptions(this.options);
        
        // Prime the kernel with silence to avoid warm-up artifacts on first play
        this.rubberbandNode.port.postMessage(JSON.stringify(['prime', 4]));

        this.initialized = true;
    }

    async open(filePath) {
        if(!this.initialized) await this.init();
        
        // Only recreate worklet if disposed (null)
        // File changes reuse the same worklet to avoid WASM memory leaks
        if (!this.rubberbandNode) {
            await this.recreateWorklet();
        } else if (this.filePath && this.filePath !== filePath) {
            // File changed - reset worklet state instead of recreating
            // The 100ms warmup delay in play() masks any potential audio bleed
            this._resetWorkletState();
        }
        
        this.filePath = filePath;
        
        // Reset position tracking for new file
        this._seekOffset = 0;
        this._rubberbandOutputFrames = 0;
        this._rubberbandPositionAt = 0;
        
        // Cancel any pending play timeout from previous file
        if (this._playTimeout) {
            clearTimeout(this._playTimeout);
            this._playTimeout = null;
        }
        
        // Ensure player is connected to rubberband (player.open() may disconnect internally)
        if (this.player && this.player.gainNode && this.rubberbandNode) {
            try { 
                this.player.gainNode.disconnect(this.rubberbandNode); 
            } catch(e) {}
            try {
                this.player.gainNode.connect(this.rubberbandNode);
            } catch(e) {}
        }
        
        let metadata = null;
        if(this.player) {
            metadata = await this.player.open(filePath);
        } else {
            throw new Error('Rubberband player not initialized');
        }
        this.setPitch(this.currentPitch);
        this.setTempo(this.currentTempo);
        return metadata;
    }

    play() {
        if(!this.player) return;
        if(this._isDisposing) return;
        
        // Brutal fix: delay first play after file change to let rubberband stabilize
        if (this._needsStartupDelay) {
            this._needsStartupDelay = false;
            console.log('[RubberbandPipeline] Delaying playback 100ms for startup stabilization');
            
            // Start muted
            if (this.gainNode) {
                this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
            }
            
            // Delay actual playback
            this._playTimeout = setTimeout(() => {
                this._playTimeout = null;
                if (this._isDisposing) return;
                if (this.player && this.rubberbandNode) {
                    // Tell rubberband to start counting position from 0
                    this.rubberbandNode.port.postMessage(JSON.stringify(['start-counting']));
                    this.player.play();
                }
            }, 100);
            return;
        }
        
        // Start muted - will ramp up when rubberband signals warmup complete
        if (this.gainNode && !this._isWarmedUp) {
            this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
        }
        
        // Tell rubberband to start counting position from 0
        if (this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['start-counting']));
        }
        
        this.player.play();
    }

    pause() {
        if(this.player) this.player.pause();
    }

    async stop(retain = false) {
        if(this.player) await this.player.stop(retain);
    }

    fadeOut() {
        if (!this.gainNode) return Promise.resolve();
        return new Promise(resolve => {
            const now = this.ctx.currentTime;
            const gain = this.gainNode.gain;
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(gain.value, now);
            gain.linearRampToValueAtTime(0, now + 0.012);
            setTimeout(resolve, 12);
        });
    }

    fadeIn() {
        if (!this.gainNode) return Promise.resolve();
        return new Promise(resolve => {
            const now = this.ctx.currentTime;
            const gain = this.gainNode.gain;
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(0, now);
            gain.linearRampToValueAtTime(this.currentVolume || 1.0, now + 0.015);
            setTimeout(resolve, 15);
        });
    }

    seek(time) {
        if(!this.player) return;
        
        // Seek the player first (this updates player's _seekOffset)
        this.player.seek(time);
        
        // Reset our position tracking to match
        this._seekOffset = time;
        this._rubberbandOutputFrames = 0;
        this._rubberbandPositionAt = 0;
        
        // Tell worklet to reset its position counter
        if (this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['seek']));
        }
    }
    
    getCurrentTime() {
        // Use player's position as ground truth - rubberband worklet position
        // can be stale due to async message processing
        
        if (!this.isPlaying) {
            // When paused/stopped, return the seek offset (current position)
            return this._seekOffset;
        }
        
        // Get player's position (this is accurate - comes from SAB worklet)
        const playerTime = this.player ? this.player.getCurrentTime() : 0;
        
        // For looping: wrap around if we exceed duration
        if (this.isLoop && this.duration > 0) {
            return playerTime % this.duration;
        }
        
        return Math.min(playerTime, this.duration);
    }
    
    // Called by engines.js when player signals a loop occurred
    onPlayerLoop() {
        // Reset rubberband position tracking to sync with player's loop
        this._rubberbandOutputFrames = 0;
        this._rubberbandPositionAt = 0;
        // Tell worklet to reset its counter
        if (this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['loop']));
        }
    }

    setLoop(enabled) {
        this.isLoop = enabled;
        if(this.player) this.player.setLoop(enabled);
    }
    
    get volume() { return this.currentVolume; }
    set volume(v) {
        this.currentVolume = v;
        this._targetVolumeAfterWarmup = v;
        // Only set immediately if warmed up, otherwise let _rampUpVolume handle it
        if(this.gainNode && this._isWarmedUp) {
            this.gainNode.gain.setValueAtTime(v, this.ctx.currentTime);
        }
    }

    setPitch(ratio) {
        this.currentPitch = ratio;
        
        // Backlog Workaround:
        // We use FFmpeg playback rate for substantial tempo changes.
        // Source Speed X increases Pitch by X.
        // We compensate by shifting Rubberband Pitch by 1/X.
        
        const speed = this.currentTempo;
        const compensation = 1.0 / speed;
        
        // Final Pitch = Target Pitch * Compensation
        const finalPitch = this.currentPitch * compensation;
        
        if(this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['pitch', finalPitch]));
        }
    }

    setTempo(speed) {
        // speed: 1.0 = Normal, 0.5 = Half Speed, 2.0 = Double Speed.
        this.currentTempo = speed;
        
        // Backlog Workaround: Drive FFmpeg rate directly
        if(this.player) {
            this.player.setPlaybackRateRatio(speed);
        }

        if(this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['tempo', 1.0]));
        }
        
        this.setPitch(this.currentPitch);
    }

    setOptions(opts) {
        if(!opts) return;
        this.options = { ...this.options, ...opts };
        if(this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['options', this.options]));
        }
    }

    setPlaybackRate(semitones) {
        const ratio = Math.pow(2, semitones / 12.0);
        this.setPitch(ratio);
        this.setTempo(ratio);
    }

    reset() {
        this.setPitch(1.0);
        this.setTempo(1.0);
    }

    // Pipeline routing control
    connect(destinationNode = null) {
        if (!this.gainNode) return;
        
        if (destinationNode) {
            // Connect to specific node (e.g., monitoring splitter)
            this.gainNode.connect(destinationNode);
        } else if (!this.isConnected) {
            // Connect to default destination
            this.gainNode.connect(this.ctx.destination);
            this.isConnected = true;
        }
    }

    disconnect(destinationNode = null) {
        if (!this.gainNode) return;
        
        if (destinationNode) {
            // Disconnect from specific node only
            try {
                this.gainNode.disconnect(destinationNode);
            } catch (e) {
                // Ignore if not connected
            }
        } else if (this.isConnected) {
            // Disconnect from all
            try {
                this.gainNode.disconnect();
            } catch (e) {}
            this.isConnected = false;
        }
    }

    get isPlaying() {
        return this.player ? this.player.isPlaying : false;
    }

    get duration() {
        return this.player ? this.player.duration : 0;
    }

    async onEnded(callback) {
        if(this.player) {
            if(typeof this.player.onEnded === 'function') this.player.onEnded(callback);
            else this.player.onEnded = callback;
        }
    }

    _resetWorkletState() {
        // Reset position tracking
        this._seekOffset = 0;
        this._rubberbandOutputFrames = 0;
        this._rubberbandPositionAt = 0;
        
        // Reset warmup state - triggers 100ms delay which masks bleed
        this._isWarmedUp = false;
        this._needsStartupDelay = true;
        
        // Send reset message to worklet to clear internal buffers
        if (this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['reset-file']));
            // Re-prime the kernel for the new file
            this.rubberbandNode.port.postMessage(JSON.stringify(['prime', 4]));
        }
    }

    async disposeWorklet() {
        // Mark as disposing to prevent play() from setting up new timeouts
        this._isDisposing = true;
        
        // Cancel any pending play timeout
        if (this._playTimeout) {
            clearTimeout(this._playTimeout);
            this._playTimeout = null;
        }
        
        if(this.rubberbandNode) {
            // Send close message to processor - this sets running=false 
            // so process() returns false and processor can be GC'd
            try {
                this.rubberbandNode.port.postMessage(JSON.stringify(['close']));
            } catch(e) {}
            
            try {
                this.rubberbandNode.disconnect();
            } catch(e) {
                console.error('[RubberbandPipeline] Error disconnecting worklet:', e);
            }
            
            // Clear port reference
            try {
                this.rubberbandNode.port.onmessage = null;
            } catch(e) {}
            
            // Give worklet time to clean up
            await new Promise(resolve => setTimeout(resolve, 50));
            
            this.rubberbandNode = null;
        }
        
        this._isDisposing = false;
    }

    async recreateWorklet() {
        if(this.rubberbandNode) {
            await this.disposeWorklet();
        }
        
        // Reset disposal flag
        this._isDisposing = false;
        
        // Disconnect player from old routing (it was connected to the now-disposed rubberbandNode)
        if(this.player && this.player.gainNode) {
            try { this.player.gainNode.disconnect(); } catch(e) {}
        }
        
        // Reset warmup state and position tracking
        this._isWarmedUp = false;
        this._rubberbandOutputFrames = 0;
        this._rubberbandPositionAt = 0;
        this._needsStartupDelay = true;
        
        try {
            this.rubberbandNode = new AudioWorkletNode(this.ctx, 'realtime-pitch-shift-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                processorOptions: { 
                    blockSize: 4096,
                    highQuality: this.options.highQuality !== undefined ? this.options.highQuality : true
                }
            });
            
            // Rebuild the full audio chain: player.gainNode → rubberbandNode → this.gainNode
            this.rubberbandNode.connect(this.gainNode);
            
            // Reconnect player output to new rubberband node
            if(this.player && this.player.gainNode) {
                this.player.gainNode.connect(this.rubberbandNode);
            }
            
            // Listen for messages from the worklet
            this.rubberbandNode.port.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    const event = data[0];
                    const payload = data[1];
                    
                    switch (event) {
                        case 'position':
                            this._rubberbandOutputFrames = payload | 0;
                            this._rubberbandPositionAt = this.ctx.currentTime;
                            break;
                        case 'warmed-up':
                            if (!this._isWarmedUp) {
                                this._isWarmedUp = true;
                                this._rampUpVolume();
                            }
                            break;
                    }
                } catch (err) {
                    console.error('[RubberbandPipeline] Error parsing worklet message:', err);
                }
            };
            
            // Reapply current settings
            this.setPitch(this.currentPitch);
            this.setTempo(this.currentTempo);
            this.setOptions(this.options);
            
            // Prime the kernel with silence to avoid warm-up artifacts
            this.rubberbandNode.port.postMessage(JSON.stringify(['prime', 4]));
            

        } catch(e) {
            console.error('[RubberbandPipeline] Failed to recreate rubberband worklet:', e);
            throw e;
        }
    }
    
    _rampUpVolume() {
        if (!this.gainNode) return;
        const now = this.ctx.currentTime;
        const gain = this.gainNode.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(this._targetVolumeAfterWarmup, now + 0.015);
    }

    dispose() {
        // Cancel any pending play timeout
        if (this._playTimeout) {
            clearTimeout(this._playTimeout);
            this._playTimeout = null;
        }
        
        this.stop(false);
        if(this.player) {
            this.player.dispose();
            this.player = null;
        }
        if(this.rubberbandNode) {
            try { this.rubberbandNode.disconnect(); } catch(e) {}
            this.rubberbandNode = null;
        }
        if(this.gainNode) {
            try { this.gainNode.disconnect(); } catch(e) {}
            this.gainNode = null;
        }
        this.isConnected = false;
        this.initialized = false;
        this.filePath = null;
    }
}

module.exports = RubberbandPipeline;
