# Pitch and Time Manipulation in SoundApp

This document now focuses on a **dedicated Pitch/Time window** (similar to Mixer) that hosts an isolated pipeline.
Pitch/time processing is **removed from the main player** to keep core playback stable and predictable. The main
window retains the **tape-style speed control** only. The Pitch/Time window will use a **fixed 48 kHz AudioContext**
so its pipeline is self-contained and independent of the main player sample-rate setting.

Two pitch/time backends are still relevant, but they will live **only in the dedicated window**:
1. **FFmpeg Native Implementation** (baseline)
2. **Web Audio WASM Implementation** (higher quality, preferred for testing)

---

## FFmpeg Native Implementation (Dedicated Window Only)

### Architecture

```
Audio File → FFmpeg Decoder (C++) → Rubberband Filter (R2) → Resampler → SAB Ring Buffer → AudioWorklet → Output
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

**Keyboard Shortcuts:**

Pitch/time shortcuts are removed from the main window. The dedicated window will define its own
shortcuts and UI controls.

### Limitations

**Quality:**
- Restricted to Rubberband R2 (Faster) engine
- No access to R3 (Finer) engine
- Cannot configure quality options:
  - No formant preservation control
  - No transients handling (crisp/mixed/smooth)
  - No window size control (standard/short/long)
  - No detector options (compound/percussive/soft)
  - No pitch quality modes (high-speed/high-quality/high-consistency)

**FFmpeg Filter Exposure:**

FFmpeg's rubberband filter only exposes `tempo` and `pitch` parameters. The underlying Rubber Band Library has extensive options that are compiled into the filter but not exposed through FFmpeg's option interface.

### Performance

- Real-time capable for moderate pitch shifts (±6 semitones)
- CPU usage similar to native FFmpeg filtering
- Latency: ~15-30ms (FFmpeg decoding + filter + ring buffer)
- Memory: Minimal overhead (filter graph + ring buffer)

### Quality Assessment

- **Moderate shifts (±3 st):** Acceptable for preview/reference
- **Large shifts (±6+ st):** Noticeable graininess, artifacts
- **Vocal material:** Formant shifting creates "chipmunk" effect
- **Percussive material:** Generally good, transient preservation works

---

## Web Audio WASM Implementation (Dedicated Window Only)

### Architecture

```
Audio File → FFmpeg Decoder (C++) → SAB Ring Buffer → AudioWorklet (Rubberband WASM) → Output
                                                              ↑
                                                  Full R3 quality control
```

### Why WASM?

**Quality advantages:**
- Access to Rubberband R3 (Finer) engine - significantly better quality
- Full control over quality parameters
- Formant preservation for natural vocal pitch shifts
- Better transient handling
- Configurable window sizes for quality/latency trade-off

**Integration advantages:**
- Keeps FFmpeg for decoding (fast, all formats supported)
- Moves filtering to Web Audio (better browser integration)
- Simpler buffer management (AudioWorklet native)
- Lower overall latency (no native↔JS bridge for filtering)

### Implementation Plan

**1. Package Selection:**

Use `rubberband-web` (AudioWorklet wrapper) instead of raw `rubberband-wasm`:

```bash
npm install rubberband-web
```

**2. File Structure (Dedicated Window):**

```
html/pitchtime.html
css/pitchtime.css
js/pitchtime/main.js
js/pitchtime/pitchtime_engine.js
bin/win_bin/rubberband-processor.js  (copied from node_modules)
```

**3. Dedicated Window Pipeline:**

```javascript
// pitchtime_engine.js - dedicated architecture
// FFmpeg decode -> SAB -> (optional) WASM Rubber Band -> output
// All pitch/time logic is isolated from the main player.
```

**4. Dedicated Window Controls:**

All pitch/time UI (including quality mode) will live inside the dedicated window and will not
share settings with the main player.

### Expected Quality Improvements

**Formant Preservation:**
- Natural vocal pitch shifts (no "chipmunk" effect)
- Maintains vocal character across pitch range
- Critical for music with vocals

**Better Transient Handling:**
- Preserves percussive attacks
- Less smearing on drums/percussion
- Configurable detector modes (compound/percussive/soft)

**Reduced Artifacts:**
- Less graininess at extreme pitch shifts (±12 st)
- Smoother time stretching
- Better phase coherence

**Configurable Quality:**
- R3 Finer engine for complex material
- Window size control (standard/short/long)
- CPU vs quality trade-off

### Performance Considerations

**Bundle Size:**
- WASM binary: ~5-10MB (gzipped: ~2-3MB)
- One-time download, cached by browser
- Acceptable for desktop app

**CPU Usage:**
- R3 engine: 2-3x more CPU than R2
- High quality mode: Additional 20-30% overhead
- Still real-time capable on modern hardware
- Settings toggle lets users choose quality vs performance

**Latency:**
- AudioWorklet runs on audio thread (deterministic)
- Lower than FFmpeg approach (~5-10ms vs ~15-30ms)
- Configurable via window size (short = lower latency)

**Memory:**
- WASM heap allocation (~10-30MB)
- Browser handles GC
- No manual memory management needed

### New Development Plan (Dedicated Window)

**Phase 1: Add Pitch/Time Window**
- Create `html/pitchtime.html` with NUI chrome
- Add `js/pitchtime/main.js` and `js/pitchtime/pitchtime_engine.js`
- Wire window open/close in `stage.js` (shortcut TBD)
- Keep all pitch/time UI and engine logic isolated here

**Phase 2: Implement WASM Pipeline in the Window**
- Use `rubberband-web` worklet inside the dedicated window
- Use a specialized buffer strategy (optional resample path)
- Allow toggling FFmpeg vs WASM inside the window only

**Phase 3: Main Player Cleanup**
- Remove main-window pitch/time settings and shortcuts (done)
- Keep tape-style speed control intact

### Licensing Considerations

**Current Status:**
- FFmpeg: GPL (compatible with SoundApp)
- Rubber Band Library: GPL / Commercial

**WASM Addition:**
- `rubberband-web`: GPL
- No change to licensing status
- Already GPL-compliant via FFmpeg

**If going commercial:**
- Need Rubber Band commercial license
- Applies to both FFmpeg and WASM implementations
- One license covers both

### Testing Strategy

**Quality Tests:**
1. Vocal material: ±6 st pitch shift, check formant preservation
2. Percussive: ±6 st, check transient clarity
3. Time stretch: 0.5x, 2.0x on complex mixes
4. Extreme shifts: ±12 st on various material

**Performance Tests:**
1. CPU usage: Monitor at various quality settings
2. Latency: Measure end-to-end with system audio tools
3. Memory: Check WASM heap size over time
4. Real-time stability: Long playback sessions

**Compatibility Tests:**
1. Fixed 48 kHz playback at multiple file input rates
2. Different audio formats (MP3, FLAC, WAV, etc.)
3. Different buffer sizes in the dedicated window
4. Seek during pitch/time manipulation

---

## Comparison Matrix

| Feature | FFmpeg Native | WASM Rubberband |
|---------|---------------|-----------------|
| **Quality (±3 st)** | Good | Excellent |
| **Quality (±6+ st)** | Fair | Good |
| **Formant preservation** | No | Yes (R3) |
| **Transient handling** | Basic | Configurable |
| **Window control** | No | Yes |
| **CPU usage** | Low | Medium (configurable) |
| **Latency** | 15-30ms | 5-10ms |
| **Bundle size** | Native (0KB JS) | ~5-10MB WASM |
| **Maintainability** | C++ build required | npm package |
| **Quality options** | None | Extensive |
| **Real-time** | Yes | Yes |
| **License** | GPL | GPL |

---

## Recommendation

**For SoundApp:**

1. **Keep pitch/time in a dedicated window** to preserve main playback stability.
2. **Prefer WASM Rubber Band** in that window for quality testing.
3. **Optional resample path** for 192kHz contexts (downsample → process → upsample).
4. **Keep tape-style speed** in main window only.

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
