'use strict';

/**
 * PLAYER.JS - UI-only Renderer
 * 
 * Derived from stage.js by stripping all audio code.
 * Handles UI rendering, user input, and communicates with app.js via IPC.
 * All audio playback is handled by engines.js (hidden renderer).
 */

const { ipcRenderer, webUtils } = require("electron");
const fs = require('fs').promises;
const path = require('path');
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const shortcuts = require('../js/shortcuts.js');

// DEBUG: Define disposeIPC immediately at global scope
// This allows testing IPC disposal even if setupIPC() hasn't run yet
window.disposeIPC = {
    all: function () {
        console.log('[Debug] Removing ALL IPC listeners...');
        ipcRenderer.removeAllListeners('state:update');
        ipcRenderer.removeAllListeners('position');
        ipcRenderer.removeAllListeners('window-closed');
        ipcRenderer.removeAllListeners('window-hidden');
        ipcRenderer.removeAllListeners('window-ready');
        ipcRenderer.removeAllListeners('theme-changed');
        ipcRenderer.removeAllListeners('shortcut');
        ipcRenderer.removeAllListeners('log');
        ipcRenderer.removeAllListeners('main');
        ipcRenderer.removeAllListeners('param-change');
        ipcRenderer.removeAllListeners('midi-reset-params');
        ipcRenderer.removeAllListeners('tracker-reset-params');
        ipcRenderer.removeAllListeners('file-change');
        ipcRenderer.removeAllListeners('waveform-data');
        ipcRenderer.removeAllListeners('waveform-chunk');
        ipcRenderer.removeAllListeners('clear-waveform');
        ipcRenderer.removeAllListeners('ana-data');
        console.log('[Debug] All IPC listeners removed.');
    },
    nonEssential: function () {
        console.log('[Debug] Removing non-essential IPC listeners...');
        ipcRenderer.removeAllListeners('log');
        ipcRenderer.removeAllListeners('waveform-chunk');
        ipcRenderer.removeAllListeners('clear-waveform');
        ipcRenderer.removeAllListeners('ana-data');
        console.log('[Debug] Non-essential IPC listeners removed.');
    },
    status: function () {
        console.log('[Debug] disposeIPC is ready');
    }
};

let g = {};
g.windows = { help: null, settings: null, playlist: null, mixer: null, pitchtime: null, 'midi': null, parameters: null, monitoring: null, 'state-debug': null };
g.windowsClosing = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false, parameters: false, monitoring: false, 'state-debug': false };
g.lastNavTime = 0;
g.mixerPlaying = false;

g.state = {
    file: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 0.5,
    metadata: null,
    fileType: null,
    maxSampleRate: null,
    currentSampleRate: null,
    loop: false,
    playlist: [],
    playlistIndex: 0,
    // Audio params from app.js (ground truth)
    mode: 'tape',
    tapeSpeed: 0,
    pitch: 0,
    tempo: 1.0,
    formant: false,
    locked: false,
    activePipeline: 'normal',
    monitoringSource: null,
    engineAlive: false
};

// File format support (for drag-drop filtering)
g.supportedMpt = ['.mptm', '.mod', '.mo3', '.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf',
    '.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus',
    '.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod',
    '.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];
g.supportedMIDI = ['.mid', '.midi', '.kar', '.rmi'];
g.supportedChrome = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.m4b', '.aac', '.webm'];
g.supportedFFmpeg = ['.mpg', '.mp2', '.aif', '.aiff', '.aa', '.wma', '.asf', '.ape', '.wv', '.wvc', '.tta', '.mka',
    '.amr', '.3ga', '.ac3', '.eac3', '.dts', '.dtshd', '.caf', '.au', '.snd', '.voc', '.tak', '.mpc', '.mp+'];
g.supportedFilter = [...g.supportedChrome, ...g.supportedFFmpeg, ...g.supportedMpt, ...g.supportedMIDI];

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

// Set process title for identification in task manager
process.title = 'SoundApp UI';

// ═══════════════════════════════════════════════════════════════════════════
// STATE CLIENT ACTION HELPERS
// Unified state actions - uses State Client if available, falls back to IPC
// ═══════════════════════════════════════════════════════════════════════════

async function togglePlayback() {
    if (typeof State !== 'undefined' && State.dispatch) {
        await State.dispatch('toggle');
    } else {
        // Legacy IPC fallback
        ipcRenderer.send(g.state.isPlaying ? 'audio:pause' : 'audio:play');
    }
}

async function playNextTrack() {
    if (typeof State !== 'undefined' && State.dispatch) {
        await State.dispatch('next');
    } else {
        ipcRenderer.send('audio:next');
    }
}

async function playPrevTrack() {
    if (typeof State !== 'undefined' && State.dispatch) {
        await State.dispatch('prev');
    } else {
        ipcRenderer.send('audio:prev');
    }
}

async function seekToPosition(position) {
    if (typeof State !== 'undefined' && State.dispatch) {
        await State.dispatch('seek', { position });
    } else {
        ipcRenderer.send('audio:seek', position);
    }
}

init();
async function init() {
    fb('Init Player UI');
    g.win = helper.window;
    g.main_env = await helper.global.get('main_env');
    g.basePath = await helper.global.get('base_path');
    g.isPackaged = await helper.global.get('isPackaged');
    g.cache_path = await helper.global.get('temp_path');
    g.start_vars = await helper.global.get('start_vars');
    g.app_path = await helper.app.getAppPath();

    g.configName = g.main_env.configName || 'user';
    g.config_obj = await helper.config.initRenderer(g.configName, async (newData) => {
        const oldConfig = g.config || {};
        g.config = newData || {};

        const oldTheme = (oldConfig && oldConfig.ui) ? oldConfig.ui.theme : undefined;
        const theme = (g.config && g.config.ui) ? g.config.ui.theme : 'dark';

        if (oldTheme !== theme) {
            if (theme === 'dark') {
                document.body.classList.add('dark');
            } else {
                document.body.classList.remove('dark');
            }
            tools.sendToMain('command', { command: 'set-theme', theme: theme });
        }

        const oldShowControls = (oldConfig && oldConfig.ui) ? !!oldConfig.ui.showControls : false;
        const showControls = (g.config && g.config.ui) ? !!g.config.ui.showControls : false;
        if (oldShowControls !== showControls) {
            applyShowControls(showControls, true);
        }

        // Update volume display if changed externally
        if (g.config.audio && g.config.audio.volume !== undefined) {
            g.state.volume = g.config.audio.volume;
            updateVolumeUI();
        }
    });
    g.config = g.config_obj.get();
    let saveCnf = false;
    if (!g.config || typeof g.config !== 'object') g.config = {};
    if (!g.config.windows) g.config.windows = {};
    if (!g.config.windows.main) g.config.windows.main = {};
    let s = (g.config.windows.main.scale !== undefined) ? (g.config.windows.main.scale | 0) : 14;
    if (s < 14) { s = 14; saveCnf = true; }
    if ((g.config.windows.main.scale | 0) !== s) { g.config.windows.main.scale = s; saveCnf = true; }
    if (saveCnf) { g.config_obj.set(g.config); }

    const theme0 = (g.config && g.config.ui) ? g.config.ui.theme : 'dark';
    if (theme0 === 'dark') {
        document.body.classList.add('dark');
    } else {
        document.body.classList.remove('dark');
    }
    tools.sendToMain('command', { command: 'set-theme', theme: theme0 });

    const showControls0 = (g.config && g.config.ui && g.config.ui.showControls) ? true : false;
    applyShowControls(showControls0);

    ut.setCssVar('--space-base', s);

    let b = (g.config.windows && g.config.windows.main && g.config.windows.main.width && g.config.windows.main.height) ? g.config.windows.main : null;
    if (b) {
        const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
        const baseMinH = showControls0 ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
        const scale0 = _getMainScale();
        const minW = _scaledDim(MIN_WIDTH, scale0);
        const minH = _scaledDim(baseMinH, scale0);
        const nb = { width: b.width | 0, height: b.height | 0 };
        if (b.x !== undefined && b.x !== null) nb.x = b.x | 0;
        if (b.y !== undefined && b.y !== null) nb.y = b.y | 0;
        if (nb.width < minW) nb.width = minW;
        if (nb.height < minH) nb.height = minH;
        await g.win.setBounds(nb);
        g.config.windows.main = { ...g.config.windows.main, x: nb.x, y: nb.y, width: nb.width, height: nb.height, scale: s | 0 };
    }

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    g.win.show();
    if (!g.isPackaged) { g.win.toggleDevTools() }

    setupIPC();
    setupWindow();
    setupDragDrop();
    appStart();
}

function setupIPC() {
    // Receive state updates from app.js - render directly from broadcast
    ipcRenderer.on('state:update', (e, data) => {
        // Update read-only cache for rendering (main is source of truth)
        if (data.file !== undefined) g.state.file = data.file;
        if (data.isPlaying !== undefined) g.state.isPlaying = data.isPlaying;
        if (data.position !== undefined) g.state.position = data.position;
        if (data.duration !== undefined) g.state.duration = data.duration;
        if (data.volume !== undefined) g.state.volume = data.volume;
        if (data.metadata !== undefined) g.state.metadata = data.metadata;
        if (data.fileType !== undefined) g.state.fileType = data.fileType;
        if (data.loop !== undefined) g.state.loop = data.loop;
        if (data.maxSampleRate !== undefined) g.state.maxSampleRate = data.maxSampleRate;
        if (data.currentSampleRate !== undefined) g.state.currentSampleRate = data.currentSampleRate;
        if (data.playlist !== undefined) g.state.playlist = data.playlist;
        if (data.playlistIndex !== undefined) g.state.playlistIndex = data.playlistIndex;
        // Audio params from app.js (ground truth)
        if (data.mode !== undefined) g.state.mode = data.mode;
        if (data.tapeSpeed !== undefined) g.state.tapeSpeed = data.tapeSpeed;
        if (data.pitch !== undefined) g.state.pitch = data.pitch;
        if (data.tempo !== undefined) g.state.tempo = data.tempo;
        if (data.formant !== undefined) g.state.formant = data.formant;
        if (data.locked !== undefined) g.state.locked = data.locked;
        if (data.activePipeline !== undefined) g.state.activePipeline = data.activePipeline;
        if (data.monitoringSource !== undefined) g.state.monitoringSource = data.monitoringSource;
        // Engine state from app.js (ground truth)
        if (data.engineAlive !== undefined) g.state.engineAlive = data.engineAlive;

        // Update UI directly from broadcast state
        updateUI();
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE CLIENT INTEGRATION (New - alongside legacy code)
    // Gradual migration from manual IPC to unified State Client API
    // ═══════════════════════════════════════════════════════════════════════════
    if (typeof State !== 'undefined') {
        // Subscribe to state changes using State Client
        // These work alongside existing ipcRenderer listeners for gradual migration
        
        State.subscribe('playback.isPlaying', (isPlaying) => {
            // Sync with legacy g.state
            g.state.isPlaying = isPlaying;
            updatePlayButton();
        });

        State.subscribe('playback.position', (position) => {
            g.state.position = position;
            updatePositionUI();
        });

        State.subscribe('playback.file', (file) => {
            g.state.file = file;
            updateFileDisplay();
        });

        State.subscribe('playback.duration', (duration) => {
            g.state.duration = duration;
            updateDurationUI();
        });

        State.subscribe('audio.*', (value, oldValue, key) => {
            // Wildcard subscription for all audio params
            const param = key.split('.')[1];
            if (g.state[param] !== undefined) {
                g.state[param] = value;
            }
            updateUI();
        });

        State.subscribe('system.engineAlive', (alive) => {
            g.state.engineAlive = alive;
            // Could show/hide "engine sleeping" indicator here
        });

        console.log('[Player] State Client subscriptions registered');
    }

    // Receive position updates (frequent, ≤15ms)
    ipcRenderer.on('position', (e, position) => {
        g.state.position = position;
        updatePositionUI();
    });

    // Receive idle time updates (for debug display)
    ipcRenderer.on('idle:time', (e, data) => {
        updateIdleDebugDisplay(data);
    });

    // Handle file drops from main process
    ipcRenderer.on('main', async (e, data) => {
        if (data.length == 1) {
            await playListFromSingle(data[0], false);
        } else {
            await playListFromMulti(data, false, false);
        }
        // Send playlist to app.js and load first file
        sendPlaylistToApp();
        ipcRenderer.send('audio:load', { file: g.state.playlist[g.state.playlistIndex], position: 0, paused: false });
        g.win.focus();
    });

    ipcRenderer.on('log', (e, data) => {
        console.log('%c' + data.context, 'color:#6058d6', data.data);
    });

    ipcRenderer.on('window-closed', (e, data) => {
        console.log('[window-closed] received:', data.type, 'windowId:', data.windowId, 'current g.windows:', g.windows[data.type]);
        if (g.windows[data.type] === data.windowId) {
            g.windows[data.type] = null;
            console.log('[window-closed] Cleared tracking for', data.type);
        }
        if (g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;
        // Forward to app.js for engine tracking and focus management
        ipcRenderer.send('window-closed', data);
    });

    ipcRenderer.on('window-hidden', async (e, data) => {
        console.log('[PLAYER] window-hidden received:', data?.type, 'windowId:', data?.windowId);
        console.log('[PLAYER] Current tracked window:', g.windows[data?.type]);
        if (g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;
        // Forward to app.js for engine tracking and focus management
        console.log('[PLAYER] Forwarding to main...');
        ipcRenderer.send('window-hidden', data);
    });

    // Forward window-created from child windows to app.js
    ipcRenderer.on('window-created', (e, data) => {
        if (data && data.type) {
            g.windows[data.type] = data.windowId;
            // Forward to app.js for engine tracking
            ipcRenderer.send('window-created', data);
        }
    });

    // Main process tells us to create a new window (it doesn't exist yet)
    ipcRenderer.on('window:create', (e, data) => {
        if (data && data.type) {
            openWindow(data.type);
        }
    });

    // Forward param-change messages from child windows (parameters, etc.) to app.js
    ipcRenderer.on('param-change', (e, data) => {
        ipcRenderer.send('param-change', data);
    });

    // Forward monitoring source changes from child windows (mixer, etc.) to app.js
    ipcRenderer.on('monitoring:setSource', (e, data) => {
        ipcRenderer.send('monitoring:setSource', data);
    });

    ipcRenderer.on('midi-reset-params', (e, data) => {
        ipcRenderer.send('midi-reset-params', data);
    });

    ipcRenderer.on('tracker-reset-params', (e, data) => {
        ipcRenderer.send('tracker-reset-params', data);
    });

    ipcRenderer.on('open-soundfonts-folder', (e, data) => {
        ipcRenderer.send('open-soundfonts-folder', data);
    });

    ipcRenderer.on('get-available-soundfonts', (e, data) => {
        ipcRenderer.send('get-available-soundfonts', data);
    });

    // Stage keydown from child windows - forward to app.js for global handling
    ipcRenderer.on('stage-keydown', (e, data) => {
        // Handle locally first for player-specific shortcuts
        if (data.keyCode === 80) { // P - toggle parameters
            openWindow('parameters');
        }
    });

    // Forward monitoring data from engine to monitoring window
    ipcRenderer.on('file-change', (e, data) => {
        if (g.windows.monitoring) {
            tools.sendToId(g.windows.monitoring, 'file-change', data);
        }
    });

    ipcRenderer.on('waveform-data', (e, data) => {
        if (g.windows.monitoring) {
            tools.sendToId(g.windows.monitoring, 'waveform-data', data);
        }
    });

    ipcRenderer.on('waveform-chunk', (e, data) => {
        if (g.windows.monitoring) {
            tools.sendToId(g.windows.monitoring, 'waveform-chunk', data);
        }
    });

    ipcRenderer.on('clear-waveform', (e, data) => {
        if (g.windows.monitoring) {
            tools.sendToId(g.windows.monitoring, 'clear-waveform', data);
        }
    });

    ipcRenderer.on('ana-data', (e, data) => {
        if (g.windows.monitoring) {
            tools.sendToId(g.windows.monitoring, 'ana-data', data);
        }
    });

    ipcRenderer.on('theme-changed', (e, data) => {
        if (data.dark) {
            document.body.classList.add('dark');
        } else {
            document.body.classList.remove('dark');
        }
        if (!g.config.ui) g.config.ui = {};
        g.config.ui.theme = data.dark ? 'dark' : 'light';
        g.config_obj.set(g.config);
    });

    ipcRenderer.on('shortcut', (e, data) => {
        if (data.action === 'toggle-help') {
            openWindow('help');
        } else if (data.action === 'toggle-settings') {
            openWindow('settings');
        } else if (data.action === 'toggle-mixer') {
            const fp = g.state.file;
            if (g.state.isPlaying) {
                ipcRenderer.send('audio:pause');
            }
            openWindow('mixer', false, fp);
        } else if (data.action === 'toggle-pitchtime') {
            openWindow('parameters');
        } else if (data.action === 'toggle-monitoring') {
            openWindow('monitoring');
        } else if (data.action === 'toggle-theme') {
            tools.sendToMain('command', { command: 'toggle-theme' });
        }
    });

    ipcRenderer.on('stage-keydown', (e, data) => {
        if (!data) return;
        const ev = {
            keyCode: data.keyCode | 0,
            ctrlKey: !!data.ctrlKey,
            shiftKey: !!data.shiftKey,
            altKey: !!data.altKey,
            metaKey: !!data.metaKey,
            code: data.code || '',
            key: data.key || '',
            preventDefault: () => { },
            stopPropagation: () => { }
        };
        onKey(ev);
    });

    // Expose debug commands to console
    window.debugEngine = {
        close: function () {
            console.log('[Debug] Closing engine window...');
            ipcRenderer.send('debug:close-engine');
            console.log('[Debug] Engine window closed. Check Task Manager for CPU drop.');
        },
        open: function () {
            console.log('[Debug] Reopening engine window...');
            ipcRenderer.send('debug:open-engine');
            console.log('[Debug] Engine window should reopen shortly.');
        },
        status: function () {
            ipcRenderer.send('debug:idle-status');
        }
    };

    // Idle disposal debug commands
    window.debugIdle = {
        status: function () {
            ipcRenderer.send('debug:idle-status');
            console.log('[Debug] Idle status requested. Check response in console.');
        },
        forceDispose: function () {
            console.log('[Debug] Forcing engine disposal...');
            ipcRenderer.send('debug:idle-force-dispose');
        },
        resetTimer: function () {
            ipcRenderer.on('debug:idle-reset-timer');
        }
    };

    // Listen for window close events (to update UI toggle buttons)
    ipcRenderer.on('debug:idle-status-response', (e, status) => {
        console.log('[Debug] Idle Status:', status);
    });

    console.log('[Player] Debug commands: debugEngine.close(), debugEngine.open(), debugIdle.status(), debugIdle.forceDispose(), disposeIPC.all()');
}

async function appStart() {
    window.addEventListener("keydown", onKey);
    window.addEventListener('focus', () => {
        // Send intent to main - main owns monitoring source state
        ipcRenderer.send('monitoring:setSource', { source: 'main' });
    });
    window.addEventListener('wheel', onWheelVolume, { passive: false });
    g.scale = window.devicePixelRatio || 1;
    g.body = document.body;
    g.frame = ut.el('.frame');
    g.top = ut.el('.top');
    g.top_num = g.top.el('.num');
    g.top_close = g.top.el('.close');

    g.time_controls = ut.el('.time_controls');
    g.playhead = ut.el('.playhead');
    g.prog = ut.el('.playhead .prog');
    g.cover = ut.el('.info .cover');
    g.type_band = g.cover.el('.filetype .type');
    g.playtime = ut.el('.playtime .time');
    g.playvolume = ut.el('.playtime .volume span');
    g.playremain = ut.el('.playtime .remain');
    g.top_btn_loop = ut.el('.top .content .loop');
    g.top_btn_shuffle = ut.el('.top .content .shuffle');
    g.top_btn_playpause = ut.el('.top .content .playpause');

    g.ctrl_btn_prev = ut.el('.controls .button.prev');
    g.ctrl_btn_next = ut.el('.controls .button.next');
    g.ctrl_btn_shuffle = ut.el('.controls .button.shuffle');
    g.ctrl_btn_play = ut.el('.controls .button.play');
    g.ctrl_btn_loop = ut.el('.controls .button.loop');
    g.ctrl_btn_settings = ut.el('.controls .button.settings');
    g.ctrl_btn_parameters = ut.el('.controls .button.parameters');
    g.ctrl_volume = ut.el('.controls .volume');
    g.ctrl_volume_bar = g.ctrl_volume ? g.ctrl_volume.el('.volume-bar') : null;
    g.ctrl_volume_bar_inner = g.ctrl_volume ? g.ctrl_volume.el('.volume-bar-inner') : null;

    g.text = ut.el('.info .text');
    g.text.innerHTML = '';

    // Request initial state from app.js
    ipcRenderer.send('audio:requestState');

    // Check for command line args
    let arg = g.start_vars[g.start_vars.length - 1];
    if (arg != '.' && g.start_vars.length > 1 && arg != '--squirrel-firstrun') {
        await playListFromSingle(arg);
        if (g.state.playlist.length > 0) {
            sendPlaylistToApp();
            ipcRenderer.send('audio:load', { file: g.state.playlist[g.state.playlistIndex], position: 0, paused: false });
            ipcRenderer.send('cmdline-open', { count: 1, initial: true });
        }
    } else {
        const dir = (g.config && g.config.ui && g.config.ui.defaultDir) ? g.config.ui.defaultDir : '';
        if (dir) {
            await playListFromSingle(dir);
            if (g.state.playlist.length > 0) {
                sendPlaylistToApp();
                ipcRenderer.send('audio:load', { file: g.state.playlist[g.state.playlistIndex], position: 0, paused: false });
            }
        }
    }

    // Event listeners
    g.top_close.addEventListener('click', () => {
        const cfg = g.config_obj ? g.config_obj.get() : g.config;
        const keep = cfg && cfg.ui && cfg.ui.keepRunningInTray;
        if (keep) {
            if (g.state.isPlaying) ipcRenderer.send('audio:pause');
            g.win.hide();
        } else {
            g.win.close();
        }
    });

    g.top_btn_loop.addEventListener('click', toggleLoop);
    g.top_btn_shuffle.addEventListener('click', shufflePlaylist);
    g.top_btn_playpause.addEventListener('click', playPause);

    g.ctrl_btn_prev.addEventListener('click', playPrev);
    g.ctrl_btn_next.addEventListener('click', playNext);
    g.ctrl_btn_shuffle.addEventListener('click', shufflePlaylist);
    g.ctrl_btn_play.addEventListener('click', playPause);
    g.ctrl_btn_loop.addEventListener('click', toggleLoop);
    g.ctrl_btn_settings.addEventListener('click', () => openWindow('settings'));
    g.ctrl_btn_parameters.addEventListener('click', () => openWindow('parameters'));

    if (ut.dragSlider && g.ctrl_volume && g.ctrl_volume_bar) {
        g.ctrl_volume_slider = ut.dragSlider(g.ctrl_volume, volumeSlider, -1, g.ctrl_volume_bar);
    }
    if (ut.dragSlider && g.time_controls && g.playhead) {
        g.timeline_slider = ut.dragSlider(g.time_controls, timelineSlider, -1, g.playhead);
    }

}

// ═══════════════════════════════════════════════════════════════════════════
// UI UPDATES
// ═══════════════════════════════════════════════════════════════════════════

function updateUI() {
    // Update play/pause state
    checkState();

    // Update metadata display if file changed
    if (g.state.file && g.state.metadata) {
        renderInfo(g.state.file, g.state.metadata);
    }

    // Update duration display (even without metadata)
    if (g.state.duration && g.playremain) {
        g.playremain.innerText = ut.playTime((g.state.duration || 0) * 1000).minsec;
    }

    // Update playlist counter
    renderTopInfo();

    // Update volume
    updateVolumeUI();
}

function updatePositionUI() {
    if (!g.state.duration) return;

    const proz = g.state.position / g.state.duration;
    g.prog.style.width = (proz * 100) + '%';

    const minsec = ut.playTime(g.state.position * 1000).minsec;
    g.playtime.innerText = minsec;

    // Update remaining time (duration may arrive before metadata)
    if (g.playremain) {
        g.playremain.innerText = ut.playTime((g.state.duration || 0) * 1000).minsec;
    }
}

function updateVolumeUI() {
    const vol = g.state.volume;
    if (g.playvolume) g.playvolume.innerText = (Math.round(vol * 100)) + '%';
    if (g.ctrl_volume_bar_inner) g.ctrl_volume_bar_inner.style.width = (vol * 100) + '%';
}

function checkState() {
    if (g.state.loop) {
        g.body.addClass('loop');
    } else {
        g.body.removeClass('loop');
    }

    if (!g.state.isPlaying) {
        g.body.addClass('pause');
    } else {
        g.body.removeClass('pause');
    }
}

// Debug: Update idle time display in title bar
function updateIdleDebugDisplay(data) {
    // Try to find dedicated element first
    let el = document.querySelector('.idle-debug');

    // Fallback: append to num element
    if (!el) {
        const numEl = document.querySelector('.top .content .num');
        if (!numEl) return;

        // Create or find idle span inside num
        el = numEl.querySelector('.idle-text');
        if (!el) {
            el = document.createElement('span');
            el.className = 'idle-text';
            el.style.cssText = 'margin-left: 0.5rem; opacity: 0.6; font-size: 0.75em;';
            numEl.appendChild(el);
        }
    }

    // Always show countdown - reset by play state or user activity
    // Format: just the number (seconds until disposal)
    el.innerText = `${data.remaining || 0}`;
}

function renderInfo(fp, metadata) {
    if (!fp) return;

    let parse = path.parse(fp);
    let parent = path.basename(parse.dir);
    g.playremain.innerText = ut.playTime((g.state.duration || 0) * 1000).minsec;
    ut.killKids(g.text);
    g.text.appendChild(renderInfoItem('Folder:', parent));
    g.text.appendChild(renderInfoItem('File:', parse.base));
    g.text.appendChild(ut.htmlObject(`<div class="space"></div>`));
    let ext_string = parse.ext.substring(1).toLowerCase();
    g.type_band.className = 'type ' + ext_string;
    g.type_band.innerText = ext_string;

    // Clear previous covers
    let prevCovers = g.cover.els('img');
    for (let i = 0; i < prevCovers.length; i++) {
        let el = prevCovers[i];
        el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: 200, fill: 'forwards' })
            .onfinish = () => ut.killMe(el);
    }
    renderTopInfo();

    if (metadata) {
        if (metadata.tracker) {
            // Tracker file
            g.text.appendChild(renderInfoItem('Format:', metadata.tracker));
            g.text.appendChild(ut.htmlObject(`<div class="space"></div>`));
            if (metadata.artist) g.text.appendChild(renderInfoItem('Artist:', metadata.artist));
            if (metadata.title) g.text.appendChild(renderInfoItem('Title:', metadata.title));
            if (metadata.date) g.text.appendChild(renderInfoItem('Date:', metadata.date));
        } else if (metadata.type === 'midi') {
            // MIDI file
            g.text.appendChild(renderInfoItem('Format:', 'MIDI'));

            let infoParts = [];
            if (metadata.originalBPM) infoParts.push(`${metadata.originalBPM} BPM`);
            if (metadata.timeSignature) infoParts.push(`Time: ${metadata.timeSignature}`);
            if (metadata.ppq) infoParts.push(`${metadata.ppq} PPQ`);
            if (metadata.channels) infoParts.push(`${metadata.channels} Ch`);

            const infoLine = infoParts.join(' / ');
            if (infoLine) g.text.appendChild(renderInfoItem(' ', infoLine));

            g.text.appendChild(ut.htmlObject(`<div class="space"></div>`));
            if (metadata.title) g.text.appendChild(renderInfoItem('Title:', metadata.title));
            if (metadata.copyright) g.text.appendChild(renderInfoItem('Copyright:', metadata.copyright));
            if (metadata.keySignature) g.text.appendChild(renderInfoItem('Key:', metadata.keySignature));
        } else if (metadata.codec || metadata.format) {
            // Regular audio file
            g.text.appendChild(renderInfoItem('Format:', metadata.codecLongName || metadata.formatLongName || metadata.codec || metadata.format || 'Unknown'));

            let bitrateStr = metadata.bitrate ? Math.round(metadata.bitrate / 1000) + ' kbps' : '';
            let channelStr = metadata.channels == 2 ? 'stereo' : (metadata.channels == 1 ? 'mono' : (metadata.channels ? metadata.channels + ' ch' : ''));
            let sampleStr = metadata.sampleRate ? metadata.sampleRate + ' Hz' : '';
            if (metadata.bitsPerSample && sampleStr) sampleStr += ' @ ' + metadata.bitsPerSample + ' Bit';
            let infoLine = [bitrateStr, channelStr, sampleStr].filter(s => s).join(' / ');
            if (infoLine) g.text.appendChild(renderInfoItem(' ', infoLine));

            g.text.appendChild(ut.htmlObject(`<div class="space"></div>`));
            if (metadata.artist) g.text.appendChild(renderInfoItem('Artist:', metadata.artist));
            if (metadata.album) g.text.appendChild(renderInfoItem('Album:', metadata.album));
            if (metadata.title) g.text.appendChild(renderInfoItem('Title:', metadata.title));

            // Load cover art only for regular audio files
            loadCoverArt(metadata);
        }
    }
}

async function loadCoverArt(metadata) {
    // Only use cover art from metadata (FFmpeg extracted)
    if (!metadata || !metadata.coverArt || metadata.coverArt.length === 0) {
        return;
    }

    const cover = await getCoverArtFromMetadata(metadata);
    if (cover) {
        g.cover.appendChild(cover);
        cover.style.opacity = '0';
        cover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
    }
}

function getCoverArtFromMetadata(meta) {
    return new Promise((resolve, reject) => {
        if (meta && meta.coverArt && meta.coverArt.length > 0) {
            let img = new Image();
            let mime = meta.coverArtMimeType || 'image/jpeg';
            // coverArt arrives as Uint8Array after IPC (not Buffer), so we need manual base64 conversion
            let base64 = arrayBufferToBase64(meta.coverArt);
            img.src = 'data:' + mime + ';base64,' + base64;
            img.addEventListener('load', () => { resolve(img); }, { once: true });
            img.addEventListener('error', () => { resolve(null); }, { once: true });
        } else {
            resolve(null);
        }
    });
}

// Convert Uint8Array/Buffer to base64 string - works after IPC serialization
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Use tools.loadImage from helper instead - handles local/network paths via getFileURL
function renderInfoItem(label, text) {
    let el = ut.htmlObject(`
    <div class="item">
        <div class="label">${label}</div>
        <div class="content">${text}</div>
    </div>`);
    return el;
}

function renderTopInfo() {
    const idx = g.state.playlistIndex;
    const max = g.state.playlist.length;
    g.top_num.innerText = max > 0 ? (idx + 1) + ' of ' + max : '0 of 0';
}

// ═══════════════════════════════════════════════════════════════════════════
// USER INPUT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function playPause() {
    if (!g.state.file && g.state.playlist.length > 0) {
        // No file loaded but we have a playlist - load first file
        ipcRenderer.send('audio:load', { file: g.state.playlist[g.state.playlistIndex], position: 0, paused: false });
        return;
    }

    if (g.state.isPlaying) {
        ipcRenderer.send('audio:pause');
    } else {
        ipcRenderer.send('audio:play');
    }
}

function playNext(e, autoAdvance = false) {
    // Just tell main to go to next track - main is the source of truth
    ipcRenderer.send('audio:next');
}

function playPrev(e) {
    // Just tell main to go to previous track - main is the source of truth
    ipcRenderer.send('audio:prev');
}

function toggleLoop() {
    // Just tell main to toggle loop - main is source of truth
    // Main will broadcast new state back to us
    ipcRenderer.send('audio:setParams', { loop: !g.state.loop });
}

function shufflePlaylist() {
    // Just tell main to shuffle - main is source of truth
    ipcRenderer.send('audio:shuffle');
}

function seekTo(s) {
    // Optimistic UI update - update immediately for responsiveness
    // Engine will correct if there's any discrepancy when it restores
    g.state.position = s;
    updatePositionUI();

    ipcRenderer.send('audio:seek', { position: s });
}

function seekFore() {
    if (g.state.position + 10 < g.state.duration) {
        seekTo(g.state.position + 10);
    }
}

function seekBack() {
    if (g.state.position - 10 > 0) {
        seekTo(g.state.position - 10);
    } else {
        seekTo(0);
    }
}

function timelineSlider(e) {
    if (!g.state.duration) return;

    if (e.type === 'start') {
        // User started dragging - tell engine to use faster position updates
        ipcRenderer.send('engine:set-position-mode', { mode: 'scrubbing' });
    } else if (e.type === 'end') {
        // User finished dragging - back to normal update rate
        ipcRenderer.send('engine:set-position-mode', { mode: 'normal' });
        return;
    }

    const s = g.state.duration * e.prozX;
    seekTo(s);
}

function volumeSlider(e) {
    if (e.type == 'start' || e.type == 'move') {
        setVolume(e.prozX, false);
    } else if (e.type == 'end') {
        setVolume(e.prozX, true);
    }
}

function setVolume(v, persist = false) {
    v = _clamp01(v);
    g.state.volume = v;
    if (!g.config.audio) g.config.audio = {};
    g.config.audio.volume = v;
    updateVolumeUI();

    ipcRenderer.send('audio:setParams', { volume: v });

    if (persist && g.config_obj) {
        g.config_obj.set(g.config);
    }
}

function _clamp01(v) {
    v = +v;
    if (!(v >= 0)) return 0;
    if (v > 1) return 1;
    return v;
}

function volumeUp() {
    const v = g.state.volume + 0.05;
    setVolume(v, true);
}

function volumeDown() {
    const v = g.state.volume - 0.05;
    setVolume(v, true);
}

function onWheelVolume(e) {
    if (e.ctrlKey || e.metaKey) return;
    if (!e) return;
    const dy = +e.deltaY;
    if (!isFinite(dy) || dy === 0) return;
    if (!g.wheel_vol) g.wheel_vol = { acc: 0, t: 0 };
    const now = performance.now();
    if (now - g.wheel_vol.t > 250) { g.wheel_vol.acc = 0; }
    g.wheel_vol.t = now;
    g.wheel_vol.acc += dy;

    const step = 80;
    while (g.wheel_vol.acc <= -step) {
        g.wheel_vol.acc += step;
        volumeUp();
    }
    while (g.wheel_vol.acc >= step) {
        g.wheel_vol.acc -= step;
        volumeDown();
    }

    e.preventDefault();
}

function flashButton(btn) {
    if (!btn) return;
    btn.classList.add('flash');
    setTimeout(() => { btn.classList.remove('flash'); }, 50);
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAYLIST MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

function playListFromSingle(fp, rec = true) {
    return new Promise(async (resolve, reject) => {
        let pl = [];
        let idx = 0;
        try {
            let stat = await fs.lstat(path.normalize(fp));
            if (stat.isDirectory()) {
                if (rec) {
                    pl = await tools.getFilesRecursive(fp, g.supportedFilter);
                } else {
                    pl = await tools.getFiles(fp, g.supportedFilter);
                }
            } else {
                if (tools.checkFileType(fp, g.supportedFilter)) {
                    let info = path.parse(fp);
                    pl = await tools.getFiles(info.dir, g.supportedFilter);
                    idx = pl.findIndex(item => item == path.join(info.dir, info.base));
                    if (idx == -1) { idx = 0 };
                }
            }
            // Store temporarily - will be sent to main which broadcasts back
            if (pl.length > 0) {
                g.state.playlist = pl;
                g.state.playlistIndex = idx;
            }
        } catch (err) {
            console.error('Error loading playlist:', err);
        }
        resolve();
    });
}

function playListFromMulti(ar, add = false, rec = false) {
    return new Promise(async (resolve, reject) => {
        let pl = [];
        for (let i = 0; i < ar.length; i++) {
            let fp = ar[i];
            try {
                let stat = await fs.lstat(path.normalize(fp));
                if (stat.isDirectory()) {
                    let folder_files = [];
                    if (rec) {
                        folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
                    } else {
                        folder_files = await tools.getFiles(fp, g.supportedFilter);
                    }
                    pl = pl.concat(folder_files);
                } else {
                    if (tools.checkFileType(fp, g.supportedFilter)) {
                        pl.push(fp);
                    }
                }
            } catch (err) {
                console.error('Error processing file:', fp, err);
            }
        }
        // Store temporarily - will be sent to main which broadcasts back
        if (pl.length > 0) {
            if (add && g.state.playlist.length > 0) {
                g.state.playlist = g.state.playlist.concat(pl);
            } else {
                g.state.playlistIndex = 0;
                g.state.playlist = pl;
            }
        }
        resolve(pl);
    });
}

function sendPlaylistToApp() {
    ipcRenderer.send('audio:setPlaylist', {
        playlist: g.state.playlist,
        index: g.state.playlistIndex
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAG & DROP
// ═══════════════════════════════════════════════════════════════════════════

function setupDragDrop() {
    g.dropZone = window.nui_app.dropZone(
        [
            { name: 'drop_add', label: 'Add to Playlist' },
            { name: 'drop_replace', label: 'Replace Playlist' },
            { name: 'drop_mixer', label: 'Multitrack<br>Preview' }
        ],
        dropHandler,
        document.body
    );

    async function dropHandler(e) {
        e.preventDefault();
        if (e.target.id == 'drop_add') {
            let files = fileListArray(e.dataTransfer.files);
            const wasEmpty = g.state.playlist.length === 0;
            await playListFromMulti(files, true, !e.ctrlKey);
            sendPlaylistToApp();
            ipcRenderer.send('drag-drop', { action: 'add', count: files.length });
            if (wasEmpty && g.state.playlist[g.state.playlistIndex]) {
                ipcRenderer.send('audio:load', { file: g.state.playlist[g.state.playlistIndex], position: 0, paused: false });
            }
            g.win.focus();
        }
        if (e.target.id == 'drop_replace') {
            let files = fileListArray(e.dataTransfer.files);
            await playListFromMulti(files, false, !e.ctrlKey);
            sendPlaylistToApp();
            ipcRenderer.send('drag-drop', { action: 'replace', count: files.length });
            if (g.state.playlist[g.state.playlistIndex]) {
                ipcRenderer.send('audio:load', { file: g.state.playlist[g.state.playlistIndex], position: 0, paused: false });
            }
            g.win.focus();
        }
        if (e.target.id == 'drop_mixer') {
            let files = fileListArray(e.dataTransfer.files);
            let pl = [];
            for (let i = 0; i < files.length; i++) {
                let fp = files[i];
                try {
                    let stat = await fs.lstat(path.normalize(fp));
                    if (stat.isDirectory()) {
                        let folder_files = [];
                        if (!e.ctrlKey) {
                            folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
                        } else {
                            folder_files = await tools.getFiles(fp, g.supportedFilter);
                        }
                        pl = pl.concat(folder_files);
                    } else {
                        if (tools.checkFileType(fp, g.supportedFilter)) {
                            pl.push(fp);
                        }
                    }
                } catch (err) {
                    console.error('Error processing mixer file:', fp);
                }
            }

            if (g.state.isPlaying) {
                ipcRenderer.send('audio:pause');
                checkState();
            }
            openWindow('mixer', true, pl);
            return;
        }
        renderTopInfo();
    }

    function fileListArray(fl) {
        let out = [];
        for (let i = 0; i < fl.length; i++) {
            out.push(webUtils.getPathForFile(fl[i]));
        }
        return out;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// WINDOW MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

function setupWindow() {
    g.win.hook_event('blur', handler);
    g.win.hook_event('focus', handler);
    g.win.hook_event('move', handler);
    g.win.hook_event('resized', handler);
    g.win.hook_event('resize', handler);

    function handler(e, data) {
        if (data.type == 'blur') {
            g.frame.classList.remove('focus');
        }
        if (data.type == 'focus') {
            g.frame.classList.add('focus');
        }
        if (data.type == 'move' || data.type == 'resized' || data.type == 'resize') {
            clearTimeout(g.window_move_timeout);
            g.window_move_timeout = setTimeout(async () => {
                let bounds = await g.win.getBounds();
                if (!g.config.windows) g.config.windows = {};
                if (!g.config.windows.main) g.config.windows.main = {};
                const scale = (g.config.windows.main.scale !== undefined) ? (g.config.windows.main.scale | 0) : 14;
                g.config.windows.main = {
                    ...g.config.windows.main,
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                    scale: scale
                };
                g.config_obj.set(g.config);
            }, 500);
        }
    }
}

async function openWindow(type, forceShow = false, contextFile = null) {
    // Block state-debug window in packaged builds (defense in depth)
    if (type === 'state-debug' && g.isPackaged) {
        console.log('[openWindow] state-debug window blocked in packaged build');
        return;
    }
    console.log('[openWindow] type:', type, 'forceShow:', forceShow, 'windowId:', g.windows[type]);

    async function waitForWindowClosed(t, id, timeoutMs = 2000) {
        return await new Promise((resolve) => {
            let done = false;
            const to = setTimeout(() => {
                if (done) return;
                done = true;
                ipcRenderer.removeListener('window-closed', onClosed);
                resolve(false);
            }, timeoutMs | 0);
            function onClosed(e, data) {
                if (done) return;
                if (!data || data.type !== t || data.windowId !== id) return;
                done = true;
                clearTimeout(to);
                ipcRenderer.removeListener('window-closed', onClosed);
                resolve(true);
            }
            ipcRenderer.on('window-closed', onClosed);
        });
    }

    if (g.windows[type] && g.windowsClosing[type]) {
        await waitForWindowClosed(type, g.windows[type], 2000);
    }

    // If window exists, let main process handle toggle (show/hide)
    // Main process has ground truth visibility state
    if (g.windows[type] && !forceShow) {
        // Send toggle intent to main process
        ipcRenderer.send('window:toggle', { type });
        return;
    }

    // For forceShow or new windows, handle specially
    if (g.windows[type] && forceShow) {
        // Window exists, just show it and update context if needed
        if (type === 'mixer') {
            if (g.state.isPlaying) {
                ipcRenderer.send('audio:pause');
                checkState();
            }
            const playlist = await getMixerPlaylist(contextFile);
            tools.sendToId(g.windows[type], 'mixer-playlist', {
                paths: playlist.paths.slice(0, 20),
                idx: playlist.idx
            });
        }
        tools.sendToId(g.windows[type], 'show-window');
        ipcRenderer.send('window-visible', { type, windowId: g.windows[type] });
        return;
    }

    let stageBounds = await g.win.getBounds();
    let displays = await helper.screen.getAllDisplays();
    let targetDisplay = displays.find(d =>
        stageBounds.x >= d.bounds.x &&
        stageBounds.x < d.bounds.x + d.bounds.width &&
        stageBounds.y >= d.bounds.y &&
        stageBounds.y < d.bounds.y + d.bounds.height
    ) || displays[0];

    const configDefaults = require('./config-defaults.js');
    const defaultWinSettings = (configDefaults && configDefaults.windows && configDefaults.windows[type]) || {};
    const userWinSettings = (g.config.windows && g.config.windows[type]) || {};
    const winSettings = { ...defaultWinSettings, ...userWinSettings };

    let windowWidth = winSettings.width || 960;
    let windowHeight = winSettings.height || 800;

    let x = targetDisplay.workArea.x + Math.round((targetDisplay.workArea.width - windowWidth) / 2);
    let y = targetDisplay.workArea.y + Math.round((targetDisplay.workArea.height - windowHeight) / 2);

    if (winSettings.x !== null && winSettings.x !== undefined) x = winSettings.x;
    if (winSettings.y !== null && winSettings.y !== undefined) y = winSettings.y;

    const init_data = {
        type: type,
        stageId: await g.win.getId(),
        configName: g.configName,
        config: g.config,
        currentFile: g.state.file,
        currentTime: g.state.position,
        maxSampleRate: g.state.maxSampleRate,
        currentSampleRate: g.state.currentSampleRate,
        fileType: g.state.fileType
    };

    if (type === 'mixer') {
        if (g.state.isPlaying) {
            ipcRenderer.send('audio:pause');
            checkState();
        }
        const playlist = await getMixerPlaylist(contextFile);
        init_data.playlist = {
            paths: playlist.paths.slice(0, 20),
            idx: playlist.idx
        };
        
        // Add FFmpeg paths for streaming support (fixes "Mixer - FFmpeg streaming" issue)
        const os = require('os');
        // FIX: Use g.app_path (set at line 151) instead of undefined helper.app_path
        let appPath = g.app_path || '';
        const originalAppPath = appPath;
        if (g.isPackaged) { appPath = path.dirname(appPath); }
        
        const isLinux = os.platform() === 'linux';
        const binDir = isLinux ? 'linux_bin' : 'win_bin';
        init_data.ffmpeg_napi_path = path.resolve(appPath, 'bin', binDir, 'ffmpeg_napi.node');
        init_data.ffmpeg_player_path = path.resolve(appPath, 'bin', binDir, 'player-sab.js');
        init_data.ffmpeg_worklet_path = path.resolve(appPath, 'bin', binDir, 'ffmpeg-worklet-sab.js');
        
        // Debug logging for path verification
        console.log('[Mixer] FFmpeg paths constructed:', {
            isPackaged: g.isPackaged,
            originalAppPath,
            resolvedAppPath: appPath,
            binDir,
            ffmpeg_napi: init_data.ffmpeg_napi_path
        });
    }

    if (type === 'monitoring') {
        init_data.filePath = g.state.file ? path.basename(g.state.file) : '';
    }

    g.windows[type] = await tools.browserWindow('frameless', {
        file: `./html/${type}.html`,
        show: false,
        width: windowWidth,
        height: windowHeight,
        x: x,
        y: y,
        backgroundColor: '#323232',
        hasShadow: true,
        init_data: init_data
    });

    // Notify app.js/engine.js that window was created
    ipcRenderer.send('window-created', { type: type, windowId: g.windows[type] });

    // Wait for window-ready signal before showing
    const windowId = g.windows[type];
    const onReady = (e, data) => {
        // Use loose equality for windowId (could be number or string)
        if (data && data.type === type && data.windowId == windowId) {
            ipcRenderer.removeListener('window-ready', onReady);
            clearTimeout(fallbackTimeout);
            tools.sendToId(windowId, 'show-window');
            // Notify main process that window is now visible
            ipcRenderer.send('window-visible', { type: type, windowId: windowId });
        }
    };
    ipcRenderer.on('window-ready', onReady);

    // Fallback: show after timeout even if ready signal not received
    const fallbackTimeout = setTimeout(() => {
        ipcRenderer.removeListener('window-ready', onReady);
        tools.sendToId(windowId, 'show-window');
        // Notify main process that window is now visible
        ipcRenderer.send('window-visible', { type: type, windowId: windowId });
    }, 500);
}

async function getMixerPlaylist(contextFile = null) {
    if (Array.isArray(contextFile)) {
        return { paths: contextFile, idx: 0 };
    }
    let fp = contextFile;
    if (!fp && g.state.file) {
        fp = g.state.file;
    }

    if (fp) {
        try {
            const dir = path.dirname(fp);
            const files = await tools.getFiles(dir, g.supportedFilter);
            const currentPath = path.normalize(fp);
            let idx = files.findIndex(f => path.normalize(f) === currentPath);
            if (idx === -1) idx = 0;
            return { paths: files, idx: idx };
        } catch (e) {
            console.error('Error getting siblings for mixer:', e);
        }
    }
    const list = Array.isArray(g.state.playlist) ? g.state.playlist : [];
    return { paths: list, idx: g.state.playlistIndex | 0 };
}

function toggleControls() {
    if (!g.config.ui) g.config.ui = {};
    const current = !!g.config.ui.showControls;
    const next = !current;
    g.config.ui.showControls = next;
    g.config_obj.set(g.config);
    applyShowControls(next, true);
}

function _getMainScale() {
    let s = 14;
    if (g.config && g.config.windows && g.config.windows.main && g.config.windows.main.scale !== undefined) {
        s = g.config.windows.main.scale | 0;
    }
    if (s < 14) s = 14;
    return s;
}

function _scaledDim(base, scale) {
    const v = Math.round((base / 14) * scale);
    return (v > base) ? v : base;
}

function applyShowControls(show, resetSize = false) {
    const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
    const minH = show ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
    const scale = _getMainScale();
    const scaledMinW = _scaledDim(MIN_WIDTH, scale);
    const scaledMinH = _scaledDim(minH, scale);
    if (show) {
        document.body.classList.add('show-controls');
    } else {
        document.body.classList.remove('show-controls');
    }
    tools.sendToMain('command', { command: 'set-min-height', minHeight: scaledMinH, minWidth: scaledMinW });
    if (resetSize) {
        g.win.setBounds({ width: scaledMinW, height: scaledMinH });
    }
}

async function scaleWindow(val) {
    const { MIN_WIDTH, MIN_HEIGHT_WITH_CONTROLS, MIN_HEIGHT_WITHOUT_CONTROLS } = require('./config-defaults.js').WINDOW_DIMENSIONS;
    const showControls = (g.config && g.config.ui && g.config.ui.showControls) ? true : false;
    const MIN_H = showControls ? MIN_HEIGHT_WITH_CONTROLS : MIN_HEIGHT_WITHOUT_CONTROLS;
    let w_scale = MIN_WIDTH / 14;
    let h_scale = MIN_H / 14;
    if (!g.config.windows) g.config.windows = {};
    if (!g.config.windows.main) g.config.windows.main = {};
    let curBounds = await g.win.getBounds();
    if (!curBounds) curBounds = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_H };
    let nb = {
        x: curBounds.x,
        y: curBounds.y,
        width: parseInt(w_scale * val),
        height: parseInt(h_scale * val)
    };
    if (nb.width < MIN_WIDTH) { nb.width = MIN_WIDTH; val = 14 };
    if (nb.height < MIN_H) { nb.height = MIN_H; val = 14 };
    await g.win.setBounds(nb);
    g.config.windows.main = { ...g.config.windows.main, x: nb.x, y: nb.y, width: nb.width, height: nb.height, scale: val | 0 };
    ut.setCssVar('--space-base', val);
    g.config_obj.set(g.config);
    const scaledMinW = _scaledDim(MIN_WIDTH, val | 0);
    const scaledMinH = _scaledDim(MIN_H, val | 0);
    tools.sendToMain('command', { command: 'set-min-height', minHeight: scaledMinH, minWidth: scaledMinW });
}

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARD HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function onKey(e) {
    let shortcutAction = null;
    if (shortcuts && shortcuts.handleShortcut) {
        shortcutAction = shortcuts.handleShortcut(e, 'stage');
    } else if (window.shortcuts && window.shortcuts.handleShortcut) {
        shortcutAction = window.shortcuts.handleShortcut(e, 'stage');
    }

    if (shortcutAction === 'toggle-parameters') {
        openWindow('parameters');
        flashButton(g.ctrl_btn_parameters);
    } else if (shortcutAction === 'toggle-settings') {
        openWindow('settings');
        flashButton(g.ctrl_btn_settings);
    } else if (shortcutAction === 'toggle-help') {
        openWindow('help');
    } else if (shortcutAction === 'toggle-theme') {
        tools.sendToMain('command', { command: 'toggle-theme' });
    } else if (shortcutAction === 'toggle-mixer') {
        const fp = g.state.file;
        openWindow('mixer', false, fp);
    } else if (shortcutAction === 'toggle-pitchtime') {
        openWindow('parameters');
    } else if (shortcutAction === 'toggle-controls') {
        toggleControls();
    } else if (shortcutAction === 'toggle-monitoring') {
        openWindow('monitoring');
    }

    // Debug: Ctrl+Shift+D to open state debugger (dev builds only)
    if (e.ctrlKey && e.shiftKey && e.keyCode === 68 && !g.isPackaged) { // D
        e.preventDefault();
        openWindow('state-debug');
    }

    if (e.keyCode == 123) {
        g.win.toggleDevTools();
    } else if (e.keyCode == 76) {
        toggleLoop();
        flashButton(g.ctrl_btn_loop);
    }

    if (e.keyCode == 27) {
        g.config_obj.set(g.config);
        const cfg = g.config_obj ? g.config_obj.get() : g.config;
        const keep = cfg && cfg.ui && cfg.ui.keepRunningInTray;
        if (keep) {
            if (g.state.isPlaying) ipcRenderer.send('audio:pause');
            g.win.hide();
        } else {
            g.win.close();
        }
    }
    if (e.keyCode == 39) {
        if (e.ctrlKey) { seekFore(); }
        else {
            let now = Date.now();
            if (now - g.lastNavTime >= 100) {
                g.lastNavTime = now;
                playNext();
                flashButton(g.ctrl_btn_next);
            }
        }
    }
    if (e.keyCode == 37) {
        if (e.ctrlKey) { seekBack(); }
        else {
            let now = Date.now();
            if (now - g.lastNavTime >= 100) {
                g.lastNavTime = now;
                playPrev();
                flashButton(g.ctrl_btn_prev);
            }
        }
    }
    if (e.keyCode == 38) {
        volumeUp();
    }
    if (e.keyCode == 40) {
        volumeDown();
    }

    if (e.keyCode == 82) {
        shufflePlaylist();
        flashButton(g.ctrl_btn_shuffle);
    }
    if (e.keyCode == 73) {
        helper.shell.showItemInFolder(g.state.playlist[g.state.playlistIndex]);
    }

    if (e.keyCode == 32) {
        playPause();
        flashButton(g.ctrl_btn_play);
    }

    // Ctrl+/- for window scaling
    if (e.keyCode == 189 || e.keyCode == 109 || e.keyCode == 173) {
        if (e.ctrlKey) {
            console.log('Scaling down');
            let val = ut.getCssVar('--space-base').value;
            scaleWindow(val - 1);
        }
    }
    if (e.keyCode == 187 || e.keyCode == 107 || e.keyCode == 61) {
        if (e.ctrlKey) {
            console.log('Scaling up');
            let val = ut.getCssVar('--space-base').value;
            scaleWindow(val + 1);
        }
    }
}

function fb(o) {
    console.log('[Player]', o);
}

module.exports.init = init;
