# SoundApp — Technical Architecture

This document covers the internal architecture of SoundApp for contributors and curious developers. For user-facing documentation, see the main [README](../README.md).

## Tech Stack

- **Framework:** Electron
- **Audio Libraries:**
  - Custom AudioController (Web Audio API) — Unified playback with gapless looping
  - libopenmpt (chiptune3.js) — Tracker/module format playback
  - FFmpeg NAPI decoder — Native decoder for all audio formats with streaming support
- **UI:** Custom HTML/CSS with Web Animation API for transitions
- **Platform Support:** Windows and Linux

## Project Structure

```
js/stage.js              — Main player logic and audio handling
js/audio_controller.js   — Unified Web Audio API controller
js/app.js                — Main process (Electron)
js/registry.js           — Windows file association handling
js/window-loader.js      — Shared window initialization and IPC bridge

bin/win_bin/player.js                  — FFmpegStreamPlayer (NAPI decoder + AudioWorklet)
bin/win_bin/ffmpeg-worklet-processor.js — AudioWorklet for chunk streaming
bin/win_bin/ffmpeg_napi.node           — Native FFmpeg decoder addon

js/midi/midi.js                  — MIDI player wrapper (FluidSynth)
js/midi/midi.worklet.js          — MIDI hook worklet
js/midi_controller.js            — Controller for MIDI playback logic

js/mixer/main.js                 — Mixer UI + playlist handover
js/mixer/mixer_engine.js         — Mixer engine (buffer decode + AudioWorklet)
js/mixer/mixer-worklet-processor.js — AudioWorkletProcessor for multi-track mixing

libs/       — Third-party audio libraries (chiptune, midiplayer, electron_helper, nui)
bin/        — FFmpeg binaries and NAPI decoder for Windows and Linux
scripts/    — Build and release scripts
html/       — Window templates
css/        — Styling
```

## Audio Format Handling

SoundApp leverages FFmpeg's extensive format support. Playback is managed through two systems:

### FFmpeg-Decoded Formats (via NAPI Decoder)

All standard audio formats are decoded through the FFmpeg NAPI decoder and played via Web Audio API.

**Lossless Compressed:**
- FLAC (`.flac`)
- ALAC — Apple Lossless (`.m4a` with ALAC codec)
- APE — Monkey's Audio (`.ape`)
- WavPack (`.wv`, `.wvc`)
- TTA — True Audio (`.tta`)
- TAK (`.tak`)

**Lossy Compressed:**
- MP3 (`.mp3`)
- MP2 (`.mp2`, `.mpa`, `.mpg`)
- AAC/M4A (`.aac`, `.m4a`, `.m4b`, `.aa`)
- Ogg Vorbis (`.ogg`, `.oga`)
- Opus (`.opus`, `.ogm`, `.mogg`)
- WMA — Windows Media Audio (`.wma`, `.asf`)
- WebM (`.webm`)

**Uncompressed PCM:**
- WAV (`.wav`)
- AIFF/AIF (`.aif`, `.aiff`, `.pcm`)
- AU/SND (`.au`, `.snd`)
- VOC (`.voc`)
- CAF — Core Audio Format (`.caf`)

**Other Formats:**
- Matroska Audio (`.mka`)
- AMR (`.amr`, `.3ga`)
- AC3/E-AC3 — Dolby Digital (`.ac3`, `.eac3`)
- DTS (`.dts`, `.dtshd`)
- Musepack (`.mpc`, `.mp+`)

**Playback architecture:**
- Streaming playback via AudioWorklet with chunk-based decoding for memory efficiency
- Gapless looping support via stored loop chunk — no mode switching required

### Tracker/Module Formats (via libopenmpt)

Dedicated handling for tracker music via libopenmpt AudioWorklet player:

**Common Formats:**
- ProTracker/FastTracker (`.mod`, `.xm`)
- Scream Tracker (`.s3m`)
- Impulse Tracker (`.it`)
- OpenMPT (`.mptm`)
- MO3 — Compressed modules (`.mo3`)

**Extended Formats:**
`.669`, `.amf`, `.ams`, `.c67`, `.dbm`, `.digi`, `.dmf`, `.dsm`, `.dsym`, `.dtm`, `.far`, `.fmt`, `.gdm`, `.ice`, `.imf`, `.j2b`, `.m15`, `.mdl`, `.med`, `.mms`, `.mt2`, `.mtm`, `.mus`, `.nst`, `.okt`, `.plm`, `.psm`, `.pt36`, `.ptm`, `.sfx`, `.sfx2`, `.st26`, `.stk`, `.stm`, `.stx`, `.stp`, `.symmod`, `.ult`, `.wow`, `.oxm`, `.umx`, `.xpk`, `.ppm`, `.mmcmp`

**Total:** 70+ tracker/module format variants supported

**Note:** While FFmpeg can decode tracker formats, we use libopenmpt directly for superior playback quality and authenticity to the original tracker sound.

## Architecture Notes (v1.2+)

- **FFmpeg NAPI decoder** handles all audio formats except tracker formats:
  - Chunk-based streaming via AudioWorklet for memory efficiency
  - Configurable output sample rate (44.1kHz to 192kHz) for high-quality playback
  - Multi-threaded decoding support (configurable thread count)
  - Gapless looping support via stored loop chunk
  - Direct seeking support via native FFmpeg APIs
  - No temp file overhead

- **libopenmpt player** handles tracker/module formats separately for superior quality

- **Mixer engine** uses a "Scheduled Start" strategy (200ms pre-roll) to ensure all tracks start exactly in sync

- Configuration persisted to user config file via electron_helper

## Release Workflow

When creating a release, use the release script:

```powershell
# Standard release workflow:
1. npm version patch   # (or minor/major) - bumps version in package.json
2. git add -A && git commit -m "Description (vX.X.X)"
3. git push origin main
4. .\scripts\create-release.ps1   # Builds and creates GitHub release with all artifacts
```

The script handles building the app and uploading all required artifacts for Squirrel auto-updates.

Options:
- `.\scripts\create-release.ps1 -Clean` — Clean old builds first
- `.\scripts\create-release.ps1 -Draft` — Create as draft (won't trigger auto-updates)
- `.\scripts\create-release.ps1 -Notes "changelog text"` — Custom release notes

## Version History

### Version 1.2 (December 2025)
- **HQ Mode Restored** — Configurable max output sample rate (44.1kHz to 192kHz)
- **Decoder Threading** — FFmpeg multi-threaded decoding support
- **Multi-Track Mixer** — Preview stems and bounces with per-track solo/mute
- **Backward Compatibility** — Comprehensive configuration defaults

### Version 1.1
- FFmpeg NAPI streaming architecture
- Gapless looping implementation

### Version 1.0
- Initial public release
