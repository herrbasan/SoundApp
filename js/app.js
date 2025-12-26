'use strict';
const {app, protocol, BrowserWindow, Menu, ipcMain} = require('electron');
const path = require('path');
const fs = require("fs").promises;
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const update = require('../libs/electron_helper/update.js');
const squirrel_startup = require('./squirrel_startup.js');

squirrel_startup().then((ret, cmd) => { if(ret) { app.quit(); return; } init(cmd); });

let main_env = {channel:'stable'};
let isPackaged = app.isPackaged;
let app_path = app.getAppPath();
let base_path = path.join(app_path);
let user_data = app.getPath('userData');
let wins = {};
let currentTheme = 'dark'; // Default theme, will be updated by stage on startup

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
					if (wins.main.isMinimized()) wins.main.restore()
					wins.main.focus()
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
    
    // Initialize config on main process
    await helper.config.initMain('user', {
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
    });
    
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
		file:'html/stage.html',
		webPreferences:{
			navigateOnDragDrop: true
		}
	})

	ipcMain.handle('command', mainCommand);
	Menu.setApplicationMenu( null );
	if(main_env?.channel != 'dev'){
		setTimeout(checkUpdate,1000);
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