# Idle Engine Disposal Implementation

> **Status:** ✅ **Fully Working** | Parameter preservation, child window routing fixed

## Overview

This implementation adds **two-tier idle disposal** to dynamically manage CPU usage:

1. **Aggressive disposal** (5 seconds): When window is hidden to tray + paused
2. **Conservative disposal** (10 seconds): When window is visible but paused (no user activity)

## How It Works

### Disposal Triggers

| Condition | Timeout | Reason |
|-----------|---------|--------|
| Hidden to tray + paused | 5s | User explicitly hid the window |
| Visible but idle + paused | 10s | User paused and walked away |
| Playing | Never | Audio must continue |

### Restoration Triggers

Any user interaction restores the engine automatically:

- **Play button**: Restores → Plays
- **Seek**: Restores → Seeks to position  
- **Next/Prev**: Restores → Changes track → Plays
- **Window show/restore**: Restores (if was disposed)
- **Window focus**: Resets idle timer

### State Preservation

When the engine is disposed:
- `audioState` in `app.js` preserves: file, position, params, playlist
- UI stays responsive (just no position updates)
- On restoration: engine recreates → loads file → seeks to position → ready

## Implementation Details

### Timeout Configuration

```javascript
const IDLE_DISPOSE_TIMEOUT_MS = 5000;         // Hidden to tray
const IDLE_DISPOSE_VISIBLE_TIMEOUT_MS = 10000; // Visible but idle
```

Located in `js/app.js` lines ~631-632.

### Idle State Tracking

```javascript
let idleState = {
    lastActivityTime: Date.now(),
    visibleDisposeTimeout: null
};
```

## Features Working ✅

| Feature | Status | Notes |
|---------|--------|-------|
| Idle detection | ✅ | 10s visible, 5s hidden |
| Engine disposal | ✅ | Window destroyed, CPU → 0% |
| Engine restoration | ✅ | <300ms restore time |
| Position preservation | ✅ | Resumes from exact position |
| Waveform caching | ✅ | No re-extraction on restore |
| Monitoring window | ✅ | Reconnects after restore |
| Child window tracking | ✅ | Windows re-registered with engine |
| State preservation | ✅ | Fixed - params properly restored after engine recreate |
| Child window routing | ✅ | stageId updated after engine recreate |

## State Preservation (WORKING ✅)

> **Status:** ✅ **Fixed** - Parameters properly restored after engine restoration

### The Architecture Problem

The app has **3 audio engines** with different parameter systems, displayed in a single Parameters window that adapts its UI via "tabs":

| Engine | Parameters | Storage Location | Pipeline |
|--------|-----------|------------------|----------|
| **Audio (FFmpeg)** | mode, tapeSpeed, pitch, tempo, formant, locked | `g.audioParams` (engine) + `audioState` (main) | Dual: Normal (48-192kHz) vs Rubberband (fixed 48kHz) |
| **MIDI** | transpose, bpm, metronome, soundfont | `g.midiSettings` (engine) + `audioState.midiParams` (main) | Normal only |
| **Tracker** | pitch, tempo, stereoSeparation | `g.trackerParams` (engine) + `audioState.trackerParams` (main) | Normal only |

### The Audio Pipeline Complexity

The Audio engine has a **special dual-pipeline architecture**:

```
Normal Pipeline (48-192kHz, matches HQ setting)
├── Tape Mode: tapeSpeed applied via setPlaybackRate()
└── Used for: Standard playback, MIDI, Tracker

Rubberband Pipeline (fixed 48kHz, ignores HQ setting)
├── Pitch/Time Mode: pitch, tempo, formant applied via WASM worklet
└── Used for: Pitch manipulation (higher CPU/memory cost)
```

**Key insight:** Rubberband ALWAYS runs at 48kHz regardless of HQ mode. The HQ setting (48kHz vs max sample rate) only affects the normal pipeline.

### Where State Lives

**Main Process (`app.js`):**
- `audioState` - Ground truth that outlives engine
- `audioState.midiParams` - MIDI settings preserved across restore
- `audioState.trackerParams` - Tracker settings preserved across restore

**Engine Process (`engines.js`):**
- `g.audioParams` - Audio parameters (mode, tapeSpeed, pitch, tempo, formant, locked)
- `g.midiSettings` - MIDI runtime settings (pitch, speed, metronome)
- `g.trackerParams` - Tracker runtime settings (pitch, tempo, stereoSeparation)

**Parameters Window (`parameters/main.js`):**
- UI state only - receives `set-mode` and `update-params` events
- Sends `param-change` events back to engine via `bridge.sendToStage()`

### The Restoration Flow (Working Implementation)

```
restoreEngineIfNeeded()
├── 1. createEngineWindow({ skipAutoLoad: true })
├── 2. sendToEngine('cmd:setParams', audioState)     // Pre-set g.audioParams globals
├── 3. Re-register child windows + update stageId    // Fix routing
├── 4. sendToEngine('cmd:load', { ... })             // Load file, init players
├── 5. ← Wait for 'audio:loaded' signal              // Players now exist
├── 6. sendToEngine('cmd:applyParams', ...)          // Apply to active players
└── 7. sendParamsToParametersWindow()                // Update UI
```

**Key insight:** Step 5 (waiting for `audio:loaded`) ensures players exist before `cmd:applyParams` is sent. This eliminates the race condition where params were sent to non-existent players.

### Problems Solved

The following issues were fixed by the deferred param application pattern:

| Issue | Root Cause | Solution |
|-------|------------|----------|
| **Race Condition on File Load** | MIDI/Tracker players initialize AFTER file load, but params were sent before | Wait for `audio:loaded` signal before sending `cmd:applyParams` |
| **Pipeline Switch Timing** | Rubberband lazy-initialization happened after file load | Pre-set `g.activePipeline` via `cmd:setParams` before load |
| **Parameter Reset on New File** | `playAudio()` reset params even with `restore: true` | `cmd:applyParams` applies params after players exist, overriding defaults |
| **Child Window Routing** | Parameters window had cached `stageId` from destroyed window | Send `update-stage-id` IPC to child windows after engine recreation |
| **UI State Desync** | `set-mode` event arrived after `sendParamsToParametersWindow()` | `cmd:applyParams` handles all param application, UI updated last |
| **Parameters Tab Stuck on Audio** | `audio:loaded` event didn't include `fileType`, so `audioState.fileType` was never set | Include `fileType` in `audio:loaded` event from engine |
| **Double Press Required After Restore** | Hidden child windows didn't receive `update-stage-id` after engine restoration | Send `update-stage-id` to ALL existing child windows, not just visible ones |

### Solution

The fix uses a **deferred param application** pattern:

1. **Pre-set globals before load** — `cmd:setParams` sets `g.audioParams` before `cmd:load`
2. **Wait for file load** — `restoreEngineIfNeeded()` waits for `audio:loaded` signal before proceeding
3. **Apply params after players exist** — `cmd:applyParams` is sent after file is loaded, when players are initialized
4. **Update UI last** — Parameters window UI is updated via `sendParamsToParametersWindow()` after all params applied

This ensures players exist when params are applied, eliminating race conditions.

### Implementation Details

**Key changes in `restoreEngineIfNeeded()` (app.js):**

```javascript
// Wait for file to load before applying params
const fileLoadedPromise = new Promise((resolve) => {
    const onLoaded = (e, data) => {
        if (data.file === audioState.file) {
            ipcMain.removeListener('audio:loaded', onLoaded);
            resolve(data);
        }
    };
    ipcMain.once('audio:loaded', onLoaded);
});

sendToEngine('cmd:load', { file: audioState.file, ... });
await fileLoadedPromise;  // Players now exist

// Now safe to apply params
sendToEngine('cmd:applyParams', { ... });
```

**Key changes in `playAudio()` (engines.js):**

```javascript
// Signal when file is loaded (players initialized)
ipcRenderer.send('audio:loaded', { file: data.file, ... });
```

**New `cmd:applyParams` handler (engines.js):**

```javascript
ipcRenderer.on('cmd:applyParams', (e, data) => {
    // Apply to active players (they exist now)
    if (g.currentAudio?.isFFmpeg) { ... }
    else if (g.currentAudio?.isMidi && midi) { ... }
    else if (g.currentAudio?.isMod && player) { ... }
});
```

**Bug Fix: `fileType` in `audio:loaded` event (engines.js):**

The `audio:loaded` event must include `fileType` so `app.js` can correctly set `audioState.fileType`, which is used by `sendParamsToParametersWindow()` to determine which tab to show:

```javascript
// Determine fileType for the loaded file
const ext = path.extname(data.file).toLowerCase();
const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
const isTracker = g.supportedMpt && g.supportedMpt.includes(ext);
const fileType = isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg';
ipcRenderer.send('audio:loaded', { 
    file: data.file, 
    duration: g.currentAudio?.duration || 0,
    fileType: fileType  // ← Required for parameters window tab switching
});
```

**Bug Fix: Hidden window `update-stage-id` (app.js):**

When the engine is restored, `update-stage-id` must be sent to ALL child windows that exist, not just visible ones. Hidden windows have `childWindows[type].open = false` but still need the new engine ID:

```javascript
// In restoreEngineIfNeeded() (app.js):
for (const [type, state] of Object.entries(childWindows)) {
    if (state.windowId) {
        // Update ALL child windows that exist (including hidden)
        const childWin = BrowserWindow.fromId(state.windowId);
        if (childWin && !childWin.isDestroyed()) {
            childWin.webContents.send('update-stage-id', { stageId: newEngineId });
        }
        
        // Only register visible windows with the engine
        if (state.open) {
            sendToEngine('window-created', { type, windowId: state.windowId });
            sendToEngine('window-visible', { type, windowId: state.windowId });
        }
    }
}
```

## Testing

### Debug Commands (DevTools Console)

```javascript
// Check current idle status
debugIdle.status()
// Returns: { engineAlive, isPlaying, idleTimeSec, shouldDispose, waveformCacheSize }

// Force immediate disposal
debugIdle.forceDispose()

// Reset idle timer manually
debugIdle.resetTimer()

// Legacy engine commands
debugEngine.close()   // Force close engine
debugEngine.open()    // Reopen engine
```

### Manual Test Procedure

#### Test 1: Visible Idle Disposal

1. Play an audio file
2. Pause playback
3. Leave window visible, don't interact
4. Wait 10 seconds
5. Check Task Manager - CPU should drop to ~0%
6. Click Play - Engine restores, resumes from paused position

#### Test 2: Hidden Tray Disposal

1. Enable "Keep running in tray" in settings
2. Play an audio file
3. Pause playback
4. Close window to tray
5. Wait 5 seconds
6. Check Task Manager - CPU should drop to ~0%
7. Click tray icon - Engine restores

#### Test 3: Waveform Cache

1. Open monitoring window
2. Load a file (waveform extracts)
3. Let engine dispose
4. Click play to restore
5. Monitoring window should show cached waveform instantly

#### Test 4: Parameters Window Tab Switching After Restore

1. Open parameters window
2. Load a MIDI file - verify parameters window shows MIDI tab
3. Pause playback, let engine dispose (10s visible idle or 5s tray)
4. Click play to restore engine
5. **Bug check:** Parameters window should still show MIDI tab (not stuck on Audio)
6. Repeat with Tracker file (.mod, .xm, etc.) - should show Tracker tab after restore

#### Test 5: Parameters Window Opens on First Press After Restore

1. Open parameters window (press 'P')
2. Close parameters window (press 'P' again or click X)
3. Play a file, pause, let engine dispose (10s visible idle)
4. Click play to restore engine
5. **Bug check:** Press 'P' once - parameters window should open immediately
6. Close parameters window
7. Press 'P' again - should open again (no double-press required)

### Expected CPU Usage

| State | Expected CPU |
|-------|-------------|
| Playing (engine alive) | 0.3-1.1% |
| Paused, engine alive | 0.3-0.5% |
| Engine disposed | ~0% (+ GC spikes) |
| During restore | Brief spike, then normal |

## Architecture

### Idle Detection Flow

```
User pauses / hides window
        │
        ▼
┌──────────────────┐
│ scheduleEngine   │──► Sets timeout (5s or 10s)
│ Disposal()       │
└──────────────────┘
        │
        ▼ (timeout reached)
┌──────────────────┐
│ shouldDispose()  │──► Checks: !isPlaying && (hidden || idle)
└──────────────────┘
        │ Yes
        ▼
┌──────────────────┐
│ disposeEngine    │──► window.destroy(), CPU → 0%
│ Window()         │
└──────────────────┘
```

**Note on Concurrent Disposal:** Two disposal timers exist (`scheduleEngineDisposal` and `scheduleVisibleIdleDisposal`). When the window is visible and paused, both schedule for 10s. A guard flag (`isDisposing`) prevents duplicate disposal execution when both timers fire simultaneously.

### Restoration Flow

```
User clicks play
        │
        ▼
┌──────────────────┐
│ restoreEngine    │──► Create window (skipAutoLoad), wait for ready
│ IfNeeded()       │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ cmd:setParams    │──► Pre-set audio params (mode, pitch, tempo, etc.)
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Re-register      │──► childWindows → engine, update stageId
│ windows          │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ cmd:load         │──► Load file with restore=true (uses pre-set params)
│ (restore: true)  │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ param-change     │──► Apply MIDI/Tracker format-specific params
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ sendParamsTo     │──► Update parameters window UI
│ ParametersWindow │
└──────────────────┘
```

## File Structure

| File | Role | Status |
|------|------|--------|
| `js/app.js` | Main process, state machine, idle logic | ✅ Working |
| `js/engines.js` | Audio engine, player management | ✅ Working |
| `js/player.js` | UI, user input | ✅ Working |
| `js/parameters/main.js` | Parameters UI | ✅ Working |

## Waveform Caching

Waveform data is cached in the main process to avoid re-extraction:

- **Location**: `waveformCache` Map in `js/app.js`
- **Survives**: Engine disposal/recreation
- **Max Size**: 10 entries (LRU eviction)
- **Key**: Full file path

### IPC Methods

```javascript
// Get cached waveform
const cached = await ipcRenderer.invoke('waveform:get', filePath);

// Store waveform
ipcRenderer.send('waveform:set', { filePath, peaksL, peaksR, points, duration });
```

## Future Work

### Optional Enhancements

1. Configurable idle timeouts via settings UI
2. Visual indicator when engine is disposed
3. Predictive restoration (hover over play button)
4. Smart idle detection (audio fade-out detection)

### Lazy Engine Initialization (Future Optimization)

> **Status:** 💡 **Design Idea** - Not yet implemented

#### Problem

Currently, all three engines (FFmpeg, MIDI, Tracker) are initialized at startup:
- FFmpeg player: ~5MB memory
- Rubberband pipeline: ~70MB memory (WASM heap)
- MIDI player: ~10MB + soundfont
- Tracker player: ~5MB

**Total:** ~90MB+ baseline memory even before playing any file.

#### Proposed Solution

Lazy initialization: Only initialize the engine that's actually needed for the current file type.

##### Two Operating Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Normal** | Keep current engine, lazy-init new engines on file type change | Standard usage |
| **Resource Saving** | Full reset + init only needed engine on EVERY file change | Low-memory systems |

##### Engine Type Detection

```javascript
const ENGINE_TYPES = {
    FFMPEG: 'ffmpeg',    // Normal audio files (mp3, flac, etc.)
    MIDI: 'midi',        // MIDI files (.mid, .kar, .rmi)
    TRACKER: 'tracker'   // Module files (.mod, .xm, .it, etc.)
};

function getEngineType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (supportedMIDI.includes(ext)) return ENGINE_TYPES.MIDI;
    if (supportedMpt.includes(ext)) return ENGINE_TYPES.TRACKER;
    return ENGINE_TYPES.FFMPEG;
}
```

##### Normal Mode Flow

```
User opens file
        │
        ▼
┌──────────────────┐
│ Detect engine    │──► Determine required engine type
│ type needed      │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Is required      │──► No ──► Load file immediately
│ engine active?   │
└──────────────────┘
        │ Yes
        ▼
┌──────────────────┐
│ Initialize new   │──► Lazy-init only the needed engine
│ engine only      │    (keep existing engines running)
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Load file        │
└──────────────────┘
```

**Example Normal Mode Sequence:**

| Action | Engines Active | Memory |
|--------|---------------|--------|
| App starts | None (waiting) | ~10MB |
| Play audio.mp3 | FFmpeg only | ~15MB |
| Play tracker.mod | FFmpeg + Tracker | ~20MB |
| Play audio2.mp3 | FFmpeg + Tracker | ~20MB (no change) |
| Play midi.mid | FFmpeg + Tracker + MIDI | ~30MB |

##### Resource Saving Mode Flow

```
User opens file
        │
        ▼
┌──────────────────┐
│ Detect engine    │──► Determine required engine type
│ type needed      │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Is this engine   │──► Yes ──► Load file (no reset needed)
│ already active?  │
└──────────────────┘
        │ No
        ▼
┌──────────────────┐
│ Close engine     │──► Destroy ALL engines (full reset)
│ window           │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Re-create window │──► Initialize ONLY the needed engine
│ with single      │
│ engine           │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Load file        │
└──────────────────┘
```

**Example Resource Saving Mode Sequence:**

| Action | Engines Active | Memory | Reset? |
|--------|---------------|--------|--------|
| App starts | None (waiting) | ~10MB | - |
| Play audio.mp3 | FFmpeg only | ~15MB | No |
| Play tracker.mod | Tracker only | ~15MB | **Yes** (FFmpeg closed) |
| Play tracker2.xm | Tracker only | ~15MB | No (same engine) |
| Play midi.mid | MIDI only | ~20MB | **Yes** (Tracker closed) |
| Play audio.mp3 | FFmpeg only | ~15MB | **Yes** (MIDI closed) |

#### Implementation Details

##### 1. Engine State Tracking

```javascript
// In app.js - track which engines are initialized
const engineState = {
    // ... existing fields ...
    
    // Engine initialization state
    initializedEngines: {
        ffmpeg: false,
        midi: false,
        tracker: false
    },
    
    // Current active engine type
    activeEngineType: null,  // 'ffmpeg' | 'midi' | 'tracker'
    
    // Operating mode
    lazyMode: 'normal',  // 'normal' | 'resource-saving'
};
```

##### 2. Engine-Specific Init Functions

Split the monolithic `init()` in `engines.js` into separate functions:

```javascript
// engines.js - modular initialization

async function initFFmpegEngine() {
    if (g.initializedEngines.ffmpeg) return;
    
    g.FFmpegDecoder = require(g.ffmpeg_napi_path);
    const { FFmpegStreamPlayerSAB } = require(g.ffmpeg_player_path);
    FFmpegStreamPlayerSAB.setDecoder(g.FFmpegDecoder);
    
    g.ffmpegPlayer = new FFmpegStreamPlayerSAB(...);
    await g.ffmpegPlayer.init();
    
    g.initializedEngines.ffmpeg = true;
}

async function initMidiEngine() {
    if (g.initializedEngines.midi) return;
    
    // MIDI player initialization
    midi = new MidiPlayer(...);
    await midi.init();
    
    g.initializedEngines.midi = true;
}

async function initTrackerEngine() {
    if (g.initializedEngines.tracker) return;
    
    // Tracker player initialization
    player = new ChiptunePlayer(...);
    await player.init();
    
    g.initializedEngines.tracker = true;
}
```

##### 3. Modified Engine Window Creation

```javascript
// app.js - create engine window with specific engine(s)

async function createEngineWindow(options = {}) {
    // options.engines = ['ffmpeg'] | ['midi'] | ['tracker'] | ['ffmpeg', 'midi', ...]
    
    const enginesToInit = options.engines || ['ffmpeg'];  // Default to ffmpeg
    
    // Pass engines list to renderer via global or IPC
    await helper.global.set('engines_to_init', enginesToInit);
    
    // ... create window ...
}
```

##### 4. File Load Handler

```javascript
// app.js - handle file type changes

async function handleFileChange(filePath) {
    const requiredEngine = getEngineType(filePath);
    
    // Check if we need to reset
    const needsReset = engineState.lazyMode === 'resource-saving' && 
                       engineState.activeEngineType !== null &&
                       engineState.activeEngineType !== requiredEngine;
    
    if (needsReset) {
        // Resource saving mode: close everything, start fresh
        await disposeEngineWindow();
        await createEngineWindow({ engines: [requiredEngine] });
    } else if (!engineState.initializedEngines[requiredEngine]) {
        // Normal mode: lazy-init the new engine
        sendToEngine('init-engine', { engine: requiredEngine });
    }
    
    engineState.activeEngineType = requiredEngine;
    
    // Continue with file load...
    sendToEngine('cmd:load', { file: filePath });
}
```

#### Benefits

| Mode | Memory Savings | Use Case |
|------|---------------|----------|
| Normal | 50-70% | Users who mostly play one file type |
| Resource Saving | 70-85% | Low-memory systems, embedded devices |

#### Challenges

1. **State Preservation**: The existing state preservation issues become even more critical when engines are frequently reset
2. **Switching Delay**: File type changes incur ~100-300ms init delay for new engine
3. **Rubberband Complexity**: Rubberband is an FFmpeg add-on - needs special handling for pipeline switching
4. **Settings Window**: Settings may need engines to be initialized to apply configuration

#### Migration Path

1. **Phase 1**: Modularize engine initialization (split `init()` into separate functions)
2. **Phase 2**: Add engine state tracking to main process
3. **Phase 3**: Implement lazy init for new engines in normal mode
4. **Phase 4**: Add resource-saving mode with full reset behavior
5. **Phase 5**: Add UI toggle in settings window

## Session History

| Date | Changes |
|------|---------|
| Initial | Basic idle disposal, 5s tray / 10s visible |
| +1 | Optimistic seek UI, DevTools disabled |
| +2 | Waveform caching |
| +3 | Child window tracking (monitoring, params) |
| +4 | Parameter preservation (race condition fixes) |
| Current | **Idle disposal fully working** - State preservation fixed via deferred param application |
| +5 | Added `isDisposing` guard to prevent duplicate disposal when both timers fire simultaneously |
| +6 | **MessagePort implementation** - Direct renderer-to-renderer communication for high-frequency data (VU meters, waveforms) |

---

**Note:** The idle disposal feature is fully working, including parameter preservation. All known issues have been resolved.

## MessagePort Implementation (Direct Renderer Communication)

> **Status:** ✅ **Working** - Added 2025-02-14

### Overview

To reduce main process CPU overhead during high-frequency data streaming (VU meters, waveform data), we implemented **MessageChannelMain** for direct renderer-to-renderer communication between the engine and child windows (parameters, monitoring).

### Key Implementation Details

#### 1. Port Lifecycle

**Creation (Main Process):**
```javascript
const { port1, port2 } = new MessageChannelMain();

// Send ports to both renderers
engineWindow.webContents.postMessage('message-channel', 
    { type, windowId, role: 'engine' }, 
    [port1]
);
win.webContents.postMessage('message-channel', 
    { type, role: 'window' }, 
    [port2]
);
```

**Reception (Renderers):**
```javascript
// IMPORTANT: Must call port.start() to receive messages!
// Without this, messages queue up causing OOM crashes.
ipcRenderer.on('message-channel', (e, meta) => {
    const port = e.ports[0];
    port.start();  // ← Critical!
    port.onmessage = (e) => { /* handle message */ };
});
```

#### 2. Data Flow

| Path | Before | After |
|------|--------|-------|
| VU meters | Engine → Main IPC → Window | Engine → **MessagePort** → Window (direct) |
| Waveform data | Engine → Main IPC → Window | Engine → **MessagePort** → Window (direct) |
| Control commands | Window → Main IPC → Engine | Window → Main IPC → Engine (unchanged) |

#### 3. Disposal Handling

When engine is disposed, ports must be closed cleanly to prevent crashes:

```javascript
// In disposeEngineWindow() (app.js):
// Close all MessageChannels before destroying engine
const channelsToClose = Array.from(messageChannels.entries());
messageChannels.clear();

for (const [windowId, channel] of channelsToClose) {
    try { channel.enginePort.close(); } catch (e) {}
}
```

The remote end (window) receives a `'close'` event and cleans up its port reference.

#### 4. Restoration Handling

After engine restoration, new MessageChannels are created:

```javascript
// In restoreEngineIfNeeded() (app.js):
// Recreate MessageChannels for direct communication after engine restoration
recreateAllMessageChannels();
```

Windows automatically receive new ports via the `message-channel` IPC event.

### Critical Bug Fixed: Missing `port.start()`

**Problem:** OOM crashes during engine disposal/restoration cycles.

**Root Cause:** Not calling `port.start()` after receiving the port. Per Electron documentation: *"Messages will be queued until this method is called."* High-frequency VU data (60fps) would queue up indefinitely, causing memory exhaustion.

**Solution:** Added `port.start()` in both engine and window reception handlers.

### Files Modified

| File | Changes |
|------|---------|
| `js/app.js` | `MessageChannelMain` import, `createMessageChannel()`, `recreateAllMessageChannels()` |
| `js/engines.js` | Port reception handler, `sendToWindow()` uses MessagePort when available |
| `js/window-loader.js` | Port reception handler with `port.start()`, handler attachment |
| `js/parameters/main.js` | Auto-rebuild tracker VU meters when channel count changes |

### Window-Ready Handshake

To prevent windows from appearing before they're fully initialized (and missing early messages), a handshake was added:

```javascript
// player.js - when creating window:
const onReady = (e, data) => {
    if (data.windowId == windowId) {
        tools.sendToId(windowId, 'show-window');
        ipcRenderer.send('window-visible', { type, windowId });
    }
};
ipcRenderer.on('window-ready', onReady);

// window-loader.js - when initialized:
tools.sendToId(stageId, 'window-ready', { type: windowType, windowId });
```

### Testing MessagePort

To verify MessagePort is being used (vs fallback IPC), temporarily enable debug logging in `sendToWindow()`:

```javascript
if (windowType && g.messagePorts[windowType]) {
    console.log('[MessagePort] Direct send:', channel);
} else {
    console.log('[MessagePort] Fallback IPC:', channel);
}
```

Expected: High-frequency data (tracker-vu, ana-data) should use direct path.

---

**Note:** The idle disposal feature is fully working, including parameter preservation and MessagePort direct communication. All known issues have been resolved.
