# Pitch and Time Manipulation in SoundApp

The Pitch/Time window is a dedicated UI pane that runs an isolated audio pipeline. It will use a **fixed 48 kHz AudioContext**
so its pipeline is self-contained and independent of the main player sample-rate setting.

Both pitch/time backends will live **only in the dedicated window**:
1. **FFmpeg Native Implementation** (baseline)
2. **Web Audio WASM Implementation** (higher quality, preferred for testing)

---

## FFmpeg Native Implementation

### Architecture

```
Audio File → FFmpeg Decoder (C++) → Rubberband Filter (R2) → Resampler (48 kHz) → SAB Ring Buffer → AudioWorklet → Output
                                           ↑
                                    Limited to tempo + pitch params
```

### Implementation Details

**Location:** `libs/ffmpeg-napi-interface/`

**Key Files (future placement for dedicated window):**
- `html/pitchtime.html` - New window shell (NUI layout)
- `css/pitchtime.css` - Window styling
- `js/pitchtime/main.js` - Window UI + pipeline control
- `js/pitchtime/pitchtime_engine.js` - Dedicated pitch/time pipeline
- `libs/ffmpeg-napi-interface/src/*` - FFmpeg filter graph infrastructure

**Filter Graph Setup:**

The decoder creates an FFmpeg filter graph with the rubberband filter:

```cpp
// initFilters() in decoder.cpp
filterGraph = avfilter_graph_alloc();

// Create buffer source (abuffer)
snprintf(args, sizeof(args),
    "time_base=%d/%d:sample_rate=%d:sample_fmt=%s:channel_layout=stereo",
    1, codecCtx->sample_rate,
    codecCtx->sample_rate,
    av_get_sample_fmt_name(codecCtx->sample_fmt));

avfilter_graph_create_filter(&bufferSrcCtx, bufferSrc, "in", args, nullptr, filterGraph);

// Create rubberband filter
double pitchRatio = pow(2.0, pitchShift / 12.0);
snprintf(rubberbandArgs, sizeof(rubberbandArgs), 
    "tempo=%f:pitch=%f", timeStretch, pitchRatio);

avfilter_graph_create_filter(&currentFilter, rubberband, "rubberband",
                              rubberbandArgs, nullptr, filterGraph);

// Link: abuffer → rubberband → abuffersink
avfilter_link(bufferSrcCtx, 0, currentFilter, 0);
avfilter_link(currentFilter, 0, bufferSinkCtx, 0);
avfilter_graph_config(filterGraph, nullptr);
```

**PTS Synchronization Fix:**

Critical discovery: Rubberband requires monotonic sample-based PTS for temporal continuity.

```cpp
// Before pushing frames to filter
frame->pts = filterPts;
filterPts += frame->nb_samples;

// Reset on seek or parameter changes
filterPts = 0;
```

Without proper PTS, rubberband treats each frame as a discontinuity, causing "blurp" artifacts (original-pitch transients) when pitching up.

**Buffer Management:**

When pitch/time changes, three levels of buffers must be flushed:

1. **Codec buffers** - `avcodec_flush_buffers(codecCtx)`
2. **Frame data** - `av_frame_unref(frame)` and `av_frame_unref(filteredFrame)`
3. **Resampler** - `swr_close()` + `swr_init()`
4. **SAB ring buffer** - Set read_ptr = write_ptr to discard buffered audio
5. **Filter graph** - Drain via NULL frame before rebuilding

```cpp
// closeFilters() drains filter before teardown
av_buffersrc_add_frame_flags(bufferSrcCtx, nullptr, 0);  // Signal EOF
while (av_buffersink_get_frame(bufferSinkCtx, drainFrame) >= 0) {
    av_frame_unref(drainFrame);  // Discard stale frames
}
```

**Controls:**

All pitch and time controls are exposed exclusively through the dedicated window UI.

---

## Web Audio WASM Implementation

### Architecture

```
Audio File → FFmpeg Decoder (C++) → SAB Ring Buffer → AudioWorklet (Rubberband WASM) → Output
                                                              ↑
                                                  Full R3 quality control
```

### Implementation Plan

**1. Package Selection:**

Use `rubberband-web` (AudioWorklet wrapper) instead of raw `rubberband-wasm`:

```bash
npm install rubberband-web
```

**2. Rubber Band Worklet Notes:**

- Use explicit stereo settings when creating the AudioWorkletNode:
    - `numberOfInputs: 1`, `numberOfOutputs: 1`
    - `channelCount: 2`, `channelCountMode: 'explicit'`, `channelInterpretation: 'speakers'`
    - `outputChannelCount: [2]`
- Pass `processorOptions` to set initial params:
    - `numSamples` (128 normal, 256 for HQ tests)
    - `highQuality`, `pitch`, `tempo`
- Control messages are JSON strings (rubberband-web expects stringified payloads).

**3. Dedicated Window Controls:**

All pitch/time UI (including quality mode) will live inside the dedicated window and will not
share settings with the main player.

---
## Recommendation

**For SoundApp:**

1. **Keep pitch/time in a dedicated window** to preserve main playback stability.
2. **Prefer WASM Rubber Band** in that window.
3. **No explicit upsampling** in the dedicated window. Keep the entire pitch/time pipeline at fixed 48 kHz and let the OS handle any device resampling.

**No fallback policy:**

The dedicated window should fail explicitly if the selected engine cannot run. Do not add fallback or degraded modes
until a production-ready decision is made.

---

## References

- [Rubber Band Library](https://breakfastquay.com/rubberband/)
- [rubberband-wasm on GitHub](https://github.com/Daninet/rubberband-wasm)
- [rubberband-web on GitHub](https://github.com/delude88/rubberband-web)
- [Phase Vocoder Theory](https://sethares.engr.wisc.edu/vocoders/phasevocoder.html)
- [Web Audio API AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
