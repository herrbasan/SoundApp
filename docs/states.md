# Problematic Event Chains

> This document tracks event sequences that have caused bugs, to help identify race conditions and ordering issues.

---

## Chain 1: File Change + Parameters Window Open + Locked Mode

**Scenario:** Rubberband active, user opens new file

```
File Open Event
    ↓
Pipeline decides: rubberband needed
    ↓
NEW FFmpeg player created
    ↓
Rubberband worklet starts receiving audio  ← [RACE: worklet not fully ready]
    ↓
play() called
    ↓
AUDIO "RUSH" - first ~1 second plays garbled/wrong speed
```

**Root Cause:** Rubberband worklet takes time to "warm up" (WASM init), but FFmpeg feeds audio immediately.

**Severity:** Worse in HQ mode (96/192kHz) despite rubberband always running at 48kHz - suggests timing/handoff issue, not processing.

**Related Code:**
- `js/stage.js:1907-1909` - Pipeline switch after file load
- `js/rubberband-pipeline.js` - Worklet creation
- `bin/win_bin/player-sab.js` - FFmpeg decoder feeding

---

## Chain 2: UI State Desync (Paused but Audio Playing)

**Scenario:** User clicks play, then quickly pauses, or rapid mode switches

```
User clicks Play
    ↓
g.currentAudio.play() called
    ↓
Async: player starts playing
    ↓
BEFORE player confirms: User clicks Pause
    ↓
g.currentAudio.pause() called
    ↓
But: player.isPlaying = true, g.currentAudio.paused = true
    ↓
UI shows "paused", speakers emit audio
```

**Root Cause:** `g.currentAudio.paused` out of sync with `player.isPlaying`

**Fix Applied:** Made `play()` idempotent, always use wrapper methods that update both states

---

## Chain 3: Duplicate play() Calls

**Scenario:** Pipeline switch while shouldPlay=true

```
File loads → shouldPlay = true
    ↓
applyRoutingState(true) called
    ↓
switchPipeline() creates new player
    ↓
switchPipeline() calls play() on new player  ← [CALL 1]
    ↓
Back in playAudio(): play() called again      ← [CALL 2 - DUPLICATE]
    ↓
Audio artifacts, position jumps
```

**Root Cause:** Both `switchPipeline()` and `playAudio()` calling play()

**Fix Applied:** Made `play()` idempotent with `if (this.isPlaying) return;`

---

## Chain 4: Monitoring Disconnects Everything

**Scenario:** Closing monitoring window in rubberband mode

```
Monitoring window closes
    ↓
disconnect() called on source
    ↓
.disconnect() with NO target specified
    ↓
Disconnects ALL connections (including to destination!)
    ↓
Audio continues playing but no output to speakers
    ↓
Monitoring graphs empty (correct) but also no sound (wrong)
```

**Root Cause:** `disconnect()` disconnects all targets, not just monitoring

**Fix Applied:** Pass target to `disconnect(target)` for selective disconnection

---

## Chain 5: Parameters Applied to Wrong Pipeline

**Scenario:** Lock mode + file change + pipeline switch

```
Locked mode active, rubberband pipeline
    ↓
New file loaded
    ↓
Parameters window open → UI resets to defaults
    ↓
Pipeline switches to normal (based on new file?)
    ↓
Parameters from Tape/Speed tab applied
    ↓
BUT: User had Pitch/Time values from before
    ↓
Wrong values applied, unexpected audio behavior
```

**Open Question:** Which parameter set should apply when pipeline switches under lock mode?

---

## Chain 6: HQ Mode Change While Rubberband Active

**Scenario:** User toggles HQ mode while rubberband pipeline is running

```
Rubberband pipeline active (always 48kHz internally)
    ↓
User toggles HQ Mode (96kHz)
    ↓
Normal pipeline would change sample rate
    ↓
Rubberband pipeline ignores change (correct)
    ↓
User switches to normal pipeline later
    ↓
Sample rate is now 96kHz (stored from earlier)
    ↓
Audio plays at wrong speed OR needs re-init
```

**Expected:** HQ setting stored for later, applied when switching to normal pipeline

**Risk:** Timing of when stored value is applied vs when pipeline actually switches

---

## Chain 7: Window State Race Conditions

**Scenario:** Parameters window opened while file is loading

```
File starts loading
    ↓
User opens Parameters window (async)
    ↓
File load completes → triggers UI update
    ↓
Parameters window init continues
    ↓
[BOTH updating UI simultaneously]
    ↓
UI shows inconsistent state (wrong tab, wrong values)
```

**Risk:** Two code paths updating same UI elements without coordination

---

## Chain 8: Monitoring Window + Pipeline Switch

**Scenario:** Monitoring open, user switches modes causing pipeline switch

```
Monitoring window open, connected to rubberband
    ↓
User switches to tape mode (normal pipeline)
    ↓
applyRoutingState() switches pipeline
    ↓
Old analyzers disconnected from rubberband
    ↓
New analyzers connected to normal pipeline
    ↓
[BUT] Monitoring window still references old analysers?
    ↓
Graphs empty or frozen
```

**Open Question:** Are monitoring connections properly re-established after pipeline switch?

---

## Chain 9: Pause During Seek

**Scenario:** User seeks while playing, clicks pause before seek completes

```
PLAYING state
    ↓
Seek starts → SEEKING state
    ↓
User clicks Pause
    ↓
Seek completes → tries to resume PLAYING
    ↓
Pause command also pending
    ↓
[RACE: which happens first?]
    ↓
Either: Paused at wrong position, or playing when should be paused
```

---

## Chain 10: Cover Image Not Reset on File Change

**Scenario:** File A has cover, File B has no cover

```
File A loaded (has cover.jpg)
    ↓
Cover displayed in UI
    ↓
User opens File B (no cover)
    ↓
File B metadata loaded
    ↓
No cover found in File B
    ↓
[BUG: Cover update skipped - no new cover to set]
    ↓
File A's cover still displayed for File B
```

**Root Cause:** Cover update only triggers when new cover IS found; missing "clear cover" path when no cover exists

**Status:** 🔴 **OPEN BUG**

---

## Chain 11: Engines Closed + File Skip + Parameters Window Open

**Scenario:** Engines shut down (paused), user skips to next file while Parameters window remains open

### Path A: Lock Settings = OFF ✅ FIXED
```
Engines closed (paused state)
    ↓
User clicks Skip (Next/Prev)
    ↓
New file selected
    ↓
Main process restores engine with restoreEngineIfNeeded()
    ↓
IF locked=false: Reset audioState to defaults (tape/speed 0)  ← [FIXED]
    ↓
Sync window states (parametersOpen=true) to engine
    ↓
Load file with restore=true
    ↓
Apply reset params to engine
    ↓
Update UI with reset values (tape/speed 0)
    ↓
Audio plays normally
```

**Fix Applied:** 
- `js/app.js:audio:next` handler now calls `restoreEngineIfNeeded()` when engine is dead
- `js/app.js:restoreEngineIfNeeded()` resets `audioState` to defaults when `locked=false` (lines 832-841)
- `js/parameters/main.js:updateParams()` clears debounce timeouts before updating sliders (prevents old values overwriting reset)
- Window states are properly synced during engine restoration

**Root Cause of UI Not Updating:**
The parameters window's sliders have 30ms debounce timeouts for sending `param-change` events. When we reset params programmatically, pending debounced callbacks from user interactions would fire AFTER the reset, overwriting the new values. Fixed by clearing timeouts before updating sliders.

### Path B: Lock Settings = ON ✅ FIXED
```
Engines closed (paused state)
    ↓
User clicks Skip (Next/Prev)
    ↓
New file selected
    ↓
Main process restores engine with restoreEngineIfNeeded()
    ↓
Pre-set params on engine (mode=pitchtime, pitch=X, locked=true)
    ↓
Calculate desired pipeline BEFORE clearAudio() resets it
    ↓
Restore activePipeline to 'rubberband' if needed
    ↓
Ensure rubberband pipeline is initialized before use
    ↓
Load file with correct pipeline from the start
    ↓
Audio plays with correct pitch/tempo manipulation
```

**Fix Applied:**
- `js/engines.js:playAudio()` now stores `desiredPipeline` BEFORE `clearAudio()` resets it
- `js/engines.js:playAudio()` restores `activePipeline` after `clearAudio()` if rubberband is needed
- `js/engines.js:playAudio()` ensures rubberband is initialized before selecting player
- `js/engines.js:ensureRubberbandPipeline()` now detects disposed worklets and recreates pipeline

### Path C: CRITICAL - Rubberband Pipeline Corruption ✅ FIXED
```
Rubberband pipeline active (Pitch/Time mode)
    ↓
Engines closed (paused state)
    ↓
User clicks Skip (Next/Prev)
    ↓
New file selected
    ↓
Main process restores engine with restoreEngineIfNeeded()
    ↓
ensureRubberbandPipeline() detects disposed worklet
    ↓
Clean up old player, set g.rubberbandPlayer = null
    ↓
Create fresh rubberband pipeline with new worklet
    ↓
Load file with fresh rubberband instance
    ↓
Audio plays correctly with pitch/tempo manipulation
```

**Root Cause:** `clearAudio()` called `disposeWorklet()` which set `rubberbandNode = null`, but `g.rubberbandPlayer` still existed. `ensureRubberbandPipeline()` checked `if (g.rubberbandPlayer)` and returned true, thinking the pipeline was ready.

**Fix Applied:**
- `js/engines.js:ensureRubberbandPipeline()` now checks `g.rubberbandPlayer.rubberbandNode` 
- If player exists but worklet is null, dispose old player and set to null
- Fresh pipeline is created with new WASM instance and worklet

**Status:** ✅ **FIXED - Rubberband pipeline properly recreates after disposal**

**Related Issues:**
- #1 (Audio Rush) - Same root cause: pipeline switch timing
- g.rubberbandPlayer not properly cleaned up on engine shutdown
- Rubberband worklet needs hard reset between files

---

## Debugging Tool: State Debug Dump

When issues occur, log this:

```javascript
console.log({
  // Core state
  activePipeline: g.activePipeline,
  desiredPipeline: calculateDesiredPipeline(),
  
  // Player state
  currentAudio: {
    exists: !!g.currentAudio,
    paused: g.currentAudio?.paused,
    isFFmpeg: g.currentAudio?.isFFmpeg,
    playerExists: !!g.currentAudio?.player,
    playerIsPlaying: g.currentAudio?.player?.isPlaying
  },
  
  // Pipeline instances
  players: {
    ffmpeg: !!g.ffmpegPlayer,
    rubberband: !!g.rubberbandPlayer
  },
  
  // Audio params
  params: g.audioParams,
  
  // Window states
  windows: {
    parametersOpen: g.parametersOpen,
    monitoringOpen: !!g.windows.monitoring,
    monitoringReady: g.monitoringReady
  },
  
  // Contexts
  contexts: {
    main: g.audioContext?.state,
    rubberband: g.rubberbandContext?.state
  }
});
```

---

## Summary of Fixes (2026-02-13)

### Issues Fixed

| Issue | File | Lines | Description |
|-------|------|-------|-------------|
| Chain 11 Path A | `js/app.js` | 832-841 | Reset `audioState` to defaults when `locked=false` during engine restore |
| Chain 11 Path A UI | `js/parameters/main.js` | ~350-375 | Clear debounce timeouts before updating sliders (prevents old values overwriting reset) |
| Chain 11 Path B | `js/engines.js` | 1517-1533 | Store `desiredPipeline` before `clearAudio()` resets it |
| Chain 11 Path C | `js/engines.js` | 266-285 | Detect disposed worklets in `ensureRubberbandPipeline()` |
| State-debug window | `js/app.js` | 1370-1420 | Add missing `state-debug:request` IPC handler |
| State-debug actions | `js/app.js` | 688-710 | Add `logStateDebugAction()` function |
| State-debug actions | `js/app.js` | 1060,1085,1172,1187,1266,799,937 | Action logging at key events |

### Key Changes

1. **`js/app.js:state-debug:request`** - Add missing IPC handler to send main state, action log, and forward requests to engine (fixes broken state-debug window).

2. **`js/app.js:logStateDebugAction()`** - Add action logging function and log key events (play, pause, next, prev, file-loaded, engine-disposed, engine-restored).

3. **`js/app.js:restoreEngineIfNeeded()`** - Reset `audioState` to defaults (tape/speed 0) when `locked=false` before restoring engine.

4. **`js/app.js:sendParamsToParametersWindow()`** - Accept `reset` parameter to signal UI reset when params are reset (fixes params UI not updating).

5. **`js/engines.js:playAudio()`** - Calculate `desiredPipeline` BEFORE calling `clearAudio()` (which resets `activePipeline` to 'normal'), then restore `activePipeline` if rubberband is needed.

6. **`js/engines.js:playAudio()`** - If `activePipeline === 'rubberband'` but `g.rubberbandPlayer` is null or has disposed worklet, call `ensureRubberbandPipeline()` before selecting the player.

7. **`js/engines.js:ensureRubberbandPipeline()`** - Check if `g.rubberbandPlayer.rubberbandNode` exists (not just player object). If worklet was disposed, clean up old player and create fresh instance.

---

## Pipeline Architecture Notes

**Mixer Window:** Does not use the FFmpeg streaming pipeline; falls back to loading files completely into memory.

