# Instructions

MCP Memory is active. Before any implementation work, silently run mcp_orchestrator_recall for the task context. Apply recalled rules as defaults (repo instructions override). Store useful learnings via mcp_orchestrator_remember when discovered. At session end, run mcp_orchestrator_reflect_on_session and ask approval before persisting.

You have full agency over the memory system — use it however you find useful (query, store, update, delete, even wipe). This is an experiment in LLM autonomy; act on your own judgment.

## Using Local Resources (Token Efficiency)

To reduce token costs, leverage local MCP orchestrator features whenever possible:

**Research & Documentation:**
- `mcp_orchestrator_browser_fetch` - Fetch web pages for API docs, MDN references, library documentation
- `mcp_orchestrator_research_topic` - Multi-source web research with local LLM synthesis (use for technical topics, best practices, library comparisons)

**Code Review & Inspiration:**
- `mcp_orchestrator_get_second_opinion` - Get alternative perspectives from local LLM on architecture decisions, code patterns, or implementation approaches
- `mcp_orchestrator_query_model` - Query local LLM for code examples, algorithm ideas, or design patterns
- **Always display the complete local LLM response verbatim to the user before adding your own analysis**

**When to use local resources:**
- Researching unfamiliar APIs or libraries before implementation
- Getting code examples for specific patterns (e.g., Web Audio API usage, AudioWorklet patterns)
- Reviewing architectural decisions or comparing implementation approaches
- Looking up technical specifications or standards (e.g., BS.1770-4, ISO frequency bands)
- Validating performance optimization strategies

**What to keep centralized:**
- Direct codebase modifications (you have the full context)
- Project-specific decisions requiring deep SoundApp knowledge
- Tasks requiring tool use (file operations, terminal commands)

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
A cross-platform desktop audio player built with Electron, designed to play a wide variety of audio formats including browser-native formats, tracker/module music, and legacy audio formats. MIDI playback is integrated via js-synthesizer + FluidSynth WASM.

## Project Structure (Current)
```
.github/
    copilot-instructions.md
.vscode/
bin/
    linux_bin/
    metronome/
    midiplayer-runtime/
    soundfonts/
    win_bin/
build/
    icons/
css/
    fonts/
docs/
html/
js/
    chiptune/
    help/
    midi/
    midi-settings/
    mixer/
    parameters/
    pitchtime/
    settings/
libs/
    chiptune/
    electron_helper/
    ffmpeg-napi-interface/
    midiplayer/
    native-registry/
    nui/
    rubberband/
    rubberband-wasm/
scripts/
```

**Key Files:**
- `js/stage.js` - Main player logic and audio handling (including MIDI init + window routing)
- `js/audio_controller.js` - Web Audio controller for browser-native formats
- `js/app.js` - Main process (Electron)
- `js/config-defaults.js` - Default configuration values and window dimension constants
- `js/registry.js` - Windows file association handling and Default Programs integration
- `js/shortcuts.js` - Centralized keyboard shortcut definitions
- `js/window-loader.js` - Shared window initialization and IPC bridge
- `js/rubberband-pipeline.js` - Rubber Band audio stretching pipeline
- `js/midi/midi.js` - MIDI player (js-synthesizer integration + metronome config)
- `js/midi/midi.worklet.js` - MIDI hook worklet (transpose, etc.)
- `js/midi/metronome.worklet.js` - Worklet-synced metronome (sample decode + mix)
- `js/midi-settings/main.js` - MIDI Settings window logic (pitch/tempo/metronome/soundfont)
- `js/parameters/main.js` - Parameters window logic (unified control interface)
- `js/pitchtime/main.js` - Pitch/Time window logic
- `js/pitchtime/pitchtime_engine.js` - Pitch/time manipulation engine
- `html/*.html` - Window templates (stage, help, settings, mixer, midi, parameters, pitchtime)
- `css/*.css` - Styling (main, window, mixer, midi, parameters, pitchtime, etc.)
- `js/mixer/main.js` - Mixer UI + playlist handover + cleanup
- `js/mixer/mixer_engine.js` - Mixer engine (buffer decode + AudioWorklet mixer)
- `js/mixer/mixer-worklet-processor.js` - AudioWorkletProcessor (`soundapp-mixer`)
- `bin/win_bin/player-sab.js` - FFmpegStreamPlayerSAB class (NAPI decoder + SharedArrayBuffer + AudioWorklet)
- `bin/win_bin/ffmpeg-worklet-sab.js` - AudioWorkletProcessor for SAB ring buffer playback
- `bin/win_bin/ffmpeg_napi.node` - Native FFmpeg decoder addon
- `bin/metronome/` - Metronome click samples (user-replaceable WAVs)
- `libs/midiplayer/` - js-synthesizer bundles (main + worklet)
- `bin/midiplayer-runtime/` - runtime copy of js-synthesizer bundles
- `scripts/patch-midiplayer-worklet.js` - post-update patch for js-synthesizer worklet hook
- `scripts/sync-ffmpeg-napi.ps1` - sync ffmpeg-napi-interface to bin/
- `scripts/create-release.ps1` - release workflow script
- `libs/` - Third-party audio libraries (NUI, electron_helper, chiptune, etc.)
- `docs/` - Architecture documentation

## MIDI Player Integration
- **Package:** js-synthesizer v1.11.0 from npm (easy updates)
- **Player:** `js/midi/midi.js` wraps js-synthesizer and is initialized by `js/stage.js`
- **Worklets:** `js/midi/midi.worklet.js` (MIDI hook) and `js/midi/metronome.worklet.js` (metronome) are loaded via `audioWorklet.addModule()`
- **Bundles:** Copied from `node_modules/js-synthesizer/dist/` to `libs/midiplayer/` and `bin/midiplayer-runtime/` by `scripts/patch-midiplayer-worklet.js`
- **Patches applied:**
  - UMD wrapper fix for ES module context (`root = root || globalThis`)
  - Metronome hook injection (`AudioWorkletGlobalScope.SoundAppMetronome`)
- **Soundfonts:** `bin/soundfonts/` and MIDI Settings window drive the active SoundFont
- **Updates:** `npm update js-synthesizer && npm run patch-midiplayer-worklet`

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

**Mixer Window Integration:**
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

**Window Lifecycle (Hide vs Close):**
**Important:** Windows are hidden rather than closed when the user "closes" them. This means:
- Use `'hide'` event instead of `'close'` event for cleanup logic
- Window state persists between hide/show cycles
- Clean up temporary state when window is hidden, not when window object is destroyed
- The window object remains in `g.windows` until explicitly set to `null`

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

## MIDI Metronome (Worklet-Synced Samples)

The MIDI metronome is implemented as a separate AudioWorklet module that mixes click samples directly into the js-synthesizer output, synced to the player tick stream and tempo map (including tempo changes).

**Files:**
- [js/midi/metronome.worklet.js](js/midi/metronome.worklet.js) - standalone metronome worklet logic (sample decode, tick scheduling, mixing)
- [js/midi/midi.js](js/midi/midi.js) - loads the metronome worklet module and sends config/buffers via `callFunction('SoundAppMetronomeConfig', ...)`
- [libs/midiplayer/js-synthesizer.worklet.js](libs/midiplayer/js-synthesizer.worklet.js) - minimal hook (uses `AudioWorkletGlobalScope.SoundAppMetronome` if present)
- [bin/midiplayer-runtime/js-synthesizer.worklet.js](bin/midiplayer-runtime/js-synthesizer.worklet.js) - same minimal hook for runtime copy

**How it works:**
- `midi.js` loads `metronome.worklet.js` before the js-synthesizer worklet.
- The worklet exposes `SoundAppMetronomeConfig` which receives:
  - `enabled`, `ppq`, `timeSignatures`, `highGain`, `lowGain`
  - `highBuffer`, `lowBuffer` (ArrayBuffer WAV data)
  - `reset`, `resetTick` (for seek alignment)
- The metronome uses the player’s MIDI tempo (`fluid_player_get_midi_tempo`) to compute ticks-per-second and schedules beat ticks inside each render block.
- Click samples are mixed as persistent “voices” so they play across blocks without being truncated.

**Samples:**
- Default files: `bin/metronome/metronome-high.wav` and `bin/metronome/metronome-low.wav`
- Users can replace these files to customize the click sound.

## js-synthesizer Updates & Patch Workflow

The js-synthesizer worklet bundles are generated artifacts. To keep the metronome hook without modifying the submodule:

- **Patch script:** [scripts/patch-midiplayer-worklet.js](scripts/patch-midiplayer-worklet.js)
  - Injects the minimal metronome hook into:
    - [libs/midiplayer/js-synthesizer.worklet.js](libs/midiplayer/js-synthesizer.worklet.js)
    - [bin/midiplayer-runtime/js-synthesizer.worklet.js](bin/midiplayer-runtime/js-synthesizer.worklet.js)
- **Auto-run:** `postinstall` runs the patch script.
- **Manual run:** `npm run patch-midiplayer-worklet` after any update/regeneration of js-synthesizer bundles.

**Rule:** Do not edit the js-synthesizer submodule directly; keep it update-compatible and patch the generated bundles via the script.

## FFmpeg NAPI Module Build

The FFmpeg decoder is a native Node.js addon (C++) that must be built before use. **Important:** Do not use `node-gyp rebuild` directly.

**Build Requirements:**
- **Visual Studio Build Tools:** C++ build toolchain required
- **node-gyp:** Local version (10.3.1) used automatically by npm script

**Build Command:**
```powershell
cd libs/ffmpeg-napi-interface
npm run build
```

**Sync to Runtime:**
After building, sync the native addon and FFmpeg DLLs to the runtime directory:
```powershell
.\scripts\sync-ffmpeg-napi.ps1 -IncludeNative
```

**Why Not `node-gyp rebuild`:**
- Global node-gyp (11.1.0+) has a Windows Unicode issue in `win_delay_load_hook.cc`
- Error: `error C2664: 'HMODULE GetModuleHandleW(LPCWSTR)': cannot convert argument`
- The module's npm build script uses local node-gyp 10.3.1 which doesn't have this issue
- The build script also applies necessary vcxproj patches automatically

**Output Files:**
- `libs/ffmpeg-napi-interface/build/Release/ffmpeg_napi.node` - Native addon
- Synced to `bin/win_bin/ffmpeg_napi.node` by sync script
- FFmpeg DLLs (avcodec-62.dll, avformat-62.dll, avutil-60.dll, swresample-6.dll) also synced

**When to Rebuild:**
- After modifying C++ source files in `libs/ffmpeg-napi-interface/src/`
- After pulling updates that include native module changes
- If native module fails to load with binding errors

## libopenmpt WASM Build

The tracker/module player uses libopenmpt compiled to WASM. The build is performed on Windows using native Emscripten.

**Build Requirements:**
- **Emscripten:** Installed at `C:\emsdk` (activate via `C:\emsdk\emsdk_env.ps1`)
- **GNU Make:** Install via `choco install make` (required for libopenmpt Makefile)
- **libopenmpt version:** 0.7.13+release

**Build Command:**
```powershell
cd libs/chiptune
.\build.ps1
```

**Output:**
- `libs/chiptune/libopenmpt.worklet.js` (~1.49 MB)
- Includes ext API functions: `_openmpt_module_ext_create`, `_openmpt_module_ext_get_interface` for advanced features like channel mute/solo

**Emscripten 4.x Compatibility:**
Starting with Emscripten 4.0.7, memory views (HEAP8, HEAPU32) must be in `EXPORTED_RUNTIME_METHODS` instead of `EXPORTED_FUNCTIONS`. The build script automatically patches `config-emscripten.mk`:
```makefile
-s EXPORTED_RUNTIME_METHODS="['stackAlloc','stackSave','stackRestore','UTF8ToString','HEAP8','HEAPU8','HEAPU32','HEAPF32']"
```

**Post-Build Patches:**
The build script automatically applies patches to the generated JS file:
1. **Polyfills:** Adds TextDecoder, TextEncoder, atob, performance, crypto for AudioWorkletGlobalScope
2. **HEAP Exports:** Patches HEAPU8 and HEAPF32 to be exported on Module object (Emscripten doesn't do this by default even when in EXPORTED_RUNTIME_METHODS)

**Build Script Notes:**
- Checks for actual file content (config file), not just directory existence
- Handles Windows directory locks gracefully (extracts into existing directory if needed)
- Non-critical warnings about missing Unix tools (sed, grep, uname) are expected on Windows

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

## Monitoring Window (Real-Time Audio Analysis) (Current)

The Monitoring window provides professional-grade audio analysis and visualization tools for the currently playing track.

**Toggle:** `N` key opens/closes the monitoring window

**Features:**
- **Overview Waveform** - Static waveform with playhead tracking for navigation
- **Live Waveform** - Real-time oscilloscope view of the audio signal
- **Spectrum Analyzer** - 31-band ISO 266 frequency analysis (RTA) with fast-attack/slow-release ballistics
- **Goniometer** - Stereo phase visualization (Mid-Side XY display)
- **Correlation Meter** - Real-time stereo phase correlation (-1 to +1)
- **BS.1770-4 Loudness Metering** - Professional broadcast loudness measurement:
  - Short-term LUFS (3s sliding window)
  - Integrated LUFS (gated, full-track measurement)
  - LRA (Loudness Range)
  - PLR (Peak-to-Loudness Ratio)
  - Sample Peak detection
  - Configurable target presets: Streaming (-14), EBU R128 (-23), CD/Club (-9), Podcast (-18)

**Architecture:**
- **Tap Points:** `initMonitoring()` creates non-invasive stereo AnalyserNode taps on both standard and Rubberband audio pipelines
- **Dual Context:** Monitoring automatically switches between main AudioContext and rubberbandContext based on active pipeline
- **60 FPS Updates:** `updateMonitoring()` runs at 60Hz, sending frequency/time-domain data to the window via IPC
- **Worker-Based Waveform:** Overview waveform extraction runs in a Node.js Worker Thread to avoid blocking
- **K-Weighting Filters:** Two-stage K-weighting filters (ITU-R BS.1770) for accurate loudness measurement
- **Gating Algorithm:** Absolute and relative gating per BS.1770-4 spec for integrated LUFS

**Files:**
- [html/monitoring.html](html/monitoring.html) - NUI-based window structure with canvas containers
- [css/monitoring.css](css/monitoring.css) - Professional meter styling and layout
- [js/monitoring/main.js](js/monitoring/main.js) - Window initialization, IPC handlers, UI coordination
- [js/monitoring/visualizers.js](js/monitoring/visualizers.js) - Canvas rendering, BS.1770-4 LUFS engine, spectrum analysis
- [js/monitoring/waveform_worker.js](js/monitoring/waveform_worker.js) - Worker thread for async waveform peak extraction
- [js/stage.js](js/stage.js) - `initMonitoring()`, `updateMonitoring()`, `extractAndSendWaveform()` functions

**IPC Protocol:**
- `monitoring-ready` - Window signals ready state, triggers initial waveform extraction
- `clear-waveform` - Stage clears waveform before track change
- `waveform-data` - Stage sends peak data: `{ peaksL, peaksR, points, duration, filePath }`
- `ana-data` - Stage sends real-time analysis (60Hz): `{ freqL, freqR, timeL, timeR, pos, duration, sampleRate }`

**Sample Rate Handling:**
- Monitoring adapts to AudioContext sample rate (44.1kHz to 192kHz)
- Larger FFT sizes used at high sample rates (8192 vs 2048) to maintain frequency resolution
- K-weighting filters recalculate coefficients when sample rate changes
- Waveform extraction always resamples to 44.1kHz for consistent peak analysis

**Performance Notes:**
- AnalyserNode taps are lightweight (~0.5% CPU overhead)
- Waveform extraction is async (Worker Thread) - no UI blocking
- Canvas rendering is throttled to 60 FPS
- Monitoring loop auto-stops when window is hidden

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

### Critical Working Rules (ALL AI ASSISTANTS)

**BEFORE making ANY code changes:**
1. **Read the existing implementation completely** - Don't assume, verify the current state
2. **Trace dependencies** - Check what other code calls this function, what it calls
3. **Check git history** - Use `git show <commit>:file` to understand why code is structured this way
4. **Query MCP memories** - Run `mcp_orchestrator_recall` for domain-specific learnings
5. **Announce your plan** - Describe files, functions, and logic changes BEFORE executing

**FORBIDDEN actions (causes breakage):**
- ❌ Removing code without understanding why it exists
- ❌ "Simplifying" complex logic without tracing all call sites
- ❌ Changing function signatures without checking all usages
- ❌ Modifying audio pipeline routing without understanding dual-context architecture
- ❌ Adding features that touch multiple systems without comprehensive testing plan
- ❌ Force-terminating worker threads that run native code (NAPI fatal errors)

**SoundApp-specific critical systems (extra care required):**
- **Dual audio pipelines** - `g.audioContext` (normal) and `g.rubberbandContext` (pitch/time) - only one connects to destination at a time
- **Native addons** - FFmpeg NAPI, never call `worker.terminate()` during active processing
- **AudioWorklet lifecycle** - Persistent nodes, careful disposal, monitor connections
- **Parameters/Mode state** - `g.audioParams.mode` ('tape' vs 'pitchtime') drives pipeline selection
- **Window state vs feature state** - Window open ≠ feature active (check mode/locked flags)

**When uncertain:**
- ASK before making changes to core audio systems (stage.js pipelines, rubberband, FFmpeg)
- VERIFY assumptions by reading code, not guessing
- TEST changes mentally: "What breaks if this function isn't called?" "What else depends on this?"

### Release Workflow
When the user asks to create a release, **always use the release script**:

```powershell
# Standard release workflow:
1. npm version patch   # (or minor/major) - bumps version in package.json
2. git add -A && git commit -m "Description (vX.X.X)"
3. git push origin main
4. .\scripts\create-release.ps1 -Notes "description of changes since last release"
```

The script (`scripts/create-release.ps1`) handles:
- Building the app with `npm run make`
- Uploading all required artifacts: `soundApp_Setup.exe`, `*-full.nupkg`, `RELEASES`
- Creating the GitHub release with proper tagging

**Never manually run `gh release create`** - the nupkg and RELEASES files are required for Squirrel auto-updates to work.

**Required Parameter:**
- `-Notes "text"` - **REQUIRED** - Description of what has changed since the last release (changelog)

**Optional Parameters:**
- `-Clean` - Clean old builds first
- `-Draft` - Create as draft (won't trigger auto-updates)

## Release History

### Version 2.1.1 (January 2026)
- **Unified Parameters Window** - Context-aware control panel that adapts to file type
  - Audio files: Tape Speed (default) or Pitch/Time (Rubber Band) controls with optional Lock Settings
  - MIDI files: Global transpose, tempo, metronome, and SoundFont selection
  - Tracker files: Pitch shift, tempo, channel mixer with solo/mute, and stereo separation
  - Replaced help button in controls bar with parameters button
- **Updated Documentation** - Comprehensive documentation for Parameters window in README and Help
- **Cleaned Settings Window** - Removed duplicate tracker settings (now exclusively in Parameters window)

### Version 2.1.0 (January 2026)
- **High-Quality Pitch Shifting & Time Stretching** - Rubber Band Library integration
  - Independent pitch and tempo control for professional audio manipulation
  - Real-time DSP processing with configurable quality presets
  - Dedicated controls windows for precise parameter adjustment
- **Full MIDI Support** - FluidSynth-based MIDI playback
  - Native SoundFont synthesis via js-synthesizer (FluidSynth WASM)
  - Worklet-synced metronome with customizable click samples
  - MIDI Settings window for pitch/tempo/soundfont configuration
- **Dedicated Controls Windows** - Specialized UI for advanced features
  - Pitch/Time window for real-time audio manipulation
  - MIDI Settings window for comprehensive MIDI control
  - Parameters window for future extensibility

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

## Current Bugs

(none)


## Immediate Features

- **MIDI Channel Activity Visualization (Monitoring Window)** - Replace blank waveform canvas with MIDI activity visualization when playing MIDI files
   - All 16 MIDI channels displayed as horizontal lanes stacked vertically
   - Events rendered as horizontal bars within each channel lane
   - Continuous activity (notes/events without gaps) combined into single bar
   - Bar breaks when no events occur for a threshold duration (~2 seconds)
   - Minimum bar length (~1 second) ensures short events remain visible
   - Next activity after gap starts a new bar
   - Time-aligned with playhead position for visual feedback during playback

## Backlog / Future Features

- **Waveform Caching** - Cache extracted waveforms to avoid re-extraction on repeated monitoring
   - In-memory cache keyed by file path + mtime (cleared on app restart)
   - Optional persistent cache in %APPDATA%/SoundApp/waveforms/ with filename hashes
   - Smart invalidation based on file modification time and size
   - Performance: instant cache hit vs 250ms-4s extraction time for 4min-1hr tracks
- **Playlist Window**
   - Separate window displaying full playlist
   - Use `libs/nui/nui_list.js` for virtualized list handling
   - Search, sort, and scroll through large playlists
- **Tracker Type Controls for the Parameters Window** - Tracker-style parameter controls in Parameters window
- **Automatic or User Driven Soundfont Downloads** - Download SoundFonts from Archive.org sources
- **Waveform Visualization** - Display audio waveform (if performance allows)
- **BPM Detection** - Detect tempo, maybe in conjunction with the waveform display
- **Quick Compare Mode** - Hold key to jump to another track, release to return
- **Export Playlist** - Save playlist as M3U or text file
- **Marker System** - Set up to 10 markers in a file (keys 1-0), jump and play from markers
  - Integrates with Quick Compare Mode for A/B comparison between markers
- **Folder Metadata Display** - Show folder stats (duration, file count, size)
- **Quick Tag Editor** - Simple inline ID3/metadata editing