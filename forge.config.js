const path = require('path');

module.exports = {
  packagerConfig: {
    asar:true,
    ignore:['_Material', '_gsdata_', '.vscode', 'build', 'bin'],
    extraResource: [
      "./bin", 
      "./build/icons/"
    ],
    executableName: 'soundApp',
    icon:path.join(__dirname, 'build', 'icons', 'app.ico'),
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'soundApp',
        setupExe: 'soundApp_Setup.exe',
        setupIcon: path.join(__dirname, 'build', 'icons', 'installer.ico'),
        iconUrl:'https://raum.com/update/soundapp/app.ico',
      },
    }
  ],
};
