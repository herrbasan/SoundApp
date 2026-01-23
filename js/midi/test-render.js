// Quick diagnostic - check what FluidSynth is actually rendering
const context = new AudioContext({ sampleRate: 48000 });
console.log('Context SR:', context.sampleRate);

import { MidiPlayer } from './midi.js';
const player = new MidiPlayer({ context });
await player.init();

console.log('Synth initialized');
console.log('Synth object:', player.synth);
console.log('AudioNode:', player.audioNode);

// Check if we can inspect settings
if (player.synth && player.synth._settings) {
    console.log('Settings handle:', player.synth._settings);
}
