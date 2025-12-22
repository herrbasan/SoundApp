# SoundApp - Project Overview

## What This Is
A cross-platform desktop audio player built with Electron, designed to play a wide variety of audio formats including browser-native formats, tracker/module music, and legacy audio formats.

## Historical Context
Inspired by the classic [SoundApp](http://www-cs-students.stanford.edu/~franke/SoundApp/) from the Mac OS System 7 era - a beloved lightweight audio previewer that musicians used to quickly audition audio files. The original was famous for its minimal interface and keyboard-driven workflow, allowing rapid navigation through directories of audio files without touching the mouse.

## Project Aim & Philosophy
**Primary Goal:** Create a lightweight, responsive audio player that "just works" with any audio file you throw at it, without the bloat of traditional media players. Designed for audio professionals who need to quickly audition and navigate through large collections of audio files.

**Key Feature:** True gapless looping - seamlessly loop any audio file without interruption, perfect for auditioning loops and samples.

**Design Principles:**
- **Universal Format Support:** If FFmpeg can decode it, we can play it
- **Minimal UI:** Clean, distraction-free interface focused on the music
- **Performance First:** Instant playback start, low memory footprint
- **No Database:** Direct file system browsing, no library management overhead
- **Keyboard-Driven:** Efficient workflow for power users

## Tech Stack
- **Framework:** Electron
- **Audio Libraries:**
  - Custom AudioController (Web Audio API) - Unified playback with gapless looping
  - libopenmpt (chiptune3.js) - Tracker/module format playback
  - FFmpeg NAPI decoder - Native decoder for all audio formats with streaming support
- **UI:** Custom HTML/CSS with Web Animation API for transitions
- **Platform Support:** Windows and Linux

## Audio Format Handling
SoundApp leverages FFmpeg's extensive format support to handle nearly all audio formats. Playback is managed through two systems:

### FFmpeg-Decoded Formats (via NAPI Decoder)
All standard audio formats are decoded through the FFmpeg NAPI decoder and played via Web Audio API:
- **Lossless:** `.wav`, `.flac`, `.alac`, `.ape`, `.wv` (WavPack), `.tta`
- **Lossy:** `.mp3`, `.aac`, `.m4a`, `.ogg`, `.opus`, `.wma`
- **Legacy/Professional:** `.aif`, `.aiff`, `.au`, `.snd`, `.voc`, `.amr`
- **Video Audio Streams:** `.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.mpg`, `.mp2`
- **Other:** `.ac3`, `.dts`, `.ra` (RealAudio), `.mka`

**Playback modes:**
- Stream mode: Real-time decoding via AudioWorklet for memory efficiency
- Loop mode: Full buffer decode for true gapless looping

### Tracker/Module Formats (via libopenmpt)
Dedicated handling for tracker music formats via libopenmpt AudioWorklet player:
- **Formats:** `.mod`, `.xm`, `.it`, `.s3m`, `.mptm`, `.umx`, `.mo3`, `.mtm`, `.dbm`, `.far`, `.mdl`, and more

**Note:** While FFmpeg can decode tracker formats, we use libopenmpt directly for superior playback quality and authenticity to the original tracker sound.

## Key Features

### Core Features (inspired by original SoundApp)
- **Auto-Playlist from File Context:** Opening a single file automatically adds all audio files from that directory to the playlist for quick navigation
- **Keyboard-Driven Navigation:** Arrow keys for track navigation, volume control, and seeking
- **Minimal UI:** Clean, focused interface that stays out of the way

### Modern Enhancements
- **Drag-and-Drop Playlist Management:** 
  - Two-zone drop interface: "Add to Playlist" or "Replace Playlist"
  - Recursive folder scanning by default
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

## Project Structure
- `js/stage.js` - Main player logic and audio handling
- `js/audio_controller.js` - Unified Web Audio API controller
- `js/app.js` - Main process (Electron)
- `js/registry.js` - Windows file association handling
- `bin/win_bin/player.js` - FFmpegStreamPlayer (NAPI decoder + AudioWorklet)
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorklet for chunk streaming
- `bin/win_bin/ffmpeg_napi.node` - Native FFmpeg decoder addon
- `libs/` - Third-party audio libraries (chiptune, electron_helper, nui)
- `bin/` - FFmpeg binaries and NAPI decoder for Windows and Linux
- `scripts/` - Build and update scripts
- `html/` - Window templates
- `css/` - Styling

## Current Architecture Notes (v1.1.3+)
- **FFmpeg NAPI decoder** handles all audio formats except tracker formats:
  - Chunk-based streaming via AudioWorklet for memory efficiency
  - Gapless looping support via stored loop chunk (toggle feature, not a separate mode)
  - Direct seeking support via native FFmpeg APIs
  - No temp file overhead
- **libopenmpt player** handles tracker/module formats separately for superior quality
- Configuration persisted to user config file via electron_helper
