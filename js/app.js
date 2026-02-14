'use strict';
const { app, protocol, BrowserWindow, Menu, ipcMain, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require("fs").promises;
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const update = require('../libs/electron_helper/update.js');
const squirrel_startup = require('./squirrel_startup.js');
const configDefaults = require('./config-defaults.js');

squirrel_startup().then((ret, cmd) => { if (ret) { app.quit(); return; } init(cmd); });

let main_env = { channel: 'stable' };
let isPackaged = app.isPackaged;
let app_path = app.getAppPath();
let base_path = path.join(app_path);
let user_data = app.getPath('userData');
let wins = {};
let currentTheme = 'dark'; // Default theme, will be updated by stage on startup
let tray = null;
let user_cfg = null;
let isQuitting = false;

// ═══════════════════════════════════════════════════════════
// AUDIO WORKER ARCHITECTURE: State Machine (Phase 2)
// ═══════════════════════════════════════════════════════════

// File type detection (must match engines.js)
const supportedMIDI = ['.mid', '.midi', '.kar', '.rmi'];
const supportedTracker = ['.mptm', '.mod', '.mo3', '.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf',
    '.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus',
    '.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod',
    '.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];

function getFileType(filePath) {
    if (!filePath) return 'FFmpeg';
    const ext = path.extname(filePath).toLowerCase();
    if (supportedMIDI.includes(ext)) return 'MIDI';
    if (supportedTracker.includes(ext)) return 'Tracker';
    return 'FFmpeg';
}

// Ground truth state - lives in main process, outlives both renderers
// ═══════════════════════════════════════════════════════════════════════════
// DEFAULTS - Single source of truth for parameter reset values
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULTS = {
    audio: {
        mode: 'tape',
        tapeSpeed: 0,
        pitch: 0,
        tempo: 1.0,
        formant: false,
        locked: false
    },
    midi: {
        transpose: 0,
        bpm: null,          // null = use original BPM from file
        metronome: false,
        soundfont: null     // null = use default soundfont
    },
    tracker: {
        pitch: 1.0,
        tempo: 1.0,
        stereoSeparation: 100
    }
};

/**
 * Reset audio parameters to defaults.
 * Called when a new file is loaded (unless locked for audio files).
 * 
 * @param {string} fileType - 'MIDI', 'Tracker', or 'FFmpeg' 
 * @param {object} options - Optional values to override defaults (e.g., { originalBPM: 140 })
 * @returns {object} The new parameter values after reset
 */
function resetParamsToDefaults(fileType, options = {}) {
    console.log(`[resetParamsToDefaults] fileType=${fileType}, options=${JSON.stringify(options)}`, 'params');
    
    if (fileType === 'MIDI') {
        audioState.midiParams = {
            ...DEFAULTS.midi,
            bpm: options.originalBPM || DEFAULTS.midi.bpm
        };
        return { ...audioState.midiParams };
    } 
    
    if (fileType === 'Tracker') {
        audioState.trackerParams = { ...DEFAULTS.tracker };
        return { ...audioState.trackerParams };
    }
    
    // FFmpeg audio - only reset if not locked
    if (!audioState.locked) {
        audioState.mode = DEFAULTS.audio.mode;
        audioState.tapeSpeed = DEFAULTS.audio.tapeSpeed;
        audioState.pitch = DEFAULTS.audio.pitch;
        audioState.tempo = DEFAULTS.audio.tempo;
        audioState.formant = DEFAULTS.audio.formant;
        // Note: locked is preserved by design
    }
    
    return {
        mode: audioState.mode,
        tapeSpeed: audioState.tapeSpeed,
        pitch: audioState.pitch,
        tempo: audioState.tempo,
        formant: audioState.formant,
        locked: audioState.locked
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIO STATE - Ground truth for all audio-related state
// ═══════════════════════════════════════════════════════════════════════════
const audioState = {
    // Playback
    file: null,             // Current file path
    isPlaying: false,
    position: 0,            // Seconds (updated from engine)
    duration: 0,
    
    // Audio params (FFmpeg files)
    mode: DEFAULTS.audio.mode,
    tapeSpeed: DEFAULTS.audio.tapeSpeed,
    pitch: DEFAULTS.audio.pitch,
    tempo: DEFAULTS.audio.tempo,
    formant: DEFAULTS.audio.formant,
    locked: DEFAULTS.audio.locked,
    volume: 0.5,
    loop: false,
    
    // Format-specific params (reset on file change unless locked for audio)
    midiParams: { ...DEFAULTS.midi },
    trackerParams: { ...DEFAULTS.tracker },
    
    // Pipeline
    activePipeline: 'normal',   // 'normal' | 'rubberband'
    
    // Engine
    engineAlive: false,
    engineInitializing: false,
    engineDisposalTimeout: null,  // Timer for idle disposal
    isRestoration: false,         // True during engine restoration flow
    isDisposing: false,           // Guard against concurrent disposal
    
    // Playlist
    playlist: [],
    playlistIndex: 0,
    
    // Metadata (for UI)
    metadata: null,
    fileType: null          // 'MIDI' | 'Tracker' | 'FFmpeg'
};

// Engine window reference
let engineWindow = null;
let playerWindow = null;

// Child window tracking (monitoring, parameters, etc.)
// These need to be re-notified to engine after restoration
const childWindows = {
    monitoring: { open: false, windowId: null },
    parameters: { open: false, windowId: null },
    settings: { open: false, windowId: null },
    playlist: { open: false, windowId: null },
    help: { open: false, windowId: null },
    mixer: { open: false, windowId: null }
};

// Waveform cache - survives engine disposal
// Key: file path, Value: { peaksL, peaksR, points, duration, timestamp }
const waveformCache = new Map();
const WAVEFORM_CACHE_MAX_SIZE = 10; // Keep last 10 waveforms

//app.commandLine.appendSwitch('high-dpi-support', 'false');
//app.commandLine.appendSwitch('force-device-scale-factor', '1');
//app.commandLine.appendSwitch('--js-flags', '--experimental-module');
//app.disableHardwareAcceleration();
// Enable SharedArrayBuffer (required for SAB-based streaming player)
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
//protocol.registerSchemesAsPrivileged([{ scheme: 'raum', privileges: { bypassCSP: true, supportFetchAPI:true } }])

async function init(cmd) {
	console.log('APP INIT');

	if (isPackaged) {
		const gotTheLock = app.requestSingleInstanceLock()

		if (!gotTheLock) {
			app.quit()
		}
		else {
			app.on('second-instance', (event, commandLine, workingDirectory) => {
				if (wins.main.webContents) {

					//let argv = commandLine.slice(4);
					let argv = [];
					for (let i = 1; i < commandLine.length; i++) {
						if (commandLine[i].substr(0, 2) != '--') {
							argv.push(commandLine[i]);
						}
					}
					wins.main.webContents.send('main', argv);
					if (!wins.main.isVisible()) wins.main.show();
					if (wins.main.isMinimized()) wins.main.restore();
					wins.main.focus();
				}
			})
		}

		if (process.env.PORTABLE_EXECUTABLE_DIR) {
			base_path = process.env.PORTABLE_EXECUTABLE_DIR;
		}
		else {
			var ar = process.execPath.split(path.sep);
			ar.length -= 2;
			base_path = ar.join(path.sep) + path.sep;
		}
	}

	app.on('before-quit', () => {
		isQuitting = true;
	});

	// Prevent quit when all windows closed if keep-in-tray is enabled
	app.on('window-all-closed', () => {
		// On macOS apps typically stay open; on Windows/Linux we check setting
		if (process.platform === 'darwin') return;
		let keep = false;
		try {
			let cnf = user_cfg ? (user_cfg.get() || {}) : {};
			keep = !!(cnf && cnf.ui && cnf.ui.keepRunningInTray);
		} catch (err) { }
		if (!keep) app.quit();
	});


	let fp = path.join(app_path, 'env.json');
	if ((await helper.tools.fileExists(fp))) {
		let _env = await fs.readFile(fp, 'utf8');
		main_env = JSON.parse(_env);
	}
	setEnv();

	main_env.base_path = base_path;
	main_env.user_data = user_data;
	main_env.app_path = app_path;
	main_env.startType = 'Dev'
	main_env.app_name = app.getName();
	main_env.app_version = app.getVersion();
	main_env.app_exe = process.execPath;
	main_env.argv = process.argv[1];

	if (base_path.includes('AppData')) {
		if (base_path.includes('Local')) {
			main_env.startType = 'Installed';
			let name = path.basename(main_env.app_exe);
			main_env.app_exe = path.resolve(path.dirname(main_env.app_exe), '..', name);
		}
		else {
			main_env.startType = 'Portable';
		}
	}

}


function setEnv() {
	console.log('APP SET_ENV');
	console.log('--------------------------------------');
	process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;
	helper.setGlobal('main_env', main_env);
	helper.setGlobal('isPackaged', isPackaged);
	helper.setGlobal('base_path', base_path);
	helper.setGlobal('temp_path', path.join(app.getPath('userData'), 'temp'));
	helper.setGlobal('start_vars', process.argv);

	console.log('Electron Version: ' + process.versions.electron);
	console.log('Node Version: ' + process.versions.node);
	console.log('Chrome Version: ' + process.versions.chrome);
	console.log('--------------------------------------');

	app.whenReady().then(appStart).catch((err) => { throw err });
}


// ═══════════════════════════════════════════════════════════
// FREEZE/THAW ARCHITECTURE: Control window for 0% CPU mode
// The control window stays alive while player window can be closed/reopened
// ═══════════════════════════════════════════════════════════
async function appStart() {
	console.log('Init Windows');
	app.on('before-quit', () => { isQuitting = true; });
	// Optional config activity logging (temporary debugging aid)
	// Enable via env.json: { "config_log": true } or env var: ELECTRON_HELPER_CONFIG_LOG=1
	if (main_env && (main_env.config_log || main_env.configLog)) {
		process.env.ELECTRON_HELPER_CONFIG_LOG = '1';
	}
	const configLog = (process.env.ELECTRON_HELPER_CONFIG_LOG === '1' || process.env.ELECTRON_HELPER_CONFIG_LOG === 'true');

	// Initialize config on main process
	// NOTE: We intentionally do not migrate older structures.
	// If config structure changes, the recommended path is to delete user.json and let defaults recreate it.

	// Development: start with defaults without touching argv parsing
	// Enable via env.json: { "startWithDefaults": true }
	// OR via command line: --defaults or --no-config
	// - false: normal behavior (uses user.json)
	// - true: uses user_temp.json (fresh defaults for testing)
	const hasDefaultsFlag = process.argv.includes('--defaults') || process.argv.includes('--no-config');
	const startWithDefaults = hasDefaultsFlag || !!(main_env && (main_env.startWithDefaults || main_env.start_with_defaults));
	const configName = startWithDefaults ? 'user_temp' : 'user';
	if (startWithDefaults) {
		console.log('startWithDefaults enabled: using temporary config user_temp.json');
	}
	main_env.configName = configName;

	// If defaults mode is active, reset user_temp.json to config-defaults.js
	if (startWithDefaults) {
		const configPath = path.join(user_data, 'user_temp.json');
		try {
			await fs.writeFile(configPath, JSON.stringify(configDefaults, null, 2), 'utf8');
			console.log('Defaults mode: Reset user_temp.json from config-defaults.js');
		} catch (err) {
			console.log('Warning: Could not write user_temp.json:', err.message);
		}
	}

	user_cfg = await helper.config.initMain(configName, configDefaults, { log: configLog });

	// Determine initial minHeight based on showControls setting
	const cfg = user_cfg ? user_cfg.get() : {};
	const showControls = (cfg && cfg.ui && cfg.ui.showControls !== undefined) ? cfg.ui.showControls : true;
	const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = configDefaults.WINDOW_DIMENSIONS;
	let scale = 14;
	try {
		if (cfg && cfg.windows && cfg.windows.main && cfg.windows.main.scale !== undefined) scale = cfg.windows.main.scale | 0;
	} catch (e) { }
	if (scale < 14) scale = 14;
	const baseMinH = showControls ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
	const scaledMinW = Math.max(MIN_WIDTH, Math.round((MIN_WIDTH / 14) * scale));
	const scaledMinH = Math.max(baseMinH, Math.round((baseMinH / 14) * scale));
	const initialMinHeight = scaledMinH;
	const initialHeight = scaledMinH;

	wins.main = await helper.tools.browserWindow('default', {
		frame: false,
		minWidth: scaledMinW,
		minHeight: initialMinHeight,
		width: scaledMinW,
		height: initialHeight,
		show: false,
		resizable: false,
		maximizable: false,
		devTools: false,
		transparent: false,
		backgroundColor: '#323232',
		file: 'html/player.html',
		webPreferences: {
			navigateOnDragDrop: true
		}
	})

	// Opt-in: keep running in tray (hide main window on close)
	try {
		wins.main.on('close', (e) => {
			if (isQuitting) return;
			let keep = false;
			try {
				let cnf = user_cfg ? (user_cfg.get() || {}) : {};
				keep = !!(cnf && cnf.ui && cnf.ui.keepRunningInTray);
			} catch (err) { }
			if (!keep) return;
			e.preventDefault();
			try { wins.main.hide(); } catch (err) { }
			// Phase 4: Schedule engine disposal when hidden to tray
			scheduleEngineDisposal();
		});

		wins.main.on('closed', () => {
			let keep = false;
			try {
				let cnf = user_cfg ? (user_cfg.get() || {}) : {};
				keep = !!(cnf && cnf.ui && cnf.ui.keepRunningInTray);
			} catch (err) { }
			if (!keep) app.quit();
		});
		
		// Phase 4: Restore engine when window becomes visible
		wins.main.on('show', () => {
			cancelEngineDisposal();
			restoreEngineIfNeeded();
		});
		
		wins.main.on('restore', () => {
			cancelEngineDisposal();
			restoreEngineIfNeeded();
		});
		
		// Track user activity to prevent idle disposal
		wins.main.on('focus', () => {
			recordUserActivity();
		});
		
		wins.main.webContents.on('did-focus', () => {
			recordUserActivity();
		});
		
	} catch (err) { }

	createTray();
	
	// Setup Audio Worker IPC (Phase 2)
	setupAudioIPC();

	ipcMain.handle('command', mainCommand);
	
	let currentWaveformWorker = null;
	let currentWaveformFile = null;
	
	ipcMain.handle('extract-waveform', async (event, data) => {
		const { Worker } = require('worker_threads');
		
		// Abort any existing worker - send abort signal and schedule cleanup
		// Native FFmpeg code creates TypedArrays before calling JS callback,
		// so terminate() during processing causes NAPI fatal error
		if (currentWaveformWorker) {
			const oldWorker = currentWaveformWorker;
			oldWorker.postMessage('abort');
			
			// Safety: force-terminate after 2 seconds if worker doesn't exit
			// (Worker should exit within ~100ms after abort, but this prevents leaks)
			setTimeout(() => {
				try {
					oldWorker.removeAllListeners();
					oldWorker.terminate();
				} catch (err) {
					// Already exited
				}
			}, 2000);
		}
		
		return new Promise((resolve) => {
			const worker = new Worker(data.workerPath, {
				workerData: {
					filePath: data.filePath,
					binPath: data.binPath,
					numPoints: data.numPoints || 300,
					chunkSizeMB: data.chunkSizeMB || 10
				}
			});
			
			currentWaveformWorker = worker;
			currentWaveformFile = data.filePath;
			let resolved = false;
			
			const cleanup = () => {
				if (currentWaveformWorker === worker) {
					currentWaveformWorker = null;
					currentWaveformFile = null;
				}
				// Remove all event listeners to allow GC
				worker.removeAllListeners();
				// Terminate only after worker has exited naturally
				setTimeout(() => {
					try { worker.terminate(); } catch (err) {}
				}, 100);
			};
			
			worker.on('message', (msg) => {
				// Ignore messages if this worker was replaced
				if (currentWaveformWorker !== worker) {
					if (!resolved) {
						resolved = true;
						resolve({ aborted: true, complete: true });
					}
					return;
				}
				
				if (msg.error || msg.complete) {
					if (!resolved) {
						resolved = true;
						resolve(msg);
					}
					cleanup();
				} else {
					// Progressive chunk - only send if still current
					if (currentWaveformFile === data.filePath) {
						event.sender.send('waveform-chunk', msg);
					}
				}
			});
			
			worker.on('error', (err) => {
				if (!resolved) {
					resolved = true;
					resolve({ error: err.message, complete: true });
				}
				cleanup();
			});
			
			worker.on('exit', (code) => {
				if (!resolved) {
					resolved = true;
					resolve({ aborted: true, complete: true });
				}
				cleanup();
			});
		});
	});
	Menu.setApplicationMenu(null);
	if (main_env?.channel != 'dev') {
		setTimeout(checkUpdate, 1000);
	}
}

function createTray() {
	if (tray) return;
	let iconPath = null;
	if (process.platform === 'win32') {
		// In packaged app, extraResource files go to process.resourcesPath/icons/
		// In dev, they're at app_path/build/icons/
		if (isPackaged) {
			iconPath = path.join(process.resourcesPath, 'icons', 'app.ico');
		} else {
			iconPath = path.join(app_path, 'build', 'icons', 'app.ico');
		}
	}
	else {
		if (isPackaged) {
			iconPath = path.join(process.resourcesPath, 'icons', 'app.ico');
		} else {
			iconPath = path.join(app_path, 'build', 'icons', 'app.ico');
		}
	}

	let img = null;
	try {
		img = nativeImage.createFromPath(iconPath);
		if (img && img.isEmpty && img.isEmpty()) img = null;
	} catch (e) {
		img = null;
	}
	if (!img) {
		console.log('Tray icon not created (icon missing): ' + iconPath);
		return;
	}

	tray = new Tray(img);
	tray.setToolTip('SoundApp');

	const contextMenu = Menu.buildFromTemplate([
		{ label: 'Show', click: async () => { 
			try { 
				if (wins.main) {
					wins.main.show(); 
					wins.main.focus();
					// Phase 4: Cancel disposal and restore engine if needed
					cancelEngineDisposal();
					await restoreEngineIfNeeded();
				}
			} catch (e) { } 
		} },
		{ label: 'Reset Windows', click: () => { resetAllWindows(); } },
		{ type: 'separator' },
		{ label: 'Quit', click: () => { app.quit(); } }
	]);
	tray.setContextMenu(contextMenu);
	tray.on('click', async () => {
		try { 
			if (wins.main) {
				wins.main.show(); 
				wins.main.focus();
				// Phase 4: Cancel disposal and restore engine if needed
				cancelEngineDisposal();
				await restoreEngineIfNeeded();
			}
		} catch (e) { }
	});
}

async function resetAllWindows() {
	try {
		if (!user_cfg) {
			console.log('Reset Windows: config not initialized');
			return;
		}
		const cnf = user_cfg.get() || {};
		if (!cnf.windows) cnf.windows = {};

		const primary = screen.getPrimaryDisplay();
		const wa = primary && primary.workArea ? primary.workArea : { x: 0, y: 0, width: 1024, height: 768 };

		const defaults = (configDefaults && configDefaults.windows) ? configDefaults.windows : {};
		const keys = new Set([
			...Object.keys(defaults || {}),
			...Object.keys(cnf.windows || {})
		]);

		for (const k of keys) {
			const d = defaults[k] || cnf.windows[k] || {};
			const w = d.width | 0;
			const h = d.height | 0;
			if (w <= 0 || h <= 0) continue;
			const nx = wa.x + Math.round((wa.width - w) / 2);
			const ny = wa.y + Math.round((wa.height - h) / 2);
			cnf.windows[k] = { ...cnf.windows[k], x: nx, y: ny, width: w, height: h };
		}

		user_cfg.set(cnf);

		// Apply to main window immediately
		try {
			if (wins.main && cnf.windows && cnf.windows.main) {
				wins.main.setBounds(cnf.windows.main);
			}
		} catch (e) { }

		// Ask renderer windows to reposition themselves
		try { tools.broadcast('windows-reset', cnf.windows); } catch (e) { }
		console.log('Reset Windows: done');
	} catch (err) {
		console.error('Reset Windows failed:', err);
	}
}

async function checkUpdate() {
	console.log('Checking for updates');
	let check = await update.checkVersion('herrbasan/SoundApp', 'git', true);
	if (check.status && check.isNew) {
		console.log('Update available: v' + check.remote_version);
		update.init({ mode: 'splash', url: 'herrbasan/SoundApp', source: 'git', progress: update_progress, check: check, useSemVer: true })
	}
	else {
		console.log('No updates available');
	}
}

function update_progress(e) {
	// Progress updates handled silently
}

function mainCommand(e, data) {
	if (data.command === 'toggle-theme') {
		// Toggle theme state
		currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
		let isDark = currentTheme === 'dark';
		// Broadcast new theme to all windows
		tools.broadcast('theme-changed', { dark: isDark });
	}
	else if (data.command === 'set-theme') {
		// Stage sends initial theme on startup
		currentTheme = data.theme;
	}
	else if (data.command === 'set-min-height') {
		// Dynamically adjust main window min height for controls toggle
		if (wins.main && data.minHeight) {
			const minW = (data.minWidth !== undefined && data.minWidth !== null) ? (data.minWidth | 0) : 480;
			wins.main.setMinimumSize(minW, data.minHeight | 0);
		}
	}
	return true;
}

// ═══════════════════════════════════════════════════════════
// AUDIO ENGINE LIFECYCLE
// ═══════════════════════════════════════════════════════════

async function createEngineWindow(options = {}) {
    if (engineWindow) return;
    if (audioState.engineInitializing) return;
    
    audioState.engineInitializing = true;
    console.log('[] ');
    
    try {
        engineWindow = await helper.tools.browserWindow('default', {
            frame: false,
            show: false,           // Hidden window
            width: 400,
            height: 300,
            resizable: false,
            maximizable: false,
            devTools: true, // Enabled for debugging
            transparent: false,
            backgroundColor: '#1a1a1a',
            file: 'html/engines.html',
            webPreferences: {
                navigateOnDragDrop: false,
                backgroundThrottling: false  // Keep engine running when hidden
            }
        });
        
        // Track engine state
        engineWindow.on('closed', () => {
            audioState.engineAlive = false;
            audioState.engineInitializing = false;
            engineWindow = null;
            console.log('[] ');
        });
        
        engineWindow.on('ready-to-show', () => {
            console.log('[] ');
        });
        
        // Wait for engine:ready signal
        ipcMain.once('engine:ready', () => {
            audioState.engineAlive = true;
            audioState.engineInitializing = false;
            console.log('[] ');
            
            // Skip auto-load when restoreEngineIfNeeded will handle it
            if (!options.skipAutoLoad && audioState.file) {
                sendToEngine('cmd:load', {
                    file: audioState.file,
                    position: audioState.position,
                    paused: !audioState.isPlaying
                });
            }
        });
        
    } catch (err) {
        console.log('Failed to create engine window: ' + err.message, 'engine');
        audioState.engineInitializing = false;
        engineWindow = null;
    }
}

// ═══════════════════════════════════════════════════════════
// ENGINE DISPOSAL / RESTORATION (Phase 4: 0% CPU when idle)
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// IDLE DISPOSAL CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const IDLE_DISPOSE_TIMEOUT_MS = 5000;        // 5s when hidden to tray
const IDLE_DISPOSE_VISIBLE_TIMEOUT_MS = 10000; // 10s when visible but paused

// Idle state tracking
let idleState = {
    lastActivityTime: Date.now(),
    visibleDisposeTimeout: null
};

// State-debug action tracking
// Debug logging - outputs to console for development debugging
function logStateDebugAction(action, detail = '') {
    console.log(`[StateDebug] ${action}: ${detail}`);
}

function shouldDisposeEngine() {
    // Dispose when: (window hidden to tray OR idle timeout reached) AND playback paused
    if (audioState.isPlaying) return false;
    
    const isWindowVisible = wins.main && wins.main.isVisible() && !wins.main.isMinimized();
    
    // Always dispose when hidden to tray
    if (!isWindowVisible) return true;
    
    // Dispose when visible but idle for too long
    const idleTime = Date.now() - idleState.lastActivityTime;
    return idleTime >= IDLE_DISPOSE_VISIBLE_TIMEOUT_MS;
}

function recordUserActivity() {
    // Called on any user interaction that should reset idle timer
    idleState.lastActivityTime = Date.now();
    
    // If we have a visible-idle timeout pending, cancel and reschedule
    if (idleState.visibleDisposeTimeout) {
        clearTimeout(idleState.visibleDisposeTimeout);
        idleState.visibleDisposeTimeout = null;
        scheduleVisibleIdleDisposal();
    }
}

function scheduleEngineDisposal() {
    // Clear any existing timeout
    if (audioState.engineDisposalTimeout) {
        clearTimeout(audioState.engineDisposalTimeout);
        audioState.engineDisposalTimeout = null;
    }
    
    // Only schedule if engine exists and should be disposed
    if (!engineWindow || !shouldDisposeEngine()) return;
    
    const isWindowVisible = wins.main && wins.main.isVisible() && !wins.main.isMinimized();
    const timeoutMs = isWindowVisible ? IDLE_DISPOSE_VISIBLE_TIMEOUT_MS : IDLE_DISPOSE_TIMEOUT_MS;
    
    console.log(`Scheduling engine disposal in ${timeoutMs}ms... (visible: ${isWindowVisible})`, 'engine');
    
    audioState.engineDisposalTimeout = setTimeout(() => {
        audioState.engineDisposalTimeout = null;
        if (shouldDisposeEngine()) {
            disposeEngineWindow();
        }
    }, timeoutMs);
}

function scheduleVisibleIdleDisposal() {
    // Schedule disposal for visible-but-idle state
    if (!engineWindow || audioState.isPlaying) return;
    
    const isWindowVisible = wins.main && wins.main.isVisible() && !wins.main.isMinimized();
    if (!isWindowVisible) return; // Only for visible window
    
    // Cancel any existing visible timeout
    if (idleState.visibleDisposeTimeout) {
        clearTimeout(idleState.visibleDisposeTimeout);
    }
    
    idleState.visibleDisposeTimeout = setTimeout(() => {
        idleState.visibleDisposeTimeout = null;
        if (shouldDisposeEngine()) {
            console.log('[] ');
            disposeEngineWindow();
        }
    }, IDLE_DISPOSE_VISIBLE_TIMEOUT_MS);
}

function cancelEngineDisposal() {
    if (audioState.engineDisposalTimeout) {
        clearTimeout(audioState.engineDisposalTimeout);
        audioState.engineDisposalTimeout = null;
        console.log('[] ');
    }
    if (idleState.visibleDisposeTimeout) {
        clearTimeout(idleState.visibleDisposeTimeout);
        idleState.visibleDisposeTimeout = null;
    }
}

function disposeEngineWindow() {
    if (!engineWindow) return;
    
    // Guard against concurrent disposal (both timers firing simultaneously)
    if (audioState.isDisposing) return;
    audioState.isDisposing = true;
    
    // Cancel any pending disposal timeout
    cancelEngineDisposal();
    
    console.log('[] ');
    logStateDebugAction('engine-disposed', 'Engine disposed (0% CPU mode)');
    audioState.engineAlive = false;
    
    try {
        engineWindow.destroy();  // Force close without events
    } catch (err) {
        console.log('Error disposing engine: ' + err.message, 'engine');
    }
    
    engineWindow = null;
}

async function restoreEngineIfNeeded() {
    // Restore engine when window becomes visible and we have state to restore
    console.log(`[DEBUG] restoreEngineIfNeeded called, engineAlive=${audioState.engineAlive}, file=${audioState.file ? path.basename(audioState.file) : 'null'}`, 'engine');
    if (audioState.engineAlive) {
        console.log('[] ');
        return true;
    }
    if (!audioState.file) {
        console.log('[] ');
        return false;
    }
    
    // Mark that we're in restoration flow - audio:loaded handler uses this
    audioState.isRestoration = true;
    
    // Reset disposal guard since we're creating a new engine
    audioState.isDisposing = false;
    
    console.log('[] ');
    const startTime = Date.now();
    
    try {
        // skipAutoLoad: we control the cmd:load with restore flag
        await createEngineWindow({ skipAutoLoad: true });
        
        // Wait for engine to be ready (engine:ready event sets engineAlive)
        let waitMs = 0;
        const maxWaitMs = 1000;
        while (!audioState.engineAlive && waitMs < maxWaitMs) {
            await new Promise(r => setTimeout(r, 10));
            waitMs += 10;
        }
        
        if (!audioState.engineAlive) {
            console.log('[] ');
            return false;
        }
        
        // ── Step 0: Reset audioState to defaults ──
        // FFmpeg: reset only if locked=false
        // MIDI/Tracker: always reset (no lock feature)
        const shouldReset = audioState.fileType === 'FFmpeg' ? !audioState.locked : true;
        if (shouldReset) {
            console.log(`Resetting ${audioState.fileType} params to defaults`, 'params');
            resetParamsToDefaults(audioState.fileType, audioState.metadata);
        }
        
        // ── Step 1: Pre-set audio params on engine BEFORE file load ──
        // This ensures g.audioParams has the correct values (including locked)
        // when playAudio() runs, so pipeline routing and settings are correct.
        // Include parametersOpen so rubberband activates for pitchtime mode.
        sendToEngine('cmd:setParams', {
            mode: audioState.mode,
            tapeSpeed: audioState.tapeSpeed,
            pitch: audioState.pitch,
            tempo: audioState.tempo,
            formant: audioState.formant,
            locked: audioState.locked,
            volume: audioState.volume,
            loop: audioState.loop,
            parametersOpen: childWindows.parameters.open
        });
        
        // ── Step 2: Push window IDs to engine ──
        // Main process owns window IDs. Engine only pushes data, never queries.
        // We send ALL existing window IDs (not just visible) so engine can push to them.
        const newEngineId = engineWindow.id;
        const existingWindows = {};
        for (const [type, state] of Object.entries(childWindows)) {
            if (state.windowId) {
                existingWindows[type] = {
                    windowId: state.windowId,
                    open: state.open
                };
                // Update child window's stageId to point to the new engine
                const childWin = BrowserWindow.fromId(state.windowId);
                if (childWin && !childWin.isDestroyed()) {
                    childWin.webContents.send('update-stage-id', { stageId: newEngineId });
                }
            }
        }
        
        // Single IPC call to register all windows with engine
        console.log(`[DEBUG] Pushing window IDs to restored engine: ${JSON.stringify(existingWindows)}`, 'engine');
        sendToEngine('windows:init', { windows: existingWindows });
        
        // ── Step 3: Load file with restore flag ──
        // The restore flag tells playAudio() to:
        // - Use pre-set g.audioParams as-is (no reset)
        // - Apply settings regardless of locked state
        // - Skip sending set-mode to params window (we handle that)
        const fileLoadedPromise = new Promise((resolve) => {
            const onLoaded = (e, data) => {
                if (data.file === audioState.file) {
                    ipcMain.removeListener('audio:loaded', onLoaded);
                    resolve(data);
                }
            };
            ipcMain.once('audio:loaded', onLoaded);
            setTimeout(() => {
                ipcMain.removeListener('audio:loaded', onLoaded);
                resolve(null);
            }, 2000);
        });
        
        sendToEngine('cmd:load', {
            file: audioState.file,
            position: audioState.position,
            paused: !audioState.isPlaying
        });
        
        console.log('[] ');
        const loadedData = await fileLoadedPromise;
        
        // CRITICAL: Update audioState.fileType from the loaded data BEFORE calling sendParamsToParametersWindow
        // This ensures the correct tab is shown in the parameters window after engine restoration
        if (loadedData && loadedData.fileType) {
            audioState.fileType = loadedData.fileType;
            console.log(`[DEBUG] Updated audioState.fileType from loadedData: ${audioState.fileType}`, 'params');
        }
        
        // ── Step 4: Apply params to active players after load ──
        // cmd:applyParams applies state to players (unlike cmd:setParams which sets globals)
        sendToEngine('cmd:applyParams', {
            mode: audioState.mode,
            tapeSpeed: audioState.tapeSpeed,
            pitch: audioState.pitch,
            tempo: audioState.tempo,
            formant: audioState.formant,
            transpose: audioState.midiParams.transpose,
            bpm: audioState.midiParams.bpm,
            metronome: audioState.midiParams.metronome
        });
        
        // Tracker params applied via cmd:applyParams
        if (audioState.fileType === 'Tracker') {
            console.log('[] ');
            sendToEngine('cmd:applyParams', {
                pitch: audioState.trackerParams.pitch,
                tempo: audioState.trackerParams.tempo,
                stereoSeparation: audioState.trackerParams.stereoSeparation
            });
        }
        
        // ── Step 4b: Start monitoring if window is open ──
        if (childWindows.monitoring.open) {
            console.log('[] ');
            sendToEngine('window-visible', { type: 'monitoring', windowId: childWindows.monitoring.windowId });
        }
        
        // ── Step 5: Update parameters window UI ──
        // NOTE: sendParamsToParametersWindow is now called by the unified audio:loaded handler
        // This ensures single source of truth for parameters window tab switching
        // We only need to pass reset flag if we reset params in Step 0
        if (didResetParams) {
            console.log(`[DEBUG] Sending reset=true to parameters window after restoration`, 'params');
            sendParamsToParametersWindow(true);
        }
        
        const elapsed = Date.now() - startTime;
        console.log(`Engine restored in ${elapsed}ms`, 'engine');
        audioState.isRestoration = false; // Clear restoration flag on success
        return true;
        
    } catch (err) {
        console.log('Failed to restore engine: ' + err.message, 'engine');
        audioState.isRestoration = false; // Clear restoration flag on failure
        return false;
    }
}

function sendToEngine(channel, data) {
    if (!engineWindow || engineWindow.isDestroyed()) {
        console.log(`sendToEngine(${channel}): engine window not available`, 'engine');
        return false;
    }
    try {
        engineWindow.webContents.send(channel, data);
        console.log(`sendToEngine(${channel}): sent`, 'engine');
        return true;
    } catch (err) {
        console.log(`sendToEngine(${channel}): failed - ${err.message}`, 'engine');
        return false;
    }
}

function sendToPlayer(channel, data) {
    // Send to player window (player.html)
    if (!wins.main || wins.main.isDestroyed()) return false;
    try {
        wins.main.webContents.send(channel, data);
        return true;
    } catch (err) {
        return false;
    }
}

function sendParamsToParametersWindow(reset = false) {
    // Send current params directly to parameters window if it exists
    // Window may be hidden (open=false) but still exist - send params anyway
    console.log(`[DEBUG] sendParamsToParametersWindow called, reset=${reset}`, 'params');
    console.log(`[DEBUG] childWindows.parameters: open=${childWindows.parameters.open}, windowId=${childWindows.parameters.windowId}`, 'params');
    console.log(`[DEBUG] audioState.fileType: ${audioState.fileType}`, 'params');
    
    if (!childWindows.parameters.windowId) {
        console.log(`[DEBUG] Early return: no windowId (window doesn't exist)`, 'params');
        return;
    }
    
    const fileType = audioState.fileType;
    console.log(`[DEBUG] Sending params for fileType: ${fileType}`, 'params');
    let paramsData = null;
    
    if (fileType === 'MIDI') {
        // Include originalBPM from metadata if available (for UI display)
        const originalBPM = audioState.metadata?.originalBPM;
        paramsData = {
            mode: 'midi',
            params: {
                transpose: audioState.midiParams.transpose,
                bpm: audioState.midiParams.bpm,
                metronome: audioState.midiParams.metronome,
                soundfont: audioState.midiParams.soundfont,
                originalBPM: originalBPM,
                reset
            }
        };
    } else if (fileType === 'Tracker') {
        // Include channel count from metadata if available
        const channels = audioState.metadata?.channels;
        paramsData = {
            mode: 'tracker',
            params: {
                pitch: audioState.trackerParams.pitch,
                tempo: audioState.trackerParams.tempo,
                stereoSeparation: audioState.trackerParams.stereoSeparation,
                channels: channels,
                reset
            }
        };
    } else {
        // Default to audio params (FFmpeg or no file loaded)
        paramsData = {
            mode: 'audio',
            params: {
                audioMode: audioState.mode,
                tapeSpeed: audioState.tapeSpeed,
                pitch: audioState.pitch,
                tempo: audioState.tempo,
                formant: audioState.formant,
                locked: audioState.locked,
                reset
            }
        };
    }
    
    if (paramsData) {
        console.log(`Sending params to parameters window: ${paramsData.mode}`, 'params');
        // Send directly to parameters window using tools helper
        try {
            tools.sendToId(childWindows.parameters.windowId, 'set-mode', paramsData);
        } catch (err) {
            console.log(`Failed to send params to parameters window: ${err.message}`, 'params');
        }
    }
}

function broadcastState(excludeEngine = false) {
    const stateUpdate = {
        file: audioState.file,
        isPlaying: audioState.isPlaying,
        position: audioState.position,
        duration: audioState.duration,
        mode: audioState.mode,
        tapeSpeed: audioState.tapeSpeed,
        pitch: audioState.pitch,
        tempo: audioState.tempo,
        formant: audioState.formant,
        locked: audioState.locked,
        volume: audioState.volume,
        loop: audioState.loop,
        activePipeline: audioState.activePipeline,
        metadata: audioState.metadata,
        fileType: audioState.fileType
    };
    
    // Send to player window
    sendToPlayer('state:update', stateUpdate);
    
    // Optionally send to other windows (settings, monitoring, etc.)
    // via tools.broadcast if needed
}

// ═══════════════════════════════════════════════════════════
// IPC HANDLERS (AUDIO WORKER ARCHITECTURE)
// ═══════════════════════════════════════════════════════════

function setupAudioIPC() {
    // Commands from player UI → forward to engine
    ipcMain.on('audio:play', async () => {
        // Record activity to reset idle timers
        recordUserActivity();
        logStateDebugAction('play', audioState.engineAlive ? 'Play (engine alive)' : 'Play (engine was disposed, restoring...)');
        
        audioState.isPlaying = true;
        // Phase 4: Cancel any pending disposal
        cancelEngineDisposal();
        
        // If engine was disposed, restore it first
        if (!audioState.engineAlive) {
            console.log('[] ');
            const restored = await restoreEngineIfNeeded();
            if (!restored) {
                console.log('[] ');
                audioState.isPlaying = false;
                broadcastState();
                return;
            }
        }
        
        sendToEngine('cmd:play');
        broadcastState();
    });
    
    ipcMain.on('audio:pause', () => {
        logStateDebugAction('pause', 'Playback paused');
        audioState.isPlaying = false;
        sendToEngine('cmd:pause');
        broadcastState();
        // Phase 4: Schedule disposal after pausing
        scheduleEngineDisposal();
        // Also schedule visible idle disposal (in case window stays visible)
        scheduleVisibleIdleDisposal();
    });
    
    ipcMain.on('audio:seek', async (e, data) => {
        // Record activity
        recordUserActivity();
        
        if (data && typeof data.position === 'number') {
            audioState.position = data.position;
            
            // If engine was disposed, restore it first
            if (!audioState.engineAlive && audioState.file) {
                console.log('[] ');
                const restored = await restoreEngineIfNeeded();
                if (!restored) {
                    console.log('[] ');
                    return;
                }
                // After restoration, the engine loads at the current position
                // No need to send separate seek
                return;
            }
            
            sendToEngine('cmd:seek', { position: data.position });
        }
    });
    
    ipcMain.on('audio:load', async (e, data) => {
        if (!data || !data.file) return;
        
        // Phase 4: Cancel any pending disposal when loading new content
        cancelEngineDisposal();
        
        audioState.file = data.file;
        audioState.position = data.position || 0;
        audioState.isPlaying = !data.paused;
        audioState.duration = 0;
        audioState.metadata = null;
        
        if (!audioState.engineAlive) {
            // skipAutoLoad: we control the cmd:load after setting params
            await createEngineWindow({ skipAutoLoad: true });
            
            // Wait for engine to be ready
            let waitMs = 0;
            const maxWaitMs = 1000;
            while (!audioState.engineAlive && waitMs < maxWaitMs) {
                await new Promise(r => setTimeout(r, 10));
                waitMs += 10;
            }
            
            if (!audioState.engineAlive) {
                console.log('[] ');
                return;
            }
            
            // ── Reset params if locked=false ──
            // When locked is OFF, file change should reset to tape/speed 0
            if (!audioState.locked) {
                console.log('[] ');
                audioState.mode = 'tape';
                audioState.tapeSpeed = 0;
                audioState.pitch = 0;
                audioState.tempo = 1.0;
                audioState.formant = false;
            }
            
            // Send params BEFORE loading file (so playAudio uses correct mode)
            // Include parametersOpen so rubberband activates for pitchtime mode
            sendToEngine('cmd:setParams', {
                mode: audioState.mode,
                tapeSpeed: audioState.tapeSpeed,
                pitch: audioState.pitch,
                tempo: audioState.tempo,
                formant: audioState.formant,
                locked: audioState.locked,
                volume: audioState.volume,
                loop: audioState.loop,
                parametersOpen: childWindows.parameters.open
            });
            
                // Update parameters window UI if we reset
            if (!audioState.locked && childWindows.parameters.open) {
                sendParamsToParametersWindow(true);
            }
        }
        
        sendToEngine('cmd:load', {
            file: data.file,
            position: data.position || 0,
            paused: data.paused || false
        });
        
        broadcastState();
    });
    
    ipcMain.on('audio:next', async () => {
        recordUserActivity();
        logStateDebugAction('next-track', audioState.engineAlive ? 'Next track (engine alive)' : 'Next track (engine was disposed)');
        
        // If engine was disposed, we need to handle next track differently
        if (!audioState.engineAlive) {
            console.log('[] ');
            // Let the track-end handler manage the next track logic
            await handleTrackEnded();
            return;
        }
        
        sendToEngine('cmd:next');
    });
    
    ipcMain.on('audio:prev', async () => {
        recordUserActivity();
        logStateDebugAction('prev-track', audioState.engineAlive ? 'Previous track (engine alive)' : 'Previous track (engine was disposed)');
        
        // If engine was disposed, we need to handle prev track differently
        if (!audioState.engineAlive) {
            console.log('[] ');
            // Decrement playlist index and load previous file
            if (audioState.playlist.length > 0) {
                audioState.playlistIndex--;
                if (audioState.playlistIndex < 0) {
                    audioState.playlistIndex = audioState.playlist.length - 1;
                }
                const prevFile = audioState.playlist[audioState.playlistIndex];
                if (prevFile) {
                    audioState.file = prevFile;
                    audioState.fileType = getFileType(prevFile);
                    audioState.position = 0;
                    audioState.isPlaying = true;
                    
                    const restored = await restoreEngineIfNeeded();
                    if (restored) {
                        sendToEngine('cmd:play');
                    }
                    broadcastState();
                }
            }
            return;
        }
        
        sendToEngine('cmd:prev');
    });
    
    ipcMain.on('audio:setParams', (e, data) => {
        // Update local state
        if (data.mode !== undefined) audioState.mode = data.mode;
        if (data.tapeSpeed !== undefined) audioState.tapeSpeed = data.tapeSpeed;
        if (data.pitch !== undefined) audioState.pitch = data.pitch;
        if (data.tempo !== undefined) audioState.tempo = data.tempo;
        if (data.formant !== undefined) audioState.formant = data.formant;
        if (data.locked !== undefined) audioState.locked = data.locked;
        if (data.volume !== undefined) audioState.volume = data.volume;
        if (data.loop !== undefined) audioState.loop = data.loop;
        
        // Forward to engine
        sendToEngine('cmd:setParams', data);
        
        // Broadcast to UI
        broadcastState();
    });
    
    ipcMain.on('audio:setPlaylist', (e, data) => {
        if (data.playlist) audioState.playlist = data.playlist;
        if (data.index !== undefined) audioState.playlistIndex = data.index;
        
        sendToEngine('cmd:playlist', {
            music: audioState.playlist,
            idx: audioState.playlistIndex,
            max: audioState.playlist.length - 1
        });
    });
    
    // Events from engine → update state and broadcast to player
    ipcMain.on('audio:position', (e, position) => {
        audioState.position = position;
        // Targeted send to player only (frequent updates)
        sendToPlayer('position', position);
    });
    
    ipcMain.on('audio:state', (e, data) => {
        if (data.isPlaying !== undefined) {
            audioState.isPlaying = data.isPlaying;
        }
        if (data.isLoop !== undefined) {
            audioState.loop = data.isLoop;
        }
        broadcastState();
    });
    
    ipcMain.on('audio:loaded', (e, data) => {
        console.log(`[DEBUG] audio:loaded received: fileType=${data.fileType}, file=${data.file ? path.basename(data.file) : 'null'}`, 'engine');
        
        const previousFileType = audioState.fileType;
        const isRestorationFlow = audioState.isRestoration; // True during engine restoration
        
        if (data.duration) audioState.duration = data.duration;
        if (data.file) audioState.file = data.file;
        if (data.fileType) {
            audioState.fileType = data.fileType;
            console.log(`[DEBUG] audioState.fileType set to: ${audioState.fileType}`, 'engine');
        }
        // Store metadata for parameters window (e.g., MIDI originalBPM, Tracker channels)
        if (data.metadata) {
            audioState.metadata = { ...audioState.metadata, ...data.metadata };
            // Update MIDI BPM if originalBPM provided
            if (data.metadata.originalBPM) {
                audioState.midiParams.bpm = Math.round(data.metadata.originalBPM);
            }
        }
        broadcastState();
        
        // UNIFIED STATE TRANSITION: Update parameters window when:
        // 1. fileType changes (normal file switch), OR
        // 2. Engine is being restored (parameters window may have stale state)
        // This is the single source of truth for parameters window tab switching
        const fileTypeChanged = data.fileType && data.fileType !== previousFileType;
        if (fileTypeChanged || isRestorationFlow) {
            console.log(`[DEBUG] Updating parameters window (fileTypeChanged=${fileTypeChanged}, isRestorationFlow=${isRestorationFlow})`, 'params');
            
            // Determine if we should reset state to defaults:
            // - Audio: reset only if NOT locked
            // - MIDI/Tracker: always reset (no lock feature)
            const shouldReset = audioState.fileType === 'FFmpeg' ? !audioState.locked : true;
            
            // Reset state to defaults before sending to UI
            if (shouldReset) {
                resetParamsToDefaults(audioState.fileType, data.metadata);
            }
            
            sendParamsToParametersWindow(shouldReset);
        }
    });
    
    ipcMain.on('audio:ended', () => {
        // Handle track end - advance playlist
        handleTrackEnded();
    });
    
    ipcMain.on('audio:metadata', (e, data) => {
        if (data.duration) audioState.duration = data.duration;
        if (data.metadata) audioState.metadata = data.metadata;
        if (data.fileType) audioState.fileType = data.fileType;
        broadcastState();
    });
    
    // Window lifecycle - track in main and forward to engine
    ipcMain.on('window-created', (e, data) => {
        console.log(`[DEBUG] window-created: type=${data?.type}, windowId=${data?.windowId}`, 'engine');
        if (data && data.type) {
            // Track in main state for engine restoration
            if (childWindows[data.type]) {
                childWindows[data.type].open = true;
                childWindows[data.type].windowId = data.windowId;
                console.log(`[DEBUG] childWindows.${data.type} tracked: open=true, windowId=${data.windowId}`, 'engine');
            }
            sendToEngine('window-created', data);
            
            // Initialize parameters window on first creation
            if (data.type === 'parameters') {
                sendParamsToParametersWindow();
            }
        }
    });
    
    ipcMain.on('window-visible', (e, data) => {
        console.log(`[DEBUG] window-visible: type=${data?.type}, windowId=${data?.windowId}`, 'engine');
        if (data && data.type && childWindows[data.type]) {
            childWindows[data.type].open = true;
            childWindows[data.type].windowId = data.windowId;
        }
        sendToEngine('window-visible', data);
        
        // Send current params to parameters window when it becomes visible
        if (data && data.type === 'parameters') {
            sendParamsToParametersWindow();
        }
    });
    
    ipcMain.on('window-hidden', (e, data) => {
        console.log(`[DEBUG] window-hidden: type=${data?.type}, windowId=${data?.windowId}`, 'engine');
        if (data && data.type && childWindows[data.type]) {
            // Window is hidden but not closed - keep tracking it
            console.log(`[DEBUG] childWindows.${data.type}: open stays true, windowId stays ${childWindows[data.type].windowId}`, 'engine');
        }
        sendToEngine('window-hidden', data);
    });
    
    ipcMain.on('window-closed', (e, data) => {
        console.log(`[DEBUG] window-closed: type=${data?.type}, windowId=${data?.windowId}`, 'engine');
        if (data && data.type) {
            // Remove from tracking
            if (childWindows[data.type]) {
                childWindows[data.type].open = false;
                childWindows[data.type].windowId = null;
                console.log(`[DEBUG] childWindows.${data.type} cleared`, 'engine');
            }
            sendToEngine('window-closed', data);
        }
    });
    
    // Param changes from parameters window → track in state and forward to engine
    ipcMain.on('param-change', (e, data) => {
        // Track format-specific params in main state so we can restore after disposal
        let stateChanged = false;
        if (data.mode === 'midi') {
            if (data.param === 'transpose') audioState.midiParams.transpose = data.value;
            if (data.param === 'bpm') audioState.midiParams.bpm = data.value;
            if (data.param === 'metronome') audioState.midiParams.metronome = data.value;
            if (data.param === 'soundfont') audioState.midiParams.soundfont = data.value;
        } else if (data.mode === 'tracker') {
            if (data.param === 'pitch') audioState.trackerParams.pitch = data.value;
            if (data.param === 'tempo') audioState.trackerParams.tempo = data.value;
            if (data.param === 'stereoSeparation') audioState.trackerParams.stereoSeparation = data.value;
        } else if (data.mode === 'audio') {
            if (data.param === 'audioMode') audioState.mode = data.value;
            if (data.param === 'tapeSpeed') audioState.tapeSpeed = data.value;
            if (data.param === 'pitch') audioState.pitch = data.value;
            if (data.param === 'tempo') audioState.tempo = data.value;
            if (data.param === 'formant') audioState.formant = !!data.value;
            if (data.param === 'locked') audioState.locked = !!data.value;
            stateChanged = true;  // Audio params affect player UI state
        }
        sendToEngine('param-change', data);
        
        // Broadcast to player so it has current params for window initialization
        if (stateChanged) {
            broadcastState();
        }
    });
    
    // Other parameter-related messages
    ipcMain.on('midi-reset-params', (e, data) => {
        audioState.midiParams = { transpose: 0, bpm: null, metronome: false, soundfont: null };
        sendToEngine('midi-reset-params', data);
    });
    
    ipcMain.on('tracker-reset-params', (e, data) => {
        audioState.trackerParams = { pitch: 1.0, tempo: 1.0, stereoSeparation: 100 };
        sendToEngine('tracker-reset-params', data);
    });
    
    ipcMain.on('open-soundfonts-folder', (e, data) => {
        sendToEngine('open-soundfonts-folder', data);
    });
    
    ipcMain.on('get-available-soundfonts', (e, data) => {
        sendToEngine('get-available-soundfonts', data);
    });
    
    // Player requests current state (on startup)
    ipcMain.on('audio:requestState', (e) => {
        broadcastState();
    });
    
    // State debugger: Send main state and forward to engine
    ipcMain.on('state-debug:request', (e, data) => {
        const windowId = data?.windowId;
        const action = data?.action;  // Specific action to log (optional)
        const detail = data?.detail;
        if (!windowId) return;
        
        // Log specific action if provided
        if (action && action !== 'request') {
            logStateDebugAction(action, detail);
        }
        
        // Send main state to state-debug window (include recent actions)
        const mainState = {
            audioState: {
                file: audioState.file ? path.basename(audioState.file) : null,
                isPlaying: audioState.isPlaying,
                position: audioState.position,
                duration: audioState.duration,
                fileType: audioState.fileType,
                mode: audioState.mode,
                tapeSpeed: audioState.tapeSpeed,
                pitch: audioState.pitch,
                tempo: audioState.tempo,
                formant: audioState.formant,
                locked: audioState.locked,
                volume: audioState.volume,
                loop: audioState.loop,
                activePipeline: audioState.activePipeline,
                engineAlive: audioState.engineAlive
            },
            midiParams: audioState.midiParams,
            trackerParams: audioState.trackerParams,
            childWindows: {
                parameters: { open: childWindows.parameters.open },
                monitoring: { open: childWindows.monitoring.open },
                mixer: { open: childWindows.mixer.open }
            },
            idleState: {
                lastActivityTime: new Date(idleState.lastActivityTime).toLocaleTimeString(),
                engineDisposalTimeout: !!audioState.engineDisposalTimeout,
                visibleDisposeTimeout: !!idleState.visibleDisposeTimeout
            }
        };
        
        // Send state to state-debug window
        tools.sendToId(windowId, 'state-debug:main', { 
            state: mainState
        });
        
        // Forward to engine if alive
        if (engineWindow && !engineWindow.isDestroyed()) {
            engineWindow.webContents.send('state-debug:request', { windowId });
        }
    });
    
    // DEBUG: Close engine window (for CPU testing)
    ipcMain.on('debug:close-engine', (e) => {
        console.log('[] ');
        disposeEngineWindow();
    });
    
    // DEBUG: Reopen engine window (for CPU testing)
    ipcMain.on('debug:open-engine', async (e) => {
        console.log('[] ');
        if (!engineWindow) {
            await createEngineWindow();
        }
    });
    
    // Waveform cache IPC handlers
    ipcMain.handle('waveform:get', (e, filePath) => {
        const cached = waveformCache.get(filePath);
        if (cached) {
            console.log(`Waveform cache hit for: ${path.basename(filePath)}`, 'cache');
            return cached;
        }
        return null;
    });
    
    ipcMain.on('waveform:set', (e, data) => {
        if (!data || !data.filePath) return;
        
        // Enforce cache size limit (LRU eviction)
        if (waveformCache.size >= WAVEFORM_CACHE_MAX_SIZE) {
            const oldestKey = waveformCache.keys().next().value;
            waveformCache.delete(oldestKey);
            console.log('[] ');
        }
        
        waveformCache.set(data.filePath, {
            peaksL: data.peaksL,
            peaksR: data.peaksR,
            points: data.points,
            duration: data.duration,
            timestamp: Date.now()
        });
        console.log(`Cached waveform for: ${path.basename(data.filePath)}`, 'cache');
    });
    
    // DEBUG: Idle disposal testing
    ipcMain.on('debug:idle-status', (e) => {
        const isWindowVisible = wins.main && wins.main.isVisible() && !wins.main.isMinimized();
        const idleTime = Date.now() - idleState.lastActivityTime;
        const status = {
            engineAlive: audioState.engineAlive,
            isPlaying: audioState.isPlaying,
            isWindowVisible,
            idleTimeMs: idleTime,
            idleTimeSec: Math.round(idleTime / 1000),
            shouldDispose: shouldDisposeEngine(),
            pendingTimeouts: !!audioState.engineDisposalTimeout || !!idleState.visibleDisposeTimeout,
            waveformCacheSize: waveformCache.size
        };
        console.log('Idle status: ' + JSON.stringify(status), 'engine');
        e.sender.send('debug:idle-status-response', status);
    });
    
    ipcMain.on('debug:idle-force-dispose', (e) => {
        console.log('[] ');
        disposeEngineWindow();
    });
    
    ipcMain.on('debug:idle-reset-timer', (e) => {
        console.log('[] ');
        recordUserActivity();
    });
}

async function handleTrackEnded() {
    console.log('[] ');
    
    if (audioState.loop && audioState.file) {
        // Loop current track
        audioState.position = 0;
        // Ensure engine is alive before sending commands
        if (!audioState.engineAlive) {
            await restoreEngineIfNeeded();
        }
        if (audioState.engineAlive) {
            sendToEngine('cmd:seek', { position: 0 });
            sendToEngine('cmd:play');
        }
        audioState.isPlaying = true;
    } else if (audioState.playlist.length > 0) {
        // Advance to next track
        audioState.playlistIndex++;
        if (audioState.playlistIndex >= audioState.playlist.length) {
            audioState.playlistIndex = 0;  // Wrap around
        }
        
        const nextFile = audioState.playlist[audioState.playlistIndex];
        if (nextFile) {
            audioState.file = nextFile;
            audioState.fileType = getFileType(nextFile);
            audioState.position = 0;
            audioState.isPlaying = true;
            audioState.duration = 0;
            audioState.metadata = null;
            
            // If engine is not alive, restore it (which will load the file)
            if (!audioState.engineAlive) {
                await restoreEngineIfNeeded();
            } else {
                // Engine is alive, just load the new file
                sendToEngine('cmd:load', {
                    file: nextFile,
                    position: 0,
                    paused: false
                });
            }
        }
    } else {
        audioState.isPlaying = false;
    }
    
    broadcastState();
}



