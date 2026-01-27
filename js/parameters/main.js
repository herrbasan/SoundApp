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

    // Override the default close behavior from window-loader/nui_app if needed
    // But usually standard window-loader sends 'window-closed' and main process hides it.
    // The plan says "Window hides (doesn't destroy)".
    
    // Wire up sliders
    initAudioControls();
    initMidiControls();

    // Listen for file type / mode changes from stage
    bridge.on('set-mode', (data) => {
        setMode(data.mode); // 'audio', 'midi', 'tracker'
        if (data.params) {
            updateParams(data.mode, data.params);
        }
    });

    // Listen for parameter updates (e.g. from key commands in main window)
    bridge.on('update-params', (data) => {
        updateParams(currentMode, data);
    });

    // Initialize logic based on initial data (passed via window-loader)
    // window-loader usually sets window.init_data
    if (window.init_data) {
        g.init_data = window.init_data;
        if (window.init_data.mode) {
            setMode(window.init_data.mode);
        }
        if (window.init_data.params) {
            updateParams(window.init_data.mode || 'audio', window.init_data.params);
        }
    } else {
        // Default to audio if opened without context
        setMode('audio');
    }
    
    document.querySelector('main').classList.add('ready');
}

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
        if (params.soundfont) {
            const sfSelect = document.getElementById('soundfont-select');
            if (sfSelect) {
                sfSelect.value = params.soundfont;
                // Update superSelect visual if needed (usually dispatch change event handles logic, but simple value set needs manual update if custom UI used)
                 // If using specific library update method...
                 // Assuming native select value change is enough for now or superSelect handles it.
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
        // controls.midi.tempo.update(120); // Should reset to file original tempo? Need logic for that.
        bridge.sendToStage('midi-reset-params', {});
    });
    
    // SoundFont Selector
    const sfSelect = document.getElementById('soundfont-select');
    if (sfSelect) {
        superSelect(sfSelect);
        sfSelect.addEventListener('change', () => {
            bridge.sendToStage('param-change', { mode: 'midi', param: 'soundfont', value: sfSelect.value });
        });
        
        // Request available soundfonts from stage
        bridge.sendToStage('get-available-soundfonts', { windowId: bridge.windowId });
        bridge.on('available-soundfonts', (data) => {
            if (data.fonts && data.fonts.length) {
                const current = sfSelect.value;
                sfSelect.innerHTML = '';
                data.fonts.forEach(font => {
                    const option = document.createElement('option');
                    option.value = font.filename;
                    option.textContent = font.label;
                    sfSelect.appendChild(option);
                });
                sfSelect.value = current; // Restore selection if possible
             
                // Force UI update for superSelect
                const event = new Event('change', { bubbles: true });
                sfSelect.dispatchEvent(event);
            }
        });
    }
    
    document.getElementById('btn_open_fonts').addEventListener('click', () => {
        bridge.sendToStage('open-soundfonts-folder', {});
    });
}
