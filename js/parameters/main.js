import ut from '../../libs/nui/nui_ut.js';
import superSelect from '../../libs/nui/nui_select.js';
import dragSlider from '../../libs/nui/nui_drag_slider.js';

window.ut = ut;
window.superSelect = superSelect;
ut.dragSlider = dragSlider;

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULTS - Must match DEFAULTS in app.js (single source of truth)
// These values are used when resetting UI on file open
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULTS = {
    audio: {
        mode: 'tape',
        tapeSpeed: 0,
        pitch: 0,
        tempo: 1.0,
        formant: false
    },
    midi: {
        transpose: 0,
        bpm: 120,
        metronome: false
    },
    tracker: {
        pitch: 1.0,
        tempo: 1.0,
        stereoSeparation: 100
    }
};

let bridge;
let g = {
    init_data: null
};

let currentMode = 'audio';
let audioMode = 'tape'; // 'tape' or 'pitchtime'
const controls = {
    audio: {},
    tape: {},
    midi: {},
    tracker: {}
};

// Debounce timers for parameter changes (30ms prevents crackling)
let tapeSpeedTimeout = null;
let audioPitchTimeout = null;
let audioTempoTimeout = null;
let midiPitchTimeout = null;
let midiTempoTimeout = null;
let trackerPitchTimeout = null;
let trackerTempoTimeout = null;
let trackerStereoTimeout = null;

// Tracker VU state
let trackerVuBars = [];
let trackerChannelCount = 0;
let trackerSoloSet = new Set();  // Channels currently soloed (auditioned)

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
    initTrackerControls();
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
        console.log('[Parameters] set-mode received:', JSON.stringify(data));
        setMode(data.mode); // 'audio', 'midi', 'tracker'

        if (data.mode === 'audio' && data.params && data.params.reset) {
            const lockCheckbox = document.getElementById('audio_lock_settings');
            console.log('[Parameters] Reset flag set, lockCheckbox=' + (lockCheckbox ? lockCheckbox.checked : 'null'));
            if (lockCheckbox && lockCheckbox.checked) {
                console.log('[Parameters] Lock is ON - resending params');
                resendAudioParams();
                return;
            }
            // Lock is not checked - reset UI to defaults (tape mode, zero values)
            console.log('[Parameters] Reset flag set, lock OFF - resetting audio params UI');
            resetAudioParams(false);  // Reset sliders UI (don't send to stage, it already reset)
            // Also reset tape speed
            resetTapeParams(false);
            // Switch to tape mode visually
            audioMode = 'tape';
            const tapeSection = document.getElementById('tape-section');
            const pitchtimeSection = document.getElementById('pitchtime-section');
            if (tapeSection) tapeSection.classList.remove('disabled');
            if (pitchtimeSection) pitchtimeSection.classList.add('disabled');
            console.log('[Parameters] Reset complete - audioMode=' + audioMode);
            return;  // Don't call updateParams since we already reset
        }
        
        // Reset tracker solo state when a new file loads
        if (data.mode === 'tracker' && data.params && data.params.reset) {
            resetTrackerSoloState();
            resetTrackerParams(false);  // Reset sliders UI (don't send to stage, it already reset)
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

    // Listen for tracker VU updates (high-frequency, from audio worklet)
    let vuFrameCount = 0;
    bridge.on('tracker-vu', (data) => {
        if (currentMode !== 'tracker' || !data.vu) return;
        // Log first VU frame and then every 60 frames (approx 1 second)
        if (vuFrameCount === 0) console.log('[Parameters] First tracker-vu received, channels:', data.channels);
        vuFrameCount++;
        if (vuFrameCount >= 60) vuFrameCount = 0;
        updateTrackerVu(data.vu, data.channels);
    });
    
    // Reset UI when window is hidden/closed
    if (window.bridge && window.bridge.isElectron) {
        const {ipcRenderer} = require('electron');
        ipcRenderer.on('hide-window', () => {
            console.log('[Parameters] Window hidden - resetting all params');
            // Reset all controls and send to stage immediately
            resetAudioParams(true);
            resetMidiParams(true);
            resetTapeParams(true);
            resetTrackerParams(true);
            resetTrackerSoloState();
            // Reset audio mode to tape and send to stage
            audioMode = 'tape';
            const tapeSection = document.getElementById('tape-section');
            const pitchtimeSection = document.getElementById('pitchtime-section');
            if (tapeSection) tapeSection.classList.remove('disabled');
            if (pitchtimeSection) pitchtimeSection.classList.add('disabled');
            bridge.sendToStage('param-change', { mode: 'audio', param: 'audioMode', value: 'tape' });
            // Uncheck lock checkbox
            const lockCheckbox = document.getElementById('audio_lock_settings');
            if (lockCheckbox) lockCheckbox.checked = false;
        });
    }
    
    document.querySelector('main').classList.add('ready');
}

// Ensure DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Handle bridge-ready event - this may fire before or after DOM is ready
// We handle both cases by checking readyState
window.addEventListener('bridge-ready', async (e) => {
    const data = e.detail;
    console.log('[Parameters] bridge-ready received, init_data:', data);
    
    // Store init_data globally
    g.init_data = data;
    
    // Wait for DOM to be ready if it isn't already
    if (document.readyState === 'loading') {
        console.log('[Parameters] DOM still loading, waiting for DOMContentLoaded...');
        await new Promise(resolve => {
            document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
    }
    
    // Initialize soundfont selector
    await initSoundfontSelector();
    
    // Set mode if provided
    if (data.mode) {
        console.log('[Parameters] Setting mode from bridge-ready:', data.mode);
        setMode(data.mode);
    }
    
    // Display original BPM for MIDI mode
    if (data.mode === 'midi' && typeof data.originalBPM === 'number') {
        const origElem = document.getElementById('midi_original_bpm');
        if (origElem) origElem.textContent = `(Original: ${Math.round(data.originalBPM)})`;
        if (controls.midi && controls.midi.tempo && controls.midi.tempo.setDefault) {
            controls.midi.tempo.setDefault(Math.round(data.originalBPM));
        }
    }
    
    // Update params if provided
    if (data.params) {
        console.log('[Parameters] Updating params from bridge-ready:', data.params);
        updateParams(data.mode || 'audio', data.params);
    }
}, { once: true });

// --- Logic ---

const modeTitles = {
    audio: 'Parameters - Audio',
    midi: 'Parameters - MIDI',
    tracker: 'Parameters - Tracker (MOD)'
};

function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-container').forEach(el => el.classList.remove('active'));
    
    const target = document.getElementById(`${mode}-controls`);
    if (target) {
        target.classList.add('active');
    }
    
    // Update window title
    const title = modeTitles[mode] || 'Parameters';
    document.title = title;
    const titleLabel = document.querySelector('.nui-title-bar .title .label');
    if (titleLabel) titleLabel.textContent = title;
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

    // Use DEFAULTS for single source of truth
    const { transpose, metronome } = DEFAULTS.midi;
    // BPM comes from file's original BPM if available, otherwise DEFAULTS.midi.bpm
    const originalBPM = (g.init_data && typeof g.init_data.originalBPM === 'number') 
        ? Math.round(g.init_data.originalBPM) 
        : (DEFAULTS.midi.bpm || 120);

    controls.midi.pitch.update(transpose);  // 0 = no transpose
    controls.midi.tempo.update(originalBPM);

    if (pitchVal) pitchVal.textContent = String(transpose);
    if (tempoVal) tempoVal.textContent = String(originalBPM);
    if (metronomeBtn) metronomeBtn.checked = metronome;

    if (sendStage && bridge && bridge.sendToStage) {
        bridge.sendToStage('midi-reset-params', {});
    }
}

function resetAudioParams(sendStage = false) {
    if (!controls.audio || !controls.audio.pitch || !controls.audio.tempo) return;

    const pitchVal = document.getElementById('audio_pitch_value');
    const tempoVal = document.getElementById('audio_tempo_value');
    const formantCheckbox = document.getElementById('audio_formant_mode');

    // Use DEFAULTS for single source of truth
    const { pitch, tempo, formant } = DEFAULTS.audio;

    controls.audio.pitch.update(pitch);    // 0 = no pitch shift
    controls.audio.tempo.update(tempo);    // 1.0 = normal speed

    if (pitchVal) pitchVal.textContent = (pitch >= 0 ? '+' : '') + pitch;
    if (tempoVal) tempoVal.textContent = String(Math.round(tempo * 100));
    if (formantCheckbox) formantCheckbox.checked = formant;

    if (sendStage && bridge && bridge.sendToStage) {
        bridge.sendToStage('param-change', { mode: 'audio', param: 'pitch', value: pitch });
        bridge.sendToStage('param-change', { mode: 'audio', param: 'tempo', value: tempo });
        bridge.sendToStage('param-change', { mode: 'audio', param: 'formant', value: formant });
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
            if (tapeSpeedTimeout) clearTimeout(tapeSpeedTimeout);
            controls.tape.speed.update(params.tapeSpeed, true);
            const speedVal = document.getElementById('tape_speed_value');
            const rounded = Math.round(params.tapeSpeed);
            if (speedVal) speedVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        }
        
        // Handle pitch/time params
        // Clear any pending debounced callbacks before updating to prevent old values being sent back
        if (typeof params.pitch !== 'undefined') {
            if (audioPitchTimeout) clearTimeout(audioPitchTimeout);
            controls.audio.pitch.update(params.pitch, true);
            const pitchVal = document.getElementById('audio_pitch_value');
            const rounded = Math.round(params.pitch);
            if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        }
        if (typeof params.tempo !== 'undefined') {
            if (audioTempoTimeout) clearTimeout(audioTempoTimeout);
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
    } else if (mode === 'tracker') {
        // Handle tracker params
        if (typeof params.pitch !== 'undefined') {
            // Convert pitch_factor back to semitones
            const semitones = Math.round(12 * Math.log2(params.pitch));
            if (controls.tracker.pitch) controls.tracker.pitch.update(semitones, true);
            const pitchVal = document.getElementById('tracker_pitch_value');
            if (pitchVal) pitchVal.textContent = (semitones >= 0 ? '+' : '') + semitones;
        }
        if (typeof params.tempo !== 'undefined') {
            if (controls.tracker.tempo) controls.tracker.tempo.update(params.tempo, true);
            const tempoVal = document.getElementById('tracker_tempo_value');
            if (tempoVal) tempoVal.textContent = Math.round(params.tempo * 100);
        }
        if (typeof params.stereoSeparation !== 'undefined') {
            if (controls.tracker.stereo) controls.tracker.stereo.update(params.stereoSeparation, true);
            const stereoVal = document.getElementById('tracker_stereo_value');
            if (stereoVal) stereoVal.textContent = Math.round(params.stereoSeparation);
        }
        // Initialize channel count if provided
        if (typeof params.channels === 'number') {
            trackerChannelCount = 0; // Force rebuild
            updateTrackerVu(new Float32Array(params.channels), params.channels);
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
            // Ignore end event to prevent duplicate updates
            if (e.type === 'end') return;
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
    
    // Use DEFAULTS for single source of truth
    const { tapeSpeed } = DEFAULTS.audio;
    controls.tape.speed.update(tapeSpeed);  // 0 = normal speed

    if (speedVal) speedVal.textContent = (tapeSpeed >= 0 ? '+' : '') + tapeSpeed;

    if (sendStage && bridge && bridge.sendToStage) {
        bridge.sendToStage('param-change', { mode: 'audio', param: 'tapeSpeed', value: tapeSpeed });
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
            // Only send formant changes when in pitchtime mode
            if (audioMode === 'pitchtime') {
                bridge.sendToStage('param-change', { mode: 'audio', param: 'formant', value: formantCheckbox.checked });
            }
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

function initTrackerControls() {
    const pitchVal = document.getElementById('tracker_pitch_value');
    // Pitch: -12 to +12 semitones, converted to pitch_factor (2^(semitones/12))
    controls.tracker.pitch = createSlider('tracker_pitch_slider', -12, 12, 0, 0, (v) => {
        const rounded = Math.round(v);
        if (pitchVal) pitchVal.textContent = (rounded >= 0 ? '+' : '') + rounded;
        if (trackerPitchTimeout) clearTimeout(trackerPitchTimeout);
        trackerPitchTimeout = setTimeout(() => {
            const pitchFactor = Math.pow(2, rounded / 12);
            bridge.sendToStage('param-change', { mode: 'tracker', param: 'pitch', value: pitchFactor });
        }, 30);
    });

    const tempoVal = document.getElementById('tracker_tempo_value');
    // Tempo: 50% to 150%, converted to tempo_factor
    controls.tracker.tempo = createSlider('tracker_tempo_slider', 0.5, 1.5, 1.0, 1.0, (v) => {
        const pct = Math.round(v * 100);
        if (tempoVal) tempoVal.textContent = pct;
        if (trackerTempoTimeout) clearTimeout(trackerTempoTimeout);
        trackerTempoTimeout = setTimeout(() => {
            bridge.sendToStage('param-change', { mode: 'tracker', param: 'tempo', value: v });
        }, 30);
    });

    const stereoVal = document.getElementById('tracker_stereo_value');
    // Stereo separation: 0% to 200%
    controls.tracker.stereo = createSlider('tracker_stereo_slider', 0, 200, 100, 100, (v) => {
        const rounded = Math.round(v);
        if (stereoVal) stereoVal.textContent = rounded;
        if (trackerStereoTimeout) clearTimeout(trackerStereoTimeout);
        trackerStereoTimeout = setTimeout(() => {
            bridge.sendToStage('param-change', { mode: 'tracker', param: 'stereoSeparation', value: rounded });
        }, 30);
    });

    // Reset button
    const resetBtn = document.getElementById('btn_tracker_reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetTrackerParams(true);
        });
    }
}

function resetTrackerParams(sendStage = false) {
    // Use DEFAULTS for single source of truth
    const { pitch, tempo, stereoSeparation } = DEFAULTS.tracker;
    
    const pitchVal = document.getElementById('tracker_pitch_value');
    const tempoVal = document.getElementById('tracker_tempo_value');
    const stereoVal = document.getElementById('tracker_stereo_value');

    // Pitch slider: range -12 to +12, default 0 (1.0 = no change)
    // Slider shows semitones offset, so 1.0 pitch = 0 semitones
    if (controls.tracker.pitch) controls.tracker.pitch.update(0);  // 0 semitones offset
    if (controls.tracker.tempo) controls.tracker.tempo.update(tempo);  // 1.0 = normal speed
    if (controls.tracker.stereo) controls.tracker.stereo.update(stereoSeparation);  // 100 = default

    if (pitchVal) pitchVal.textContent = '+0';
    if (tempoVal) tempoVal.textContent = '100';
    if (stereoVal) stereoVal.textContent = String(stereoSeparation);

    if (sendStage && bridge && bridge.sendToStage) {
        bridge.sendToStage('tracker-reset-params', {});
    }
}

function updateTrackerVu(vuData, channelCount) {
    const container = document.getElementById('tracker_channels_container');
    const countLabel = document.getElementById('tracker_channel_count');
    if (!container) return;

    // Rebuild channel strips if channel count changed
    if (channelCount !== trackerChannelCount) {
        trackerChannelCount = channelCount;
        trackerVuBars = [];
        trackerSoloSet.clear();
        container.innerHTML = '';
        
        for (let i = 0; i < channelCount; i++) {
            const strip = document.createElement('div');
            strip.className = 'tracker-channel-strip';
            strip.dataset.channel = i;
            
            const vuBar = document.createElement('div');
            vuBar.className = 'tracker-vu-bar';
            vuBar.innerHTML = '<div class="vu-fill"></div>';
            vuBar.title = `Channel ${i + 1} - Click: solo, Shift+Click: add to solo`;
            
            // Click: exclusive solo, Shift+click: add/remove from solo group
            vuBar.addEventListener('click', (e) => {
                handleTrackerSolo(i, e.shiftKey);
            });
            
            const label = document.createElement('div');
            label.className = 'channel-label';
            label.textContent = (i + 1);
            
            strip.appendChild(vuBar);
            strip.appendChild(label);
            container.appendChild(strip);
            trackerVuBars.push(vuBar.querySelector('.vu-fill'));
        }
        
        if (countLabel) countLabel.textContent = channelCount + ' channels';
    }

    // Update VU levels
    for (let i = 0; i < trackerVuBars.length && i < vuData.length; i++) {
        const level = vuData[i] || 0;
        const heightPct = Math.min(100, level * 100);
        trackerVuBars[i].style.height = heightPct + '%';
        
        // Add active class for non-zero levels
        const bar = trackerVuBars[i].parentElement;
        if (level > 0.01) {
            bar.classList.add('active');
        } else {
            bar.classList.remove('active');
        }
    }
}

function handleTrackerSolo(index, additive) {
    if (additive) {
        // Shift+click: toggle this channel in/out of solo group
        if (trackerSoloSet.has(index)) {
            trackerSoloSet.delete(index);
        } else {
            trackerSoloSet.add(index);
        }
    } else {
        // Click: exclusive solo (or un-solo if clicking the only soloed track)
        if (trackerSoloSet.size === 1 && trackerSoloSet.has(index)) {
            // Clicking the only soloed track: clear solo (all play)
            trackerSoloSet.clear();
        } else {
            // Solo only this track
            trackerSoloSet.clear();
            trackerSoloSet.add(index);
        }
    }
    
    applyTrackerSoloState();
}

function applyTrackerSoloState() {
    const container = document.getElementById('tracker_channels_container');
    if (!container) return;
    
    const strips = container.querySelectorAll('.tracker-channel-strip');
    const hasSolo = trackerSoloSet.size > 0;
    
    for (let i = 0; i < trackerChannelCount; i++) {
        const strip = strips[i];
        if (!strip) continue;
        
        const isSoloed = trackerSoloSet.has(i);
        // If any channel is soloed, mute those not in the solo set
        const isMuted = hasSolo && !isSoloed;
        
        strip.classList.toggle('solo', isSoloed);
        strip.classList.toggle('muted', isMuted);
        
        // Send mute state to worklet
        bridge.sendToStage('param-change', {
            mode: 'tracker',
            param: 'channelMute',
            value: { channel: i, mute: isMuted }
        });
    }
}

function resetTrackerSoloState() {
    // Clear all solo selections and update UI
    trackerSoloSet.clear();
    
    const container = document.getElementById('tracker_channels_container');
    if (!container) return;
    
    const strips = container.querySelectorAll('.tracker-channel-strip');
    for (let i = 0; i < strips.length; i++) {
        strips[i].classList.remove('solo', 'muted');
    }
    // Note: don't send mute commands here - the worklet already reset on file load
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
