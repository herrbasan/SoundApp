# State Client Usage Audit - February 21, 2026

## Summary

**State Client is available in all windows** (via `window-loader.js`), but **only player.js uses it** - and even then, only partially. All other windows continue to use legacy IPC patterns.

---

## Context-by-Context Breakdown

### 1. Player Window (`js/player.js`)
**Status**: ⚠️ Partial Migration

**Uses State Client for:**
- ✅ `State.dispatch('toggle')` - play/pause toggle
- ✅ `State.dispatch('next')` - next track
- ✅ `State.dispatch('prev')` - previous track
- ✅ `State.dispatch('seek', { position })` - seeking
- ✅ `State.subscribe()` - subscriptions for playback state

**Still Uses Legacy IPC:**
- ❌ `ipcRenderer.send('audio:play')` - direct play command
- ❌ `ipcRenderer.send('audio:pause')` - direct pause command
- ❌ `ipcRenderer.send('audio:load', ...)` - loading files
- ❌ `ipcRenderer.send('audio:next')` - next track (fallback path)
- ❌ `ipcRenderer.send('audio:prev')` - prev track (fallback path)
- ❌ `ipcRenderer.send('audio:seek', ...)` - seeking (fallback path)
- ❌ `ipcRenderer.send('audio:setParams', ...)` - volume, loop
- ❌ `ipcRenderer.send('audio:shuffle')` - shuffle playlist
- ❌ `ipcRenderer.send('audio:setPlaylist', ...)` - set playlist
- ❌ `ipcRenderer.send('param-change', ...)` - parameter changes
- ❌ `ipcRenderer.on('state:update', ...)` - state updates (legacy format)

**Note**: Player has fallback handling (`if (typeof State !== 'undefined')`) but defaults to legacy IPC.

---

### 2. Parameters Window (`js/parameters/main.js`)
**Status**: ❌ Not Using State Client

**Uses Legacy IPC:**
- Receives: `bridge.on('set-mode', ...)` - mode changes
- Receives: `bridge.on('update-params', ...)` - parameter updates
- Receives: `bridge.on('tracker-vu', ...)` - VU data
- Sends: `bridge.sendToMain('param-change', { mode, param, value })` - all parameter changes

**State Client Available**: Yes (loaded by window-loader.js), but not used.

**Migration Path**:
```javascript
// Current (legacy)
bridge.sendToMain('param-change', { mode: 'audio', param: 'pitch', value: 3 });

// Target (State Client)
await State.set('audio.pitch', 3);
```

---

### 3. Settings Window (`js/settings/main.js`)
**Status**: ❌ Not Using State Client

**Uses Legacy IPC:**
- Receives: Custom config update events
- Sends: `bridge.sendToMain('update-config', ...)` - config changes

**State Client Available**: Yes, but not used.

**Note**: Settings window correctly uses local config cache for UX (draft/edit before apply). Migration not critical.

---

### 4. Monitoring Window (`js/monitoring/main.js`)
**Status**: ❌ Not Using State Client

**Uses Legacy IPC:**
- Receives: `bridge.on('set-monitoring-source', ...)`
- Receives: MessagePort for high-frequency VU data

**State Client Available**: Yes, but not used.

---

### 5. Help Window (`js/help/main.js`)
**Status**: ❌ Not Using State Client

**Uses**: Static content only, minimal IPC.

---

### 6. Mixer Window (`js/mixer/main.js`)
**Status**: ❌ Not Using State Client

**Uses Legacy IPC:**
- Multiple custom IPC channels for multi-track control
- `mixer:play`, `mixer:pause`, `mixer:seek`, etc.

---

### 7. Engine Window (`js/engines.js`)
**Status**: ❌ Not Applicable (sender, not receiver)

**Sends to Main:**
- `audio:position` - position updates
- `audio:state` - playback state
- `audio:metadata` - file metadata
- `audio:loaded` - file loaded signal
- `audio:ended` - playback ended
- etc.

**Note**: Engine is stateless - receives commands from main, doesn't use State Client pattern.

---

## The Gap

### Current State Flow

```
Main Process (app.js)
    ↓ broadcastState()
Player Window (player.js) ← uses state:update IPC (legacy format)
    ↓ manual g.state updates
UI Updates

Main Process (app.js)  
    ↓ custom IPC (set-mode, update-params)
Parameters Window (parameters/main.js) ← uses bridge.on() listeners
    ↓ manual control updates
UI Updates
```

### State Client Flow (What Should Happen)

```
Main Process (app.js)
    ↓ state:update (delta format)
State Client (all windows)
    ↓ _applyDelta() + _notifySubscribers()
Subscribed callbacks
    ↓ UI Updates
```

---

## Problems Identified

### 1. Inconsistent State Updates
- Player uses `state:update` with flat object format
- Parameters uses `set-mode` and `update-params` custom events
- Both receive state differently

### 2. Duplicate State Management
- Player maintains `g.state` cache
- Parameters maintains `controls` cache
- State Client maintains `_state` cache (if used)
- Main maintains `audioState` (ground truth)

### 3. Fragmented Write Patterns
- Player sends `audio:*` events directly
- Parameters sends `param-change` via bridge
- State Client sends `state:setIntent` (if used)

---

## Migration Path to Full State Client Usage

### Phase 1: Unify State Update Format (Main Process)
**File**: `js/app.js`

Current `broadcastState()` sends:
```javascript
{
    isPlaying: true,
    position: 120,
    pitch: 3,
    // ...flat format
}
```

Should send State Client format:
```javascript
{
    'playback.isPlaying': true,
    'playback.position': 120,
    'audio.pitch': 3
}
```

### Phase 2: Update Player Window
**File**: `js/player.js`

Replace:
```javascript
// Legacy state update handler
ipcRenderer.on('state:update', (e, data) => {
    if (data.isPlaying !== undefined) g.state.isPlaying = data.isPlaying;
    // ...20 more lines
});
```

With:
```javascript
// State Client already has subscriptions, remove legacy handler
// Keep State.subscribe() calls that already exist
```

Replace all `ipcRenderer.send('audio:...')` with `State.dispatch()` or `State.set()`.

### Phase 3: Update Parameters Window
**File**: `js/parameters/main.js`

Replace:
```javascript
bridge.on('set-mode', (data) => { ... });
bridge.on('update-params', (data) => { ... });
```

With:
```javascript
State.subscribe('file.type', (fileType) => {
    setMode(fileType.toLowerCase()); // 'audio', 'midi', 'tracker'
});

State.subscribe('audio.*', (value, oldValue, key) => {
    const param = key.split('.')[1];
    updateAudioControl(param, value);
});
```

Replace:
```javascript
bridge.sendToMain('param-change', { mode: 'audio', param: 'pitch', value: 3 });
```

With:
```javascript
await State.set('audio.pitch', 3);
```

### Phase 4: Update Remaining Windows
- Settings: Optional (current pattern is UX-correct)
- Monitoring: Low priority
- Help: Not needed
- Mixer: Separate audio domain, keep custom IPC

---

## Recommendation

**Keep Current Hybrid Approach** for now because:

1. **Player.js has fallback handling** - works with or without State Client
2. **Parameters window works** - custom IPC pattern is functional
3. **Risk of regression** - large refactor for marginal benefit
4. **State Client is ready** - new code can use it, old code continues to work

**Use State Client for:**
- New windows/features
- Gradual migration when touching related code
- Future architecture (if doing major refactor)

**Keep Legacy IPC for:**
- Existing working code
- High-frequency data (monitoring VU meters)
- Complex multi-step operations (mixer)

---

## Quick Win

If you want to improve consistency without full migration:

1. **Ensure all windows receive `state:update`** in State Client format (dotted keys)
2. **Player window** - rely on State Client subscriptions, remove legacy `ipcRenderer.on('state:update')` handler
3. **Parameters window** - add State Client subscriptions alongside existing handlers for gradual transition
