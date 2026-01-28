import ut from '../../libs/nui/nui_ut.js';
import superSelect from '../../libs/nui/nui_select.js';
import dragSlider from '../../libs/nui/nui_drag_slider.js';

window.ut = ut;
window.superSelect = superSelect;
ut.dragSlider = dragSlider;

let bridge;
let g = {
    init_data: null
};

let currentMode = 'audio';
const controls = {
    audio: {},
    midi: {}
};

// --- Initialization ---

async function init() {
    if (window.bridge) {
        bridge = window.bridge;
    } else {
        console.warn('Bridge not found, running in browser preview mode?');
        // Mock bridge for testing if needed
        bridge = {
            on: (ch, cb) => {},
            sendToStage: (ch, data) => console.log('Mock IPC:', ch, data),
            once: (ch, cb) => {}, 
            window: { 
                close: () => {}, 
                hide: () => {} // In this window, close means hide
            }
        };
    }

    // Wire up sliders
    initAudioControls();
    initMidiControls();

    // Listen for file type / mode changes from stage
    bridge.on('set-mode', (data) => {
        setMode(data.mode); // 'audio', 'midi', 'tracker'
        
        // Display original BPM for MIDI mode
        if (data.mode === 'midi' && data.params && typeof data.params.originalBPM === 'number') {
            const origElem = document.getElementById('midi_original_bpm');
            if (origElem) origElem.textContent = `(Original: ${Math.round(data.params.originalBPM)})`;
            // Set the default value for the tempo slider
            if (controls.midi && controls.midi.tempo && controls.midi.tempo.setDefault) {
                controls.midi.tempo.setDefault(Math.round(data.params.originalBPM));
            }
        }
        
        if (data.params) {
            updateParams(data.mode, data.params);
        }
    });

    // Listen for parameter updates (e.g. from key commands in main window)
    bridge.on('update-params', (data) => {
        updateParams(currentMode, data);
    });
    
    document.querySelector('main').classList.add('ready');
}

// Wait for bridge-ready event which provides init_data
window.addEventListener('bridge-ready', async (e) => {
    const data = e.detail;
    g.init_data = data;
    console.log('[Parameters] bridge-ready, init_data received:', data);
    
    // Initialize soundfont selector now that we have init_data
    await initSoundfontSelector();
    
    if (data.mode) {
        console.log('[Parameters] Setting mode:', data.mode);
        setMode(data.mode);
    }
    
    // Display original BPM for MIDI mode
    if (data.mode === 'midi' && typeof data.originalBPM === 'number') {
        const origElem = document.getElementById('midi_original_bpm');
        if (origElem) origElem.textContent = `(Original: ${Math.round(data.originalBPM)})`;
        // Set the default value for the tempo slider
        if (controls.midi && controls.midi.tempo && controls.midi.tempo.setDefault) {
            controls.midi.tempo.setDefault(Math.round(data.originalBPM));
        }
    }
    
    if (data.params) {
        console.log('[Parameters] Updating params:', data.params);
        updateParams(data.mode || 'audio', data.params);
    }
});

// Ensure DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


// --- Logic ---

function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-container').forEach(el => el.classList.remove('active'));
    
    const target = document.getElementById(`${mode}-controls`);
    if (target) {
        target.classList.add('active');
    }
}

function updateParams(mode, params) {
    if (mode === 'audio') {
        if (typeof params.pitch !== 'undefined') {
            controls.audio.pitch.update(params.pitch, true);
            // Update text display
            const pitchVal = document.getElementById('audio_pitch_value');
            const rounded = Math.round(params.pitch);
            if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        }
        if (typeof params.tempo !== 'undefined') {
            controls.audio.tempo.update(params.tempo, true);
            // Update text display
            const tempoVal = document.getElementById('audio_tempo_value');
            const pct = Math.round(params.tempo * 100);
            if (tempoVal) tempoVal.textContent = pct;
        }
    } else if (mode === 'midi') {
        if (typeof params.transpose !== 'undefined') controls.midi.pitch.update(params.transpose, true);
        if (typeof params.bpm !== 'undefined') controls.midi.tempo.update(params.bpm, true);
        if (typeof params.metronome !== 'undefined') {
            document.getElementById('btn_metronome').checked = !!params.metronome;
        }
        // Display original BPM beside the Tempo label
        if (g.init_data && typeof g.init_data.originalBPM === 'number') {
            const origElem = document.getElementById('midi_original_bpm');
            if (origElem) origElem.textContent = `(Original: ${Math.round(g.init_data.originalBPM)})`;
            // Set the default value for the tempo slider
            if (controls.midi.tempo && controls.midi.tempo.setDefault) {
                controls.midi.tempo.setDefault(Math.round(g.init_data.originalBPM));
            }
        }
        if (params.soundfont) {
            const sfSelect = document.getElementById('soundfont-select');
            if (sfSelect) {
                sfSelect.value = params.soundfont;
                // Trigger superSelect update by finding and clicking the matching option in the custom UI
                const customSelect = sfSelect.parentElement.querySelector('.nui-select-display');
                if (customSelect) {
                    // Find the selected option's text
                    const selectedOption = sfSelect.options[sfSelect.selectedIndex];
                    if (selectedOption) {
                        customSelect.textContent = selectedOption.textContent;
                    }
                }
            }
        }
    }
}

function createSlider(containerId, min, max, initial, defaultVal, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    
    const handle = container.querySelector('.handle');
    const track = container.querySelector('.track');
    let value = initial;

    function update(v, skipCallback = false) {
        value = Math.max(min, Math.min(max, v));
        const percent = (value - min) / (max - min);
        handle.style.left = (percent * 100) + '%';
        if (!skipCallback && onChange) onChange(value);
    }

    update(initial, true);

    if (ut && ut.dragSlider) {
        ut.dragSlider(container, (e) => {
            update(min + e.prozX * (max - min));
        }, -1, track);
    }
    
    container.addEventListener('dblclick', () => {
        update(defaultVal);
    });
    
    return { update, getValue: () => value, setDefault: (v) => { defaultVal = v; } };
}

function initAudioControls() {
    const pitchVal = document.getElementById('audio_pitch_value');
    controls.audio.pitch = createSlider('audio_pitch_slider', -12, 12, 0, 0, (v) => {
        const rounded = Math.round(v);
        if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        bridge.sendToStage('param-change', { mode: 'audio', param: 'pitch', value: rounded });
    });

    const tempoVal = document.getElementById('audio_tempo_value');
    controls.audio.tempo = createSlider('audio_tempo_slider', 0.5, 1.5, 1.0, 1.0, (v) => {
        // v is 0.5 to 1.5
        const pct = Math.round(v * 100);
        if (tempoVal) tempoVal.textContent = pct;
        bridge.sendToStage('param-change', { mode: 'audio', param: 'tempo', value: v });
    });

    document.getElementById('btn_audio_reset').addEventListener('click', () => {
        controls.audio.pitch.update(0);
        controls.audio.tempo.update(1.0);
        
        // Reset pipeline to normal? Maybe not, keep user preference.
    });
}

function initMidiControls() {
    const pitchVal = document.getElementById('midi_pitch_value');
    controls.midi.pitch = createSlider('midi_pitch_slider', -12, 12, 0, 0, (v) => {
        const rounded = Math.round(v);
        if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        bridge.sendToStage('param-change', { mode: 'midi', param: 'transpose', value: rounded });
    });

    const tempoVal = document.getElementById('midi_tempo_value');
    // MIDI TEMPO range 40-240
    controls.midi.tempo = createSlider('midi_tempo_slider', 40, 240, 120, 120, (v) => {
        const rounded = Math.round(v);
        if (tempoVal) tempoVal.textContent = rounded;
        bridge.sendToStage('param-change', { mode: 'midi', param: 'bpm', value: rounded });
    });

    document.getElementById('btn_metronome').addEventListener('change', (e) => {
        bridge.sendToStage('param-change', { mode: 'midi', param: 'metronome', value: e.target.checked });
    });

    document.getElementById('btn_midi_reset').addEventListener('click', () => {
        controls.midi.pitch.update(0);
        // Reset tempo to original BPM
        const originalBPM = (g.init_data && g.init_data.originalBPM) ? Math.round(g.init_data.originalBPM) : 120;
        controls.midi.tempo.update(originalBPM);
        bridge.sendToStage('midi-reset-params', {});
    });
    
    document.getElementById('btn_open_fonts').addEventListener('click', () => {
        bridge.sendToStage('open-soundfonts-folder', {});
    });
}

async function initSoundfontSelector() {
    const sfSelect = document.getElementById('soundfont-select');
    if (!sfSelect) return;
    
    // Get current soundfont from init_data (will be set by bridge-ready event)
    const getCurrentFont = () => (g.init_data && g.init_data.params && g.init_data.params.soundfont) || 'TimGM6mb.sf2';
    
    console.log('[SoundFont] Requesting available soundfonts, windowId:', bridge.windowId);
    
    // Get list of available soundfonts from stage
    const availableFonts = await new Promise((resolve) => {
        bridge.sendToStage('get-available-soundfonts', { windowId: bridge.windowId });
        bridge.once('available-soundfonts', (data) => {
            console.log('[SoundFont] Received available soundfonts:', data);
            resolve(data.fonts || []);
        });
    });
    
    // Populate dropdown with available fonts
    if (availableFonts.length > 0) {
        sfSelect.innerHTML = '';
        availableFonts.forEach(font => {
            const option = document.createElement('option');
            option.value = font.filename;
            option.textContent = font.label;
            sfSelect.appendChild(option);
        });
    }
    
    // Set current value before initializing superSelect
    const currentFont = getCurrentFont();
    sfSelect.value = currentFont;
    console.log('[SoundFont] Set select value to:', currentFont, 'selectedIndex:', sfSelect.selectedIndex);
    
    // Ensure something is selected
    if (sfSelect.selectedIndex === -1 && sfSelect.options.length > 0) {
        console.warn('[SoundFont] Configured soundfont not found, defaulting to first option');
        sfSelect.selectedIndex = 0;
    }
    
    // Initialize nui-select
    console.log('[SoundFont] Calling superSelect()');
    superSelect(sfSelect);
    
    // Force update the visual state of the select
    const event = new Event('change', { bubbles: true });
    sfSelect.dispatchEvent(event);
    
    // Listen for changes
    sfSelect.addEventListener('change', () => {
        const newFont = sfSelect.value;
        console.log('[SoundFont] Changed to:', newFont);
        bridge.sendToStage('param-change', { mode: 'midi', param: 'soundfont', value: newFont });
    });
}
