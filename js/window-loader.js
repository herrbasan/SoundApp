'use strict';

const isElectron = typeof process !== 'undefined' && process.versions && process.versions.electron;

let bridge;

if (isElectron) {
	document.body.classList.add('electron');
	
	const { ipcRenderer } = require('electron');
	const helper = require('../libs/electron_helper/helper_new.js');
	const tools = helper.tools;
	
	let stageId = null;
	let windowId = null;
	let windowType = null;
	
	bridge = {
		sendToStage: (channel, data) => tools.sendToId(stageId, channel, data),
		sendToId: (id, channel, data) => tools.sendToId(id, channel, data),
		broadcast: (channel, data) => tools.broadcast(channel, data),
		on: (channel, cb) => ipcRenderer.on(channel, (e, d) => cb(d)),
		once: (channel, cb) => ipcRenderer.once(channel, (e, d) => cb(d)),
		config: helper.config,
		window: helper.window,
		closeWindow: () => {
			if (stageId && windowType) {
				tools.sendToId(stageId, 'window-closed', { type: windowType, windowId: windowId });
			}
			helper.window.close();
		},
		isElectron: true,
		get stageId() { return stageId; },
		get windowId() { return windowId; }
	};
	
	// Listen for theme changes (register early)
	ipcRenderer.on('theme-changed', (e, data) => {
		if (data.dark) {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
	});
	
	// Listen for show window command
	ipcRenderer.on('show-window', () => {
		helper.window.show();
		helper.window.focus();
	});
	
	// Listen for hide window command
	ipcRenderer.on('hide-window', () => {
		helper.window.hide();
	});
	
	// Listen for close window command
	ipcRenderer.on('close-window', () => {
		helper.window.close();
	});
	
	// Add global keyboard shortcuts
	document.addEventListener('keydown', (e) => {
		if(e.keyCode == 122){ // F11 - toggle DevTools
			helper.window.toggleDevTools();
		}
	});
	
	// Setup window chrome functionality
	setupChrome();
	
	// Wait for init_data from stage
	ipcRenderer.once('init_data', async (e, data) => {
		stageId = data.stageId;
		windowId = await helper.window.getId();
		windowType = data.type;
		
		// Apply theme from config
		if (data.config && data.config.theme === 'dark') {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
		
		dispatchBridgeReady(data);
	});
	
	function setupChrome() {
		// Close button (NUI framework selector)
		let closeBtn = document.querySelector('.nui-app .controls .close');
		if (closeBtn) {
			closeBtn.addEventListener('click', () => bridge.closeWindow());
		}
		
		// Focus/blur states
		helper.window.hook_event('blur', (e, data) => {
			document.body.classList.remove('focus');
		});
		helper.window.hook_event('focus', (e, data) => {
			document.body.classList.add('focus');
		});
		
		// Show window once ready
		helper.window.show();
	}
} 
else {
	// Browser preview mode - mock bridge
	bridge = {
		sendToStage: (channel, data) => console.log('→ Stage:', channel, data),
		sendToId: (id, channel, data) => console.log('→ Window', id, ':', channel, data),
		broadcast: (channel, data) => console.log('→ Broadcast:', channel, data),
		on: (channel, cb) => console.log('Listening:', channel),
		once: (channel, cb) => console.log('Listening once:', channel),
		config: createMockConfig(),
		window: { show: () => {}, hide: () => {}, close: () => {} },
		closeWindow: () => console.log('Close window'),
		isElectron: false,
		stageId: null,
		windowId: null
	};
	
	// Browser preview: Load theme from localStorage
	let savedTheme = localStorage.getItem('preview-theme') || 'dark';
	if (savedTheme === 'dark') {
		document.body.classList.add('dark');
	}
	
	// Browser preview: X key toggles theme
	document.addEventListener('keydown', (e) => {
		if(e.keyCode == 88){ // X key
			document.body.classList.toggle('dark');
			let isDark = document.body.classList.contains('dark');
			localStorage.setItem('preview-theme', isDark ? 'dark' : 'light');
			console.log('Preview theme toggled:', isDark ? 'dark' : 'light');
		}
	});
	
	// Simulate init_data after short delay
	setTimeout(() => {
		dispatchBridgeReady(getMockInitData());
	}, 100);
}

window.bridge = bridge;

function dispatchBridgeReady(data) {
	window.dispatchEvent(new CustomEvent('bridge-ready', { detail: data }));
}

function createMockConfig() {
	return {
		initRenderer: async (name, onChange) => {
			let data = JSON.parse(localStorage.getItem('mock-config-' + name) || '{}');
			return {
				get: () => data,
				set: (newData) => {
					data = { ...data, ...newData };
					localStorage.setItem('mock-config-' + name, JSON.stringify(data));
					if (onChange) onChange(data);
					console.log('Config updated:', name, data);
				}
			};
		}
	};
}

function getMockInitData() {
	const pageName = location.pathname.split('/').pop().replace('.html', '');
	const mockData = {
		help: {
			type: 'help',
			shortcuts: [
				{ key: 'Space', action: 'Play / Pause' },
				{ key: 'L', action: 'Toggle loop mode' },
				{ key: 'R', action: 'Shuffle playlist' },
				{ key: '←', action: 'Previous track' },
				{ key: '→', action: 'Next track' },
				{ key: 'Ctrl + ←', action: 'Skip back 10 seconds' },
				{ key: 'Ctrl + →', action: 'Skip forward 10 seconds' },
				{ key: '↑', action: 'Volume up' },
				{ key: '↓', action: 'Volume down' },
				{ key: 'I', action: 'Show file in folder' },
				{ key: 'Ctrl + +', action: 'Scale UI up' },
				{ key: 'Ctrl + -', action: 'Scale UI down' },
				{ key: 'F12', action: 'Toggle DevTools' },
				{ key: 'Esc', action: 'Exit application' }
			]
		},
		settings: {
			type: 'settings',
			config: { volume: 0.8, loop: false, theme: 'dark' }
		},
		playlist: {
			type: 'playlist',
			music: ['track1.mp3', 'track2.mp3', 'track3.mp3'],
			idx: 0
		}
	};
	return mockData[pageName] || { type: pageName };
}
