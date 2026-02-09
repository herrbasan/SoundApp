
---

## Mental Model: Audio Pipeline Architecture

> **⚠️ NOTE:** This is a simplified model of the audio pipeline. For the full picture, read the code.

### Core State

```javascript
// Three key pieces of state
g.activePipeline      // 'normal' | 'rubberband' - which pipeline is currently active
g.audioParams         // { mode, locked, pitch, tempo, tapeSpeed, formant }
g.currentAudio        // { player, paused, isFFmpeg, play(), pause(), seek() }
```

### The Two Pipelines

| | Normal | Rubberband |
|--|--------|------------|
| **Sample Rate** | 48-192kHz (configurable) | Fixed 48kHz |
| **Use Case** | Standard playback | Pitch/tempo manipulation |
| **Player** | `g.ffmpegPlayer` | `g.rubberbandPlayer` |
| **Memory** | ~5MB | ~70MB (WASM) |
| **Created** | App startup | On-demand (lazy) |

### Key Insight: Dual AudioContext Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  g.audioContext │     │g.rubberbandContext│
│  (48-192kHz)    │     │   (fixed 48kHz)  │
│                 │     │                  │
│ ┌─────────────┐ │     │ ┌─────────────┐  │
│ │ FFmpeg      │ │     │ │ FFmpeg      │  │
│ │ Player      │ │     │ │ Player ──►  │  │
│ │ (SAB)       │ │     │ │ Rubberband  │  │
│ └──────┬──────┘ │     │ │ Worklet     │  │
│        │        │     │ └──────┬──────┘  │
│        ▼        │     │        │         │
│   Destination   │     │   Destination    │
└─────────────────┘     └─────────────────┘
        ▲                       ▲
        └───────────┬───────────┘
                    │
         Only ONE connects to
         speakers at a time
```

### The Routing Coordinator

All pipeline decisions go through `applyRoutingState()`:

```javascript
// Call this whenever state changes:
// - File loaded
// - Mode changed (tape ↔ pitchtime)
// - Parameters window opened/closed
// - Locked setting toggled
await applyRoutingState(shouldPlay);  // shouldPlay = true | false | null
```

**What it does:**
1. Calls `calculateDesiredPipeline()` → decides 'normal' or 'rubberband'
2. Calls `switchPipeline()` if needed
3. Cleans up unused resources (destroys rubberband to free memory)
4. Updates monitoring connections

### Common Issues

#### 1. UI Shows Paused But Audio Playing
**Cause:** `g.currentAudio.paused` out of sync with `player.isPlaying`
**Fix:** Always use `g.currentAudio.play()` / `pause()` methods (they update both states)

#### 2. Monitoring Graphs Empty in Rubberband Mode  
**Cause:** `disconnect()` was disconnecting ALL targets, not just monitoring
**Fix:** Pass target to `disconnect(target)` for selective disconnection

#### 3. Duplicate play() Calls
**Cause:** Both `switchPipeline()` and `playAudio()` calling play()
**Fix:** Made `play()` idempotent with `if (this.isPlaying) return;`

#### 4. Audio "Rush" on File Change (Locked Mode)
**Status:** Known bug - see "Known Bugs" section below
**Clue:** Worse in HQ mode (96/192kHz) even though rubberband always runs at 48kHz

### Debug Snippets

```javascript
// Check pipeline state
console.log('active:', g.activePipeline, 'desired:', calculateDesiredPipeline());

// Check players
console.log('ffmpeg:', !!g.ffmpegPlayer, 'rb:', !!g.rubberbandPlayer);

// Check sync
console.log('paused:', g.currentAudio?.paused, 'playing:', g.currentAudio?.player?.isPlaying);

// Check monitoring
console.log('RB splitter:', !!g.monitoringSplitter_RB, 'RB analysers:', !!g.monitoringAnalyserL_RB);
```


### Known Bugs (Pending Fix)

#### 1. Constant CPU When Idle (0.3-0.5%) - ✅ WORKAROUND AVAILABLE
**Status:** Root cause found, workaround implemented  
**Cause:** MIDI player library causes constant CPU usage even when idle  
**Solution:** Set `disableMidiPlayer: true` in audio config (see "Debugging Constant CPU Usage" section)

#### 2. Audio "Rush" on File Change in Locked Pitchtime Mode

**Symptom:** When rubberband is active and a new file loads, the first ~1 second of audio "rushes" (plays at wrong speed or garbled). This is minor in 48kHz mode but severe in HQ mode (96/192kHz).

**Key Clue:** Rubberband ALWAYS runs at 48kHz regardless of HQ mode. The fact that HQ mode makes it worse suggests the issue is in the **timing/handoff between FFmpeg decoder initialization and rubberband worklet**, not the rubberband processing itself.

**Hypothesis:** 
- FFmpeg decoder initializes and starts feeding audio immediately
- Rubberband worklet takes time to "warm up" (WASM initialization, first process() call)
- During this window, audio may be buffered incorrectly or played at wrong rate
- Higher sample rates = more data in the same time window = worse artifacts

**Investigation Notes:**
```javascript
// The issue likely occurs in this sequence:
1. playAudio() creates new FFmpeg player
2. switchPipeline() opens file in rubberband player
3. rubberband worklet starts receiving audio
4. [GAP/RACE CONDITION HERE]
5. play() starts actual output

// Possible fixes to investigate:
// - Add delay/worklet priming before starting playback
// - Check if rubberband worklet needs pre-roll silence
// - Verify FFmpeg player isn't feeding data before worklet is ready
```

**Related Code:**
- `js/rubberband-pipeline.js` - Worklet creation and audio routing
- `bin/win_bin/player-sab.js` - FFmpeg decoder feeding
- `js/stage.js:1907-1909` - Where pipeline switch happens after file load


---

## Future Architecture: Centralized State System

> **Status:** Design idea for future refactoring

### Current Problem

State is scattered across multiple global variables:

```javascript
// Current state is fragmented:
g.activePipeline           // 'normal' | 'rubberband'
g.audioParams              // { mode, locked, pitch, tempo, ... }
g.currentAudio             // { player, paused, isFFmpeg, ... }
g.rubberbandPlayer         // Player instance or null
g.ffmpegPlayer             // Player instance
g.windows.monitoring       // Window ID or null
g.windowsVisible.monitoring // boolean
g.monitoringReady          // boolean
g.parametersOpen           // boolean
// ...and more
```

**Problems with this approach:**
1. Hard to know what's "true" at any moment
2. Race conditions when multiple things change simultaneously  
3. Easy to get out of sync (e.g., `paused` vs `isPlaying`)
4. No single place to validate state consistency
5. Testing is hard - have to mock many globals

### Proposed Solution

```javascript
// Single source of truth
g.playerState = {
  // What
  file: null | string,           // Current file path
  isPlaying: boolean,            // Actual playback state
  position: number,              // Current time in seconds
  duration: number,              // Total duration
  
  // How
  pipeline: 'normal' | 'rubberband',
  mode: 'tape' | 'pitchtime',
  params: {
    tapeSpeed: number,
    pitch: number,
    tempo: number,
    formant: boolean,
    locked: boolean
  },
  
  // UI/Windows
  windows: {
    monitoring: { open: boolean, visible: boolean, ready: boolean },
    parameters: { open: boolean },
    // ...etc
  }
};

// All mutations go through actions
g.playerState = StateReducer(g.playerState, {
  type: 'PLAY',
  payload: { startTime: 0 }
});

// Components subscribe to slices
State.subscribe('pipeline', (newVal, oldVal) => {
  // React to pipeline changes
});

State.subscribe('isPlaying', (newVal) => {
  updateUI(newVal ? 'playing' : 'paused');
});
```

### Benefits

1. **Single source of truth** - Look in one place to know everything
2. **Predictable updates** - All state changes go through the reducer
3. **Easy debugging** - Log every state change, time-travel debugging
4. **Testability** - Pure functions: `newState = reducer(oldState, action)`
5. **Subscriptions** - Components react to changes instead of polling

### Migration Path

```javascript
// Phase 1: Create state object that mirrors current globals
g.state = createInitialState();

// Phase 2: Replace direct mutations with setters
// Before:
g.activePipeline = 'rubberband';

// After:
State.set({ activePipeline: 'rubberband' });

// Phase 3: Components subscribe to state instead of checking globals
// Before:
if (g.activePipeline === 'rubberband') { ... }

// After:
State.subscribe('activePipeline', (val) => { ... });
```

### Related Ideas

- **State Machines** - Model playback as explicit states:
  ```javascript
  // IDLE -> LOADING -> PLAYING -> PAUSED -> STOPPED
  //               \______________/
  ```

- **Command Pattern** - All actions are objects:
  ```javascript
  { type: 'PLAY_FILE', file: 'song.mp3', mode: 'pitchtime' }
  { type: 'SEEK', position: 120 }
  { type: 'SET_MODE', mode: 'tape', speed: -3 }
  ```

- **Undo/Redo** - With immutable state, easy to implement history


---

## Debugging Constant CPU Usage (0.2%+ When Idle)

> **Status:** ✅ **RESOLVED** - MIDI Player is the culprit

### Investigation Results

| DEBUG_MODE Level | Components | CPU Usage |
|------------------|------------|-----------|
| 0-1 | UI + Config | 0-0.1% ✅ |
| 2 | + AudioContext (suspended) | 0-0.1% ✅ |
| 3 | + FFmpeg player (idle) | 0-0.1% ✅ |
| 4 | + AudioContext running | 0-0.1% ✅ |
| 5 | + **MIDI player** | **0.3-0.5%** ❌ |
| 6 | + Tracker player | 0.3-0.5% ❌ |

**Root Cause:** The MIDI player (`js/midi/midi.js` library) causes constant 0.3-0.5% CPU usage even when idle/not playing MIDI files.

### Solution

**Option 1: Disable MIDI player completely** (if you don't need MIDI file support)

Add to your config (or edit `js/config-defaults.js`):
```json
{
  "audio": {
    "disableMidiPlayer": true
  }
}
```

Or use the DEBUG_MODE test to confirm:
```json
{
  "DEBUG_MODE": 4
}
```

**Option 2: Live with it** (if you need MIDI support)
- 0.3-0.5% is relatively minor
- The MIDI player loads a soundfont and likely has internal timers/polling

### Implementation Details

The fix was added in `js/stage.js:initMidiPlayer()`:
```javascript
async function initMidiPlayer() {
    if (!window.midi || !g.audioContext) return;
    
    // Allow disabling MIDI player to save CPU (0.3-0.5% constant usage even when idle)
    if (g.config?.audio?.disableMidiPlayer) {
        console.log('[MIDI] Disabled via config (disableMidiPlayer: true)');
        return;
    }
    // ... rest of initialization
}
```

And `js/config-defaults.js` has the new option:
```javascript
audio: {
    volume: 0.5,
    output: { deviceId: '' },
    hqMode: false,
    disableMidiPlayer: false  // Set to true to save 0.3-0.5% constant CPU usage
},
```

### Original Hypotheses (DEBUNKED)

1. ~~AudioContext running state~~ - Tested: suspended vs running makes no difference (0-0.1% both)
2. ~~Web Audio AnalyserNode~~ - Not active when monitoring window closed
3. ~~Electron/Chromium flags~~ - Minimal mode proves Electron itself is fine
4. ~~Memory pressure/GC~~ - No GC pressure observed
5. ~~Background timer~~ - No suspicious timers found
6. ~~Worklet still active~~ - FFmpeg worklet idle = 0% CPU

### Debugging Steps

#### 1. Check AudioContext State
Open DevTools console in the main window when idle:
```javascript
// Check if audio context is running
console.log('AudioContext state:', g.audioContext?.state);
console.log('RubberbandContext state:', g.rubberbandContext?.state);

// Suspend it manually and see if CPU drops
g.audioContext.suspend().then(() => console.log('Suspended main context'));
g.rubberbandContext?.suspend().then(() => console.log('Suspended RB context'));
```

If CPU drops after suspend, we found the culprit.

#### 2. Profile with Chrome DevTools
1. Open DevTools (Ctrl+Shift+I)
2. Performance tab
3. Click record for 5-10 seconds while app is idle
4. Look for:
   - **Task** spikes (JavaScript running)
   - **System** activity (GC, compilation)
   - Long **Idle** periods vs constant small tasks

#### 3. Check for Timers/Intervals
In DevTools console:
```javascript
// Override setInterval/setTimeout to log what's running
const origSetInterval = window.setInterval;
window.setInterval = function(fn, delay, ...args) {
    console.trace('setInterval created:', delay, fn.toString().slice(0, 100));
    return origSetInterval(fn, delay, ...args);
};

const origSetTimeout = window.setTimeout;
window.setTimeout = function(fn, delay, ...args) {
    if (delay < 1000) { // Only log short timeouts
        console.trace('setTimeout created:', delay, fn.toString().slice(0, 100));
    }
    return origSetTimeout(fn, delay, ...args);
};
```

Reload and see what's being scheduled constantly.

#### 4. Check Electron Helper/Library
The issue might be in the `electron_helper` library:
```javascript
// Check if config is being polled
console.log('Config object:', g.config_obj);
// Look for any intervals/timeouts in the helper
```

#### 5. Compare with "Before" State
If you have a git commit from before the new features:
```bash
# Checkout old version
git checkout <commit-before-features>
# Test CPU usage
# Then compare what changed
```

#### 6. Process Isolation Test
In Task Manager, try killing individual Electron processes one by one (not the main one!) and see which one reduces CPU. This tells us if it's:
- Main process (app.js)
- Renderer (stage.js)
- GPU process
- Utility process (audio, etc.)

### Potential Fixes to Try

1. **Suspend AudioContext when paused:**
```javascript
// When pausing
g.audioContext.suspend();

// When resuming
g.audioContext.resume();
```

2. **Disable background throttling:**
```javascript
// In app.js when creating window
webPreferences: {
    backgroundThrottling: true,  // or false to test
    // ...
}
```

3. **Check Electron version changes:**
```javascript
// In DevTools
console.log(process.versions.electron);
console.log(process.versions.chrome);
```

### Related Code Areas
- `js/stage.js:541` - AudioContext creation
- `js/stage.js:254` - Rubberband context creation
- `js/app.js:191` - Main window webPreferences
- `libs/electron_helper/` - Helper library internals

---


---

## Minimal Mode (CPU Debugging)

> **Purpose:** Isolate what's causing constant CPU usage by skipping all heavy initialization

### How to Enable

**Option 1: Command line flag**
```bash
# Run app with --minimal flag
.\SoundApp.exe --minimal
```

**Option 2: Environment variable**
Add to `env.json` in app root:
```json
{
  "MINIMAL_MODE": true
}
```

### What Gets Skipped in Minimal Mode

✅ **Still loaded:**
- Basic Electron window
- Minimal UI (dark theme, frame)
- Console logging

❌ **Skipped:**
- AudioContext creation
- FFmpeg player initialization
- MIDI player initialization
- Tracker/MOD player initialization
- Rubberband pipeline
- Config system
- All IPC handlers
- All event listeners

### Expected CPU Usage

| Mode | Expected CPU |
|------|-------------|
| Minimal mode | 0% (or very close) |
| Normal idle (paused) | 0.2%+ (the problem) |

### Debugging Process

1. **Start in minimal mode** - Check Task Manager
   - If CPU is 0% → Problem is in skipped components
   - If CPU is still 0.2%+ → Problem is in Electron/Chromium itself

2. **Gradually re-enable components** by editing the init() function:
   ```javascript
   // In js/stage.js init(), after minimal mode check:
   
   // Step 1: Add back config system
   g.config_obj = await helper.config.initRenderer(...)
   
   // Step 2: Add back AudioContext only
   g.audioContext = new AudioContext(...)
   
   // Step 3: Add back FFmpeg player
   // etc.
   ```

3. **Check CPU after each addition** to find the culprit

### Quick Test in DevTools

Even without minimal mode, you can test suspending the AudioContext:
```javascript
// In DevTools console when app is idle
console.log('Before suspend:', g.audioContext.state);
g.audioContext.suspend().then(() => {
    console.log('After suspend:', g.audioContext.state);
    console.log('Check Task Manager - did CPU drop?');
});
```

### Related Files

- `js/stage.js:368-400` - Minimal mode check and early return
- `js/stage.js:539-543` - AudioContext creation (skipped in minimal)
- `js/stage.js:567-578` - FFmpeg player init (skipped in minimal)

