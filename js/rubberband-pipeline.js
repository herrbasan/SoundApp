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

        this.initialized = false;
        this._disposeTimeout = null;
        this._disposing = false;
    }

    async init() {
        if (this.initialized) return;

        // 1. Create Gain Node (disconnected - will be connected when pipeline is active)
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = this.currentVolume;

        // 2. Load Rubberband Worklet
        try {
            await this.ctx.audioWorklet.addModule(this.rubberbandWorkletPath);
        } catch (e) {
            // Ignore if already registered, otherwise throw
            if (!e.message || !e.message.includes('already been registered')) {
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
        } catch (e) {
            console.error('Rubberband node creation failed:', e);
            throw e;
        }

        // 4. Create Player (FFmpeg Source)
        try {
            let FFmpegDecoder = this.ffmpegDecoder;
            if (FFmpegDecoder && FFmpegDecoder.FFmpegDecoder) FFmpegDecoder = FFmpegDecoder.FFmpegDecoder;

            const { FFmpegStreamPlayerSAB } = require(this.playerPath);

            if (FFmpegStreamPlayerSAB.setDecoder) FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);

            // Constructor: (audioContext, workletPath, processorName, ringSeconds, threadCount, connectDestination)
            this.player = new FFmpegStreamPlayerSAB(this.ctx, this.workletPath, 'ffmpeg-stream-sab', 2, this.threadCount, false);

            await this.player.init();
            this.player.connect(this.rubberbandNode);
        } catch (e) {
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
        console.log('[RubberbandPipeline] open() called, initialized:', this.initialized, 'rubberbandNode:', !!this.rubberbandNode, 'player:', !!this.player, 'filePath:', this.filePath, 'newFile:', filePath);
        
        // Cancel any pending disposal from previous clearAudio
        this.cancelPendingDispose();
        
        if (!this.initialized) {
            console.log('[RubberbandPipeline] Not initialized, calling init()...');
            await this.init();
        }

        // Recreate worklet if:
        // 1. It was disposed (rubberbandNode is null), OR
        // 2. We're changing files (prevents audio bleed from previous track's internal buffers)
        const needsRecreate = !this.rubberbandNode || (this.filePath && this.filePath !== filePath);
        console.log('[RubberbandPipeline] needsRecreate:', needsRecreate, 'rubberbandNode exists:', !!this.rubberbandNode);

        if (needsRecreate) {
            console.log('[RubberbandPipeline] Recreating worklet, reason:', !this.rubberbandNode ? 'disposed' : 'file change');
            await this.recreateWorklet();
        }

        this.filePath = filePath;

        let metadata = null;
        if (this.player) {
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
        if (this.isPlaying) return;
        if (this.player) this.player.play();
    }

    pause() {
        if (this.player) this.player.pause();
    }

    async stop(retain = false) {
        if (this.player) await this.player.stop(retain);
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
        if (this.player) this.player.seek(time);
    }

    getCurrentTime() {
        return this.player ? this.player.getCurrentTime() : 0;
    }

    setLoop(enabled) {
        this.isLoop = enabled;
        if (this.player) this.player.setLoop(enabled);
    }

    get volume() { return this.currentVolume; }
    set volume(v) {
        this.currentVolume = v;
        if (this.gainNode) this.gainNode.gain.setValueAtTime(v, this.ctx.currentTime);
    }

    setPitch(ratio) {
        console.log('[RubberbandPipeline] setPitch called:', ratio, 'currentPitch:', this.currentPitch, 'rubberbandNode:', !!this.rubberbandNode);
        this.currentPitch = ratio;

        // Backlog Workaround:
        // We use FFmpeg playback rate for substantial tempo changes.
        // Source Speed X increases Pitch by X.
        // We compensate by shifting Rubberband Pitch by 1/X.

        const speed = this.currentTempo;
        const compensation = 1.0 / speed;

        // Final Pitch = Target Pitch * Compensation
        const finalPitch = this.currentPitch * compensation;

        if (this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['pitch', finalPitch]));
            console.log('[RubberbandPipeline] Pitch sent to worklet:', finalPitch);
        } else {
            console.warn('[RubberbandPipeline] Cannot set pitch - rubberbandNode is null');
        }
    }

    setTempo(speed) {
        // speed: 1.0 = Normal, 0.5 = Half Speed, 2.0 = Double Speed.
        this.currentTempo = speed;

        // Backlog Workaround: Drive FFmpeg rate directly
        if (this.player) {
            this.player.setPlaybackRateRatio(speed);
        }

        if (this.rubberbandNode) {
            this.rubberbandNode.port.postMessage(JSON.stringify(['tempo', 1.0]));
        }

        this.setPitch(this.currentPitch);
    }

    setOptions(opts) {
        if (!opts) return;
        this.options = { ...this.options, ...opts };
        if (this.rubberbandNode) {
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
    connect(target) {
        if (this.gainNode) {
            const dest = target || this.ctx.destination;
            this.gainNode.connect(dest);
            // Only set isConnected flag when connecting to destination (not for monitoring taps)
            if (!target) {
                this.isConnected = true;
            }
            console.log('RubberbandPipeline connected to:', target ? 'monitoring tap' : 'destination');
        }
    }

    disconnect(target) {
        if (!this.gainNode) return;
        
        if (target) {
            // Disconnect from specific target only
            try { this.gainNode.disconnect(target); } catch (e) {}
            console.log('RubberbandPipeline disconnected from specific target');
        } else {
            // Disconnect from all targets
            try { this.gainNode.disconnect(); } catch (e) {}
            this.isConnected = false;
            console.log('RubberbandPipeline disconnected from all targets');
        }
    }

    /**
     * Wait for worklet to be ready (WASM initialized and processing).
     * Use this before starting playback to avoid audio rush artifacts.
     * @param {number} timeoutMs - Maximum wait time
     * @returns {Promise<boolean>} - True if ready, false on timeout
     */
    async waitForWorkletReady(timeoutMs = 500) {
        if (!this.rubberbandNode) return false;
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                console.warn('[RubberbandPipeline] Worklet ready timeout');
                resolve(false);
            }, timeoutMs);
            
            const messageHandler = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data[0] === 'ready-ack') {
                        clearTimeout(timeout);
                        cleanup();
                        resolve(true);
                    }
                } catch (err) {
                    // Ignore non-JSON messages
                }
            };
            
            const cleanup = () => {
                if (this.rubberbandNode) {
                    this.rubberbandNode.port.onmessage = null;
                }
            };
            
            this.rubberbandNode.port.onmessage = messageHandler;
            this.rubberbandNode.port.postMessage(JSON.stringify(['ready-check']));
        });
    }

    get isPlaying() {
        return this.player ? this.player.isPlaying : false;
    }

    get duration() {
        return this.player ? this.player.duration : 0;
    }

    async onEnded(callback) {
        if (this.player) {
            if (typeof this.player.onEnded === 'function') this.player.onEnded(callback);
            else this.player.onEnded = callback;
        }
    }

    cancelPendingDispose() {
        if (this._disposeTimeout) {
            clearTimeout(this._disposeTimeout);
            this._disposeTimeout = null;
            this._disposing = false;
            console.log('[RubberbandPipeline] Cancelled pending worklet disposal');
        }
    }

    async disposeWorklet() {
        if (this._disposing) return; // Already disposing
        if (!this.rubberbandNode) return;
        
        this._disposing = true;
        
        // Send close message to processor - this sets running=false 
        // so process() returns false and processor can be GC'd
        try {
            this.rubberbandNode.port.postMessage(JSON.stringify(['close']));
        } catch (e) { }

        try {
            this.rubberbandNode.disconnect();
        } catch (e) {
            console.error('[RubberbandPipeline] Error disconnecting worklet:', e);
        }

        // Clear port reference
        try {
            this.rubberbandNode.port.onmessage = null;
        } catch (e) { }

        // Give worklet time to clean up (track timeout so it can be cancelled)
        await new Promise(resolve => {
            this._disposeTimeout = setTimeout(() => {
                this._disposeTimeout = null;
                resolve();
            }, 50);
        });
        
        if (!this._disposing) {
            // Disposal was cancelled
            return;
        }

        this.rubberbandNode = null;
        this._disposing = false;
        // Note: isConnected tracks gainNode→destination, not rubberband state

        console.log('[RubberbandPipeline] Worklet disposed');
    }

    async recreateWorklet() {
        if (this.rubberbandNode) {
            await this.disposeWorklet();
        }

        // Disconnect player from old routing (it was connected to the now-disposed rubberbandNode)
        if (this.player && this.player.gainNode) {
            try { this.player.gainNode.disconnect(); } catch (e) { }
        }

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
            if (this.player && this.player.gainNode) {
                this.player.gainNode.connect(this.rubberbandNode);
            }

            // Reapply current settings
            this.setPitch(this.currentPitch);
            this.setTempo(this.currentTempo);
            this.setOptions(this.options);

            // Prime the kernel with silence to avoid warm-up artifacts
            this.rubberbandNode.port.postMessage(JSON.stringify(['prime', 4]));

            console.log('[RubberbandPipeline] Worklet recreated with pitch:', this.currentPitch, 'tempo:', this.currentTempo);
        } catch (e) {
            console.error('[RubberbandPipeline] Failed to recreate rubberband worklet:', e);
            throw e;
        }
    }

    dispose() {
        console.log('[RubberbandPipeline] Full dispose');
        this.stop(false);
        if (this.player) {
            this.player.dispose();
            this.player = null;
        }
        if (this.rubberbandNode) {
            try { this.rubberbandNode.disconnect(); } catch (e) { }
            this.rubberbandNode = null;
        }
        if (this.gainNode) {
            try { this.gainNode.disconnect(); } catch (e) { }
            this.gainNode = null;
        }
        this.isConnected = false;
        this.initialized = false;
        this.filePath = null;
    }
}

module.exports = RubberbandPipeline;
