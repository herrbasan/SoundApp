# SoundApp Experimental Branch - Quickstart

> **Purpose:** Maximize CPU and memory efficiency through aggressive resource disposal  
> **Core Strategy:** Engines run in a separate, disposable process (hidden window)

---

## Process Identification

In Task Manager, Electron processes show as `electron.exe`. To identify which is which:

| Process | Title (Task Manager) | Role |
|---------|---------------------|------|
| Main | `SoundApp Main` | Main process, state machine |
| UI Window | `SoundApp UI` | Player interface |
| Engine | `SoundApp Engine` | Audio processing |
| GPU | (no title) | Chromium GPU |
| Utilities | (no title) | Audio worklets, decoders |

**Note:** Process titles are set via `process.title` and may not show in all Task Manager views. Use Process Explorer from Sysinternals for detailed view including command line.

---

## The Architecture Shift

```
┌─────────────────────────────────────────────────────────────┐
│  Main Process (app.js)                                      │
│  ├─ State Machine (audioState) - Ground Truth               │
│  ├─ Idle Detection & Engine Disposal                        │
│  ├─ Waveform Cache (LRU, survives disposal)                 │
│  └─ IPC Routing (control) + MessagePort (high-freq data)    │
└─────────────────────────────────────────────────────────────┘
                               │
                               │ (create/destroy)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Hidden Window (engines.js)                                 │
│  ├─ FFmpeg Player (eager-init)                              │
│  ├─ MIDI Player (lazy-init)                                 │
│  ├─ Tracker Player (lazy-init)                              │
│  └─ AudioContext + Worklets                                 │
└─────────────────────────────────────────────────────────────┘
                               │
                               │ (MessagePort - direct)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Child Windows (parameters, monitoring)                     │
│  └─ VU meters, waveforms, parameter controls                │
└─────────────────────────────────────────────────────────────┘
```

**Key Insight:** The engine window can be destroyed entirely when idle, dropping CPU to ~0%. State lives in the main process and is restored on demand.

---

## Engine Init Strategy

| Engine | Module Load | Instance Init | Strategy |
|--------|-------------|---------------|----------|
| **FFmpeg** | Startup | Startup | Eager-init (always needed) |
| **MIDI** | Startup | On first MIDI file | Lazy-init |
| **Tracker** | Startup | On first tracker file | Lazy-init |

**Module Load** = JS classes imported (cheap, just code)  
**Instance Init** = Player instantiated, AudioContext connected, resources allocated (expensive)

---

## Idle Disposal Behavior

| Condition | Timeout | Action |
|-----------|---------|--------|
| Hidden to tray + paused | 5s | Destroy engine window |
| Visible but idle + paused | 10s | Destroy engine window |
| Playing | Never | Keep alive |

**Restoration triggers:** Play, Seek, Next/Prev, Window show/focus

---

## Key Files

| File | Responsibility |
|------|----------------|
| `js/app.js` | State machine, idle detection, disposal/restoration logic |
| `js/engines.js` | Audio engines (FFmpeg, MIDI, Tracker) - lives in hidden window |
| `js/player.js` | Main UI - sends commands, receives state |
| `js/window-loader.js` | Child window bootstrap - receives MessagePort |
| `js/rubberband-pipeline.js` | Pitch/time manipulation (WASM worklet) |

---

## Configuration

### `env.json` - Development Flags

```json
{
  "lazyLoadEngines": true,      // Enable lazy-init for MIDI/Tracker
  "lazyLoadTracker": true       // Specifically for tracker (optional)
}
```

### User Config - Disable MIDI Completely

```json
{
  "audio": {
    "disableMidiPlayer": true   // Saves 0.3-0.5% constant CPU
  }
}
```

---

## Debugging

```javascript
// DevTools console in main window

// Check idle status
debugIdle.status()
// { engineAlive, isPlaying, idleTimeSec, shouldDispose }

// Force disposal/restore
debugIdle.forceDispose()
debugEngine.open()

// Waveform cache stats
waveformCache.getStats()
// { hits, misses, evictions, hitRate }

// Engine init status
_midiInstance?.config ? "MIDI ready" : "MIDI not loaded"
_trackerInstance ? "Tracker ready" : "Tracker not loaded"
```

---

## Critical Implementation Details

### 1. State Preservation Flow

```
User clicks Play (engine disposed)
        │
        ▼
restoreEngineIfNeeded()
        │
        ├── 1. createEngineWindow({ skipAutoLoad: true })
        ├── 2. sendToEngine('cmd:setParams', audioState)     // Pre-set globals
        ├── 3. Re-register child windows + update stageId    // Fix routing
        ├── 4. sendToEngine('cmd:load', { ... })             // Load file
        ├── 5. ← Wait for 'audio:loaded' signal              // Players exist
        ├── 6. sendToEngine('cmd:applyParams', ...)          // Apply to players
        └── 7. sendParamsToParametersWindow()                // Update UI
```

**Race condition fix:** Step 5 waits for the `audio:loaded` signal before applying params. Players must exist before params are sent.

### 2. MessagePort Direct Communication

High-frequency data (VU meters, waveforms) bypasses main process:

```
Before: Engine → Main IPC → Window (main process bottleneck)
After:  Engine → MessagePort → Window (direct, ~70% less IPC)
```

**Critical:** `port.start()` must be called after receiving the port or messages queue indefinitely (OOM).

### 3. Lazy-Init Pattern

Engines initialize only when first needed:

| File Type | Engines Active |
|-----------|---------------|
| MP3, FLAC, etc. | FFmpeg only |
| .mid, .kar | FFmpeg + MIDI (init on first file) |
| .mod, .xm | FFmpeg + Tracker (init on first file) |

---

## Performance Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Idle CPU | 0.9-1.3% | ~0% | 100% reduction |
| IPC Traffic | 66 Hz | 20 Hz | 70% reduction |
| Memory | Growing | Bounded | Stable |
| Audio Glitches | Yes | No | Fixed |

---

## Known Limitations

1. **First MIDI load:** 1-2s delay on first MIDI file (library initialization)
2. **First Tracker load:** Slight delay on first tracker file
3. **Position update:** 50ms interval (was 15ms) - barely noticeable
4. **Engine restoration:** ~100-300ms delay after disposal

---

## 🔧 Hardening Issues (Fixed)

The following issues have been addressed:

### 1. MIDI Eager-Init Bug (Regression) ✅
**Status:** Fixed - MIDI now lazy-init

**Fix:** Removed `await initMidiPlayer()` from `init()`, added lazy-init check in `playAudio()` when `isMIDI && !midi`.

### 2. Tracker State Reset on Engine Disposal ✅
**Status:** Fixed - State properly reset

**Fix:** `disposeEngines.tracker()` now resets all module-scope state:
```javascript
_trackerInstance = null;
_trackerInitPromise = null;
_trackerInitialized = false;
player = null;
```

### 3. Incomplete Tracker Disposal ✅
**Status:** Fixed - Proper disposal implemented

**Fix:** Tracker disposal now:
- Stops playback
- Disconnects gain nodes
- Resets all module-scope state

### 4. Race Condition on Engine Disposal ✅
**Status:** Fixed - Aborts if disposed during init

**Fix:** `initTrackerPlayerLazy()` and `getTrackerPlayer()` check `g.isDisposed` after initialization and abort if engine was destroyed, preventing stale instance usage.

### 5. toggleHQMode Ignores Lazy-Init ✅
**Status:** Fixed - Respects lazy-init flag

**Fix:** `toggleHQMode()` now checks `lazyLoadEngines`/`lazyLoadTracker` flags and only eagerly creates tracker player when lazy-init is disabled. When lazy-init is enabled, tracker state is reset and will lazy-init on next tracker file.

---

## Future Directions (Not Implemented)

| Idea | Description |
|------|-------------|
| Predictive Restoration | Start restoring on hover over play button |
| Visual "Sleeping" Indicator | Show when engine is disposed |
| Configurable Timeouts | User-defined disposal timing |
| Smart Idle Detection | Dispose during fade-out silence |
| WebGL Waveform Rendering | Replace Canvas 2D |
| Per-File-Type Engine Init | Only init the engine needed for current file type |

---

## Testing Checklist

- [ ] Play file, pause, wait 10s visible → CPU drops to ~0%
- [ ] Click play → Restores and resumes from position
- [ ] Open parameters, set pitch +5, pause, dispose, play → Pitch preserved
- [ ] Open monitoring window, dispose, restore → Waveform cached, VU meters work
- [ ] Play MIDI → No constant CPU when idle (if lazy-init enabled)
- [ ] First tracker file → Slight delay then plays
- [ ] Toggle HQ mode with lazy-init → Respects flag

---

## Document References

| Document | Purpose |
|----------|---------|
| `IDLE_DISPOSAL_IMPLEMENTATION.md` | Full disposal implementation details |
| `OPTIMIZATIONS.md` | Performance optimizations summary |
| `AGENTS.md` | Audio pipeline mental model |

---

**Status:** Idle disposal fully working. Parameter preservation fixed. MessagePort direct communication active. Lazy-init hardened for both MIDI and Tracker.
