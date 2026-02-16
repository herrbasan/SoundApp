import ut from '../../libs/nui/nui_ut.js';
import superSelect from '../../libs/nui/nui_select.js';

window.ut = ut;
window.superSelect = superSelect;

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

function initAudioInfo(data) {
	if (data.maxSampleRate) {
		document.getElementById('maxSampleRate').textContent = data.maxSampleRate + ' Hz';
	}
	if (data.currentSampleRate) {
		document.getElementById('currentSampleRate').textContent = data.currentSampleRate + ' Hz';
	}
}

function initHQMode() {
	const hqToggle = document.getElementById('hqModeToggle');
	const hqNotice = document.getElementById('hqRestartNotice');
	if (getCfg(['audio', 'hqMode'], false)) {
		hqToggle.checked = true;
	}

	hqToggle.addEventListener('change', () => {
		setCfgValue(['audio', 'hqMode'], !!hqToggle.checked);
		hqNotice.classList.add('visible');

		setTimeout(() => {
			hqNotice.classList.remove('visible');
		}, 3000);
	});
}


function initDarkTheme() {
	const darkThemeToggle = document.getElementById('darkThemeToggle');
	if (getCfg(['ui', 'theme'], 'dark') === 'dark') {
		darkThemeToggle.checked = true;
	}

	darkThemeToggle.addEventListener('change', () => {
		setCfgValue(['ui', 'theme'], darkThemeToggle.checked ? 'dark' : 'light');
	});

	bridge.on('theme-changed', (data) => {
		darkThemeToggle.checked = data.dark;
		if (data.dark) {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
	});
}

function initKeepRunningInTray() {
	const keepRunningInTrayToggle = document.getElementById('keepRunningInTrayToggle');
	if (keepRunningInTrayToggle) {
		keepRunningInTrayToggle.checked = !!getCfg(['ui', 'keepRunningInTray'], false);
		keepRunningInTrayToggle.addEventListener('change', () => {
			setCfgValue(['ui', 'keepRunningInTray'], !!keepRunningInTrayToggle.checked);
		});
	}
}

function initShowControls() {
	const showControlsToggle = document.getElementById('showControlsToggle');
	if (showControlsToggle) {
		showControlsToggle.checked = getCfg(['ui', 'showControls'], false);
		showControlsToggle.addEventListener('change', () => {
			setCfgValue(['ui', 'showControls'], !!showControlsToggle.checked);
		});
	}
}

function initSampleRateListener() {
	bridge.on('sample-rate-updated', (data) => {
		if (data.currentSampleRate) {
			document.getElementById('currentSampleRate').textContent = data.currentSampleRate + ' Hz';
		}
	});
}

async function initOutputDevice() {
	const deviceSelect = document.getElementById('outputDeviceSelect');
	const deviceNotice = document.getElementById('deviceChangeNotice');
	let deviceSelectWidget = null;
	let deviceLoadDebounce = null;

	async function loadAudioDevices() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			const audioOutputs = devices.filter(d => {
				if (d.kind !== 'audiooutput') return false;
				if (d.label && d.label.toLowerCase().includes('communications')) return false;
				return true;
			});

			const options = [
				{ name: 'System Default', value: '', selected: !getCfg(['audio', 'output', 'deviceId'], '') }
			];

			audioOutputs.forEach(device => {
				const label = device.label || `Device ${device.deviceId.substring(0, 8)}`;
				if (label.toLowerCase().includes('system default') || label.toLowerCase() === 'default') {
					return;
				}

				options.push({
					name: label,
					value: device.deviceId,
					selected: device.deviceId === getCfg(['audio', 'output', 'deviceId'], '')
				});
			});

			deviceSelect.innerHTML = '';
			options.forEach(opt => {
				const option = document.createElement('option');
				option.value = opt.value;
				option.textContent = opt.name;
				if (opt.selected) option.selected = true;
				deviceSelect.appendChild(option);
			});

			if (deviceSelectWidget) {
				deviceSelectWidget.reRender();
			} else {
				deviceSelectWidget = superSelect(deviceSelect, { searchable: false });
			}

			const currentDevId = getCfg(['audio', 'output', 'deviceId'], '');
			if (currentDevId) {
				const deviceExists = audioOutputs.some(d => d.deviceId === currentDevId);
				if (!deviceExists) {
					console.log('Configured output device not found, using system default');
				}
			}
		} catch (err) {
			console.error('Failed to enumerate devices:', err);
		}
	}

	await loadAudioDevices();

	navigator.mediaDevices.addEventListener('devicechange', () => {
		if (deviceLoadDebounce) clearTimeout(deviceLoadDebounce);
		deviceLoadDebounce = setTimeout(loadAudioDevices, 500);
	});

	deviceSelect.addEventListener('change', () => {
		const deviceId = deviceSelect.value;
		setCfgValue(['audio', 'output', 'deviceId'], deviceId || '');
		deviceNotice.classList.add('visible');

		setTimeout(() => {
			deviceNotice.classList.remove('visible');
		}, 2000);
	});
}

function initBufferSize() {
	const bufferSizeSelect = document.getElementById('bufferSizeSelect');
	bufferSizeSelect.value = getCfg(['ffmpeg', 'stream', 'prebufferChunks'], 10);
	superSelect(bufferSizeSelect, { searchable: false });

	let bufferChangeTimeout = null;
	bufferSizeSelect.addEventListener('change', () => {
		clearTimeout(bufferChangeTimeout);
		bufferChangeTimeout = setTimeout(() => {
			const bufferSize = parseInt(bufferSizeSelect.value);
			setCfgValue(['ffmpeg', 'stream', 'prebufferChunks'], bufferSize);
		}, 200);
	});
}

function initDecoderThreads() {
	const decoderThreadsSelect = document.getElementById('decoderThreadsSelect');
	decoderThreadsSelect.value = getCfg(['ffmpeg', 'decoder', 'threads'], 0);
	superSelect(decoderThreadsSelect, { searchable: false });

	let threadsChangeTimeout = null;
	decoderThreadsSelect.addEventListener('change', () => {
		clearTimeout(threadsChangeTimeout);
		threadsChangeTimeout = setTimeout(() => {
			const threadCount = parseInt(decoderThreadsSelect.value);
			setCfgValue(['ffmpeg', 'decoder', 'threads'], threadCount);
		}, 200);
	});
}

function initMixerPreBuffer() {
	const mixerPreBufferSelect = document.getElementById('mixerPreBufferSelect');
	mixerPreBufferSelect.value = getCfg(['mixer', 'preBuffer'], 50);
	superSelect(mixerPreBufferSelect, { searchable: false });

	let preBufferChangeTimeout = null;
	mixerPreBufferSelect.addEventListener('change', () => {
		clearTimeout(preBufferChangeTimeout);
		preBufferChangeTimeout = setTimeout(() => {
			const preBuffer = parseInt(mixerPreBufferSelect.value);
			setCfgValue(['mixer', 'preBuffer'], preBuffer);
		}, 200);
	});
}

function initDefaultDirectory() {
	const dirInput = document.getElementById('defaultDirInput');
	const browseBtn = document.getElementById('browseBtn');
	const clearDirBtn = document.getElementById('clearDirBtn');

	function updateClearBtn() {
		clearDirBtn.style.display = dirInput.value ? 'flex' : 'none';
	}

	const cfgDir = getCfg(['ui', 'defaultDir'], '');
	if (cfgDir) {
		dirInput.value = cfgDir;
	}
	updateClearBtn();

	browseBtn.addEventListener('click', () => {
		bridge.sendToStage('browse-directory', {});
	});

	clearDirBtn.addEventListener('click', () => {
		dirInput.value = '';
		updateClearBtn();
		setCfgValue(['ui', 'defaultDir'], '');
	});

	bridge.on('directory-selected', (dirPath) => {
		dirInput.value = dirPath;
		updateClearBtn();
		setCfgValue(['ui', 'defaultDir'], dirPath);
	});
}

function initFileAssociations() {
	const registerBtn = document.getElementById('registerFilesBtn');
	const unregisterBtn = document.getElementById('unregisterFilesBtn');
	const setDefaultBtn = document.getElementById('setDefaultBtn');
	const registryNotice = document.getElementById('registryNotice');

	registerBtn.addEventListener('click', () => {
		bridge.sendToStage('register-file-types', {});
	});

	unregisterBtn.addEventListener('click', () => {
		bridge.sendToStage('unregister-file-types', {});
	});

	setDefaultBtn.addEventListener('click', () => {
		bridge.sendToStage('open-default-programs', {});
	});

	bridge.on('registry-action-complete', (data) => {
		registryNotice.textContent = data.success ? 'Done!' : 'Failed: ' + data.error;
		registryNotice.classList.add('visible');
		setTimeout(() => {
			registryNotice.classList.remove('visible');
		}, 2000);
	});
}

async function init(data) {
	bridge = window.bridge;
	config = data.config || {};
	config_obj = data.config_obj || null;

	if (bridge && bridge.isElectron) {
		window.addEventListener('keydown', (e) => {
			const code = e.code || '';

			// Don't trigger if typing in an input (handled by shortcuts.js check usually, but good to have explicit check for local handlers)
			const target = e.target;
			const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

			// Handle global shortcuts via shared module
			let action = '';
			if (!isInput && window.shortcuts && window.shortcuts.handleShortcut) {
				action = window.shortcuts.handleShortcut(e, 'settings');
			}

			// Local overrides: S or Escape closes settings
			if ((action === 'toggle-settings' || code === 'Escape') && !isInput) {
				e.preventDefault();
				bridge.closeWindow();
				return;
			}

			// F12: Toggle DevTools
			if (code === 'F12') {
				e.preventDefault();
				if (bridge.toggleDevTools) bridge.toggleDevTools();
				return;
			}

			if (action) return;

			// Relay other keys to stage (e.g. space for play/pause) - ONLY if not typing
			if (!isInput && bridge.sendToStage) {
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
	}

	initAudioInfo(data);
	initHQMode();
	initDarkTheme();
	initKeepRunningInTray();
	initShowControls();
	initSampleRateListener();
	await initOutputDevice();
	initBufferSize();
	initDecoderThreads();
	initMixerPreBuffer();
	initDefaultDirectory();
	initFileAssociations();
}

main.init = init;
export { main };
