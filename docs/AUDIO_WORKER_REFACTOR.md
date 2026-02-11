# Audio Worker Refactor

> **Status:** ✅ **PHASE 4 COMPLETE**  
> **Branch:** `feature/audio-worker`  
> **Goal:** 0% CPU when idle/tray by separating UI from audio engine

---

## ✅ Completion Summary

### What Was Accomplished

| Component | Status | Notes |
|-----------|--------|-------|
| Audio Engine (engines.js) | ✅ | Headless, all formats working (FFmpeg, MIDI, Tracker) |
| Player UI (player.js) | ✅ | UI-only, communicates via IPC |
| State Machine (app.js) | ✅ | Ground truth, outlives both renderers |
| Parameters Window | ✅ | All controls functional (tape/pitchtime, MIDI transpose/BPM, Tracker channels) |
| Audio Monitoring | ✅ | Waveforms, VU meters, MIDI timeline |
| Engine Disposal/Restore | ✅ | Confirmed working - see findings below |

**All 69 integration tests pass.**

### 🔬 CPU Disposal Findings (Confirmed)

Through systematic testing with console commands (`debugEngine.close()`, `disposeIPC.all()`), we confirmed:

| Configuration | CPU Usage | Finding |
|--------------|-----------|---------|
| Full app running | 0.3-1.1% | Normal operation |
| Engine window closed | ~0-0.3% | **Major reduction** |
| Engine + IPC disposed | ~0% + GC spikes | **Near zero** |
| Player window alone | ~0% | UI is not the culprit |

**Conclusion:** The audio engines (FFmpeg, MIDI, Tracker) are the CPU consumers. The player window itself uses negligible CPU.

### Hard-Reset Approach Confirmed Working

The refactor successfully enables **clean disposal via window destruction**:

1. **Close engine window** → `engineWindow.destroy()` immediately frees all resources
2. **Result:** CPU drops to near 0%
3. **Restore:** `createEngineWindow()` recreates from scratch in <300ms
4. **State preservation:** `audioState` in app.js maintains playback position, file, params

This validates the architecture: by separating engines into their own window, we can achieve true 0% CPU when idle (tray + paused) by simply closing that window.

### Minor CPU Spikes After Disposal

After full disposal, occasional 0.1-0.2% spikes remain:
- **Cause:** V8 garbage collection + config auto-save interval (3s)
- **Impact:** Negligible
- **Not from:** Player window RAF (removed), IPC overhead, or audio engines

---

## Architecture Inversion

---

## Architecture Inversion

Instead of moving audio to a new hidden worker, we **move UI out** and let the existing `stage.js` become the hidden audio engine.

**Before:**
```
app.js (main)
    └── stage.js (renderer) ──► UI + Audio (visible)
```

**After:**
```
app.js (main) ──► State Machine (ground truth)
    ├── engines.js (renderer) ──► Audio Engine (hidden, was stage.js)
    └── player.js (renderer) ───► UI Only (visible, from stage.js copy)
```

---

## Build Strategy: Copy-and-Strip

Both new files come from the same source — `stage.js`:

| New File | Source | Strip | Keep |
|----------|--------|-------|------|
| `engines.js` | `stage.js` (renamed) | DOM refs, UI rendering, key handlers, drag-drop, window setup | Audio init, players, pipelines, routing, monitoring analysers |
| `player.js` | `stage.js` (copied) | AudioContext, players, pipeline logic, NAPI decoder | DOM refs, controls, timeline, cover art, metadata, drag-drop, playlist, shortcuts |

HTML and CSS stay in place — `player.html` is essentially `stage.html` pointing at the new script. No visual redesign.

---

## Communication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     MAIN PROCESS (app.js)                        │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 STATE MACHINE (ground truth)                │  │
│  │  • file, isPlaying, duration, params, volume, pipeline     │  │
│  │  • window visibility, engine alive status                  │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                       │
│         ┌─────────────────┼─────────────────┐                    │
│         │                 │                 │                    │
│         ▼                 ▼                 ▼                    │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐             │
│  │ engines.js  │  │ player.js   │  │ params/      │             │
│  │ AUDIO       │  │ UI          │  │ settings/    │             │
│  │ (hidden)    │  │ (visible)   │  │ etc.         │             │
│  └─────────────┘  └─────────────┘  └──────────────┘             │
│                                                                   │
│  State changes: broadcast to ALL windows (each filters its own)  │
│  Position (currentTime): targeted send to player + monitoring    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## IPC Design

### Two channels

**State channel (broadcast):** All state changes — play/pause, file loaded, params changed, pipeline switched — are broadcast by app.js to every window. Each window filters for what it cares about. Low frequency (user actions, a few per second at most).

**Position channel (targeted):** `currentTime` updates at ≤15ms resolution. Engine pushes position to app.js, which forwards specifically to player.js and monitoring.js. Not broadcast — only the two windows that need it receive it.

### IPC latency budget

```
Engine → app.js → player.js  ≈  1ms + 1ms  =  2ms
Budget per frame:                              16ms
Headroom:                                      14ms  ✓
```

Position updates are fire-and-forget. The UI renders whatever the latest received value is. No request-response, no synchronous reads needed.

### Example flow

```javascript
// player.js: user clicks play
ipcRenderer.send('audio:play');

// app.js: routes command to engine, updates state
engines.send('cmd:play');
state.isPlaying = true;
broadcast('state:update', { isPlaying: true });

// engines.js: starts playback, pushes position continuously
setInterval(() => {
    ipcRenderer.send('audio:position', currentTime);
}, 15);

// app.js: targeted forward (not broadcast)
playerWindow.send('position', currentTime);
monitoringWindow?.send('position', currentTime);
```

---

## State Machine (app.js)

app.js is the single source of truth. Both renderers are projections of this state.

```javascript
const audioState = {
    // Playback
    file: null,             // Current file path
    isPlaying: false,
    position: 0,            // Seconds (updated from engine)
    duration: 0,

    // Audio params
    mode: 'tape',           // 'tape' | 'pitchtime'
    tapeSpeed: 0,
    pitch: 0,
    tempo: 1.0,
    formant: false,
    locked: false,
    volume: 0.5,
    loop: false,

    // Pipeline
    activePipeline: 'normal',   // 'normal' | 'rubberband'

    // Engine
    engineAlive: false,

    // Playlist (owned by main, not by UI)
    playlist: [],
    playlistIndex: 0
};
```

### Why playlist lives in app.js

Playlist determines "what plays next" — a decision that persists across UI show/hide and engine dispose/restore. If the user is in tray mode and the track ends, app.js must know what to play next without asking the UI window (which may be hidden).

### Track-end and advance

When a track finishes, engines.js sends `audio:ended` to app.js. app.js owns the advance logic:

1. Check loop → if looping, send `cmd:seek(0)` + `cmd:play` to engine
2. Check shuffle → pick next index accordingly
3. Determine next file, send `cmd:load(nextFile)` + `cmd:play` to engine
4. Broadcast `state:update` with new file/metadata to all windows

The engine is never playlist-aware. It plays what it's told.

**Same-format optimization:** If the next file uses the same pipeline/module as the current one, the engine skips reinit. FFmpeg → FFmpeg: just `open()` + `play()`. MIDI → MIDI: same. Tracker → Tracker: same. Reinit only happens on pipeline change (e.g., normal → rubberband, or sample rate change for HQ mode).

---

## Engine Lifecycle

| Event | Action | CPU Impact |
|-------|--------|------------|
| App start | Engine window created, hidden, loads engines.js | ~0.3-0.5% baseline |
| First play | Engine initializes AudioContext + FFmpeg player | Increases temporarily |
| File skip | Engine stays alive, `open()` + `play()` — zero overhead | Unchanged |
| Format switch | Lazy init MIDI/Tracker in engine as needed | May spike briefly |
| **Tray (paused)** | **Dispose engine window** | **→ ~0% CPU** ✅ |
| Tray (playing) | Engine stays alive, UI hidden | Normal playback CPU |
| **Restore from tray** | **Recreate engine + restore state** | **<300ms restore** ✅ |
| Idle timeout (paused) | Auto-dispose after 5s → 0% CPU | Configurable |

### Disposal Confirmation

**Tested via console commands:**
```javascript
// In player window DevTools:
debugEngine.close()   // CPU drops to ~0%
debugEngine.open()    // Restores in <300ms
```

**The hard-reset (window destroy/recreate) is the only reliable path to 0% CPU.**
Individual engine disposal (player.stop(), midi.dispose()) leaves residual overhead.
This validates the window-based architecture decision.

### Restore sequence (when engine was disposed)

```
create engine window → init → load(state.file) → seek(state.position) → pause
```

Expected restore time: well under 300ms. AudioContext creation is ~10ms, FFmpeg `open()` + `seek()` is ~20-50ms for typical files. State in app.js means nothing is lost.

### Monitoring (VU data)

Monitoring stays unchanged. engines.js reads AnalyserNodes in-process (same renderer, same AudioContext) and sends VU data directly to the monitoring window via IPC — exactly as stage.js does today. The monitoring data path does not route through app.js. Position data for the monitoring timeline comes via the targeted position channel from app.js.

---

## File Structure

```
html/
  player.html             # Visible UI (was stage.html)
  engines.html            # Hidden audio engine (minimal HTML)

js/
  app.js                  # State machine, IPC router, engine lifecycle
  engines.js              # Audio engine (stage.js with UI stripped)
  player.js               # UI (stage.js copy with audio stripped)

  rubberband-pipeline.js  # Unchanged (used by engines.js)
  midi/midi.js            # Unchanged (used by engines.js)
  monitoring/             # Unchanged
  parameters/             # Unchanged
  settings/               # Unchanged
```

No new subdirectories needed. The child windows (parameters, settings, monitoring, help, mixer) continue unchanged — they already communicate via IPC through app.js.

---

## Implementation Phases

### Phase 1: Headless Engine

Copy `stage.js` → `engines.js`. Strip all DOM manipulation, UI rendering, element refs, key handlers, drag-drop, window setup. Add IPC command handlers (`cmd:play`, `cmd:pause`, `cmd:seek`, `cmd:load`, `cmd:setParams`). Add position push (`audio:position`). Create `engines.html` (minimal: load scripts, no UI).

**Test:** Launch engines.html as hidden window. Send commands from devtools via IPC. Audio plays. Position events flow.

### Phase 2: State Machine in app.js

Add `audioState` object. Add IPC routing: receive commands from any renderer, forward to engine, receive events from engine, broadcast state updates, targeted position sends.

**Test:** State in app.js reflects engine state. Commands from devtools update both state and engine.

### Phase 3: Player UI

Copy `stage.js` → `player.js`. Strip all audio code (AudioContext, players, pipeline, NAPI). Replace with IPC: `send('audio:play')`, `on('state:update')`, `on('position')`. Create `player.html` (essentially `stage.html` with new script src).

**Test:** Full app works: player.js visible, engines.js hidden, app.js mediating. All controls functional.

### Phase 4: Disposal ✅ COMPLETE

Implement engine disposal on tray+paused and idle timeout. Implement engine restoration from `audioState`.

**Status:** ✅ Confirmed working

**Implementation:**
- `disposeEngineWindow()` - Force destroy hidden engine window
- `restoreEngineIfNeeded()` - Recreate + restore state from `audioState`
- 5-second idle timeout when tray+paused
- Automatic restore on window show/tray click

**Test Results:**
- ✅ 0% CPU when tray+paused (engine disposed)
- ✅ Engine restores cleanly in <300ms
- ✅ File skip speed unchanged when engine alive
- ✅ State preservation works (file, position, params)

**Key Finding:** The "hard-reset" approach (window destroy/recreate) is the only reliable way to achieve true 0% CPU. Individual engine disposal (stop/disconnect) doesn't fully release resources.

### Phase 5: Polish

Error recovery: detect engine crash via `render-process-gone` event, recreate once, restore from `audioState`. Config flow. Audit child windows (parameters, settings, monitoring) for any direct calls to stage.js globals — replace with IPC through app.js where found.

---

## Design Decisions

### engines.js is stage.js, not a rewrite

The proven audio code stays. We strip UI from it; we don't rewrite audio logic.

### player.js is stage.js copy, not written from scratch

The UI code (controls, timeline, cover art, metadata, playlist rendering, shortcuts, drag-drop) is copied from stage.js with audio calls replaced by IPC sends. HTML/CSS unchanged.

### app.js is ground truth

All state lives in the main process. It outlives both renderers. Engine disposal doesn't lose state. UI hide doesn't lose state. This is the centralized state system the architecture docs describe.

### Broadcast + targeted position

State changes: `broadcast()` to all windows. Every window filters for what it needs. Simple, no routing logic per message type.

Position updates: `send()` specifically to player.js and monitoring.js only. At ≤15ms intervals, broadcasting to windows that don't need it (settings, help, parameters) is wasteful. Two targeted sends is cleaner.

### Drag-drop routing

player.js keeps drag-drop handling. On file drop, player.js sends the file path to app.js via `audio:load`. app.js updates state and forwards `cmd:load` to engines.js. Same for playlist drops — player.js resolves paths, sends them to app.js to update `audioState.playlist`.

### Monitoring: no change

engines.js reads AnalyserNodes locally (same renderer process, same AudioContext) and pushes VU data directly to the monitoring window. This is identical to what stage.js does today. The AnalyserNode reads are zero-cost in-process calls, not IPC. Only the timeline position comes via app.js.

### Mixer unchanged

Independent window, separate AudioContext, not part of this refactor.

---

## Related Files

| File | Role |
|------|------|
| [js/stage.js](js/stage.js) | Source for both engines.js and player.js. Removed when done. |
| [js/app.js](js/app.js) | Gains state machine, IPC router, engine lifecycle |
| [js/rubberband-pipeline.js](js/rubberband-pipeline.js) | Used by engines.js, unchanged |
| [js/midi/midi.js](js/midi/midi.js) | Used by engines.js, unchanged |
| [html/stage.html](html/stage.html) | Becomes player.html (new script src) |
| [bin/win_bin/player-sab.js](bin/win_bin/player-sab.js) | Used by engines.js, unchanged |

---

## Success Criteria - ✅ ALL ACHIEVED

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | **File skip** | ✅ Same latency | Engine stays alive, direct IPC call |
| 2 | **Tray + paused** | ✅ ~0% CPU | Engine window disposed, state in app.js |
| 3 | **Tray + playing** | ✅ Works | Audio continues, UI hidden |
| 4 | **Restore** | ✅ <300ms | Engine recreate + load + seek |
| 5 | **No regressions** | ✅ All working | All formats, pipeline switching, monitoring, child windows |

### Bonus Achievements

- **Rubberband pipeline switching** works correctly
- **Parameters window** fully functional for all formats
- **Tracker channel mixer** with VU meters
- **Debug commands** for CPU testing (`debugEngine.close()`, `disposeIPC.all()`)

---

## Notes

- Branch experiment. Delete if it fails.
- Measure at each phase: file skip time, position update latency, idle CPU.
- Both engines.js and player.js are derived from stage.js by stripping, not by writing new code.
- stage.js is the reference during development, deleted at the end.
