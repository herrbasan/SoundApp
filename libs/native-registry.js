"use strict";
const path = require('path');
const fs = require('fs').promises;
const native = require('./native-registry.node');
let REG;
let HK;


(function (HK) {
    HK[HK["CR"] = 2147483648] = "CR";
    HK[HK["CU"] = 2147483649] = "CU";
    HK[HK["LM"] = 2147483650] = "LM";
    HK[HK["U"] = 2147483651] = "U";
    HK[HK["PD"] = 2147483652] = "PD";
    HK[HK["CC"] = 2147483653] = "CC";
    HK[HK["DD"] = 2147483654] = "DD";
})(HK = exports.HK || (exports.HK = {}));

(function (REG) {
    REG[REG["SZ"] = 1] = "SZ";
    REG[REG["EXPAND_SZ"] = 2] = "EXPAND_SZ";
    REG[REG["BINARY"] = 3] = "BINARY";
    REG[REG["DWORD"] = 4] = "DWORD";
    REG[REG["DWORD_BIG_ENDIAN"] = 5] = "DWORD_BIG_ENDIAN";
    REG[REG["DWORD_LITTLE_ENDIAN"] = 4] = "DWORD_LITTLE_ENDIAN";
    REG[REG["LINK"] = 6] = "LINK";
    REG[REG["MULTI_SZ"] = 7] = "MULTI_SZ";
    REG[REG["RESOURCE_LIST"] = 8] = "RESOURCE_LIST";
})(REG = exports.REG || (exports.REG = {}));


function getRegistryKey(root, path) {
    var ret = {};
    var key = native.getKey(root, path);
    if (!key) {
        return null;
    }
    for (var _i = 0, key_1 = key; _i < key_1.length; _i++) {
        var value = key_1[_i];
        ret[value.name] = value;
    }
    return ret;
}
exports.getRegistryKey = getRegistryKey;

function getRegistryValue(root, path, name) {
    var key = getRegistryKey(root, path);
    if (!key || !key[name]) {
        return null;
    }
    return key[name].value;
}
exports.getRegistryValue = getRegistryValue;

function setRegistryValue(root, path, name, type, value) {
    return native.setValue(root, path, type, name, value);
}
exports.setRegistryValue = setRegistryValue;

function listRegistrySubkeys(root, path) {
    return native.listSubkeys(root, path);
}
exports.listRegistrySubkeys = listRegistrySubkeys;

function createRegistryKey(root, path) {
    return native.createKey(root, path);
}
exports.createRegistryKey = createRegistryKey;

function deleteRegistryKey(root, path) {
    return native.deleteKey(root, path);
}
exports.deleteRegistryKey = deleteRegistryKey;

function deleteRegistryValue(root, path, name) {
    return native.deleteValue(root, path, name);
}
exports.deleteRegistryValue = deleteRegistryValue;

/**
 * Registers a file type in the Windows registry.
 * @param {Object} prop - The properties for the ProgID registration.
 * @param {string} prop.progID - ProgID.
 * @param {string} prop.description - The description of the ProgID.
 * @param {string} prop.icon_path - The path to the icon.
 * @param {string} prop.app_name - The name of the application.
 * @param {string} prop.command - The command to open the file type with the application.
 * @param {string[]} prop.extensions - list of extensions to associate with the ProgID.
 */
function registerProgID(prop) {
    return new Promise(async (resolve, reject) => {
        let base = 'Software\\Classes\\';
        prop.reg_path = base + prop.progID + '\\';
        let check = getRegistryKey(HK.CU, prop.reg_path);
        if(check) { await log(prop.progID + JSON.stringify(check)); }
        
        /*Type Description */
        await log(prop.progID + ' | Type Description: ' + prop.description);
        await errorCheck(createRegistryKey(HK.CU, prop.reg_path));
        await errorCheck(setRegistryValue(HK.CU, prop.reg_path, '', REG.SZ, prop.description ));
        

        /*Icon */
        await log(prop.progID + ' | Icon Path: ' + prop.icon_path);
        await errorCheck(createRegistryKey(HK.CU, prop.reg_path + 'DefaultIcon'));
        await errorCheck(setRegistryValue(HK.CU, prop.reg_path + 'DefaultIcon', '', REG.SZ, prop.icon_path));
        

        /*Create Shell */
        await log(prop.progID + ' | Shell Name: ' + prop.app_name);
        prop.reg_path = prop.reg_path + 'shell'
        await errorCheck(createRegistryKey(HK.CU, prop.reg_path));
        prop.reg_path = prop.reg_path + '\\open'
        await errorCheck(createRegistryKey(HK.CU, prop.reg_path));
        await errorCheck(setRegistryValue(HK.CU, prop.reg_path, '', REG.SZ, 'Open with ' + prop.app_name));
        await errorCheck(setRegistryValue(HK.CU, prop.reg_path, 'FriendlyAppName', REG.SZ, prop.app_name));
        

        /*Command */
        prop.reg_path = prop.reg_path + '\\command';
        prop.command = `"${prop.command}" "--process-start-args" "%1"`;
        await log(prop.progID + ' | Shell Command: ' + prop.command);
        await errorCheck(createRegistryKey(HK.CU, prop.reg_path));
        await errorCheck(setRegistryValue(HK.CU, prop.reg_path, '', REG.SZ, prop.command));
        
        /*Extension */
        if(!prop.extensions){ resolve(); return; }
        for (let i = 0; i < prop.extensions.length; i++) {
            let ext = prop.extensions[i];
            ext = ext.charAt(0) === '.' ? ext : '.' + ext;
            await log(prop.progID + ' | Register extension: ' + ext);
            await errorCheck(createRegistryKey(HK.CU, 'Software\\Classes\\' + ext));
            await errorCheck(setRegistryValue(HK.CU, 'Software\\Classes\\' + ext, '', REG.SZ, ''));
            await errorCheck(createRegistryKey(HK.CU, 'Software\\Classes\\' + ext + '\\OpenWithProgids'));
            await errorCheck(setRegistryValue(HK.CU, 'Software\\Classes\\' + ext + '\\OpenWithProgids', prop.progID, REG.SZ, ''));
        }
        resolve();
    })
}

/**
 * Cleans up the registry entries for a file type.
 * @param {Object} prop - The properties for the file type registration.
 * @param {string} prop.progID - ProgID.
 * @param {string[]} prop.extensions - The list of extensions to clean up.
 */
async function removeProgID(prop) {
    return new Promise(async (resolve, reject) => {
        let base = 'Software\\Classes\\';
        prop.reg_path = base + prop.progID + '\\';
        await log(prop.reg_path);
        let check = getRegistryKey(HK.CU, prop.reg_path);
        if (check) {
            await log(prop.progID + ' | Cleaning up registry');
            await errorCheck(deleteRegistryKey(HK.CU, prop.reg_path));
            await log(prop.progID + ' | Registry cleaned up for' + prop.progID);
        } else {
            await log(prop.progID + ' | No registry entries found for ' + prop.progID);
        }

        // Remove the application association from the file extensions
        if (!prop.extensions) { resolve(); return; }
        if (prop.extensions && Array.isArray(prop.extensions)) {
            prop.extensions.forEach(async extension => {
                extension = extension.charAt(0) === '.' ? extension : '.' + extension;
                let extPath = base + extension + '\\OpenWithProgids';
                let extKey = getRegistryKey(HK.CU, extPath);
                if (extKey && extKey[prop.progID]) {
                    await errorCheck(deleteRegistryValue(HK.CU, extPath, prop.progID));
                    await log(prop.progID + ' | ' + `Removed association for ${extension}`);
                }
                else {
                    await log(prop.progID + ' | ' + `No association found for ${extension}`);
                }
            });
        }
        resolve();
    });
}

async function errorCheck(ret) { 
    if (ret) { return log('Error: ' + JSON.stringify(ret)); }
    else { return; } 
}

function log(msg) {
    let ts = Date.now();
    let date = new Date().toLocaleDateString('en-us', { year: "numeric", month: "short", day: "numeric", hour: '2-digit', minute: '2-digit' })
    msg = ts + ' | ' + date + ' | ' + msg;
    console.log(msg);
    return fs.appendFile(path.resolve(path.dirname(process.execPath), '..', 'registry.log'), msg + '\n');
}

exports.registerProgID = registerProgID;
exports.removeProgID = removeProgID;
