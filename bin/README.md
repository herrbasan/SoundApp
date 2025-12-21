# Binary Resources

This directory contains platform-specific binaries bundled with the application.

## Structure

```
bin/
├── win_bin/
│   ├── ffmpeg.exe
│   ├── ffprobe.exe
│   ├── ffmpeg_napi.node              # FFmpeg NAPI decoder (native addon)
│   ├── player.js                     # Streaming player class
│   ├── ffmpeg-worklet-processor.js   # AudioWorklet processor
│   ├── index.js                      # Module exports
│   └── *.dll                         # FFmpeg DLLs
└── linux_bin/
    ├── ffmpeg
    ├── ffprobe
    ├── ffmpeg_napi.node              # FFmpeg NAPI decoder (native addon)
    ├── player.js                     # Streaming player class
    ├── ffmpeg-worklet-processor.js   # AudioWorklet processor
    ├── index.js                      # Module exports
    └── *.so                          # FFmpeg shared libraries
```

## FFmpeg NAPI Interface

All runtime files are kept together in `bin/`. The source lives in the submodule at `libs/ffmpeg-napi-interface/`.

### Development Workflow

1. **Edit files** in `libs/ffmpeg-napi-interface/lib/`
2. **Sync to bin/** by running:
   ```powershell
   .\scripts\sync-ffmpeg-napi.ps1
   ```
3. **Test** the app
4. **Commit** submodule changes, then SoundApp changes

### Native Addon Changes

If you modify the C++ source (`libs/ffmpeg-napi-interface/src/`):

1. Build in the submodule:
   ```powershell
   cd libs/ffmpeg-napi-interface
   npm run build
   ```
2. Copy the `.node` file to `bin/win_bin/` or `bin/linux_bin/`
3. Test and commit

## Deployment

All files in this directory are included as `extraResource` during packaging (see `forge.config.js`).
