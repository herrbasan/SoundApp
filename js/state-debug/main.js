/**
 * State Debugger Window
 * 
 * Displays real-time state from main process (app.js)
 * for debugging complex state transitions.
 */

let bridge;
let initialized = false;
let g = {
    init_data: null
};

// State storage
const state = {
    main: null
};

// DOM elements
let mainStateEl;
let mainTimeEl;

async function init() {
    if (initialized) return;
    initialized = true;

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
    mainTimeEl = document.getElementById('main-timestamp');

    // Setup button handlers
    document.getElementById('btn-copy').addEventListener('click', copyToClipboard);
    document.getElementById('btn-export').addEventListener('click', exportJSON);
    document.getElementById('btn-refresh').addEventListener('click', requestState);

    // Listen for state updates from main process
    bridge.on('state-debug:main', (data) => {
        console.log('[state-debug] Received main state');
        state.main = data.state;
        renderMainState();
    });

    // Request initial state
    requestState();

    // Auto-refresh every 1 second for real-time debugging
    setInterval(requestState, 1000);

    // Mark as ready for CSS transition
    document.querySelector('main').classList.add('ready');
}

function requestState() {
    console.log('[state-debug] requestState called');
    // Send directly to main process (no stageId/player relay needed)
    bridge.sendToMain('state-debug:request');
}

function renderMainState() {
    if (!state.main) {
        mainStateEl.innerHTML = '<div class="state-row"><span class="state-value null">No data</span></div>';
        return;
    }
    
    mainTimeEl.textContent = new Date().toLocaleTimeString();
    mainStateEl.innerHTML = renderObject(state.main);
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

function escapeHtml(text) {
    if (typeof text !== 'string') return String(text);
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getExportData() {
    return {
        timestamp: new Date().toISOString(),
        main: state.main
    };
}

async function copyToClipboard() {
    const data = JSON.stringify(getExportData(), null, 2);
    try {
        await navigator.clipboard.writeText(data);
        console.log('[State Debug] State copied to clipboard');
    } catch (err) {
        console.error('[State Debug] Failed to copy:', err);
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
    console.log('[State Debug] State exported to file');
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
            parameters: { open: true, visible: true, windowId: 3 },
            monitoring: { open: false, visible: false, windowId: null },
            mixer: { open: false, visible: false, windowId: null },
            settings: { open: false, visible: false, windowId: null },
            help: { open: false, visible: false, windowId: null }
        },
        windows: {
            player: { windowId: 1, visible: true, minimized: false, focused: true },
            engine: { windowId: 2, alive: true },
            stateDebug: { windowId: 4 }
        },
        engineState: {
            engines: {
                ffmpeg: { loaded: true, active: true, pipeline: 'normal' },
                midi: { loaded: true, active: false, moduleLoaded: true, initialized: false },
                tracker: { loaded: false, active: false, moduleLoaded: true }
            },
            playback: {
                file: 'Example Audio Book.m4b',
                type: 'FFmpeg',
                playing: true,
                position: 1234.56,
                duration: 3741.2
            },
            pipeline: {
                active: 'normal',
                rubberbandLoaded: false,
                rubberbandInitialized: false
            },
            windows: {
                parameters: 3,
                monitoring: null,
                parametersVisible: true,
                monitoringVisible: false
            }
        },
        idleState: {
            state: 'ACTIVE',
            lastActivityTime: Date.now(),
            lastActivityTimeStr: new Date().toLocaleTimeString(),
            isDisposing: false,
            pollingActive: true,
            isPlaying: true,
            engineAlive: true,
            windowVisible: true,
            timeoutMs: 10000,
            idleTimeMs: 0
        }
    };
    
    // Wait for DOM ready then render
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                mainStateEl = document.getElementById('main-state');
                mainTimeEl = document.getElementById('main-timestamp');
                renderMainState();
                document.querySelector('main').classList.add('ready');
            }, 100);
        });
    } else {
        setTimeout(() => {
            mainStateEl = document.getElementById('main-state');
            mainTimeEl = document.getElementById('main-timestamp');
            renderMainState();
            document.querySelector('main').classList.add('ready');
        }, 100);
    }
}
