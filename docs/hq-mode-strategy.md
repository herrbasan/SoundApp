# SoundApp HQ Mode: Strategy to Restore “Max Sample Rate” (Dec 2025)

## Scope / intent
This document focuses only on restoring **real HQ mode** functionality: “HQ mode == higher output sample rate (up to device max) without pitch/speed bugs and without breaking gapless looping.”

It assumes the **current gapless-looping fixes remain** (time-based chunking, worklet telemetry, native EOF/resampler drain).

## Current state (today)
- **Native FFmpeg decoder output is fixed**: float32 stereo @ **44100 Hz**.
  - Implemented as `OUTPUT_SAMPLE_RATE = 44100` and libswresample conversion to 44100.
- SoundApp therefore creates the **AudioContext at 44100 Hz**.
- The UI “HQ mode” toggle currently **does not increase sample rate**; it mostly reinitializes the audio pipeline.

## Why HQ was disabled
The AudioWorklet streaming path is clocked by the **AudioContext sample rate**. When the PCM stream rate and AudioContext rate differ, you get **pitch/speed errors**.

So “AudioContext at 192k while native outputs 44.1k” is invalid unless something performs correct resampling in between.

## What changed that may make HQ viable again
The new time-based buffering (“Option A”) stabilizes queue time in seconds across sample rates. That removes the main structural reason HQ was fragile:
- Previously: fixed chunk frames ⇒ at 192k each chunk represented fewer milliseconds ⇒ less buffer time ⇒ underruns/crackle near loop transitions.
- Now: chunkFrames = round(sampleRate * chunkSeconds) ⇒ buffer time stays roughly constant even at high sample rates.

But this only helps if we can output PCM **at the chosen sample rate**.

## Design constraints (hard requirements)
- **Streaming path must output PCM at exactly the AudioContext sample rate**.
- **Gapless loop must remain sample-accurate** (no crossfade).
- Keep the current “submodule as source of truth” workflow.

## Strategy options

### Option 1 (recommended): Make native output sample rate configurable
**Idea:** Keep AudioWorklet streaming architecture. Add a native setting so FFmpeg decoding/resampling produces PCM at a caller-selected output rate (e.g. 48000/96000/192000). Then create the AudioContext at the same rate.

Pros:
- No extra resampling work in JS/worklet.
- Quality is handled by libswresample (battle-tested).
- Integrates cleanly with time-based chunk sizing.

Cons:
- Requires N-API API change and careful state handling on open/seek.

Implementation sketch:
- Native (`ffmpeg-napi-interface`):
  - Replace `OUTPUT_SAMPLE_RATE` constant with a per-instance `outputSampleRate`.
  - Add one of:
    - `new FFmpegDecoder({ outputSampleRate })`, or
    - `decoder.setOutputSampleRate(sr)` before `open()`, or
    - `open(filePath, { outputSampleRate })`.
  - In resampler init: set swr output rate to `outputSampleRate`.
  - Ensure `sampleBufferSize` scales with output rate (still “~1 second of audio” is fine).
  - On `seek()`: after `swr_close`, ensure `swr_init` uses the same `outputSampleRate`.
  - Expose `getSampleRate()` as `outputSampleRate` (not input).

- SoundApp (`js/stage.js`):
  - HQ mode determines the **target output rate**:
    - `targetRate = min(deviceMaxSupported, config.hqTargetRate?)`
    - Or “max supported” directly.
  - Create AudioContext with `{ sampleRate: targetRate }`.
  - Construct decoder/player so native output rate matches `targetRate`.

Recommended policy for choosing the rate:
- Simple and robust: `targetRate = g.config.hqMode ? g.maxSampleRate : 44100`.
- More nuanced (optional later): `targetRate = min(g.maxSampleRate, fileSampleRate)` to avoid upsampling 44.1k content.

### Option 2: Resample in the AudioWorklet (keep native at 44.1k)
**Idea:** Leave native output fixed at 44100 and upsample/downsample inside the worklet to the AudioContext rate.

Pros:
- No native API changes.

Cons:
- More CPU in JS/AudioWorklet; harder to do high-quality SRC.
- Higher risk of subtle drift or artifacts at loop boundaries.

This is viable but is the highest risk option for “gapless as USP”.

### Option 3: Switch HQ mode to a different playback engine (buffered)
**Idea:** For HQ only, decode full track to an `AudioBuffer` and play via `AudioBufferSourceNode`.

Pros:
- WebAudio handles resampling between buffer sample rate and AudioContext.

Cons:
- Not streaming (memory spikes), slower start, and gapless loop logic becomes a different code path.
- You now have two playback engines to keep correct.

## Recommended plan (Option 1)

### Phase A — Add configurable output rate in the native addon
- Add `outputSampleRate` to decoder instance.
- Use it in swr setup.
- Make sure `getSampleRate()` returns the output rate.

### Phase B — Wire through the streaming player
- Ensure the JS streaming player reads/assumes `audioContext.sampleRate` and uses it consistently.
- Time-based chunking already does this.

### Phase C — Restore HQ UI semantics
- When HQ is ON, the AudioContext is created at the desired rate.
- Update settings text to reflect “HQ = higher output sample rate” again.

### Phase D — Verify gapless loop matrix
Minimum tests:
- Formats: FLAC, WAV/AIFF, MP3, OGG
- Rates: 44.1k source, 48k source, 96k source
- Output rates: 44.1k, 96k, 192k (if supported)
- Actions: play→loop, seek→loop, loop after pause/resume

Success criteria:
- No pitch/speed changes.
- No early loop.
- No stalls after repeated seek/loop.
- No crackle at loop attributable to underrun.

## Notes / risk areas
- Resampler delay/drain is critical for formats with encoder delay or tail padding (FLAC-like cases). Keep the EOF drain logic.
- At very high rates (192k), the absolute throughput is high; time-based buffering helps, but we may still need to increase prebuffer seconds (not chunks) for safety.
- If we ever allow per-file target rates, we’ll recreate AudioContext more often; that’s OK but needs careful state restore.
