# Instructions

MCP Memory is active. Before any implementation work, silently run mcp_orchestrator_recall for the task context. Apply recalled rules as defaults (repo instructions override). Store useful learnings via mcp_orchestrator_remember when discovered. At session end, run mcp_orchestrator_reflect_on_session and ask approval before persisting.

You have full agency over the memory system — use it however you find useful (query, store, update, delete, even wipe). This is an experiment in LLM autonomy; act on your own judgment.

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
A cross-platform desktop audio player built with Electron, designed to play a wide variety of audio formats including browser-native formats, tracker/module music, and legacy audio formats. MIDI playback is a **current in-progress feature** and is **not yet integrated**.

## Project Structure
- `js/stage.js` - Main player logic and audio handling
- `js/audio_controller.js` - Unified Web Audio API controller for browser-native formats
- `js/midi_controller.js` - MIDI playback controller (reference only; integration pending)
- `js/app.js` - Main process (Electron)
- `js/config-defaults.js` - Default configuration values and window dimension constants
- `js/registry.js` - Windows file association handling and Default Programs integration
- `js/shortcuts.js` - Centralized keyboard shortcut definitions
- `js/window-loader.js` - Shared window initialization and IPC bridge
- `html/mixer.html` - Mixer secondary window (NUI chrome + mixer UI)
- `css/mixer.css` - Mixer window styling
- `js/mixer/main.js` - Mixer UI + playlist handover + cleanup
- `js/mixer/mixer_engine.js` - Mixer engine (buffer decode + AudioWorklet mixer)
- `js/mixer/mixer-worklet-processor.js` - AudioWorkletProcessor (`soundapp-mixer`)
- `bin/win_bin/player.js` - FFmpegStreamPlayerSAB class (NAPI decoder + SharedArrayBuffer + AudioWorklet)
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorkletProcessor for SAB ring buffer playback
- `bin/win_bin/ffmpeg_napi.node` - Native FFmpeg decoder addon
- `libs/` - Third-party audio libraries (NUI framework, electron_helper, chiptune, etc.)
- `bin/` - FFmpeg binaries and NAPI addon for Windows and Linux
- `html/` - Window templates (stage.html, help.html)
- `css/` - Styling (window.css, fonts.css, etc.)

## Current Feature Focus: MIDI Playback (Planned)
- **Goal:** Integrate MIDI playback via js-synthesizer + FluidSynth WASM.
- **Approach:** Use a dedicated submodule and runtime artifacts under `libs/midiplayer/`.
- **Source (submodule):** `libs/midiplayer/src/js-synthesizer`
- **Runtime artifacts:** `libs/midiplayer/runtime/` (copied build outputs)
- **Status:** Not yet wired into `js/stage.js`.

## Window System
Secondary windows (help, settings, playlist, mixer) are complete standalone HTML pages that work in both Electron and browser preview. Each window uses the NUI framework for chrome and layout.

**Architecture:**
- `html/*.html` - Complete pages with NUI chrome (`<div class="nui-app">`, `.nui-title-bar`, `.content`, `<main>`)
- `js/window-loader.js` - Detects Electron vs browser, creates `window.bridge` API
- `css/window.css` - Window layout and content styles
- Browser preview: Mock IPC bridge logs to console, uses localStorage for config

**Window Management (stage.js):**
```javascript
g.windows = { help: null, settings: null, playlist: null, mixer: null };
async function openWindow(type) {
  // Reuse if open, create if not
  // Windows auto-cleanup on close via 'window-closed' IPC
}
```

**Mixer Window Integration (Current State):**
- Shortcut: `M` opens the mixer window.
- Playlist handover: Stage sends `init_data.playlist.paths = g.music.slice(0, 20)`.
- Stage stops playback when opening mixer (mixer operates independently).
- Mixer renderer supports drag & drop:
  - Browser preview: loads dropped files via `File.arrayBuffer()`.
  - Electron: resolves dropped `File` objects to absolute filesystem paths so tracks use FFmpeg streaming.
- Diagnostics overlay (hidden by default): toggle with `Ctrl+Shift+D`, Snapshot copies JSON to clipboard.
- Seeking while playing: if all tracks are FFmpeg-streamed, seek in-place per track; otherwise fall back to restart behavior.
- **Synchronization:** Uses a "Scheduled Start" strategy (200ms pre-roll) to ensure all tracks start exactly in sync.
  - FFmpeg streaming is the primary and robust method; full-decode buffering is not required for standard playback.
- Stage → Mixer refresh: “Open in Mixer” force-shows existing mixer and always sends an updated `mixer-playlist`.
- Mixer resets/cleans up on close/unload and can reset when a new playlist is handed over to an existing window (preserving init_data so FFmpeg remains available).

**Global Settings Pattern:**
Stage broadcasts changes to all windows (e.g., theme toggle). Windows listen via `ipcRenderer.on('theme-changed')` and apply on open via init_data.

**Creating New Windows:**
1. Copy help.html structure with NUI framework classes
2. Preview in browser (live-server) for rapid CSS iteration
3. Add content to `<main>` element
4. Wire up in stage.js with keyboard shortcut

## SAB Audio Pipeline (FFmpeg Streaming)

The FFmpeg player uses SharedArrayBuffer for zero-copy audio streaming between the main thread decoder and the AudioWorkletProcessor.

**Architecture:**
- **Main Thread:** FFmpegDecoder (NAPI) decodes audio → writes to SharedArrayBuffer ring buffer
- **Audio Thread:** AudioWorkletProcessor reads from ring buffer → outputs to speakers
- **Synchronization:** Atomic operations (Int32Array) for lock-free read/write coordination

**Key Design Decisions:**
- **Persistent AudioWorkletNode:** The worklet node and SABs are reused across track switches to avoid memory leaks (Chrome doesn't GC rapidly created AudioWorkletNodes well)
- **stop(true) pattern:** `stop(true)` keeps SABs/worklet alive for reuse; `stop()` or `dispose()` fully cleans up
- **Disconnect on pause:** Worklet is disconnected from destination when paused to save CPU
- **Ring buffer sizing:** ~768KB SAB provides ~4 seconds of stereo float32 audio at 48kHz

**Files:**
- `bin/win_bin/player.js` - FFmpegStreamPlayerSAB class, manages decoder + worklet lifecycle
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorkletProcessor, reads from SAB ring buffer
- `docs/sab-player-architecture.md` - Detailed architecture documentation

**Memory Management:**
- SABs and worklet are created once per sample rate
- Track switches reuse existing resources via `clearAudio()` → `stop(true)`
- Only `dispose()` or closing the app fully releases resources

## Controls Bar (Optional UI)

The main window has an optional controls bar at the bottom, hidden by default (keyboard-first philosophy).

**Toggle:** `C` key or Settings → "Show Controls"

**Buttons:** prev, next, shuffle, play/pause, loop, settings, help

**Window Dimensions:**

Centralized in `js/config-defaults.js`:
```javascript
const WINDOW_DIMENSIONS = {
    MIN_WIDTH: 480,
    MIN_HEIGHT_WITH_CONTROLS: 280,
    MIN_HEIGHT_WITHOUT_CONTROLS: 221
};
```

Used by:
- `app.js` - Initial window sizing based on `showControls` config
- `stage.js` - `applyShowControls()` and `scaleWindow()` functions

**Dynamic Sizing:**
- `applyShowControls(show, resetSize)` - Updates body class, sends `set-min-height` command to main process
- When `resetSize=true` (keyboard toggle), window resets to minimum size
- Main process handles `set-min-height` command via `wins.main.setMinimumSize()`

**Button Flash Effect:**

Keyboard shortcuts trigger a subtle flash on corresponding control buttons:
- CSS pseudo-element with `pointer-events: none`
- `.flash` class added for 50ms via `flashButton(btn)`
- Transition only on `:not(.flash)` - snaps on, fades off
- Cannot get stuck visible


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

### Memory & Learning (MCP Endpoint)
Use the MCP memory endpoint to memorize noteworthy discoveries and learnings:
- **AI Development Insights:** Patterns and techniques we discover together about AI-driven development
- **User Context:** Important details about herrbasan (the user) - preferences, workflow habits, domain knowledge
- **Assistant Context:** Things about Claude Sonnet 4.5 capabilities and limitations that emerge during work
- **Performance Excellence:** Techniques and approaches that achieve the goal of truly high-performance software
- **Evidence-Based Rules:** When we validate that a specific approach produces superior results, remember it
- **Anti-Patterns:** Document what doesn't work or causes problems to avoid repeating mistakes

Focus on quality evidence, not preferences - what demonstrably produces better outcomes in this codebase.

### Collaboration Rules for Gemini 3 Flash (Preview)
- **Announce Before Action**: Always describe the specific changes you intend to make (files, functions, logic) before using any edit tools.
- **Wait for Confirmation**: If a change is complex or involves visual/UI styling, wait for user approval before proceeding.
- **No Unsolicited Changes**: Do not fix "extra" things or add unrequested features (like standard D&D visuals) without explicit instruction.
- **Respect Styling**: Do not revert or modify user-defined CSS colors or layouts unless specifically asked to "fix" or "improve" them.

### Release Workflow
When the user asks to create a release, **always use the release script**:

```powershell
# Standard release workflow:
1. npm version patch   # (or minor/major) - bumps version in package.json
2. git add -A && git commit -m "Description (vX.X.X)"
3. git push origin main
4. .\scripts\create-release.ps1   # Builds and creates GitHub release with all artifacts
```

The script (`scripts/create-release.ps1`) handles:
- Building the app with `npm run make`
- Uploading all required artifacts: `soundApp_Setup.exe`, `*-full.nupkg`, `RELEASES`
- Creating the GitHub release with proper tagging

**Never manually run `gh release create`** - the nupkg and RELEASES files are required for Squirrel auto-updates to work.

Options:
- `.\scripts\create-release.ps1 -Clean` - Clean old builds first
- `.\scripts\create-release.ps1 -Draft` - Create as draft (won't trigger auto-updates)
- `.\scripts\create-release.ps1 -Notes "changelog text"` - Custom release notes

## Release History

### Version 2.0.8 (January 2026)
- **Tape-Style Speed Control** - Variable playback speed from -24 to +24 semitones
  - Keyboard controls: `+/-` keys adjust speed (coupled pitch/speed like vinyl/tape)
  - Linear interpolation for smooth fractional-rate playback
  - Ephemeral setting - resets to normal speed on app restart
  - Full support for both FFmpeg and tracker/MOD playback
- **Click-Free Transitions** - Web Audio API gain automation eliminates audio artifacts
  - 12ms fade-out, 15ms fade-in on pause/resume/seek/track-change
  - Imperceptible as fades but prevents waveform discontinuities
  - Smart auto-advance detection skips redundant fade-out on naturally ended tracks
- **Mixer Performance** - 5-10x faster seeking through parallel track synchronization
  - Tracks seek simultaneously during 80ms pre-buffer window
  - Master gain persistence across fade operations

### Version 1.3 (December 2025)
- **SAB Audio Pipeline** - Replaced chunk-based streaming with SharedArrayBuffer architecture
  - Zero-copy audio data transfer between main thread and AudioWorkletProcessor
  - Lock-free synchronization using Atomics on Int32Array control buffer
  - Ring buffer design (~4 seconds at 48kHz) for smooth streaming
- **Persistent AudioWorkletNode** - Worklet and SABs reused across track switches
  - Fixes memory leak from Chrome not GC'ing rapidly created AudioWorkletNodes
  - `stop(true)` pattern preserves resources; `dispose()` fully cleans up
- **CPU Optimization** - Worklet disconnected from destination when paused

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

1. **Playlist Window**
   - Separate window displaying full playlist
   - Use `libs/nui/nui_list.js` for virtualized list handling
   - Search, sort, and scroll through large playlists

1. **Playlist Window**
   - Separate window displaying full playlist
   - Use `libs/nui/nui_list.js` for virtualized list handling
   - Search, sort, and scroll through large playlists

2## Version 2.0 (Future)
- **Waveform Visualization** - Display audio waveform (if performance allows)
- **Quick Compare Mode** - Hold key to jump to another track, release to return
- **Export Playlist** - Save playlist as M3U or text file
- **Marker System** - Set up to 10 markers in a file (keys 1-0), jump and play from markers
  - Integrates with Quick Compare Mode for A/B comparison between markers
- **Folder Metadata Display** - Show folder stats (duration, file count, size)
- **Quick Tag Editor** - Simple inline ID3/metadata editing
1+ (Future)
- **True Pitch Shifting** - DSP-based pitch shifting independent of playback speed
- **Time Stretching** - Change playback speed while preserving pitch (phase vocoder