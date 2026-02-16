# SoundApp Experimental Branch

> **Core Architecture:** Main process owns all state. Player windows are "dumb" renderers. Engine runs in disposable hidden window.

---

## ⚠️ STATE CENTRALIZATION STATUS (Feb 2026)

**Correction:** Previous documentation incorrectly claimed state centralization was "COMPLETED". This was inaccurate.

### Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| **Parameters Window** | ✅ Complete | Dumb renderer - no local state, receives from main |
| **Monitoring Window** | ✅ Complete | Dumb renderer - no local state, receives from main |
| **Player Window** | ✅ Fixed | Previously maintained `g.uiState`, `g.music`, `g.idx`, `g.max`, `g.isLoop`. Now unified to single `g.state` that receives from main broadcasts only |
| **Engine (engines.js)** | ✅ Complete | Stateless - receives params via IPC commands from Main. Uses `g.currentAudioParams`, `g.currentMidiParams`, `g.currentTrackerParams` only for caching received values |
| **Mixer Window** | ⚠️ Exception | Maintains local track state by design - separate audio domain |

**Pattern:** Player sends intent → Main updates `audioState` → Main broadcasts `state:update` → Player renders from broadcast. No local mutations.

---

## Architecture

```
┌─────────────────────────────────────────┐
│  Main Process (app.js)                  │
│  └─ State Machine (single source of     │
│     truth for playlist, playback state) │
└─────────────────────────────────────────┘
                    │
    ┌───────────────┼───────────────┐
    ▼               ▼               ▼
┌─────────┐   ┌──────────┐   ┌──────────┐
│ Player  │   │ Engine   │   │ Child    │
│ Window  │   │ (hidden) │   │ Windows  │
│ (UI)    │   │          │   │(params,  │
└─────────┘   └──────────┘   │ monitor) │
                             └──────────┘
```

**Key Principle:** Player sends intent (`audio:next`, `audio:play`), main updates state, main broadcasts new state to all windows.

---

## What's Working

| Feature | Status |
|---------|--------|
| Engine disposal on idle (CPU → 0%) | ✅ |
| Engine restoration on interaction | ✅ |
| Playlist navigation (next/prev/shuffle) | ✅ |
| State sync between main and player | ✅ |
| Cover art display | ✅ |
| Monitoring window seeking | ✅ |
| Lazy-init for MIDI/Tracker | ✅ |
| Waveform cache (survives disposal) | ✅ |
| Parameter preservation across disposal | ✅ |
| Parameters window tab switching | ✅ |
| Shortcuts in child windows | ⚠️ Partial - Settings/Help window shortcuts broken |

---

## State Centralization

**Goal:** Eliminate all local state in renderer windows. Main process should be the single source of truth for everything.

**Pattern:**
- ❌ Bad: Renderer updates local state, then tells main
- ✅ Good: Renderer sends intent to main, main updates state, broadcasts new state

**Status by Component:**

### 1. Parameters Window (`js/parameters/main.js`) ✅
- No local state - dumb renderer
- Receives mode/params via `set-mode` / `update-params` from main
- Sends `param-change` intent to main
- Mode derived from DOM visibility (main owns state)

### 2. Monitoring Window (`js/monitoring/main.js`) ✅
- No local state - dumb renderer  
- Receives `set-monitoring-source` from main
- Sends `monitoring:setSource` intent to main

### 3. Player Window (`js/player.js`) ✅ Fixed Feb 2026
- **Previously (WRONG):** Maintained parallel state: `g.uiState`, `g.music`, `g.idx`, `g.max`, `g.isLoop`
- **Now:** Single `g.state` object receives from `state:update` broadcasts only
- Renders directly from broadcast, no local mutations
- Sends intents: `audio:next`, `audio:prev`, `audio:play`, etc.

### 4. Engine (`js/engines.js`) ⚠️ Needs Review
- May still have duplicate state: `engineState`, `g.audioParams`
- Should receive params from main and apply without storing

### 5. Main Process (`js/app.js`) ✅
- `audioState` is single source of truth
- Handles all intents, broadcasts updates
- `sendParamsToParametersWindow()` syncs params to UI

---

## Architecture Insights (Learned the Hard Way)

**What Works:**
1. **Always broadcast on every relevant event** - Never conditionally send state updates
2. **Dumb renderers** - Child windows should only render, never maintain state
3. **Single source of truth** - Main process owns all state, outlives renderers
4. **Intent pattern** - Windows send intent (`param-change`), main updates, main broadcasts

**What Breaks:**
1. **Conditional updates** (`if (changed) send()` ) - Race conditions, missed updates
2. **Local state** - Any state in renderers will drift

---

## Known Issues / Not Implemented

| Issue | Notes |
|-------|-------|
| ~~MIDI metadata in Player~~ | ✅ **Fixed** - `type: 'midi'` was lowercase in player.js but uppercase 'MIDI' in engines.js |
| ~~Format display shows wrong sample rate~~ | ✅ **Fixed** - Now shows file's original sample rate |
| Folder fallback for cover art | Not working - FFmpeg extraction works |
| First MIDI load delay | 1-2s (library init) |
| First Tracker load delay | Slight delay |
| Position update interval | 50ms (was 15ms) |
| ~~Engine restoration delay~~ | ✅ **Optimized** - Event-driven restoration, reduced timeouts, removed setTimeout delays |
| ~~Monitoring window CPU usage~~ | ✅ **Fixed** - No data sent when hidden, RAF cancelled, visibility check on restoration |
| Mixer window state | Partially decentralized - uses local track state |
| ~~Tracker pitch by semitones~~ | ✅ **Fixed** - Was double-converting semitones to ratio |

---

## Key Files

| File | Responsibility |
|------|----------------|
| `js/app.js` | State machine, single source of truth |
| `js/engines.js` | Audio processing (FFmpeg/MIDI/Tracker) |
| `js/player.js` | UI renderer - sends actions, receives state |
| `js/window-loader.js` | Child window bootstrap, bridge setup |
| `js/parameters/main.js` | Dumb renderer - receives mode/params from main |
| `js/monitoring/main.js` | Dumb renderer - receives source from main |

---

## Process Identification (Task Manager)

| Title | Role |
|-------|------|
| `SoundApp Main` | Main process |
| `SoundApp UI` | Player window |
| `SoundApp Engine` | Audio engine (hidden) |

---

## Debugging

```javascript
// Main process console
debugIdle.status()        // Check idle/disposal state
debugIdle.forceDispose()  // Force engine disposal
debugEngine.open()        // Open engine DevTools
waveformCache.getStats()  // Cache hit/miss stats
```

---

## Remaining Work (Future Sessions)

### High Priority
- ~~**Window Management System**~~ - ✅ **Refactored** - Moved to `js/managers/window-manager.js`
  - Centralized window state tracking in WindowManager singleton
  - Native event listeners for reliable hide/close detection
  - Robust focus restoration to player window (with Windows alwaysOnTop hack)
  - Child windows now properly return focus to player on hide/close
- ~~**Settings/Help Shortcuts**~~ - ✅ **Fixed** - Shortcuts now work in Settings and Help windows
- **Mixer window state** - Track/mixer state should be partially centralized or documented as exception
- ~~**Mixer - FFmpeg streaming**~~ - ✅ **Fixed** - Added FFmpeg paths to mixer init_data for streaming support
- ~~**Monitoring Window**~~ - ✅ Fixed - Survives engine dispose cycle, zero CPU when hidden
- ~~**Player - MIDI metadata**~~ - ✅ Fixed - Case mismatch resolved

### Medium Priority
- **Parameters Window - MIDI Tab** - ~~Soundfont select does not show currently selected model at startup~~ ✅ Fixed - **IMPLEMENTATION NEEDS REVIEW** (sloppy: conditional bypass in engines.js, config saved in two places)
- **Logging cleanup** - Player has excessive logging
- **Engine logging** - Clean up logging, relay to app.js logging instead of console

### Low Priority  
- **Settings window** - Already uses config_obj properly, minor cleanup possible
- **Code cleanup** - Remove old stage.js references, consolidate IPC handlers

---

**Status:** Core architecture stable. Main process is single source of truth. Player window now properly receives state from broadcasts (fixed Feb 2026). Parameters/monitoring windows are dumb renderers. **Window management system refactored.**
