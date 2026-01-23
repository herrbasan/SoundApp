'use strict';

const fs = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');

class MIDIController {
	constructor(audioContext, soundfontPath, libfluidsynthPath, outputDeviceId = '') {
		this.ctx = audioContext;
		this.soundfontPath = soundfontPath;
		this.libfluidsynthPath = libfluidsynthPath;
		this.outputDeviceId = outputDeviceId;
		this.synth = null;
		this.initialized = false;
		this.loading = false;
		this.playing = false;
		this.paused = true;
		this.duration = 0;
		this.currentTime = 0;
		this.volume = 1.0;
		this.loop = false;
		this.onEndedCallback = null;
		this.updateInterval = null;
		this.soundFontLoaded = false;
		this.ended = false;
		this.midiCtx = null;
		this.activeCtx = audioContext;
	}

	async ensureFluidSynthLoaded() {
		if(globalThis.__fluidsynthModule && globalThis.__fluidsynthModule.addFunction) return;
		if(globalThis.Module && globalThis.Module.addFunction) {
			globalThis.__fluidsynthModule = globalThis.Module;
			return;
		}
		if(!this.libfluidsynthPath) {
			throw new Error('libfluidsynth path not set');
		}
		if(!globalThis.__fluidsynthLoadingPromise) {
			const scriptUrl = pathToFileURL(this.libfluidsynthPath).toString();
			globalThis.__fluidsynthLoadingPromise = new Promise((resolve, reject) => {
				const existing = document.querySelector('script[data-libfluidsynth="1"]');
				if(existing) {
					existing.addEventListener('load', resolve, { once: true });
					existing.addEventListener('error', reject, { once: true });
					return;
				}
				const script = document.createElement('script');
				script.src = scriptUrl;
				script.async = true;
				script.dataset.libfluidsynth = '1';
				script.addEventListener('load', resolve, { once: true });
				script.addEventListener('error', reject, { once: true });
				document.head.appendChild(script);
			});
		}
		await globalThis.__fluidsynthLoadingPromise;
		if(globalThis.Module && globalThis.Module.addFunction) {
			globalThis.__fluidsynthModule = globalThis.Module;
			return;
		}
		throw new Error('libfluidsynth module failed to load');
	}

	async init() {
		if(this.initialized) return;
		try {
			const JSSynth = require('js-synthesizer');
			await this.ensureFluidSynthLoaded();
			if(typeof JSSynth.Synthesizer.initializeWithFluidSynthModule === 'function' && globalThis.__fluidsynthModule){
				JSSynth.Synthesizer.initializeWithFluidSynthModule(globalThis.__fluidsynthModule);
			}
			if(typeof JSSynth.waitForReady === 'function'){
				await JSSynth.waitForReady();
			}
			
			// Use the standard Synthesizer (not AudioWorklet) for simplicity
			this.synth = new JSSynth.Synthesizer();
			// FluidSynth limits sample-rate; if AudioContext is out of range, use a dedicated MIDI context
			let synthRate = this.ctx.sampleRate;
			if(synthRate < 8000 || synthRate > 96000){
				synthRate = 44100;
				this.midiCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: synthRate });
				this.activeCtx = this.midiCtx;
				if(this.outputDeviceId && typeof this.midiCtx.setSinkId === 'function'){
					try { await this.midiCtx.setSinkId(this.outputDeviceId); } catch(e) {}
				}
			} else {
				this.activeCtx = this.ctx;
			}
			await this.synth.init(synthRate);
			
			// Create gain node for volume control
			this.gainNode = this.activeCtx.createGain();
			this.gainNode.connect(this.activeCtx.destination);
			
			// Connect synthesizer to gain node
			const node = this.synth.createAudioNode(this.activeCtx);
			node.connect(this.gainNode);
			
			console.log('Looking for soundfont at:', this.soundfontPath);
			const soundFontExists = await fs.access(this.soundfontPath).then(() => true).catch(() => false);
			
			if(soundFontExists) {
				const sfontBuf = await fs.readFile(this.soundfontPath);
				const sfontData = new Uint8Array(sfontBuf.buffer, sfontBuf.byteOffset, sfontBuf.byteLength);
				await this.synth.loadSFont(sfontData);
				this.soundFontLoaded = true;
				console.log('SoundFont loaded:', this.soundfontPath);
			} else {
				console.warn('Default soundfont not found at:', this.soundfontPath);
			}
			
			this.initialized = true;
			console.log('MIDI controller initialized at', synthRate, 'Hz');
		} catch(err) {
			console.error('Failed to initialize MIDI controller:', err);
			throw err;
		}
	}

	async loadMIDI(filePath) {
		if(!this.initialized) await this.init();
		
		this.loading = true;
		this.paused = true;
		this.playing = false;
		this.ended = false;
		this.currentTime = 0;
		
		try {
			const midiData = await fs.readFile(filePath);
			await this.synth.addSMFDataToPlayer(new Uint8Array(midiData));
			
			this.synth.waitForPlayerStopped().then(() => {
				if(!this.loop) {
					this.ended = true;
					this.playing = false;
					this.paused = true;
					if(this.onEndedCallback) {
						this.onEndedCallback();
					}
				}
			});
			
			this.loading = false;
			console.log('MIDI file loaded:', filePath);
			return this;
		} catch(err) {
			this.loading = false;
			console.error('Failed to load MIDI file:', err);
			throw err;
		}
	}

	play() {
		if(!this.initialized || this.loading) return;
		
		this.synth.playPlayer();
		this.playing = true;
		this.paused = false;
		this.ended = false;
		
		this.startTimeTracking();
	}

	pause() {
		if(!this.initialized || !this.playing) return;
		
		this.synth.stopPlayer();
		this.playing = false;
		this.paused = true;
		
		this.stopTimeTracking();
	}

	stop() {
		if(!this.initialized) return;
		
		this.synth.stopPlayer();
		this.playing = false;
		this.paused = true;
		this.ended = true;
		this.currentTime = 0;
		
		this.stopTimeTracking();
	}

	seek(seconds) {
		if(!this.initialized) return;
		
		const wasPlaying = this.playing;
		
		this.synth.seekPlayer(Math.floor(seconds * 1000));
		this.currentTime = seconds;
		
		if(wasPlaying) {
			this.play();
		}
	}

	getCurrentTime() {
		if(!this.initialized) return 0;
		
		try {
			this.currentTime = this.synth.retrievePlayerCurrentTick() / 1000;
		} catch(err) {
			// Silently ignore - player might not be ready
		}
		return this.currentTime;
	}

	getDuration() {
		if(!this.initialized) return 0;
		
		try {
			return this.synth.retrievePlayerTotalTick() / 1000;
		} catch(err) {
			return 0;
		}
	}

	setVolume(vol) {
		this.volume = Math.max(0, Math.min(1, vol));
		if(this.gainNode) {
			this.gainNode.gain.value = this.volume;
		}
	}

	setLoop(loop) {
		this.loop = loop;
		if(this.initialized && this.synth) {
			this.synth.setPlayerLoop(loop ? 1 : 0);
		}
	}

	setReverb(roomSize = 0.2, damping = 0.4, width = 0.5, level = 0.9) {
		if(this.initialized && this.synth) {
			this.synth.setReverb(roomSize, damping, width, level);
		}
	}

	setChorus(nr = 3, level = 2.0, speed = 0.3, depth = 8.0, type = 0) {
		if(this.initialized && this.synth) {
			this.synth.setChorus(nr, level, speed, depth, type);
		}
	}

	setPitchOffset(semitones) {
		if(this.initialized && this.synth) {
			// GEN_COARSETUNE = 51
			for(let i=0; i<16; i++) {
				this.synth.setGenerator(i, 51, semitones);
			}
		}
	}

	setPlaybackSpeed(speed) {
		if(this.initialized && this.synth) {
			const JSSynth = require('js-synthesizer');
			// PlayerSetTempoType.Internal = 0. tempo argument is a multiplier.
			this.synth.setPlayerTempo(JSSynth.Constants.PlayerSetTempoType.Internal, speed);
		}
	}

	startTimeTracking() {
		this.stopTimeTracking();
		this.updateInterval = setInterval(() => {
			if(this.playing) {
				this.getCurrentTime();
			}
		}, 100);
	}

	stopTimeTracking() {
		if(this.updateInterval) {
			clearInterval(this.updateInterval);
			this.updateInterval = null;
		}
	}

	dispose() {
		this.stop();
		this.stopTimeTracking();
		
		if(this.synth) {
			try {
				this.synth.close();
			} catch(err) {
				console.error('Error disposing MIDI controller:', err);
			}
		}
		
		this.initialized = false;
		this.synth = null;
		if(this.midiCtx){
			try { this.midiCtx.close(); } catch(e) {}
			this.midiCtx = null;
		}
	}
}

if(typeof module !== 'undefined' && module.exports) {
	module.exports = MIDIController;
}
