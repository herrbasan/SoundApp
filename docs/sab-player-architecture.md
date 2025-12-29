# SAB Player Architecture

## Overview

The SAB (SharedArrayBuffer) player is a streaming audio player for Electron that uses native FFmpeg decoding via a NAPI addon, streaming decoded audio through a shared memory ring buffer to an AudioWorkletProcessor.

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MAIN THREAD                                    │
│                                                                             │
│  ┌──────────────────┐    ┌─────────────────────────────────────────────┐   │
│  │  FFmpegDecoder   │    │         FFmpegStreamPlayerSAB               │   │
│  │  (NAPI Addon)    │    │                                             │   │
│  │                  │    │  ┌─────────────────────────────────────┐   │   │
│  │  - open(path)    │◄───┼──│ decoder: FFmpegDecoder              │   │   │
│  │  - read(samples) │    │  │                                     │   │   │
│  │  - seek(seconds) │    │  │ controlSAB: SharedArrayBuffer (48B) │───┼───┼──┐
│  │  - close()       │    │  │ audioSAB: SharedArrayBuffer (~1MB)  │───┼───┼──┤
│  │                  │    │  │                                     │   │   │  │
│  │  Native memory:  │    │  │ workletNode: AudioWorkletNode       │   │   │  │
│  │  - AVFormatCtx   │    │  │ gainNode: GainNode                  │   │   │  │
│  │  - AVCodecCtx    │    │  │                                     │   │   │  │
│  │  - SwrContext    │    │  │ feedTimer: setTimeout (20ms loop)   │   │   │  │
│  │  - Frame buffers │    │  └─────────────────────────────────────┘   │   │  │
│  └──────────────────┘    └─────────────────────────────────────────────┘   │  │
│                                        │                                    │  │
│                                        │ postMessage                        │  │
│                                        ▼                                    │  │
│                               ┌─────────────────┐                           │  │
│                               │ MessagePort     │                           │  │
│                               │ (for commands)  │                           │  │
│                               └────────┬────────┘                           │  │
└────────────────────────────────────────┼────────────────────────────────────┘  │
                                         │                                       │
═════════════════════════════════════════╪═══════════════════════════════════════╪═══
                                         │                                       │
┌────────────────────────────────────────┼───────────────────────────────────────┼──┐
│                           AUDIO THREAD │                                       │  │
│                                        ▼                                       │  │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │  │
│  │                     FFmpegSABProcessor                                   │  │  │
│  │                     (AudioWorkletProcessor)                              │  │  │
│  │                                                                          │  │  │
│  │  controlBuffer: Int32Array ◄────────────────────────────────────────────┼──┼──┘
│  │  audioBuffer: Float32Array ◄────────────────────────────────────────────┼──┘
│  │                                                                          │
│  │  process() called 375x/sec (128 samples @ 48kHz)                        │
│  │  - Reads STATE from controlBuffer                                        │
│  │  - If PLAYING: reads from audioBuffer ring, outputs to speakers          │
│  │  - If PAUSED/STOPPED: outputs silence                                    │
│  │  - Returns true to stay alive (returns false on dispose)                 │
│  │                                                                          │
│  │  Port messages IN:  init, reset, seek, dispose                           │
│  │  Port messages OUT: ended, position                                      │
│  └─────────────────────────────────────────────────────────────────────────┘
│                                        │
│                                        ▼
│                               ┌─────────────────┐
│                               │  Audio Output   │
│                               │  (speakers)     │
│                               └─────────────────┘
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Shared Memory Layout

### Control Buffer (SharedArrayBuffer, 48 bytes = 12 × Int32)

```
Index  Name           Purpose
─────  ─────────────  ──────────────────────────────────────────
0      WRITE_PTR      Main thread writes decoded frames here
1      READ_PTR       Worklet reads from here, updates after read
2      STATE          0=STOPPED, 1=PLAYING, 2=PAUSED
3      SAMPLE_RATE    Audio sample rate (e.g., 48000)
4      CHANNELS       Channel count (always 2 currently)
5      LOOP_ENABLED   1=loop, 0=no loop
6      LOOP_START     Loop start frame (unused currently)
7      LOOP_END       Loop end frame
8      TOTAL_FRAMES   Total frames in file
9      UNDERRUN_COUNT Incremented when worklet starves
10     START_TIME_HI  Scheduled start (high 32 bits of float64)
11     START_TIME_LO  Scheduled start (low 32 bits of float64)
```

### Audio Buffer (SharedArrayBuffer, ~768KB at 48kHz)

```
Size: ringSeconds × sampleRate × channels × 4 bytes
      e.g., 4 sec × 48000 Hz × 2 ch × 4 bytes = 1.5MB

Layout: Interleaved stereo samples as Float32
        [L0, R0, L1, R1, L2, R2, ...]
        
Ring buffer with wrap-around:
        writePtr and readPtr are in FRAMES (not samples)
        Actual index = (ptr % ringSize) × channels
```

## Memory Management Strategy

### The Problem: Chrome's AudioWorkletNode Memory Leak

Chrome/Chromium has a known issue where rapidly created AudioWorkletNodes are not properly garbage collected. Each new AudioWorkletNode creates internal audio routing resources that persist longer than expected. Creating a new node for every track switch leads to unbounded memory growth.

**Observed behavior:** ~8-10MB growth per 30 track switches, never released.

### The Solution: Persistent Worklet Node Reuse

The SAB player employs a **persistent reuse strategy**:

1. **Create once, reuse always** - The AudioWorkletNode and SharedArrayBuffers are created once and reused across all track switches.

2. **`stop(true)` pattern** - When switching tracks, call `stop(true)` which:
   - Stops playback and clears timers
   - Resets ring buffer pointers to zero
   - Sends `reset` message to worklet (instead of `dispose`)
   - **Keeps** the workletNode, SABs, and buffers intact
   - Only closes the decoder

3. **Full cleanup only on dispose** - `stop()` without `true` or `dispose()` performs complete teardown, destroying the worklet node and releasing all SABs.

4. **Sample rate awareness** - SABs are only recreated when sample rate changes, which is rare in practice.

### Implementation in stage.js

The key is in `clearAudio()`:

```javascript
function clearAudio() {
    // ... other cleanup ...
    if (g.ffmpegPlayer) {
        g.ffmpegPlayer.stop(true);  // ← Keep SABs/worklet for reuse
    }
}
```

This is called before every `play()` operation, ensuring the previous track's resources are properly stopped but the worklet infrastructure remains ready.

### CPU Optimization: Disconnect on Pause

Even when paused, a connected AudioWorkletNode's `process()` method runs continuously (~375 times/second at 48kHz). This wastes CPU.

**Solution:** Disconnect the worklet node on pause, reconnect on play:

```javascript
pause() {
    // ... set state ...
    this.workletNode.disconnect();  // CPU stops
}

play() {
    this.workletNode.connect(this.gainNode);  // Resume processing
    // ... set state ...
}
```

### Worklet Termination on Dispose

When truly disposing the player, the worklet's `process()` returns `false` to signal termination:

```javascript
// Worklet processor
case 'dispose':
    this.shouldTerminate = true;
    // ... clear all state ...
    break;

process() {
    if (this.shouldTerminate) return false;  // Terminates processor
    // ...
}
```

## Lifecycle Flows

### Opening a New Track (Reuse Path)

```
await player.open(filePath)
    │
    ├── stop(true)  ◄── Keeps SABs/worklet
    │   ├── pause() → disconnect, clear timers
    │   ├── STATE = STOPPED
    │   ├── worklet.postMessage({type:'reset'})  ◄── NOT dispose
    │   ├── decoder.close()
    │   └── decoder = null
    │
    ├── decoder = new FFmpegDecoder()
    ├── decoder.open(filePath, contextSampleRate, threads)
    │
    ├── if (sampleRate changed OR first open):
    │   ├── Create new SABs (rare)
    │   ├── Create new AudioWorkletNode (rare)
    │   └── worklet.postMessage({type:'init', SABs})
    │
    ├── else (typical path):
    │   ├── Reset control buffer pointers
    │   └── worklet.postMessage({type:'reset'})  ◄── Reuse existing
    │
    ├── _fillRingBuffer()  (initial fill)
    │
    └── isLoaded = true
```

### Playing

```
await player.play(when = 0)
    │
    ├── audioContext.resume() if suspended
    │
    ├── workletNode.connect(gainNode)  ◄── Reconnect (may already be connected)
    │
    ├── _setScheduledStart(when)
    │
    ├── Atomics.store(STATE, PLAYING)
    │
    └── _startFeedLoop()
        └── 20ms setTimeout loop: decoder.read() → write to SAB ring
```

### Pausing

```
player.pause()
    │
    ├── isPlaying = false
    ├── clearTimeout(feedTimer)
    ├── Atomics.store(STATE, PAUSED)
    │
    └── workletNode.disconnect()  ◄── Stops CPU usage
```

### Full Dispose

```
player.dispose()
    │
    ├── stop()  ◄── Without true = full cleanup
    │   ├── pause()
    │   ├── STATE = STOPPED
    │   ├── worklet.postMessage({type:'dispose'})  ◄── Signals termination
    │   ├── workletNode.disconnect()
    │   ├── workletNode = null
    │   ├── SABs = null
    │   ├── decoder.close()
    │   └── decoder = null
    │
    └── isDisposed = true
```

## Comparison: SAB vs PostMessage Streaming

| Aspect | SAB Player | PostMessage Player |
|--------|-----------|-------------------|
| Memory per chunk | 0 (reuses ring buffer) | New Float32Array per chunk |
| Message overhead | Minimal (position only) | Full audio data via postMessage |
| Latency | Lower (direct memory access) | Higher (message serialization) |
| GC pressure | Lower | Higher |
| Complexity | Higher (Atomics, SAB setup) | Lower |
| Memory leak risk | Solved via reuse strategy | Messages may accumulate |

## Key Files

- `bin/win_bin/player.js` - FFmpegStreamPlayerSAB class
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorkletProcessor
- `bin/win_bin/ffmpeg_napi.node` - Native FFmpeg decoder

## Diagnostics

```javascript
const diag = player.getDiagnostics();
// { ringSize, bufferedFrames, bufferedSeconds, underrunCount, fillPercent }
```
