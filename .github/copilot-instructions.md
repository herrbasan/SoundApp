# SoundApp - Project Overview

## About The Author (Context For LLM)

- Name/handle: herrbasan (also GitHub username)
- Background: German, 50+, residing in Germany
- Experience: Web developer since ~1996; very strong in JS/CSS/HTML
- Lower experience: relatively little hands-on practice with C/C++/C#
- Domain: musician; SoundApp is built primarily as a practical tool for personal music work
- Product direction: long-used private tool now being prepared for public release
- Major architecture shift: moved from using the FFmpeg CLI to a native NAPI implementation

## What This Is
A cross-platform desktop audio player built with Electron, designed to play a wide variety of audio formats including browser-native formats, tracker/module music, and legacy audio formats.

## Project Structure
- `js/stage.js` - Main player logic and audio handling
- `js/audio_controller.js` - Unified Web Audio API controller for browser-native formats
- `js/app.js` - Main process (Electron)
- `js/registry.js` - Windows file association handling
- `js/window-loader.js` - Shared window initialization and IPC bridge
- `bin/win_bin/player.js` - FFmpegStreamPlayer class (NAPI decoder + AudioWorklet)
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorklet for chunk-based streaming
- `bin/win_bin/ffmpeg_napi.node` - Native FFmpeg decoder addon
- `libs/` - Third-party audio libraries (NUI framework, electron_helper, chiptune, etc.)
- `bin/` - FFmpeg binaries and NAPI addon for Windows and Linux
- `html/` - Window templates (stage.html, help.html)
- `css/` - Styling (window.css, fonts.css, etc.)

## Window System
Secondary windows (help, settings, playlist) are complete standalone HTML pages that work in both Electron and browser preview. Each window uses the NUI framework for chrome and layout.

**Architecture:**
- `html/*.html` - Complete pages with NUI chrome (`<div class="nui-app">`, `.nui-title-bar`, `.content`, `<main>`)
- `js/window-loader.js` - Detects Electron vs browser, creates `window.bridge` API
- `css/window.css` - Window layout and content styles
- Browser preview: Mock IPC bridge logs to console, uses localStorage for config

**Window Management (stage.js):**
```javascript
g.windows = { help: null, settings: null, playlist: null };
async function openWindow(type) {
  // Reuse if open, create if not
  // Windows auto-cleanup on close via 'window-closed' IPC
}
```

**Global Settings Pattern:**
Stage broadcasts changes to all windows (e.g., theme toggle). Windows listen via `ipcRenderer.on('theme-changed')` and apply on open via init_data.

**Creating New Windows:**
1. Copy help.html structure with NUI framework classes
2. Preview in browser (live-server) for rapid CSS iteration
3. Add content to `<main>` element
4. Wire up in stage.js with keyboard shortcut


## Coding Philosophy & Style

### Performance First
- **High-performance code is a priority** - Optimize for performance with knowledge of the JavaScript runtime
  - Example: Prefer native `for` loops over utility functions: `for(let i=0; i<fl.length; i++)` is fastest
  - Example: Avoid modern array functions like `.map()`, `.filter()`, `.forEach()` in performance-critical code - direct iteration with `for` loops is significantly faster
  - Keep iterator `i` accessible for flexible use within loops

### Code Structure
- **Functional patterns:** Aim for simple input/output functions
- **Self-contained functions:** Do all related work within a function, sometimes as closures
- **Not dogmatic:** Not religious about stateless functions - pragmatism over purity
- **Repetition is acceptable:** Prefer clarity and self-contained logic over DRY when it makes sense

### Code Style
- **Compact code:** Optimize for performance first, then for logical structure that humans and LLMs can understand - descriptive function names are important, traditional readability concerns are not
- **Avoid comments except for major section separation - write self-explanatory code instead**
- **Engage with the function:** Understanding requires reading the implementation anyway

### Dependencies
- **Vanilla JS:** Prefer vanilla JavaScript solutions
- **Minimal dependencies:** If we can build it ourselves, we should
- **Own libraries only:** 
  - `electron_helper` (herrbasan/electron_helper)
  - `native-registry` (herrbasan/native-registry)
  - `nui` (herrbasan/nui)
- **Third-party exceptions:** Only for specialized needs (libopenmpt, FFmpeg)

### Working with the Codebase (LLM Instructions)
- **Surgical approach:** Work in careful, thoughtful steps
- **Consider context:** Always analyze connected functions and how changes ripple through the codebase
- **Self-critical:** Review your changes for potential side effects and edge cases
- **When uncertain:** Ask the user for clarification rather than making assumptions
- **Read before modifying:** Understand the full context of what a function does before changing it
- **Avoid try/catch for control flow:** Only use try/catch when there's no other way to determine a fail state - prefer explicit state tracking
- **Graceful error handling:** Fail states should be reported gracefully in the UI, not silently swallowed or causing crashes

## Release History

### Version 1.2 (December 2025)
- **HQ Mode Restored** - Configurable max output sample rate (44.1kHz to 192kHz) for high-quality playback
  - Native FFmpeg decoder outputs at exact AudioContext sample rate to prevent pitch/speed errors
  - Time-based chunking (0.1s per chunk) maintains stability across all sample rates
  - Gapless looping verified working at all sample rates (44.1k, 96k, 192k)
- **Decoder Threading** - FFmpeg multi-threaded decoding support
  - Configurable thread count (0=auto, 1-8=specific count)
  - Frame + slice threading for parallel decoding
  - Settings UI with buffer size timing estimates
- **Backward Compatibility** - Comprehensive configuration defaults ensure smooth updates
  - All settings have fallback values in code and UI
  - Empty/missing config files work correctly with defaults

## Backlog / Future Features

### Short Term Updates

1. **Playback Speed Control**
   - Time Stretching: Change speed while preserving pitch
   - Pitch Shifting: Change playback rate affecting pitch
   - Keyboard controls: Ctrl+Shift+Arrow Up/Down

2. **Playlist Window**
   - Separate window displaying full playlist
   - Use `libs/nui/nui_list.js` for virtualized list handling
   - Search, sort, and scroll through large playlists

3. **Multi-Track Mixer**
   - Open folder (max ~20 files) and trigger mixer mode
   - Synchronous playback with per-track volume and panning
   - Use case: Preview bounced stems/tracks from projects

4. **File Format Converter**
   - Convert currently playing file to different formats
   - Keyboard shortcut opens conversion window with format options
   - FFmpeg NAPI interface for transcoding

### Version 2.0 (Future)
- **Waveform Visualization** - Display audio waveform (if performance allows)
- **Quick Compare Mode** - Hold key to jump to another track, release to return
- **Export Playlist** - Save playlist as M3U or text file
- **Marker System** - Set up to 10 markers in a file (keys 1-0), jump and play from markers
  - Integrates with Quick Compare Mode for A/B comparison between markers
- **Folder Metadata Display** - Show folder stats (duration, file count, size)
- **Quick Tag Editor** - Simple inline ID3/metadata editing
