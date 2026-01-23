# MIDI Playback Implementation

## Overview
MIDI playback is **fully integrated and working** using js-synthesizer (AudioWorkletNodeSynthesizer) with FluidSynth WASM.

### Current Structure
```
libs/
	midiplayer/
		js-synthesizer.js           # Main ES6 module
		js-synthesizer.worklet.js   # AudioWorklet processor
		libfluidsynth.js            # WASM glue code + embedded binary
js/
	midi/
		midi.js                     # AudioWorklet-based MIDI player wrapper
```

## Implementation Status: COMPLETE ✓

- ✓ **High-quality synthesis** using FluidSynth engine
- ✓ **AudioWorklet-based rendering** for low-latency playback
- ✓ **SoundFont support** (SF2 and SF3 formats)
- ✓ **Full playback control** - play, pause, seek, loop
- ✓ **Live seeking** - seek while playing (no restart)
- ✓ **Duration calculation** with FluidSynth quirk workaround
- ✓ **Volume control** integrated with SoundApp's audio system
- ✓ **Time tracking** for UI progress bar

## Critical Implementation Details

### Sample Rate Handling (HQ Mode Support)
**Problem:** FluidSynth's WASM build only supports sample rates up to 96kHz, but SoundApp's HQ mode can use 192kHz.

**Solution:** Automatic resampling chain when main AudioContext > 96kHz:
```javascript
// Create separate 96kHz AudioContext for FluidSynth
midiContext = new AudioContext({ sampleRate: 96000 });

// Resample to main context via MediaStream
resampler = midiContext.createMediaStreamDestination();
gain.connect(resampler);
resamplerSource = mainContext.createMediaStreamSource(resampler.stream);
resamplerSource.connect(mainContext.destination);
```

This allows MIDI playback at any HQ mode sample rate (96k, 176.4k, 192k) with transparent resampling.

### FluidSynth Duration Quirk
**Problem:** `retrievePlayerTotalTicks()` returns 0 until playback actually starts.

**Solution:**
```javascript
// Briefly start playback to trigger MIDI parsing
await synth.playPlayer();
// Poll until totalTicks is non-zero (max 100ms)
for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    totalTicks = await synth.retrievePlayerTotalTicks();
    if (totalTicks > 0) break;
}
synth.stopPlayer();
// Save duration BEFORE resetting player
duration = totalTicks / 1000; // ticks are in milliseconds
// Reset player to clear "stopped" state for actual playback
await synth.resetPlayer();
await synth.addSMFDataToPlayer(arrayBuffer);
```

### Metronome Implementation (Glitch-Free)
**Problem:** FluidSynth resets all channel volumes to 100 (Max) when `resetPlayer()` is called. If the metronome track is generated with notes but muted via code, there's a race condition where the first tick plays before the mute command takes effect, causing a "single click" artifact on start.

**Solution:**
1. **Silent Generation:** The metronome track is generated with explicit **CC7 (Volume) = 0** and **CC11 (Expression) = 0** events at **Tick 0**.
2. **Logic Override:** The track defaults to silent. To enable it, we send `CC7=127` *after* playback starts.
3. **Strict Persistence:** The feature is forcibly disabled (`metronomeEnabled = false`) on every new file load to prevent unexpected clicking.

### Transposition & Speed
- **Pitch Shift:** Implemented via `hookPlayerMIDIEventsByName` to intercept NoteOn events in the AudioWorklet. This allows shifting note numbers directly rather than resampling the audio, preserving the drum channel (Ch. 10) pitch.
- **Playback Speed:** Uses `synth.setPlayerTempo()` (ExternalBPM mode for >4.0 values, Internal multiplier for <4.0).
- **Sticky Settings:** When the MIDI Settings window is open, pitch/speed persist across tracks. When closed, they reset to default (0 pitch, 1.0 speed).

### Seeking Behavior
- **Supports live seeking** - can seek while playing without stopping
- **Tick unit is milliseconds** - `seekPlayer(seconds * 1000)`
- **No stop/resume needed** - FluidSynth handles in-place seeking

### Event Handler Timing
- `waitForPlayerStopped()` must be called **when playback starts**, not during load
- Calling it during load causes immediate resolution from the duration check playback

## Supported Formats
- `.mid` - Standard MIDI files
- `.midi` - Standard MIDI files
- `.kar` - Karaoke MIDI files
- `.rmi` - RIFF MIDI files

## Architecture

### MIDI Controller (`js/midi_controller.js`)
Encapsulates js-synthesizer functionality:
- Lazy initialization (only loads when MIDI file is played)
- SoundFont loading from `bin/soundfonts/default.sf2`
- AudioWorklet-based synthesis
- Event callbacks for playback end

### Integration (`js/stage.js`)
MIDI integration is active in `js/stage.js`.
- **Initialization**: `initMidiPlayer()` called on startup.
- **File Support**: `.mid`, `.midi`, `.kar`, `.rmi` extensions added to supported list.
- **Playback**: Integrated into `playAudio()`, `pauseAudio()`, `stopAudio()`, etc.
- **SoundFonts**: Reloads automatically when configuration changes.

## SoundFont Configuration

**Active soundfont:** `bin/soundfonts/TimGM6mb.sf2` (6 MB, General MIDI compatible)

Alternative soundfonts in `bin/soundfonts/`:
- `VintageDreamsWaves-v2.sf2` (314 KB) - Compact, causes ROM sample issues
- `FluidR3Mono_GM.sf3` (14 MB) - Downloaded but not tested

### Known FluidSynth Warnings (Harmless)
```
fluidsynth: error: function fluid_file_test is a stub, always returning true
fluidsynth: error: function fluid_stat is a stub, always returning -1
fluidsynth: Ignoring unrecognized meta event type 0x21
```
These are expected in WASM environment - FluidSynth doesn't need filesystem access, and meta event 0x21 is non-standard MIDI metadata. Cannot be suppressed without recompiling FluidSynth.

## Playback Flow

1. **File detection** - `stage.js` checks extension against `g.supportedMIDI`
2. **Controller init** - First MIDI load initializes AudioWorkletNodeSynthesizer
3. **Soundfont load** - `ensureSoundfontLoaded()` via fetch() + loadSFont()
4. **MIDI load** - `load(fileURL)` → fetch() → addSMFDataToPlayer()
5. **Duration workaround** - Briefly play to trigger parsing, capture totalTicks, reset
6. **Playback** - `play()` calls `playPlayer()` + sets up `waitForPlayerStopped()`
7. **Time tracking** - `updateTime()` via `retrievePlayerCurrentTick()`
8. **Seeking** - `seekPlayer()` works live during playback
9. **End handling** - `waitForPlayerStopped()` triggers onEnded or loop

## Known Limitations

1. **Duration calculation overhead** - Requires brief playback start (~100ms) on load
2. **FluidSynth max sample rate** - 96kHz internal (resampled to higher rates if needed)
3. **Console warnings** - FluidSynth WASM stub warnings cannot be suppressed
4. **Memory** - Larger soundfonts (>100MB) may impact startup time

## Performance

- **Initialization:** ~200ms (first MIDI file only, includes soundfont load)
- **Track switching:** ~100ms (includes duration workaround)
- **Seeking:** Instant (live seek while playing)
- **CPU usage:** ~2-5% (AudioWorklet rendering)
- **Memory:** ~10MB (synth) + soundfont size (~6MB for TimGM6mb)

## Future Enhancements

- [ ] Settings UI for reverb/chorus levels
- [ ] Multiple soundfont selection
- [ ] MIDI channel visualization
- [ ] Karaoke lyrics display (.kar files)
- [ ] MIDI export/recording functionality
- [ ] Per-instrument volume mixing

## Dependencies

- **js-synthesizer** (MIT) - AudioWorklet-based synthesizer
- **FluidSynth** (LGPL v2.1) - Synthesis engine (WASM)
- **default.sf2** (Permissive) - GeneralUser GS SoundFont

## References

- [js-synthesizer on GitHub](https://github.com/jet2jet/js-synthesizer)
- [FluidSynth Documentation](https://www.fluidsynth.org/)
- [SoundFont specification](https://en.wikipedia.org/wiki/SoundFont)
