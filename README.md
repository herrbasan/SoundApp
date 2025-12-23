# SoundApp - Project Overview

## What This Is
A cross-platform desktop audio player built with Electron. Beside supporting all common formats, it supports tracker/module music and legacy audio formats.

![SoundApp Screenshot](https://raw.githubusercontent.com/herrbasan/SoundApp/main/build/screenshot.png)

## Keyboard Shortcuts

<table>
<thead>
<tr>
<th>Key</th>
<th>Action</th>
</tr>
</thead>
<tbody>
<tr>
<td><kbd>Space</kbd></td>
<td>Play / Pause</td>
</tr>
<tr>
<td><kbd>L</kbd></td>
<td>Toggle loop mode</td>
</tr>
<tr>
<td><kbd>S</kbd></td>
<td>Open settings</td>
</tr>
<tr>
<td><kbd>R</kbd></td>
<td>Shuffle playlist</td>
</tr>
<tr>
<td><kbd>←</kbd></td>
<td>Previous track</td>
</tr>
<tr>
<td><kbd>→</kbd></td>
<td>Next track</td>
</tr>
<tr>
<td><kbd>Ctrl</kbd> + <kbd>←</kbd></td>
<td>Skip back 10 seconds</td>
</tr>
<tr>
<td><kbd>Ctrl</kbd> + <kbd>→</kbd></td>
<td>Skip forward 10 seconds</td>
</tr>
<tr>
<td><kbd>↑</kbd></td>
<td>Volume up</td>
</tr>
<tr>
<td><kbd>↓</kbd></td>
<td>Volume down</td>
</tr>
<tr>
<td><kbd>I</kbd></td>
<td>Show file in folder</td>
</tr>
<tr>
<td><kbd>H</kbd></td>
<td>Show help window</td>
</tr>
<tr>
<td><kbd>X</kbd></td>
<td>Toggle dark/light theme</td>
</tr>
<tr>
<td><kbd>Ctrl</kbd> + <kbd>+</kbd></td>
<td>Scale UI up</td>
</tr>
<tr>
<td><kbd>Ctrl</kbd> + <kbd>-</kbd></td>
<td>Scale UI down</td>
</tr>
<tr>
<td><kbd>F12</kbd></td>
<td>Toggle DevTools</td>
</tr>
<tr>
<td><kbd>Esc</kbd></td>
<td>Exit application</td>
</tr>
</tbody>
</table>

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

**Lossless Compressed:**
- FLAC (`.flac`)
- ALAC - Apple Lossless (`.m4a` with ALAC codec)
- APE - Monkey's Audio (`.ape`)
- WavPack (`.wv`, `.wvc`)
- TTA - True Audio (`.tta`)
- TAK (`.tak`)

**Lossy Compressed:**
- MP3 (`.mp3`)
- MP2 (`.mp2`, `.mpa`, `.mpg`)
- AAC/M4A (`.aac`, `.m4a`, `.m4b`, `.aa`)
- Ogg Vorbis (`.ogg`, `.oga`)
- Opus (`.opus`, `.ogm`, `.mogg`)
- WMA - Windows Media Audio (`.wma`, `.asf`)
- WebM (`.webm`)

**Uncompressed PCM:**
- WAV (`.wav`)
- AIFF/AIF (`.aif`, `.aiff`, `.pcm`)
- AU/SND (`.au`, `.snd`)
- VOC (`.voc`)
- CAF - Core Audio Format (`.caf`)

**Other Formats:**
- Matroska Audio (`.mka`)
- AMR (`.amr`, `.3ga`)
- AC3/E-AC3 - Dolby Digital (`.ac3`, `.eac3`)
- DTS (`.dts`, `.dtshd`)
- Musepack (`.mpc`, `.mp+`)

**Playback mode:**
- Streaming playback via AudioWorklet with chunk-based decoding for memory efficiency
- Gapless looping support (when enabled) via stored loop chunk - no mode switching required

### Tracker/Module Formats (via libopenmpt)
Dedicated handling for tracker music formats via libopenmpt AudioWorklet player:

**Common Formats:**
- ProTracker/FastTracker (`.mod`, `.xm`)
- Scream Tracker (`.s3m`)
- Impulse Tracker (`.it`)
- OpenMPT (`.mptm`)
- MO3 - Compressed modules (`.mo3`)

**Extended Formats:**
- `.669`, `.amf`, `.ams`, `.c67`, `.dbm`, `.digi`, `.dmf`, `.dsm`, `.dsym`, `.dtm`
- `.far`, `.fmt`, `.gdm`, `.ice`, `.imf`, `.j2b`, `.m15`, `.mdl`, `.med`, `.mms`
- `.mt2`, `.mtm`, `.mus`, `.nst`, `.okt`, `.plm`, `.psm`, `.pt36`, `.ptm`
- `.sfx`, `.sfx2`, `.st26`, `.stk`, `.stm`, `.stx`, `.stp`, `.symmod`
- `.ult`, `.wow`, `.oxm`, `.umx`, `.xpk`, `.ppm`, `.mmcmp`

**Total:** 70+ tracker/module format variants supported

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

## Current Architecture Notes (v1.2+)
- **FFmpeg NAPI decoder** handles all audio formats except tracker formats:
  - Chunk-based streaming via AudioWorklet for memory efficiency
  - Configurable output sample rate (44.1kHz to 192kHz) for high-quality playback
  - Multi-threaded decoding support (configurable thread count)
  - Gapless looping support via stored loop chunk (toggle feature, not a separate mode)
  - Direct seeking support via native FFmpeg APIs
  - No temp file overhead
- **libopenmpt player** handles tracker/module formats separately for superior quality
- Configuration persisted to user config file via electron_helper

## Recent Updates

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

## Feature Roadmap

### Short-Term Updates

#### 1. Playback Speed Control
- **Time Stretching:** Change playback speed while preserving pitch
- **Pitch Shifting:** Change playback rate affecting pitch
- **Controls:** Ctrl+Shift+Arrow Up/Down keyboard shortcuts

#### 2. Playlist Window
Separate window displaying the full playlist with enhanced management:
- Virtualized list rendering for large playlists (using `nui_list.js`)
- Search, sort, and scroll capabilities
- Visual feedback of current track

#### 3. Multi-Track Mixer
Advanced feature for simultaneous playback of multiple tracks:
- Open folder (max ~20 files) to trigger mixer mode
- Synchronous playback with per-track volume and panning controls
- **Use case:** Preview bounced stems/tracks from music production projects

#### 4. File Format Converter
Built-in transcoding utility:
- Convert currently playing file to different formats
- Keyboard shortcut opens conversion window with format options
- Powered by FFmpeg NAPI interface for high-quality transcoding

### Version 2.0 (Future Vision)

#### Waveform Visualization
Display audio waveform for visual reference and navigation (if performance constraints allow).

#### Quick Compare Mode
Hold a key to jump to another track for A/B comparison, release to return to original position. Perfect for comparing different mixes or masters.

#### Export Playlist
Save current playlist as M3U or plain text file for archival or sharing.

#### Marker System
Set up to 10 bookmarks within a file (keys 1-0):
- Jump to and play from any marker position
- Integrates with Quick Compare Mode for precise A/B comparison between markers
- Ideal for comparing sections within long recordings

#### Folder Metadata Display
Show aggregate statistics for the current folder: total duration, file count, and total size.

#### Quick Tag Editor
Simple inline ID3/metadata editing for quick corrections without launching external tools.
