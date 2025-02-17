const path = require('path');
const reg = require('../libs/native-registry/dist/native-registry.js');


async function registry(task, exe_path, app_path) {
    return new Promise(async (resolve, reject) => {
        let icon_path = path.join(path.dirname(app_path), 'icons');
        let registry_data = {
            app: {
                name: 'SoundApp',
                exe: path.basename(exe_path),
            },
            filetypes: {
                soundapp_mp3: {
                    description: 'SoundApp Audio File',
                    icon: 'mp3.ico',
                    extensions: ['mp3'],
                },
                soundapp_mp2: {
                    description: 'SoundApp Audio File',
                    icon: 'pcm.ico',
                    extensions: ['mp2', 'mpa'],
                },
                soundapp_m4a: {
                    description: 'SoundApp Audio File',
                    icon: 'm4a.ico',
                    extensions: ['m4a', 'm4b', 'aac', 'aa'],
                },
                soundapp_flac: {
                    description: 'SoundApp Audio File',
                    icon: 'flac.ico',
                    extensions: ['flac'],
                },
                soundapp_pcm: {
                    description: 'SoundApp Audio File',
                    icon: 'pcm.ico',
                    extensions: ['wav', 'aif', 'aiff', 'pcm'],
                },
                soundapp_ogg: {
                    description: 'SoundApp Audio File',
                    icon: 'ogg.ico',
                    extensions: ['ogg', 'oga', 'opus', 'ogm', 'mogg'],
                },
                soundapp_mod: {
                    description: 'SoundApp Audio File',
                    icon: 'mod.ico',
                    extensions: [
                        'mptm', 'mod', 'mo3', 's3m', 'xm', 'it', '669', 'amf', 'ams', 'c67', 'dbm', 'digi', 'dmf',
                        'dsm', 'dsym', 'dtm', 'far', 'fmt', 'imf', 'ice', 'j2b', 'm15', 'mdl', 'med', 'mms', 'mt2', 'mtm', 'mus',
                        'nst', 'okt', 'plm', 'psm', 'pt36', 'ptm', 'sfx', 'sfx2', 'st26', 'stk', 'stm', 'stx', 'stp', 'symmod',
                        'ult', 'wow', 'gdm', 'mo3', 'oxm', 'umx', 'xpk', 'ppm', 'mmcmp'
                    ]
                }
            }
        }
     
        if (task === 'register') {
            for (let key in registry_data.filetypes) {
                await reg.registerProgID({
                    progID: key,
                    description: registry_data.filetypes[key].description,
                    app_name: registry_data.app.name,
                    icon_path: path.resolve(icon_path, registry_data.filetypes[key].icon),
                    command: exe_path,
                    extensions: registry_data.filetypes[key].extensions,
                })
            }
        }
        else if (task === 'unregister') {
            for (let key in registry_data.filetypes) {
                await reg.removeProgID({ progID: key, extensions: registry_data.filetypes[key].extensions});
            }
        }
  
        resolve(true);
    });
}

module.exports = registry;