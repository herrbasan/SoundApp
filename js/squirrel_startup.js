const path = require('path');
const spawn = require('child_process').spawn;
const app = require('electron').app;
const fs = require('fs').promises;

const { ProgId, ShellOption, Regedit } = require('electron-regedit')

let app_dir = path.dirname(app.getAppPath());

function squirrel_startup() {
	return new Promise(async (resolve, reject) => {
		let ret = false;
		if(app.isPackaged){
			let cmd = process.argv[1];
			let target = path.basename(process.execPath);
			
			if (cmd === '--squirrel-firstrun'){
				await log('Squirrel Firstrun');
				await log('Register File Types');
				await registy('reg');
			}
			if (cmd === '--squirrel-install' || cmd === '--squirrel-updated') {
				await log('Creating Shortcut at: ' + target);
				await runCommand(['--createShortcut=' + target + '']);
				await log('Register File Types');
				await registy('reg');
				await log('Install Done');
				ret = true;
			}
			if (cmd === '--squirrel-uninstall') {
				await log('Remove Shortcut at: ' + target);
				await runCommand(['--removeShortcut=' + target + '']);
				await log('Un-Register File Types');
				await registy('unreg');
				await log('Uninstall Done');
				ret = true;
			}
		}
		resolve(ret);
	});
}

function registy(task) {
	return new Promise(async (resolve, reject) => {
		let ret;
		let mod_extension = [
			'mptm', 'mod', 'mo3', 's3m', 'xm', 'it', '669', 'amf', 'ams', 'c67', 'dbm', 'digi', 'dmf',
			'dsm', 'dsym', 'dtm', 'far', 'fmt', 'imf', 'ice', 'j2b', 'm15', 'mdl', 'med', 'mms', 'mt2', 'mtm', 'mus',
			'nst', 'okt', 'plm', 'psm', 'pt36', 'ptm', 'sfx', 'sfx2', 'st26', 'stk', 'stm', 'stx', 'stp', 'symmod',
			'ult', 'wow', 'gdm', 'mo3', 'oxm', 'umx', 'xpk', 'ppm', 'mmcmp'
		]

		let mod_extension_short = ['mod', 's3m', 'xm', 'it'];

		new ProgId({ squirrel: true, appName: 'soundapp_mp3', friendlyAppName: 'soundapp', description: 'MPEG Layer 3 Audio File', icon: path.join(app_dir, 'icons', 'mp3.ico'), extensions: ['mp3'] })
		new ProgId({ squirrel: true, appName: 'soundapp_mp2', friendlyAppName: 'soundapp', description: 'MPEG Layer 2 Audio File', icon: path.join(app_dir, 'icons', 'pcm.ico'), extensions: ['mp2', 'mpa'] })
		new ProgId({ squirrel: true, appName: 'soundapp_m4a', friendlyAppName: 'soundapp', description: 'MPEG Layer 4 Audio File', icon: path.join(app_dir, 'icons', 'm4a.ico'), extensions: ['m4a', 'aac', 'm4b', 'aa'] })
		new ProgId({ squirrel: true, appName: 'soundapp_flac', friendlyAppName: 'soundapp', description: 'FLAC Audio File', icon: path.join(app_dir, 'icons', 'flac.ico'), extensions: ['flac'] })
		new ProgId({ squirrel: true, appName: 'soundapp_pcm', friendlyAppName: 'soundapp', description: 'PCM Audio File', icon: path.join(app_dir, 'icons', 'pcm.ico'), extensions: ['wav', 'aif', 'aiff', 'pcm'] })
		new ProgId({ squirrel: true, appName: 'soundapp_ogg', friendlyAppName: 'soundapp', description: 'OGG Audio File', icon: path.join(app_dir, 'icons', 'ogg.ico'), extensions: ['ogg', 'oga', 'opus', 'ogm', 'mogg'] })
		new ProgId({ squirrel: true, appName: 'soundapp_mod', friendlyAppName: 'soundapp', description: 'MOD File', icon: path.join(app_dir, 'icons', 'mod.ico'), extensions: mod_extension })
		if(task == 'reg'){
			ret = await Regedit.installAll();
		}
		else {
			ret = await Regedit.uninstallAll();
		}
		await log(JSON.stringify(ret));
		resolve(ret);
	});
}

function runCommand(args) {
	return new Promise((resolve, reject) => {
		var updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
		spawn(updateExe, args, { detached: true }).on('close', resolve);
	})
}

function log(msg){
	let ts = Date.now();
	let date = new Date().toLocaleDateString('en-us', { year:"numeric", month:"short", day:"numeric", hour:'2-digit', minute:'2-digit'}) 
	msg = ts + ' | ' + date + ' | ' + msg;
	console.log(msg);
	return fs.appendFile(path.resolve(path.dirname(process.execPath), '..', 'startup.log'),  msg + '\n');
}
/*
let log_buffer = [];
let write_lock = false;
async function log(msg){
	log_buffer.push(Date.now() + ' | ' + msg);
	if(!write_lock){
		write_lock = true;
		let out = '';
		for(let i=0; i<log_buffer.length; i++){
			out += log_buffer[i] + '\n';
		}
		await fs.appendFile(path.join(app_dir, 'startup.log'), out);
		log_buffer = [];
		write_lock = false;
	}
}*/
module.exports = squirrel_startup;