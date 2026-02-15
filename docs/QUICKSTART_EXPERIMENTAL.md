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

---

## Active Work: State Centralization

**Goal:** Eliminate all local state in renderer windows. Main process should be the single source of truth for everything.

**Pattern:**
- ❌ Bad: Renderer updates `g.idx` locally, then tells main
- ✅ Good: Renderer sends `audio:next` to main, main updates index, broadcasts new state

**Status:** Playlist navigation, loop, shuffle now centralized. Still hunting down local states in parameters/settings windows.

---

## Known Issues / Not Implemented

| Issue | Notes |
|-------|-------|
| Folder fallback for cover art | Not working - FFmpeg extraction works |
| First MIDI load delay | 1-2s (library init) |
| First Tracker load delay | Slight delay |
| Position update interval | 50ms (was 15ms) |
| Engine restoration delay | ~100-300ms |

---

## Key Files

| File | Responsibility |
|------|----------------|
| `js/app.js` | State machine, single source of truth |
| `js/engines.js` | Audio processing (FFmpeg/MIDI/Tracker) |
| `js/player.js` | UI renderer - sends actions, receives state |
| `js/window-loader.js` | Child window bootstrap |

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

**Status:** Core architecture stable. Main process is single source of truth. State synchronization working.
