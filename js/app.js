'use strict';
const {app, protocol, BrowserWindow, Menu, ipcMain} = require('electron');
const squirrel_startup = require('./squirrel_startup.js');
squirrel_startup().then(ret => { if(ret) { app.quit(); return; } init(); });

const path = require('path');
const fs = require("fs").promises;
const helper = require('../libs/electron_helper/helper.js');
const update = require('../libs/electron_helper/update.js');
const reg = require('../libs/windows-native-registry.js');

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



async function init(){
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
	configWindow();
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
	if(data.cmd == 'register'){
		registerFileType()
	}
	else if(data.cmd == 'unregister'){
		unregisterFileType()
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


function registerFileType(){
	/* Native-reg Example 
	let key = reg.openKey(reg.HKCU, 'Software\\Classes\\soundapp_flac', reg.Access.ALL_ACCESS, reg.ValueType.NONE);
	let val = reg.getValue(key, 'DefaultIcon', '', reg.ValueType.STRING);
	*/
	let key = reg.getRegistryKey(reg.HK.CU, 'Software\\Classes\\soundapp_flac');
	wins.temp.webContents.send('msg', JSON.stringify(key));
	console.log(key);
}

function unregisterFileType(){

}

async function configWindow(){
    wins.temp = await helper.tools.browserWindow('frameless', {
        webPreferences:{preload: helper.tools.path.join(__dirname, '..', 'libs', 'electron_helper', 'helper.js')},
        devTools: true,
        width:800, 
        height:800,
        modal: true,
        html:/*HTML*/`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>SoundApp</title>
                </head>
            
                <body class="dark">
                    <main>
                        <section>
                            <article>
								<div class="nui-card">
									<div class="nui-input">
										<label for="apppath">App Path</label>
										<input id="apppath" type="text" placeholder="Enter path here" value="C:\\Users\\dave\\AppData\\Local\\soundApp\\soundApp.exe">
									</div>
									<div class="nui-input">
										<label for="iconpath">Icons Path</label>
										<input id="iconpath" type="text" placeholder="Enter path here" value="C:\\Users\\dave\\AppData\\Local\\soundApp\\app-1.1.0\\resources\\icons">
									</div>
									<div class="nui-button-container">
										<button id="register" class="nui-button">Register</button>
										<button id="unregister" class="nui-button">Un-Register</button>
									</div>
								</div>
								<div id="msg" class="nui-card">
									<div class="nui-output"></div>
								</div>
                            </article>
                        </section>
                    </main>
                </body>
				<style>
					
				</style>
                <script type="module">
                    import nui from './libs/nui/nui.js';
                    import ut from './libs/nui/nui_ut.js';
                    import nui_app from './libs/nui/nui_app.js';
                    
					document.addEventListener('DOMContentLoaded', init, {conce:true})
					let g = {};

					async function init(){
						await nui_app.appWindow({inner:ut.el('body'), fnc_close:window.electron_helper.window.close, icon:ut.icon('settings')});
                        electron_helper.ipcHandleRenderer('msg', update);
						g.msg = ut.el('#msg');
						g.msg_content = ut.el('#msg .nui-output');
					}
                    
					function update(e, data){
                        g.msg_content.innerHTML += '<br>' + data;
                    }

					ut.el('#register').addEventListener('click', sendCommand);
					ut.el('#unregister').addEventListener('click', sendCommand);
					
					function sendCommand(e){
						electron_helper.tools.sendToMain('command', {cmd:e.target.id, data:{ apppath:ut.el('#apppath').value, iconpath:ut.el('#iconpath').value}});
					}

                </script>
            </html>
        `
    });
}

module.exports.fb = fb;