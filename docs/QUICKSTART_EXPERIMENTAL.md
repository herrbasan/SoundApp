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
| Shortcuts in child windows | ✅ |

---

## State Centralization - COMPLETED

**Goal:** Eliminate all local state in renderer windows. Main process should be the single source of truth for everything.

**Pattern:**
- ❌ Bad: Renderer updates local state, then tells main
- ✅ Good: Renderer sends intent to main, main updates state, broadcasts new state

**Completed Changes:**

### 1. Parameters Window (`js/parameters/main.js`)
- ✅ Removed `currentMode` and `audioMode` local variables
- ✅ Mode now derived from main's broadcasts via `getCurrentMode()` / `getAudioMode()`
- ✅ Sends `param-change` to main (not directly to engine)
- ✅ UI updates only via `set-mode` / `update-params` events from main

### 2. Monitoring Window (`js/monitoring/main.js`)
- ✅ `activeSource` centralized in main's `audioState.monitoringSource`
- ✅ Windows send `monitoring:setSource` intent to main
- ✅ Main broadcasts source changes to monitoring window

### 3. Main Process (`js/app.js`)
- ✅ Added `monitoringSource` to `audioState`
- ✅ Added `sendParamsToParametersWindow()` - single function to sync params
- ✅ `sendParamsToParametersWindow()` called on EVERY file load (not just type changes)
- ✅ Fixed fileType capitalization consistency (`'Tracker'` not `'tracker'`)

### 4. Player Window (`js/player.js`)
- ✅ Shortcut proxy fixed - sends `stage-keydown` to main which forwards to player
- ✅ `fileType` included in init_data for child windows

### 5. Window Loader (`js/window-loader.js`)
- ✅ Added `sendToMain()` method to bridge for proper main-process routing

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
3. **Direct window-to-window** - Must route through main

---

## Known Issues / Not Implemented

| Issue | Notes |
|-------|-------|
| Folder fallback for cover art | Not working - FFmpeg extraction works |
| First MIDI load delay | 1-2s (library init) |
| First Tracker load delay | Slight delay |
| Position update interval | 50ms (was 15ms) |
| Engine restoration delay | ~100-300ms |
| Mixer window state | Partially decentralized - uses local track state |

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
- **Mixer window state** - Track/mixer state should be partially centralized or documented as exception

### Low Priority  
- **Settings window** - Already uses config_obj properly, minor cleanup possible
- **Code cleanup** - Remove old stage.js references, consolidate IPC handlers

---

**Status:** Core architecture stable. Main process is single source of truth. State synchronization working. Parameters/monitoring windows are dumb renderers.
