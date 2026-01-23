const path = require('path');
const { exec } = require('child_process');
const reg = require('../libs/native-registry/dist/native-registry.js');

const APP_NAME = 'SoundApp';
const APP_DESCRIPTION = 'SoundApp - Audio player supporting MP3, FLAC, OGG, tracker modules, and many more formats.';
const CAPABILITIES_PATH = 'SOFTWARE\\SoundApp\\Capabilities';

async function registry(task, exe_path, app_path) {
    return new Promise(async (resolve, reject) => {
        let icon_path;
        // Check if this is a packaged app by looking at app_path (ASAR location)
        if (app_path.includes('app.asar')) {
            // Packaged app: app_path is at app-X.X.X/resources/app.asar, icons at app-X.X.X/resources/icons
            icon_path = path.join(path.dirname(app_path), 'icons');
        } else {
            // Dev mode: derive from app_path
            icon_path = path.join(path.dirname(app_path), 'build', 'icons');
        }
        let registry_data = {
            app: {
                name: 'SoundApp',
                exe: path.basename(exe_path),
            },
            filetypes: {
                soundapp_mp3: {
                    description: 'MP3 Audio File',
                    icon: 'mp3.ico',
                    extensions: ['mp3'],
                },
                soundapp_mp2: {
                    description: 'MP2 Audio File',
                    icon: 'pcm.ico',
                    extensions: ['mp2', 'mpa'],
                },
                soundapp_m4a: {
                    description: 'AAC Audio File',
                    icon: 'm4a.ico',
                    extensions: ['m4a', 'm4b', 'aac', 'aa'],
                },
                soundapp_flac: {
                    description: 'FLAC Audio File',
                    icon: 'flac.ico',
                    extensions: ['flac'],
                },
                soundapp_pcm: {
                    description: 'PCM Audio File',
                    icon: 'pcm.ico',
                    extensions: ['wav', 'aif', 'aiff', 'pcm'],
                },
                soundapp_ogg: {
                    description: 'Ogg Vorbis Audio File',
                    icon: 'ogg.ico',
                    extensions: ['ogg', 'oga', 'opus', 'ogm', 'mogg'],
                },
                soundapp_mod: {
                    description: 'Tracker Module',
                    icon: 'mod.ico',
                    extensions: [
                        'mptm', 'mod', 'mo3', 's3m', 'xm', 'it', '669', 'amf', 'ams', 'c67', 'dbm', 'digi', 'dmf',
                        'dsm', 'dsym', 'dtm', 'far', 'fmt', 'imf', 'ice', 'j2b', 'm15', 'mdl', 'med', 'mms', 'mt2', 'mtm', 'mus',
                        'nst', 'okt', 'plm', 'psm', 'pt36', 'ptm', 'sfx', 'sfx2', 'st26', 'stk', 'stm', 'stx', 'stp', 'symmod',
                        'ult', 'wow', 'gdm', 'mo3', 'oxm', 'umx', 'xpk', 'ppm', 'mmcmp'
                    ]
                },
                soundapp_midi: {
                    description: 'MIDI Audio File',
                    icon: 'midi.ico',
                    extensions: ['mid', 'midi', 'kar', 'rmi']
                },
                soundapp_wma: {
                    description: 'Windows Media Audio',
                    icon: 'pcm.ico',
                    extensions: ['wma', 'asf']
                },
                soundapp_ape: {
                    description: 'Monkey\'s Audio',
                    icon: 'pcm.ico',
                    extensions: ['ape']
                },
                soundapp_wavpack: {
                    description: 'WavPack Audio',
                    icon: 'pcm.ico',
                    extensions: ['wv', 'wvc']
                },
                soundapp_tta: {
                    description: 'True Audio',
                    icon: 'pcm.ico',
                    extensions: ['tta']
                },
                soundapp_mka: {
                    description: 'Matroska Audio',
                    icon: 'pcm.ico',
                    extensions: ['mka']
                },
                soundapp_amr: {
                    description: 'AMR Audio',
                    icon: 'pcm.ico',
                    extensions: ['amr', '3ga']
                },
                soundapp_ac3: {
                    description: 'AC3 Audio',
                    icon: 'pcm.ico',
                    extensions: ['ac3', 'eac3']
                },
                soundapp_dts: {
                    description: 'DTS Audio',
                    icon: 'pcm.ico',
                    extensions: ['dts', 'dtshd']
                },
                soundapp_misc: {
                    description: 'Audio File',
                    icon: 'pcm.ico',
                    extensions: ['caf', 'au', 'snd', 'voc', 'tak', 'mka', 'mpc', 'mp+']
                }
            }
        }
     
        if (task === 'register') {
            // Register ProgIDs for each file type
            for (let key in registry_data.filetypes) {
                try {
                    await reg.registerProgID({
                        progID: key,
                        description: registry_data.filetypes[key].description,
                        app_name: registry_data.app.name,
                        icon_path: path.resolve(icon_path, registry_data.filetypes[key].icon),
                        command: exe_path,
                        extensions: registry_data.filetypes[key].extensions,
                    })
                } catch (err) {
                    console.error(`Failed to register ${key}:`, err);
                }
            }

            // Register Capabilities for Default Programs integration
            try {
                // Create Capabilities key
                reg.createRegistryKey(reg.HK.CU, CAPABILITIES_PATH);
                reg.setRegistryValue(reg.HK.CU, CAPABILITIES_PATH, 'ApplicationDescription', reg.REG.SZ, APP_DESCRIPTION);
                reg.setRegistryValue(reg.HK.CU, CAPABILITIES_PATH, 'ApplicationName', reg.REG.SZ, APP_NAME);

                // Create FileAssociations subkey with all extensions mapped to their ProgIDs
                let fileAssocPath = CAPABILITIES_PATH + '\\FileAssociations';
                reg.createRegistryKey(reg.HK.CU, fileAssocPath);
                for (let key in registry_data.filetypes) {
                    let exts = registry_data.filetypes[key].extensions;
                    for (let i = 0; i < exts.length; i++) {
                        let ext = '.' + exts[i];
                        reg.setRegistryValue(reg.HK.CU, fileAssocPath, ext, reg.REG.SZ, key);
                    }
                }

                // Register in RegisteredApplications
                reg.createRegistryKey(reg.HK.CU, 'SOFTWARE\\RegisteredApplications');
                reg.setRegistryValue(reg.HK.CU, 'SOFTWARE\\RegisteredApplications', APP_NAME, reg.REG.SZ, CAPABILITIES_PATH);
            } catch (err) {
                console.error('Failed to register Capabilities:', err);
            }
        }
        else if (task === 'unregister') {
            // Remove ProgIDs
            for (let key in registry_data.filetypes) {
                try {
                    await reg.removeProgID({ progID: key, extensions: registry_data.filetypes[key].extensions});
                } catch (err) {
                    console.error(`Failed to unregister ${key}:`, err);
                }
            }

            // Remove Capabilities and RegisteredApplications entry
            try {
                reg.deleteRegistryValue(reg.HK.CU, 'SOFTWARE\\RegisteredApplications', APP_NAME);
                reg.deleteRegistryKey(reg.HK.CU, 'SOFTWARE\\SoundApp');
            } catch (err) {
                console.error('Failed to remove Capabilities:', err);
            }
        }
  
        resolve(true);
    });
}

/**
 * Opens the Windows Default Programs control panel for SoundApp.
 * This allows users to set SoundApp as the default for all registered file types.
 */
function openDefaultProgramsUI() {
    // Opens the classic "Set Default Programs" dialog - works on Windows 10/11
    // Users can select SoundApp and check all file types at once
    exec('control /name Microsoft.DefaultPrograms /page pageDefaultProgram');
}

module.exports = registry;
module.exports.openDefaultProgramsUI = openDefaultProgramsUI;