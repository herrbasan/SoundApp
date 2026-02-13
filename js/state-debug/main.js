/**
 * State Debugger Window
 * 
 * Displays real-time state from main process (app.js) and engine (engines.js)
 * for debugging complex state transitions.
 */

let bridge;
let g = {
    init_data: null
};

// State storage
const state = {
    main: null,
    engine: null,
    audio: null,
    actions: []
};

const MAX_ACTIONS = 50;

// DOM elements
let mainStateEl, engineStateEl, audioStateEl, actionLogEl;
let mainTimeEl, engineTimeEl, audioTimeEl;

async function init() {
    if (window.bridge) {
        bridge = window.bridge;
    } else {
        console.warn('Bridge not found');
        bridge = {
            on: () => {},
            sendToStage: () => {},
            once: () => {},
            window: { close: () => {}, hide: () => {} }
        };
    }

    // Cache DOM elements
    mainStateEl = document.getElementById('main-state');
    engineStateEl = document.getElementById('engine-state');
    audioStateEl = document.getElementById('audio-state');
    actionLogEl = document.getElementById('action-log');
    mainTimeEl = document.getElementById('main-timestamp');
    engineTimeEl = document.getElementById('engine-timestamp');
    audioTimeEl = document.getElementById('audio-timestamp');

    // Setup button handlers
    document.getElementById('btn-copy').addEventListener('click', copyToClipboard);
    document.getElementById('btn-export').addEventListener('click', exportJSON);
    document.getElementById('btn-refresh').addEventListener('click', requestState);

    // Listen for state updates from main process
    bridge.on('state-debug:main', (data) => {
        state.main = data.state;
        // Only log actions that aren't polling updates
        if (data.action && data.action !== 'request') {
            addAction('main', data.action, data.detail);
        }
        // Process actions array from main process (if provided)
        if (data.actions && Array.isArray(data.actions)) {
            data.actions.forEach(action => {
                if (action.action && action.action !== 'request') {
                    addAction(action.source || 'main', action.action, action.detail);
                }
            });
        }
        renderMainState();
    });

    bridge.on('state-debug:engine', (data) => {
        state.engine = data.state;
        // Engine state updates - don't log unless explicit action
        if (data.action && data.action !== 'request') {
            addAction('engine', data.action, data.detail);
        }
        renderEngineState();
    });

    bridge.on('state-debug:audio', (data) => {
        state.audio = data;
        renderAudioState();
    });

    // Request initial state
    requestState();

    // Auto-refresh every 2 seconds as fallback
    setInterval(requestState, 2000);
    
    // Mark as ready for CSS transition
    document.querySelector('main').classList.add('ready');
}

function requestState() {
    bridge.sendToStage('state-debug:request');
}

function addAction(source, action, detail) {
    // Skip if no action or if it's a polling request
    if (!action || action === 'request') {
        return;
    }
    
    const timestamp = new Date().toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        fractionalSecondDigits: 3
    });
    
    state.actions.unshift({
        timestamp,
        source,
        action,
        detail: detail || ''
    });
    
    // Keep only last N actions
    if (state.actions.length > MAX_ACTIONS) {
        state.actions.pop();
    }
    
    renderActions();
}

function renderMainState() {
    if (!state.main) {
        mainStateEl.innerHTML = '<div class="state-row"><span class="state-value null">No data</span></div>';
        return;
    }
    
    mainTimeEl.textContent = new Date().toLocaleTimeString();
    mainStateEl.innerHTML = renderObject(state.main);
}

function renderEngineState() {
    if (!state.engine) {
        engineStateEl.innerHTML = '<div class="state-row"><span class="state-value null">No data</span></div>';
        return;
    }
    
    engineTimeEl.textContent = new Date().toLocaleTimeString();
    engineStateEl.innerHTML = renderObject(state.engine);
}

function renderAudioState() {
    if (!state.audio) {
        audioStateEl.innerHTML = '<div class="state-row"><span class="state-value null">No data</span></div>';
        return;
    }
    
    audioTimeEl.textContent = new Date().toLocaleTimeString();
    audioStateEl.innerHTML = renderObject(state.audio);
}

function renderObject(obj, prefix = '') {
    if (obj === null) return '<span class="state-value null">null</span>';
    if (obj === undefined) return '<span class="state-value null">undefined</span>';
    
    const type = typeof obj;
    
    if (type === 'boolean') {
        return `<span class="state-value boolean-${obj}">${obj}</span>`;
    }
    if (type === 'number') {
        return `<span class="state-value number">${obj}</span>`;
    }
    if (type === 'string') {
        return `<span class="state-value string">"${escapeHtml(obj)}"</span>`;
    }
    if (Array.isArray(obj)) {
        if (obj.length === 0) return '<span class="state-value">[]</span>';
        return obj.map((item, i) => `
            <div class="state-row">
                <span class="state-key">[${i}]</span>
                <span class="state-value">${renderObject(item)}</span>
            </div>
        `).join('');
    }
    
    // Object
    const entries = Object.entries(obj);
    if (entries.length === 0) return '<span class="state-value">{}</span>';
    
    return entries.map(([key, value]) => {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        return `
            <div class="state-row">
                <span class="state-key">${escapeHtml(key)}</span>
                <span class="state-value">${renderObject(value, fullKey)}</span>
            </div>
        `;
    }).join('');
}

function renderActions() {
    if (!actionLogEl) return;
    
    actionLogEl.innerHTML = state.actions.map(action => {
        let cssClass = '';
        if (action.action.includes('error') || action.action.includes('fail')) {
            cssClass = 'error';
        } else if (action.action.includes('restore') || action.action.includes('create')) {
            cssClass = 'success';
        } else if (action.action.includes('warning') || action.action.includes('skip')) {
            cssClass = 'warning';
        }
        
        return `
            <div class="action-item ${cssClass}">
                <div>
                    <span class="action-time">${action.timestamp}</span>
                    <span class="action-name">[${action.source}] ${escapeHtml(action.action)}</span>
                </div>
                ${action.detail ? `<div class="action-detail">${escapeHtml(action.detail)}</div>` : ''}
            </div>
        `;
    }).join('');
}

function escapeHtml(text) {
    if (typeof text !== 'string') return String(text);
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getExportData() {
    return {
        timestamp: new Date().toISOString(),
        main: state.main,
        engine: state.engine,
        audio: state.audio,
        recentActions: state.actions
    };
}

async function copyToClipboard() {
    const data = JSON.stringify(getExportData(), null, 2);
    try {
        await navigator.clipboard.writeText(data);
        addAction('ui', 'copy-to-clipboard', 'State copied to clipboard');
    } catch (err) {
        addAction('ui', 'copy-to-clipboard', 'Failed: ' + err.message);
    }
}

function exportJSON() {
    const data = getExportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soundapp-state-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addAction('ui', 'export-json', 'State exported to file');
}

// Wait for bridge-ready
window.addEventListener('bridge-ready', async (e) => {
    g.init_data = e.detail;
    await init();
});

// Also init if DOM is ready and bridge already exists
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.bridge && window.bridge.isElectron) {
            init();
        }
    });
} else if (window.bridge && window.bridge.isElectron) {
    init();
}

// Browser preview: Generate mock data for styling
if (typeof process === 'undefined' || !process.versions || !process.versions.electron) {
    console.log('[State Debug] Browser preview mode - generating mock data');
    
    // Mock state data
    state.main = {
        audioState: {
            file: "My Audio Book [ABC123] - Chapter 5.m4b",
            isPlaying: true,
            position: 1234.56,
            duration: 3741.2,
            fileType: "FFmpeg",
            mode: "pitchtime",
            tapeSpeed: 0,
            pitch: 3,
            tempo: 1.15,
            formant: true,
            locked: false,
            volume: 0.75,
            loop: false,
            activePipeline: "rubberband",
            engineAlive: true
        },
        midiParams: {
            transpose: 0,
            bpm: 120,
            metronome: false,
            soundfont: "TimGM6mb.sf2"
        },
        trackerParams: {
            pitch: 1.1,
            tempo: 0.95,
            stereoSeparation: 120
        },
        childWindows: {
            parameters: { open: true },
            monitoring: { open: false },
            mixer: { open: false }
        },
        idleState: {
            lastActivityTime: new Date().toLocaleTimeString(),
            engineDisposalTimeout: false,
            visibleDisposeTimeout: false
        }
    };
    
    state.engine = {
        audioParams: {
            mode: "pitchtime",
            tapeSpeed: 0,
            pitch: 3,
            tempo: 1.15,
            formant: true,
            locked: false
        },
        activePipeline: "rubberband",
        windows: {
            parametersOpen: true,
            monitoringReady: false
        },
        midiSettings: {
            pitch: 0,
            speed: null
        },
        trackerParams: {
            pitch: 1.1,
            tempo: 0.95,
            stereoSeparation: 120
        }
    };
    
    state.audio = {
        isFFmpeg: true,
        isMidi: false,
        isMod: false,
        fp: "My Audio Book [ABC123] - Chapter 5.m4b",
        paused: false,
        currentTime: 1234.56,
        duration: 3741.2
    };
    
    // Mock actions
    state.actions = [
        { timestamp: "22:24:03.241", source: "main", action: "pipeline-switch", detail: "Switched to pitchtime mode" },
        { timestamp: "22:24:02.150", source: "user", action: "play clicked", detail: "" },
        { timestamp: "22:23:45.892", source: "main", action: "engine-restored", detail: "Engine restored in 245ms" },
        { timestamp: "22:23:40.100", source: "main", action: "engine-disposed", detail: "0% CPU mode activated" },
        { timestamp: "22:23:15.555", source: "user", action: "param: pitch=3", detail: "" },
        { timestamp: "22:23:14.123", source: "user", action: "param: tempo=1.15", detail: "" },
        { timestamp: "22:23:10.888", source: "main", action: "window-opened", detail: "parameters window created" },
        { timestamp: "22:23:05.444", source: "main", action: "drag-drop", detail: "add (3 files)" },
        { timestamp: "22:22:45.333", source: "user", action: "load file: My Audio Book.m4b", detail: "" },
        { timestamp: "22:22:30.777", source: "main", action: "pipeline-switch", detail: "Switched to tape mode" },
        { timestamp: "22:22:15.444", source: "user", action: "prev track", detail: "" },
        { timestamp: "22:21:50.222", source: "main", action: "cmdline-open", detail: "Initial file open (1 file)" },
        { timestamp: "22:21:30.111", source: "user", action: "play clicked", detail: "" }
    ];
    
    // Wait for DOM ready then render
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                mainStateEl = document.getElementById('main-state');
                engineStateEl = document.getElementById('engine-state');
                audioStateEl = document.getElementById('audio-state');
                actionLogEl = document.getElementById('action-log');
                mainTimeEl = document.getElementById('main-timestamp');
                engineTimeEl = document.getElementById('engine-timestamp');
                audioTimeEl = document.getElementById('audio-timestamp');
                
                renderMainState();
                renderEngineState();
                renderAudioState();
                renderActions();
                document.querySelector('main').classList.add('ready');
            }, 100);
        });
    } else {
        setTimeout(() => {
            mainStateEl = document.getElementById('main-state');
            engineStateEl = document.getElementById('engine-state');
            audioStateEl = document.getElementById('audio-state');
            actionLogEl = document.getElementById('action-log');
            mainTimeEl = document.getElementById('main-timestamp');
            engineTimeEl = document.getElementById('engine-timestamp');
            audioTimeEl = document.getElementById('audio-timestamp');
            
            renderMainState();
            renderEngineState();
            renderAudioState();
            renderActions();
            document.querySelector('main').classList.add('ready');
        }, 100);
    }
}
