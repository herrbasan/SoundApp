# SoundApp — Agent Instructions

> **⚠️ BRANCH CONTEXT:** This is an experimental development branch featuring the Engine-based audio architecture with idle disposal, MessagePort direct communication, and lazy initialization. This branch is ahead of main.

> **📖 MINDSET:** Read and internalize [`DETERMINISTIC_MIND.md`](DETERMINISTIC_MIND.md) — core principles for code quality and reasoning.

> **📋 CURRENT WORK:** See [`docs/Current_Tasks.md`](docs/Current_Tasks.md) — state centralization status, known issues, and remaining tasks.

---

## 🪵 Logging-Based Debugging (Primary Method)

**When debugging anything, use the logger. Do not add console.log statements.**

Log files are created in `logs/soundapp-YYYY-MM-DDTHH-MM-SS.log` for every app start in dev mode. Read the latest log to trace exactly what happened.

### Quick Start

```javascript
// Main process (js/app.js) - already initialized
logger.info('main', 'Something happened', { file: path.basename(fp) });
logger.debug('state', 'State changed', { isPlaying, position });
logger.warn('engine', 'Unusual condition', { param: value });
logger.error('audio', 'Failed to load', error);

// Renderer processes (windows) - via window-loader.js
// Already initialized with window type as scope
logger.info('Window loaded', { windowId });
logger.debug('Data received', data);
```

### Log Levels

| Level | Use For |
|-------|---------|
| `DEBUG` | Detailed tracing, state dumps, frequent updates |
| `INFO` | Significant events, lifecycle, user actions |
| `WARN` | Unexpected but handled conditions |
| `ERROR` | Failures that affect functionality |

### Log Format

```
[2026-02-15T21:45:30.123Z] [INFO ] [main        ] audio:play received | {"engineAlive":true}
[2026-02-15T21:45:30.456Z] [DEBUG] [engine      ] cmd:load received | {"file":"song.mp3"}
[2026-02-15T21:45:31.789Z] [WARN ] [player      ] File not found | {"path":"/missing.wav"}
```

### Terminal stays clean

All `console.log` calls are automatically captured to the log file. The terminal only shows errors. Read `logs/` for the full trace.

---

## Quick Reference

| Key File | Purpose |
|----------|---------|
| `js/app.js` | Main process — ground truth state, idle disposal, IPC routing |
| `js/engines.js` | Hidden engine window — all audio playback, monitoring |
| `js/stage.js` | Player UI — file drops, playlist, keyboard input |
| `js/rubberband-pipeline.js` | Rubberband WASM wrapper for pitch/time |
| `js/window-loader.js` | Shared bootstrap for all child windows |
| `js/config-defaults.js` | Default configuration values |

---

## Architecture Overview

### Three-Process Design

```
┌─────────────────┐     IPC      ┌─────────────────┐     IPC      ┌─────────────────┐
│    Main         │◄────────────►│     Engine      │◄────────────►│  Child Windows  │
│   (app.js)      │              │  (engines.js)   │   MessagePort │ (parameters,    │
│                 │              │                 │   (VU data)   │  monitoring,    │
│ • Ground truth  │              │ • Audio playback│               │  mixer, etc)    │
│   state         │              │ • All 3 engines │               │                 │
│ • Idle disposal │              │ • Monitoring    │               │ • Dumb renderers│
│ • IPC routing   │              │   analysis      │               │ • Receive data  │
└─────────────────┘              └─────────────────┘               └─────────────────┘
        │
        ▼
┌─────────────────┐
│   Player UI     │
│  (stage.js)     │
│                 │
│ • User interface│
│ • File handling │
│ • Playlist      │
└─────────────────┘
```

### Process Roles

| Process | Responsibility |
|---------|---------------|
| **Main** | Window lifecycle, ground truth `audioState`, idle disposal, IPC routing, child window tracking |
| **Engine** | All audio playback (FFmpeg, MIDI, Tracker), monitoring taps, VU data generation |
| **Player UI** | User interface, file drops, playlist display, keyboard shortcuts |
| **Child Windows** | Parameters, Monitoring, Mixer, Settings, Help — receive data via MessagePort or IPC |

---

## State Architecture

### Ground Truth (Main Process Only)

`audioState` in `app.js` is the **single source of truth** that survives engine disposal:

```javascript
const audioState = {
    // Playback
    file: null,             // Current file path
    isPlaying: false,
    position: 0,            // Seconds
    duration: 0,
    
    // Audio params (FFmpeg files)
    mode: 'tape',           // 'tape' | 'pitchtime'
    tapeSpeed: 0,           // -12 to +12 semitones
    pitch: 0,               // -12 to +12 semitones
    tempo: 1.0,             // 0.5 to 2.0 ratio
    formant: false,         // Formant preservation
    locked: false,          // Lock settings across tracks
    
    // MIDI params
    midiParams: {
        transpose: 0,
        bpm: null,          // null = use file BPM
        metronome: false,
        soundfont: null
    },
    
    // Tracker params
    trackerParams: {
        pitch: 1.0,
        tempo: 1.0,
        stereoSeparation: 100
    },
    
    // Engine lifecycle
    activePipeline: 'normal',   // 'normal' | 'rubberband'
    engineAlive: false,
    engineInitializing: false,
    
    // Playlist
    playlist: [],
    playlistIndex: 0,
    
    // Metadata (for UI)
    metadata: null,
    fileType: null          // 'MIDI' | 'Tracker' | 'FFmpeg'
};
```

### Engine Local State (Stateless Design)

Engine does NOT maintain ground truth state. It receives params from Main with each command:

```javascript
// engines.js - params received from Main via IPC commands
g.currentAudioParams = null;   // Set by cmd:setParams (mode, tapeSpeed, pitch, tempo, formant, locked)
g.currentMidiParams = null;    // Set by param-change events (transpose, bpm, metronome)
g.currentTrackerParams = null; // Set by param-change events (pitch, tempo, stereoSeparation)

// Runtime objects only (not state)
g.currentAudio = { fp, player, paused, isFFmpeg, isMidi, isMod, ... };
```

**Pattern:** Main sends state with commands → Engine stores temporarily → Engine applies to players. Engine never generates its own state.

### State Flow

1. **User changes param** → Parameters window → `param-change` IPC → Main updates `audioState` → Forwards to Engine (with param values) → Engine applies to player
2. **Engine restoration** → Main sends `cmd:setParams` (with full state) → `cmd:load` (load file) → Wait for `audio:loaded` → `cmd:applyParams` (apply received params to players)
3. **File change + locked=true** → Main preserves params → Sends to Engine with `cmd:setParams`
4. **File change + locked=false** → Main resets params to defaults → Sends to Engine with `cmd:setParams`

**Key Principle:** Engine never reads from `audioState` directly. Main always sends state via IPC commands.

---

## Idle Disposal (0% CPU Mode)

### State Machine

```
ACTIVE ──pause+5s/hidden──▶ PAUSED_HIDDEN ──▶ DISPOSING ──▶ DISPOSED
   │
   └──pause+10s/visible────▶ PAUSED_VISIBLE ──▶ DISPOSING ──▶ DISPOSED
```

| State | Timeout | Condition |
|-------|---------|-----------|
| `ACTIVE` | — | Playing or recently active |
| `PAUSED_VISIBLE` | 10s | Paused, window visible, no interaction |
| `PAUSED_HIDDEN` | 5s | Paused, window hidden to tray |
| `DISPOSING` | Immediate | Cleanup in progress |
| `DISPOSED` | — | Engine destroyed, 0% CPU |

### Restoration Triggers

- Play button
- Seek
- Next/Prev track
- Window show/restore
- Any window focus (resets timer)

### Key Implementation

```javascript
// app.js — Idle State Machine
const IdleState = {
    ACTIVE: 'active',
    PAUSED_VISIBLE: 'paused_visible',
    PAUSED_HIDDEN: 'paused_hidden',
    DISPOSING: 'disposing',
    DISPOSED: 'disposed'
};

// Restoration preserves exact position and params
async function restoreEngineIfNeeded() {
    // 1. Create engine window
    // 2. sendToEngine('cmd:setParams', audioState) — pre-set globals
    // 3. Re-register child windows + update stageId
    // 4. sendToEngine('cmd:load', { file, position })
    // 5. Wait for 'audio:loaded' signal
    // 6. sendToEngine('cmd:applyParams', ...) — apply to active players
    // 7. Update parameters window UI
}
```

---

## Audio Pipeline Architecture

### Three Engines

| Engine | Formats | Pipeline | Key Params |
|--------|---------|----------|------------|
| **FFmpeg** | MP3, FLAC, WAV, OGG, AAC, etc. | Dual: Normal / Rubberband | mode, tapeSpeed, pitch, tempo, formant, locked |
| **MIDI** | .mid, .midi, .kar, .rmi | Normal only | transpose, bpm, metronome, soundfont |
| **Tracker** | MOD, XM, IT, S3M, 70+ formats | Normal only | pitch, tempo, stereoSeparation |

### Dual Pipeline (Audio Files Only)

```
┌─────────────────────────────────────────────────────────────────┐
│                     NORMAL PIPELINE                              │
│              (48-192kHz, configurable, HQ mode)                 │
│                                                                  │
│   FFmpeg Decoder → FFmpeg Worklet → Gain → Destination          │
│                            │                                     │
│                      tapeSpeed via playbackRate                  │
└─────────────────────────────────────────────────────────────────┘
                                OR
┌─────────────────────────────────────────────────────────────────┐
│                   RUBBERBAND PIPELINE                            │
│              (48kHz fixed, ~70MB WASM heap)                     │
│                                                                  │
│   FFmpeg Decoder → Rubberband Worklet → Gain → Destination      │
│                            │                                     │
│              pitch, tempo, formant via WASM                     │
└─────────────────────────────────────────────────────────────────┘
```

### Pipeline Selection

```javascript
function calculateDesiredPipeline() {
    if (!g.currentAudio?.isFFmpeg) return 'normal';
    if (g.audioParams.locked && g.audioParams.mode === 'pitchtime') return 'rubberband';
    if (g.parametersOpen && g.audioParams.mode === 'pitchtime') return 'rubberband';
    return 'normal';
}
```

### Lazy Initialization

| Component | When Created | When Destroyed | Toggle |
|-----------|--------------|----------------|--------|
| FFmpeg Player | Engine init | Engine disposal | — |
| Rubberband | First pitchtime use | When no longer needed (saves ~70MB) | — |
| MIDI | First MIDI file playback | Never | `disableMidiPlayer: true` in config |
| Tracker | First tracker file (if lazyLoad enabled) | Engine disposal | `lazyLoadTracker: true` or `lazyLoadEngines: true` in env.json |

#### Tracker Lazy-Init

Controlled via `env.json`:
```json
{
  "lazyLoadEngines": true,   // Enables both MIDI and Tracker lazy-init
  "lazyLoadTracker": true    // Specifically for tracker (optional override)
}
```

- **Default**: Tracker initializes at engine startup (backward compatible)
- **With lazyLoad**: Tracker module loads at startup, but player instance initializes on first tracker file
- **HQ Mode toggle**: Respects lazy setting — won't eagerly init if lazy mode enabled

#### MIDI Lazy-Init

MIDI behaves differently — the module loads at engine startup (loads WASM/SoundFont), but the player instance initializes on first MIDI file playback. To completely disable MIDI (saves 0.3-0.5% constant CPU):

```json
// config.json (not env.json)
{
  "audio": {
    "disableMidiPlayer": true
  }
}
```

---

## Communication Patterns

### IPC Channels (Main ↔ Engine/Player)

**Player → Main:**
```javascript
audio:play, audio:pause, audio:seek, audio:load
audio:next, audio:prev, audio:setParams, audio:shuffle
window-created, window-visible, window-hidden, window-closed
param-change
```

**Engine → Main:**
```javascript
audio:position, audio:state, audio:loaded, audio:ended
audio:metadata, audio:sample-rate-info, engine:ready
```

**Main → Player:**
```javascript
state:update, position, theme-changed
```

### MessagePort (Direct Engine ↔ Child Windows)

For high-frequency data (VU meters at 60fps), use MessagePort to bypass main process:

```javascript
// In engines.js
if (g.messagePorts.parameters) {
    g.messagePorts.parameters.postMessage({ 
        channel: 'tracker-vu', 
        data: { vu: [...], channels: N }
    });
}

// In window-loader.js — reception
ipcRenderer.on('message-channel', (e, meta) => {
    const port = e.ports[0];
    port.start();  // CRITICAL: Must call start()!
    port.onmessage = (e) => { /* handle */ };
});
```

**Critical:** Always call `port.start()` or messages queue indefinitely causing OOM.

---

## Child Windows

All child windows use `js/window-loader.js` for shared bootstrap:

| Window | Shortcut | Data Source | Notes |
|--------|----------|-------------|-------|
| **Parameters** | P | MessagePort from engine | Adaptive UI: Audio/MIDI/Tracker tabs |
| **Monitoring** | N | MessagePort from engine | FFT, waveform, loudness analysis |
| **Mixer** | M | Direct from engines | Multi-track preview (20 tracks) |
| **Settings** | S | IPC to main | Config UI, output device selection |
| **Help** | H | Static | Keyboard shortcuts reference |

### Window Lifecycle

1. **Creation** → Stage sends `init_data` with `stageId`, `windowId`, `type`
2. **Loader** → Receives `init_data`, initializes config, applies theme
3. **Ready** → Sends `window-ready` to stage
4. **Visible** → Stage sends `show-window`, forwards to engine
5. **Close** → Calls `bridge.closeWindow()` which hides (fast reopen)
6. **Real Close** → Mixer only: `windowType === 'mixer'` triggers actual destroy

---

## Configuration System

### Files

| File | Purpose |
|------|---------|
| `js/config-defaults.js` | Default values, window dimensions |
| `user.json` | User settings (persistent) |
| `user_temp.json` | Temporary settings (`--defaults` flag) |
| `env.json` | Environment flags (DEBUG_MODE, etc.) |

### Key Defaults

```javascript
// config-defaults.js
audio: { volume: 0.5, output: { deviceId: '' }, hqMode: false, disableMidiPlayer: false }
ffmpeg: { stream: { prebufferChunks: 50 }, decoder: { threads: 0 } }
tracker: { stereoSeparation: 100 }
mixer: { preBuffer: 50, useSAB: false }
windows: { main: { width: 480, height: 278, scale: 14 }, ... }
```

---

## Debugging & Development

**Primary debugging method:** Use the logger. See [Logging-Based Debugging](#logging-based-debugging-primary-method) section above.

### Environment Flags (env.json)

```json
{
  "DEBUG_MODE": 4,              // Step-by-step init (0-7)
  "MINIMAL_MODE": true,         // UI only, skip audio init
  "KILL_MIDI": true,            // Skip MIDI init (debug)
  "KILL_TRACKER": true,         // Skip Tracker init (debug)
  "KILL_FFMPEG": true,          // Skip FFmpeg init (debug)
  "KILL_AUDIO_CONTEXT": true,   // Skip AudioContext creation (debug)
  "lazyLoadEngines": true,      // Lazy init MIDI and Tracker players
  "lazyLoadTracker": true,      // Lazy init Tracker only (overrides lazyLoadEngines)
  "config_log": true            // Log config changes
}
```

**Note:** `lazyLoadEngines` and `lazyLoadTracker` are development/testing flags in `env.json`. For user-facing MIDI disable, use `disableMidiPlayer: true` in `config.json` (see Configuration System).

### Command Line

```bash
# Minimal mode (debug CPU usage)
.\SoundApp.exe --minimal

# Start with fresh defaults
.\SoundApp.exe --defaults
.\SoundApp.exe --no-config
```

### DevTools Console Snippets

```javascript
// Check engine state (use logger for persistent output)
logger.info('debug', 'Engine state', { engineAlive: audioState.engineAlive, idleState: idleStateMachine.current });

// Force disposal/restore
debugIdle.forceDispose();
debugEngine.open();

// Check caches
waveformCache.getStats();

// Check lazy-init status
midi?._isInitialized ? "MIDI initialized" : "MIDI not loaded";
_trackerInstance ? "Tracker initialized" : "Tracker not loaded";

// Check MessagePorts
g.messagePorts;  // In engine

// Check log file location
logger.getLogPath();
```

---

## File Organization

```
js/
├── app.js                    # Main process
├── engines.js                # Audio engine (hidden window)
├── stage.js                  # Player UI (legacy, being phased out)
├── player.js                 # Player UI logic (used by stage.js)
├── rubberband-pipeline.js    # Rubberband WASM wrapper
├── waveform_analyzer.js      # Waveform extraction
├── shortcuts.js              # Global keyboard shortcuts
├── registry.js               # Windows file associations
├── window.js                 # Window utilities
├── window-loader.js          # Shared window bootstrap
├── config-defaults.js        # Default configuration
├── logger-main.js            # Main process logging (file output)
├── logger-renderer.js        # Renderer process logging (IPC to main)
│
├── midi/                     # MIDI player & FluidSynth
│   ├── midi.js
│   ├── synth-wrapper.js
│   └── *.worklet.js
│
├── mixer/                    # Multi-track mixer
│   ├── main.js
│   ├── mixer_engine.js
│   └── mixer-worklet-processor.js
│
├── monitoring/               # Audio analysis & visualization
│   ├── main.js
│   ├── visualizers.js
│   ├── analysis.worker.js
│   └── *.worker.js
│
├── parameters/               # Parameters window (Audio/MIDI/Tracker)
│   └── main.js
│
├── settings/                 # Settings window
│   └── main.js
│
└── help/                     # Help window
    └── main.js

bin/win_bin/                  # Windows binaries
├── ffmpeg_napi.node          # FFmpeg N-API binding
├── player-sab.js             # SharedArrayBuffer player
├── ffmpeg-worklet-sab.js     # FFmpeg AudioWorklet
└── realtime-pitch-shift-processor.js  # Rubberband worklet
```

---

## Known Issues & Behavior

### By Design

1. **MIDI Player CPU Usage**: The `js-synthesizer` library causes constant 0.3-0.5% CPU even when idle. Set `disableMidiPlayer: true` in `config.json` to eliminate (MIDI files won't play). The MIDI module always loads at startup (WASM/SoundFont), but the player instance initializes on first MIDI file.

2. **Rubberband Fixed 48kHz**: Rubberband ALWAYS runs at 48kHz regardless of HQ mode. HQ mode only affects the normal pipeline.

3. **First MIDI Load Delay**: 1-2s delay on first MIDI file (SoundFont loading, working as intended).

4. **First Tracker Load Delay**: Slight delay on first tracker file if `lazyLoadEngines: true` or `lazyLoadTracker: true` in `env.json`. Default behavior is eager initialization for backward compatibility.

### Under Investigation

1. **Position Update Smoothness**: 50ms interval is slightly less smooth than 15ms (barely noticeable, but ~60% less IPC traffic).

---

## Testing Checklist

When making changes to audio/engine code:

- [ ] Play/pause works for all three engine types (FFmpeg, MIDI, Tracker)
- [ ] Parameters window shows correct tab for each file type
- [ ] Parameters values persist across track changes when locked=true
- [ ] Monitoring shows correct visualization (FFT, waveform)
- [ ] Idle disposal triggers after timeout (check Task Manager for 0% CPU)
- [ ] Restoration resumes from exact position with correct params
- [ ] Mixer syncs and plays multiple tracks
- [ ] Child windows reconnect after engine restoration
- [ ] No double-press required for window toggle after restore
- [ ] Rubberband pitch/tempo changes are smooth (no crackling)
- [ ] **Logs are written** to `logs/` directory and contain expected trace

---

## Future Ideas (Not Implemented)

These are **ideas only** — no code written yet.

### Predictive Engine Restoration
Start restoring engine when user hovers over play button (before click).  
*Trade-off: May restore unnecessarily.*

### Visual "Engine Sleeping" Indicator
Show indicator when engine is disposed to explain brief delay on first play.

### Configurable Idle Timeouts
User settings for disposal timing (fast disposal vs instant playback).

### Smart Idle Detection
Dispose during audio fade-out silence instead of fixed timeouts.

### WebGL Waveform Rendering
Replace Canvas 2D with WebGL for smoother visualization.

### Code Splitting
Load MIDI/Tracker code only when needed (requires build changes).
