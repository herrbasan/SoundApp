# SoundApp Experimental Branch

> **Core Architecture:** Main process owns all state. Player windows are "dumb" renderers. Engine runs in disposable hidden window.

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

## State Centralization

| Component | Status | Notes |
|-----------|--------|-------|
| **Parameters Window** | ✅ Complete | Dumb renderer - receives mode/params from main |
| **Monitoring Window** | ✅ Complete | Dumb renderer - receives source from main |
| **Player Window** | ✅ Complete | Single `g.state` receives from broadcasts only |
| **Engine** | ✅ Complete | Stateless - receives params via IPC commands |
| **Mixer Window** | ⚠️ Exception | Maintains local track state by design - separate audio domain |
| **Main Process** | ✅ Complete | `audioState` is single source of truth |

**Pattern:** Player sends intent → Main updates `audioState` → Main broadcasts `state:update` → Player renders from broadcast. No local mutations.

---

## Architecture Insights

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
| Folder fallback for cover art | Not working - FFmpeg extraction works |
| First MIDI load delay | 1-2s (library init, by design) |
| First Tracker load delay | Slight delay if lazy-load enabled (by design) |
| Position update interval | 50ms (was 15ms, ~60% less IPC traffic) |
| Mixer window state | Track/mixer state is local by design - separate domain |

---

## Key Files

| File | Responsibility |
|------|----------------|
| `js/app.js` | State machine, single source of truth |
| `js/engines.js` | Audio processing (FFmpeg/MIDI/Tracker) |
| `js/player.js` | UI renderer - sends actions, receives state |
| `js/window-loader.js` | Child window bootstrap, bridge setup |
| `js/managers/window-manager.js` | Window lifecycle and focus management |
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

## Potential Future Work

### Medium Priority
- **Logging cleanup** - Player has excessive logging
- **Disable logging in packaged builds** - Ensure logger is disabled or no-op when app is packaged for production
- ~~**Parameters soundfont selector init**~~ ✅ **Fixed** - (1) Soundfont list cached in main process (app.js), scanned once at startup; (2) `initSoundfontSelector` only runs once from `bridge-ready`; (3) `set-mode` applies values via `updateParams` → `applySoundfontToDropdown`; (4) `updateSoundfontOptions` uses `reRender()` instead of `update()` to avoid state corruption.

### Low Priority
- **Settings window** - Already uses config_obj properly, minor cleanup possible
- **Code cleanup** - Remove old stage.js references, consolidate IPC handlers

### Refactoring Ideas (DETERMINISTIC_MIND aligned)
- Globals (`g.`): Refactor engines.js/player.js to explicit params
- Immutable audioState: Use spreads in app.js
- Structured errors/tests/perf improvements

---

**Status:** Core architecture stable. Main process is single source of truth. All windows are dumb renderers receiving state from broadcasts. Window management centralized in WindowManager singleton.
