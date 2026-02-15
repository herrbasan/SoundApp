'use strict';

const isElectron = typeof process !== 'undefined' && process.versions && process.versions.electron;

let bridge;

if (isElectron) {
	document.body.classList.add('electron');
	
	const { ipcRenderer } = require('electron');
	const helper = require('../libs/electron_helper/helper_new.js');
	const tools = helper.tools;
	
	// Safe logger initialization - don't let logging break window loading
	let logger;
	try {
		logger = require('./logger-renderer');
	} catch (e) {
		// Fallback logger that just logs to console
		logger = {
			init: () => {},
			debug: () => {},
			info: (...args) => console.log('[INFO]', ...args),
			warn: (...args) => console.warn('[WARN]', ...args),
			error: (...args) => console.error('[ERROR]', ...args)
		};
	}
	
	let stageId = null;
	let windowId = null;
	let windowType = null;
	
	// MessagePort for direct engine communication (set when received)
	let messagePort = null;
	// Handlers that should also be attached to MessagePort when it arrives
	const portHandlers = new Map();
	
	bridge = {
		sendToStage: (channel, data) => tools.sendToId(stageId, channel, data),
		sendToId: (id, channel, data) => tools.sendToId(id, channel, data),
		sendToMain: (channel, data) => ipcRenderer.send(channel, data),
		broadcast: (channel, data) => tools.broadcast(channel, data),
		on: (channel, cb) => {
			// Always listen on IPC (for main-process messages)
			ipcRenderer.on(channel, (e, d) => cb(d));
			// Also store for MessagePort (will be attached when port arrives)
			portHandlers.set(channel, cb);
			// If port already exists, attach immediately
			if (messagePort) {
				messagePort.onmessage = (e) => {
					if (e.data && e.data.channel === channel) {
						cb(e.data.data);
					}
				};
			}
		},
		once: (channel, cb) => ipcRenderer.once(channel, (e, d) => cb(d)),
		config: helper.config,
		window: helper.window,
		closeWindow: () => {
			// Always trigger local hide-window listeners (e.g. Mixer cleanup) before we hide/close.
			ipcRenderer.emit('hide-window', {}, {});

			// For Mixer we want a real close/destroy (memory experiments).
			if(windowType === 'mixer'){
				try { helper.window.close(); } catch(e) {}
				return;
			}

			// Default behavior for secondary windows: hide (fast reopen)
			if (stageId && windowType) {
				tools.sendToId(stageId, 'window-hidden', { type: windowType, windowId: windowId });
			}
			helper.window.hide();
		},
		isElectron: true,
		get stageId() { return stageId; },
		get windowId() { return windowId; },
		toggleDevTools: () => helper.window.toggleDevTools(),
		logger: logger
	};
	
	// Listen for theme changes (register early)
	ipcRenderer.on('theme-changed', (e, data) => {
		if (data.dark) {
			document.body.classList.add('dark');
		} else {
			document.body.classList.remove('dark');
		}
	});
	
	// Listen for engine recreation - update stageId so messages reach the new engine
	ipcRenderer.on('update-stage-id', (e, data) => {
		if (data && data.stageId) {
			stageId = data.stageId;
		}
	});
	
	// Receive MessagePort from main for direct engine-to-window communication
	ipcRenderer.on('message-channel', (e, meta) => {
		const port = e.ports[0];
		if (!port) return;
		
		if (meta.role === 'window') {
			// Close old port if exists
			if (messagePort) {
				try { messagePort.close(); } catch (e) {}
			}
			
			// Store port for direct communication
			messagePort = port;
			
			// IMPORTANT: Start the port to receive messages
			// Without this, messages queue up in memory causing OOM
			port.start();
			
			// Attach existing handlers to the port
			port.onmessage = (e) => {
				if (e.data && e.data.channel) {
					const handler = portHandlers.get(e.data.channel);
					if (handler) {
						handler(e.data.data);
					}
				}
			};
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
		bridge.closeWindow();
	});

	// Tray / main-process helper: reset window bounds (e.g. after disconnected monitors)
	ipcRenderer.on('windows-reset', async (e, windowsConfig) => {
		try {
			if(!windowsConfig || !windowType) return;
			let b = windowsConfig[windowType];
			if(!b) return;
			await helper.window.setBounds({ x: b.x|0, y: b.y|0, width: b.width|0, height: b.height|0 });
			helper.window.show();
			helper.window.focus();
		} catch(err) {
			console.error('windows-reset failed:', err);
		}
	});
	
	// Add global keyboard shortcuts
	document.addEventListener('keydown', (e) => {
		// F12 (keyCode 123) or F11 (keyCode 122) - toggle DevTools
		if(e.keyCode === 123 || e.keyCode === 122){
			helper.window.toggleDevTools();
		}
	});
	
	// Setup window chrome functionality
	setupChrome();
	
	// Wait for init_data from stage
	ipcRenderer.once('init_data', async (e, data) => {
		stageId = data.stageId;
		
		if(data.windowId){
			windowId = data.windowId;
		} else {
			windowId = await helper.window.getId();
		}
		
		windowType = data.type;
		
		// Initialize logger with detected window type (safely)
		// captureConsole=true to redirect all console.* to log file
		if (logger && logger.init) {
			logger.init(windowType, true);
			if (logger.info) logger.info('Window initialized', { windowType, windowId, stageId });
		}
		
		let closedSent = false;
		let boundsSaveTimer = 0;
		let lastBounds = null;
		const sendClosedOnce = () => {
			if(closedSent) return;
			closedSent = true;
			if(stageId && windowType){
				tools.sendToId(stageId, 'window-closed', { type: windowType, windowId: windowId });
			}
		};
		// If user closes via OS controls / Alt+F4, ensure stage gets the cleanup message.
		window.addEventListener('beforeunload', sendClosedOnce);

		function applyTheme(cnf){
			const theme = (cnf && cnf.ui && cnf.ui.theme) ? cnf.ui.theme : ((cnf && cnf.theme) ? cnf.theme : 'dark');
			if(theme === 'dark'){
				document.body.classList.add('dark');
			}
			else {
				document.body.classList.remove('dark');
			}
		}

		// Centralized config wiring (Phase 1)
		// - Provides data.config_obj + data.config for all windows
		// - Applies theme from the live config
		// - Keeps backward-compatibility: if initRenderer fails, fall back to init_data.config
		let config_obj = null;
		try {
			const configName = data.configName || 'user';
			config_obj = await helper.config.initRenderer(configName, (newConfig) => {
				data.config = newConfig;
				applyTheme(newConfig);
			}, { initialConfig: data.config });
		} catch(err) {
			console.error('window-loader: initRenderer failed, falling back to init_data.config', err);
		}

		function scheduleSaveBounds(){
			if(!config_obj || !windowType) return;
			if(boundsSaveTimer) clearTimeout(boundsSaveTimer);
			boundsSaveTimer = setTimeout(async () => {
				if(!config_obj || !windowType) return;
				let bounds = await helper.window.getBounds();
				if(!bounds) return;
				if(lastBounds && bounds.x === lastBounds.x && bounds.y === lastBounds.y && bounds.width === lastBounds.width && bounds.height === lastBounds.height) return;
				lastBounds = bounds;
				let cnf = config_obj.get() || {};
				if(!cnf.windows) cnf.windows = {};
				if(!cnf.windows[windowType]) cnf.windows[windowType] = {};
				cnf.windows[windowType] = {
					...cnf.windows[windowType],
					x: bounds.x|0,
					y: bounds.y|0,
					width: bounds.width|0,
					height: bounds.height|0
				};
				config_obj.set(cnf);
			}, 350);
		}

		// Phase 6: persist secondary-window bounds automatically
		helper.window.hook_event('move', scheduleSaveBounds);
		helper.window.hook_event('resize', scheduleSaveBounds);

		data.config_obj = config_obj;
		if(config_obj){
			data.config = config_obj.get() || data.config;
		}
		applyTheme(data.config);
		dispatchBridgeReady(data);
		
		// Signal that window is ready to receive messages
		if(stageId){
			tools.sendToId(stageId, 'window-ready', { type: windowType, windowId: windowId });
		}
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
		
		// Window is shown via 'show-window' IPC from stage after creation
		// Don't auto-show here to avoid white flash before content is ready
	}
} 
else {
	// Browser preview mode - mock bridge
	bridge = {
		sendToStage: (channel, data) => console.log('→ Stage:', channel, data),
		sendToId: (id, channel, data) => console.log('→ Window', id, ':', channel, data),
		sendToMain: (channel, data) => console.log('→ Main:', channel, data),
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
	
	// Simulate init_data after short delay to ensure page modules are ready
	setTimeout(() => {
		dispatchBridgeReady(getMockInitData());
	}, 50);
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
					data = newData || {};
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
			config: {
				config_version: 2,
				ui: { theme: 'dark', defaultDir: '' },
				audio: { volume: 0.8, output: { deviceId: '' }, hqMode: false },
				ffmpeg: { stream: { prebufferChunks: 10 }, decoder: { threads: 0 }, transcode: { ext: '.wav', cmd: '-c:a pcm_s16le' } },
				tracker: { stereoSeparation: 100, interpolationFilter: 0 },
				mixer: { preBuffer: 50 },
				windows: { main: { x: null, y: null, width: 480, height: 217, scale: 14 } }
			}
		},
		playlist: {
			type: 'playlist',
			music: ['track1.mp3', 'track2.mp3', 'track3.mp3'],
			idx: 0
		},
		mixer: {
			type: 'mixer',
			config: { theme: 'dark' },
			playlist: {
				paths: []
			}
		},
		parameters: {
			type: 'parameters',
			mode: 'audio',
			params: {
				tapeSpeed: 0,
				pitch: 0,
				tempo: 100
			},
			soundfonts: [
				{ name: 'Default SoundFont', path: '/soundfonts/default.sf2' },
				{ name: 'Piano', path: '/soundfonts/piano.sf2' }
			],
			currentSoundfont: '/soundfonts/default.sf2',
			config: { theme: 'dark' }
		}
	};
	return mockData[pageName] || { type: pageName };
}
