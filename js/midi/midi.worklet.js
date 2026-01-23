AudioWorkletGlobalScope.SoundAppMidiHook = function (s, type, event, data) {
	// data is transpose semitones (provided via param)
	if (data && typeof data === 'number') {
		// NOTE_ON = 144 (0x90), NOTE_OFF = 128 (0x80) on MIDI channel 0-15
		// FluidSynth event type returns standard MIDI status byte (without channel part usually, but typically 0x90/0x80)
		if (type === 144 || type === 128) {
			// Skip drum channel (Channel 10, index 9)
			if (event.getChannel() !== 9) { 
				let key = event.getKey();
				key += data;
				// Clamp to valid MIDI range
				if(key < 0) key = 0;
				if(key > 127) key = 127;
				event.setKey(key);
			}
		}
	}
	return false;
};
