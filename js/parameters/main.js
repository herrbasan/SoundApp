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
let audioMode = 'tape'; // 'tape' or 'pitchtime'
const controls = {
    audio: {},
    tape: {},
    midi: {}
};

// Debounce timers for parameter changes (30ms prevents crackling)
let tapeSpeedTimeout = null;
let audioPitchTimeout = null;
let audioTempoTimeout = null;
let midiPitchTimeout = null;
let midiTempoTimeout = null;

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
    initTapeControls();
    initAudioControls();
    initMidiControls();
    initAudioModeSections();

    // NOTE: Do NOT reset params when window is hidden
    // Parameters should persist between hide/show cycles
    // Only reset when a new track loads (via set-mode event)

    window.addEventListener('keydown', (e) => {
        if (!e) return;
        if (shouldIgnoreKeyTarget(e.target || e.srcElement)) return;

        const code = '' + (e.code || '');

        // P: toggle Parameters window (hide when already open)
        if (e.keyCode === 80) {
            e.preventDefault();
            if (bridge && bridge.closeWindow) bridge.closeWindow();
            else if (bridge && bridge.window && bridge.window.hide) bridge.window.hide();
            return;
        }

        // F12: Toggle DevTools
        if (code === 'F12') {
            e.preventDefault();
            if (window.bridge && window.bridge.toggleDevTools) window.bridge.toggleDevTools();
            return;
        }

        // Handle global shortcuts via shared module
        if (window.shortcuts && window.shortcuts.handleShortcut) {
            const action = window.shortcuts.handleShortcut(e, 'parameters');
            if (action) return;
        }

        if (bridge && bridge.sendToStage) {
            bridge.sendToStage('stage-keydown', {
                keyCode: e.keyCode | 0,
                code: e.code || '',
                key: e.key || '',
                ctrlKey: !!e.ctrlKey,
                shiftKey: !!e.shiftKey,
                altKey: !!e.altKey,
                metaKey: !!e.metaKey
            });
        }
    });

    // Listen for file type / mode changes from stage
    bridge.on('set-mode', (data) => {
        console.log('[Parameters] set-mode received:', data);
        setMode(data.mode); // 'audio', 'midi', 'tracker'

        if (data.mode === 'audio' && data.params && data.params.reset) {
            const lockCheckbox = document.getElementById('audio_lock_settings');
            if (lockCheckbox && lockCheckbox.checked) {
                resendAudioParams();
                return;
            }
        }
        
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
        console.log('[Parameters] update-params received:', data);
        if(data && data.mode && data.params){
            setMode(data.mode);
            updateParams(data.mode, data.params);
        } else {
            updateParams(currentMode, data);
        }
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

function shouldIgnoreKeyTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function resetMidiParams(sendStage = false) {
    if (!controls.midi || !controls.midi.pitch || !controls.midi.tempo) return;

    const pitchVal = document.getElementById('midi_pitch_value');
    const tempoVal = document.getElementById('midi_tempo_value');
    const metronomeBtn = document.getElementById('btn_metronome');

    const originalBPM = (g.init_data && typeof g.init_data.originalBPM === 'number') ? Math.round(g.init_data.originalBPM) : 120;

    controls.midi.pitch.update(0);
    controls.midi.tempo.update(originalBPM);

    if (pitchVal) pitchVal.textContent = '0';
    if (tempoVal) tempoVal.textContent = '' + originalBPM;
    if (metronomeBtn) metronomeBtn.checked = false;

    if (sendStage && bridge && bridge.sendToStage) {
        bridge.sendToStage('midi-reset-params', {});
    }
}

function resetAudioParams(sendStage = false) {
    if (!controls.audio || !controls.audio.pitch || !controls.audio.tempo) return;

    const pitchVal = document.getElementById('audio_pitch_value');
    const tempoVal = document.getElementById('audio_tempo_value');
    const formantCheckbox = document.getElementById('audio_formant_mode');

    controls.audio.pitch.update(0);
    controls.audio.tempo.update(1.0);

    if (pitchVal) pitchVal.textContent = '+0';
    if (tempoVal) tempoVal.textContent = '100';
    if (formantCheckbox) formantCheckbox.checked = false;

    if (sendStage && bridge && bridge.sendToStage) {
        bridge.sendToStage('param-change', { mode: 'audio', param: 'pitch', value: 0 });
        bridge.sendToStage('param-change', { mode: 'audio', param: 'tempo', value: 1.0 });
        bridge.sendToStage('param-change', { mode: 'audio', param: 'formant', value: false });
    }
}

function resendAudioParams() {
    if (!bridge || !bridge.sendToStage) return;

    // First send the current mode
    bridge.sendToStage('param-change', { mode: 'audio', param: 'audioMode', value: audioMode });

    if (audioMode === 'tape') {
        // Tape mode: send tape speed
        if (controls.tape && controls.tape.speed) {
            const tapeVal = controls.tape.speed.getValue ? controls.tape.speed.getValue() : 0;
            bridge.sendToStage('param-change', { mode: 'audio', param: 'tapeSpeed', value: Math.round(tapeVal) });
        }
    } else {
        // Pitch/Time mode: send pitch, tempo, formant
        if (!controls.audio || !controls.audio.pitch || !controls.audio.tempo) return;
        
        const formantCheckbox = document.getElementById('audio_formant_mode');
        const pitchVal = controls.audio.pitch.getValue ? controls.audio.pitch.getValue() : 0;
        const tempoVal = controls.audio.tempo.getValue ? controls.audio.tempo.getValue() : 1.0;
        const formant = formantCheckbox ? !!formantCheckbox.checked : false;

        bridge.sendToStage('param-change', { mode: 'audio', param: 'pitch', value: Math.round(pitchVal) });
        bridge.sendToStage('param-change', { mode: 'audio', param: 'tempo', value: tempoVal });
        bridge.sendToStage('param-change', { mode: 'audio', param: 'formant', value: formant });
    }
}

function updateParams(mode, params) {
    if (mode === 'audio') {
        // Handle audio mode switching
        if (typeof params.audioMode !== 'undefined') {
            const tapeSection = document.getElementById('tape-section');
            const pitchtimeSection = document.getElementById('pitchtime-section');
            
            audioMode = params.audioMode;
            if (params.audioMode === 'tape') {
                tapeSection.classList.remove('disabled');
                pitchtimeSection.classList.add('disabled');
            } else {
                tapeSection.classList.add('disabled');
                pitchtimeSection.classList.remove('disabled');
            }
        }
        
        // Handle tape speed
        if (typeof params.tapeSpeed !== 'undefined' && controls.tape && controls.tape.speed) {
            controls.tape.speed.update(params.tapeSpeed, true);
            const speedVal = document.getElementById('tape_speed_value');
            const rounded = Math.round(params.tapeSpeed);
            if (speedVal) speedVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        }
        
        // Handle pitch/time params
        if (typeof params.pitch !== 'undefined') {
            controls.audio.pitch.update(params.pitch, true);
            const pitchVal = document.getElementById('audio_pitch_value');
            const rounded = Math.round(params.pitch);
            if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        }
        if (typeof params.tempo !== 'undefined') {
            controls.audio.tempo.update(params.tempo, true);
            const tempoVal = document.getElementById('audio_tempo_value');
            const pct = Math.round(params.tempo * 100);
            if (tempoVal) tempoVal.textContent = pct;
        }
        if (typeof params.formant !== 'undefined') {
            const formantCheckbox = document.getElementById('audio_formant_mode');
            if (formantCheckbox) formantCheckbox.checked = !!params.formant;
        }
        if (typeof params.locked !== 'undefined') {
            const lockCheckbox = document.getElementById('audio_lock_settings');
            if (lockCheckbox) lockCheckbox.checked = !!params.locked;
        }
    } else if (mode === 'midi') {
        // Store originalBPM if provided (for reset button)
        if (typeof params.originalBPM === 'number') {
            if (!g.init_data) g.init_data = {};
            g.init_data.originalBPM = params.originalBPM;
        }
        
        if (typeof params.transpose !== 'undefined') {
            controls.midi.pitch.update(params.transpose, true);
            const pitchVal = document.getElementById('midi_pitch_value');
            const rounded = Math.round(params.transpose);
            if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        }
        if (typeof params.bpm !== 'undefined') {
            controls.midi.tempo.update(params.bpm, true);
            const tempoVal = document.getElementById('midi_tempo_value');
            const rounded = Math.round(params.bpm);
            if (tempoVal) tempoVal.textContent = '' + rounded;
        }
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
            // Use requestAnimationFrame to ensure DOM is ready after mode switch
            requestAnimationFrame(() => {
                const sfSelect = document.getElementById('soundfont-select');
                if (!sfSelect) return;
                
                // Set the native select value
                sfSelect.value = params.soundfont;
                
                // Force superSelect to sync its display with the native select value
                if (sfSelect.reRender) {
                    sfSelect.reRender();
                }
            });
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
        const target = container.closest('.param-group') || container;
        ut.dragSlider(target, (e) => {
            update(min + e.prozX * (max - min));
        }, -1, track);
    }
    
    container.addEventListener('dblclick', () => {
        update(defaultVal);
    });
    
    return { update, getValue: () => value, setDefault: (v) => { defaultVal = v; } };
}

function initTapeControls() {
    const speedVal = document.getElementById('tape_speed_value');
    controls.tape.speed = createSlider('tape_speed_slider', -12, 12, 0, 0, (v) => {
        const rounded = Math.round(v);
        if (speedVal) speedVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        if (tapeSpeedTimeout) clearTimeout(tapeSpeedTimeout);
        tapeSpeedTimeout = setTimeout(() => {
            bridge.sendToStage('param-change', { mode: 'audio', param: 'tapeSpeed', value: rounded });
        }, 30);
    });

    const resetBtn = document.getElementById('btn_tape_reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetTapeParams(true);
        });
    }
}

function initAudioModeSections() {
    const tapeSection = document.getElementById('tape-section');
    const pitchtimeSection = document.getElementById('pitchtime-section');

    function setAudioMode(mode) {
        if (audioMode === mode) return; // Already in this mode
        console.log('[Parameters] setAudioMode called:', mode, 'previous:', audioMode);
        audioMode = mode;
        
        // Send audioMode - this triggers pipeline switch in stage.js
        console.log('[Parameters] Sending audioMode:', mode);
        bridge.sendToStage('param-change', { mode: 'audio', param: 'audioMode', value: mode });
        
        if (mode === 'tape') {
            tapeSection.classList.remove('disabled');
            pitchtimeSection.classList.add('disabled');
        } else {
            tapeSection.classList.add('disabled');
            pitchtimeSection.classList.remove('disabled');
        }
    }

    // Click anywhere on disabled section to activate it
    if (tapeSection) {
        tapeSection.addEventListener('click', () => {
            if (tapeSection.classList.contains('disabled')) {
                setAudioMode('tape');
            }
        });
    }
    
    if (pitchtimeSection) {
        pitchtimeSection.addEventListener('click', () => {
            if (pitchtimeSection.classList.contains('disabled')) {
                setAudioMode('pitchtime');
            }
        });
    }
    
    // Expose setAudioMode for updateParams
    window._setAudioMode = setAudioMode;
}

function resetTapeParams(sendStage = false) {
    if (!controls.tape || !controls.tape.speed) return;

    const speedVal = document.getElementById('tape_speed_value');
    controls.tape.speed.update(0);

    if (speedVal) speedVal.textContent = '+0';

    if (sendStage && bridge && bridge.sendToStage) {
        bridge.sendToStage('param-change', { mode: 'audio', param: 'tapeSpeed', value: 0 });
    }
}

function initAudioControls() {
    const pitchVal = document.getElementById('audio_pitch_value');
    controls.audio.pitch = createSlider('audio_pitch_slider', -12, 12, 0, 0, (v) => {
        const rounded = Math.round(v);
        if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        if (audioPitchTimeout) clearTimeout(audioPitchTimeout);
        audioPitchTimeout = setTimeout(() => {
            bridge.sendToStage('param-change', { mode: 'audio', param: 'pitch', value: rounded });
        }, 30);
    });

    const tempoVal = document.getElementById('audio_tempo_value');
    controls.audio.tempo = createSlider('audio_tempo_slider', 0.5, 1.5, 1.0, 1.0, (v) => {
        // v is 0.5 to 1.5
        const pct = Math.round(v * 100);
        if (tempoVal) tempoVal.textContent = pct;
        if (audioTempoTimeout) clearTimeout(audioTempoTimeout);
        audioTempoTimeout = setTimeout(() => {
            bridge.sendToStage('param-change', { mode: 'audio', param: 'tempo', value: v });
        }, 30);
    });

    const formantCheckbox = document.getElementById('audio_formant_mode');
    if (formantCheckbox) {
        formantCheckbox.addEventListener('change', () => {
            bridge.sendToStage('param-change', { mode: 'audio', param: 'formant', value: formantCheckbox.checked });
        });
    }

    const lockCheckbox = document.getElementById('audio_lock_settings');
    if (lockCheckbox) {
        lockCheckbox.addEventListener('change', () => {
            bridge.sendToStage('param-change', { mode: 'audio', param: 'locked', value: lockCheckbox.checked });
        });
    }

    document.getElementById('btn_audio_reset').addEventListener('click', () => {
        resetAudioParams(true);
    });
}

function initMidiControls() {
    const pitchVal = document.getElementById('midi_pitch_value');
    controls.midi.pitch = createSlider('midi_pitch_slider', -12, 12, 0, 0, (v) => {
        const rounded = Math.round(v);
        if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        if (midiPitchTimeout) clearTimeout(midiPitchTimeout);
        midiPitchTimeout = setTimeout(() => {
            bridge.sendToStage('param-change', { mode: 'midi', param: 'transpose', value: rounded });
        }, 30);
    });

    const tempoVal = document.getElementById('midi_tempo_value');
    // MIDI TEMPO range 40-240
    controls.midi.tempo = createSlider('midi_tempo_slider', 40, 240, 120, 120, (v) => {
        const rounded = Math.round(v);
        if (tempoVal) tempoVal.textContent = rounded;
        if (midiTempoTimeout) clearTimeout(midiTempoTimeout);
        midiTempoTimeout = setTimeout(() => {
            bridge.sendToStage('param-change', { mode: 'midi', param: 'bpm', value: rounded });
        }, 30);
    });

    document.getElementById('btn_metronome').addEventListener('change', (e) => {
        bridge.sendToStage('param-change', { mode: 'midi', param: 'metronome', value: e.target.checked });
    });

    document.getElementById('btn_midi_reset').addEventListener('click', () => {
        resetMidiParams(true);
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
    const selectInstance = superSelect(sfSelect);
    
    // Force superSelect to update its visual display
    if (selectInstance && selectInstance.updateDisplay) {
        selectInstance.updateDisplay();
    } else {
        // Fallback: manually update the display element
        const customDisplay = sfSelect.parentElement.querySelector('.nui-select-display');
        if (customDisplay && sfSelect.selectedIndex >= 0) {
            customDisplay.textContent = sfSelect.options[sfSelect.selectedIndex].textContent;
        }
    }
    
    // Listen for changes
    sfSelect.addEventListener('change', () => {
        const newFont = sfSelect.value;
        console.log('[SoundFont] Changed to:', newFont);
        bridge.sendToStage('param-change', { mode: 'midi', param: 'soundfont', value: newFont });
    });
}
