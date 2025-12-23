const path = require('path');
const reg = require('../libs/native-registry/dist/native-registry.js');


async function registry(task, exe_path, app_path) {
    return new Promise(async (resolve, reject) => {
        let icon_path = path.join(process.resourcesPath || path.dirname(app_path), 'icons');
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