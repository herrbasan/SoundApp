# SoundApp - Project Overview

## What This Is
A cross-platform desktop audio player built with Electron, designed to play a wide variety of audio formats including browser-native formats, tracker/module music, and legacy audio formats.

## Project Structure
- `js/stage.js` - Main player logic and audio handling
- `js/audio_controller.js` - Unified Web Audio API controller for browser-native formats
- `js/app.js` - Main process (Electron)
- `js/registry.js` - Windows file association handling
- `bin/win_bin/player.js` - FFmpegStreamPlayer class (NAPI decoder + AudioWorklet)
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorklet for chunk-based streaming
- `bin/win_bin/ffmpeg_napi.node` - Native FFmpeg decoder addon
- `libs/` - Third-party audio libraries
- `bin/` - FFmpeg binaries and NAPI addon for Windows and Linux
- `html/` - Window templates
- `css/` - Styling


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

## Backlog / Future Refactors

### Short term Updates / Features
1. **Playlist Window**
   - Separate window displaying full playlist
   - Use `libs/nui/nui_list.js` for virtualized list handling
   - Search, sort, and scroll through large playlists

2. **Help/Documentation Window**
   - In-app user guide with visual keyboard shortcut reference
   - Feature explanations and shortcut table

3. **Playback Speed Control**
   - Time Stretching: Change speed while preserving pitch
   - Pitch Shifting: Change playback rate affecting pitch
   - Keyboard controls: Ctrl+Shift+Arrow Up/Down

4. **Multi-Track Mixer**
   - Open folder (max ~20 files) and trigger mixer mode
   - Synchronous playback with per-track volume and panning
   - Use case: Preview bounced stems/tracks from projects

5. **File Format Converter**
   - Convert currently playing file to different formats
   - Keyboard shortcut opens conversion window with format options
   - FFmpeg CLI for transcoding

### Version 2.0 (Future)
- **Waveform Visualization** - Display audio waveform (if performance allows)
- **Quick Compare Mode** - Hold key to jump to another track, release to return
- **Export Playlist** - Save playlist as M3U or text file
- **Marker System** - Set up to 10 markers in a file (keys 1-0), jump and play from markers
  - Integrates with Quick Compare Mode for A/B comparison between markers
- **Folder Metadata Display** - Show folder stats (duration, file count, size)
- **Quick Tag Editor** - Simple inline ID3/metadata editing
