# MIDI Playback - Implementation Summary

## Status

MIDI playback integration is **fully implemented and active**. The solution uses **js-synthesizer (AudioWorkletNodeSynthesizer) + FluidSynth WASM** loaded as ES6 modules.

### Current Structure
\\\	ext
libs/
midiplayer/
js-synthesizer.js          (Main ES6 entry point)
js-synthesizer.worklet.js  (AudioWorklet)
		libfluidsynth.js           (WASM glue code + embedded binary)
js/
midi/
midi.js                    (SoundApp-specific wrapper/controller)
midi.worklet.js            (Additional worklet logic if any)
\\\`n
## Files Created

1. **js/midi/midi.js**
   - MidiPlayer class for SoundApp
   - Handles AudioContext management and node connection
   - Manages SoundFont loading and initialization
   - Provides transport controls (play, pause, stop, seek)

2. **bin/soundfonts/**
   - Directory containing .sf2 soundfont files
   - Default: default.sf2 (GeneralUser GS)

3. **scripts/patch-midiplayer-worklet.js**
   - Copies js-synthesizer bundles from node_modules
   - Patches worklet files to inject metronome hook

## Files Modified

### html/stage.html
- Imports MidiPlayer from ../js/midi/midi.js module
- Exposes window.midi for stage.js access

### js/stage.js
- Checks for window.midi availability
- Initializes MIDI player via initMidiPlayer()
- Handles file association logic for .mid, .midi, .kar, .rmi
- Manages playback state switching between FFmpeg, Tracker, and MIDI engines
- Reacts to midi-soundfont-changed events to reload the player

### libs/midiplayer/libfluidsynth.js
- Modified to suppress fluid_file_test stub warnings via Module.printErr override.
