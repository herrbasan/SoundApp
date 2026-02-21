# SoundApp Background Activity Analysis

## Executive Summary

Even when all windows are closed/hidden and the engine is disposed, SoundApp shows ~0.1-0.2% CPU activity. This is primarily caused by unnecessary IPC communication and polling loops that continue running when the app is idle.

---

## Activity Sources Identified

### 1. State-Debug Window Auto-Refresh (HIGH IMPACT)
**Location:** `js/state-debug/main.js:59`

```javascript
// Auto-refresh every 1 second for real-time debugging
setInterval(requestState, 1000);
```

**Problem:** 
- Continues polling even when state-debug window is hidden/closed
- Each poll sends IPC `state-debug:request` to main process
- Main process queries engine state and responds

**Impact:** ~1 IPC round-trip per second per state-debug window instance

**When Active:** Always when state-debug window is open (regardless of visibility)

---

### 2. Idle Disposal Polling Loop (MEDIUM IMPACT)
**Location:** `js/app.js:1147-1150`

```javascript
idleDisposalState.checkInterval = setInterval(() => {
    checkIdleDisposal();
    broadcastIdleTime();
}, IDLE_CHECK_INTERVAL_MS); // 1000ms
```

**Problem:**
- `broadcastIdleTime()` sends `idle:time` IPC message every second
- Only needed for debug display (shows countdown timer in UI)
- Continues even when engine is disposed and player is hidden

**Impact:** 1 IPC message per second to player window

**When Active:** Always after app startup (loop starts in app initialization)

---

### 3. Engine Monitoring Loop (HIGH IMPACT WHEN ACTIVE)
**Location:** `js/engines.js:3017`

```javascript
g.monitoringLoop = setInterval(updateMonitoring, 1000 / 60); // 60fps
```

**Problem:**
- Runs at 60fps when monitoring window is open
- Analyzes audio and sends VU data via MessagePort
- Continues even when monitoring window is hidden (just not visible)

**Impact:** High CPU in engine process when monitoring is "open" even if hidden

**When Active:** When monitoring window has been opened at least once

---

### 4. State Client Sync (NEW - MEDIUM IMPACT)
**Location:** `js/state-client.js` (initialization)

**Problem:**
- Subscribes to IPC `state:update` events
- Maintains local proxy state that updates on every broadcast
- Subscriptions trigger callbacks even when window is hidden

**Impact:** State update processing in all renderer processes

**When Active:** Always when State Client is loaded (all windows)

---

### 5. Window Focus Polling/Tracking (LOW IMPACT)
**Various locations**

Native event listeners on windows track focus/blur/move/resize. These are OS-level events but can generate activity.

---

## Optimization Recommendations

### Priority 1: State-Debug Window (Highest ROI)

**Option A: Pause when hidden**
```javascript
// In state-debug/main.js
let refreshInterval;
let isVisible = true;

// Listen for visibility changes
bridge.on('window-visible', () => {
    isVisible = true;
    startRefresh();
});

bridge.on('window-hidden', () => {
    isVisible = false;
    stopRefresh();
});

function startRefresh() {
    if (refreshInterval) return;
    refreshInterval = setInterval(requestState, 1000);
}

function stopRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}
```

**Option B: Manual refresh only**
- Remove auto-refresh entirely
- User clicks "Refresh" button when needed
- Better for debugging - no stale data from auto-update

**Recommendation:** Option B - simpler and state-debug is for interactive debugging anyway

---

### Priority 2: Idle Time Broadcasting

**Current:** Always broadcast `idle:time` every second

**Optimized:** Only broadcast when player window is visible
```javascript
function broadcastIdleTime() {
    // Only send if player window is visible
    if (!wins.main?.isVisible() || wins.main?.isMinimized()) {
        return;
    }
    
    const timeout = getIdleTimeoutMs();
    let remaining;
    
    if (audioState.isPlaying) {
        remaining = Math.round(timeout / 1000);
    } else {
        const idleTime = Date.now() - idleDisposalState.lastActivityTime;
        remaining = Math.max(0, Math.round((timeout - idleTime) / 1000));
    }
    
    sendToPlayer('idle:time', { remaining });
}
```

**Alternative:** Only broadcast when debug display is visible (lazy - check if any listener exists)

---

### Priority 3: Stop Idle Loop When Engine Disposed

**Current:** Polling loop continues forever

**Optimized:** Stop loop when engine disposed AND player hidden
```javascript
function checkIdleDisposal() {
    if (!shouldDisposeEngine()) {
        // Check if we should stop the loop entirely
        if (!engineWindow && !isWindowVisible()) {
            stopIdleDisposalLoop();
        }
        return;
    }
    
    console.log('[Idle] Timeout reached, disposing engine...');
    performDisposal();
}
```

**Restart loop on:** Window show, user activity, play button

---

### Priority 4: Monitoring Window - Pause on Hide

**Current:** 60fps loop continues when monitoring hidden

**Optimized:** Pause analysis when monitoring not visible
```javascript
// In engines.js
ipcRenderer.on('window-hidden', (e, data) => {
    if (data.type === 'monitoring') {
        stopMonitoringLoop(); // Clear the 60fps interval
    }
});

ipcRenderer.on('window-visible', (e, data) => {
    if (data.type === 'monitoring') {
        startMonitoringLoop(); // Restart 60fps interval
    }
});
```

---

### Priority 5: State Client - Pause Updates When Hidden

**Concept:** State Client should skip update processing when window is hidden

```javascript
// In state-client.js
let isWindowVisible = true;

// Listen for visibility from main
ipcRenderer.on('window-visibility', (e, visible) => {
    isWindowVisible = visible;
});

_applyDelta(delta) {
    // Skip processing if window hidden
    if (!isWindowVisible) {
        // Still store the delta, just don't process subscriptions
        Object.assign(this._state, delta);
        return;
    }
    
    // Normal processing...
}
```

**Note:** This requires main process to broadcast visibility changes

---

## Implementation Priority

| Priority | Change | Effort | Impact | Notes |
|----------|--------|--------|--------|-------|
| 1 | State-debug manual refresh | Low | High | Remove 1s polling |
| 2 | Skip idle broadcast when hidden | Low | Medium | Add visibility check |
| 3 | Stop idle loop when disposed+hidden | Medium | Medium | Need restart triggers |
| 4 | Monitoring pause on hide | Medium | High | Only when monitoring used |
| 5 | State Client visibility-aware | Medium | Low | Complex, lower benefit |

---

## Expected Results

With all optimizations implemented:
- **0% CPU** when app is hidden to tray with engine disposed
- **No IPC traffic** during idle periods
- **Minimal memory churn** from stopped intervals
- **Instant resume** on window show (all state synced on visibility)

---

## Implementation Notes

### Key Challenge: Restarting Idle Loop
When stopping the idle disposal loop, we need reliable triggers to restart:
- `window.show` event on main window
- `browser-window-focus` app event
- IPC from renderer on user interaction

### Testing Considerations
1. Test tray hide/show cycles
2. Test with monitoring window opened then closed
3. Test state-debug open but minimized
4. Verify engine still disposes correctly when idle
5. Verify engine restores correctly on play/window show

### Backward Compatibility
All changes are internal - no API changes needed
