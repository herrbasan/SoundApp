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
let g = {};
g.test = {};
g.audioContext = null;
g.ffmpegPlayer = null;
g.windows = { help: null, settings: null, playlist: null, mixer: null };
g.windowsVisible = { help: false, settings: false, playlist: false, mixer: false };
g.lastNavTime = 0;
g.mixerPlaying = false;
g.music = [];
g.idx = 0;
g.max = -1;

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

	let default_config = {
		transcode: {
			"ext":".wav",
			"cmd":"-c:a pcm_s16le"
		},
		space:10,
		win_min_width:480,
		win_min_height:217,
		volume: 0.5,
		theme: 'dark',
		hqMode: false,
		bufferSize: 10,
		decoderThreads: 0,
		modStereoSeparation: 100,
		modInterpolationFilter: 0,
		outputDeviceId: '',
		defaultDir: '',
		mixerPreBuffer: 50
	}
	
	g.config_obj = await helper.config.initRenderer('user', async (newData) => {
		const oldBuffer = g.config.bufferSize;
		const oldThreads = g.config.decoderThreads;
		g.config = newData;

		// Broadcast config change to all windows (e.g. Mixer)
		tools.broadcast('config-changed', g.config);

		// If streaming settings changed, perform a clean reset of the player
		if (g.ffmpegPlayer && (oldBuffer !== g.config.bufferSize || oldThreads !== g.config.decoderThreads)) {
			if (g.currentAudio && g.currentAudio.isFFmpeg) {
				console.log('Streaming settings changed, resetting player...');
				const pos = g.ffmpegPlayer.getCurrentTime();
				const wasPlaying = g.ffmpegPlayer.isPlaying;
				
				g.ffmpegPlayer.prebufferSize = g.config.bufferSize || 10;
				g.ffmpegPlayer.threadCount = g.config.decoderThreads || 0;
				
				try {
					await g.ffmpegPlayer.open(g.currentAudio.fp);
					if (pos > 0) g.ffmpegPlayer.seek(pos);
					if (wasPlaying) await g.ffmpegPlayer.play();
				} catch (err) {
					console.error('Failed to reset player after config change:', err);
				}
			} else {
				// Just update parameters for next load
				g.ffmpegPlayer.prebufferSize = g.config.bufferSize || 10;
				g.ffmpegPlayer.threadCount = g.config.decoderThreads || 0;
			}
		}
	});
	g.config = g.config_obj.get();
	if(g.config.volume === undefined) { g.config.volume = 0.5; }
	if(g.config.theme === undefined) { g.config.theme = 'dark'; }
	if(g.config.hqMode === undefined) { g.config.hqMode = false; }
	if(g.config.bufferSize === undefined) { g.config.bufferSize = 10; }
	if(g.config.decoderThreads === undefined) { g.config.decoderThreads = 0; }
	if(g.config.modStereoSeparation === undefined) { g.config.modStereoSeparation = 100; }
	if(g.config.modInterpolationFilter === undefined) { g.config.modInterpolationFilter = 0; }
	if(g.config.outputDeviceId === undefined) { g.config.outputDeviceId = ''; }
	if(g.config.defaultDir === undefined) { g.config.defaultDir = ''; }
	
	// Apply theme at startup
	if(g.config.theme === 'dark') {
		document.body.classList.add('dark');
	} else {
		document.body.classList.remove('dark');
	}
	// Send initial theme to main process
	tools.sendToMain('command', { command: 'set-theme', theme: g.config.theme });
	
	ut.setCssVar('--space-base', g.config.space);

	if(g.config.window){
		if(g.config.window.width && g.config.window.height){
			await g.win.setBounds(g.config.window)
		}
	}
	g.win.show();
	//g.win.transparent
	if(!g.isPackaged) { g.win.toggleDevTools() }
	
	let fp = g.app_path;
	if(g.isPackaged){fp = path.dirname(fp);}

	if(os.platform() == 'linux'){
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/linux_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/linux_bin/player.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-processor.js');
	}
	else {
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/win_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/win_bin/player.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-processor.js');
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
	const targetRate = g.config.hqMode ? g.maxSampleRate : 44100;
	g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });
	console.log('AudioContext sample rate:', g.audioContext.sampleRate);
	
	/* Apply saved output device if configured */
	if (g.config.outputDeviceId) {
		try {
			await g.audioContext.setSinkId(g.config.outputDeviceId);
			console.log('Output device set to:', g.config.outputDeviceId);
		} catch (err) {
			console.error('Failed to set output device, using system default:', err);
			g.config.outputDeviceId = '';
			g.config_obj.set(g.config);
		}
	}

	/* FFmpeg NAPI Player - unified streaming with gapless looping */
	const { FFmpegDecoder, getMetadata } = require(g.ffmpeg_napi_path);
	g.getMetadata = getMetadata;
	const { FFmpegStreamPlayer } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayer.setDecoder(FFmpegDecoder);
	const bufferSize = g.config.bufferSize !== undefined ? g.config.bufferSize : 10;
	const threadCount = g.config.decoderThreads !== undefined ? g.config.decoderThreads : 0;
	g.ffmpegPlayer = new FFmpegStreamPlayer(g.audioContext, g.ffmpeg_worklet_path, bufferSize, threadCount);
	try {
		await g.ffmpegPlayer.init();
	} catch (err) {
		console.error('Failed to initialize FFmpeg player:', err);
	}

	/* Mod Player */
	const modConfig = {
		repeatCount: 0,
		stereoSeparation: g.config.modStereoSeparation !== undefined ? g.config.modStereoSeparation : 100,
		interpolationFilter: g.config.modInterpolationFilter !== undefined ? g.config.modInterpolationFilter : 0,
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
		}
		// Return focus to stage window after small delay to ensure window is gone
		setTimeout(() => g.win.focus(), 50);
	});
	
	ipcRenderer.on('settings-changed', (e, data) => {
		if (data.defaultDir !== undefined) {
			g.config.defaultDir = data.defaultDir;
			g.config_obj.set(g.config);
		}
	});
	
	ipcRenderer.on('set-output-device', async (e, data) => {
		const deviceId = data.deviceId;
		
		// Store in config
		g.config.outputDeviceId = deviceId || '';
		g.config_obj.set(g.config);
		
		// Apply to AudioContext
		try {
			if (deviceId) {
				await g.audioContext.setSinkId(deviceId);
				console.log('Output device changed to:', deviceId);
			} else {
				await g.audioContext.setSinkId('');
				console.log('Output device reset to system default');
			}
		} catch (err) {
			console.error('Failed to set output device:', err);
			// Fallback to default
			g.config.outputDeviceId = '';
			g.config_obj.set(g.config);
			
			// Notify user
			if (g.windows.settings) {
				tools.sendToId(g.windows.settings, 'device-change-failed', {
					error: 'Device not available, using system default'
				});
			}
		}
	});
	
	ipcRenderer.on('set-buffer-size', async (e, data) => {
		const bufferSize = data.bufferSize;
		
		// Store in config
		g.config.bufferSize = bufferSize;
		g.config_obj.set(g.config);
		
		// Update player's prebuffer size (takes effect on next file load)
		if (g.ffmpegPlayer) {
			g.ffmpegPlayer.prebufferSize = bufferSize;
			console.log('Buffer size changed to:', bufferSize, 'chunks');
		}
	});
	
	ipcRenderer.on('set-decoder-threads', async (e, data) => {
		const threadCount = data.threadCount;
		
		// Store in config
		g.config.decoderThreads = threadCount;
		g.config_obj.set(g.config);
		
		// Update player's thread count
		if (g.ffmpegPlayer) {
			const wasPlaying = g.ffmpegPlayer.isPlaying;
			const currentFile = g.ffmpegPlayer.filePath;
			const currentTime = g.ffmpegPlayer.getCurrentTime();
			
			g.ffmpegPlayer.threadCount = threadCount;
			console.log('Decoder threads changed to:', threadCount === 0 ? 'Auto' : threadCount);
			
			// Reload current file if one is loaded to apply new thread count
			if (currentFile) {
				await g.ffmpegPlayer.stop();
				await g.ffmpegPlayer.open(currentFile);
				
				// Restore position and playback state
				if (currentTime > 0) {
					await g.ffmpegPlayer.seek(currentTime);
				}
				if (wasPlaying) {
					await g.ffmpegPlayer.play();
				}
			}
		}
	});
	
	ipcRenderer.on('set-mod-stereo-separation', async (e, data) => {
		const stereoSeparation = data.stereoSeparation;
		
		// Store in config
		g.config.modStereoSeparation = stereoSeparation;
		g.config_obj.set(g.config);
		
		console.log('MOD stereo separation changed to:', stereoSeparation + '%');
		
		// Update running player if playing MOD file
		if (player && g.currentAudio?.isMod) {
			player.setStereoSeparation(stereoSeparation);
		}
	});
	
	ipcRenderer.on('set-mod-interpolation-filter', async (e, data) => {
		const interpolationFilter = data.interpolationFilter;
		
		// Store in config
		g.config.modInterpolationFilter = interpolationFilter;
		g.config_obj.set(g.config);
		
		console.log('MOD interpolation filter changed to:', interpolationFilter);
		
		// Update running player if playing MOD file
		if (player && g.currentAudio?.isMod) {
			player.setInterpolationFilter(interpolationFilter);
		}
	});
	
	ipcRenderer.on('set-mixer-pre-buffer', async (e, data) => {
		if (data.preBuffer !== undefined) {
			g.config.mixerPreBuffer = data.preBuffer;
			await g.config_obj.set(g.config);
			// Broadcast config change to all windows (e.g. Mixer)
			tools.broadcast('config-changed', g.config);
		}
	});

	ipcRenderer.on('toggle-hq-mode', async (e, data) => {
		await toggleHQMode();
		// Send updated sample rate to settings window
		if (g.windows.settings) {
			tools.sendToId(g.windows.settings, 'sample-rate-updated', {
				currentSampleRate: g.audioContext.sampleRate
			});
		}
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
	
	ipcRenderer.on('shortcut', (e, data) => {
		if (data.action === 'toggle-help') {
			openWindow('help');
		}
		else if (data.action === 'toggle-settings') {
			openWindow('settings');
		}
		else if (data.action === 'toggle-mixer') {
			const fp = g.currentAudio ? g.currentAudio.fp : null;
			clearAudio();
			openWindow('mixer', false, fp);
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
		g.config.theme = data.dark ? 'dark' : 'light';
		g.config_obj.set(g.config);
		
		// Broadcast to all open windows
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
	g.scale = window.devicePixelRatio || 1;
	g.body = document.body;
	g.frame = ut.el('.frame');
	g.top = ut.el('.top');
	g.top_num = g.top.el('.num');
	g.top_close = g.top.el('.close')

	g.bottom = ut.el('.bottom');
	g.playhead = ut.el('.playhead');
	g.prog = ut.el('.playhead .prog');
	g.cover = ut.el('.info .cover');
	g.type_band = g.cover.el('.filetype .type');
	g.playtime = ut.el('.playtime .time');
	g.playvolume = ut.el('.playtime .volume span');
	g.playremain = ut.el('.playtime .remain');
	g.top_btn_loop = ut.el('.top .content .loop');
	g.top_btn_playpause = ut.el('.top .content .playpause');

	g.text = ut.el('.info .text');

	g.blocky = false;

	
	g.supportedMpt = ['.mptm', '.mod','.mo3','.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf', 
	'.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus', 
	'.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod', 
	'.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];
	g.supportedChrome = ['.mp3','.wav','.flac','.ogg', '.m4a', '.m4b', '.aac','.webm'];
	g.supportedFFmpeg = ['.mpg','.mp2', '.aif', '.aiff','.aa', '.wma', '.asf', '.ape', '.wv', '.wvc', '.tta', '.mka', 
	'.amr', '.3ga', '.ac3', '.eac3', '.dts', '.dtshd', '.caf', '.au', '.snd', '.voc', '.tak', '.mpc', '.mp+'];


	g.supportedFilter = [...g.supportedChrome, ...g.supportedFFmpeg, ...g.supportedMpt]

	g.music = [];
	g.idx = 0;
	g.isLoop = false;
	setupWindow();
	setupDragDrop();

	let arg = g.start_vars[g.start_vars.length-1];
	
	if(arg != '.' && g.start_vars.length > 1 && arg != '--squirrel-firstrun'){
		await playListFromSingle(arg);
	}
	else {
		if (g.config.defaultDir) {
			await playListFromSingle(g.config.defaultDir);
		}
	}
	
	if(g.music.length > 0){
		
		g.max = g.music.length-1;
		playAudio(g.music[g.idx])
	}

	g.bottom.addEventListener('mousedown', timeline)
	g.top_close.addEventListener('click', app.exit);

	g.top_btn_loop.addEventListener('click', toggleLoop);
	g.top_btn_playpause.addEventListener('click', playPause);

	loop();
	
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
					if(tools.checkFileType(fp, g.supportedFilter)){
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
	g.win.hook_event('resized', handler);
	function handler(e, data){
		//clearDrop();
		if(data.type == 'blur'){
			g.frame.classList.remove('focus');
		}
		if(data.type == 'focus'){
			g.frame.classList.add('focus');
		}
		if(data.type == 'move' || data.type == 'resized'){
			clearTimeout(g.window_move_timeout);
			g.window_move_timeout = setTimeout(async () => {
				let bounds = await g.win.getBounds();
				g.config.window = bounds;
				g.config_obj.set(g.config);
			}, 500)
		}
	}
}

function timeline(e){
	if(e.type == 'mousedown'){
		window.addEventListener('mouseup', timeline);
		window.addEventListener('mousemove', timeline);
		seek(e.clientX);
	}
	if(e.type == 'mousemove'){
		seek(e.clientX);
	}
	if(e.type == 'mouseup'){
		window.removeEventListener('mouseup', timeline);
		window.removeEventListener('mousemove', timeline);
	}
	
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
				if(tools.checkFileType(fp, g.supportedFilter)){
					pl.push(fp);
				}
				else {
					console.log('Unsupported File Type')
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



async function playAudio(fp, n, startPaused = false){
	console.log('playAudio', fp, n, startPaused);
	if(!g.blocky){
		let parse = path.parse(fp);
		let bench = performance.now();
		g.blocky = true;
		clearAudio();

		if(player) { player.stop(); }

		const isTracker = g.supportedMpt.includes(parse.ext.toLocaleLowerCase());

		if(isTracker){
			g.currentAudio = {
				isMod: true, 
				fp: fp, 
				bench: bench, 
				currentTime: 0,
				paused: startPaused, 
				duration: 0,
				play: () =>  { g.currentAudio.paused = false; player.unpause() }, 
				pause: () => { g.currentAudio.paused = true; player.pause() }
			};
			player.load(tools.getFileURL(fp));
			player.gain.gain.value = g.config.volume;
			if(startPaused) {
				// Tracker player auto-plays on load, so we might need to pause immediately or handle it.
				// Chiptune.js usually plays on load. We can try to pause it.
				// However, chiptune.js load is async inside.
				// For now, let's assume checkState() handles the UI, but we might need to explicitly pause.
				// Actually, chiptune.js doesn't have a 'startPaused' option easily.
				// We'll rely on the fact that we can call pause() after load?
				// Or maybe we just accept that trackers might start?
				// Let's try to pause it in the checkState or right after load if possible.
				// But wait, player.load() is void.
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
					volume: g.config.volume,
					play: () => { g.currentAudio.paused = false; ffPlayer.play(); },
					pause: () => { g.currentAudio.paused = true; ffPlayer.pause(); },
					seek: (time) => ffPlayer.seek(time),
					getCurrentTime: () => ffPlayer.getCurrentTime()
				};
				
				ffPlayer.volume = g.config.volume;
				
				if (n > 0) { ffPlayer.seek(n); }
				
				if (!startPaused) {
					await ffPlayer.play();
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
	if(g.ffmpegPlayer) g.ffmpegPlayer.stop();
	if(g.currentAudio){
		if(g.currentAudio.isMod) player.stop();
		g.currentAudio = undefined;
	}
}

function audioEnded(e){
	if(g.currentAudio?.isMod && g.isLoop){
		playAudio(g.music[g.idx]);
	}
	else {
		playNext();
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

function shufflePlaylist(){
	ut.shuffleArray(g.music);
	g.idx = 0;
	playAudio(g.music[g.idx]);
}

function playNext(e){
	if(!g.blocky){
		if(g.idx == g.max){ g.idx = -1; }
		g.idx++;
		playAudio(g.music[g.idx])
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
	checkState();
}

async function toggleHQMode(){
	g.config.hqMode = !g.config.hqMode;
	g.config_obj.set(g.config);
	
	const targetRate = g.config.hqMode ? g.maxSampleRate : 44100;
	console.log('Switching to', g.config.hqMode ? 'Max output sample rate' : 'Standard mode', '(' + targetRate + 'Hz)');
	
	const wasPlaying = !g.currentAudio?.paused;
	const currentFile = g.music[g.idx];
	const wasMod = g.currentAudio?.isMod;
	const currentTime = wasMod ? (player?.getCurrentTime() || 0) : (g.currentAudio?.player?.getCurrentTime() || 0);
	
	// Stop current playback
	if(g.currentAudio){
		if(g.currentAudio.isMod){
			player.stop();
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
	
	const { FFmpegDecoder } = require(g.ffmpeg_napi_path);
	const { FFmpegStreamPlayer } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayer.setDecoder(FFmpegDecoder);
	const bufferSize = g.config.bufferSize !== undefined ? g.config.bufferSize : 10;
	const threadCount = g.config.decoderThreads !== undefined ? g.config.decoderThreads : 0;
	g.ffmpegPlayer = new FFmpegStreamPlayer(g.audioContext, g.ffmpeg_worklet_path, bufferSize, threadCount);
	await g.ffmpegPlayer.init();
	
	const modConfig = {
		repeatCount: 0,
		stereoSeparation: g.config.modStereoSeparation !== undefined ? g.config.modStereoSeparation : 100,
		interpolationFilter: g.config.modInterpolationFilter !== undefined ? g.config.modInterpolationFilter : 0,
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
	
	if(currentFile){
		await playAudio(currentFile);
		if(currentTime > 0 && g.currentAudio){
			if(g.currentAudio.isMod){
				player.seek(currentTime);
			} else if(g.currentAudio.player?.seek){
				await g.currentAudio.player.seek(currentTime);
			}
		}
		if(wasPlaying && g.currentAudio?.play){
			g.currentAudio.play();
		}
	}
	
	checkState();
}

function volumeUp(){
	g.config.volume += 0.05;
	if(g.config.volume > 1) { g.config.volume = 1 }
	if(player) { player.gain.gain.value = g.config.volume; }
	if(g.currentAudio?.isFFmpeg && g.currentAudio.player) {
		g.currentAudio.player.volume = g.config.volume;
	}
	g.config_obj.set(g.config);
}

function volumeDown(){
	g.config.volume -= 0.05;
	if(g.config.volume < 0) { g.config.volume = 0 }
	if(player) { player.gain.gain.value = g.config.volume; }
	if(g.currentAudio?.isFFmpeg && g.currentAudio.player) {
		g.currentAudio.player.volume = g.config.volume;
	}
	g.config_obj.set(g.config);
}


function seek(mx){
	let max = g.bottom.offsetWidth;
	let x = mx - ut.offset(g.bottom).left;
	if(x < 0) { x = 0; }
	if(x > max) { x = max; }
	let proz = x / max;
	seekTo(g.currentAudio.duration * proz);
}

function seekTo(s){
	if(g.currentAudio){
		if(g.currentAudio.isMod){
			player.seek(s);
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
		
		if(g.currentAudio.lastTime != g.currentAudio.currentTime){
			g.currentAudio.lastTime = g.currentAudio.currentTime;
			time = g.currentAudio.currentTime;
			proz = time / g.currentAudio.duration;
			g.prog.style.width = (proz*100) + '%';
			let minsec = ut.playTime(time*1000).minsec;
			if(g.lastMinsec !=  minsec){
				g.playtime.innerText = minsec;
				g.lastMinsec = minsec;
			}
		}
	}
	
	
	if(g.last_vol != g.config.volume){
		g.playvolume.innerText = (Math.round(g.config.volume*100)) + '%';
		g.last_vol = g.config.volume;
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
	}
	else if (shortcutAction === 'toggle-settings') {
		openWindow('settings');
	}
	else if (shortcutAction === 'toggle-theme') {
		tools.sendToMain('command', { command: 'toggle-theme' });
	}
	else if (shortcutAction === 'toggle-mixer') {
		const fp = g.currentAudio ? g.currentAudio.fp : null;
		openWindow('mixer', false, fp);
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
	}

	if (e.keyCode == 27) {
		g.config_obj.set(g.config);
		app.exit();
	}
	if (e.keyCode == 39) {
		if(e.ctrlKey){ seekFore()}
		else { 
			let now = Date.now();
			if(now - g.lastNavTime >= 100){
				g.lastNavTime = now;
				playNext(); 
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
			}
		}
	}
	if (e.keyCode == 38) {
		volumeUp();
	}
	if (e.keyCode == 40) {
		volumeDown();
	}

	if (e.keyCode == 82) {
		shufflePlaylist();
	}
	if (e.keyCode == 73){
		helper.shell.showItemInFolder(g.music[g.idx]);
	}
	
	if(e.keyCode == 32){
		playPause();
	}
	if(e.keyCode == 109 && e.ctrlKey){
		let val = ut.getCssVar('--space-base').value;
		scaleWindow(val-1)
	}
	if(e.keyCode == 107 && e.ctrlKey){
		let val = ut.getCssVar('--space-base').value;
		scaleWindow(val+1)
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
	if (g.windows[type]) {
		// Window exists
		if(forceShow){
			if(!g.windowsVisible[type]){
				tools.sendToId(g.windows[type], 'show-window');
				g.windowsVisible[type] = true;
			} else {
				tools.sendToId(g.windows[type], 'show-window');
			}
			// Always refresh mixer playlist when explicitly opening from Stage actions (e.g. drag&drop)
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
			return;
		}

		// Default behavior: toggle visibility based on tracked state
		if (g.windowsVisible[type]) {
			tools.sendToId(g.windows[type], 'hide-window');
			g.windowsVisible[type] = false;
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
	
	// Window size configurations per type
	const windowSizes = {
		help: { width: 800, height: 700 },
		settings: { width: 500, height: 700 },
		playlist: { width: 960, height: 700 },
		mixer: { width: 1100, height: 760 }
	};
	
	// Position window in center of the same display
	let windowWidth = windowSizes[type]?.width || 960;
	let windowHeight = windowSizes[type]?.height || 800;
	let x = targetDisplay.bounds.x + Math.round((targetDisplay.bounds.width - windowWidth) / 2);
	let y = targetDisplay.bounds.y + Math.round((targetDisplay.bounds.height - windowHeight) / 2);
	
	const init_data = {
		type: type,
		stageId: await g.win.getId(),
		config: g.config,
		maxSampleRate: g.maxSampleRate,
		currentSampleRate: g.audioContext.sampleRate,
		ffmpeg_napi_path: g.ffmpeg_napi_path,
		ffmpeg_player_path: g.ffmpeg_player_path,
		ffmpeg_worklet_path: g.ffmpeg_worklet_path
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

	g.windows[type] = await tools.browserWindow('frameless', {
		file: `./html/${type}.html`,
		show: false,
		width: windowWidth,
		height: windowHeight,
		x: x,
		y: y,
		init_data: init_data
	});
	
	// Mark window as visible after creation
	g.windowsVisible[type] = true;
	
	// Show the newly created window
	tools.sendToId(g.windows[type], 'show-window');
}

async function scaleWindow(val){
	//let bounds = await g.win.getBounds();
	let w_scale = g.config.win_min_width / 10;
	let h_scale = g.config.win_min_height / 10;
	g.config.window.width = parseInt(w_scale * val);
	g.config.window.height = parseInt(h_scale * val);
	if(g.config.window.width < g.config.win_min_width) { g.config.window.width = g.config.win_min_width; val = 10};
	if(g.config.window.height < g.config.win_min_height) { g.config.window.height = g.config.win_min_height; val = 10};
	await g.win.setBounds(g.config.window);
	g.config.space = val;
	ut.setCssVar('--space-base', g.config.space);
	g.config_obj.set(g.config);
}


function fb(o){
    console.log(o);
}

module.exports.init = init;