# Pitch & Time Manipulation (Dedicated Window)

SoundApp’s Pitch&Time feature runs in a dedicated secondary window with its own audio pipeline.
This keeps the main player stable and makes rapid iteration easier.

The window uses a fixed `AudioContext({ sampleRate: 48000 })` so the whole chain is predictable.

## Current Implementation

### Window + Integration

- UI: [html/pitchtime.html](../html/pitchtime.html) + [css/pitchtime.css](../css/pitchtime.css)
- Renderer logic: [js/pitchtime/main.js](../js/pitchtime/main.js)
- Audio engine: [js/pitchtime/pitchtime_engine.js](../js/pitchtime/pitchtime_engine.js)
- Stage integration: [js/stage.js](../js/stage.js) (`P` shortcut toggles Pitch&Time)

Stage behavior:

- When Pitch&Time opens, stage pauses current playback and sends the current file + position.
- When Pitch&Time is re-shown (Electron hides windows by default), stage sends a refresh message `pitchtime-file` so the window can reload and start again.

### Audio Pipeline (What Actually Runs)

```
Audio File
    → FFmpeg NAPI decoder (native)
    → SAB ring buffer (decoded PCM @ AudioContext rate)
    → FFmpeg SAB AudioWorklet (stream reader)
    → RubberBand WASM AudioWorklet (forked realtime wrapper; pitch + optional DSP)
    → Output
```

Worklet selection:

- Preferred: forked realtime RubberBand processor [libs/realtime-pitch-shift-processor.js](../libs/realtime-pitch-shift-processor.js)
- Fallback: original rubberband-web processor [libs/rubberband-processor.js](../libs/rubberband-processor.js)

### High/Low Watermark (Backlog) Management

Problem we hit:

- Using RubberBand realtime *tempo* (`timeRatio`) for time-stretch can create an **output backlog**.
- Speaker demand is fixed (128 frames per render quantum). But with time-stretch ratios, RubberBand can generate output in a way that grows internal/output buffering.
- Once buffers saturate, the system can degrade into silence or distortion.

Solution we implemented (current state):

- We do **not** time-stretch via RubberBand in the realtime worklet.
- Instead, Pitch&Time implements time-stretch by changing the SAB player playback speed.

Concretely:

- Tempo slider expresses **speed** $s$ (e.g. `1.25` = 125% faster playback).
- Internally, the engine converts to a “stretch factor” $r = 1/s$ (e.g. `1.25x speed` = `0.8x duration`).
- We set SAB playback rate to $s$.
- Because SAB rate changes pitch too, we compensate pitch in RubberBand:
    - `rubberbandPitch = basePitch / s` where `basePitch = 2^(semitones/12)`.

This behaves like a “watermark controller” because it removes the source of backlog entirely:

- output demand stays fixed
- the upstream source (SAB playback) produces exactly what is consumed
- RubberBand only needs to do pitch, not rate conversion that can backlog

Notes:

- This relies on fractional playback in the SAB worklet (linear interpolation), controlled via `CONTROL.PLAYBACK_RATE`.
- We added `setPlaybackRateRatio(rate)` to the SAB player on Windows so Pitch&Time can drive it directly.

### High Quality Mode

HQ toggle behavior:

- HQ is ON by default.
- Switching HQ recreates the RubberBand kernel inside the worklet.
- To prevent parameter resets, we reapply pitch/tempo after toggling.

### Stability Fixes (What We Changed)

Detached ArrayBuffer crash:

- Emscripten builds with `ALLOW_MEMORY_GROWTH=1`. When memory grows, existing `HEAPF32` views become detached.
- We fixed [libs/rubberband-wasm/src/wasm/HeapArray.ts](../libs/rubberband-wasm/src/wasm/HeapArray.ts) to rebuild `HEAPF32.subarray(...)` views on demand when the underlying heap buffer changes.

Window lifecycle cleanup (Electron hide vs unload):

- Closing secondary windows typically hides them; `beforeunload` does not run.
- Pitch&Time listens to `hide-window` and disposes the entire pipeline:
    - stop playback
    - dispose SAB player
    - disconnect RubberBand node
    - close the `AudioContext`
- On `show-window`, Pitch&Time recreates the engine and reapplies current UI params.

Race on reopen:

- Stage can send `show-window` and `pitchtime-file` back-to-back.
- We added an `engineInitPromise` gate so file loads cannot run until `engine.init()` has fully constructed the FFmpeg/SAB player.

## Build / Deploy (Forked RubberBand Worklet)

### Rebuild worklet bundle (TS → JS)

From repository root:

1. `cd libs/rubberband-wasm`
2. `npm run build:worklet`
3. Copy the bundle into SoundApp:
     - copy `libs/rubberband-wasm/public/realtime-pitch-shift-processor.js` → `libs/realtime-pitch-shift-processor.js`

### Rebuild WASM (only when C++ changes)

The fork is built with Emscripten and emits a single-file JS+WASM bundle used by the AudioWorklet.

Key build traits:

- `-s MODULARIZE=1 -s SINGLE_FILE=1`
- `-s ALLOW_MEMORY_GROWTH=1`
- exports `_malloc/_free`
- uses a post-JS hook [libs/rubberband-wasm/wasm/src/post-js/heap-exports.js](../libs/rubberband-wasm/wasm/src/post-js/heap-exports.js) to attach heap views to the returned module object

After rebuilding WASM, run the worklet rebuild again so webpack picks up the new `wasm/build/rubberband.js`.

## Reference Links

- [Web Audio API AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [Rubber Band Library](https://breakfastquay.com/rubberband/)
