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

//app.commandLine.appendSwitch('high-dpi-support', 'false');
//app.commandLine.appendSwitch('force-device-scale-factor', '1');
//app.commandLine.appendSwitch('--js-flags', '--experimental-module');
//app.disableHardwareAcceleration();
// Enable SharedArrayBuffer (required for SAB-based streaming player)
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
//protocol.registerSchemesAsPrivileged([{ scheme: 'raum', privileges: { bypassCSP: true, supportFetchAPI:true } }])

async function init(cmd) {
	fb('APP INIT');

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
	fb('APP SET_ENV');
	fb('--------------------------------------');
	process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;
	helper.setGlobal('main_env', main_env);
	helper.setGlobal('isPackaged', isPackaged);
	helper.setGlobal('base_path', base_path);
	helper.setGlobal('temp_path', path.join(app.getPath('userData'), 'temp'));
	helper.setGlobal('start_vars', process.argv);

	fb('Electron Version: ' + process.versions.electron);
	fb('Node Version: ' + process.versions.node);
	fb('Chrome Version: ' + process.versions.chrome);
	fb('--------------------------------------');

	app.whenReady().then(appStart).catch((err) => { throw err });
}


async function appStart() {
	fb('Init Windows');
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
		fb('startWithDefaults enabled: using temporary config user_temp.json');
	}
	main_env.configName = configName;

	// If defaults mode is active, reset user_temp.json to config-defaults.js
	if (startWithDefaults) {
		const configPath = path.join(user_data, 'user_temp.json');
		try {
			await fs.writeFile(configPath, JSON.stringify(configDefaults, null, 2), 'utf8');
			fb('Defaults mode: Reset user_temp.json from config-defaults.js');
		} catch (err) {
			fb('Warning: Could not write user_temp.json:', err.message);
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
		file: 'html/stage.html',
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
		});

		wins.main.on('closed', () => {
			let keep = false;
			try {
				let cnf = user_cfg ? (user_cfg.get() || {}) : {};
				keep = !!(cnf && cnf.ui && cnf.ui.keepRunningInTray);
			} catch (err) { }
			if (!keep) app.quit();
		});
	} catch (err) { }

	createTray();

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
		fb('Tray icon not created (icon missing): ' + iconPath);
		return;
	}

	tray = new Tray(img);
	tray.setToolTip('SoundApp');

	const contextMenu = Menu.buildFromTemplate([
		{ label: 'Show', click: () => { try { wins.main && wins.main.show(); wins.main && wins.main.focus(); } catch (e) { } } },
		{ label: 'Reset Windows', click: () => { resetAllWindows(); } },
		{ type: 'separator' },
		{ label: 'Quit', click: () => { app.quit(); } }
	]);
	tray.setContextMenu(contextMenu);
	tray.on('click', () => {
		try { wins.main && wins.main.show(); wins.main && wins.main.focus(); } catch (e) { }
	});
}

async function resetAllWindows() {
	try {
		if (!user_cfg) {
			fb('Reset Windows: config not initialized');
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
		fb('Reset Windows: done');
	} catch (err) {
		console.error('Reset Windows failed:', err);
	}
}

async function checkUpdate() {
	fb('Checking for updates');
	let check = await update.checkVersion('herrbasan/SoundApp', 'git', true);
	if (check.status && check.isNew) {
		fb('Update available: v' + check.remote_version);
		update.init({ mode: 'splash', url: 'herrbasan/SoundApp', source: 'git', progress: update_progress, check: check, useSemVer: true })
	}
	else {
		fb('No updates available');
	}
}

function update_progress(e) {
	if (e.type == 'state') {
		fb('Update State: ' + e.data);
	}
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

function fb(o, context = 'main') {
	if (!isPackaged) {
		console.log(context + ' : ', o);
	}
	if (wins?.main?.webContents) {
		wins.main.webContents.send('log', { context: context, data: o });
	}
}


module.exports.fb = fb;