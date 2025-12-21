# SoundApp - Project Overview

## What This Is
A cross-platform desktop audio player built with Electron, designed to play a wide variety of audio formats including browser-native formats, tracker/module music, and legacy audio formats.

## Historical Context
Inspired by the classic [SoundApp](http://www-cs-students.stanford.edu/~franke/SoundApp/) from the Mac OS System 7 era - a beloved lightweight audio previewer that musicians used to quickly audition audio files. The original was famous for its minimal interface and keyboard-driven workflow, allowing rapid navigation through directories of audio files without touching the mouse.

## Project Aim & Philosophy
**Primary Goal:** Create a lightweight, responsive audio player that "just works" with any audio file you throw at it, without the bloat of traditional media players.

**Design Principles:**
- **Universal Format Support:** If FFmpeg can decode it, we can play it
- **Minimal UI:** Clean, distraction-free interface focused on the music
- **Performance First:** Instant playback start, low memory footprint
- **No Database:** Direct file system browsing, no library management overhead
- **Keyboard-Driven:** Efficient workflow for power users
- **Native Feel:** Frameless window, custom UI that feels native to the OS

## Tech Stack
- **Framework:** Electron
- **Audio Libraries:**
  - Custom AudioController (Web Audio API) - Unified playback with gapless looping
  - FFmpegStreamPlayer (bin/win_bin/player.js) - Native NAPI decoder with AudioWorklet streaming
  - libopenmpt (chiptune3.js) - Tracker/module format playback
  - FFmpeg CLI - Legacy transcoding fallback
- **UI:** Custom HTML/CSS with GSAP for animations
- **Platform Support:** Windows and Linux

## Audio Format Handling
The app categorizes audio files into three groups:

1. **Browser-native formats** (`.mp3`, `.wav`, `.flac`, `.ogg`, `.m4a`, etc.)
   - Direct playback via Web Audio API AudioController
   - Loop mode: AudioBuffer for gapless looping
   - Normal mode: MediaElement for efficient streaming

2. **Tracker/Module formats** (`.mod`, `.xm`, `.it`, `.s3m`, etc.)
   - Decoded and played via libopenmpt (AudioWorklet-based)

3. **Unsupported formats** (`.aif`, `.aiff`, `.mpg`, `.mp2`, `.aa`)
   - Decoded via FFmpeg NAPI decoder (native C++ addon)
   - Real-time streaming via AudioWorklet with gapless looping support
   - Fallback: FFmpeg CLI transcoding (legacy)

## Key Features

### Core Features (inspired by original SoundApp)
- **Auto-Playlist from File Context:** Opening a single file automatically loads all audio files from that directory for quick navigation
- **Keyboard-Driven Navigation:** Arrow keys for track navigation, volume control, and seeking
- **Minimal UI:** Clean, focused interface that stays out of the way

### Modern Enhancements
- **Drag-and-Drop Playlist Management:** 
  - Two-zone drop interface: "Add to Playlist" or "Replace Playlist"
  - Folder browsing with optional recursive scanning
- **Visual Polish:**
  - Color-coded format icons (different colors for MP3, FLAC, WAV, AIFF, etc.)
  - Album cover art display when available
  - Dynamic UI scaling (Ctrl+Plus/Minus)
- **Extended Playback Features:**
  - Gapless loop mode (L key) - seamless audio looping
  - Playlist shuffle (R key) - randomize playback order
  - 10-second skip forward/backward (Ctrl+Arrow Left/Right)

### Complete Keyboard Shortcuts
- `Arrow Left/Right` - Previous/Next track
- `Ctrl+Arrow Left/Right` - Skip backward/forward 10 seconds  
- `Arrow Up/Down` - Volume up/down
- `Space` - Play/Pause
- `L` - Toggle loop mode
- `R` - Shuffle playlist
- `I` - Show file in folder
- `Esc` - Exit
- `Ctrl+Plus/Minus` - Scale UI

### Technical Features
- **Audio Info:** Metadata display, cover art extraction, format details
- **File Associations:** Windows registry integration for file type associations
- **Auto-Update:** Squirrel-based updates via electron_helper
  - GitHub Releases API for version checking
  - Automatic download from GitHub CDN
  - Squirrel handles installation/replacement
  - See [docs/github-releases-migration.md](../docs/github-releases-migration.md) for details

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

## Current Architecture Notes
- **Browser-native formats:** AudioController with dual mode (BufferSource for loop, MediaElement for stream)
- **FFmpeg formats:** FFmpegStreamPlayer with native NAPI decoder and AudioWorklet streaming
- **Gapless looping:** Both AudioController and FFmpegStreamPlayer support true gapless looping
- **FFmpeg streaming:** Chunk-based streaming with loop chunk stored for seamless repeat
- Configuration persisted to user config file via electron_helper
- See `bin/LOCAL_FIXES.md` for fixes applied locally to FFmpeg player (carry to source repo)
- See `docs/ffmpeg-player-review.md` for performance/reliability improvement notes

## Coding Philosophy & Style

### Performance First
- High-performance code is a priority
- Prefer native `for` loops over utility functions: `for(let i=0; i<fl.length; i++)` is fastest
- Keep iterator `i` accessible for flexible use within loops
- Avoid forEach and other abstraction layers when performance matters

### Code Structure
- **Functional patterns:** Aim for simple input/output functions
- **Self-contained functions:** Do all related work within a function, sometimes as closures
- **Not dogmatic:** Not religious about stateless functions - pragmatism over purity
- **Repetition is acceptable:** Prefer clarity and self-contained logic over DRY when it makes sense

### Code Style
- **Compact code:** Concise, readable code without comments
- **No comments:** Comments are at best useless, at worst confusing - the code should speak for itself
- **Engage with the function:** Understanding requires reading the implementation anyway

### Dependencies
- **Vanilla JS:** Prefer vanilla JavaScript solutions
- **Minimal dependencies:** If we can build it ourselves, we should
- **Own libraries only:** 
  - `electron_helper` (herrbasan/electron_helper)
  - `native-registry` (herrbasan/native-registry)
  - `nui` (herrbasan/nui)
- **Third-party exceptions:** Only for specialized needs (libopenmpt, FFmpeg, GSAP)

### Working with the Codebase (LLM Instructions)
- **Surgical approach:** Work in careful, thoughtful steps
- **Consider context:** Always analyze connected functions and how changes ripple through the codebase
- **Self-critical:** Review your changes for potential side effects and edge cases
- **When uncertain:** Ask the user for clarification rather than making assumptions
- **Read before modifying:** Understand the full context of what a function does before changing it
- **Avoid try/catch for control flow:** Only use try/catch when there's no other way to determine a fail state - prefer explicit state tracking
- **Graceful error handling:** Fail states should be reported gracefully in the UI, not silently swallowed or causing crashes

## Backlog / Future Refactors

### Version 1.1.2 ✅ DONE
1. ~~**Howler.js Removal / Unified Audio Controller**~~ 
   - ~~Replace Howler.js with direct Web Audio API implementation~~
   - ~~Create unified audio controller for all playback types~~
   - ~~Foundation for future gain/pan/speed controls~~

2. ~~**GitHub Releases for Updates**~~ 
   - ~~Migrate from custom HTTP server to GitHub Releases API~~
   - ~~Update auto-update feature in electron_helper~~
   - See [docs/github-releases-migration.md](../docs/github-releases-migration.md)

### Version 1.1.3
1. **FFmpeg Native Streaming**
   - Stream PCM audio directly from FFmpeg stdout to Web Audio API
   - Hybrid mode: streaming for regular playback, buffered for loop mode
   - Details: See [docs/streaming-refactor.md](../docs/streaming-refactor.md)

### Version 1.1.4
1. **Playlist Window**
   - Separate window displaying full playlist
   - Use `libs/nui/nui_list.js` for virtualized list handling
   - Search, sort, and scroll through large playlists

2. **Help/Documentation Window**
   - In-app user guide with visual keyboard shortcut reference
   - Feature explanations and shortcut table

### Version 1.2
1. **Playback Speed Control**
   - Time Stretching: Change speed while preserving pitch
   - Pitch Shifting: Change playback rate affecting pitch
   - Keyboard controls: Ctrl+Shift+Arrow Up/Down

2. **Multi-Track Mixer**
   - Open folder (max ~20 files) and trigger mixer mode
   - Synchronous playback with per-track volume and panning
   - Use case: Preview bounced stems/tracks from projects

3. **File Format Converter**
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
