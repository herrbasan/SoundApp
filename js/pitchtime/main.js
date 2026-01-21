import { PitchtimeEngine } from './pitchtime_engine.js';

import ut from '../../libs/nui/nui_ut.js';
import nui_app from '../../libs/nui/nui_app.js';
import dragSlider from '../../libs/nui/nui_drag_slider.js';
ut.dragSlider = dragSlider;
window.nui_app = nui_app;

let g = {};
let engine;
let g_params = null;
let engineInitPromise = null;

function formatTime(s){
	if(isNaN(s) || s < 0) s = 0;
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function showError(msg){
	const el = document.getElementById('error_display');
	const msgEl = document.getElementById('error_message');
	if(el && msgEl){
		msgEl.textContent = msg;
		el.style.display = 'flex';
	}
}

function hideError(){
	const el = document.getElementById('error_display');
	if(el) el.style.display = 'none';
}

function showLoading(){
	const el = document.getElementById('loading_overlay');
	if(el) el.style.display = 'flex';
}

function hideLoading(){
	const el = document.getElementById('loading_overlay');
	if(el) el.style.display = 'none';
}

function updateUI(){
	const playing = engine && engine.isPlaying;
	const currentTime = engine ? engine.getCurrentTime() : 0;
	const duration = engine ? engine.duration : 0;
	const progress = (duration > 0) ? (currentTime / duration) : 0;

	const playBtn = document.getElementById('btn_play');
	if(playBtn){
		if(playing) playBtn.classList.add('playing');
		else playBtn.classList.remove('playing');
	}

	const loopBtn = document.getElementById('btn_loop');
	if(loopBtn && engine){
		if(engine.loop) loopBtn.classList.add('active');
		else loopBtn.classList.remove('active');
	}

	const currentTimeEl = document.getElementById('current_time');
	const totalTimeEl = document.getElementById('total_time');
	if(currentTimeEl) currentTimeEl.textContent = formatTime(currentTime);
	if(totalTimeEl) totalTimeEl.textContent = formatTime(duration);

	const seekBar = document.querySelector('.transport .bar .inner');
	if(seekBar) seekBar.style.width = (progress * 100) + '%';
}

function setupTransportControls(){
	const playBtn = document.getElementById('btn_play');
	const stopBtn = document.getElementById('btn_stop');
	const loopBtn = document.getElementById('btn_loop');

	if(playBtn){
		playBtn.addEventListener('click', async () => {
			if(!engine) return;
			if(engine.isPlaying){
				await engine.pause();
			} else {
				await engine.play();
			}
			updateUI();
		});
	}

	if(stopBtn){
		stopBtn.addEventListener('click', () => {
			if(!engine) return;
			engine.seek(0);
			updateUI();
		});
	}

	if(loopBtn){
		loopBtn.addEventListener('click', () => {
			if(!engine) return;
			if(engine.setLoop){
				engine.setLoop(!engine.loop);
			} else {
				engine.loop = !engine.loop;
			}
			updateUI();
		});
	}

	const transportEl = document.querySelector('.transport');
	const transportBar = transportEl ? transportEl.querySelector('.bar') : null;
	if(transportEl && transportBar && ut.dragSlider){
		ut.dragSlider(transportEl, (e) => {
			if(!engine || engine.duration <= 0) return;
			engine.seek(e.prozX * engine.duration);
			updateUI();
		}, 120, transportBar);
	}
}

function setupVolumeControls(){
	const masterVol = document.querySelector('.master-vol');
	const slider = document.getElementById('master_slider');
	const bar = slider ? slider.querySelector('.inner') : null;
	if(!slider || !bar) return;
	if(typeof g.master_gain_val !== 'number' || !isFinite(g.master_gain_val)) g.master_gain_val = 1.0;

	function apply(v){
		v = Math.max(0, Math.min(1, +v || 0));
		g.master_gain_val = v;
		bar.style.width = (v * 100) + '%';
		if(engine && engine.setVolume) engine.setVolume(v);
	}
	apply(g.master_gain_val);

	if(ut.dragSlider){
		ut.dragSlider(masterVol || slider, (e) => {
			apply(e.prozX);
		}, -1, slider);
	}
}

function setupParameterControls(){
	const pitchSlider = document.getElementById('pitch_slider');
	const tempoSlider = document.getElementById('tempo_slider');
	const pitchValue = document.getElementById('pitch_value');
	const tempoValue = document.getElementById('tempo_value');

	function createSlider(container, min, max, initial, onChange){
		if(!container) return;
		const handle = container.querySelector('.handle');
		const track = container.querySelector('.track');
		if(!handle || !track) return;
		let value = initial;

		function update(v, skipCallback = false){
			value = Math.max(min, Math.min(max, v));
			const percent = (value - min) / (max - min);
			handle.style.left = (percent * 100) + '%';
			if(!skipCallback && onChange) onChange(value);
		}

		update(initial, true);
		if(ut.dragSlider){
			const target = container.closest('.param-group') || container;
			ut.dragSlider(target, (e) => {
				update(min + e.prozX * (max - min));
			}, -1, track);
		}
		return { update, getValue: () => value };
	}

	const pitchControl = createSlider(pitchSlider, -12, 12, 0, (v) => {
		const rounded = Math.round(v);
		if(pitchValue) pitchValue.textContent = (rounded >= 0 ? '+' : '') + rounded;
		if(engine){
			const currentPitch = engine.currentPitch || 0;
			if(rounded !== currentPitch){
				engine.setPitch(rounded);
			}
		}
	});

	const tempoControl = createSlider(tempoSlider, 0.5, 1.5, 1.0, (v) => {
		const speed = v;
		const percent = Math.round(speed * 100);
		if(tempoValue) tempoValue.textContent = percent;
		if(engine){
			const currentPercent = Math.round((1.0 / (engine.currentTempo || 1.0)) * 100);
			if(percent !== currentPercent){
				engine.setTempo(1.0 / (speed || 1.0));
			}
		}
	});

	const hqCheckbox = document.getElementById('hq_mode');
	if(hqCheckbox){
		hqCheckbox.addEventListener('change', () => {
			if(engine) engine.setHighQuality(hqCheckbox.checked);
		});
	}

	const resetBtn = document.getElementById('btn_reset_params');
	if(resetBtn){
		resetBtn.addEventListener('click', () => {
			if(pitchControl) pitchControl.update(0);
			if(tempoControl) tempoControl.update(1.0);
			if(hqCheckbox) hqCheckbox.checked = true;
			if(pitchValue) pitchValue.textContent = '0';
			if(tempoValue) tempoValue.textContent = '100';
			if(engine){
				engine.setPitch(0);
				engine.setTempo(1.0);
				engine.setHighQuality(true);
			}
		});
	}

	g_params = { pitchControl, tempoControl, hqCheckbox, pitchValue, tempoValue };
	return g_params;
}

async function ensureEngine(){
	// If init is already in flight, always await it.
	// Otherwise we can hit a race where engine is non-null but not fully initialized yet.
	if(engineInitPromise){
		try { return await engineInitPromise; } catch(e) { return false; }
	}
	if(engine){
		// Engine exists; still apply UI params (important on first init because
		// the engine is created before setupParameterControls wires g_params).
		if(g_params){
			const pitchTxt = g_params.pitchValue ? parseInt(g_params.pitchValue.textContent || '0', 10) : 0;
			const tempoTxt = g_params.tempoValue ? parseInt(g_params.tempoValue.textContent || '100', 10) : 100;
			const speed = Math.max(0.5, Math.min(1.5, (tempoTxt || 100) / 100));
			engine.setPitch(isFinite(pitchTxt) ? pitchTxt : 0);
			engine.setTempo(isFinite(speed) ? (1.0 / speed) : 1.0);
			if(g_params.hqCheckbox) engine.setHighQuality(!!g_params.hqCheckbox.checked);
		}
		if(typeof g.master_gain_val === 'number' && isFinite(g.master_gain_val) && engine.setVolume){
			engine.setVolume(g.master_gain_val);
		}
		return true;
	}

	engineInitPromise = (async () => {
		try {
			engine = new PitchtimeEngine(g.initData);
			await engine.init();
			if(typeof g.master_gain_val === 'number' && isFinite(g.master_gain_val) && engine.setVolume){
				engine.setVolume(g.master_gain_val);
			}
			// Re-apply current UI params to the fresh engine (window may be re-shown after hide).
			if(g_params){
				const pitchTxt = g_params.pitchValue ? parseInt(g_params.pitchValue.textContent || '0', 10) : 0;
				const tempoTxt = g_params.tempoValue ? parseInt(g_params.tempoValue.textContent || '100', 10) : 100;
				const speed = Math.max(0.5, Math.min(1.5, (tempoTxt || 100) / 100));
				engine.setPitch(isFinite(pitchTxt) ? pitchTxt : 0);
				engine.setTempo(isFinite(speed) ? (1.0 / speed) : 1.0);
				if(g_params.hqCheckbox) engine.setHighQuality(!!g_params.hqCheckbox.checked);
			}
			return true;
		} catch(err) {
			console.error('Engine init failed:', err);
			showError('Failed to initialize audio engine: ' + err.message);
			engine = null;
			return false;
		}
	})();

	try {
		return await engineInitPromise;
	} finally {
		engineInitPromise = null;
	}
}

function setupDragAndDrop(){
	if(!window.nui_app) return;
	const dropZone = window.nui_app.dropZone(
		[{ name:'drop_file', label:'Drop Files...' }],
		async (e) => {
			e.preventDefault();
			if(!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
			const file = e.dataTransfer.files[0];
			await loadFile(file, true);
		},
		document.querySelector('.nui-app')
	);
}

async function loadFile(file, autoPlay = false){
	if(!engine || !file) return;
	hideError();
	try {
		let filePath;
		if(window.bridge && window.bridge.isElectron){
			const webUtils = require('electron').webUtils;
			filePath = webUtils.getPathForFile(file);
		}
		const filename = file.name || 'Unknown';
		const infoFilename = document.getElementById('info_filename');
		if(infoFilename) infoFilename.textContent = filename;

		await engine.loadFile(filePath || file);
		if(autoPlay) await engine.play();
		updateUI();
	} catch(err) {
		console.error('Failed to load file:', err);
		showError('Failed to load file: ' + err.message);
	}
}

async function init(initData){
	console.log('Pitchtime init', initData);
	const main = document.querySelector('main');
	
	g.initData = initData || {};
	g.config = g.initData.config || {};

	const theme = (g.config && g.config.ui) ? g.config.ui.theme : 'dark';
	if(theme === 'dark') document.body.classList.add('dark');
	else document.body.classList.remove('dark');

	// Initialize volume from stage if provided
	if(typeof g.initData.currentVolume === 'number' && isFinite(g.initData.currentVolume)){
		g.master_gain_val = g.initData.currentVolume;
	} else if(typeof g.master_gain_val !== 'number' || !isFinite(g.master_gain_val)){
		g.master_gain_val = 1.0;
	}

	await ensureEngine();
	setupVolumeControls();

	setupTransportControls();
	setupParameterControls();
	setupDragAndDrop();

	// Load current file if provided by stage
	if(g.initData && g.initData.currentFile){
		if(!(await ensureEngine())) return;
		const filePath = g.initData.currentFile;
		const filename = filePath.split(/[\\/]/).pop() || 'Unknown';
		const infoFilename = document.getElementById('info_filename');
		if(infoFilename) infoFilename.textContent = filename;
		
		try {
			showLoading();
			await engine.loadFile(filePath);
			hideLoading();
			if(g.initData.currentTime){
				engine.seek(g.initData.currentTime);
			}
			engine.play();
			updateUI();
		} catch(err) {
			hideLoading();
			console.error('Failed to load initial file:', err);
			showError('Failed to load file: ' + err.message);
		}
	}

	setInterval(() => {
		if(engine && engine.isPlaying) updateUI();
	}, 100);

	if(main){
		main.classList.add('ready');
	}

	// Keyboard shortcuts
	window.addEventListener('keydown', (e) => {
		if(!e) return;
		const code = '' + (e.code || '');

		// F12: Toggle DevTools
		if(code === 'F12'){
			e.preventDefault();
			if(window.bridge && window.bridge.toggleDevTools) window.bridge.toggleDevTools();
			return;
		}

		// Arrow keys for pitch/tempo adjustment
		if(code === 'ArrowUp' || code === 'ArrowDown'){
			e.preventDefault();
			if(!g_params || !g_params.pitchControl || !g_params.pitchValue) return;
			const current = parseInt(g_params.pitchValue.textContent || '0', 10);
			const delta = (code === 'ArrowUp') ? 1 : -1;
			const newVal = Math.max(-24, Math.min(24, current + delta));
			g_params.pitchControl.update(newVal);
			g_params.pitchValue.textContent = newVal;
			if(engine) engine.setPitch(newVal);
			return;
		}

		if(code === 'ArrowLeft' || code === 'ArrowRight'){
			e.preventDefault();
			if(!g_params || !g_params.tempoControl || !g_params.tempoValue) return;
			const current = parseInt(g_params.tempoValue.textContent || '100', 10);
			const delta = (code === 'ArrowRight') ? 5 : -5;
			const newVal = Math.max(50, Math.min(150, current + delta));
			g_params.tempoControl.update(newVal / 100);
			g_params.tempoValue.textContent = newVal;
			if(engine) engine.setTempo(1.0 / (newVal / 100));
			return;
		}

		// Handle global shortcuts via shared module
		if(window.shortcuts && window.shortcuts.handleShortcut){
			const action = window.shortcuts.handleShortcut(e, 'pitchtime');
			if(action) return;
		}
	});

	if(window.bridge && window.bridge.isElectron){
		window.bridge.on('theme-changed', (data) => {
			if(data.dark){
				document.body.classList.add('dark');
			} else {
				document.body.classList.remove('dark');
			}
		});
		window.bridge.on('pitchtime-file', async (data) => {
			if(!data || !data.currentFile) return;
			if(!(await ensureEngine())) return;
			try {
				const filePath = data.currentFile;
				const filename = filePath.split(/[\\/]/).pop() || 'Unknown';
				const infoFilename = document.getElementById('info_filename');
				if(infoFilename) infoFilename.textContent = filename;

				showLoading();
				await engine.loadFile(filePath);
				hideLoading();
				if(data.currentTime) engine.seek(data.currentTime);
				engine.play();
				updateUI();
			} catch(err) {
				hideLoading();
				console.error('Failed to load pitchtime-file:', err);
				showError('Failed to load file: ' + err.message);
			}
		});
		// Electron secondary windows are often hidden (not unloaded) when closed.
		// Ensure the whole audio pipeline is torn down on hide, and recreated on show.
		window.bridge.on('hide-window', async () => {
			if(engineInitPromise){
				try { await engineInitPromise; } catch(e) {}
			}
			if(engine){
				try { await engine.dispose(); } catch(e) {}
				engine = null;
			}
		});
		window.bridge.on('show-window', async () => {
			await ensureEngine();
		});
	}
}

window.addEventListener('bridge-ready', (e) => {
	init(e.detail);
});

window.addEventListener('beforeunload', () => {
	if(engine) engine.dispose();
});
