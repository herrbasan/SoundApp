# SoundApp Design Gaps Analysis

## The Core Problem

The codebase has **mechanisms** for efficiency (adaptive position updates, idle disposal, visibility tracking) but they are **not wired together**. This creates a system that *could* be efficient but isn't because the connections are missing.

---

## Gap 1: Position Updates Don't Scale with Visibility

**What Exists:**
- `POSITION_PUSH_INTERVALS` with modes: scrubbing (16ms), normal (50ms), idle (250ms), minimal (1000ms)
- `setPositionPushMode()` function to change modes
- IPC channel `engine:set-position-mode` to receive mode changes

**What's Missing:**
- Main process never sends `engine:set-position-mode` when player window is hidden
- Engine continues 20fps position updates even when no window is visible to receive them

**The Gap:**
```javascript
// In app.js - this code DOES NOT EXIST:
wins.main.on('hide', () => {
    sendToEngine('engine:set-position-mode', { mode: 'minimal' });
});
```

**Impact:** ~20 IPC messages/second when playing and hidden

---

## Gap 2: Idle Loop Runs Forever

**What Exists:**
- `startIdleDisposalLoop()` and `stopIdleDisposalLoop()` functions
- Loop runs every 1000ms to check disposal conditions

**What Was Missing (Fixed in a1f480f):**
- Loop never stopped even when engine disposed and window hidden

**The Fix Applied:**
```javascript
// Now stops loop when fully idle, restarts on activity
if (engineDisposed && windowHidden && !isPlaying) {
    stopIdleDisposalLoop();
}
```

---

## Gap 3: State-Debug Polling

**What Exists:**
- Manual "Refresh" button in state-debug UI
- IPC handler `state-debug:request` for on-demand queries

**What Was Missing (Fixed in a1f480f):**
- Auto-refresh every 1 second regardless of need

**The Fix Applied:**
- Removed `setInterval(requestState, 1000)`
- User now clicks Refresh button

---

## Gap 4: Idle Time Broadcasts

**What Exists:**
- `broadcastIdleTime()` sends countdown to player
- Only used for debug display

**What Was Missing (Fixed in a1f480f):**
- Continued broadcasting when player window hidden

**The Fix Applied:**
```javascript
if (!wins.main?.isVisible() || wins.main?.isMinimized()) {
    return;
}
```

---

## Gap 5: Monitoring Loop 60fps

**What Exists:**
- `startMonitoringLoop()` / `stopMonitoringLoop()` functions
- Runs at 60fps when monitoring window is visible
- Stops when monitoring window is hidden

**Status:** ✅ **CORRECTLY IMPLEMENTED**

This is the exception - it actually works as designed.

---

## Gap 6: broadcastState Sends to All Windows

**What Exists:**
- `broadcastState()` sends full state to player
- Has `hasStateChanged()` check to skip duplicates

**What's Missing:**
- Doesn't check if player window is visible before sending
- Child windows (parameters, monitoring) get their own targeted updates

**The Gap:**
```javascript
// In broadcastState() - no visibility check:
sendToPlayer('state:update', stateUpdate);
// ^ Always sends even if window hidden
```

**Impact:** State updates on every play/pause/seek even when hidden

---

## Gap 7: State Client Subscriptions

**What Exists:**
- State Client with `subscribe()` for reactive updates
- `_applyDelta()` processes all updates

**What's Missing:**
- No visibility awareness - subscriptions fire even when window hidden
- No "pause updates" mechanism for background windows

**The Gap:**
```javascript
// State Client always processes updates:
_applyDelta(delta) {
    // No visibility check
    for (const [key, value] of Object.entries(delta)) {
        this._setPath(this._state, key, value);
        this._notifySubscribers(key, value, oldValue);
    }
}
```

---

## Root Cause Analysis

### Why Do These Gaps Exist?

1. **Feature-First Development**: Priority was "make it work" not "make it efficient"
2. **No Visibility Testing**: Testing focused on visible window scenarios
3. **Assumed Low Cost**: "IPC is cheap, timers are cheap" - until they add up
4. **Missing Architecture Review**: No systematic review of background behavior

### What Should Have Been The Design?

```
┌─────────────────────────────────────────────────────────────┐
│                    VISIBILITY-AWARE SYSTEM                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Main Window Hidden:                                         │
│    ↳ Position updates → minimal (1s interval)                │
│    ↳ State broadcasts → batched/queued                       │
│    ↳ Idle loop → stopped (restarts on show)                  │
│    ↳ Idle time → not broadcast                               │
│                                                               │
│  Engine Disposed:                                            │
│    ↳ No position updates (no engine)                         │
│    ↳ Idle loop → stopped                                     │
│    ↳ All child windows → closed                              │
│                                                               │
│  Window Show/Restore:                                        │
│    ↳ Request full state sync                                 │
│    ↳ Resume normal update frequency                          │
│    ↳ Restart idle loop                                       │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Recommended Design Principles

### 1. Visibility-Aware Broadcasting
Every broadcast should consider visibility:
```javascript
function broadcast(channel, data) {
    if (!isTargetVisible(channel)) {
        queueForLater(channel, data); // Or skip entirely
        return;
    }
    send(channel, data);
}
```

### 2. Adaptive Intervals
All intervals should adapt to activity:
```javascript
const intervals = {
    active: 50,      // Window visible and interacting
    background: 250, // Window visible but not focused
    hidden: 1000,    // Window hidden
    idle: null       // Stop entirely
};
```

### 3. Explicit State Sync on Show
When window shows, explicitly request state rather than relying on broadcasts:
```javascript
window.on('show', () => {
    requestFullStateSync();
    resumeNormalOperations();
});
```

### 4. No Polling Without Purpose
Every `setInterval` must have:
- Clear purpose that requires periodic execution
- Stopping condition (when is it no longer needed?)
- Adaptive frequency (can it run less often?)

---

## Remaining Gaps to Fix

| Gap | File | Effort | Impact |
|-----|------|--------|--------|
| Position updates don't scale | app.js + engines.js | Low | High |
| broadcastState sends when hidden | app.js | Low | Medium |
| State Client processes when hidden | state-client.js | Medium | Low |

---

## Conclusion

The codebase has the *pieces* for an efficient system but lacks the *connections*. Each gap represents a missing wire between two existing components. The fixes are straightforward - the hard part was identifying that the gaps exist in the first place.

A systematic review of all IPC communication against visibility states would eliminate most background activity.
