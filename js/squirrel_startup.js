const path = require('path');
const spawn = require('child_process').spawn;
const app = require('electron').app;
const fs = require('fs').promises;
const registry = require('../js/registry.js');

function squirrel_startup() {
    return new Promise(async (resolve, reject) => {
        let ret = false;
        let cmd = process.argv[1];
        if (app.isPackaged) {
            let app_exe = process.execPath;
            app_exe = path.resolve(path.dirname(app_exe), '..', path.basename(app_exe));
            let app_path = app.getAppPath();

            let target = path.basename(app_exe);

            if (cmd === '--squirrel-install' || cmd === '--squirrel-updated') {
                await write_log('Creating Shortcut at: ' + target);
                await runCommand(['--createShortcut=' + target + '']);
                // Re-register on both install and update to ensure icon paths are current
                // No need to unregister first - re-registering overwrites existing entries
                await write_log('Registering file types');
                await registry('register', app_exe, app_path);
                await write_log('Install Done');
                ret = true;
            }
            if (cmd === '--squirrel-uninstall') {
                await write_log('Remove Shortcut at: ' + target);
                await runCommand(['--removeShortcut=' + target + '']);
                await registry('unregister', app_exe, app_path);
                await write_log('Uninstall Done');
                ret = true;
            }
            if (cmd === '--squirrel-obsoleted') {
                await write_log('Squirrel Obsoleted');
                ret = true;
            }
            if (cmd === '--squirrel-firstrun') {
                await write_log('Squirrel Firstrun - Registering file types');
                await registry('register', app_exe, app_path);
            }
        }
        resolve(ret, cmd);
    });
}


function runCommand(args) {
    return new Promise((resolve, reject) => {
        var updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
        spawn(updateExe, args, { detached: true }).on('close', resolve);
    })
}

function write_log(msg) {
    let ts = Date.now();
    let date = new Date().toLocaleDateString('en-us', { year: "numeric", month: "short", day: "numeric", hour: '2-digit', minute: '2-digit' })
    msg = ts + ' | ' + date + ' | ' + msg;
    return fs.appendFile(path.resolve(path.dirname(process.execPath), '..', 'startup.log'), msg + '\n');
}

module.exports = squirrel_startup;