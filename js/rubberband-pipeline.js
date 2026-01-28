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

        this.options = {
            highQuality: true,
            transients: 'smooth',
            detector: 'soft',
            formantPreserved: false
        };
        
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

        this.initialized = true;
    }

    async open(filePath) {
        if(!this.initialized) await this.init();
        let metadata = null;
        if(this.player) {
            metadata = await this.player.open(filePath);
        } else {
            console.error('RubberbandPipeline.open: player is null!');
            throw new Error('Rubberband player not initialized');
        }
        this.setPitch(this.currentPitch);
        this.setTempo(this.currentTempo);
        return metadata;
    }

    play() {
        if(this.player) this.player.play();
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
        if(this.player) this.player.seek(time);
    }
    
    getCurrentTime() {
        return this.player ? this.player.getCurrentTime() : 0;
    }

    setLoop(enabled) {
        this.isLoop = enabled;
        if(this.player) this.player.setLoop(enabled);
    }
    
    get volume() { return this.currentVolume; }
    set volume(v) {
        this.currentVolume = v;
        if(this.gainNode) this.gainNode.gain.setValueAtTime(v, this.ctx.currentTime);
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
    connect() {
        if(this.gainNode && !this.isConnected) {
            this.gainNode.connect(this.ctx.destination);
            this.isConnected = true;
            console.log('RubberbandPipeline connected to destination');
        }
    }

    disconnect() {
        if(this.gainNode && this.isConnected) {
            this.gainNode.disconnect();
            this.isConnected = false;
            console.log('RubberbandPipeline disconnected from destination');
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

    dispose() {
        this.stop(false);
        if(this.player) this.player.dispose();
        if(this.rubberbandNode) {
            this.rubberbandNode.disconnect();
            this.rubberbandNode = null;
        }
        if(this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }
        this.initialized = false;
    }
}

module.exports = RubberbandPipeline;
