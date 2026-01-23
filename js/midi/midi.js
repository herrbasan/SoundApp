/*
	MIDI player (AudioWorklet, js-synthesizer)
*/

import { createEnhancedSynthesizer } from './synth-wrapper.js';

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
		// No longer need sample rate check - we handle it with resampling
		try {
			await this.ensureMainLoaded();
			await this.ensureWorkletLoaded();
			const JSSynth = globalThis.JSSynth;
			if (!JSSynth) throw new Error('JSSynth not available');
		this.synth = createEnhancedSynthesizer();
		
		// Create audio node with higher polyphony for complex MIDI files
		this.audioNode = this.synth.createAudioNode(this.context, {
			polyphony: 512,  // Double the default (256) to prevent voice stealing
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
				// Use dynamic import instead of script tag injection - works from asar
				// Import libfluidsynth for side effects (initializes Module globally)
				await import(new URL('../../libs/midiplayer/libfluidsynth.js', import.meta.url).href);
				
				// Import JSSynth from the ES6 module
				const module = await import(new URL('../../libs/midiplayer/js-synthesizer.js', import.meta.url).href);
				const JSSynth = module.default;
				
				// Make available globally as expected by other parts
				globalThis.JSSynth = JSSynth;
				
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
		// Use relative URLs from import.meta.url - works from asar
		const libfluidsynthWorkletUrl = new URL('../../libs/midiplayer/libfluidsynth.js', import.meta.url).href;
		const jsSynthWorkletUrl = new URL('../../libs/midiplayer/js-synthesizer.worklet.js', import.meta.url).href;
		await this.context.audioWorklet.addModule(libfluidsynthWorkletUrl);
		await this.context.audioWorklet.addModule(jsSynthWorkletUrl);
		if (this.hookWorkletUrl) {
			try { await this.context.audioWorklet.addModule(this.hookWorkletUrl); } catch(e) {}
		}
		this.workletLoaded = true;
	}

	async ensureSoundfontLoaded() {
		if (this.soundfontLoaded) return;
		const resp = await fetch(this.soundfontUrl || this.config.soundfontUrl);
		if (!resp.ok) throw new Error('Failed to fetch soundfont');
		const buf = await resp.arrayBuffer();
		const sfontId = await this.synth.loadSFont(buf);
		if (!(sfontId > 0)) throw new Error('Failed to load soundfont');
		this.soundfontId = sfontId;
		this.soundfontLoaded = true;

		// Re-apply pitch and speed settings after soundfont reload (as synth might have reset)
		if(this.pitchOffset !== 0) this.setPitchOffset(this.pitchOffset);
		// Speed is usually player-dependent, not soundfont, but good to ensure
		// Check if we have a stored speed > 4.0 (BPM) or multiplier
		if(this.playbackSpeed !== 1.0 && this.playbackSpeed !== 0) {
			this.setPlaybackSpeed(this.playbackSpeed);
		}
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
		// Reset tracking of metronome channel for new file
		this.metronomeChannel = undefined;
		
		// Stop current playback and reset player to clear previous MIDI data
		if (this.playing) {
			this.synth.stopPlayer();
		}
		await this.synth.resetPlayer();
		
		// Parse Metadata first to get PPQ for calculation
		const ab = (buf instanceof ArrayBuffer) ? buf : (buf && buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
		const extendedInfo = this.parseMidiMetadata(ab);

		// Inject Metronome
		let finalBuffer = ab;
		// parseMidiMetadata sets this.ppq
		if(this.ppq > 0) {
			// generateMetronomeTrack returns null if it can't generate, won't throw
			const metronomeTrack = this.generateMetronomeTrack(extendedInfo);
			if(metronomeTrack) {
				finalBuffer = this.injectTrack(ab, metronomeTrack);
			}
		}

		// Add MIDI data
		// If this fails, we want the error to propagate to the UI (onError)
		await this.synth.addSMFDataToPlayer(finalBuffer);
		
		// FluidSynth doesn't parse totalTicks until playback starts
		// So we need to briefly start the player to trigger parsing
		let totalTicks = 0;
		try {
			await this.synth.playPlayer();
			// Wait for totalTicks to become non-zero (max 500ms, increased for first load)
			for (let i = 0; i < 25; i++) {
				await new Promise(resolve => setTimeout(resolve, 20));
				totalTicks = await this.synth.retrievePlayerTotalTicks();
				if (totalTicks > 0) break;
			}
			this.synth.stopPlayer();
		} catch(e) {
			// Non-fatal: just means we won't have duration
			console.warn('[MIDI] Failed to determine track duration:', e);
		}
		
		// Calculate duration
		// Capture original BPM before any playback speed modifications
		if (typeof this.synth.retrievePlayerBpm === 'function') {
			try {
				this.originalBPM = await this.synth.retrievePlayerBpm();
			} catch(e) { 
				console.warn('[MIDI] BPM retrieval failed, defaulting to 120');
				this.originalBPM = 120;
			}
		} else {
			this.originalBPM = 120;
		}
		
		// Now reset to clear "player stopped" state so actual playback can start fresh
		await this.synth.resetPlayer();
		await this.synth.addSMFDataToPlayer(finalBuffer || ab);

		// Strict persistence: Default to OFF for every new file
		// User requirement: "should stay OFF for new files unless explicitly enabled"
		this.metronomeEnabled = false;
		
		// Force default metronome state to OFF every time a new file loads?
		// User said: "default should be off". Persistence is nice but maybe confusing if it auto-enables on next track.
		// "when I play the next midi file the metronome is enabled from the start" -> This implies it persists.
		// Let's force it OFF on every load for now to fix the "unexpected on" behavior.
		// UNLESS we want global persistence? Usually metronome is per-session.
		// But if it's "on from the start", it means `this.metronomeEnabled` is true.
		
		// FIX: The issue is likely that "resetPlayer" resets channel volumes to 100!
		// And our setMetronome call might is happening, but maybe FluidSynth reset is async/laggy?
		// Or maybe the SMF data contains events that reset the volume?
		
		// Let's try to set it explicitly, and maybe add a small delay or hook play start?
		this.setMetronome(this.metronomeEnabled);
		
		this.currentTime = 0;
		
		// Parse standard textual metadata and musical info
		// (Already parsed above, but keeping reference if needed)
		// const extendedInfo = this.parseMidiMetadata(ab);

		// Calculate tick rate (ticks per second) based on PPQ and BPM
		// Rate = (BPM * PPQ) / 60
		// Default to 120 BPM if 0 or unavailable
		const bpm = (this.originalBPM > 0) ? this.originalBPM : 120;
		// PPQ is parsed in parseMidiMetadata
		const ppq = this.ppq || 96; 
		
		// Calculate average tick rate
		// Note: This assumes constant tempo, which is not true for all files,
		// but it provides a consistent linear scale for the seek bar.
		this.tickRate = (bpm * ppq) / 60;
		
		// Calculate duration in seconds using the tick rate
		if(totalTicks > 0) {
			this.duration = totalTicks / this.tickRate;
		} else {
			this.duration = 0;
		}

		console.log(`[MIDI] Duration Calc: Ticks=${totalTicks}, PPQ=${ppq}, BPM=${bpm}, Rate=${this.tickRate}, Dur=${this.duration}s`);

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
		
		// Don't restart if already playing (prevents reset to position 0)
		if (this.playing && !this.paused) return;
		
		if (this.context && this.context.state === 'suspended') {
			this.context.resume().catch(() => {});
		}
		
		// If resuming from pause, seek to paused position first
		if (this.pausedAt > 0) {
			this.synth.seekPlayer(Math.floor(this.pausedAt * 1000));
			this.pausedAt = 0;
		}
		
		// Ensure hook is active (hook is lost on resetPlayer usually, unless persistent?)
		// FluidSynth player reset clears callbacks, so we must re-hook.
		if (this.pitchOffset !== 0 && typeof this.synth.hookPlayerMIDIEventsByName === 'function') {
			this.synth.hookPlayerMIDIEventsByName(this.config.hookName, this.pitchOffset);
		}

		const p = this.synth.playPlayer();
		
		// RE-APPLY METRONOME STATE AFTER PLAY START
		// We moved this after playPlayer() because playPlayer/resetPlayer might reset controllers.
		// Combined with track-level silence (Vol 0 at tick 0), this ensures no initial glitch.
		this.setMetronome(this.metronomeEnabled);
		// If it returns a promise, ensure we catch async errors to avoid UnhandledPromiseRejection,
		// but we still want to log them or fail visibly.
		if (p && typeof p.catch === 'function') {
			p.catch((e) => console.error('[MIDI] Playback error:', e));
		}
		
		// Set up end handler when playback starts
		this.synth.waitForPlayerStopped().then(() => {
			// Only fire onEnded if we're not paused (pause also stops the player)
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
		
		// If already paused, nothing to do
		if (this.paused && !this.playing) return;
		
		// Save current position before stopping (FluidSynth doesn't have pause, only stop which resets position)
		if (this.playing) {
			const ticks = this.synth.getCurrentTickInstant();
			this.pausedAt = (ticks > 0) ? (ticks / 1000) : this.currentTime;
			
			this.synth.stopPlayer();
			
			this.synth.stopTickPolling();
			this.stopTimeTracking();
		} else {
			// Not playing yet, but we want to start in paused state - save current position
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
		
		// Seek directly - FluidSynth supports seeking while playing
		// Convert seconds back to MIDI ticks for the player using simplified Linear Scale
		const ticks = Math.round(seconds * this.tickRate);
		this.synth.seekPlayer(ticks);
		
		this.currentTime = seconds;
		
		// If wasn't playing but is now (from UI update), start playback
		if (!wasPlaying && this.playing) {
			this.play();
		}
	}

	getCurrentTime() {
		return this.currentTime || 0;
	}

	getDuration() {
		return this.duration || 0;
	}

	setVol(val) {
		this.gain.gain.value = val;
	}

	setLoop(loop) {
		this.loop = !!loop;
		if (this.initialized && this.synth) {
			this.synth.setPlayerLoop(this.loop ? 1 : 0);
		}
	}

	setPitchOffset(semitones) {
		this.pitchOffset = semitones;
		if (this.initialized && this.synth) {
			// Hook into MIDI events to shift note values ( cleaner than setGenerator / coarse tune )
			if (typeof this.synth.hookPlayerMIDIEventsByName === 'function') {
				// Pass semitones as the data parameter to the hook
				this.synth.hookPlayerMIDIEventsByName(this.config.hookName, semitones);
				
				// Force all notes off to prevent stuck notes when transposing
				// Send -1 for all channels
				if(typeof this.synth.midiAllNotesOff === 'function'){
					this.synth.midiAllNotesOff(-1);
				} else {
					// Fallback if method wrapper missing on main thread side (worklet message manual send)
					// But we patched worklet. 
					// We need to make sure the main thread 'synth' object has this method.
					// It's a method on the class Synthesizer in the worklet file, but not necessarily exposed 
					// via the proxy object if not defined in the interface/proxy generator.
				}
			}
		}
	}

	setPlaybackSpeed(speed) {
		this.playbackSpeed = speed;
		if (this.initialized && this.synth) {
			
			// Check if using BPM or Multiplier
			// If speed is > 10, assume BPM mode (ExternalBpm)
			// If speed is <= 10, assume Multiplier mode (Internal) [legacy support or low bpm?]
			// User requested 0-200 BPM. 0-10 BPM is edge case.
			// Let's assume > 4.0 is BPM.
			
			const JSSynth = globalThis.JSSynth || window.JSSynth;
			if (!JSSynth || !JSSynth.Constants) return;

			if (typeof this.synth.setPlayerTempo === 'function') {
				if (speed > 4.0) {
					// BPM Mode
					this.synth.setPlayerTempo(JSSynth.Constants.PlayerSetTempoType.ExternalBpm, speed);
				} else {
					// Multiplier Mode (fallback or if user explicitly wants multiplier)
					this.synth.setPlayerTempo(JSSynth.Constants.PlayerSetTempoType.Internal, speed);
				}
			} else {
				console.warn('[MIDI] setPlayerTempo not available on synth');
			}
		}
	}

	resetPlaybackSpeed() {
		this.playbackSpeed = 1.0;
		if (this.initialized && this.synth) {
			const JSSynth = globalThis.JSSynth || window.JSSynth;
			if (!JSSynth || !JSSynth.Constants) return;
			// Reset to internal tempo (file events) with 1.0 multiplier
			if (typeof this.synth.setPlayerTempo === 'function') {
				this.synth.setPlayerTempo(JSSynth.Constants.PlayerSetTempoType.Internal, 1.0);
			}
		}
	}

	async getCurrentBPM() {
		if (this.initialized && this.synth && typeof this.synth.retrievePlayerBpm === 'function') {
			try {
				const bpm = await this.synth.retrievePlayerBpm();
				return bpm;
			} catch(e) {
				console.error('[MIDI] Failed to retrieve BPM:', e);
				return 120;
			}
		}
		return 120;
	}

	getOriginalBPM() {
		return this.originalBPM || 120;
	}

	startTimeTracking() {
		this.stopTimeTracking();
		const token = {};
		this._timeToken = token;
		
		this.updateInterval = setInterval(() => {
			if (!this.playing) return;
			if (this._timeToken !== token) return;
			
			// Instant read from cached tick value (no async, never blocks)
			const ticks = this.synth.getCurrentTickInstant();
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
		// Use dynamically assigned channel (default 15 if not set yet)
		// We use 15 as safe default if generation hasn't run yet
		const ch = (typeof this.metronomeChannel === 'number') ? this.metronomeChannel : 15;
		
		console.log(`[MIDI] setMetronome(${enabled}) on Ch ${ch+1}`);

		if(!this.synth) return;

		if(enabled) {
			// CC 7 = Volume (Set to MAX 127)
			// CC 11 = Expression (Set to MAX 127)
			if (typeof this.synth.midiControl === 'function') {
				this.synth.midiControl(ch, 7, 127);
				this.synth.midiControl(ch, 11, 127);
			} else if (typeof this.synth.cc === 'function') {
				this.synth.cc(ch, 7, 127);
				this.synth.cc(ch, 11, 127);
			}
		} else {
			// MUTE
			if (typeof this.synth.midiControl === 'function') {
				this.synth.midiControl(ch, 7, 0);
				this.synth.midiControl(ch, 11, 0);
			} else if (typeof this.synth.cc === 'function') {
				this.synth.cc(ch, 7, 0);
				this.synth.cc(ch, 11, 0);
			}
		}
	}

	generateMetronomeTrack(info) {
		if(!this.ppq || !info.maxTick) return null;
		
		// Intelligent Channel Selection
		// Prefer 15 (Ch 16). If used, count down.
		// If all used, force 9 (Ch 10 - Drums) as last resort, though muting will be buggy.
		let channel = 15;
		const used = info.channels || new Set();
		// If Set size is 16, we are full.
		if (used.size < 16) {
			// Find highest unused channel
			for (let c = 15; c >= 0; c--) {
				if (!used.has(c)) {
					channel = c;
					break;
				}
			}
		} else {
			// All channels full. We must hijack one.
			// Ch 9 (Drums) is best candidate as we can add percussion.
			channel = 9;
		}
		
		this.metronomeChannel = channel;
		console.log(`[MIDI] Metronome assigned to Channel ${channel + 1}`);

		// SETUP METRONOME SOUNDS
		// If forced to Channel 10 (fallback), use Standard Kit Woodblocks.
		// If independent channel, use Melodic Woodblock (Program 115).
		const isDrumChannel = (channel === 9); // Ch 10 is index 9
		
		let prog, noteAcc, noteBeat;
		
		if (isDrumChannel) {
			// Do NOT send Program Change (keep existing Kit)
			prog = -1; 
			// Standard Kit: 76 (Hi Woodblock), 77 (Low Woodblock)
			noteAcc = 76;
			noteBeat = 77; 
		} else {
			// Melodic: Program 115 is Woodblock
			prog = 115;
			// Pitched up for better cut usage: F6/E6 (89/88).
			noteAcc = 89; 
			noteBeat = 88;
		}

		
		// Helper to write VLQ directly to array
		const writeVLQ = (arr, val) => {
			if (val === 0) { arr.push(0); return; }
			const buffer = [];
			while (val > 0) {
				buffer.push(val & 0x7F);
				val = val >>> 7; // Unsigned shift
			}
			for (let i = buffer.length - 1; i >= 0; i--) {
				arr.push(buffer[i] | (i > 0 ? 0x80 : 0));
			}
		};
		
		const trackBytes = [];
		// MTrk header
		[0x4D, 0x54, 0x72, 0x6B].forEach(b => trackBytes.push(b));
		// Length placeholder (4 bytes)
		[0, 0, 0, 0].forEach(b => trackBytes.push(b));
		
		// INITIALIZE CHANNEL TO SILENT (Fixes "single click" glitch)
		// We insert Volume 0 and Expression 0 at Tick 0. 
		// setMetronome(true) will unmute this, but default state will be silent.
		
		// CC7 Volume 0
		writeVLQ(trackBytes, 0);
		trackBytes.push(0xB0 | channel); 
		trackBytes.push(7); 
		trackBytes.push(0);

		// CC11 Expression 0
		writeVLQ(trackBytes, 0);
		trackBytes.push(0xB0 | channel); 
		trackBytes.push(11); 
		trackBytes.push(0);

		// Set Program Change only if Melodic
		if (prog !== -1) {
			writeVLQ(trackBytes, 0);
			trackBytes.push(0xC0 | channel);
			trackBytes.push(prog);
		} else {
			// No initial event, but we need 0 delta for first note if it starts at 0?
			// The loop below handles deltas.
			// But `lastEventTick` starts at 0.
			// If we skipped the Prog Change, we just start writing notes.
		}

		// Prepare Time Signatures
		const timeSigs = (info.timeSignatures || []).sort((a,b) => a.tick - b.tick);
		if(timeSigs.length === 0 || timeSigs[0].tick > 0) {
			timeSigs.unshift({ tick: 0, n: 4, d: 4 });
		}

		let currentTick = 0;
		let lastEventTick = 0;
		let tsIdx = 0;
		let currentTs = timeSigs[0];
		let nextTs = timeSigs[1];
		
		let bar = 0;
		let beat = 0;
		
		// Iterate until maxTick
		while(currentTick < info.maxTick) {
			// Check for TS change
			if(nextTs && currentTick >= nextTs.tick) {
				currentTs = nextTs;
				tsIdx++;
				nextTs = timeSigs[tsIdx + 1];
				beat = 0; // Reset beat separate on TS change
			}
			
			const isAccent = (beat === 0);
			const note = isAccent ? noteAcc : noteBeat;
			// Accent: Max volume (127), Others: ~60% (76)
			const vel = isAccent ? 127 : 76;

			// Delta Time for Note On
			const deltaOn = currentTick - lastEventTick;
			writeVLQ(trackBytes, deltaOn);
			lastEventTick = currentTick;
			
			// Note On
			trackBytes.push(0x90 | channel);
			trackBytes.push(note);
			trackBytes.push(vel);
			
			// Duration 1/16th note approx
			const dur = Math.max(10, Math.floor(this.ppq / 4));
			const offTick = currentTick + dur;
			
			const deltaOff = offTick - lastEventTick;
			writeVLQ(trackBytes, deltaOff);
			lastEventTick = offTick;
			
			// Note Off
			trackBytes.push(0x80 | channel);
			trackBytes.push(note);
			trackBytes.push(0);
			
			// Advance time
			const ticksPerBeat = (this.ppq * 4) / currentTs.d;
			currentTick += ticksPerBeat;
			
			beat++;
			if(beat >= currentTs.n) {
				beat = 0;
				bar++;
			}
		}
		
		// End of Track
		const deltaEnd = 0;
		writeVLQ(trackBytes, deltaEnd);
		trackBytes.push(0xFF);
		trackBytes.push(0x2F);
		trackBytes.push(0x00);
		
		// Fix Length
		const len = trackBytes.length - 8;
		trackBytes[4] = (len >>> 24) & 0xFF;
		trackBytes[5] = (len >>> 16) & 0xFF;
		trackBytes[6] = (len >>> 8) & 0xFF;
		trackBytes[7] = len & 0xFF;
		
		return new Uint8Array(trackBytes);
	}

	injectTrack(ab, trackBytes) {
		const dv = new DataView(ab);
		if (dv.getUint32(0) !== 0x4D546864) return ab; // MThd

		const newLen = ab.byteLength + trackBytes.byteLength;
		const newBuf = new Uint8Array(newLen);
		newBuf.set(new Uint8Array(ab), 0);
		
		const newDv = new DataView(newBuf.buffer);
		
		// Update Format -> 1 if was 0
		const oldFormat = dv.getUint16(8);
		if (oldFormat === 0) {
			newDv.setUint16(8, 1);
		}
		
		// Increment Track Count
		const ntrks = dv.getUint16(10);
		newDv.setUint16(10, ntrks + 1);
		
		// Append new track
		newBuf.set(trackBytes, ab.byteLength);
		
		return newBuf.buffer;
	}

	_readString(dv, offset, len) {
		let str = '';
		for (let i = 0; i < len; i++) {
			str += String.fromCharCode(dv.getUint8(offset + i));
		}
		return str.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
	}

	parseMidiMetadata(buf) {
		const info = {
			title: '',
			copyright: '',
			timeSignature: '',
			keySignature: '',
			markers: [],
			text: [],
			timeSignatures: [], // Map of { tick, n, d }
			maxTick: 0,
			channels: new Set()
		};
		
		this.ppq = 96; // Reset to default

		try {
			const dv = new DataView(buf);
			let p = 0;

			// Check Header
			if (dv.getUint32(p) !== 0x4D546864) return info; // MThd
			p += 4;
			const headerLen = dv.getUint32(p);
			p += 4;
			const format = dv.getUint16(p); p += 2;
			const ntrks = dv.getUint16(p); p += 2;
			const division = dv.getUint16(p); p += 2;
			
			// Handle PPQ / SMPTE
			let ppq = division;
			if (division & 0x8000) {
				console.warn('[MIDI] SMPTE time division not fully supported, falling back to 96 PPQ');
				ppq = 96;
			}
			this.ppq = ppq;

			// Jump to start of tracks
			p = 14 + (headerLen - 6);
			
			// Iterate all tracks to find metadata and length
			for (let t = 0; t < ntrks; t++) {
				if (p + 4 > dv.byteLength) break;
				
				// Validate Track Header
				if (dv.getUint32(p) !== 0x4D54726B) break; // MTrk
				p += 4;
				const trackLen = dv.getUint32(p);
				p += 4;
				const end = p + trackLen;

				let runningStatus = 0;
				let absTick = 0;
				let tp = p; // Track Pointer

				while (tp < end) {
					// Read VLQ delta-time
					let delta = 0;
					let shift = 0;
					while (true) {
						if (tp >= end) break;
						let b = dv.getUint8(tp++);
						delta = delta | ((b & 0x7F) << shift);
						shift += 7;
						if (!(b & 0x80)) break;
					}
					// Delta parsing above was LSB first? Wait, MIDI VLQ is MSB first (big endian style 7-bit blocks)
					// Correction:
					// Variable-length quantities are big-endian. 
					// Re-implementing correctly below inside loop to avoid bugs.
				}
				
				// Reset and re-loop per track correctly
				tp = p;
				runningStatus = 0;
				absTick = 0;

				while (tp < end) {
					// Read VLQ delta-time (Big Endian)
					let delta = 0;
					let b = dv.getUint8(tp++);
					delta = b & 0x7F;
					while (b & 0x80) {
						if (tp >= end) break;
						b = dv.getUint8(tp++);
						delta = (delta << 7) | (b & 0x7F);
					}
					absTick += delta;
					if (absTick > info.maxTick) info.maxTick = absTick;

					if (tp >= end) break;

					// Read Status
					let status = dv.getUint8(tp);
					if (status < 0x80) {
						status = runningStatus;
					} else {
						tp++;
						if (status < 0xF0) runningStatus = status;
					}

					if (status >= 0x80 && status < 0xF0) {
						// Channel Message
						const type = status & 0xF0;
						const ch = status & 0x0F;
						info.channels.add(ch);

						if (type === 0xC0 || type === 0xD0) { tp += 1; }
						else { tp += 2; }
					} else if (status === 0xF0 || status === 0xF7) {
						// Sysex
						let len = 0;
						let b = dv.getUint8(tp++);
						len = b & 0x7F;
						while (b & 0x80) {
							if (tp >= end) break;
							b = dv.getUint8(tp++);
							len = (len << 7) | (b & 0x7F);
						}
						tp += len;
					} else if (status === 0xFF) {
						// Meta Event
						const type = dv.getUint8(tp++);
						
						let len = 0;
						let b = dv.getUint8(tp++);
						len = b & 0x7F;
						while (b & 0x80) {
							if (tp >= end) break;
							b = dv.getUint8(tp++);
							len = (len << 7) | (b & 0x7F);
						}

						if (tp + len <= end) {
							if (type === 0x03 && !info.title) {
								info.title = this._readString(dv, tp, len);
							} else if (type === 0x02 && !info.copyright) {
								info.copyright = this._readString(dv, tp, len);
							} else if (type === 0x01) {
								const t = this._readString(dv, tp, len);
								if(t && info.text.length < 5) info.text.push(t);
							} else if (type === 0x58) {
								const nn = dv.getUint8(tp);
								const dd = Math.pow(2, dv.getUint8(tp + 1));
								if(!info.timeSignature) info.timeSignature = `${nn}/${dd}`;
								info.timeSignatures.push({ tick: absTick, n: nn, d: dd });
							} else if (type === 0x59 && !info.keySignature) {
								const sf = dv.getInt8(tp);
								const mi = dv.getUint8(tp + 1);
								const keys = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
								const idx = sf + 7;
								if (idx >= 0 && idx < keys.length) {
									info.keySignature = keys[idx] + (mi ? 'm' : '');
								}
							} else if (type === 0x06) {
								info.markers.push(this._readString(dv, tp, len));
							}
						}
						tp += len;
					}
				}
				
				// Advance to next track
				p = end;
			}
			
		} catch(e) {
			console.error('Incomplete MIDI metadata parse:', e);
		}

		return info;
	}
}
