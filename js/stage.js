'use strict';

const { ipcRenderer, webUtils } = require( "electron" );
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const app = helper.app;
const os = require('node:os');
const registry = require('../js/registry.js');
const shortcuts = require('../js/shortcuts.js');

let player;
let midi;
let g = {};
g.test = {};
g.audioContext = null;
g.ffmpegPlayer = null;
g.windows = { help: null, settings: null, playlist: null, mixer: null, pitchtime: null, 'midi': null };
g.windowsVisible = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false };
g.windowsClosing = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false };
g.lastNavTime = 0;
g.mixerPlaying = false;
g.music = [];
g.idx = 0;
g.max = -1;

g.midiSettings = { pitch: 0, speed: null }; // Ephemeral MIDI settings (not saved to config)

// Init
// ###########################################################################

async function detectMaxSampleRate(){
	const rates = [192000, 176400, 96000, 88200, 48000, 44100];
	for(let i=0; i<rates.length; i++){
		const ctx = new AudioContext({ sampleRate: rates[i] });
		console.log('Testing rate:', rates[i], '-> Got:', ctx.sampleRate);
		if(ctx.sampleRate === rates[i]){
			await ctx.close();
			console.log('Max rate detected:', rates[i]);
			return rates[i];
		}
		await ctx.close();
	}
	console.log('Fallback to 44100');
	return 44100;
}

init();
async function init(){
	fb('Init Stage')
	g.win = helper.window;
	g.main_env = await helper.global.get('main_env');
	g.basePath = await helper.global.get('base_path');
	g.isPackaged = await helper.global.get('isPackaged');
	g.cache_path = await helper.global.get('temp_path');
	g.start_vars = await helper.global.get('start_vars');
	g.app_path = await helper.app.getAppPath();

	g.configName = g.main_env.configName || 'user';
	g.config_obj = await helper.config.initRenderer(g.configName, async (newData) => {
		const oldConfig = g.config || {};
		const oldBuffer = (oldConfig && oldConfig.ffmpeg && oldConfig.ffmpeg.stream) ? oldConfig.ffmpeg.stream.prebufferChunks : undefined;
		const oldThreads = (oldConfig && oldConfig.ffmpeg && oldConfig.ffmpeg.decoder) ? oldConfig.ffmpeg.decoder.threads : undefined;
		g.config = newData || {};

		const oldTheme = (oldConfig && oldConfig.ui) ? oldConfig.ui.theme : undefined;
		const theme = (g.config && g.config.ui) ? g.config.ui.theme : 'dark';
		const oldDeviceId = (oldConfig && oldConfig.audio && oldConfig.audio.output) ? oldConfig.audio.output.deviceId : undefined;
		const deviceId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
		const oldHq = !!(oldConfig && oldConfig.audio ? oldConfig.audio.hqMode : false);
		const hq = !!(g.config && g.config.audio ? g.config.audio.hqMode : false);
		const oldStereoSep = (oldConfig && oldConfig.tracker) ? oldConfig.tracker.stereoSeparation : undefined;
		const stereoSep = (g.config && g.config.tracker) ? g.config.tracker.stereoSeparation : undefined;
		const oldInterp = (oldConfig && oldConfig.tracker) ? oldConfig.tracker.interpolationFilter : undefined;
		const interp = (g.config && g.config.tracker) ? g.config.tracker.interpolationFilter : undefined;

		if(oldTheme !== theme){
			if(theme === 'dark'){
				document.body.classList.add('dark');
			}
			else {
				document.body.classList.remove('dark');
			}
			tools.sendToMain('command', { command: 'set-theme', theme: theme });
		}

		if(oldDeviceId !== deviceId){
			if(g.audioContext && typeof g.audioContext.setSinkId === 'function'){
				try {
					if(deviceId){
						await g.audioContext.setSinkId(deviceId);
						console.log('Output device changed to:', deviceId);
					}
					else {
						await g.audioContext.setSinkId('');
						console.log('Output device reset to system default');
					}
				} catch(err) {
					console.error('Failed to set output device:', err);
					if(g.config && g.config.audio && g.config.audio.output){
						g.config.audio.output.deviceId = '';
					}
					g.config_obj.set(g.config);
					if(g.windows.settings) {
						tools.sendToId(g.windows.settings, 'device-change-failed', { error: 'Device not available, using system default' });
					}
				}
			}
		}

		if(oldHq !== hq){
			await toggleHQMode(hq, true);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'sample-rate-updated', { currentSampleRate: g.audioContext?.sampleRate });
			}
			if (g.windows.mixer) {
				tools.sendToId(g.windows.mixer, 'sample-rate-updated', { currentSampleRate: g.audioContext?.sampleRate, maxSampleRate: g.maxSampleRate });
			}
		}


		if(oldStereoSep !== stereoSep){
			if(player && g.currentAudio?.isMod){
				player.setStereoSeparation(stereoSep);
			}
		}
		if(oldInterp !== interp){
			if(player && g.currentAudio?.isMod){
				player.setInterpolationFilter(interp);
			}
		}

		const oldShowControls = (oldConfig && oldConfig.ui) ? !!oldConfig.ui.showControls : false;
		const showControls = (g.config && g.config.ui) ? !!g.config.ui.showControls : false;
		if(oldShowControls !== showControls){
			applyShowControls(showControls, true);
		}

		// If streaming settings changed, perform a clean reset of the player
		const newBuffer = (g.config && g.config.ffmpeg && g.config.ffmpeg.stream) ? g.config.ffmpeg.stream.prebufferChunks : undefined;
		const newThreads = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder) ? g.config.ffmpeg.decoder.threads : undefined;
		if (g.ffmpegPlayer && (oldBuffer !== newBuffer || oldThreads !== newThreads)) {
			if (g.currentAudio && g.currentAudio.isFFmpeg) {
				console.log('Streaming settings changed, resetting player...');
				const pos = g.ffmpegPlayer.getCurrentTime();
				const wasPlaying = g.ffmpegPlayer.isPlaying;
				
				g.ffmpegPlayer.prebufferSize = (newBuffer !== undefined) ? (newBuffer | 0) : 10;
				g.ffmpegPlayer.threadCount = (newThreads !== undefined) ? (newThreads | 0) : 0;
				
				try {
					await g.ffmpegPlayer.open(g.currentAudio.fp);
					if (pos > 0) g.ffmpegPlayer.seek(pos);
					if (wasPlaying) await g.ffmpegPlayer.play();
				} catch (err) {
					console.error('Failed to reset player after config change:', err);
				}
			} else {
				// Just update parameters for next load
				g.ffmpegPlayer.prebufferSize = (newBuffer !== undefined) ? (newBuffer | 0) : 10;
				g.ffmpegPlayer.threadCount = (newThreads !== undefined) ? (newThreads | 0) : 0;
			}
		}
	});
	g.config = g.config_obj.get();
	let saveCnf = false;
	if(!g.config || typeof g.config !== 'object') g.config = {};
	if(!g.config.windows) g.config.windows = {};
	if(!g.config.windows.main) g.config.windows.main = {};
	let s = (g.config.windows.main.scale !== undefined) ? (g.config.windows.main.scale | 0) : 14;
	if(s < 14) { s = 14; saveCnf = true; }
	if((g.config.windows.main.scale|0) !== s) { g.config.windows.main.scale = s; saveCnf = true; }
	if(saveCnf) { g.config_obj.set(g.config); }

	// Apply theme at startup
	const theme0 = (g.config && g.config.ui) ? g.config.ui.theme : 'dark';
	if(theme0 === 'dark') {
		document.body.classList.add('dark');
	} else {
		document.body.classList.remove('dark');
	}
	// Send initial theme to main process
	tools.sendToMain('command', { command: 'set-theme', theme: theme0 });

	// Apply showControls at startup
	const showControls0 = (g.config && g.config.ui && g.config.ui.showControls) ? true : false;
	applyShowControls(showControls0);
	
	ut.setCssVar('--space-base', s);

	// Window bounds restoration
	let b = (g.config.windows && g.config.windows.main && g.config.windows.main.width && g.config.windows.main.height) ? g.config.windows.main : null;
	if(b){
		const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
		const baseMinH = showControls0 ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
		const scale0 = _getMainScale();
		const minW = _scaledDim(MIN_WIDTH, scale0);
		const minH = _scaledDim(baseMinH, scale0);
		const nb = { width: b.width|0, height: b.height|0 };
		if(b.x !== undefined && b.x !== null) nb.x = b.x|0;
		if(b.y !== undefined && b.y !== null) nb.y = b.y|0;
		if(nb.width < minW) nb.width = minW;
		if(nb.height < minH) nb.height = minH;
		await g.win.setBounds(nb);
		g.config.windows.main = { ...g.config.windows.main, x: nb.x, y: nb.y, width: nb.width, height: nb.height, scale: s|0 };
	}
	// Small delay to allow first paint before showing - workaround for white flash
	//await new Promise(r => setTimeout(r, 5));
	await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
	g.win.show();
	//g.win.transparent
	if(!g.isPackaged) { g.win.toggleDevTools() }
	
	let fp = g.app_path;
	if(g.isPackaged){fp = path.dirname(fp);}

	if(os.platform() == 'linux'){
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/linux_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/linux_bin/player-sab.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-sab.js');
		g.ffmpeg_player_pm_path = path.resolve(fp + '/bin/linux_bin/player-pm.js');
		g.ffmpeg_worklet_pm_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-pm.js');
		g.ffmpeg_player_sab_path = path.resolve(fp + '/bin/linux_bin/player-sab.js');
		g.ffmpeg_worklet_sab_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-sab.js');
		g.rubberband_worklet_path = path.resolve(fp + '/node_modules/rubberband-web/public/rubberband-processor.js');
	}
	else {
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/win_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/win_bin/player-sab.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-sab.js');
		g.ffmpeg_player_pm_path = path.resolve(fp + '/bin/win_bin/player-pm.js');
		g.ffmpeg_worklet_pm_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-pm.js');
		g.ffmpeg_player_sab_path = path.resolve(fp + '/bin/win_bin/player-sab.js');
		g.ffmpeg_worklet_sab_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-sab.js');
		g.rubberband_worklet_path = path.resolve(fp + '/node_modules/rubberband-web/public/rubberband-processor.js');
	}

	/* Detect max supported sample rate for HQ mode */
	g.maxSampleRate = await detectMaxSampleRate();
	console.log('Max supported sample rate:', g.maxSampleRate);
	
	/*
		Init Web Audio Context
		NOTE:
		- FFmpeg AudioWorklet streaming requires the decoded PCM rate to match the AudioContext rate.
		- The native decoder must therefore be configured to output at exactly audioContext.sampleRate.
		- HQ mode selects a higher AudioContext rate (up to device max).
	*/
	const targetRate = (g.config && g.config.audio && g.config.audio.hqMode) ? g.maxSampleRate : 44100;
	g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });
	console.log('AudioContext sample rate:', g.audioContext.sampleRate);
	
	/* Apply saved output device if configured */
	const outDevId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
	if (outDevId) {
		try {
			await g.audioContext.setSinkId(outDevId);
			console.log('Output device set to:', outDevId);
		} catch (err) {
			console.error('Failed to set output device, using system default:', err);
			if(g.config && g.config.audio && g.config.audio.output) g.config.audio.output.deviceId = '';
			g.config_obj.set(g.config);
		}
	}

	/* FFmpeg NAPI Player - unified streaming with gapless looping (SAB-based) */
	const { FFmpegDecoder, getMetadata } = require(g.ffmpeg_napi_path);
	g.getMetadata = getMetadata;
	g.FFmpegDecoder = FFmpegDecoder;  // Expose for testing
	
	const { FFmpegStreamPlayerSAB } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);
	const bufferSize = (g.config && g.config.ffmpeg && g.config.ffmpeg.stream && g.config.ffmpeg.stream.prebufferChunks !== undefined) ? (g.config.ffmpeg.stream.prebufferChunks | 0) : 10;
	const threadCount = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder && g.config.ffmpeg.decoder.threads !== undefined) ? (g.config.ffmpeg.decoder.threads | 0) : 0;
	g.ffmpegPlayer = new FFmpegStreamPlayerSAB(g.audioContext, g.ffmpeg_worklet_path, bufferSize, threadCount);
	// Reduce AudioWorkletNode churn when switching tracks / reopening files.
	try { g.ffmpegPlayer.reuseWorkletNode = true; } catch(e) {}
	try {
		await g.ffmpegPlayer.init();
	} catch (err) {
		console.error('Failed to initialize FFmpeg player:', err);
	}

	/* Mod Player */
	const modConfig = {
		repeatCount: 0,
		stereoSeparation: (g.config && g.config.tracker && g.config.tracker.stereoSeparation !== undefined) ? (g.config.tracker.stereoSeparation | 0) : 100,
		interpolationFilter: (g.config && g.config.tracker && g.config.tracker.interpolationFilter !== undefined) ? (g.config.tracker.interpolationFilter | 0) : 0,
		context: g.audioContext
	};
	player = new window.chiptune(modConfig);
	player.onMetadata(async (meta) => {
		if(g.currentAudio){
			g.currentAudio.duration = player.duration;
			g.playremain.innerText = ut.playTime(g.currentAudio.duration*1000).minsec;
			await renderInfo(g.currentAudio.fp, meta);
			//console.log('Operation took: ' + Math.round((performance.now() - g.currentAudio.bench)) );
		}
		g.blocky = false;
	});
	player.onProgress((e) => {
		if(g.currentAudio){
			g.currentAudio.currentTime = e.pos || 0;
		}
	});
	player.onEnded(audioEnded);
	player.onError((err) => { console.log(err); audioEnded(); g.blocky = false;});
	player.onInitialized(() => {
		console.log('Player Initialized');
		player.gain.connect(g.audioContext.destination);
		g.blocky = false;
		appStart();
	});

	await initMidiPlayer();

	ipcRenderer.on('main', async (e, data) => {
		if(data.length == 1){
			await playListFromSingle(data[0], false);
		}
		else {
			await playListFromMulti(data, false, false);
		}
		playAudio(g.music[g.idx], 0, false);
		g.win.focus();
	})
	console.log(g.main_env)
	ipcRenderer.on('log', (e, data) => {
		console.log('%c' + data.context, 'color:#6058d6', data.data);
	});
	
	ipcRenderer.on('window-closed', (e, data) => {
		if (g.windows[data.type] === data.windowId) {
			g.windows[data.type] = null;
			g.windowsVisible[data.type] = false;
			
			// Reset MIDI settings if MIDI window closes
			if(data.type === 'midi'){
				g.midiSettings = { pitch: 0, speed: null };
				if(midi){
					if(midi.setPitchOffset) midi.setPitchOffset(0);
					if(midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
					if(midi.setMetronome) midi.setMetronome(false); // Reset metronome
				}
			}
		}
		if(g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;
		// Return focus to stage window after small delay to ensure window is gone
		setTimeout(() => g.win.focus(), 50);
	});

	ipcRenderer.on('window-hidden', (e, data) => {
		g.windowsVisible[data.type] = false;
		if(g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;
		
		// Reset MIDI settings if MIDI window is hidden
		if(data.type === 'midi'){
			g.midiSettings = { pitch: 0, speed: null };
			if(midi){
				if(midi.setPitchOffset) midi.setPitchOffset(0);
				if(midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
				if(midi.setMetronome) midi.setMetronome(false); // Reset metronome
			}
		}

		g.win.focus();
	});
	
	ipcRenderer.on('browse-directory', async (e, data) => {
		const result = await helper.dialog.showOpenDialog({
			properties: ['openDirectory']
		});
		if (!result.canceled && result.filePaths.length > 0) {
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'directory-selected', result.filePaths[0]);
			}
		}
	});

	ipcRenderer.on('register-file-types', async (e, data) => {
		try {
			const registry = require('./registry.js');
			const path = require('path');
			let exe_path = process.execPath;
			if (g.isPackaged) {
				exe_path = path.resolve(path.dirname(exe_path), '..', path.basename(exe_path));
			}
			await registry('register', exe_path, g.app_path);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: true });
			}
		} catch (err) {
			console.error('Failed to register file types:', err);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: false, error: err.message });
			}
		}
	});

	ipcRenderer.on('unregister-file-types', async (e, data) => {
		try {
			const registry = require('./registry.js');
			const path = require('path');
			let exe_path = process.execPath;
			if (g.isPackaged) {
				exe_path = path.resolve(path.dirname(exe_path), '..', path.basename(exe_path));
			}
			await registry('unregister', exe_path, g.app_path);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: true });
			}
		} catch (err) {
			console.error('Failed to unregister file types:', err);
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'registry-action-complete', { success: false, error: err.message });
			}
		}
	});

	ipcRenderer.on('open-default-programs', (e, data) => {
		const { openDefaultProgramsUI } = require('./registry.js');
		openDefaultProgramsUI();
	});
	
	ipcRenderer.on('shortcut', (e, data) => {
		if (data.action === 'toggle-help') {
			openWindow('help');
		}
		else if (data.action === 'toggle-settings') {
			openWindow('settings');
		}
		else if (data.action === 'toggle-mixer') {
			const fp = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : ((g.music && g.music[g.idx]) ? g.music[g.idx] : null);
			// Keep the main player loaded; just pause while the mixer runs independently.
			if(g.currentAudio && !g.currentAudio.paused){
				g.currentAudio.pause();
				checkState();
			}
			openWindow('mixer', false, fp);
		}
		else if (data.action === 'toggle-pitchtime') {
			// Open MIDI settings for MIDI files, pitch/time for others
			const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
			if (currentFile) {
				const ext = path.extname(currentFile).toLowerCase();
				if (g.supportedMIDI && g.supportedMIDI.includes(ext)) {
					openWindow('midi');
				} else {
					openWindow('pitchtime');
				}
			} else {
				openWindow('pitchtime');
			}
		}
		else if (data.action === 'toggle-theme') {
			tools.sendToMain('command', { command: 'toggle-theme' });
		}
	});

	ipcRenderer.on('theme-changed', (e, data) => {
		if (data.dark) {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
		// Save theme preference to config (stage window is responsible for persistence)
		if(!g.config.ui) g.config.ui = {};
		g.config.ui.theme = data.dark ? 'dark' : 'light';
		g.config_obj.set(g.config);
		
		// Broadcast to all open windows
	});

	ipcRenderer.on('open-soundfonts-folder', () => {
		const fp = g.app_path;
		const baseDir = g.isPackaged ? path.dirname(fp) : fp;
		const soundfontPath = path.resolve(baseDir + '/bin/soundfonts/');
		helper.shell.showItemInFolder(soundfontPath + '/README.md'); 
	});

	ipcRenderer.on('midi-soundfont-changed', async (e, soundfontFile) => {
		// Reload MIDI player with new soundfont and restore playback state
		const wasPlaying = g.currentAudio && !g.currentAudio.paused;
		const currentFile = g.currentAudio ? g.currentAudio.fp : null;
		const currentTime = g.currentAudio ? g.currentAudio.getCurrentTime() : 0;
		const currentLoop = g.isLoop;
		const isMIDI = currentFile && g.supportedMIDI && g.supportedMIDI.includes(path.extname(currentFile).toLowerCase());
		
		// Dispose old MIDI player
		if (midi) {
			midi.dispose();
			midi = null;
		}
		
		// Reinitialize MIDI player with new soundfont
		await initMidiPlayer();
		
		// Reload current MIDI file if one was loaded
		if (isMIDI && currentFile) {
			try {
				// Load the file with startPaused flag to prevent auto-play
				await playAudio(currentFile, currentTime, !wasPlaying);
				
				// Wait for player to be fully initialized
				await new Promise(resolve => setTimeout(resolve, 100));
				
				if (g.currentAudio && wasPlaying) {
					// Start playing if it was playing before
					g.currentAudio.play();
				}
				
				checkState();
			} catch(err) {
				console.error('Failed to reload MIDI file after soundfont change:', err);
			}
		}
	});

	ipcRenderer.on('midi-metronome-toggle', (e, enabled) => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.metronome = enabled;
		if (midi && midi.setMetronome) {
			midi.setMetronome(enabled);
		}
	});

	ipcRenderer.on('midi-pitch-changed', (e, val) => {
		// Update ephemeral settings only
		if(g.midiSettings) g.midiSettings.pitch = val;
		if (midi && midi.setPitchOffset) {
			midi.setPitchOffset(val);
		}
	});

	ipcRenderer.on('midi-speed-changed', (e, val) => {
		// Update ephemeral settings only
		if(g.midiSettings) g.midiSettings.speed = val;
		if (midi && midi.setPlaybackSpeed) {
			midi.setPlaybackSpeed(val);
		}
	});

	ipcRenderer.on('get-available-soundfonts', async (e, data) => {
		// Scan bin/soundfonts directory for .sf2 and .sf3 files
		let fp = g.app_path;
		if(g.isPackaged){fp = path.dirname(fp);}
		const soundfontsDir = path.resolve(fp + '/bin/soundfonts/');
		
		try {
			const files = await fs.readdir(soundfontsDir);
			const soundfontFiles = files.filter(f => f.endsWith('.sf2') || f.endsWith('.sf3'));
			
			const availableFonts = soundfontFiles.map(filename => {
				// Create display label from filename
				let label = filename.replace(/\.(sf2|sf3)$/i, ''); // Remove extension
				label = label.replace(/_/g, ' '); // Replace underscores with spaces
				return { filename, label };
			});
			
			// Sort: Default first, then alphabetically
			availableFonts.sort((a, b) => {
				if (a.filename.startsWith('TimGM')) return -1;
				if (b.filename.startsWith('TimGM')) return 1;
				return a.label.localeCompare(b.label);
			});
			
			tools.sendToId(data.windowId || g.windows['midi'], 'available-soundfonts', { fonts: availableFonts });
		} catch(err) {
			console.error('[MIDI] Failed to read soundfonts directory:', err);
			// Fallback to just default
			tools.sendToId(data.windowId || g.windows['midi'], 'available-soundfonts', { 
				fonts: [{ filename: 'TimGM6mb.sf2', label: 'TimGM6mb' }] 
			});
		}
	});

	ipcRenderer.on('theme-changed', (e, data) => {
		if (g.windows.settings) {
			tools.sendToId(g.windows.settings, 'theme-changed', data);
		}
		if (g.windows.help) {
			tools.sendToId(g.windows.help, 'theme-changed', data);
		}
		if (g.windows.playlist) {
			tools.sendToId(g.windows.playlist, 'theme-changed', data);
		}
		if (g.windows.mixer) {
			tools.sendToId(g.windows.mixer, 'theme-changed', data);
		}
		if (g.windows.pitchtime) {
			tools.sendToId(g.windows.pitchtime, 'theme-changed', data);
		}
		if (g.windows['midi']) {
			tools.sendToId(g.windows['midi'], 'theme-changed', data);
		}
	});
	
	ipcRenderer.on('toggle-theme', (e, data) => {
		tools.sendToMain('command', { command: 'toggle-theme' });
	});

	ipcRenderer.on('mixer-state', (e, data) => {
		g.mixerPlaying = !!(data && data.playing);
	});
	
}

async function appStart(){
	window.addEventListener("keydown", onKey);
	window.addEventListener('wheel', onWheelVolume, {passive:false});
	g.scale = window.devicePixelRatio || 1;
	g.body = document.body;
	g.frame = ut.el('.frame');
	g.top = ut.el('.top');
	g.top_num = g.top.el('.num');
	g.top_close = g.top.el('.close')

	g.time_controls = ut.el('.time_controls');
	g.playhead = ut.el('.playhead');
	g.prog = ut.el('.playhead .prog');
	g.cover = ut.el('.info .cover');
	g.type_band = g.cover.el('.filetype .type');
	g.playtime = ut.el('.playtime .time');
	g.playvolume = ut.el('.playtime .volume span');
	g.playspeed = ut.el('.playtime .speed span');
	g.playremain = ut.el('.playtime .remain');
	g.top_btn_loop = ut.el('.top .content .loop');
	g.top_btn_shuffle = ut.el('.top .content .shuffle');
	g.top_btn_playpause = ut.el('.top .content .playpause');

	g.ctrl_btn_prev = ut.el('.controls .button.prev');
	g.ctrl_btn_next = ut.el('.controls .button.next');
	g.ctrl_btn_shuffle = ut.el('.controls .button.shuffle');
	g.ctrl_btn_play = ut.el('.controls .button.play');
	g.ctrl_btn_loop = ut.el('.controls .button.loop');
	g.ctrl_btn_settings = ut.el('.controls .button.settings');
	g.ctrl_btn_help = ut.el('.controls .button.help');
	g.ctrl_volume = ut.el('.controls .volume');
	g.ctrl_volume_bar = g.ctrl_volume ? g.ctrl_volume.el('.volume-bar') : null;
	g.ctrl_volume_bar_inner = g.ctrl_volume ? g.ctrl_volume.el('.volume-bar-inner') : null;

	g.text = ut.el('.info .text');
	g.text.innerHTML = '';
	g.blocky = false;

	
	g.supportedMpt = ['.mptm', '.mod','.mo3','.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf', 
	'.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus', 
	'.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod', 
	'.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];
	g.supportedMIDI = ['.mid', '.midi', '.kar', '.rmi'];
	g.supportedChrome = ['.mp3','.wav','.flac','.ogg', '.m4a', '.m4b', '.aac','.webm'];
	g.supportedFFmpeg = ['.mpg','.mp2', '.aif', '.aiff','.aa', '.wma', '.asf', '.ape', '.wv', '.wvc', '.tta', '.mka', 
	'.amr', '.3ga', '.ac3', '.eac3', '.dts', '.dtshd', '.caf', '.au', '.snd', '.voc', '.tak', '.mpc', '.mp+'];

	g.supportedFilter = [...g.supportedChrome, ...g.supportedFFmpeg, ...g.supportedMpt, ...g.supportedMIDI]

	function canFFmpegPlayFile(filePath){
		console.log('FFmpeg probe:', filePath);
		const decoder = new g.FFmpegDecoder();
		try {
			if(decoder.open(filePath)){
				const duration = decoder.getDuration();
				decoder.close();
				console.log('  ✓ FFmpeg can play (duration:', duration, 's)');
				return duration > 0;
			}
			decoder.close();
			console.log('  ✗ FFmpeg open failed');
			return false;
		} catch(e){
			try { decoder.close(); } catch(e2){}
			console.log('  ✗ FFmpeg error:', e.message);
			return false;
		}
	}
	g.canFFmpegPlayFile = canFFmpegPlayFile;

	g.music = [];
	g.idx = 0;
	g.isLoop = false;
	
	// Initialize ephemeral playback rate to 0 (always reset on app start)
	if(!g.config.audio) g.config.audio = {};
	g.config.audio.playbackRate = 0;
	
	setupWindow();
	setupDragDrop();

	let arg = g.start_vars[g.start_vars.length-1];
	
	if(arg != '.' && g.start_vars.length > 1 && arg != '--squirrel-firstrun'){
		await playListFromSingle(arg);
	}
	else {
		const dir = (g.config && g.config.ui && g.config.ui.defaultDir) ? g.config.ui.defaultDir : '';
		if (dir) {
			await playListFromSingle(dir);
		}
	}
	
	if(g.music.length > 0){
		
		g.max = g.music.length-1;
		playAudio(g.music[g.idx])
	}

	g.top_close.addEventListener('click', () => {
		const cfg = g.config_obj ? g.config_obj.get() : g.config;
		const keep = cfg && cfg.ui && cfg.ui.keepRunningInTray;
		if(keep){
			if(g.currentAudio && !g.currentAudio.paused) g.currentAudio.pause();
			g.win.hide();
		} else {
			g.win.close();
		}
	});

	g.top_btn_loop.addEventListener('click', toggleLoop);
	g.top_btn_shuffle.addEventListener('click', shufflePlaylist);
	g.top_btn_playpause.addEventListener('click', playPause);

	g.ctrl_btn_prev.addEventListener('click', playPrev);
	g.ctrl_btn_next.addEventListener('click', playNext);
	g.ctrl_btn_shuffle.addEventListener('click', shufflePlaylist);
	g.ctrl_btn_play.addEventListener('click', playPause);
	g.ctrl_btn_loop.addEventListener('click', toggleLoop);
	g.ctrl_btn_settings.addEventListener('click', () => openWindow('settings'));
	g.ctrl_btn_help.addEventListener('click', () => openWindow('help'));
	if(ut.dragSlider && g.ctrl_volume && g.ctrl_volume_bar){
		g.ctrl_volume_slider = ut.dragSlider(g.ctrl_volume, volumeSlider, -1, g.ctrl_volume_bar);
	}
	if(ut.dragSlider && g.time_controls && g.playhead){
		g.timeline_slider = ut.dragSlider(g.time_controls, timelineSlider, -1, g.playhead);
	}

	loop();
	
}

function onWheelVolume(e){
	// Allow browser zoom / Electron zoom gestures to work
	if(e.ctrlKey || e.metaKey) return;
	if(!e) return;
	const dy = +e.deltaY;
	if(!isFinite(dy) || dy === 0) return;
	if(!g.wheel_vol) g.wheel_vol = {acc:0, t:0};
	const now = performance.now();
	if(now - g.wheel_vol.t > 250) { g.wheel_vol.acc = 0; }
	g.wheel_vol.t = now;
	g.wheel_vol.acc += dy;

	const step = 80;
	while(g.wheel_vol.acc <= -step){
		g.wheel_vol.acc += step;
		volumeUp();
	}
	while(g.wheel_vol.acc >= step){
		g.wheel_vol.acc -= step;
		volumeDown();
	}

	// Prevent page scroll / inertial scroll side effects
	e.preventDefault();
}

function _clamp01(v){
	v = +v;
	if(!(v >= 0)) return 0;
	if(v > 1) return 1;
	return v;
}

function setVolume(v, persist=false){
	v = _clamp01(v);
	if(!g.config.audio) g.config.audio = {};
	g.config.audio.volume = v;
	if(player) {
		try { player.gain.gain.value = v; } catch(e) {}
	}
	if(midi) {
		try { midi.setVol(v); } catch(e) {}
	}
	if(g.currentAudio?.isFFmpeg && g.currentAudio.player) {
		g.currentAudio.player.volume = v;
	}
	if(g.playvolume) g.playvolume.innerText = (Math.round(v*100)) + '%';
	if(g.ctrl_volume_bar_inner) g.ctrl_volume_bar_inner.style.width = (v*100) + '%';
	if(persist && g.config_obj) g.config_obj.set(g.config);
}

function volumeSlider(e){
	if(e.type == 'start' || e.type == 'move'){
		setVolume(e.prozX, false);
	}
	else if(e.type == 'end'){
		setVolume(e.prozX, true);
	}
}

function setupDragDrop(){
	g.dropZone = window.nui_app.dropZone(
		[
			{ name:'drop_add', label:'Add to Playlist' }, 
			{ name:'drop_replace', label:'Replace Playlist' },
			{ name:'drop_mixer', label:'Multitrack<br>Preview' }
		],
		dropHandler,
		document.body
	);
	async function dropHandler(e){
		console.log(e);
		e.preventDefault();
		if(e.target.id == 'drop_add'){
			let files = fileListArray(e.dataTransfer.files);
			const wasEmpty = g.music.length === 0;
			await playListFromMulti(files, true, !e.ctrlKey);
			if(wasEmpty) playAudio(g.music[g.idx], 0, false);
			g.win.focus();
		}
		if(e.target.id == 'drop_replace'){
			let files = fileListArray(e.dataTransfer.files);
			await playListFromMulti(files, false, !e.ctrlKey);
			playAudio(g.music[g.idx], 0, false);
			g.win.focus();
		}
		if(e.target.id == 'drop_mixer'){
			let files = fileListArray(e.dataTransfer.files);
			// For mixer, we just want to get the file list to pass to the mixer window,
			// NOT update the main player's playlist (g.music).
			// We use playListFromMulti just to resolve folders recursively if needed,
			// but we need to capture the result without modifying g.music.
			
			// Create a temporary dummy object to capture the playlist if playListFromMulti modifies global state
			// But looking at playListFromMulti, it modifies g.music directly if add=true or replaces it.
			// We need a version that just returns the paths.
			
			// Actually, playListFromMulti returns the list 'pl'.
			// But it also sets g.music. We should refactor or just use a temporary variable.
			// Let's modify playListFromMulti to accept a 'dryRun' or similar, or just manually do it here.
			// Or better, let's just use the tools directly here to get the list.
			
			let pl = [];
			for(let i=0; i<files.length; i++){
				let fp = files[i];
				let stat = await fs.lstat(path.normalize(fp));
				if(stat.isDirectory()){
					let folder_files = [];
					if(!e.ctrlKey){ // Recursive by default unless Ctrl pressed (logic inverted from playListFromMulti?)
						// In playListFromMulti: rec = !e.ctrlKey.
						folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
					}
					else {
						folder_files = await tools.getFiles(fp, g.supportedFilter);
					}
					pl = pl.concat(folder_files);
				}
				else {
					if(tools.checkFileType(fp, g.supportedFilter) || g.canFFmpegPlayFile(fp)){
						pl.push(fp);
					}
				}
			}
			
			// Don't clear audio of main player if we are just opening mixer?
			// "clearAudio();" stops the main player.
			// If we want to play in mixer, we probably want to stop main player.
			// clearAudio();
			if(g.currentAudio && !g.currentAudio.paused){
				g.currentAudio.pause();
				checkState();
			}
			
			// We need to pass the 'pl' array to openWindow.
			// openWindow currently takes (type, show, file_path).
			// We need to pass the list.
			// We can temporarily set g.currentAudio.fp or modify openWindow to accept a list.
			// But openWindow uses 'init_data'.
			
			// Let's look at openWindow implementation.
			// It constructs init_data.
			// If we pass a list, we need to handle it.
			
			// Hack: We can set a temporary property on g that openWindow reads, 
			// or better, pass it as an argument.
			// openWindow(type, show, fileOrList)
			
			openWindow('mixer', true, pl);
			return;
		}
		renderTopInfo();
	}

	function fileListArray(fl){
		let out = [];
		for(let i=0; i<fl.length; i++){
			out.push(webUtils.getPathForFile(fl[i]));
		}
		return out;
	}
}


function setupWindow(){
	g.win.hook_event('blur', handler);
	g.win.hook_event('focus', handler);
	g.win.hook_event('move', handler);
	// electron_helper historically used both event names; support both.
	g.win.hook_event('resized', handler);
	g.win.hook_event('resize', handler);

	function handler(e, data){
		//clearDrop();
		if(data.type == 'blur'){
			g.frame.classList.remove('focus');
		}
		if(data.type == 'focus'){
			g.frame.classList.add('focus');
		}
		if(data.type == 'move' || data.type == 'resized' || data.type == 'resize'){
			clearTimeout(g.window_move_timeout);
			g.window_move_timeout = setTimeout(async () => {
				let bounds = await g.win.getBounds();
				if(!g.config.windows) g.config.windows = {};
				if(!g.config.windows.main) g.config.windows.main = {};
				const scale = (g.config.windows.main.scale !== undefined) ? (g.config.windows.main.scale | 0) : 14;
				g.config.windows.main = {
					...g.config.windows.main,
					x: bounds.x,
					y: bounds.y,
					width: bounds.width,
					height: bounds.height,
					scale: scale
				};
				g.config_obj.set(g.config);
			}, 500)
		}
	}
}

function timelineSlider(e){
	if(!g.currentAudio) return;
	let dur = g.currentAudio.duration;
	if(!(dur > 0)){
		// Fallbacks in case duration isn't populated yet (paused edge cases)
		if(g.currentAudio.isMod && player && player.duration) dur = player.duration;
		else if(g.currentAudio.isFFmpeg && g.currentAudio.player && g.currentAudio.player.duration) dur = g.currentAudio.player.duration;
		else if(g.currentAudio.isMidi && midi && midi.duration) dur = midi.duration;
	}
	if(!(dur > 0)) return;
	
	const s = dur * e.prozX;
	seekTo(s);
}

function playListFromSingle(fp, rec=true){
	return new Promise(async (resolve, reject) => {
		let pl = [];
		let idx = 0;
		let stat = await fs.lstat(path.normalize(fp));
		if(stat.isDirectory()){
			if(rec){
				pl = await tools.getFilesRecursive(fp, g.supportedFilter);
			}
			else {
				pl = await tools.getFiles(fp, g.supportedFilter);
			}
		}
		else {
			if(tools.checkFileType(fp, g.supportedFilter)){
				let info = path.parse(fp);
				pl = await tools.getFiles(info.dir, g.supportedFilter);
				idx = pl.findIndex(item => item == path.join(info.dir, info.base));
				if(idx == -1) { idx = 0};
			}
			else {
				console.log('Unsupported File Type')
			}
		}
		if(pl.length > 0){
			g.music = pl;
			g.max = g.music.length-1;
			g.idx = idx;
		}
		resolve();
	})
}

function playListFromMulti(ar, add=false, rec=false){
	return new Promise(async (resolve, reject) => {
		let pl = [];
		for(let i=0; i<ar.length; i++){
			let fp = ar[i];
			let stat = await fs.lstat(path.normalize(fp));
			if(stat.isDirectory()){
				let folder_files = [];
				if(rec){
					folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
				}
				else {
					folder_files = await tools.getFiles(fp, g.supportedFilter);
				}
				pl = pl.concat(folder_files);
			}
			else {
				if(tools.checkFileType(fp, g.supportedFilter) || g.canFFmpegPlayFile(fp)){
					pl.push(fp);
				}
				else {
					console.log('Unsupported File Type:', fp)
				}
			}
		}
		if(pl.length > 0){
			if(add && g.music.length > 0){
				g.music = g.music.concat(pl);
				g.max = g.music.length-1;
			}
			else {
				g.idx = 0;
				g.music = pl;
				g.max = g.music.length-1;
			}
		}
		resolve(pl);
	})
}



async function playAudio(fp, n, startPaused = false, autoAdvance = false){
	if(!g.blocky){
		if(fp && g.music && g.music.length > 0){
			const idx = g.music.indexOf(fp);
			if(idx >= 0 && g.idx !== idx){
				g.idx = idx;
				try { renderTopInfo(); } catch(e) {}
				if(g.info_win) {
					tools.sendToId(g.info_win, 'info', {list:g.music, idx:g.idx});
				}
			}
		}
		let parse = path.parse(fp);
		let bench = performance.now();
		
		// Skip fade out during auto-advance (track already ended naturally)
		if(!autoAdvance && g.currentAudio && !g.currentAudio.paused){
			if(g.currentAudio.isFFmpeg && g.currentAudio.player && typeof g.currentAudio.player.fadeOut === 'function'){
				await g.currentAudio.player.fadeOut();
			}
		}
		
		g.blocky = true;
		clearAudio();

		if(player) { player.stop(); }
		if(midi) { midi.stop(); }

		const ext = parse.ext.toLocaleLowerCase();
		const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
		const isTracker = g.supportedMpt.includes(ext);

		if(isMIDI){
			if(!midi){
				g.text.innerHTML += (g.midiInitError || 'MIDI playback not initialized.') + '<br>';
				g.blocky = false;
				return false;
			}
			const targetVol = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			const initialVol = startPaused ? 0 : targetVol;
			g.currentAudio = {
				isMidi: true,
				fp: fp,
				bench: bench,
				currentTime: 0,
				get paused() { return midi ? midi.paused : true; },
				duration: 0,
				play: () => {
					try { midi.setVol((g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : targetVol); } catch(e) {}
					midi.play();
				},
				pause: () => { midi.pause(); },
				seek: (time) => midi.seek(time),
				getCurrentTime: () => midi.getCurrentTime()
			};
			try {
				await midi.load(tools.getFileURL(fp));
				
				// Duration should now be available from metadata event
				if (!g.currentAudio.duration && midi.getDuration() > 0) {
					g.currentAudio.duration = midi.getDuration();
				}
				
				midi.setVol(initialVol);
				midi.setLoop(g.isLoop);
				if(n > 0){
					midi.seek(n);
					g.currentAudio.currentTime = n;
				}
				if(startPaused){
					try { midi.setVol(0); } catch(e) {}
					midi.pause();
				} else {
					midi.play();
				}
				
				// Pass g.currentAudio.metadata to renderInfo if active
				await renderInfo(fp, g.currentAudio.metadata);
				g.blocky = false;
				checkState();
			} catch(err) {
				console.error('MIDI playback error:', err);
				g.text.innerHTML += 'Error loading MIDI file!<br>';
				g.blocky = false;
				return false;
			}
		}
		else if(isTracker){
			const targetVol = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			const initialVol = startPaused ? 0 : targetVol;
			g.currentAudio = {
				isMod: true, 
				fp: fp, 
				bench: bench, 
				currentTime: 0,
				paused: startPaused, 
				duration: 0,
				play: () =>  {
					g.currentAudio.paused = false;
					try { player.gain.gain.value = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : targetVol; } catch(e) {}
					player.unpause();
				}, 
				pause: () => { g.currentAudio.paused = true; player.pause() }
			};
			player.load(tools.getFileURL(fp));
			player.gain.gain.value = initialVol;
			
			// Apply current ephemeral playback rate to tracker
			const playbackRate = (g.config && g.config.audio && g.config.audio.playbackRate !== undefined) ? (g.config.audio.playbackRate | 0) : 0;
			if(playbackRate !== 0){
				const tempoFactor = Math.pow(2, playbackRate / 12.0);
				player.setTempo(tempoFactor);
			}
			if(g.playspeed){
				if(playbackRate > 0) g.playspeed.innerText = '+' + playbackRate;
				else g.playspeed.innerText = playbackRate.toString();
			}
			
			if(n > 0){
				const seekTime = n;
				const seekFp = fp;
				let attempts = 0;
				const doSeek = () => {
					if(!g.currentAudio || !g.currentAudio.isMod || g.currentAudio.fp !== seekFp) return;
					if(!player || typeof player.seek !== 'function') return;
					if(player.duration && player.duration > 0){
						player.seek(seekTime);
						g.currentAudio.currentTime = seekTime;
						return;
					}
					attempts++;
					if(attempts < 60){
						setTimeout(doSeek, 25);
					}
				};
				setTimeout(doSeek, 25);
			}
			if(startPaused) {
				// Chiptune.js tends to auto-start asynchronously after load().
				// Enforce paused state immediately and shortly after to catch async start.
				try { player.gain.gain.value = 0; } catch(e) {}
				try { player.pause(); } catch(e) {}
				setTimeout(() => {
					try {
						if(g.currentAudio && g.currentAudio.isMod && g.currentAudio.fp === fp && g.currentAudio.paused){
							try { player.gain.gain.value = 0; } catch(e) {}
							player.pause();
						}
					} catch(e) {}
				}, 30);
				setTimeout(() => {
					try {
						if(g.currentAudio && g.currentAudio.isMod && g.currentAudio.fp === fp && g.currentAudio.paused){
							try { player.gain.gain.value = 0; } catch(e) {}
							player.pause();
						}
					} catch(e) {}
				}, 250);
			}
			checkState();
		}
		else {
			try {
				const ffPlayer = g.ffmpegPlayer;
				ffPlayer.onEnded(audioEnded);
				
				const metadata = await ffPlayer.open(fp);
				//console.log('File sample rate:', metadata.sampleRate, 'AudioContext rate:', g.audioContext.sampleRate);
				ffPlayer.setLoop(g.isLoop);
				
				g.currentAudio = {
					isFFmpeg: true,
					fp: fp,
					bench: bench,
					currentTime: 0,
					paused: startPaused,
					duration: metadata.duration,
					player: ffPlayer,
					volume: (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5,
					play: () => { g.currentAudio.paused = false; ffPlayer.play(); },
					pause: () => { g.currentAudio.paused = true; ffPlayer.pause(); },
					seek: (time) => ffPlayer.seek(time),
					getCurrentTime: () => ffPlayer.getCurrentTime()
				};
				
				ffPlayer.volume = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
				
			const playbackRate = (g.config && g.config.audio && g.config.audio.playbackRate !== undefined) ? (g.config.audio.playbackRate | 0) : 0;
			ffPlayer.setPlaybackRate(playbackRate);
			if(g.playspeed){
				if(playbackRate > 0) g.playspeed.innerText = '+' + playbackRate;
				else g.playspeed.innerText = playbackRate.toString();
			}
			
				if (!startPaused) {
					await ffPlayer.play();
				}
				else {
					// Some backends may begin rendering immediately after open();
					// enforce paused state so UI/playPause stays consistent.
					if(typeof ffPlayer.pause === 'function') await ffPlayer.pause();
				}
				
				checkState();
				//console.log('Operation took: ' + Math.round((performance.now() - bench)));
				await renderInfo(fp);
				g.blocky = false;
			}
			catch(err) {
				console.error('FFmpeg playback error:', err);
				g.text.innerHTML += 'Error loading file!<br>';
				g.blocky = false;
				return false;
			}
		}
	}
	if(g.info_win) {
		tools.sendToId(g.info_win, 'info', {list:g.music, idx:g.idx});
	}
}

function renderInfo(fp, metadata){
	g.currentInfo = { duration:g.currentAudio.duration };
	return new Promise(async (resolve, reject) => {
		let parse = path.parse(fp);
		let parent = path.basename(parse.dir);
		g.playremain.innerText = ut.playTime(g.currentAudio.duration*1000).minsec;
		ut.killKids(g.text);
		g.text.appendChild(renderInfoItem('Folder:', parent))
		g.text.appendChild(renderInfoItem('File:', parse.base))
		g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
		let ext_string = parse.ext.substring(1).toLowerCase();
		g.type_band.className = 'type ' + ext_string;
		g.type_band.innerText = ext_string;

		let prevCovers = g.cover.els('img');
		for(let i=0; i<prevCovers.length; i++){
			let el = prevCovers[i];
			el.animate([{opacity: 1}, {opacity: 0}], {duration: 200, delay: 200, fill: 'forwards'})
				.onfinish = () => ut.killMe(el);
		}
		renderTopInfo(); 
		
		if(g.currentAudio.isMod){
			g.currentInfo.metadata = metadata;
			g.text.appendChild(renderInfoItem('Format:', metadata.tracker))
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
			if(metadata){
				if(metadata.artist) { g.text.appendChild(renderInfoItem('Artist:', metadata.artist)) }
				if(metadata.title) { g.text.appendChild(renderInfoItem('Title:', metadata.title)) }
				if(metadata.date) { g.text.appendChild(renderInfoItem('Date:', metadata.date)) }
			}
			resolve();
		}
		else if(g.currentAudio.isMidi){
			// Use metadata from onMetadata (stored on g.currentAudio.metadata) if not passed directly
			const md = metadata || g.currentAudio.metadata || {};
			g.currentInfo.metadata = md;
			
			if(md.duration && md.duration > 0){
				g.currentAudio.duration = md.duration;
				g.playremain.innerText = ut.playTime(g.currentAudio.duration*1000).minsec;
			}
			g.text.appendChild(renderInfoItem('Format:', 'MIDI'))
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
			
			if (md.title) g.text.appendChild(renderInfoItem('Title:', md.title));
			if (md.copyright) g.text.appendChild(renderInfoItem('Copyright:', md.copyright));
			
			const infoParts = [];
			if (md.timeSignature) infoParts.push(md.timeSignature);
			if (md.originalBPM) infoParts.push(Math.round(md.originalBPM) + ' BPM');
			if (md.keySignature) infoParts.push('Key: ' + md.keySignature);
			
			if (infoParts.length > 0) {
				g.text.appendChild(renderInfoItem('Info:', infoParts.join(' - ')));
			}

			if (md.markers && md.markers.length > 0) {
				// Just show count or first few?
				// g.text.appendChild(renderInfoItem('Markers:', md.markers.length));
			}

			resolve();
		}
		else {
			
			let meta = await getFileInfo(fp);
			g.currentInfo.file = meta;

			if(meta.formatLongName && meta.formatLongName.includes('Tracker')){
				g.text.appendChild(renderInfoItem('Format:', 'Tracker Format'))
			}
			else {
				g.text.appendChild(renderInfoItem('Format:', meta.codecLongName || meta.codec || 'Unknown'))
			}
			
			let bitrateStr = meta.bitrate ? Math.round(meta.bitrate/1000) + ' kbps' : '';
			let channelStr = meta.channels == 2 ? 'stereo' : (meta.channels == 1 ? 'mono' : (meta.channels ? meta.channels + ' ch' : ''));
			let sampleStr = meta.sampleRate ? meta.sampleRate + ' Hz' : '';
			if(meta.bitsPerSample && sampleStr) sampleStr += ' @ ' + meta.bitsPerSample + ' Bit';
			let infoLine = [bitrateStr, channelStr, sampleStr].filter(s => s).join(' / ');
			if(infoLine) g.text.appendChild(renderInfoItem(' ', infoLine))
			
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
			
			if(meta.artist) { g.text.appendChild(renderInfoItem('Artist:', meta.artist)) }
			if(meta.album) { g.text.appendChild(renderInfoItem('Album:', meta.album)) }
			if(meta.title) { g.text.appendChild(renderInfoItem('Title:', meta.title)) }
			

			
			let cover;
			let id3_cover = await getCoverArt(meta);
			if(id3_cover){
				cover = id3_cover;
			}
			else {
				let images = await tools.getFiles(parse.dir, ['.jpg','.jpeg','.png','.gif']);
				if(images.length > 0){
					cover = await tools.loadImage(images[images.length-1])
				}
			}

			if(cover){
				g.cover.appendChild(cover)
				cover.style.opacity = '0';
				cover.animate([{opacity: 0}, {opacity: 1}], {duration: 200, fill: 'forwards'});
				g.currentInfo.cover_src = cover.src;
			}
			
			resolve();
		}
	})
}


function renderInfoItem(label, text){
	let el = ut.htmlObject( /*html*/ `
		<div id="#item_folder" class="item">
			<div class="label">${label}</div>
			<div class="content">${text}</div>
		</div>`)
	return el;
}

function renderTopInfo(){
	g.top_num.innerText = (g.idx+1) + ' of ' + (g.max+1); 
}

function clearAudio(){
	if(g.ffmpegPlayer) g.ffmpegPlayer.stop(true);  // Keep SABs/worklet for reuse
	if(g.currentAudio){
		if(g.currentAudio.isMod) player.stop();
		if(g.currentAudio.isMidi && midi) midi.stop();
		g.currentAudio = undefined;
	}
}

function audioEnded(e){
	if((g.currentAudio?.isMod || g.currentAudio?.isMidi) && g.isLoop){
		playAudio(g.music[g.idx], 0, false, true);
	}
	else {
		playNext(null, true);
	}
}

function checkState(){
	if(g.currentAudio){
		if(g.isLoop){
			g.body.addClass('loop')
		}
		else {
			g.body.removeClass('loop')
		}
		if(g.currentAudio.paused){
			g.body.addClass('pause')
		}
		else {
			g.body.removeClass('pause')
		}
	}
}

function flashButton(btn){
	if(!btn) return;
	btn.classList.add('flash');
	setTimeout(() => { btn.classList.remove('flash'); }, 50);
}

function shufflePlaylist(){
	ut.shuffleArray(g.music);
	g.idx = 0;
	playAudio(g.music[g.idx]);
}

function playNext(e, autoAdvance = false){
	if(!g.blocky){
		if(g.idx == g.max){ g.idx = -1; }
		g.idx++;
		playAudio(g.music[g.idx], 0, false, autoAdvance)
	}
}

function playPrev(e){
	if(!g.blocky){
		if(g.idx == 0){ g.idx = g.max+1; }
		g.idx--;
		playAudio(g.music[g.idx])
	}
}

function playPause(){
	if(!g.currentAudio){
		if(g.music && g.music.length > 0){
			playAudio(g.music[g.idx]);
		}
		return;
	}

	if(g.currentAudio.paused){
		g.currentAudio.play();
	}
	else {
		g.currentAudio.pause();
	}
	checkState();
}

function toggleLoop(){
	g.isLoop = !g.isLoop;
	if(g.currentAudio && g.currentAudio.isFFmpeg && g.currentAudio.player){
		g.currentAudio.player.setLoop(g.isLoop);
	}
	if(g.currentAudio && g.currentAudio.isMidi && midi){
		midi.setLoop(g.isLoop);
	}
	checkState();
}

function toggleControls(){
	if(!g.config.ui) g.config.ui = {};
	const current = !!g.config.ui.showControls;
	const next = !current;
	g.config.ui.showControls = next;
	g.config_obj.set(g.config);
	applyShowControls(next, true);
}

function _getMainScale(){
	let s = 14;
	if(g.config && g.config.windows && g.config.windows.main && g.config.windows.main.scale !== undefined){
		s = g.config.windows.main.scale | 0;
	}
	if(s < 14) s = 14;
	return s;
}

function _scaledDim(base, scale){
	const v = Math.round((base / 14) * scale);
	return (v > base) ? v : base;
}

function applyShowControls(show, resetSize = false){
	const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
	const minH = show ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
	const scale = _getMainScale();
	const scaledMinW = _scaledDim(MIN_WIDTH, scale);
	const scaledMinH = _scaledDim(minH, scale);
	if(show){
		document.body.classList.add('show-controls');
	} else {
		document.body.classList.remove('show-controls');
	}
	tools.sendToMain('command', { command: 'set-min-height', minHeight: scaledMinH, minWidth: scaledMinW });
	if(resetSize){
		g.win.setBounds({ width: scaledMinW, height: scaledMinH });
	}
}

async function initMidiPlayer(){
	if(!window.midi || !g.audioContext) return;
	let fp = g.app_path;
	if(g.isPackaged){fp = path.dirname(fp);}
	const soundfontFile = (g.config && g.config.midiSoundfont) ? g.config.midiSoundfont : 'default.sf2';
	const soundfontPath = path.resolve(fp + '/bin/soundfonts/' + soundfontFile);
	
	// Validate soundfont exists, fallback to default if not
	try {
		await fs.access(soundfontPath);
	} catch(e) {
		console.warn('[MIDI] SoundFont not found:', soundfontFile, '- falling back to default.sf2');
		const defaultPath = path.resolve(fp + '/bin/soundfonts/default.sf2');
		const soundfontUrl = tools.getFileURL(defaultPath);
		await initMidiWithSoundfont(soundfontUrl, defaultPath);
		return;
	}
	
	const soundfontUrl = tools.getFileURL(soundfontPath);
	await initMidiWithSoundfont(soundfontUrl, soundfontPath);
}

async function initMidiWithSoundfont(soundfontUrl, soundfontPath) {
	const midiConfig = {
		context: g.audioContext,
		soundfontUrl: soundfontUrl,
		soundfontPath: soundfontPath
	};
	try {
		midi = new window.midi(midiConfig);
	} catch(e) {
		console.error('MIDI init failed:', e);
		g.midiInitError = 'MIDI init failed: ' + e.message;
		midi = null;
		return;
	}
	midi.onMetadata((meta) => {
		console.log('[Stage] Received MIDI Metadata:', meta);
		if(g.currentAudio && g.currentAudio.isMidi){
			const dur = (meta && meta.duration) ? meta.duration : midi.getDuration();
			if(dur > 0){
				g.currentAudio.duration = dur;
				g.playremain.innerText = ut.playTime(dur*1000).minsec;
			}
			
			// Store metadata for renderInfo to use
			if(meta) {
				g.currentAudio.metadata = meta;
			}

			// Apply ephemeral settings if they exist (persistence across tracks while window is open)
			if (g.midiSettings) {
				if (g.midiSettings.pitch !== 0 && midi.setPitchOffset) {
					midi.setPitchOffset(g.midiSettings.pitch);
				}
				if (g.midiSettings.speed && midi.setPlaybackSpeed) {
					midi.setPlaybackSpeed(g.midiSettings.speed);
				}
				if (g.midiSettings.metronome && midi.setMetronome) {
					midi.setMetronome(true);
				}
			}

			// Update MIDI Settings window if open
			if(g.windows['midi'] && g.windowsVisible['midi']){
				const originalBPM = (midi.getOriginalBPM && typeof midi.getOriginalBPM === 'function') ? midi.getOriginalBPM() : 120;
				let currentBPM = originalBPM;
				
				if (g.midiSettings && g.midiSettings.speed) {
					currentBPM = g.midiSettings.speed;
				}
				
				tools.sendToId(g.windows['midi'], 'update-ui', {
					originalBPM: originalBPM,
					speed: currentBPM,
					metronome: !!(g.midiSettings && g.midiSettings.metronome)
				});
			}
		}
	});
	midi.onProgress((e) => {
		if(g.currentAudio && g.currentAudio.isMidi){
			g.currentAudio.currentTime = e.pos || 0;
		}
	});
	midi.onEnded(audioEnded);
	midi.onError((err) => { console.log(err); audioEnded(); g.blocky = false; });
	
	try {
		await midi.init();
	} catch(e) {
		console.error('[MIDI] Failed to initialize MIDI player:', e);
		g.midiInitError = 'MIDI init failed: ' + e.message;
		midi = null;
	}
}

async function toggleHQMode(desiredState, skipPersist=false){
	if(!g.config.audio) g.config.audio = {};
	let next = !!g.config.audio.hqMode;
	if(typeof desiredState === 'boolean') { next = desiredState; }
	else { next = !g.config.audio.hqMode; }
	if(!!g.config.audio.hqMode !== next){
		g.config.audio.hqMode = next;
		if(!skipPersist) { g.config_obj.set(g.config); }
	}
	
	const targetRate = g.config.audio.hqMode ? g.maxSampleRate : 44100;
	console.log('Switching to', g.config.audio.hqMode ? 'Max output sample rate' : 'Standard mode', '(' + targetRate + 'Hz)');
	
	// Use underlying player state (more reliable than g.currentAudio.paused).
	let wasPlaying = false;
	if(g.currentAudio){
		if(g.currentAudio.isFFmpeg && g.currentAudio.player && typeof g.currentAudio.player.isPlaying !== 'undefined'){
			wasPlaying = !!g.currentAudio.player.isPlaying;
		}
		else {
			wasPlaying = !g.currentAudio.paused;
		}
	}
	const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : g.music[g.idx];
	const currentIdx = (currentFile && g.music && g.music.length > 0) ? g.music.indexOf(currentFile) : -1;
	const wasMod = g.currentAudio?.isMod;
	const wasMidi = g.currentAudio?.isMidi;
	const currentTime = wasMod ? (player?.getCurrentTime() || 0) : (wasMidi ? (midi?.getCurrentTime() || 0) : (g.currentAudio?.player?.getCurrentTime() || 0));
	
	// Stop current playback
	if(g.currentAudio){
		if(g.currentAudio.isMod){
			player.stop();
		} else if(g.currentAudio.isMidi && midi){
			midi.stop();
		} else if(g.currentAudio.player){
			if(typeof g.currentAudio.player.stop === 'function'){
				g.currentAudio.player.stop();
			}
			if(typeof g.currentAudio.player.close === 'function'){
				await g.currentAudio.player.close();
			}
		}
		g.currentAudio = null;
	}
	
	if(g.audioContext && g.audioContext.state !== 'closed'){
		await g.audioContext.close();
	}
	
	g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });
	console.log('New AudioContext sample rate:', g.audioContext.sampleRate);
	
	/* Re-apply saved output device after AudioContext rebuild */
	const devId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
	if (devId) {
		try {
			await g.audioContext.setSinkId(devId);
			console.log('Output device re-applied:', devId);
		} catch (err) {
			console.error('Failed to re-apply output device, using system default:', err);
			if(g.config && g.config.audio && g.config.audio.output) g.config.audio.output.deviceId = '';
			if(!skipPersist) { g.config_obj.set(g.config); }
		}
	}
	
	// Fully dispose old ffmpegPlayer before creating new one
	if (g.ffmpegPlayer) {
		try { g.ffmpegPlayer.dispose(); } catch(e) { console.warn('ffmpegPlayer dispose error:', e); }
		g.ffmpegPlayer = null;
	}
	
	const { FFmpegDecoder } = require(g.ffmpeg_napi_path);
	const { FFmpegStreamPlayerSAB } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);
	const bufferSize = (g.config && g.config.ffmpeg && g.config.ffmpeg.stream && g.config.ffmpeg.stream.prebufferChunks !== undefined) ? (g.config.ffmpeg.stream.prebufferChunks | 0) : 10;
	const threadCount = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder && g.config.ffmpeg.decoder.threads !== undefined) ? (g.config.ffmpeg.decoder.threads | 0) : 0;
	g.ffmpegPlayer = new FFmpegStreamPlayerSAB(g.audioContext, g.ffmpeg_worklet_path, bufferSize, threadCount);
	// Reduce AudioWorkletNode churn when reopening after AudioContext rebuild.
	try { g.ffmpegPlayer.reuseWorkletNode = true; } catch(e) {}
	await g.ffmpegPlayer.init();
	
	const modConfig = {
		repeatCount: 0,
		stereoSeparation: (g.config && g.config.tracker && g.config.tracker.stereoSeparation !== undefined) ? (g.config.tracker.stereoSeparation | 0) : 100,
		interpolationFilter: (g.config && g.config.tracker && g.config.tracker.interpolationFilter !== undefined) ? (g.config.tracker.interpolationFilter | 0) : 0,
		context: g.audioContext
	};
	player = new window.chiptune(modConfig);
	
	// Wait for player to initialize before continuing
	await new Promise((resolve) => {
		player.onInitialized(() => {
			console.log('Player Initialized after HQ toggle');
			player.gain.connect(g.audioContext.destination);
			resolve();
		});
	});
	
	// Now set up remaining handlers
	player.onMetadata(async (meta) => {
		if(g.currentAudio){
			g.currentAudio.duration = player.duration;
			g.playremain.innerText = ut.playTime(g.currentAudio.duration*1000).minsec;
			await renderInfo(g.currentAudio.fp, meta);
		}
		g.blocky = false;
	});
	player.onProgress((e) => {
		if(g.currentAudio){
			g.currentAudio.currentTime = e.pos || 0;
		}
	});
	player.onEnded(audioEnded);
	player.onError((err) => { console.log(err); audioEnded(); g.blocky = false; });
	await initMidiPlayer();
	
	if(currentFile){
		if(currentIdx >= 0) {
			g.idx = currentIdx;
		}
		// Reload the current track but preserve paused state.
		// playAudio() has startPaused support for FFmpeg; trackers are best-effort.
		await playAudio(currentFile, currentTime, !wasPlaying);

		// Resume only if it was playing before the toggle.
		if(wasPlaying && g.currentAudio && g.currentAudio.paused && g.currentAudio.play){
			g.currentAudio.play();
		}
	}
	
	checkState();
}

function volumeUp(){
	const v = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? (+g.config.audio.volume + 0.05) : 0.55;
	setVolume(v, true);
}

function volumeDown(){
	const v = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? (+g.config.audio.volume - 0.05) : 0.45;
	setVolume(v, true);
}

function setPlaybackRate(semitones){
	semitones = Math.max(-24, Math.min(24, semitones | 0));
	if(!g.config.audio) g.config.audio = {};
	g.config.audio.playbackRate = semitones;
	
	// Apply to FFmpeg player
	if(g.currentAudio?.isFFmpeg && g.currentAudio.player){
		g.currentAudio.player.setPlaybackRate(semitones);
	}
	
	// Apply to tracker/mod player using tempo
	if(g.currentAudio?.isMod && player){
		const tempoFactor = Math.pow(2, semitones / 12.0);
		player.setTempo(tempoFactor);
	}
	
	// Update UI
	if(g.playspeed){
		if(semitones > 0) g.playspeed.innerText = '+' + semitones;
		else g.playspeed.innerText = semitones.toString();
	}
	// Note: NOT persisting to config - speed is ephemeral
}

function speedUp(){
	const current = (g.config && g.config.audio && g.config.audio.playbackRate !== undefined) ? (g.config.audio.playbackRate | 0) : 0;
	setPlaybackRate(current + 1);
}

function speedDown(){
	const current = (g.config && g.config.audio && g.config.audio.playbackRate !== undefined) ? (g.config.audio.playbackRate | 0) : 0;
	setPlaybackRate(current - 1);
}


function seek(mx){
	if(!g.currentAudio) return;
	let dur = g.currentAudio.duration;
	if(!(dur > 0)){
		// Fallbacks in case duration isn't populated yet (paused edge cases)
		if(g.currentAudio.isMod && player && player.duration) dur = player.duration;
		else if(g.currentAudio.isFFmpeg && g.currentAudio.player && g.currentAudio.player.duration) dur = g.currentAudio.player.duration;
		else if(g.currentAudio.isMidi && midi && midi.duration) dur = midi.duration;
	}
	if(!(dur > 0)) return;
	let max = g.time_controls.offsetWidth;
	let x = mx - ut.offset(g.time_controls).left;
	if(x < 0) { x = 0; }
	if(x > max) { x = max; }
	let proz = x / max;
	let s = dur * proz;
	if(s < 0) s = 0;
	if(s > dur) s = dur;
	seekTo(s);
}

function seekTo(s){
	if(g.currentAudio){
		if(g.currentAudio.isMod){
			player.seek(s);
			g.currentAudio.currentTime = s;
		}
		else if(g.currentAudio.isMidi){
			g.currentAudio.seek(s);
			g.currentAudio.currentTime = s;
		}
		else {
			g.currentAudio.seek(s);
		}
	}
}

function seekFore(){
	if(g.currentAudio){
		if(g.currentAudio.currentTime + 10 < g.currentAudio.duration){
			seekTo(g.currentAudio.currentTime + 10)
		}
	}
}

function seekBack(){
	if(g.currentAudio){
		if(g.currentAudio.currentTime - 10 > 0){
			seekTo(g.currentAudio.currentTime - 10)
		}
		else {
			seekTo(0);
		}
	}
}

function loadImage(url){
	return new Promise((resolve, reject) => {
		let image = new Image();
		image.src = url;
		image.addEventListener('load', done);
		function done(e){
			image.removeEventListener('load', done);
			resolve(image);
		}
	})
}

function getFileInfo(fp){
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			let meta = g.getMetadata(fp);
			resolve(meta);
		}, 0);
	})
}

function getCoverArt(meta){
	return new Promise((resolve, reject) => {
		if(meta && meta.coverArt && meta.coverArt.length > 0){
			let img = new Image();
			let mime = meta.coverArtMimeType || 'image/jpeg';
			img.src = 'data:' + mime + ';base64,' + meta.coverArt.toString('base64');
			img.addEventListener('load', () => {
				resolve(img);
			}, {once:true});
			img.addEventListener('error', () => {
				resolve();
			}, {once:true});
		}
		else {
			resolve();
		}
	})
}

function loop(){
	renderBar();
	requestAnimationFrame(loop);
	//setTimeout(loop, 100);
}


function renderBar(){
	let proz = 0;
	let time = 0;
	if(g.currentAudio){
		if(g.currentAudio.isFFmpeg && g.currentAudio.player){
			g.currentAudio.currentTime = g.currentAudio.player.getCurrentTime();
		}
		else if(g.currentAudio.isMidi && g.currentAudio.getCurrentTime){
			g.currentAudio.currentTime = g.currentAudio.getCurrentTime();
		}
		
		if(g.currentAudio.lastTime != g.currentAudio.currentTime){
			g.currentAudio.lastTime = g.currentAudio.currentTime;
			time = g.currentAudio.currentTime;
			if(g.currentAudio.duration > 0){
				proz = time / g.currentAudio.duration;
			}
			g.prog.style.width = (proz*100) + '%';
			let minsec = ut.playTime(time*1000).minsec;
			if(g.lastMinsec !=  minsec){
				g.playtime.innerText = minsec;
				g.lastMinsec = minsec;
			}
		}
	}
	
	
	const vol = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
	if(g.last_vol != vol){
		g.playvolume.innerText = (Math.round(vol*100)) + '%';
		if(g.ctrl_volume_bar_inner) g.ctrl_volume_bar_inner.style.width = (vol*100) + '%';
		g.last_vol = vol;
	}
	
}



// Tools
// ###########################################################################



async function onKey(e) {
	//fb(e.keyCode)
	let shortcutAction = null;
	if(shortcuts && shortcuts.handleShortcut){
		shortcutAction = shortcuts.handleShortcut(e, 'stage');
	} else if(window.shortcuts && window.shortcuts.handleShortcut){
		shortcutAction = window.shortcuts.handleShortcut(e, 'stage');
	}
	
	if (shortcutAction === 'toggle-help') {
		openWindow('help');
		flashButton(g.ctrl_btn_help);
	}
	else if (shortcutAction === 'toggle-settings') {
		openWindow('settings');
		flashButton(g.ctrl_btn_settings);
	}
	else if (shortcutAction === 'toggle-theme') {
		tools.sendToMain('command', { command: 'toggle-theme' });
	}
	else if (shortcutAction === 'toggle-mixer') {
		const fp = g.currentAudio ? g.currentAudio.fp : null;
		openWindow('mixer', false, fp);
	}
	else if (shortcutAction === 'toggle-pitchtime') {
		// Open MIDI settings for MIDI files, pitch/time for others
		const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
		if (currentFile) {
			const ext = path.extname(currentFile).toLowerCase();
			console.log('[P key] Current file:', currentFile, 'ext:', ext, 'isMIDI:', g.supportedMIDI.includes(ext));
			if (g.supportedMIDI && g.supportedMIDI.includes(ext)) {
				openWindow('midi');
			} else {
				openWindow('pitchtime');
			}
		} else {
			openWindow('pitchtime');
		}
	}
	else if (shortcutAction === 'toggle-controls') {
		toggleControls();
	}
	else if (e.keyCode == 70 || e.keyCode == 102) {
		console.log(g.currentAudio.src)
	}
	/*
	if(e.keyCode == 112 && e.ctrlKey && e.shiftKey){
		if(main_env.startType == 'installed'){
			console.log(await registry('register', g.main_env.app_exe, g.main_env.app_path));
		}
	}
	if(e.keyCode == 113 && e.ctrlKey && e.shiftKey){
		if(main_env.startType == 'installed'){
			console.log(await registry('unregister', g.main_env.app_exe, g.main_env.app_path));
		}
	}*/
	if (e.keyCode == 123) {
		g.win.toggleDevTools();
	}
	else if(e.keyCode == 76){
		toggleLoop();
		flashButton(g.ctrl_btn_loop);
	}

	if (e.keyCode == 27) {
		g.config_obj.set(g.config);
		const cfg = g.config_obj ? g.config_obj.get() : g.config;
		const keep = cfg && cfg.ui && cfg.ui.keepRunningInTray;
		if(keep){
			if(g.currentAudio && !g.currentAudio.paused) g.currentAudio.pause();
			g.win.hide();
		} else {
			g.win.close();
		}
	}
	if (e.keyCode == 39) {
		if(e.ctrlKey){ seekFore()}
		else { 
			let now = Date.now();
			if(now - g.lastNavTime >= 100){
				g.lastNavTime = now;
				playNext();
				flashButton(g.ctrl_btn_next);
			}
		}
	}
	if (e.keyCode == 37) {
		if(e.ctrlKey){ seekBack()}
		else { 
			let now = Date.now();
			if(now - g.lastNavTime >= 100){
				g.lastNavTime = now;
				playPrev();
				flashButton(g.ctrl_btn_prev);
			}
		}
	}
	if (e.keyCode == 38) {
		volumeUp();
	}
	if (e.keyCode == 40) {
		volumeDown();
	}
	// Speed control handled below in unified block
	
	/*
	if (e.keyCode == 187 || e.keyCode == 107) {
		speedUp();
	}
	if (e.keyCode == 189 || e.keyCode == 109) {
		speedDown();
	}
	*/

	if (e.keyCode == 82) {
		shufflePlaylist();
		flashButton(g.ctrl_btn_shuffle);
	}
	if (e.keyCode == 73){
		helper.shell.showItemInFolder(g.music[g.idx]);
	}
	
	if(e.keyCode == 32){
		playPause();
		flashButton(g.ctrl_btn_play);
	}
	
	// Mapping for standard keyboard - (189) and Numpad - (109)
	if(e.keyCode == 189 || e.keyCode == 109 || e.keyCode == 173){
		if (e.ctrlKey) {
			console.log('Scaling down');
			let val = ut.getCssVar('--space-base').value;
			scaleWindow(val-1)
		} else {
			speedDown();
		}
	}
	// Mapping for standard keyboard + (=) and Numpad + (107)
	if(e.keyCode == 187 || e.keyCode == 107 || e.keyCode == 61){
		if (e.ctrlKey) {
			console.log('Scaling up');
			let val = ut.getCssVar('--space-base').value;
			scaleWindow(val+1)
		} else {
			speedUp();
		}
	}
	// H and S shortcuts now handled globally in app.js
}

async function getMixerPlaylist(contextFile = null) {
	if (Array.isArray(contextFile)) {
		return { paths: contextFile, idx: 0 };
	}
	let fp = contextFile;
	if (!fp && g.currentAudio && g.currentAudio.fp) {
		fp = g.currentAudio.fp;
	}

	if (fp) {
		try {
			const dir = path.dirname(fp);
			const files = await tools.getFiles(dir, g.supportedFilter);
			
			const currentPath = path.normalize(fp);
			let idx = files.findIndex(f => path.normalize(f) === currentPath);
			if (idx === -1) idx = 0;
			
			return { paths: files, idx: idx };
		} catch (e) {
			console.error('Error getting siblings for mixer:', e);
		}
	}
	const list = Array.isArray(g.music) ? g.music : [];
	return { paths: list, idx: g.idx | 0 };
}

async function openWindow(type, forceShow = false, contextFile = null) {
	console.log('[openWindow] type:', type, 'forceShow:', forceShow, 'exists:', !!g.windows[type]);
	async function waitForWindowClosed(t, id, timeoutMs = 2000){
		return await new Promise((resolve) => {
			let done = false;
			const to = setTimeout(() => {
				if(done) return;
				done = true;
				ipcRenderer.removeListener('window-closed', onClosed);
				resolve(false);
			}, timeoutMs|0);
			function onClosed(e, data){
				if(done) return;
				if(!data || data.type !== t || data.windowId !== id) return;
				done = true;
				clearTimeout(to);
				ipcRenderer.removeListener('window-closed', onClosed);
				resolve(true);
			}
			ipcRenderer.on('window-closed', onClosed);
		});
	}

	// If a window is currently closing, wait briefly so we don't race against the old instance.
	if(g.windows[type] && g.windowsClosing[type]){
		await waitForWindowClosed(type, g.windows[type], 2000);
	}

	if (g.windows[type]) {
		// Window exists
		// When opening/showing MIDI window, ensure it has current ephemeral settings
		if(type === 'midi' && g.midiSettings){
			tools.sendToId(g.windows[type], 'update-ui', { pitch: g.midiSettings.pitch, speed: g.midiSettings.speed });
		}

		if(forceShow){
			// For Mixer playlist replacement, send new playlist (reuse pattern avoids memory leaks).
			if(type === 'mixer'){
				if(g.currentAudio && !g.currentAudio.paused){
					g.currentAudio.pause();
					checkState();
				}
				const playlist = await getMixerPlaylist(contextFile);
				tools.sendToId(g.windows[type], 'mixer-playlist', {
					paths: playlist.paths.slice(0, 20),
					idx: playlist.idx
				});
				if(!g.windowsVisible[type]){
					tools.sendToId(g.windows[type], 'show-window');
					g.windowsVisible[type] = true;
				} else {
					tools.sendToId(g.windows[type], 'show-window');
				}
				return;
			} else {
				if(!g.windowsVisible[type]){
					tools.sendToId(g.windows[type], 'show-window');
					g.windowsVisible[type] = true;
				} else {
					tools.sendToId(g.windows[type], 'show-window');
				}
				if(type === 'pitchtime'){
					const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
					const currentTime = g.currentAudio ? g.currentAudio.currentTime : 0;
					if(currentFile){
						if(g.currentAudio && !g.currentAudio.paused){
							g.currentAudio.pause();
							checkState();
						}
						const ext = path.extname(currentFile).toLowerCase();
						if(g.supportedMIDI && g.supportedMIDI.includes(ext)){
							tools.sendToId(g.windows[type], 'pitchtime-error', { message: 'MIDI files are not supported in Pitch/Time.' });
						} else {
							tools.sendToId(g.windows[type], 'pitchtime-file', { currentFile, currentTime });
						}
					}
				}
				return;
			}
		}

		// Default behavior: toggle visibility based on tracked state
		if (g.windowsVisible[type]) {
			tools.sendToId(g.windows[type], 'hide-window');
			g.windowsVisible[type] = false;
			
			// If hiding MIDI window, reset ephemeral settings immediately per request
			if(type === 'midi'){
				g.midiSettings = { pitch: 0, speed: null };
				if(midi){
					if(midi.setPitchOffset) midi.setPitchOffset(0);
					if(midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
					if(midi.setMetronome) midi.setMetronome(false); // Reset metronome
				}
			}

			// Return focus to stage window when hiding
			g.win.focus();
		} else {
			tools.sendToId(g.windows[type], 'show-window');
			g.windowsVisible[type] = true;
			// Refresh mixer playlist when showing an existing mixer window
			if(type === 'mixer'){
				if(g.currentAudio && !g.currentAudio.paused){
					g.currentAudio.pause();
					checkState();
				}
				const playlist = await getMixerPlaylist(contextFile);
				tools.sendToId(g.windows[type], 'mixer-playlist', {
					paths: playlist.paths.slice(0, 20),
					idx: playlist.idx
				});
			}
			if(type === 'midi' && g.midiSettings){
				tools.sendToId(g.windows[type], 'update-ui', { pitch: g.midiSettings.pitch, speed: g.midiSettings.speed });
			}
			if(type === 'pitchtime'){
				const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
				const currentTime = g.currentAudio ? g.currentAudio.currentTime : 0;
				if(currentFile){
					if(g.currentAudio && !g.currentAudio.paused){
						g.currentAudio.pause();
						checkState();
					}
					const ext = path.extname(currentFile).toLowerCase();
					if(g.supportedMIDI && g.supportedMIDI.includes(ext)){
						tools.sendToId(g.windows[type], 'pitchtime-error', { message: 'MIDI files are not supported in Pitch/Time.' });
					} else {
						tools.sendToId(g.windows[type], 'pitchtime-file', { currentFile, currentTime });
					}
				}
			}
		}
		return;
	}
	
	// Get the stage window's display to open new window on same screen
	let stageBounds = await g.win.getBounds();
	let displays = await helper.screen.getAllDisplays();
	let targetDisplay = displays.find(d => 
		stageBounds.x >= d.bounds.x && 
		stageBounds.x < d.bounds.x + d.bounds.width &&
		stageBounds.y >= d.bounds.y && 
		stageBounds.y < d.bounds.y + d.bounds.height
	) || displays[0];
	
	// Get window settings (merged defaults + user)
	const winSettings = (g.config.windows && g.config.windows[type]) || {};
	
	// Dimensions from config (or fallback)
	let windowWidth = winSettings.width || 960;
	let windowHeight = winSettings.height || 800;
	
	// Calculate center of target display (using workArea to respect taskbars)
	let x = targetDisplay.workArea.x + Math.round((targetDisplay.workArea.width - windowWidth) / 2);
	let y = targetDisplay.workArea.y + Math.round((targetDisplay.workArea.height - windowHeight) / 2);
	
	// Use saved position if available
	if(winSettings.x !== null && winSettings.x !== undefined) x = winSettings.x;
	if(winSettings.y !== null && winSettings.y !== undefined) y = winSettings.y;
	
	const init_data = {
		type: type,
		stageId: await g.win.getId(),
		configName: g.configName,
		config: g.config,
		maxSampleRate: g.maxSampleRate,
		currentSampleRate: g.audioContext.sampleRate,
		ffmpeg_napi_path: g.ffmpeg_napi_path,
		ffmpeg_player_path: g.ffmpeg_player_path,
		ffmpeg_worklet_path: g.ffmpeg_worklet_path,
		ffmpeg_player_sab_path: g.ffmpeg_player_sab_path,
		ffmpeg_worklet_sab_path: g.ffmpeg_worklet_sab_path
	};

	if(type === 'mixer'){
		if(g.currentAudio && !g.currentAudio.paused){
			g.currentAudio.pause();
			checkState();
		}
		const playlist = await getMixerPlaylist(contextFile);
		init_data.playlist = {
			paths: playlist.paths.slice(0, 20),
			idx: playlist.idx
		};
	}

	if(type === 'pitchtime'){
		const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
		const currentTime = g.currentAudio ? g.currentAudio.currentTime : 0;
		const currentVolume = (g.config && g.config.audio && typeof g.config.audio.volume === 'number') ? g.config.audio.volume : 1.0;
		if(currentFile){
			if(g.currentAudio && !g.currentAudio.paused){
				g.currentAudio.pause();
				checkState();
			}
			const ext = path.extname(currentFile).toLowerCase();
			if(g.supportedMIDI && g.supportedMIDI.includes(ext)){
				init_data.pitchtimeError = 'MIDI files are not supported in Pitch/Time.';
			} else {
				init_data.currentFile = currentFile;
				init_data.currentTime = currentTime;
			}
		}
		init_data.currentVolume = currentVolume;
	}

	if(type === 'midi'){
		// Initialize with ephemeral settings if they exist
		init_data.midiPitch = g.midiSettings ? g.midiSettings.pitch : 0;
		
		// Get original BPM if available
		if (midi && midi.getOriginalBPM) {
			init_data.originalBPM = midi.getOriginalBPM();
		} else {
			init_data.originalBPM = 120;
		}

		if (g.midiSettings && g.midiSettings.speed) {
			init_data.midiSpeed = g.midiSettings.speed;
		} else {
			// If no override, try to get current actual BPM from player
			if (midi && midi.getCurrentBPM) {
				const currentBPM = await midi.getCurrentBPM();
				init_data.midiSpeed = Math.round(currentBPM);
			} else {
				init_data.midiSpeed = 120;
			}
		}
	}

	g.windows[type] = await tools.browserWindow('frameless', {
		file: `./html/${type}.html`,
		show: false,
		width: windowWidth,
		height: windowHeight,
		x: x,
		y: y,
		backgroundColor: '#323232',
		init_data: init_data
	});
	
	console.log('[openWindow] Created window:', type, 'id:', g.windows[type]);
	
	// Mark window as visible after creation
	g.windowsVisible[type] = true;
	
	// Show the newly created window with a small delay to prevent white flash
	setTimeout(() => {
		tools.sendToId(g.windows[type], 'show-window');
	}, 100);
}

async function scaleWindow(val){
	const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
	const showControls = (g.config && g.config.ui && g.config.ui.showControls) ? true : false;
	const MIN_H = showControls ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
	let w_scale = MIN_WIDTH / 14;
	let h_scale = MIN_H / 14;
	if(!g.config.windows) g.config.windows = {};
	if(!g.config.windows.main) g.config.windows.main = {};
	let curBounds = await g.win.getBounds();
	if(!curBounds) curBounds = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_H };
	let nb = {
		x: curBounds.x,
		y: curBounds.y,
		width: parseInt(w_scale * val),
		height: parseInt(h_scale * val)
	};
	if(nb.width < MIN_WIDTH) { nb.width = MIN_WIDTH; val = 14 };
	if(nb.height < MIN_H) { nb.height = MIN_H; val = 14 };
	await g.win.setBounds(nb);
	g.config.windows.main = { ...g.config.windows.main, x: nb.x, y: nb.y, width: nb.width, height: nb.height, scale: val|0 };
	ut.setCssVar('--space-base', val);
	g.config_obj.set(g.config);
	// Keep Electron min size in sync with the current UI scale
	const scaledMinW = _scaledDim(MIN_WIDTH, val|0);
	const scaledMinH = _scaledDim(MIN_H, val|0);
	tools.sendToMain('command', { command: 'set-min-height', minHeight: scaledMinH, minWidth: scaledMinW });
}


function fb(o){
    console.log(o);
}

module.exports.init = init;