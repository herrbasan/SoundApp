/*
	MIDI player (AudioWorklet, js-synthesizer)
*/

import { createEnhancedSynthesizer } from './synth-wrapper.js';
import { parseMidiMetadata, generateMetronomeTrack, injectTrack } from './midi_utils.js';

const defaultCfg = {
	context: false,
	runtimeBase: '',
	soundfontUrl: '',
	hookWorkletUrl: '',
	hookName: 'SoundAppMidiHook',
	hookData: null
};

export class MidiPlayer {
	constructor(cfg) {
		this.config = { ...defaultCfg, ...cfg };
		
		// If provided context has sample rate > 96kHz, we need resampling
		const needsResampling = cfg.context && cfg.context.sampleRate > 96000;
		
		if (this.config.context) {
			if (!this.config.context.destination) {
				throw('MidiPlayer: This is not an audio context');
			}
			this.mainContext = this.config.context;
			this.mainDestination = this.mainContext.destination;
			
			// Create 96kHz context for FluidSynth if needed
			if (needsResampling) {
				this.context = new AudioContext({ sampleRate: 96000 });
				this.destination = this.context.destination;
				this.needsResampling = true;
			} else {
				this.context = this.mainContext;
				this.destination = this.mainDestination;
				this.needsResampling = false;
			}
		} else {
			this.context = new AudioContext();
			this.destination = this.context.destination;
			this.mainContext = this.context;
			this.mainDestination = this.destination;
			this.needsResampling = false;
		}

		this.runtimeBase = this.config.runtimeBase || new URL('../../libs/midiplayer/', import.meta.url).toString();
		if (this.runtimeBase && !this.runtimeBase.endsWith('/')) this.runtimeBase += '/';
		this.libfluidsynthMainUrl = new URL('libfluidsynth.js', this.runtimeBase).toString();
		this.libfluidsynthWorkletUrl = this.libfluidsynthMainUrl;
		this.jsSynthMainUrl = new URL('js-synthesizer.js', this.runtimeBase).toString();
		this.jsSynthWorkletUrl = new URL('js-synthesizer.worklet.js', this.runtimeBase).toString();
		this.hookWorkletUrl = this.config.hookWorkletUrl || new URL('./midi.worklet.js', import.meta.url).toString();
		this.soundfontPath = this.config.soundfontPath || '';

		this.synth = null;
		this.audioNode = null;
		this.resampler = null; // MediaStreamAudioDestinationNode for resampling
		this.resamplerSource = null; // MediaStreamAudioSourceNode in main context
		this.gain = this.context.createGain();
		this.gain.gain.value = 1;
		
		// Set up audio routing
		if (this.needsResampling) {
			// Create resampler: 96kHz context -> MediaStream -> main context
			this.resampler = this.context.createMediaStreamDestination();
			this.gain.connect(this.resampler);
			this.resamplerSource = this.mainContext.createMediaStreamSource(this.resampler.stream);
			this.resamplerSource.connect(this.mainDestination);
		} else {
			// Direct connection
			if (this.destination) this.gain.connect(this.destination);
		}

		this.handlers = [];
		this.initialized = false;
		this.loading = false;
		this.playing = false;
		this.paused = true;
		this.ended = false;
		this.loop = false;
		this.currentTime = 0;
		this.pausedAt = 0;
		this.duration = 0;
		this.soundfontLoaded = false;
		this.updateInterval = null;
		this.pitchOffset = 0;
		this.playbackSpeed = 1.0;
		this.ppq = 96; // Default PPQ
		this.tickRate = 1000; // Default ticks per second (fallback)
		
		this.metronomeEnabled = false;
		this.metronomeChannel = 15; // Default to Ch 16
		this.metronomeUseWorklet = true;
		this.metronomeHighUrl = this.config.metronomeHighUrl || new URL('../../bin/metronome/metronome-high.wav', import.meta.url).href;
		this.metronomeLowUrl = this.config.metronomeLowUrl || new URL('../../bin/metronome/metronome-low.wav', import.meta.url).href;
		this.metronomeHighBuffer = null;
		this.metronomeLowBuffer = null;
		this.metronomeWorkletConfigured = false;
		this.metronomeHighGain = (typeof this.config.metronomeHighGain === 'number') ? this.config.metronomeHighGain : 0.7;
		this.metronomeLowGain = (typeof this.config.metronomeLowGain === 'number') ? this.config.metronomeLowGain : 0.4;
		this.timeSignatures = [];
		this.currentMidiBuffer = null; // Cache for reload
	}

	fireEvent(eventName, response) {
		const handlers = this.handlers;
		if (handlers.length) {
			handlers.forEach(function (handler) {
				if (handler.eventName === eventName) {
					handler.handler(response);
				}
			});
		}
	}
	addHandler(eventName, handler) { this.handlers.push({eventName: eventName, handler: handler}); }
	onInitialized(handler) { this.addHandler('onInitialized', handler); }
	onEnded(handler) { this.addHandler('onEnded', handler); }
	onError(handler) { this.addHandler('onError', handler); }
	onMetadata(handler) { this.addHandler('onMetadata', handler); }
	onProgress(handler) { this.addHandler('onProgress', handler); }

	async init() {
		if (this.initialized) return;
		try {
			await this.ensureMainLoaded();
			await this.ensureWorkletLoaded();
			const JSSynth = globalThis.JSSynth;
			if (!JSSynth) throw new Error('JSSynth not available');
			this.synth = createEnhancedSynthesizer();
			
			// Create audio node with higher polyphony
			this.audioNode = this.synth.createAudioNode(this.context, {
				polyphony: 512,  // Double the default (256)
				gain: 1.0
			});
			this.audioNode.connect(this.gain);
			if (this.config.hookName && typeof this.synth.hookPlayerMIDIEventsByName === 'function') {
				try { this.synth.hookPlayerMIDIEventsByName(this.config.hookName, this.config.hookData || {}); } catch(e) {}
			}
			this.initialized = true;
			this.fireEvent('onInitialized');
		} catch (err) {
			this.fireEvent('onError', { type: 'Init', error: err });
			throw err;
		}
	}

	async ensureMainLoaded() {
		if (globalThis.JSSynth && globalThis.JSSynth.AudioWorkletNodeSynthesizer) return;
		if (!globalThis.__soundappMidiMainLoad) {
			globalThis.__soundappMidiMainLoad = (async () => {
				await import(new URL('../../libs/midiplayer/libfluidsynth.js', import.meta.url).href);
				const module = await import(new URL('../../libs/midiplayer/js-synthesizer.js', import.meta.url).href);
				globalThis.JSSynth = module.default;
				if (globalThis.JSSynth && typeof globalThis.JSSynth.waitForReady === 'function') {
					await globalThis.JSSynth.waitForReady();
				}
			})();
		}
		await globalThis.__soundappMidiMainLoad;
		if (!globalThis.JSSynth) throw new Error('Failed to load js-synthesizer');
	}

	async ensureWorkletLoaded() {
		if (this.workletLoaded) return;
		const metronomeWorkletUrl = new URL('./metronome.worklet.js', import.meta.url).href;
		const libfluidsynthWorkletUrl = new URL('../../libs/midiplayer/libfluidsynth.js', import.meta.url).href;
		const jsSynthWorkletUrl = new URL('../../libs/midiplayer/js-synthesizer.worklet.js', import.meta.url).href;
		await this.context.audioWorklet.addModule(metronomeWorkletUrl);
		await this.context.audioWorklet.addModule(libfluidsynthWorkletUrl);
		await this.context.audioWorklet.addModule(jsSynthWorkletUrl);
		if (this.hookWorkletUrl) {
			try { await this.context.audioWorklet.addModule(this.hookWorkletUrl); } catch(e) {}
		}
		this.workletLoaded = true;
	}

	async ensureSoundfontLoaded() {
		// Used to prevent redundant loads, but if soundfontUrl changed, we should reload.
		// For now simple boolean check.
		if (this.soundfontLoaded) return;
		const resp = await fetch(this.soundfontUrl || this.config.soundfontUrl);
		if (!resp.ok) throw new Error('Failed to fetch soundfont');
		const buf = await resp.arrayBuffer();
		const sfontId = await this.synth.loadSFont(buf);
		if (!(sfontId > 0)) throw new Error('Failed to load soundfont');
		this.soundfontId = sfontId;
		this.soundfontLoaded = true;

		// Re-apply pitch and speed settings
		if(this.pitchOffset !== 0) this.setPitchOffset(this.pitchOffset);
		if(this.playbackSpeed !== 1.0 && this.playbackSpeed !== 0) {
			this.setPlaybackSpeed(this.playbackSpeed);
		}
	}
	
	// Method to force reload soundfont (invoked by UI/app)
	async setSoundFont(url) {
		this.soundfontUrl = url;
		this.soundfontLoaded = false;
		
		// If playing, we need to pause, reload SF, reload buffer, seek, resume
		const wasPlaying = this.playing;
		const pos = this.currentTime;
		
		if(wasPlaying) this.pause();
		
		await this.ensureSoundfontLoaded();
		
		// If we have a buffer loaded, we must reload it into the player
		// because loadSFont (often) resets the player state or we need to be safe.
		if (this.currentMidiBuffer) {
			await this.reloadCurrentBuffer();
			// Seek to position
			if (pos > 0) this.seek(pos);
		}
		
		if(wasPlaying) this.play();
	}
	
	async reloadCurrentBuffer() {
		if (!this.currentMidiBuffer) return;
		await this.synth.resetPlayer();
		await this.synth.addSMFDataToPlayer(this.currentMidiBuffer);
		
		// Re-apply metronome state
		this.setMetronome(this.metronomeEnabled);
		this.updateWorkletMetronome({ reset: true });
	}

	async load(url) {
		await this.init();
		this.loading = true;
		this.paused = true;
		this.playing = false;
		this.ended = false;
		this.currentTime = 0;
		try {
			await this.ensureSoundfontLoaded();
			const resp = await fetch(url);
			if (!resp.ok) throw new Error('Failed to fetch MIDI file');
			const buf = await resp.arrayBuffer();
			await this.loadBuffer(buf);
			this.loading = false;
		} catch (err) {
			this.loading = false;
			this.fireEvent('onError', { type: 'Load', error: err });
			throw err;
		}
	}

	async loadBuffer(buf) {
		if (!this.synth) return;
		this.originalBPM = 0;
		// Reset tracking of metronome channel
		this.metronomeChannel = 15; // Default safe
		this.metronomeUseWorklet = true;
		
		if (this.playing) {
			this.synth.stopPlayer();
		}
		await this.synth.resetPlayer();
		
		// Parse Metadata
		const ab = (buf instanceof ArrayBuffer) ? buf : (buf && buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
		const extendedInfo = parseMidiMetadata(ab);
		this.ppq = extendedInfo.ppq || 96;
		this.timeSignatures = extendedInfo.timeSignatures || [];

		// Inject Metronome (fallback)
		let finalBuffer = ab;
		let useWorklet = false;
		if (this.config.metronomeUseWorklet !== false) {
			useWorklet = await this.ensureMetronomeSampleData();
		}
		if (useWorklet) {
			this.metronomeUseWorklet = true;
			this.metronomeChannel = -1;
			this.updateWorkletMetronome({ reset: true });
		} else {
			this.metronomeUseWorklet = false;
			if(this.ppq > 0) {
				console.log(`[MIDI] Generating Metronome. PPQ=${this.ppq} MaxTick=${extendedInfo.maxTick}`);
				const result = generateMetronomeTrack(extendedInfo, this.ppq);
				if(result && result.buffer) {
					console.log(`[MIDI] Metronome Track Size: ${result.buffer.byteLength} bytes on Channel ${result.channel+1}`);
					finalBuffer = injectTrack(ab, result.buffer);
					this.metronomeChannel = result.channel;
				}
			}
		}
		
		// Store for reload
		this.currentMidiBuffer = finalBuffer;

		// Add MIDI data
		await this.synth.addSMFDataToPlayer(finalBuffer);
		
		// Duration Calculation
		let totalTicks = 0;
		try {
			await this.synth.playPlayer();
			for (let i = 0; i < 25; i++) {
				await new Promise(resolve => setTimeout(resolve, 20));
				totalTicks = await this.synth.retrievePlayerTotalTicks();
				if (totalTicks > 0) break;
			}
			this.synth.stopPlayer();
		} catch(e) { console.warn('[MIDI] Failed to determine track duration:', e); }
		
		// BPM Calculation
		if (typeof this.synth.retrievePlayerBpm === 'function') {
			try { this.originalBPM = await this.synth.retrievePlayerBpm(); } 
			catch(e) { this.originalBPM = 120; }
		} else { this.originalBPM = 120; }
		
		// Reset Player for Playback
		await this.synth.resetPlayer();
		
		// FULL RESET: Reset All Controllers (CC) to default values
		// resetPlayer() does this internally for some things, but not always persistently held controls like sustain.
		console.log('[MIDI] Performing System Reset/CC Cleanup...');
		
		let didReset = false;
		if(typeof this.synth.midiSystemReset === 'function') {
			try { await this.synth.midiSystemReset(); didReset = true; } catch(e){ console.warn('[MIDI] midiSystemReset failed:', e); }
		}
		if(!didReset && typeof this.synth.systemReset === 'function') {
			try { await this.synth.systemReset(); didReset = true; } catch(e){ console.warn('[MIDI] systemReset failed:', e); }
		}
		
		// ALWAYS perform manual reset for critical controllers as a safety net
		// Some systemReset implementations might not clear Sustain (CC64) immediately or as expected
		console.log('[MIDI] Executing Safety CC Reset (Sustain, Mod, Pitch)');
		for(let c=0; c<16; c++) {
			const hasCC = typeof this.synth.cc === 'function';
			const hasMidiControl = typeof this.synth.midiControl === 'function';
			
			if(hasCC) {
				this.synth.cc(c, 64, 0); // Sustain Off
				this.synth.cc(c, 1, 0);  // Mod Wheel Off
			} else if (hasMidiControl) {
				this.synth.midiControl(c, 64, 0);
				this.synth.midiControl(c, 1, 0);
			}
			
			if(typeof this.synth.pitchBend === 'function') this.synth.pitchBend(c, 8192); // Center
			else if(typeof this.synth.midiPitchBend === 'function') this.synth.midiPitchBend(c, 8192);
		}

		await this.synth.addSMFDataToPlayer(finalBuffer);

		// Initialize Metronome State
		// Ensure silence at start
		this.setMetronome(this.metronomeEnabled);
		
		this.currentTime = 0;
		const bpm = (this.originalBPM > 0) ? this.originalBPM : 120;
		const ppq = this.ppq || 96; 
		this.tickRate = (bpm * ppq) / 60;
		
		if(totalTicks > 0) {
			this.duration = totalTicks / this.tickRate;
		} else {
			this.duration = 0;
		}

		console.log(`[MIDI] Loaded. Channel=${this.metronomeChannel+1}, Dur=${this.duration}s`);

		this.fireEvent('onMetadata', { 
			duration: this.duration, 
			originalBPM: this.originalBPM,
			...extendedInfo
		});
		
		if (this.loop) {
			try { this.synth.setPlayerLoop(1); } catch(e) {}
		}
	}

	play() {
		if (!this.initialized || this.loading) return;
		if (this.playing && !this.paused) return;
		
		if (this.context && this.context.state === 'suspended') {
			this.context.resume().catch(() => {});
		}
		
		if (this.pausedAt > 0) {
			this.synth.seekPlayer(Math.floor(this.pausedAt * 1000));
			this.pausedAt = 0;
		}
		
		if (this.pitchOffset !== 0 && typeof this.synth.hookPlayerMIDIEventsByName === 'function') {
			this.synth.hookPlayerMIDIEventsByName(this.config.hookName, this.pitchOffset);
		}

		const p = this.synth.playPlayer();
		
		// RE-APPLY METRONOME STATE
		this.setMetronome(this.metronomeEnabled);
		
		if (p && typeof p.catch === 'function') {
			p.catch((e) => console.error('[MIDI] Playback error:', e));
		}
		
		this.synth.waitForPlayerStopped().then(() => {
			if (!this.paused && !this.loop) {
				this.ended = true;
				this.playing = false;
				this.paused = true;
				this.stopTimeTracking();
				this.fireEvent('onEnded');
			}
		});

		this.playing = true;
		this.paused = false;
		this.ended = false;
		this.synth.startTickPolling();
		this.startTimeTracking();
	}

	pause() {
		if (!this.initialized) return;
		if (this.paused && !this.playing) return;
		
		if (this.playing) {
			const ticks = this.synth.getCurrentTickInstant();
			this.pausedAt = (ticks > 0) ? (ticks / 1000) : this.currentTime;
			this.synth.stopPlayer();
			this.synth.stopTickPolling();
			this.stopTimeTracking();
		} else {
			this.pausedAt = this.currentTime;
		}
		this.playing = false;
		this.paused = true;
	}

	stop() {
		if (!this.initialized) return;
		this.synth.stopPlayer();
		this.playing = false;
		this.paused = true;
		this.ended = true;
		this.currentTime = 0;
		this.pausedAt = 0;
		this.synth.stopTickPolling();
		this.stopTimeTracking();
	}

	seek(seconds) {
		if (!this.initialized) return;
		const wasPlaying = this.playing;
		
		const ticks = Math.round(seconds * this.tickRate);
		this.synth.seekPlayer(ticks);
		
		this.currentTime = seconds;
		
		// Re-apply metronome state. 
		// We do this immediately AND after a short delay to ensure it overrides any "chased" events from the seek.
		this.setMetronome(this.metronomeEnabled);
		this.updateWorkletMetronome({ reset: true, resetTick: ticks });
		
		setTimeout(() => {
			if (this.playing || this.paused) {
				this.setMetronome(this.metronomeEnabled);
				this.updateWorkletMetronome({ reset: true, resetTick: ticks });
			}
		}, 50);
		
		if (!wasPlaying && this.playing) {
			this.play();
		}
	}

	getCurrentTime() { return this.currentTime || 0; }
	getDuration() { return this.duration || 0; }
	setVol(val) { this.gain.gain.value = val; }

	setLoop(loop) {
		this.loop = !!loop;
		if (this.initialized && this.synth) {
			this.synth.setPlayerLoop(this.loop ? 1 : 0);
		}
	}

	setPitchOffset(semitones) {
		this.pitchOffset = semitones;
		if (this.initialized && this.synth) {
			if (typeof this.synth.hookPlayerMIDIEventsByName === 'function') {
				this.synth.hookPlayerMIDIEventsByName(this.config.hookName, semitones);
				if(typeof this.synth.midiAllNotesOff === 'function'){
					this.synth.midiAllNotesOff(-1);
				}
			}
		}
	}

	setPlaybackSpeed(speed) {
		this.playbackSpeed = speed;
		if (this.initialized && this.synth) {
			const JSSynth = globalThis.JSSynth || window.JSSynth;
			if (!JSSynth || !JSSynth.Constants) return;

			if (typeof this.synth.setPlayerTempo === 'function') {
				if (speed > 4.0) {
					this.synth.setPlayerTempo(JSSynth.Constants.PlayerSetTempoType.ExternalBpm, speed);
				} else {
					this.synth.setPlayerTempo(JSSynth.Constants.PlayerSetTempoType.Internal, speed);
				}
			}
		}
	}

	resetPlaybackSpeed() {
		this.playbackSpeed = 1.0;
		if (this.initialized && this.synth) {
			const JSSynth = globalThis.JSSynth || window.JSSynth;
			if (!JSSynth || !JSSynth.Constants) return;
			if (typeof this.synth.setPlayerTempo === 'function') {
				this.synth.setPlayerTempo(JSSynth.Constants.PlayerSetTempoType.Internal, 1.0);
			}
		}
	}

	async getCurrentBPM() {
		if (this.initialized && this.synth && typeof this.synth.retrievePlayerBpm === 'function') {
			try { return await this.synth.retrievePlayerBpm(); } 
			catch(e) { return 120; }
		}
		return 120;
	}

	getOriginalBPM() { return this.originalBPM || 120; }

	startTimeTracking() {
		this.stopTimeTracking();
		const token = {};
		this._timeToken = token;
		this._lastTick = 0;
		this._stallCount = 0;
		
		this.updateInterval = setInterval(async () => {
			if (!this.playing) return;
			if (this._timeToken !== token) return;
			
			let ticks = this.synth.getCurrentTickInstant();
			if (ticks === this._lastTick) this._stallCount++;
			else this._stallCount = 0;
			
			if (this._stallCount >= 4 && this.synth && typeof this.synth.retrievePlayerCurrentTick === 'function') {
				try {
					ticks = await Promise.race([
						this.synth.retrievePlayerCurrentTick(),
						new Promise((_, reject) => setTimeout(() => reject('timeout'), 100))
					]);
					this._stallCount = 0;
				} catch(e) {}
			}
			this._lastTick = ticks;
			const t = (ticks > 0 && this.tickRate > 0) ? (ticks / this.tickRate) : 0;
			this.currentTime = t;
			this.fireEvent('onProgress', { pos: t });

			if(this.duration > 0 && t >= this.duration){
				this.stop();
				this.fireEvent('onEnded');
			}
		}, 100);
	}

	stopTimeTracking() {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
			this.updateInterval = null;
		}
		this._timeToken = null;
	}

	dispose() {
		this.stop();
		this.stopTimeTracking();
		if (this.synth) {
			this.synth.stopTickPolling();
			try { this.synth.close(); } catch(e) {}
		}
		this.initialized = false;
		this.synth = null;
	}

	setMetronome(enabled) {
		this.metronomeEnabled = enabled;
		const ch = (typeof this.metronomeChannel === 'number') ? this.metronomeChannel : 15;
		
		console.log(`[MIDI] setMetronome(${enabled}) on Ch ${ch+1}`);

		if(!this.synth) return;
		if (this.metronomeUseWorklet) {
			this.updateWorkletMetronome({ enabled: !!enabled, reset: !!enabled });
			return;
		}

		// We MUST send both Volume (7) and Expression (11)
		// For disabling, we mute. For enabling, we set to 127.
		const val = enabled ? 127 : 0;
		
		// Send multiple times or ensure it goes through? 
		// MIDI messages are small, no harm sending.
		if (typeof this.synth.midiControl === 'function') {
			this.synth.midiControl(ch, 7, val);
			this.synth.midiControl(ch, 11, val);
		} else if (typeof this.synth.cc === 'function') {
			this.synth.cc(ch, 7, val);
			this.synth.cc(ch, 11, val);
		}
	}

	async ensureMetronomeSampleData() {
		if (this.metronomeHighBuffer && this.metronomeLowBuffer) return true;
		if (!this.metronomeHighUrl || !this.metronomeLowUrl) return false;
		try {
			const respH = await fetch(this.metronomeHighUrl);
			const respL = await fetch(this.metronomeLowUrl);
			if (!respH.ok || !respL.ok) return false;
			this.metronomeHighBuffer = await respH.arrayBuffer();
			this.metronomeLowBuffer = await respL.arrayBuffer();
			return !!(this.metronomeHighBuffer && this.metronomeLowBuffer);
		} catch (e) {
			return false;
		}
	}

	updateWorkletMetronome(extra) {
		if (!this.synth || typeof this.synth.callFunction !== 'function') return;
		const param = {
			enabled: !!this.metronomeEnabled,
			ppq: this.ppq || 96,
			timeSignatures: this.timeSignatures || [],
			highGain: this.metronomeHighGain,
			lowGain: this.metronomeLowGain,
			reset: false
		};
		if (extra && typeof extra === 'object') {
			Object.assign(param, extra);
		}
		if (!this.metronomeWorkletConfigured && this.metronomeHighBuffer && this.metronomeLowBuffer) {
			param.highBuffer = this.metronomeHighBuffer;
			param.lowBuffer = this.metronomeLowBuffer;
		}
		try {
			const p = this.synth.callFunction('SoundAppMetronomeConfig', param);
			if (p && typeof p.then === 'function' && param.highBuffer && param.lowBuffer) {
				p.then(() => { this.metronomeWorkletConfigured = true; }).catch(() => {});
			}
		} catch (e) {}
	}
}
