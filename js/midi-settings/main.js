import ut from '../../libs/nui/nui_ut.js';
import superSelect from '../../libs/nui/nui_select.js';
import dragSlider from '../../libs/nui/nui_drag_slider.js';

window.ut = ut;
window.superSelect = superSelect;
// Attach dragSlider to ut since that's where the implementation expects it
ut.dragSlider = dragSlider;

let main = {};
let bridge;
let config;
let config_obj;

function getCfg(path, fallback) {
	let cur = config;
	for (let i = 0; i < path.length; i++) {
		if (!cur || typeof cur !== 'object') return fallback;
		cur = cur[path[i]];
	}
	return cur === undefined ? fallback : cur;
}

function setCfgValue(path, value) {
	if (!path || !path.length) return;
	const cur = config_obj ? (config_obj.get() || {}) : (config || {});
	const next = { ...cur };

	let dst = next;
	for (let i = 0; i < path.length - 1; i++) {
		const k = path[i];
		const child = (dst[k] && typeof dst[k] === 'object') ? dst[k] : {};
		dst[k] = { ...child };
		dst = dst[k];
	}
	dst[path[path.length - 1]] = value;

	if (config_obj) {
		config_obj.set(next);
	}
	config = next;
}

async function initSoundfontSelector() {
	const soundfontSelect = document.getElementById('soundfont-select');
	const currentFont = getCfg(['midiSoundfont'], 'default.sf2');
	
	// Get list of available soundfonts from stage
	const availableFonts = await new Promise((resolve) => {
		bridge.sendToStage('get-available-soundfonts', {});
		bridge.once('available-soundfonts', (data) => {
			resolve(data.fonts || []);
		});
	});
	
	// Populate dropdown with available fonts
	if (availableFonts.length > 0) {
		soundfontSelect.innerHTML = '';
		availableFonts.forEach(font => {
			const option = document.createElement('option');
			option.value = font.filename;
			option.textContent = font.label;
			soundfontSelect.appendChild(option);
		});
	}
	
	// Set current value before initializing superSelect
	soundfontSelect.value = currentFont;
	
	// Ensure something is selected to prevent UI crash
	if (soundfontSelect.selectedIndex === -1 && soundfontSelect.options.length > 0) {
		console.warn('Configured soundfont not found in list, defaulting to first option.');
		soundfontSelect.selectedIndex = 0;
		// Update config to match reality? Maybe not, user might fix the file.
		// But for UI consistency, we just select the first one.
	}

	// Initialize nui-select
	superSelect(soundfontSelect);
	
	// Force update the visual state of the select
	const event = new Event('change', { bubbles: true });
	soundfontSelect.dispatchEvent(event);
	
	soundfontSelect.addEventListener('change', () => {
		const newFont = soundfontSelect.value;
		setCfgValue(['midiSoundfont'], newFont);
		bridge.sendToStage('midi-soundfont-changed', newFont);
	});
}

function initSliders() {
	const pitchSlider = document.getElementById('pitch_slider');
	const tempoSlider = document.getElementById('tempo_slider');
	const pitchValue = document.getElementById('pitch_value');
	const tempoValue = document.getElementById('tempo_value');

	let pitchTimeout = null;
	let tempoTimeout = null;

	function createSlider(container, min, max, initial, defaultVal, onChange) {
		if (!container) return;
		const handle = container.querySelector('.handle');
		const track = container.querySelector('.track');
		if (!handle || !track) return;
		let value = initial;

		function update(v, skipCallback = false) {
			value = Math.max(min, Math.min(max, v));
			const percent = (value - min) / (max - min);
			handle.style.left = (percent * 100) + '%';
			if (!skipCallback && onChange) onChange(value);
		}

		update(initial, true);
		// Force initial callback to set text
		if(onChange) onChange(initial);

		if (ut && ut.dragSlider) {
			ut.dragSlider(container, (e) => {
				update(min + e.prozX * (max - min));
			}, -1, track);
		}
		
		// Double click to reset
		container.addEventListener('dblclick', () => {
			update(defaultVal);
		});
		
		return { update, getValue: () => value, setDefault: (v) => { defaultVal = v; } };
	}

	let pitchUpdate, tempoUpdate;

	// Display Original BPM
	if (g.init_data && g.init_data.originalBPM) {
		const origElem = document.getElementById('original_bpm_display');
		if (origElem) origElem.textContent = `(Original: ${Math.round(g.init_data.originalBPM)})`;
	}

	// Pitch Slider (-12 to +12)
	// Don't read from config storage, use ephemeral init_data or default 0
	let startPitch = 0;
	if (g.init_data && typeof g.init_data.midiPitch === 'number') startPitch = g.init_data.midiPitch;
	
	const pitchControl = createSlider(pitchSlider, -12, 12, startPitch, 0, (v) => {
		const rounded = Math.round(v);
		if (pitchValue) pitchValue.textContent = (rounded >= 0 ? '+' : '') + rounded;
		
		if (pitchTimeout) clearTimeout(pitchTimeout);
		pitchTimeout = setTimeout(() => {
			// Don't save to config file (setCfgValue)
			bridge.sendToStage('midi-pitch-changed', rounded);
		}, 30);
	});
	pitchUpdate = pitchControl.update;

	// Tempo Slider (40 to 240 BPM)
	let startBPM = 120;
	if (g.init_data && typeof g.init_data.midiSpeed === 'number') startBPM = g.init_data.midiSpeed;
	if (!startBPM || startBPM < 40) startBPM = 120; // Default fallback if data is weird

	const defaultBPM = (g.init_data && g.init_data.originalBPM) ? Math.round(g.init_data.originalBPM) : 120;

	const tempoControl = createSlider(tempoSlider, 40, 240, startBPM, defaultBPM, (v) => {
		const bpm = Math.round(v);
		if (tempoValue) tempoValue.textContent = bpm;
		
		if (tempoTimeout) clearTimeout(tempoTimeout);
		tempoTimeout = setTimeout(() => {
			// Don't save to config file
			bridge.sendToStage('midi-speed-changed', bpm);
		}, 30);
	});
	tempoUpdate = tempoControl.update;

	// Listen for UI updates from stage (e.g. when reopening window or if stage logic changes it)
	bridge.on('update-ui', (data) => {
		if (typeof data.pitch === 'number') pitchUpdate(data.pitch, true);
		if (typeof data.speed === 'number') tempoUpdate(data.speed, true);
		if (typeof data.metronome === 'boolean') {
			const btnMetronome = document.getElementById('btn_metronome');
			if(btnMetronome) btnMetronome.checked = data.metronome;
		}
		if (typeof data.originalBPM === 'number') {
			const origElem = document.getElementById('original_bpm_display');
			if (origElem) origElem.textContent = `(Original: ${Math.round(data.originalBPM)})`;
			if (tempoControl.setDefault) tempoControl.setDefault(Math.round(data.originalBPM));
			
			// Update local cache so reset works correctly
			if (!g.init_data) g.init_data = {};
			g.init_data.originalBPM = data.originalBPM;
		}
	});

	// Connect Reset Button
	const btnReset = document.getElementById('btn_reset');
	if (btnReset) {
		btnReset.addEventListener('click', () => {
			pitchControl.update(0);
			tempoControl.update((g.init_data && g.init_data.originalBPM) ? Math.round(g.init_data.originalBPM) : 120);
		});
	}

	// Metronome Toggle
	const btnMetronome = document.getElementById('btn_metronome');
	if (btnMetronome) {
		// Init state
		btnMetronome.checked = !!(g.init_data && g.init_data.metronome);
		
		btnMetronome.addEventListener('change', () => {
			bridge.sendToStage('midi-metronome-toggle', btnMetronome.checked);
		});
	}
}

function initButtons() {
	const btnOpen = document.getElementById('btn_open_folder');
	if (btnOpen) {
		btnOpen.addEventListener('click', () => {
			if (bridge) bridge.sendToStage('open-soundfonts-folder', {});
		});
	}
}

function initCloseButton() {
	const closeBtn = document.querySelector('.nui-title-bar .close');
	if (closeBtn) {
		closeBtn.addEventListener('click', () => {
			window.close();
		});
	}
}

async function init(data) {
    if(!globalThis.g) globalThis.g = {};
    globalThis.g.init_data = data || {};
    // ... rest of init
	console.log('[MIDI Settings] init called with data:', data);
	bridge = window.bridge;
	config = data.config || {};
	config_obj = data.config_obj || null;

	if (bridge && bridge.isElectron) {
		const shortcuts = require('../js/shortcuts.js');
		window.addEventListener('keydown', (keyEvent) => {
			shortcuts.handleShortcut(keyEvent, 'midi');
		});
	}

	initSoundfontSelector();
	initCloseButton();
	initSliders();
	initButtons();
	
	// Ensure metronome turns off when window closes (UI-driven only)
	// Handled by stage.js via window-hidden/closed events
	// window.addEventListener('beforeunload', () => {});
	
	bridge.on('theme-changed', (themeData) => {
		if (themeData.dark) {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
	});

	setTimeout(() => {
		console.log('[MIDI Settings] Setting main.ready');
		document.querySelector('main').classList.add('ready');
	}, 100);
}

main.init = init;
export { main };
