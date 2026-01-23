const path = require('path');
const fs = require('fs');

module.exports = {
  packagerConfig: {
    asar: true,
    ignore: [
      '_Material', 
      '_gsdata_', 
      '.vscode', 
      'build', 
      'bin',
      'node_modules',
      'env.json'
    ],
    extraResource: [
      "./build/icons/"
    ],
    executableName: 'soundApp',
    icon: path.join(__dirname, 'build', 'icons', 'app.ico'),
  },
  hooks: {
    postPackage: async (forgeConfig, options) => {
      const platform = options.platform; // 'win32', 'linux', 'darwin'
      console.info('Post-Package Hook: Copying binaries for ' + platform);

      for (const outputPath of options.outputPaths) {
        const resourcesPath = path.join(outputPath, 'resources');
        const binDest = path.join(resourcesPath, 'bin');
        
        // Ensure bin directory exists
        if (!fs.existsSync(binDest)) {
          fs.mkdirSync(binDest, { recursive: true });
        }

        // Copy SoundFonts (only the active one to save space)
        const sfSrc = path.join(__dirname, 'bin', 'soundfonts');
        const sfDest = path.join(binDest, 'soundfonts');
        fs.mkdirSync(sfDest, { recursive: true });
        
        const sfFiles = ['default.sf2', 'README.md'];
        for (const file of sfFiles) {
          const src = path.join(sfSrc, file);
          const dest = path.join(sfDest, file);
          if (fs.existsSync(src)) {
             fs.copyFileSync(src, dest);
          } else {
             console.warn(`Warning: SoundFont file not found: ${src}`);
          }
        }

        // Copy Platform Binaries
        let binSrcFolder = '';
        if (platform === 'win32') {
          binSrcFolder = 'win_bin';
        } else if (platform === 'linux') {
          binSrcFolder = 'linux_bin';
        }

        if (binSrcFolder) {
          const src = path.join(__dirname, 'bin', binSrcFolder);
          const dest = path.join(binDest, binSrcFolder);
          if (fs.existsSync(src)) {
            // cpSync available in Node 16.7+
            fs.cpSync(src, dest, { recursive: true });
            console.info(`Copied ${binSrcFolder} to resources`);
          } else {
             console.error(`Error: Binaries path not found: ${src}`);
          }
        }
      }
    }
  },
  rebuildConfig: {
    onlyModules: []
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'soundApp',
        setupExe: 'soundApp_Setup.exe',
        setupIcon: path.join(__dirname, 'build', 'icons', 'installer.ico'),
        loadingGif: path.join(__dirname, 'build', 'loader.gif'),
        iconUrl: 'https://raum.com/update/soundapp/app.ico',
      },
    }
  ],
};
