# Rubberband Pipeline: Rush Issue - RESOLVED

**Last updated: 2026-02-22**  
**Status: FIXED**

---

## Problem Summary

When playing audio files with the rubberband pipeline (pitchtime mode), two issues occurred:

1. **Position Rush**: The displayed position would jump forward ~1-1.5 seconds immediately after starting playback
2. **Audio Crackle**: A brief crackling sound at the start of playback

Both issues were caused by rubberband's internal warmup behavior.

---

## Root Cause

The rubberband AudioWorklet processor has an internal **accumulation stall**:

1. It collects audio into a 4096-sample buffer (~85ms at 48kHz)
2. Only after accumulating 4096 samples does it push to the WASM kernel
3. The WASM kernel then processes and outputs audio

During this warmup period:
- FFmpeg was already playing and advancing position
- Rubberband was outputting audio but not counting it for position
- When rubberband finally started counting, it had already output ~1 second of audio
- This created a disconnect between audible audio and reported position

---

## Solution Implemented

### 1. One-Second Startup Delay

When a file is loaded with the rubberband pipeline, playback is delayed by **1000ms**:

```javascript
// In RubberbandPipeline.play()
if (this._needsStartupDelay) {
    setTimeout(() => {
        // Actually start playback after delay
        this.player.play();
    }, 1000);
}
```

This allows rubberband to:
- Accumulate its 4096-sample block
- Warm up its internal FFT windows
- Stabilize before audible playback begins

### 2. Position Counting Control

The worklet has a `_countingEnabled` flag that controls whether output frames are counted for position reporting:

```javascript
// During warmup (delay period)
this._countingEnabled = false;  // Counting disabled

// When play() is called
this.rubberbandNode.port.postMessage(JSON.stringify(['start-counting']));
// → Sets _countingEnabled = true, resets counters to 0
```

This ensures:
- Rubberband processes audio during the delay (no crackle)
- Position counting starts from 0 when audible playback begins
- No position rush/jump at startup

---

## Code Changes

### Files Modified

| File | Change |
|------|--------|
| `js/rubberband-pipeline.js` | Added `_needsStartupDelay` flag, 1s delay in `play()`, send `'start-counting'` message |
| `libs/rubberband/realtime-pitch-shift-processor.js` | Added `_countingEnabled` flag, handle `'start-counting'` message |

### Key Implementation Details

**Worklet (`realtime-pitch-shift-processor.js`):**
- Added `_countingEnabled = false` in constructor
- On `'prime'` message: reset `_countingEnabled = false`
- On `'start-counting'` message: set `_countingEnabled = true`, reset counters
- Only report position when `_countingEnabled === true`

**Pipeline (`rubberband-pipeline.js`):**
- Set `_needsStartupDelay = true` when recreating worklet
- In `play()`: if delay needed, wait 1000ms, then send `'start-counting'` and start playback
- Position tracking uses rubberband output frames (not FFmpeg input)

---

## Testing Checklist

- [x] No audible crackle at track start
- [x] Position starts at 0 and advances smoothly
- [x] No position jump when switching tracks
- [x] Works with locked settings across track changes
- [x] Normal pipeline (non-rubberband) unaffected

---

## Future Improvements

The current fix works but is a **band-aid solution**. A proper refactor would:

1. **Detect actual readiness** instead of using a fixed 1-second delay
   - Monitor rubberband's internal state
   - Start playback when output buffer has meaningful content

2. **Separate audio pipeline lifecycle from position tracking**
   - Current implementation has tight coupling between warmup and position
   - Position should always reflect actual audible output

3. **Remove the need for artificial delays**
   - The 1-second delay is brute-force
   - Better: synchronize rubberband startup with actual audio output

---

## Notes for Developers

- The 1-second delay only applies to the **first play after file change**
- Subsequent play/pause cycles use normal playback (no delay)
- The `warmed-up` message still controls volume fade-in
- Position reports every 128 frames (~2.7ms at 48kHz) for smooth tracking
