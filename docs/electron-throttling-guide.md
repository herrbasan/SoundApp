# Electron Background Throttling Guide

## Overview

Electron provides several mechanisms to throttle background processes, but they are **scattered across different APIs** and **poorly documented** in context of aggressive power saving. This guide collects all available throttling options.

---

## 1. `webContents.setBackgroundThrottling(allowed)`

The primary API for controlling background throttling.

### What It Does
- When `allowed = true` (default): Throttles animations and timers when page is backgrounded
- When `allowed = false`: No throttling, full performance even when hidden

### How It Works
- Throttles `requestAnimationFrame` to 1fps when backgrounded
- Throttles `setTimeout`/`setInterval` to 1Hz minimum when backgrounded
- Affects Page Visibility API behavior

### Usage
```javascript
// Enable aggressive throttling (default behavior)
win.webContents.setBackgroundThrottling(true);

// Disable throttling (for audio engines, etc.)
win.webContents.setBackgroundThrottling(false);
```

### Dynamic Toggle Example
```javascript
// Throttle when going to tray
win.on('hide', () => {
    win.webContents.setBackgroundThrottling(true);
});

// Unthrottle when showing
win.on('show', () => {
    win.webContents.setBackgroundThrottling(false);
});
```

---

## 2. `backgroundThrottling` WebPreference

Static configuration when creating BrowserWindow.

```javascript
const win = new BrowserWindow({
    webPreferences: {
        // Default: true (throttle when backgrounded)
        backgroundThrottling: true,
        
        // Disable for critical windows (audio engines)
        backgroundThrottling: false
    }
});
```

**Note:** This is the initial value. Use `setBackgroundThrottling()` to change dynamically.

---

## 3. `webContents.setFrameRate(fps)`

Limits the renderer frame rate, reducing compositor workload.

```javascript
// Normal playback: 60fps
win.webContents.setFrameRate(60);

// Idle/hidden: 1fps
win.webContents.setFrameRate(1);

// Completely pause rendering: 0fps (may cause issues)
win.webContents.setFrameRate(0);
```

### Usage with Visibility
```javascript
win.on('hide', () => {
    win.webContents.setFrameRate(1);  // Minimal rendering
});

win.on('show', () => {
    win.webContents.setFrameRate(60); // Normal rendering
});
```

---

## 4. `win.setContentProtection(enable)`

Prevents screen capture and may reduce GPU workload on some systems.

```javascript
// Enable when hidden (privacy + potential GPU savings)
win.on('hide', () => {
    win.setContentProtection(true);
});

win.on('show', () => {
    win.setContentProtection(false);
});
```

---

## 5. Chromium Command Line Flags

Global flags that affect all renderer processes.

```javascript
const { app } = require('electron');

// Before app ready
app.commandLine.appendSwitch('disable-background-timer-throttling', 'false');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'false');
app.commandLine.appendSwitch('enable-aggressive-domstorage-flushing');
```

### Useful Flags for Throttling
| Flag | Effect |
|------|--------|
| `--disable-background-timer-throttling` | Disable timer throttling (set to 'false' to enable throttling) |
| `--disable-backgrounding-occluded-windows` | Disable backgrounding occluded windows |
| `--enable-aggressive-domstorage-flushing` | Aggressive DOM storage flushing |
| `--disable-renderer-backgrounding` | Disable renderer backgrounding |
| `--max-gum-fps` | Limit getUserMedia FPS |
| `--disable-gpu-vsync` | Disable GPU vsync (may reduce GPU wakeups) |

---

## 6. `powerSaveBlocker`

Not directly for throttling, but related to power management.

```javascript
const { powerSaveBlocker } = require('electron');

// Prevent throttling when playing audio
const id = powerSaveBlocker.start('prevent-app-suspension');

// Allow throttling when idle
powerSaveBlocker.stop(id);
```

**Modes:**
- `'prevent-app-suspension'`: Prevent app suspension, still allows screen off
- `'prevent-display-sleep'`: Keep display awake (higher power usage)

---

## 7. Process Priority (Advanced)

Lower process priority when backgrounded.

```javascript
const { exec } = require('child_process');
const os = require('os');

function setIdlePriority(pid) {
    if (process.platform === 'win32') {
        // IDLE_PRIORITY_CLASS = 64
        exec(`wmic process where "ProcessId=${pid}" CALL SetPriority 64`);
    } else if (process.platform === 'darwin') {
        exec(`renice +10 -p ${pid}`);
    } else {
        exec(`renice +10 -p ${pid}`);
    }
}

function setNormalPriority(pid) {
    if (process.platform === 'win32') {
        // NORMAL_PRIORITY_CLASS = 32
        exec(`wmic process where "ProcessId=${pid}" CALL SetPriority 32`);
    } else {
        exec(`renice 0 -p ${pid}`);
    }
}

// Usage
win.on('hide', () => {
    setIdlePriority(win.webContents.getOSProcessId());
});

win.on('show', () => {
    setNormalPriority(win.webContents.getOSProcessId());
});
```

---

## 8. Suspend/Resume WebContents (Experimental)

Not officially documented, but `webContents` can be suspended:

```javascript
// Suspend all activity (experimental)
win.webContents.debugger.attach('1.3');
win.webContents.debugger.sendCommand('Page.setLifecycleEventsEnabled', { enabled: true });
win.webContents.debugger.sendCommand('Page.setAdBlockingEnabled', { enabled: true });

// This is NOT recommended for production - use setBackgroundThrottling instead
```

---

## Complete Implementation Example

```javascript
const { BrowserWindow } = require('electron');

function createWindow() {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            // Start with normal throttling behavior
            backgroundThrottling: true
        }
    });
    
    // Load your app
    win.loadFile('index.html');
    
    // Aggressive throttling when hidden
    win.on('hide', () => {
        console.log('Window hidden - enabling aggressive throttling');
        
        // Enable background throttling (timers to 1Hz)
        win.webContents.setBackgroundThrottling(true);
        
        // Reduce frame rate to 1fps
        win.webContents.setFrameRate(1);
        
        // Content protection (optional)
        win.setContentProtection(true);
    });
    
    // Full performance when visible
    win.on('show', () => {
        console.log('Window shown - disabling throttling');
        
        // Disable throttling
        win.webContents.setBackgroundThrottling(false);
        
        // Restore frame rate
        win.webContents.setFrameRate(60);
        
        // Remove content protection
        win.setContentProtection(false);
    });
    
    return win;
}
```

---

## Measuring Throttling Effectiveness

### 1. Process Monitor
```powershell
# Windows: Monitor CPU cycles
Get-Process | Where-Object {$_.ProcessName -like "*electron*"} | 
    Select-Object Name, CPU, Id
```

### 2. Electron DevTools
```javascript
// In renderer console, check if throttling is active
console.log('Background throttled:', document.hidden);
console.log('Visibility state:', document.visibilityState);

// Check RAF timing
let lastTime = performance.now();
function checkRAF() {
    const now = performance.now();
    const delta = now - lastTime;
    console.log('RAF interval:', delta.toFixed(2), 'ms');
    lastTime = now;
    requestAnimationFrame(checkRAF);
}
requestAnimationFrame(checkRAF);
// Normal: ~16ms (60fps)
// Throttled: ~1000ms (1fps)
```

### 3. Timer Throttling Test
```javascript
// Check if timers are throttled
let lastTime = Date.now();
setInterval(() => {
    const now = Date.now();
    const delta = now - lastTime;
    console.log('Timer interval:', delta, 'ms');
    lastTime = now;
}, 100); // 100ms requested

// Normal: ~100ms intervals
// Throttled: ~1000ms intervals (minimum when backgrounded)
```

---

## Limitations & Gotchas

### 1. Audio Playback
Throttling affects `setInterval` precision which can affect audio scheduling:
```javascript
// BAD: setInterval for audio
setInterval(() => playAudio(), 10);

// GOOD: AudioWorklet or Web Audio API scheduling
// These run on separate threads, not affected by throttling
```

### 2. Web Workers
Web Workers in background windows ARE throttled too.

### 3. Main Process
Throttling only affects renderer processes. Main process needs manual timer management.

### 4. GPU Process
`setBackgroundThrottling` doesn't directly reduce GPU process activity. Use `setFrameRate(1)` to minimize GPU work.

---

## Summary Table

| Method | Affected | Impact | Dynamic |
|--------|----------|--------|---------|
| `setBackgroundThrottling(true)` | Timers, RAF | High | ✅ Yes |
| `setFrameRate(1)` | Compositor | Medium | ✅ Yes |
| `setContentProtection(true)` | GPU (maybe) | Low | ✅ Yes |
| Command line flags | All renderers | High | ❌ No |
| Process priority | Entire process | Medium | ✅ Yes |
| `powerSaveBlocker` | OS sleep | Low | ✅ Yes |

---

## SoundApp Recommendations

For maximum idle efficiency:

1. **Player Window (when hidden to tray):**
   ```javascript
   win.webContents.setBackgroundThrottling(true);
   win.webContents.setFrameRate(1);
   ```

2. **Engine Window (keep audio running):**
   ```javascript
   // Never throttle - audio needs precise timers
   win.webContents.setBackgroundThrottling(false);
   ```

3. **Child Windows (parameters, monitoring, etc.):**
   ```javascript
   // Always throttle when hidden
   win.webContents.setBackgroundThrottling(true);
   win.webContents.setFrameRate(1);
   ```

4. **When Engine Disposed (0% audio need):**
   ```javascript
   // Aggressive throttling on all windows
   BrowserWindow.getAllWindows().forEach(win => {
       win.webContents.setBackgroundThrottling(true);
       win.webContents.setFrameRate(1);
   });
   ```
