# Current Tasks - February 21, 2026

> **Status**: Consolidated from design gap analysis and state architecture review  
> **Priority Order**: High → Medium → Low

---

## 🔴 HIGH PRIORITY

### 1. State Client Implementation ✅ COMPLETED
**Source**: `state-architecture-analysis.md`, `state-client-usage.md`

Create a unified State Client that abstracts IPC communication, providing synchronous reads and asynchronous writes with reactive subscriptions.

**Deliverables**:
- [x] Create `js/state-client.js` with the following API:
  - `State.get(key)` - Synchronous read from local proxy
  - `State.set(key, value)` - Async write (intent to main)
  - `State.subscribe(key, callback)` - Reactive subscriptions
  - `State.dispatch(action, payload)` - Complex actions (play, pause, seek)
- [x] Update `js/window-loader.js` to inject State Client into all windows
- [x] Implement main process handler in `app.js` for State Client IPC

**Notes**:
- State Client created at `js/state-client.js`
- Already loaded by `js/window-loader.js` for child windows
- Main process handlers already existed (`state:requestSync`, `state:setIntent`, `action:dispatch`)
- `player.js` already has State Client integration with fallback handling

---

### 1b. State Client Visibility-Aware Processing ✅ COMPLETED
**Source**: `design-gaps-analysis.md` - Gap 7

State Client now skips subscription notifications when window is hidden to save CPU.

**Implementation**: Added `_isVisible` flag and visibility check in `_applyDelta()` that stores updates but skips notification callbacks when window is hidden.

**Migration Path**:
```javascript
// Phase 1: Create State Client (new file)
// Phase 2: Migrate player.js (remove g.state duplication)
// Phase 3: Migrate parameters window
// Phase 4: Deprecate old IPC patterns
```

---

### 2. Position Update Scaling with Visibility ✅ COMPLETED
**Source**: `design-gaps-analysis.md` - Gap 1

Main process now sends `engine:set-position-mode` when player window is hidden/minimized. Position updates scale from 20fps to 2fps when window not visible.

**Implementation**:
```javascript
// In app.js - visibility handlers:
wins.main.on('hide', () => {
    sendToEngine('engine:set-position-mode', { mode: 'minimal' });
});

wins.main.on('show', () => {
    sendToEngine('engine:set-position-mode', { mode: 'normal' });
});

wins.main.on('minimize', () => {
    sendToEngine('engine:set-position-mode', { mode: 'minimal' });
});
```

**Modes**:
- `scrubbing`: 16ms (60fps) - User dragging seek bar
- `normal`: 50ms (20fps) - Standard playback 
- `idle`: 250ms (4fps) - Window background
- `minimal`: 500ms (2fps) - Window hidden/minimized

**Files Modified**:
- `js/app.js` - Added visibility-based mode switching for all hide/show/minimize/restore events

---

### 3. Replace g.state in player.js with State Client
**Source**: `state-architecture-analysis.md`

The player window maintains a massive `g.state` object that duplicates `audioState`. This is the largest state duplication in the codebase.

**Migration**:
```javascript
// Before
ipcRenderer.on('state:update', (e, data) => {
    if (data.isPlaying !== undefined) {
        g.state.isPlaying = data.isPlaying;
        updatePlayButton();
    }
});

// After
State.subscribe('playback.isPlaying', (isPlaying) => {
    updatePlayButton(isPlaying);
});
```

**Files to Modify**:
- `js/player.js` - Remove g.state, use State Client subscriptions
- `js/app.js` - Ensure broadcastState sends deltas compatible with State Client

---

## 🟡 MEDIUM PRIORITY

### 4. Visibility-Aware broadcastState ✅ ALREADY IMPLEMENTED
**Source**: `design-gaps-analysis.md` - Gap 6

`broadcastState()` already checks visibility before sending:

```javascript
function broadcastState(excludeEngine = false) {
    // ...build state update...
    
    // OPTIMIZATION: Skip broadcasting when player window is hidden
    if (!wins.main?.isVisible()) {
        logger.debug('main', 'broadcastState: skipped - window hidden');
        return;
    }
    
    sendToPlayer('state:update', stateUpdate);
}
```

**Status**: Already implemented in `js/app.js` around line 1694-1699.

---

### 5. Unify Parameters Window with State Client
**Source**: `state-architecture-analysis.md`

Parameters window uses ad-hoc IPC patterns (`set-mode`, `update-params`, `param-change`). Migrate to State Client for consistency.

**Current Pattern**:
```javascript
bridge.sendToStage('param-change', {
    mode: 'audio',
    param: 'pitch',
    value: 3
});
```

**Target Pattern**:
```javascript
await State.set('audio.pitch', 3);
```

**Files to Modify**:
- `js/parameters/main.js` - Replace bridge calls with State Client
- `js/app.js` - Handle State Client set requests for audio params

---

### 6. Monitoring Pause on Hide ✅ ALREADY IMPLEMENTED
**Source**: `optimization-analysis.md` - Priority 4

Monitoring loop correctly pauses when monitoring window is hidden.

**Implementation in `js/engines.js`**:
```javascript
ipcRenderer.on('window-visible', (e, data) => {
    if (data.type === 'monitoring') {
        g.monitoringReady = true;
        startMonitoringLoop();
        await applyRoutingState();
    }
});

ipcRenderer.on('window-hidden', (e, data) => {
    if (data.type === 'monitoring') {
        g.windowsVisible.monitoring = false;
        g.monitoringReady = false;
        stopMonitoringLoop();
        await applyRoutingState();
    }
});
```

**Status**: Already implemented and working correctly.

---

## 🟢 LOW PRIORITY

### 7. Settings Window Migration (Optional) - WON'T DO
**Source**: `state-architecture-analysis.md`

Settings window maintains local `config` cache for UX reasons (draft/edit before apply). This pattern is actually correct for configuration UI.

**Decision**: Keep current pattern - no migration needed. State Client can read config but writes should remain explicit.

---

## 📋 Task Dependencies

```
State Client Implementation (1)
    ├── Position Update Scaling (2) - depends on State Client for clean implementation
    ├── Replace g.state (3) - blocked by (1)
    ├── broadcastState visibility (4) - optional with (1)
    └── Parameters Window (5) - blocked by (1)

Independent:
    ├── Monitoring Pause Verification (6)
    └── Settings Migration Decision (7) - WON'T DO
```

---

## ⚠️ State Client Usage Reality Check

**State Client is available but NOT widely used.**

See `docs/STATE_CLIENT_AUDIT.md` for full analysis.

### Current Usage

| Window | Uses State Client | Uses Legacy IPC |
|--------|-------------------|-----------------|
| Player | ⚠️ Partial (actions only) | ✅ Yes (most operations) |
| Parameters | ❌ No | ✅ Yes (custom IPC) |
| Settings | ❌ No | ✅ Yes (config IPC) |
| Monitoring | ❌ No | ✅ Yes (custom IPC) |
| Help | ❌ No | ❌ No (static) |
| Mixer | ❌ No | ✅ Yes (custom IPC) |

### State Flow Reality

```
Main Process
    ├──→ broadcastState() → player.js (legacy format)
    ├──→ set-mode → parameters.js (custom IPC)
    └──→ update-params → parameters.js (custom IPC)
```

NOT using State Client delta format universally.

---

## ✅ What Was Actually Completed

| Task | Status | Notes |
|------|--------|-------|
| State Client Module | ✅ Done | `js/state-client.js` created and available |
| Position Update Scaling | ✅ Done | Window hide/minimize triggers 'minimal' mode |
| Visibility-Aware broadcastState | ✅ Already Done | Skips broadcasting when window hidden |
| Monitoring Pause on Hide | ✅ Already Done | 60fps loop stops when monitoring hidden |
| Window Loader Injection | ✅ Already Done | State Client loaded in all child windows |
| Main Process Handlers | ✅ Already Done | `state:requestSync`, `state:setIntent`, `action:dispatch` |

---

## 📋 What Was NOT Completed (By Design)

| Task | Status | Reason |
|------|--------|--------|
| Migrate player.js to State Client | ❌ Not Done | Works with fallback; high risk refactor |
| Migrate parameters.js to State Client | ❌ Not Done | Custom IPC works; would require format changes |
| Migrate other windows | ❌ Not Done | Low benefit |
| Unify state update format | ❌ Not Done | Would require main + all window changes |

---

## Architecture Status

**Hybrid Architecture** (working, but not unified):

1. **State Client exists** and is functional
2. **Legacy IPC still dominates** - all windows use custom patterns
3. **Player has dual support** - uses State Client if available, falls back to IPC
4. **Position optimization works** - major win regardless of state architecture

### Files Created

- `js/state-client.js` - State Client module (available but not universally used)
- `docs/STATE_CLIENT_AUDIT.md` - Usage audit and migration analysis

### Files Modified

- `js/app.js` - Added minimize handler for position scaling

---

## 📚 Reference Documents

| Document | Status | Purpose |
|----------|--------|---------|
| `state-architecture-analysis.md` | Keep | Architecture reference for State Client |
| `state-client-usage.md` | Keep | Target API specification |
| `electron-throttling-guide.md` | Keep | Reference for future optimizations |
| `design-gaps-analysis.md` | ✅ Archived | Original gap analysis |
| `optimization-analysis.md` | ✅ Archived | Background activity analysis (completed) |
| `cpu-optimization-results.md` | ✅ Archived | Results of completed optimizations |
| `electron-cpu-expectations.md` | ✅ Archived | Reference on Electron CPU limits |

---

## 🗑️ Archive Notes

The following documents are now obsolete and can be moved to `docs/_Archive/`:

1. **design-gaps-analysis.md** - Most gaps fixed; remaining tasks captured here
2. **optimization-analysis.md** - Optimizations implemented; see `cpu-optimization-results.md`
3. **cpu-optimization-results.md** - Historical record of completed work
4. **electron-cpu-expectations.md** - Reference material; no actionable tasks
