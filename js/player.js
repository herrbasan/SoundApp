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
    all: function() {
        console.log('[Debug] Removing ALL IPC listeners...');
        ipcRenderer.removeAllListeners('state:update');
        ipcRenderer.removeAllListeners('position');
        ipcRenderer.removeAllListeners('window-closed');
        ipcRenderer.removeAllListeners('window-hidden');
        ipcRenderer.removeAllListeners('theme-changed');
        ipcRenderer.removeAllListeners('shortcut');
        ipcRenderer.removeAllListeners('log');
        ipcRenderer.removeAllListeners('main');
        ipcRenderer.removeAllListeners('param-change');
        ipcRenderer.removeAllListeners('midi-reset-params');
        ipcRenderer.removeAllListeners('tracker-reset-params');
        ipcRenderer.removeAllListeners('tracker-vu');
        ipcRenderer.removeAllListeners('set-mode');
        ipcRenderer.removeAllListeners('file-change');
        ipcRenderer.removeAllListeners('waveform-data');
        ipcRenderer.removeAllListeners('waveform-chunk');
        ipcRenderer.removeAllListeners('clear-waveform');
        ipcRenderer.removeAllListeners('ana-data');
        console.log('[Debug] All IPC listeners removed.');
    },
    nonEssential: function() {
        console.log('[Debug] Removing non-essential IPC listeners...');
        ipcRenderer.removeAllListeners('log');
        ipcRenderer.removeAllListeners('tracker-vu');
        ipcRenderer.removeAllListeners('waveform-chunk');
        ipcRenderer.removeAllListeners('clear-waveform');
        ipcRenderer.removeAllListeners('ana-data');
        console.log('[Debug] Non-essential IPC listeners removed.');
    },
    status: function() {
        console.log('[Debug] disposeIPC is ready');
    }
};

let g = {};
g.test = {};
g.windows = { help: null, settings: null, playlist: null, mixer: null, pitchtime: null, 'midi': null, parameters: null, monitoring: null, 'state-debug': null };
g.windowsVisible = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false, parameters: false, monitoring: false, 'state-debug': false };
g.windowsClosing = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false, parameters: false, monitoring: false, 'state-debug': false };
g.lastNavTime = 0;
g.mixerPlaying = false;
g.music = [];          // Local playlist cache (synced with app.js)
g.idx = 0;
g.max = -1;
g.isLoop = false;
g.blocky = false;

// UI State (mirrors app.js audioState for UI purposes)
g.uiState = {
    file: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 0.5,
    metadata: null,
    fileType: null
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
            g.uiState.volume = g.config.audio.volume;
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
    // Receive state updates from app.js
    ipcRenderer.on('state:update', (e, data) => {
        // Update local UI state
        if (data.file !== undefined) g.uiState.file = data.file;
        if (data.isPlaying !== undefined) g.uiState.isPlaying = data.isPlaying;
        if (data.position !== undefined) g.uiState.position = data.position;
        if (data.duration !== undefined) g.uiState.duration = data.duration;
        if (data.volume !== undefined) g.uiState.volume = data.volume;
        if (data.metadata !== undefined) g.uiState.metadata = data.metadata;
        if (data.fileType !== undefined) g.uiState.fileType = data.fileType;
        if (data.loop !== undefined) g.isLoop = data.loop;
        
        // Update playlist if provided
        if (data.playlist) {
            g.music = data.playlist;
            g.max = g.music.length - 1;
        }
        if (data.playlistIndex !== undefined) {
            g.idx = data.playlistIndex;
        }
        
        // Update UI
        updateUI();
    });

    // Receive position updates (frequent, ≤15ms)
    ipcRenderer.on('position', (e, position) => {
        g.uiState.position = position;
        updatePositionUI();
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
        ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
        g.win.focus();
    });

    ipcRenderer.on('log', (e, data) => {
        console.log('%c' + data.context, 'color:#6058d6', data.data);
    });

    ipcRenderer.on('window-closed', (e, data) => {
        console.log('[window-closed] received:', data.type, 'windowId:', data.windowId, 'current g.windows:', g.windows[data.type]);
        if (g.windows[data.type] === data.windowId) {
            g.windows[data.type] = null;
            g.windowsVisible[data.type] = false;
            console.log('[window-closed] Cleared tracking for', data.type);
        }
        if (g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;
        // Forward to app.js for engine tracking
        ipcRenderer.send('window-closed', data);
        setTimeout(() => g.win.focus(), 50);
    });

    ipcRenderer.on('window-hidden', async (e, data) => {
        g.windowsVisible[data.type] = false;
        if (g.windowsClosing && g.windowsClosing[data.type] !== undefined) g.windowsClosing[data.type] = false;
        // Forward to app.js for engine tracking
        ipcRenderer.send('window-hidden', data);
        g.win.focus();
    });
    
    // Forward window-created from child windows to app.js
    ipcRenderer.on('window-created', (e, data) => {
        if (data && data.type) {
            g.windows[data.type] = data.windowId;
            g.windowsVisible[data.type] = true;
            // Forward to app.js for engine tracking
            ipcRenderer.send('window-created', data);
        }
    });
    
    // Forward param-change messages from child windows (parameters, etc.) to app.js
    ipcRenderer.on('param-change', (e, data) => {
        ipcRenderer.send('param-change', data);
    });
    
    // Forward state-debug requests to app.js
    ipcRenderer.on('state-debug:request', (e, data) => {
        ipcRenderer.send('state-debug:request', { ...data, windowId: g.windows['state-debug'] });
    });
    
    // Forward state-debug responses from app.js/engine.js back to state-debug window
    ipcRenderer.on('state-debug:main', (e, data) => {
        if (g.windows['state-debug']) {
            tools.sendToId(g.windows['state-debug'], 'state-debug:main', data);
        }
    });
    
    ipcRenderer.on('state-debug:engine', (e, data) => {
        if (g.windows['state-debug']) {
            tools.sendToId(g.windows['state-debug'], 'state-debug:engine', data);
        }
    });
    
    ipcRenderer.on('state-debug:audio', (e, data) => {
        if (g.windows['state-debug']) {
            tools.sendToId(g.windows['state-debug'], 'state-debug:audio', data);
        }
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
    
    // Forward tracker VU data from engine to parameters window
    ipcRenderer.on('tracker-vu', (e, data) => {
        if (g.windows.parameters) {
            tools.sendToId(g.windows.parameters, 'tracker-vu', data);
        }
    });
    
    // Forward set-mode from engine to parameters window (for initialization)
    ipcRenderer.on('set-mode', (e, data) => {
        if (g.windows.parameters) {
            tools.sendToId(g.windows.parameters, 'set-mode', data);
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
            const fp = g.uiState.file;
            if (g.uiState.isPlaying) {
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
        close: function() {
            console.log('[Debug] Closing engine window...');
            ipcRenderer.send('debug:close-engine');
            console.log('[Debug] Engine window closed. Check Task Manager for CPU drop.');
        },
        open: function() {
            console.log('[Debug] Reopening engine window...');
            ipcRenderer.send('debug:open-engine');
            console.log('[Debug] Engine window should reopen shortly.');
        },
        status: function() {
            ipcRenderer.send('debug:idle-status');
        }
    };
    
    // Idle disposal debug commands
    window.debugIdle = {
        status: function() {
            ipcRenderer.send('debug:idle-status');
            console.log('[Debug] Idle status requested. Check response in console.');
        },
        forceDispose: function() {
            console.log('[Debug] Forcing engine disposal...');
            ipcRenderer.send('debug:idle-force-dispose');
        },
        resetTimer: function() {
            console.log('[Debug] Resetting idle timer...');
            ipcRenderer.send('debug:idle-reset-timer');
        }
    };
    
    // Listen for idle status response
    ipcRenderer.on('debug:idle-status-response', (e, status) => {
        console.log('[Debug] Idle Status:', status);
    });
    
    console.log('[Player] Debug commands: debugEngine.close(), debugEngine.open(), debugIdle.status(), debugIdle.forceDispose(), disposeIPC.all()');
}

async function appStart() {
    window.addEventListener("keydown", onKey);
    window.addEventListener('focus', () => {
        if (g.windows.monitoring) {
            try { tools.sendToId(g.windows.monitoring, 'set-monitoring-source', 'main'); } catch (e) { }
        }
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
        if (g.music.length > 0) {
            sendPlaylistToApp();
            ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
            ipcRenderer.send('cmdline-open', { count: 1, initial: true });
        }
    } else {
        const dir = (g.config && g.config.ui && g.config.ui.defaultDir) ? g.config.ui.defaultDir : '';
        if (dir) {
            await playListFromSingle(dir);
            if (g.music.length > 0) {
                sendPlaylistToApp();
                ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
            }
        }
    }

    // Event listeners
    g.top_close.addEventListener('click', () => {
        const cfg = g.config_obj ? g.config_obj.get() : g.config;
        const keep = cfg && cfg.ui && cfg.ui.keepRunningInTray;
        if (keep) {
            if (g.uiState.isPlaying) ipcRenderer.send('audio:pause');
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
    if (g.uiState.file && g.uiState.metadata) {
        renderInfo(g.uiState.file, g.uiState.metadata);
    }
    
    // Update duration display (even without metadata)
    if (g.uiState.duration && g.playremain) {
        g.playremain.innerText = ut.playTime((g.uiState.duration || 0) * 1000).minsec;
    }
    
    // Update playlist counter
    renderTopInfo();
    
    // Update volume
    updateVolumeUI();
}

function updatePositionUI() {
    if (!g.uiState.duration) return;
    
    const proz = g.uiState.position / g.uiState.duration;
    g.prog.style.width = (proz * 100) + '%';
    
    const minsec = ut.playTime(g.uiState.position * 1000).minsec;
    g.playtime.innerText = minsec;
    
    // Update remaining time (duration may arrive before metadata)
    if (g.playremain) {
        g.playremain.innerText = ut.playTime((g.uiState.duration || 0) * 1000).minsec;
    }
}

function updateVolumeUI() {
    const vol = g.uiState.volume;
    if (g.playvolume) g.playvolume.innerText = (Math.round(vol * 100)) + '%';
    if (g.ctrl_volume_bar_inner) g.ctrl_volume_bar_inner.style.width = (vol * 100) + '%';
}

function checkState() {
    if (g.isLoop) {
        g.body.addClass('loop');
    } else {
        g.body.removeClass('loop');
    }
    
    if (!g.uiState.isPlaying) {
        g.body.addClass('pause');
    } else {
        g.body.removeClass('pause');
    }
}

function renderInfo(fp, metadata) {
    if (!fp) return;
    
    let parse = path.parse(fp);
    let parent = path.basename(parse.dir);
    g.playremain.innerText = ut.playTime((g.uiState.duration || 0) * 1000).minsec;
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
        } else if (metadata.codec || metadata.format) {
            // Regular audio file
            g.text.appendChild(renderInfoItem('Format:', metadata.codecLongName || metadata.codec || 'Unknown'));
            
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
        }
    }

    // Load cover art
    loadCoverArt(metadata, parse);
}

async function loadCoverArt(metadata, parse) {
    let cover = null;
    
    // Try ID3 cover art
    if (metadata && metadata.coverArt && metadata.coverArt.length > 0) {
        cover = await getCoverArtFromMetadata(metadata);
    }
    
    // Fallback to folder image
    if (!cover) {
        let images = await tools.getFiles(parse.dir, ['.jpg', '.jpeg', '.png', '.gif']);
        if (images.length > 0) {
            cover = await loadImage(images[images.length - 1]);
        }
    }

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
            img.src = 'data:' + mime + ';base64,' + meta.coverArt.toString('base64');
            img.addEventListener('load', () => { resolve(img); }, { once: true });
            img.addEventListener('error', () => { resolve(null); }, { once: true });
        } else {
            resolve(null);
        }
    });
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        let image = new Image();
        image.src = url;
        image.addEventListener('load', () => { resolve(image); }, { once: true });
        image.addEventListener('error', () => { resolve(null); }, { once: true });
    });
}

function renderInfoItem(label, text) {
    let el = ut.htmlObject(`
        <div class="item">
            <div class="label">${label}</div>
            <div class="content">${text}</div>
        </div>`);
    return el;
}

function renderTopInfo() {
    g.top_num.innerText = (g.idx + 1) + ' of ' + (g.max + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// USER INPUT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function playPause() {
    if (!g.uiState.file && g.music.length > 0) {
        // No file loaded but we have a playlist - load first file
        ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
        return;
    }
    
    if (g.uiState.isPlaying) {
        ipcRenderer.send('audio:pause');
    } else {
        ipcRenderer.send('audio:play');
    }
}

function playNext(e, autoAdvance = false) {
    if (g.blocky) return;
    if (g.idx >= g.max) {
        g.idx = -1;
    }
    g.idx++;
    
    if (g.music[g.idx]) {
        ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
        sendPlaylistToApp(); // Update app.js with new index
    }
}

function playPrev(e) {
    if (g.blocky) return;
    if (g.idx === 0) {
        g.idx = g.max + 1;
    }
    g.idx--;
    
    if (g.music[g.idx]) {
        ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
        sendPlaylistToApp();
    }
}

function toggleLoop() {
    g.isLoop = !g.isLoop;
    ipcRenderer.send('audio:setParams', { loop: g.isLoop });
    checkState();
}

function shufflePlaylist() {
    ut.shuffleArray(g.music);
    g.idx = 0;
    sendPlaylistToApp();
    if (g.music[g.idx]) {
        ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
    }
}

function seekTo(s) {
    // Optimistic UI update - update immediately for responsiveness
    // Engine will correct if there's any discrepancy when it restores
    g.uiState.position = s;
    updatePositionUI();
    
    ipcRenderer.send('audio:seek', { position: s });
}

function seekFore() {
    if (g.uiState.position + 10 < g.uiState.duration) {
        seekTo(g.uiState.position + 10);
    }
}

function seekBack() {
    if (g.uiState.position - 10 > 0) {
        seekTo(g.uiState.position - 10);
    } else {
        seekTo(0);
    }
}

function timelineSlider(e) {
    if (e.type === 'end') return; // Ignore end event
    if (!g.uiState.duration) return;
    
    const s = g.uiState.duration * e.prozX;
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
    g.uiState.volume = v;
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
    const v = g.uiState.volume + 0.05;
    setVolume(v, true);
}

function volumeDown() {
    const v = g.uiState.volume - 0.05;
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
            if (pl.length > 0) {
                g.music = pl;
                g.max = g.music.length - 1;
                g.idx = idx;
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
        if (pl.length > 0) {
            if (add && g.music.length > 0) {
                g.music = g.music.concat(pl);
                g.max = g.music.length - 1;
            } else {
                g.idx = 0;
                g.music = pl;
                g.max = g.music.length - 1;
            }
        }
        resolve(pl);
    });
}

function sendPlaylistToApp() {
    ipcRenderer.send('audio:setPlaylist', {
        playlist: g.music,
        index: g.idx
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
            const wasEmpty = g.music.length === 0;
            await playListFromMulti(files, true, !e.ctrlKey);
            sendPlaylistToApp();
            ipcRenderer.send('drag-drop', { action: 'add', count: files.length });
            if (wasEmpty && g.music[g.idx]) {
                ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
            }
            g.win.focus();
        }
        if (e.target.id == 'drop_replace') {
            let files = fileListArray(e.dataTransfer.files);
            await playListFromMulti(files, false, !e.ctrlKey);
            sendPlaylistToApp();
            ipcRenderer.send('drag-drop', { action: 'replace', count: files.length });
            if (g.music[g.idx]) {
                ipcRenderer.send('audio:load', { file: g.music[g.idx], position: 0, paused: false });
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

            if (g.uiState.isPlaying) {
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
    console.log('[openWindow] type:', type, 'forceShow:', forceShow, 'g.windows[type]:', g.windows[type], 'g.windowsVisible[type]:', g.windowsVisible[type]);
    
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

    if (g.windows[type]) {
        if (forceShow) {
            if (type === 'mixer') {
                if (g.uiState.isPlaying) {
                    ipcRenderer.send('audio:pause');
                    checkState();
                }
                const playlist = await getMixerPlaylist(contextFile);
                tools.sendToId(g.windows[type], 'mixer-playlist', {
                    paths: playlist.paths.slice(0, 20),
                    idx: playlist.idx
                });
                if (!g.windowsVisible[type]) {
                    tools.sendToId(g.windows[type], 'show-window');
                    g.windowsVisible[type] = true;
                } else {
                    tools.sendToId(g.windows[type], 'show-window');
                }
                return;
            } else {
                if (!g.windowsVisible[type]) {
                    tools.sendToId(g.windows[type], 'show-window');
                    g.windowsVisible[type] = true;
                } else {
                    tools.sendToId(g.windows[type], 'show-window');
                }
                return;
            }
        }

        if (g.windowsVisible[type]) {
            tools.sendToId(g.windows[type], 'hide-window');
            g.windowsVisible[type] = false;
            g.win.focus();
        } else {
            tools.sendToId(g.windows[type], 'show-window');
            g.windowsVisible[type] = true;
            if (type === 'mixer') {
                if (g.uiState.isPlaying) {
                    ipcRenderer.send('audio:pause');
                    checkState();
                }
                const playlist = await getMixerPlaylist(contextFile);
                tools.sendToId(g.windows[type], 'mixer-playlist', {
                    paths: playlist.paths.slice(0, 20),
                    idx: playlist.idx
                });
            }
        }
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
        currentFile: g.uiState.file,
        currentTime: g.uiState.position
    };

    if (type === 'mixer') {
        if (g.uiState.isPlaying) {
            ipcRenderer.send('audio:pause');
            checkState();
        }
        const playlist = await getMixerPlaylist(contextFile);
        init_data.playlist = {
            paths: playlist.paths.slice(0, 20),
            idx: playlist.idx
        };
    }

    if (type === 'monitoring') {
        init_data.filePath = g.uiState.file ? path.basename(g.uiState.file) : '';
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

    console.log('[openWindow] Created window:', type, 'id:', g.windows[type]);

    g.windowsVisible[type] = true;
    
    // Notify app.js/engine.js that window was created
    ipcRenderer.send('window-created', { type: type, windowId: g.windows[type] });

    setTimeout(() => {
        tools.sendToId(g.windows[type], 'show-window');
        
        // For parameters window, also send set-mode to initialize controls
        if (type === 'parameters') {
            const fileType = g.uiState.fileType;
            let mode = 'audio';
            let params = {};
            
            if (fileType === 'MIDI') {
                mode = 'midi';
                params = { transpose: 0, bpm: 120, metronome: false };
            } else if (fileType === 'Tracker') {
                mode = 'tracker';
                params = { pitch: 0, tempo: 1.0, stereoSeparation: 100 };
            } else {
                mode = 'audio';
                params = { audioMode: 'tape', tapeSpeed: 0, pitch: 0, tempo: 1.0, formant: false, locked: false };
            }
            
            console.log('[openWindow] Sending set-mode to parameters window:', mode);
            tools.sendToId(g.windows[type], 'set-mode', { mode, params });
        }
    }, 100);
}

async function getMixerPlaylist(contextFile = null) {
    if (Array.isArray(contextFile)) {
        return { paths: contextFile, idx: 0 };
    }
    let fp = contextFile;
    if (!fp && g.uiState.file) {
        fp = g.uiState.file;
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
    const list = Array.isArray(g.music) ? g.music : [];
    return { paths: list, idx: g.idx | 0 };
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
    } else if (shortcutAction === 'toggle-theme') {
        tools.sendToMain('command', { command: 'toggle-theme' });
    } else if (shortcutAction === 'toggle-mixer') {
        const fp = g.uiState.file;
        openWindow('mixer', false, fp);
    } else if (shortcutAction === 'toggle-pitchtime') {
        openWindow('parameters');
    } else if (shortcutAction === 'toggle-controls') {
        toggleControls();
    } else if (shortcutAction === 'toggle-monitoring') {
        openWindow('monitoring');
    }
    
    // Debug: Ctrl+Shift+D to open state debugger
    if (e.ctrlKey && e.shiftKey && e.keyCode === 68) { // D
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
            if (g.uiState.isPlaying) ipcRenderer.send('audio:pause');
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
        helper.shell.showItemInFolder(g.music[g.idx]);
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
