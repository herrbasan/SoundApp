# FFmpeg Player Implementation Review

## Overview
Critical analysis of `bin/win_bin/player.js` and `bin/win_bin/ffmpeg-worklet-processor.js` for simplicity, reliability, performance, and memory safety.

---

## 🔴 Critical Issues

### 1. Memory Leak: Transferable ArrayBuffers Not Used
**File:** `player.js` lines 264-271

When sending chunks to the worklet via `postMessage`, the Float32Array is **copied**, not transferred. For continuous streaming, this creates garbage that needs collection.

```javascript
// Current (copies data):
this.workletNode.port.postMessage({
  type: 'chunk',
  samples: result.buffer.subarray(0, result.samplesRead)
});

// Better (transfers ownership, zero-copy):
const chunk = result.buffer.slice(0, result.samplesRead);
this.workletNode.port.postMessage({ type: 'chunk', samples: chunk }, [chunk.buffer]);
```

### 2. Worklet Chunk Queue Can Grow Unbounded
**File:** `ffmpeg-worklet-processor.js`

The `chunks` array grows whenever chunks arrive faster than they're consumed. During pause, the feed loop stops but if it was running, chunks accumulate. No max queue size.

**Fix:** Add queue limit, drop oldest or stop accepting when full.

### 3. Feed Loop Runs Even When Decoder is EOF
**File:** `player.js` line 287

```javascript
_startFeedLoop() {
  if (!this.isPlaying) return;
  if (!this.decoderEOF) {
    this._decodeAndSendChunk();
  }
  this.decodeTimer = setTimeout(() => this._startFeedLoop(), 20);  // Runs forever!
}
```

The loop continues with 20ms timers even after EOF - wastes CPU cycles. Should stop when `decoderEOF` is true.

**Fix:**
```javascript
_startFeedLoop() {
  if (!this.isPlaying) return;
  if (this.decoderEOF) return;  // Stop loop when done
  
  this._decodeAndSendChunk();
  this.decodeTimer = setTimeout(() => this._startFeedLoop(), 20);
}
```

---

## 🟡 Reliability Issues

### 4. Position Reporting Race Condition
**File:** `ffmpeg-worklet-processor.js` lines 189-195

```javascript
if (this.framesPlayed % 4410 < 128) {
  this.port.postMessage({ type: 'position', ... });
}
```

This fires ~10 times per second but only when `framesPlayed % 4410 < 128`. At 44100Hz, `process()` handles 128 samples, so this fires once every ~100ms. But after seek, `framesPlayed` changes immediately - could miss position updates or fire multiple times in quick succession.

**Consider:** Simple frame counter, report every N calls to `process()` instead.

### 5. No Validation on Seek Range
**File:** `player.js` line 353

```javascript
seek(seconds) {
  const success = this.decoder.seek(seconds);  // What if seconds < 0 or > duration?
```

No clamping. Could seek to negative time or past end of file.

**Fix:**
```javascript
seek(seconds) {
  if (!this.decoder) return false;
  seconds = Math.max(0, Math.min(seconds, this.duration));
  // ...
}
```

### 6. `loopStarted` Handler Could Fail Silently
**File:** `player.js` lines 164-175

If `decoder.seek(0)` or `decoder.read()` fails, there's no error handling. The burst loop would send empty/broken chunks.

**Fix:** Check return values and handle failures gracefully.

---

## 🟢 Simplification Opportunities

### 7. Redundant `isLoaded` Check
Both `open()` and `play()` track loading state, but `play()` throws if `!isLoaded` while `open()` is async and could be called mid-operation.

### 8. `_pausedAtFrames` vs `currentFrames` Confusion
Two variables tracking position is error-prone. Could simplify to just `currentFrames` and a `paused` flag.

### 9. FFmpegBufferedPlayer is Unused
The codebase only uses `FFmpegStreamPlayer`. The buffered player adds complexity - could be removed if not needed.

---

## 🔧 Recommended Fix Priority

### Priority 1 (Memory/Performance):
1. Use transferable buffers for chunk posting
2. Stop feed loop when EOF reached
3. Add max queue size to worklet

### Priority 2 (Reliability):
4. Clamp seek values
5. Add error handling to `loopStarted`
6. Simplify position tracking

### Priority 3 (Cleanup):
7. Remove FFmpegBufferedPlayer if unused
8. Consolidate position tracking variables

---

## Files to Modify
- `bin/win_bin/player.js` - Main player class
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorklet processor

## Related Documentation
- [LOCAL_FIXES.md](../bin/LOCAL_FIXES.md) - Fixes already applied locally
- [streaming-refactor.md](streaming-refactor.md) - Original architecture plan
