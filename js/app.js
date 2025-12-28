'use strict';
const {app, protocol, BrowserWindow, Menu, ipcMain, Tray, nativeImage, screen} = require('electron');
const path = require('path');
const fs = require("fs").promises;
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const update = require('../libs/electron_helper/update.js');
const squirrel_startup = require('./squirrel_startup.js');
const configDefaults = require('./config-defaults.js');

squirrel_startup().then((ret, cmd) => { if(ret) { app.quit(); return; } init(cmd); });

let main_env = {channel:'stable'};
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
//protocol.registerSchemesAsPrivileged([{ scheme: 'raum', privileges: { bypassCSP: true, supportFetchAPI:true } }])

async function init(cmd){
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
					for(let i=1; i<commandLine.length; i++){
						if(commandLine[i].substr(0,2) != '--'){
							argv.push(commandLine[i]);
						}
					}
					wins.main.webContents.send('main', argv);
					if(!wins.main.isVisible()) wins.main.show();
					if (wins.main.isMinimized()) wins.main.restore();
					wins.main.focus();
				}
			})
		}
	
		if(process.env.PORTABLE_EXECUTABLE_DIR){
			base_path = process.env.PORTABLE_EXECUTABLE_DIR;
		}
		else {
			var ar = process.execPath.split( path.sep );
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
		if(process.platform === 'darwin') return;
		let keep = false;
		try {
			let cnf = user_cfg ? (user_cfg.get() || {}) : {};
			keep = !!(cnf && cnf.ui && cnf.ui.keepRunningInTray);
		} catch(err) {}
		if(!keep) app.quit();
	});


	let fp = path.join(app_path, 'env.json');
	if((await helper.tools.fileExists(fp))){
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

	if(base_path.includes('AppData')){
		if(base_path.includes('Local')){
			main_env.startType = 'Installed';
			let name = path.basename(main_env.app_exe);
			main_env.app_exe = path.resolve(path.dirname(main_env.app_exe), '..', name);
		}
		else {
			main_env.startType = 'Portable';
		}
	}

}


function setEnv(){
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

	app.whenReady().then(appStart).catch((err) => { throw err});
}


async function appStart(){
    fb('Init Windows');
	app.on('before-quit', () => { isQuitting = true; });
	// Optional config activity logging (temporary debugging aid)
	// Enable via env.json: { "config_log": true } or env var: ELECTRON_HELPER_CONFIG_LOG=1
	if(main_env && (main_env.config_log || main_env.configLog)){
		process.env.ELECTRON_HELPER_CONFIG_LOG = '1';
	}
	const configLog = (process.env.ELECTRON_HELPER_CONFIG_LOG === '1' || process.env.ELECTRON_HELPER_CONFIG_LOG === 'true');
    
	// Initialize config on main process
	// NOTE: We intentionally do not migrate older structures.
	// If config structure changes, the recommended path is to delete user.json and let defaults recreate it.
	
	// Development: start with defaults without touching argv parsing
	// Enable via env.json: { "startWithDefaults": true }
	// - false: normal behavior (uses user.json)
	// - true: uses user_temp.json (fresh defaults for testing)
	const startWithDefaults = !!(main_env && (main_env.startWithDefaults || main_env.start_with_defaults));
	const configName = startWithDefaults ? 'user_temp' : 'user';
	if(startWithDefaults){
		fb('startWithDefaults enabled: using temporary config user_temp.json');
	}
	main_env.configName = configName;
	
	user_cfg = await helper.config.initMain(configName, configDefaults, { log: configLog });
    
    wins.main = await helper.tools.browserWindow('default', { 
		frame:false, 
		minWidth:480, 
		minHeight:217, 
		width:480, 
		height:217, 
		show:false,
		resizable:true, 
		devTools:false,
		transparent:false,
		backgroundColor:'#323232',
		file:'html/stage.html',
		webPreferences:{
			navigateOnDragDrop: true
		}
	})

	// Opt-in: keep running in tray (hide main window on close)
	try {
		wins.main.on('close', (e) => {
			if(isQuitting) return;
			let keep = false;
			try {
				let cnf = user_cfg ? (user_cfg.get() || {}) : {};
				keep = !!(cnf && cnf.ui && cnf.ui.keepRunningInTray);
			} catch(err) {}
			if(!keep) return;
			e.preventDefault();
			try { wins.main.hide(); } catch(err) {}
		});

		wins.main.on('closed', () => {
			let keep = false;
			try {
				let cnf = user_cfg ? (user_cfg.get() || {}) : {};
				keep = !!(cnf && cnf.ui && cnf.ui.keepRunningInTray);
			} catch(err) {}
			if(!keep) app.quit();
		});
	} catch(err) {}

	createTray();

	ipcMain.handle('command', mainCommand);
	Menu.setApplicationMenu( null );
	if(main_env?.channel != 'dev'){
		setTimeout(checkUpdate,1000);
	}
}

function createTray(){
	if(tray) return;
	let iconPath = null;
	if(process.platform === 'win32'){
		// In packaged app, extraResource files go to process.resourcesPath/icons/
		// In dev, they're at app_path/build/icons/
		if(isPackaged){
			iconPath = path.join(process.resourcesPath, 'icons', 'app.ico');
		} else {
			iconPath = path.join(app_path, 'build', 'icons', 'app.ico');
		}
	}
	else {
		if(isPackaged){
			iconPath = path.join(process.resourcesPath, 'icons', 'app.ico');
		} else {
			iconPath = path.join(app_path, 'build', 'icons', 'app.ico');
		}
	}

	let img = null;
	try {
		img = nativeImage.createFromPath(iconPath);
		if(img && img.isEmpty && img.isEmpty()) img = null;
	} catch(e) {
		img = null;
	}
	if(!img){
		fb('Tray icon not created (icon missing): ' + iconPath);
		return;
	}

	tray = new Tray(img);
	tray.setToolTip('SoundApp');

	const contextMenu = Menu.buildFromTemplate([
		{ label: 'Show', click: () => { try { wins.main && wins.main.show(); wins.main && wins.main.focus(); } catch(e){} } },
		{ label: 'Reset Windows', click: () => { resetAllWindows(); } },
		{ type: 'separator' },
		{ label: 'Quit', click: () => { app.quit(); } }
	]);
	tray.setContextMenu(contextMenu);
	tray.on('click', () => {
		try { wins.main && wins.main.show(); wins.main && wins.main.focus(); } catch(e){}
	});
}

async function resetAllWindows(){
	try {
		if(!user_cfg){
			fb('Reset Windows: config not initialized');
			return;
		}
		const cnf = user_cfg.get() || {};
		if(!cnf.windows) cnf.windows = {};

		const primary = screen.getPrimaryDisplay();
		const wa = primary && primary.workArea ? primary.workArea : { x: 0, y: 0, width: 1024, height: 768 };

		const defaults = (configDefaults && configDefaults.windows) ? configDefaults.windows : {};
		for(const k in defaults){
			const d = defaults[k];
			if(!d) continue;
			const w = d.width|0;
			const h = d.height|0;
			if(w <= 0 || h <= 0) continue;
			const nx = wa.x + Math.round((wa.width - w) / 2);
			const ny = wa.y + Math.round((wa.height - h) / 2);
			cnf.windows[k] = { ...cnf.windows[k], x: nx, y: ny, width: w, height: h };
		}

		user_cfg.set(cnf);

		// Apply to main window immediately
		try {
			if(wins.main && cnf.windows && cnf.windows.main){
				wins.main.setBounds(cnf.windows.main);
			}
		} catch(e) {}

		// Ask renderer windows to reposition themselves
		try { tools.broadcast('windows-reset', cnf.windows); } catch(e) {}
		fb('Reset Windows: done');
	} catch(err) {
		console.error('Reset Windows failed:', err);
	}
}

async function checkUpdate(){
	fb('Checking for updates');
	let check = await update.checkVersion('herrbasan/SoundApp', 'git', true);
	if(check.status && check.isNew){
		fb('Update available: v' + check.remote_version);
		update.init({mode:'splash', url:'herrbasan/SoundApp', source:'git', progress:update_progress, check:check, useSemVer:true})
	}
	else {
		fb('No updates available');
	}
}

function update_progress(e){
	if(e.type == 'state'){
		fb('Update State: ' + e.data);
	}
}

function mainCommand(e, data){
	if(data.command === 'toggle-theme'){
		// Toggle theme state
		currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
		let isDark = currentTheme === 'dark';
		// Broadcast new theme to all windows
		tools.broadcast('theme-changed', { dark: isDark });
	}
	else if(data.command === 'set-theme'){
		// Stage sends initial theme on startup
		currentTheme = data.theme;
	}
	return true;
}

function fb(o, context='main'){
	 if (!isPackaged) {
    	console.log(context + ' : ', o);
	 }
	 if(wins?.main?.webContents){
		 wins.main.webContents.send('log', {context:context, data:o});
	 }
}


module.exports.fb = fb;