'use strict';

const {app, protocol, BrowserWindow, Menu, ipcMain} = require('electron');
const squirrel_startup = require('./squirrel_startup.js');
squirrel_startup().then(ret => { if(ret) {app.quit()}});

const path = require('path');
const fs = require("fs").promises;
const helper = require('../libs/electron_helper/helper.js');
const update = require('../libs/electron_helper/update.js');

let main_env = {channel:'stable'};
let isPackaged = app.isPackaged;
let app_path = app.getAppPath();
let base_path = path.join(app_path);
let user_data = app.getPath('userData');

let log = [];
let wins = {};

//app.commandLine.appendSwitch('high-dpi-support', 'false');
//app.commandLine.appendSwitch('force-device-scale-factor', '1');
//app.commandLine.appendSwitch('--js-flags', '--experimental-module');
//app.disableHardwareAcceleration();
//protocol.registerSchemesAsPrivileged([{ scheme: 'raum', privileges: { bypassCSP: true, supportFetchAPI:true } }])

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

init();
async function init(){
	fb('APP INIT');
	let fp = path.join(app_path, 'env.json');
	if((await helper.tools.fileExists(fp))){
		let _env = await fs.readFile(fp, 'utf8');
		main_env = JSON.parse(_env);
	}
	setEnv();
}

function setEnv(){
	fb('APP SET_ENV');
	fb('--------------------------------------');
	process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;
	global.main_env = main_env;
	global.isPackaged = isPackaged;
	global.base_path = base_path;
	global.temp_path = path.join(app.getPath('userData'), 'temp');
	global.start_vars = process.argv;

	fb('Electron Version: ' + process.versions.electron);
	fb('Node Version: ' + process.versions.node);
	fb('Chrome Version: ' + process.versions.chrome);
	fb('--------------------------------------');

	app.whenReady().then(appStart).catch((err) => { throw err});
}


async function appStart(){
    fb('Init Windows');
    wins.main = await helper.tools.browserWindow('default', { 
		frame:false, 
		minWidth:480, 
		minHeight:217, 
		width:480, 
		height:217, 
		show:true,
		resizable:true, 
		devTools:true,
		transparent:false,
		file:'html/stage.html'
	})

	ipcMain.handle('command', mainCommand);
	Menu.setApplicationMenu( null );
	if(main_env?.channel != 'dev'){
		setTimeout(checkUpdate,1000);
	}
}

async function checkUpdate(){
	let check = await update.checkVersion('https://raum.com/update/soundapp/stable/');
	if(check.status && check.isNew){
		update.init({mode:'splash', url:'https://raum.com/update/soundapp/stable/', progress:update_progress, check:check})
	}
}

function update_progress(e){
	if(e.type == 'state'){
		console.log(e);
	}
}

function mainCommand(e, data){
	console.log(data);
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