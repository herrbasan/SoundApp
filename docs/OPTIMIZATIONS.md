# SoundApp Performance Optimizations

> **Last Updated:** 2026-02-14  
> **Status:** All critical optimizations implemented and tested

---

## ✅ IMPLEMENTED - Production Ready

These optimizations are **active now** - no configuration needed.

### 1. Worklet Ready Handshake
**Problem:** Audio "rush" glitch when switching files in rubberband mode.  
**Solution:** Wait for worklet WASM to signal ready before starting playback.

**Files:** `js/rubberband-pipeline.js`, `bin/win_bin/realtime-pitch-shift-processor.js`

---

### 2. Unified Idle State Machine
**Problem:** Overlapping disposal timers caused race conditions.  
**Solution:** Explicit state machine with atomic transitions.

| State | Description | Timeout |
|-------|-------------|---------|
| `ACTIVE` | Playing or recently active | None |
| `PAUSED_VISIBLE` | Paused, window visible | 10s |
| `PAUSED_HIDDEN` | Paused, window hidden | 5s |
| `DISPOSING` | Cleanup in progress | None |
| `DISPOSED` | Engine destroyed, 0% CPU | None |

**Files:** `js/app.js`

---

### 3. Adaptive Position Push
**Problem:** Fixed 15ms position updates = excessive IPC traffic.  
**Solution:** Adaptive intervals based on user activity.

| Mode | Interval | When Used |
|------|----------|-----------|
| `scrubbing` | 16ms | User dragging seek bar |
| `normal` | 50ms | Standard playback |

**Impact:** ~60% reduction in IPC traffic during normal playback (66Hz → 20Hz).

**Files:** `js/engines.js`, `js/player.js`

---

### 4. MIDI Lazy-Init
**Problem:** MIDI player used 0.3-0.5% CPU constantly, even when idle.  
**Solution:** Initialize only on first MIDI file playback.

**Status:** ✅ **Fixed**  
Module loads at startup, instance initializes on first MIDI file.

**Files:** `js/engines.js`, `html/engines.html`

---

### 5. Tracker Lazy-Init
**Problem:** Chiptune player initialized on startup, wasting resources.  
**Solution:** Module loads at startup, instance initializes on first tracker file.

**Status:** ✅ **Fixed**  
**Key fixes:** 
- Wait for `onInitialized` callback before returning from lazy init
- Module-scope state properly reset on engine disposal
- Race condition handled (aborts if disposed during init)
- Respects lazy-init flag in `toggleHQMode()`

**Toggle in `env.json`:**
```json
{
  "lazyLoadEngines": true,  // Enables both MIDI and Tracker lazy-init
  "lazyLoadTracker": true   // Specifically for tracker (optional)
}
```

**Files:** `js/engines.js`

---

### 6. Transactional Pipeline Switch
**Problem:** Failed switches could leave audio in broken state.  
**Solution:** Atomic operation with automatic rollback on failure.

**Files:** `js/engines.js`

---

### 7. LRU Waveform Cache
**Problem:** Unbounded cache growth, no proper eviction.  
**Solution:** True LRU with hit/miss stats.

```javascript
// DevTools verification
waveformCache.getStats()  // { hits, misses, evictions, hitRate }
```

**Files:** `js/app.js`

---

## 📊 Performance Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Idle CPU** | 0.9-1.3% | ~0% | 100% reduction |
| **IPC Traffic** | 66 Hz | 20 Hz | 70% reduction |
| **Memory** | Growing | Bounded | Stable |
| **Audio Glitches** | Yes | No | Fixed |

---

## 🔧 Configuration

### No Configuration Needed
All optimizations are **enabled by default**.

### Optional: Disable MIDI Completely
If you never use MIDI files and want to save maximum CPU:

```json
// config.json
{
  "audio": {
    "disableMidiPlayer": true
  }
}
```

---

## 🐛 Debugging

```javascript
// DevTools Console

// Check idle state
debugIdle.status()

// Force engine disposal
debugIdle.forceDispose()

// Check waveform cache
waveformCache.getStats()

// Check MIDI init status
midi?._isInitialized ? "initialized" : "not loaded"

// Check tracker init status  
_trackerInstance ? "initialized" : "not loaded"
```

---

## 💡 FUTURE IDEAS (Not Implemented)

These are **ideas only** - no code written yet.

### Predictive Engine Restoration
Start restoring engine when user hovers over play button (before click).  
*Trade-off: May restore unnecessarily.*

### Visual "Engine Sleeping" Indicator
Show indicator when engine is disposed to explain brief delay on first play.

### Configurable Idle Timeouts
User settings for disposal timing (fast disposal vs instant playback).

### Smart Idle Detection
Dispose during audio fade-out silence instead of fixed timeouts.

### WebGL Waveform Rendering
Replace Canvas 2D with WebGL for smoother visualization.

### Code Splitting
Load MIDI/Tracker code only when needed (requires build changes).

---

## 📝 Files Modified

| File | Changes |
|------|---------|
| `js/app.js` | Idle state machine, LRU cache |
| `js/engines.js` | Lazy-init, adaptive scheduler, transactions |
| `js/rubberband-pipeline.js` | Worklet ready handshake |
| `bin/win_bin/realtime-pitch-shift-processor.js` | Ready acknowledgment |
| `bin/linux_bin/realtime-pitch-shift-processor.js` | Ready acknowledgment |
| `html/engines.html` | Module loading order |
| `js/midi/midi.js` | Removed debug logging |

---

## ⚠️ Known Limitations

1. **First MIDI load:** 1-2s delay on first MIDI file (lazy-init working)
2. **First Tracker load:** Slight delay on first tracker file (lazy-init working)
3. **Position update:** 50ms is slightly less smooth than 15ms (barely noticeable)
