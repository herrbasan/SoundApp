'use strict';

/**
 * ENGINES.JS - Headless Audio Engine
 * 
 * Derived from stage.js by stripping all UI code.
 * Handles audio playback, pipeline switching, and monitoring.
 * Communicates with app.js (main) via IPC.
 */

const { ipcRenderer } = require("electron");
const fs = require('fs').promises;
const path = require('path');
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const os = require('node:os');
const RubberbandPipeline = require('./rubberband-pipeline.js');

// ═══════════════════════════════════════════════════════════════════════════
// Direct Window Communication - Bypass main process for high-frequency data
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send data directly to a specific window by ID.
 * Uses ipcRenderer.sendTo for direct renderer-to-renderer communication.
 * 
 * @param {number|null} windowId - The target window ID (from g.windows)
 * @param {string} channel - The IPC channel name
 * @param {*} data - The data to send
 */
/**
 * Send data to a window. Uses MessagePort for direct communication if available,
 * otherwise falls back to main-process IPC (tools.sendToId).
 * 
 * For high-frequency data (VU meters), MessagePort is essential to avoid
 * main-process bottleneck.
 * 
 * @param {number} windowId - Target window ID
 * @param {string} channel - IPC channel name
 * @param {*} data - Data to send
 * @param {string} windowType - 'parameters' or 'monitoring' (for MessagePort lookup)
 */
function sendToWindow(windowId, channel, data, windowType) {
	if (!windowId || g.isDisposed) {
		return;
	}
	
	// Try MessagePort first if available (direct, zero main-process overhead)
	if (windowType && g.messagePorts[windowType]) {
		try {
			g.messagePorts[windowType].postMessage({ channel, data });
			return;
		} catch (err) {
			// Port failed, remove it so we don't try again
			delete g.messagePorts[windowType];
		}
	}
	
	// Fallback to main-process IPC
	try {
		tools.sendToId(windowId, channel, data);
	} catch (err) {
		// Window may not exist or be destroyed, fail silently
	}
}

/**
 * Broadcast data to all windows of a given type that are registered.
 * Currently supports 'parameters' and 'monitoring' windows.
 * 
 * @param {string} windowType - 'parameters' or 'monitoring'
 * @param {string} channel - The IPC channel name  
 * @param {*} data - The data to send
 */
function broadcastToWindow(windowType, channel, data) {
	const windowId = g.windows[windowType];
	if (windowId) {
		sendToWindow(windowId, channel, data);
	}
}

let player;
let midi;
let g = {};
g.test = {};
g.audioContext = null;
g.rubberbandContext = null;
g.rubberbandPlayer = null;
g.ffmpegPlayer = null;
g.activePipeline = 'normal';
g.parametersOpen = false;
g.windows = { help: null, settings: null, playlist: null, mixer: null, pitchtime: null, 'midi': null, parameters: null, monitoring: null };
g.windowsVisible = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false, parameters: false, monitoring: false };
g.windowsClosing = { help: false, settings: false, playlist: false, mixer: false, pitchtime: false, 'midi': false, parameters: false, monitoring: false };
g.monitoringReady = false;
g.monitoringLoop = null;
g.monitoringAnalyserL = null;
g.monitoringAnalyserR = null;
g.monitoringSplitter = null;
g.monitoringAnalyserL_RB = null;
g.monitoringAnalyserR_RB = null;
g.messagePorts = {}; // MessagePorts for direct renderer-to-renderer communication (key: window type)
g.isDisposed = false; // Flag to prevent sending data after disposal starts
g.monitoringSplitter_RB = null;
g.lastNavTime = 0;
g.mixerPlaying = false;
g.music = [];          // Playlist (mirrors app.js state)
g.idx = 0;             // Current playlist index
g.max = -1;

// =============================================================================
// TRACKER (CHIPTUNE) LAZY INITIALIZATION
// =============================================================================
let _trackerInstance = null;
let _trackerInitPromise = null;
let _trackerInitialized = false;

/**
 * Lazy accessor for Tracker (Chiptune) player.
 * Returns existing instance or initializes on first access.
 */
async function getTrackerPlayer() {
    // Check if lazy-init is enabled (default: false for compatibility)
    const lazyInitEnabled = (typeof g !== 'undefined' && g?.main_env && (g.main_env.lazyLoadTracker || g.main_env.lazyLoadEngines)) || 
                            (typeof main_env !== 'undefined' && main_env?.lazyLoadTracker);
    
    // If not lazy-init, initialize immediately on first call
    if (!lazyInitEnabled) {
        console.log('[Tracker] Lazy-init disabled, creating instance immediately');
        if (!_trackerInstance && window.chiptune) {
            _trackerInstance = createTrackerPlayer();
            player = _trackerInstance;  // Legacy compatibility
        }
        return _trackerInstance;
    }
    
    console.log('[Tracker] Lazy-init enabled, initializing on first access...');
    
    // Return existing instance if still valid (not disposed)
    if (_trackerInstance) {
        // Verify instance is still connected to current AudioContext
        if (g.isDisposed) {
            console.warn('[Tracker] Existing instance tied to disposed engine, resetting');
            _trackerInstance = null;
            _trackerInitialized = false;
        } else {
            return _trackerInstance;
        }
    }
    
    // Return in-progress initialization
    if (_trackerInitPromise) return _trackerInitPromise;
    
    // Start initialization
    _trackerInitPromise = initTrackerPlayerLazy();
    
    try {
        const instance = await _trackerInitPromise;
        // Check again if disposed during init
        if (g.isDisposed) {
            console.warn('[Tracker] Engine disposed during init, discarding instance');
            try { instance.stop(); } catch (e) {}
            try { if (instance.gain) instance.gain.disconnect(); } catch (e) {}
            _trackerInstance = null;
            _trackerInitialized = false;
            return null;
        }
        _trackerInstance = instance;
        _trackerInitialized = true;
        player = _trackerInstance;  // Legacy compatibility
        return _trackerInstance;
    } catch (err) {
        console.error('[Tracker] Failed to initialize:', err);
        _trackerInstance = null;
        _trackerInitialized = false;
        return null;
    } finally {
        _trackerInitPromise = null;
    }
}

/**
 * Create tracker player instance
 */
function createTrackerPlayer() {
    if (!window.chiptune || !g.audioContext) return null;
    
    console.log('[Tracker] Creating player instance...');
    
    const modConfig = {
        repeatCount: 0,
        stereoSeparation: (g.config && g.config.tracker && g.config.tracker.stereoSeparation !== undefined) ? (g.config.tracker.stereoSeparation | 0) : 100,
        context: g.audioContext
    };
    
    const tracker = new window.chiptune(modConfig);
    
    // Set up event handlers
    tracker.onMetadata(async (meta) => {
        if (g.currentAudio) {
            g.currentAudio.duration = tracker.duration;
            if (meta && meta.song && meta.song.channels) {
                g.currentAudio.channels = meta.song.channels.length;
            }
        }
        g.blocky = false;
        ipcRenderer.send('audio:metadata', { duration: tracker.duration, metadata: meta });
    });
    
    tracker.onProgress((e) => {
        if (g.currentAudio) {
            g.currentAudio.currentTime = e.pos || 0;
        }
        if (!g.isDisposed && e.vu && g.windows.parameters && e.vu.length > 0 && e.vu.length <= 64) {
            sendToWindow(g.windows.parameters, 'tracker-vu', { vu: e.vu, channels: e.vu.length }, 'parameters');
        }
    });
    
    tracker.onEnded(audioEnded);
    tracker.onError((err) => { console.error('[Tracker] Error:', err.message || err); audioEnded(); g.blocky = false; });
    
    tracker.onInitialized(() => {
        tracker.gain.connect(g.audioContext.destination);
        if (g.monitoringSplitter) {
            tracker.gain.connect(g.monitoringSplitter);
        }
        g.blocky = false;
    });
    
    return tracker;
}

/**
 * Lazy tracker initialization - called only when first tracker file is played.
 */
async function initTrackerPlayerLazy() {
    
    // Wait for chiptune library to be available
    let waitMs = 0;
    const maxWaitMs = 5000;
    while (!window.chiptune && waitMs < maxWaitMs) {
        await new Promise(r => setTimeout(r, 50));
        waitMs += 50;
    }
    
    if (!window.chiptune) {
        console.error('[Tracker] Chiptune library not loaded after', maxWaitMs, 'ms');
        return null;
    }
    
    if (!g.audioContext) {
        console.error('[Tracker] AudioContext not available');
        return null;
    }
    
    const tracker = createTrackerPlayer();
    
    // Wait briefly for onInitialized to fire (gain node connection)
    // The chiptune library initializes asynchronously
    let gainWaitMs = 0;
    while (!tracker.gain && gainWaitMs < 500) {
        await new Promise(r => setTimeout(r, 10));
        gainWaitMs += 10;
    }
    
    if (!tracker.gain) {
        console.warn('[Tracker] Gain node not created after 500ms, proceeding anyway');
    }
    
    // Check if engine was disposed during initialization
    // Prevents returning stale instance tied to destroyed AudioContext
    if (g.isDisposed) {
        console.warn('[Tracker] Engine disposed during init, aborting');
        try { tracker.stop(); } catch (e) {}
        try { if (tracker.gain) tracker.gain.disconnect(); } catch (e) {}
        return null;
    }
    
    return tracker;
}


// Engine state
const engineState = {
    file: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    mode: 'tape',
    tapeSpeed: 0,
    pitch: 0,
    tempo: 1.0,
    formant: false,
    locked: false,
    volume: 0.5,
    loop: false,
    activePipeline: 'normal'
};

g.midiSettings = { pitch: 0, speed: null };
g.audioParams = {
    mode: 'tape',      // 'tape' or 'pitchtime'
    tapeSpeed: 0,      // -12 to +12 semitones
    pitch: 0,          // -12 to +12 semitones (for rubberband)
    tempo: 1.0,        // 0.5 to 1.5 ratio (for rubberband)
    formant: false,    // formant preservation
    locked: false      // lock settings across track changes
};

// Position push interval - adaptive based on user activity
let positionPushInterval = null;
let positionPushMode = 'normal'; // 'scrubbing' | 'normal' | 'idle' | 'minimal'
const POSITION_PUSH_INTERVALS = {
    scrubbing: 16,  // User dragging seek bar - max responsiveness
    normal: 50,     // Standard playback - good enough for UI
    idle: 250,      // Window hidden/background - conserve CPU
    minimal: 500    // Deep background - minimal updates
};

// =============================================================================
// ROUTING COORDINATOR - Centralized State Machine
// =============================================================================
// Single source of truth for audio pipeline and monitoring state decisions.
// All routing logic lives here; execution happens via applyRoutingState().

/**
 * Calculate which audio pipeline should be active based on current state.
 * Returns: 'normal' | 'rubberband'
 */
function calculateDesiredPipeline() {
	// No FFmpeg file playing = normal pipeline (no rubberband for MIDI/tracker)
	if (!g.currentAudio || !g.currentAudio.isFFmpeg) {
		console.log('[calculateDesiredPipeline] No FFmpeg file, returning normal');
		return 'normal';
	}
	
	// Locked pitchtime mode persists even when parameters window closed
	if (g.audioParams.locked && g.audioParams.mode === 'pitchtime') {
		console.log('[calculateDesiredPipeline] Locked pitchtime, returning rubberband');
		return 'rubberband';
	}
	
	// Parameters window open in pitchtime mode
	if (g.parametersOpen && g.audioParams.mode === 'pitchtime') {
		console.log('[calculateDesiredPipeline] Params open + pitchtime, returning rubberband');
		return 'rubberband';
	}
	
	// Default: normal pipeline
	console.log('[calculateDesiredPipeline] Default normal, mode:', g.audioParams.mode, 'locked:', g.audioParams.locked, 'paramsOpen:', g.parametersOpen);
	return 'normal';
}

/**
 * Calculate whether monitoring should be active based on current state.
 * Returns: boolean
 */
function calculateDesiredMonitoring() {
	// Window must exist, be visible, and be ready
	return !!(g.windows.monitoring && g.windowsVisible.monitoring && g.monitoringReady);
}

/**
 * Apply the calculated routing state.
 * Handles transitions between pipeline states and monitoring activation.
 * Call this whenever state changes affect routing (window show/hide, mode change, track change).
 * 
 * @param {boolean|null} shouldPlay - Explicitly set playback state after transition (null = auto-detect from current player)
 */
async function applyRoutingState(shouldPlay = null) {
	const desiredPipeline = calculateDesiredPipeline();
	const desiredMonitoring = calculateDesiredMonitoring();
	
	// --- Pipeline Routing (with lazy rubberband initialization) ---
	if (g.activePipeline !== desiredPipeline) {
		if (desiredPipeline === 'rubberband') {
			// Transition to rubberband - lazy init if needed
			if (g.currentAudio && g.currentAudio.isFFmpeg) {
				const ready = await ensureRubberbandPipeline();
				if (ready) {

					try {
						await switchPipeline('rubberband', shouldPlay);
						g.rubberbandPlayer.connect();
						// Connect to monitoring if active
						if (desiredMonitoring && g.monitoringSplitter_RB) {
							g.rubberbandPlayer.connect(g.monitoringSplitter_RB);

						} else if (desiredMonitoring) {

						}
					} catch (err) {
						console.error('[Routing] Failed to switch to rubberband:', err);
					}
				}
			}
		} else {
			// Transition to normal
			if (g.activePipeline === 'rubberband') {

				// Use switchPipeline to properly transition playback to normal player
				try {
					await switchPipeline('normal', shouldPlay);
				} catch (err) {
					console.error('[Routing] Failed to switch to normal pipeline:', err);
				}
			}
		}
	}
	
	// --- Rubberband Cleanup (when no longer needed) ---
	// Destroy rubberband if: not desired, not locked, and not currently playing
	const shouldKeepRubberband = desiredPipeline === 'rubberband' || 
		(g.audioParams.locked && g.audioParams.mode === 'pitchtime');
	if (!shouldKeepRubberband && g.rubberbandPlayer && g.activePipeline !== 'rubberband') {
		// Destroy to free ~70MB memory
		await destroyRubberbandPipeline();
	}
	
	// --- Monitoring Routing (lazy resource management) ---
	if (desiredMonitoring && !g.monitoringAnalyserL) {
		// Monitoring just became active - create resources
		initMonitoring();
	} else if (!desiredMonitoring && g.monitoringAnalyserL) {
		// Monitoring just became inactive - destroy resources to save CPU/memory
		destroyMonitoring();
	}
	
	// --- Monitoring Connection Updates ---
	if (desiredMonitoring && g.monitoringAnalyserL) {
		// Ensure correct pipeline is connected to monitoring taps
		await updateMonitoringConnections();
	}
}

/**
 * Update monitoring tap connections based on current pipeline.
 * Called when pipeline switches while monitoring is active.
 */
async function updateMonitoringConnections() {
	// Disconnect all sources first (idempotent) - safe even if splitters don't exist
	try {
		if (g.ffmpegPlayer?.gainNode && g.monitoringSplitter) g.ffmpegPlayer.gainNode.disconnect(g.monitoringSplitter);
	} catch (e) {}
	try {
		if (player?.gain && g.monitoringSplitter) player.gain.disconnect(g.monitoringSplitter);
	} catch (e) {}
	try {
		if (midi?.gain && g.monitoringSplitter) midi.gain.disconnect(g.monitoringSplitter);
	} catch (e) {}
	try {
		if (g.rubberbandPlayer && g.monitoringSplitter_RB) g.rubberbandPlayer.disconnect(g.monitoringSplitter_RB);
	} catch (e) {}
	
	// Small delay to ensure player is fully initialized
	await new Promise(resolve => setTimeout(resolve, 10));
	
	// Connect active source to appropriate splitter
	if (g.activePipeline === 'rubberband' && g.rubberbandPlayer && g.monitoringSplitter_RB) {
		g.rubberbandPlayer.connect(g.monitoringSplitter_RB);

	} else if (g.monitoringSplitter) {
		// Normal pipeline - connect based on file type
		if (g.currentAudio?.isFFmpeg && g.ffmpegPlayer?.gainNode) {
			g.ffmpegPlayer.gainNode.connect(g.monitoringSplitter);
		} else if (g.currentAudio?.isMod && player?.gain) {
			player.gain.connect(g.monitoringSplitter);
		} else if (g.currentAudio?.isMidi && midi?.gain) {
			// MIDI: connect via resampler if active, otherwise direct
			const sourceNode = midi.needsResampling ? midi.resamplerSource : midi.gain;
			if (sourceNode) sourceNode.connect(g.monitoringSplitter);
		}
	}
}

/**
 * Destroy monitoring resources to free CPU/memory.
 * Called when monitoring window is hidden.
 */
function destroyMonitoring() {
	if (g.monitoringLoop) {
		clearInterval(g.monitoringLoop);
		g.monitoringLoop = null;
	}
	
	if (g.monitoringAnalyserL) {
		try { g.monitoringAnalyserL.disconnect(); } catch (e) {}
		g.monitoringAnalyserL = null;
	}
	if (g.monitoringAnalyserR) {
		try { g.monitoringAnalyserR.disconnect(); } catch (e) {}
		g.monitoringAnalyserR = null;
	}
	if (g.monitoringSplitter) {
		try { g.monitoringSplitter.disconnect(); } catch (e) {}
		g.monitoringSplitter = null;
	}
	
	if (g.monitoringAnalyserL_RB) {
		try { g.monitoringAnalyserL_RB.disconnect(); } catch (e) {}
		g.monitoringAnalyserL_RB = null;
	}
	if (g.monitoringAnalyserR_RB) {
		try { g.monitoringAnalyserR_RB.disconnect(); } catch (e) {}
		g.monitoringAnalyserR_RB = null;
	}
	if (g.monitoringSplitter_RB) {
		try { g.monitoringSplitter_RB.disconnect(); } catch (e) {}
		g.monitoringSplitter_RB = null;
	}
	
	g.monitoringBuffers = null;
}

/**
 * Ensure rubberband pipeline is initialized (lazy initialization).
 * Creates context and player on demand. Idempotent - safe to call multiple times.
 */
async function ensureRubberbandPipeline() {
	// Already initialized?
	// Also check if the worklet inside the player is still valid (not disposed by clearAudio)
	const workletValid = g.rubberbandPlayer && g.rubberbandPlayer.rubberbandNode;
	if (g.rubberbandPlayer && workletValid && g.rubberbandContext && g.rubberbandContext.state !== 'closed') {
		return true;
	}
	
	if (g.rubberbandPlayer && !workletValid) {
		// Worklet was disposed (e.g., by clearAudio), but player object exists
		// The worklet will be recreated by rubberbandPlayer.open() - don't dispose the entire player
		console.log('[ensureRubberbandPipeline] Worklet disposed but player exists, will be recreated by open()');
		// Just mark as needs re-init, don't dispose the whole player
	}
	

	
	try {
		// Create 48kHz context for rubberband (fixed rate, ignores HQ mode)
		if (!g.rubberbandContext || g.rubberbandContext.state === 'closed') {
			g.rubberbandContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
			
			// Match output device to main context
			const outDevId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
			if (outDevId) {
				try {
					await g.rubberbandContext.setSinkId(outDevId);
				} catch (err) {
					console.warn('[Rubberband] Failed to set output device:', err);
				}
			}
		}
		
		// Create rubberband pipeline
		const threadCount = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder && g.config.ffmpeg.decoder.threads !== undefined) ? (g.config.ffmpeg.decoder.threads | 0) : 0;
		const RubberbandPipeline = require('./rubberband-pipeline.js');
		g.rubberbandPlayer = new RubberbandPipeline(g.rubberbandContext, g.FFmpegDecoder, g.ffmpeg_player_path, g.ffmpeg_worklet_path, g.rubberband_worklet_path, threadCount);
		
		await g.rubberbandPlayer.init();

		
		// Re-initialize monitoring to create RB analysers now that context exists
		if (g.windows.monitoring && g.windowsVisible.monitoring) {

			initMonitoring();
		}
		
		return true;
	} catch (err) {
		console.error('[Rubberband] Failed to initialize pipeline:', err);
		g.rubberbandPlayer = null;
		return false;
	}
}

/**
 * Destroy rubberband pipeline to free memory (~70MB WASM heap).
 * Called when pitchtime mode is no longer needed.
 */
async function destroyRubberbandPipeline() {
	if (!g.rubberbandPlayer && !g.rubberbandContext) return;
	

	
	// Disconnect from monitoring if connected
	if (g.monitoringSplitter_RB) {
		try {
			if (g.rubberbandPlayer) g.rubberbandPlayer.disconnect(g.monitoringSplitter_RB);
		} catch (e) {}
	}
	
	// Dispose player
	if (g.rubberbandPlayer) {
		try {
			await g.rubberbandPlayer.stop(false);
			if (typeof g.rubberbandPlayer.dispose === 'function') {
				g.rubberbandPlayer.dispose();
			}
		} catch (e) {
			console.warn('[Rubberband] Error disposing player:', e);
		}
		g.rubberbandPlayer = null;
	}
	
	// Also destroy rubberband-specific monitoring taps
	if (g.monitoringAnalyserL_RB) {
		try { g.monitoringAnalyserL_RB.disconnect(); } catch (e) {}
		g.monitoringAnalyserL_RB = null;
	}
	if (g.monitoringAnalyserR_RB) {
		try { g.monitoringAnalyserR_RB.disconnect(); } catch (e) {}
		g.monitoringAnalyserR_RB = null;
	}
	if (g.monitoringSplitter_RB) {
		try { g.monitoringSplitter_RB.disconnect(); } catch (e) {}
		g.monitoringSplitter_RB = null;
	}
	
	// Close context
	if (g.rubberbandContext && g.rubberbandContext.state !== 'closed') {
		try {
			await g.rubberbandContext.close();
		} catch (e) {}
	}
	g.rubberbandContext = null;
	
	// Reset active pipeline so applyRoutingState() knows to recreate rubberband if needed
	if (g.activePipeline === 'rubberband') {
		g.activePipeline = 'normal';
	}
	

}

// Init
// ###########################################################################

async function detectMaxSampleRate() {
	const rates = [192000, 176400, 96000, 88200, 48000, 44100];
	for (let i = 0; i < rates.length; i++) {
		const ctx = new AudioContext({ sampleRate: rates[i] });

		if (ctx.sampleRate === rates[i]) {
			await ctx.close();

			return rates[i];
		}
		await ctx.close();
	}

	return 48000;
}

/**
 * Start position push interval - sends currentTime to app.js
 * Adaptive: faster when scrubbing, slower when idle
 */
function startPositionPush() {
    if (positionPushInterval) return;
    const interval = POSITION_PUSH_INTERVALS[positionPushMode] || POSITION_PUSH_INTERVALS.normal;
    positionPushInterval = setInterval(() => {
        if (g.currentAudio && typeof g.currentAudio.getCurrentTime === 'function') {
            const pos = g.currentAudio.getCurrentTime();
            ipcRenderer.send('audio:position', pos);
        }
    }, interval);
}

/**
 * Set position push mode and restart interval if active
 * @param {string} mode - 'scrubbing' | 'normal' | 'idle' | 'minimal'
 */
function setPositionPushMode(mode) {
    if (positionPushMode === mode) return;
    positionPushMode = mode;
    // Restart interval with new timing if currently pushing
    if (positionPushInterval) {
        stopPositionPush();
        startPositionPush();
    }
}

/**
 * Stop position push interval
 */
function stopPositionPush() {
    if (positionPushInterval) {
        clearInterval(positionPushInterval);
        positionPushInterval = null;
    }
}

init();

async function init() {
    // Set process title for identification in task manager
    if (process && process.title) {
        process.title = 'SoundApp Engine';
    }
    
    g.main_env = await helper.global.get('main_env');
    g.basePath = await helper.global.get('base_path');
    g.isPackaged = await helper.global.get('isPackaged');
    g.cache_path = await helper.global.get('temp_path');
    g.start_vars = await helper.global.get('start_vars');
    g.app_path = await helper.app.getAppPath();

	g.configName = g.main_env.configName || 'user';
	g.config_obj = await helper.config.initRenderer(g.configName, async (newData) => {
		const oldConfig = g.config || {};
		const oldBuffer = (oldConfig && oldConfig.ffmpeg && oldConfig.ffmpeg.stream) ? oldConfig.ffmpeg.stream.prebufferChunks : undefined;
		const oldThreads = (oldConfig && oldConfig.ffmpeg && oldConfig.ffmpeg.decoder) ? oldConfig.ffmpeg.decoder.threads : undefined;
		g.config = newData || {};

		const oldDeviceId = (oldConfig && oldConfig.audio && oldConfig.audio.output) ? oldConfig.audio.output.deviceId : undefined;
		const deviceId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
		const oldHq = !!(oldConfig && oldConfig.audio ? oldConfig.audio.hqMode : false);
		const hq = !!(g.config && g.config.audio ? g.config.audio.hqMode : false);
		const oldStereoSep = (oldConfig && oldConfig.tracker) ? oldConfig.tracker.stereoSeparation : undefined;
		const stereoSep = (g.config && g.config.tracker) ? g.config.tracker.stereoSeparation : undefined;

		if (oldDeviceId !== deviceId) {
			const contexts = [g.audioContext, g.rubberbandContext].filter(ctx => ctx && typeof ctx.setSinkId === 'function');
			for (const ctx of contexts) {
				try {
					if (deviceId) {
						await ctx.setSinkId(deviceId);
					}
					else {
						await ctx.setSinkId('');
					}
				}
				catch (err) {
					console.error('Failed to change output device for context:', err);
				}
			}

		}

		if (oldHq !== hq) {
			await toggleHQMode(hq, true);
		}

		if (oldStereoSep !== stereoSep) {
			if (player && g.currentAudio?.isMod) {
				player.setStereoSeparation(stereoSep);
			}
		}

		const newBuffer = (g.config && g.config.ffmpeg && g.config.ffmpeg.stream) ? g.config.ffmpeg.stream.prebufferChunks : undefined;
		const newThreads = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder) ? g.config.ffmpeg.decoder.threads : undefined;
		if (g.ffmpegPlayer && (oldBuffer !== newBuffer || oldThreads !== newThreads)) {
			if (g.currentAudio && g.currentAudio.isFFmpeg) {

				const pos = g.ffmpegPlayer.getCurrentTime();
				const wasPlaying = g.ffmpegPlayer.isPlaying;

				g.ffmpegPlayer.prebufferSize = (newBuffer !== undefined) ? (newBuffer | 0) : 10;
				g.ffmpegPlayer.threadCount = (newThreads !== undefined) ? (newThreads | 0) : 0;

				try {
					await g.ffmpegPlayer.open(g.currentAudio.fp);
					if (pos > 0) g.ffmpegPlayer.seek(pos);
					if (wasPlaying) await g.ffmpegPlayer.play();
				} catch (err) {
					console.error('Failed to reset player after config change:', err);
				}
			} else {
				g.ffmpegPlayer.prebufferSize = (newBuffer !== undefined) ? (newBuffer | 0) : 10;
				g.ffmpegPlayer.threadCount = (newThreads !== undefined) ? (newThreads | 0) : 0;
			}
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
	
	// Engine doesn't handle UI - app.js manages theme and window state

	let fp = g.app_path;
	if (g.isPackaged) { fp = path.dirname(fp); }

	if (os.platform() == 'linux') {
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/linux_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/linux_bin/player-sab.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-sab.js');
		g.ffmpeg_player_pm_path = path.resolve(fp + '/bin/linux_bin/player-pm.js');
		g.ffmpeg_worklet_pm_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-pm.js');
		g.ffmpeg_player_sab_path = path.resolve(fp + '/bin/linux_bin/player-sab.js');
		g.ffmpeg_worklet_sab_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-sab.js');
		g.rubberband_worklet_path = path.resolve(fp + '/bin/linux_bin/realtime-pitch-shift-processor.js');
	}
	else {
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/win_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/win_bin/player-sab.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-sab.js');
		g.ffmpeg_player_pm_path = path.resolve(fp + '/bin/win_bin/player-pm.js');
		g.ffmpeg_worklet_pm_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-pm.js');
		g.ffmpeg_player_sab_path = path.resolve(fp + '/bin/win_bin/player-sab.js');
		g.ffmpeg_worklet_sab_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-sab.js');
		g.rubberband_worklet_path = path.resolve(fp + '/bin/win_bin/realtime-pitch-shift-processor.js');
	}

	g.maxSampleRate = await detectMaxSampleRate();
	console.log('[Engine] Max supported sample rate:', g.maxSampleRate);
	
	// Send sample rate info to main process for forwarding to UI
	const initialTargetRate = (g.config && g.config.audio && g.config.audio.hqMode) ? g.maxSampleRate : 48000;
	ipcRenderer.send('audio:sample-rate-info', {
		maxSampleRate: g.maxSampleRate,
		currentSampleRate: initialTargetRate
	});

	// Contexts will be initialized or re-applied via toggleHQMode or lazy init
	// We ensure it exists here if not already done by config handler
	if (!g.audioContext || g.audioContext.state === 'closed') {
		const targetRate = (g.config && g.config.audio && g.config.audio.hqMode) ? g.maxSampleRate : 48000;
		g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });

	}

	// Rubberband context is created lazily by ensureRubberbandPipeline()
	
	const outDevId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
	if (outDevId) {
		try {
			await g.audioContext.setSinkId(outDevId);

		} catch (err) {
			console.error('Failed to set output device, using system default:', err);
			if (g.config && g.config.audio && g.config.audio.output) g.config.audio.output.deviceId = '';
			g.config_obj.set(g.config);
		}
	}

	const { FFmpegDecoder, getMetadata } = require(g.ffmpeg_napi_path);
	g.getMetadata = getMetadata;
	g.FFmpegDecoder = FFmpegDecoder;

	const { FFmpegStreamPlayerSAB } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);
	const threadCount = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder && g.config.ffmpeg.decoder.threads !== undefined) ? (g.config.ffmpeg.decoder.threads | 0) : 0;

	if (!g.ffmpegPlayer) {
		g.ffmpegPlayer = new FFmpegStreamPlayerSAB(g.audioContext, g.ffmpeg_worklet_path, 'ffmpeg-stream-sab', 2, threadCount, false);
		try { g.ffmpegPlayer.reuseWorkletNode = true; } catch (e) { }
		try {
			await g.ffmpegPlayer.init();

			// Connect FFmpeg player to destination
			g.ffmpegPlayer.gainNode.connect(g.audioContext.destination);
		} catch (err) {
			console.error('Failed to initialize FFmpeg player:', err);
		}
	}

	// Rubberband pipeline is initialized lazily by ensureRubberbandPipeline()

	// MIDI and Tracker are lazy-init: modules load at startup, instances init on first use
	// MIDI: initMidiPlayer() called in playAudio() when isMIDI && !midi
	// Tracker: getTrackerPlayer() called in playAudio() when isTracker


		// Check if tracker lazy loading is enabled (via env.json)
		const lazyLoadTracker = g.main_env?.lazyLoadEngines || 
		                        g.main_env?.lazyLoadTracker || 
		                        false;
		
		if (lazyLoadTracker) {
			console.log('[Tracker] Lazy loading enabled - player will init on first tracker file');
			// Don't create player here - it will be created on first tracker file
			setTimeout(() => engineReady(), 0);
		} else if (!player) {
			const modConfig = {
			repeatCount: 0,
			stereoSeparation: (g.config && g.config.tracker && g.config.tracker.stereoSeparation !== undefined) ? (g.config.tracker.stereoSeparation | 0) : 100,
			context: g.audioContext
			};
			player = new window.chiptune(modConfig);
			player.onMetadata(async (meta) => {
			if (g.currentAudio) {
				g.currentAudio.duration = player.duration;
				// Store channel count from metadata for parameters window
				if (meta && meta.song && meta.song.channels) {
					g.currentAudio.channels = meta.song.channels.length;
				}
			}
			g.blocky = false;
			// Notify app.js of metadata
			ipcRenderer.send('audio:metadata', { duration: player.duration, metadata: meta });
			});
			player.onProgress((e) => {
			if (g.currentAudio) {
				g.currentAudio.currentTime = e.pos || 0;
			}
			// Forward VU data to Parameters window
			// Safety: limit to reasonable channel count and skip if disposed
			if (!g.isDisposed && e.vu && g.windows.parameters && e.vu.length > 0 && e.vu.length <= 64) {
				sendToWindow(g.windows.parameters, 'tracker-vu', { vu: e.vu, channels: e.vu.length }, 'parameters');
			}
			});
			player.onEnded(audioEnded);
			player.onError((err) => { console.error('[Player] Error:', err.message || err); audioEnded(); g.blocky = false; });
			player.onInitialized(() => {
			player.gain.connect(g.audioContext.destination);
			if (g.monitoringSplitter) {
				player.gain.connect(g.monitoringSplitter);
			}
			g.blocky = false;
			// Delay engineReady to ensure IPC handlers are registered
			setTimeout(() => engineReady(), 0);
			});
	} else {
		// Already initialized (likely by toggleHQMode), but we still need to trigger engineReady
		// Delay engineReady to ensure IPC handlers are registered first
		setTimeout(() => engineReady(), 0);
	}

	// IPC Command handlers from app.js
	ipcRenderer.on('cmd:load', async (e, data) => {
		if (data.file) {
			// cmd:load received
			await playAudio(data.file, data.position || 0, data.paused || false, false, data.restore || false);
			// Determine fileType for the loaded file
			const ext = path.extname(data.file).toLowerCase();
			const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
			const isTracker = g.supportedMpt && g.supportedMpt.includes(ext);
			const fileType = isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg';
			
			// Gather metadata for parameters window initialization
			let metadata = {};
			if (isMIDI && midi && typeof midi.getOriginalBPM === 'function') {
				metadata.originalBPM = midi.getOriginalBPM();
			}
			if (isTracker && g.currentAudio && g.currentAudio.isMod) {
				metadata.channels = g.currentAudio.channels || 0;
			}
			
			ipcRenderer.send('audio:loaded', { 
				file: data.file, 
				duration: g.currentAudio?.duration || 0,
				fileType: fileType,
				metadata: metadata,
				playlistIndex: g.idx
			});
		}
	});
	
	ipcRenderer.on('cmd:play', (e) => {

		if (g.currentAudio) {
			if (g.currentAudio.paused) {
				g.currentAudio.play();
				startPositionPush();
			}
			ipcRenderer.send('audio:state', { isPlaying: true });
		}
	});
	
	ipcRenderer.on('cmd:pause', (e) => {

		if (g.currentAudio && !g.currentAudio.paused) {
			g.currentAudio.pause();
			stopPositionPush();
			ipcRenderer.send('audio:state', { isPlaying: false });
		}
	});
	
	ipcRenderer.on('cmd:seek', (e, data) => {

		if (g.currentAudio && typeof data.position === 'number') {
			seekTo(data.position);
		}
	});
	
	// Adaptive position push mode - reduces CPU when not scrubbing
	ipcRenderer.on('engine:set-position-mode', (e, data) => {
		if (data && data.mode) {
			setPositionPushMode(data.mode);
		}
	});
	
	ipcRenderer.on('cmd:next', (e) => {

		playNext(null, false);
	});
	
	ipcRenderer.on('cmd:prev', (e) => {

		playPrev();
	});
	
	ipcRenderer.on('cmd:setParams', async (e, data) => {

		let modeChanged = false;
		if (data.mode) {
			g.audioParams.mode = data.mode;
			modeChanged = true;
		}
		if (data.tapeSpeed !== undefined) {
			g.audioParams.tapeSpeed = data.tapeSpeed;
			applyTapeSpeed(data.tapeSpeed);
		}
		if (data.pitch !== undefined) g.audioParams.pitch = data.pitch;
		if (data.tempo !== undefined) g.audioParams.tempo = data.tempo;
		if (data.formant !== undefined) g.audioParams.formant = data.formant;
		if (data.locked !== undefined) g.audioParams.locked = data.locked;
		if (data.volume !== undefined) setVolume(data.volume);
		if (data.loop !== undefined) {
			g.isLoop = data.loop;
			if (g.currentAudio?.isFFmpeg && g.currentAudio.player) {
				g.currentAudio.player.setLoop(data.loop);
			}
		}
		// Handle parametersOpen state (sent during engine restoration)
		if (data.parametersOpen !== undefined) {
			g.parametersOpen = data.parametersOpen;

		}
		// Apply routing state if mode changed - this ensures rubberband activates for pitchtime
		if (modeChanged) {
			await applyRoutingState();
		}
	});
	
	// Apply params to active players AFTER file load (Phase 4A: state preservation)
	ipcRenderer.on('cmd:applyParams', (e, data) => {

		
		if (g.currentAudio?.isFFmpeg) {
			const player = g.currentAudio.player;
			if (data.mode === 'tape' && data.tapeSpeed !== 0) {
				player.setPlaybackRate(data.tapeSpeed);
			} else if (data.mode === 'pitchtime' && g.activePipeline === 'rubberband') {
				if (typeof player.setPitch === 'function') {
					player.setPitch(Math.pow(2, (data.pitch || 0) / 12.0));
				}
				if (typeof player.setTempo === 'function') {
					player.setTempo(data.tempo || 1.0);
				}
				if (typeof player.setOptions === 'function') {
					player.setOptions({ formantPreserved: !!data.formant });
				}
			}
		} else if (g.currentAudio?.isMidi && midi) {
			if (data.transpose !== undefined) midi.setPitchOffset(data.transpose);
			if (data.bpm !== undefined && midi.getOriginalBPM) {
				const ratio = data.bpm / midi.getOriginalBPM();
				midi.setPlaybackSpeed(ratio);
			}
			if (data.metronome !== undefined) midi.setMetronome(data.metronome);
		} else if (g.currentAudio?.isMod && player) {
			// Tracker pitch is in semitones (-12 to +12), convert to multiplicative factor
			if (data.pitch !== undefined) player.setPitch(Math.pow(2, data.pitch / 12.0));
			if (data.tempo !== undefined) player.setTempo(data.tempo);
			if (data.stereoSeparation !== undefined) player.setStereoSeparation(data.stereoSeparation);
		}
	});
	
	ipcRenderer.on('cmd:playlist', (e, data) => {
		// cmd:playlist received
		if (data.music) g.music = data.music;
		if (data.idx !== undefined) g.idx = data.idx;
		if (data.max !== undefined) g.max = data.max;

	});
	// Window visibility handlers (for monitoring and parameters)
	ipcRenderer.on('window-visible', async (e, data) => {
		if (!data || !data.type) return;
		
		// Update window tracking
		if (data.windowId) {
			g.windows[data.type] = data.windowId;
		}
		g.windowsVisible[data.type] = true;
		
		if (data.type === 'monitoring') {
			g.monitoringReady = true;
			startMonitoringLoop();
			await applyRoutingState();
		}
		
		if (data.type === 'parameters') {
			g.parametersOpen = true;
		}
	});
	
	ipcRenderer.on('window-hidden', async (e, data) => {
		if (!data || !data.type) return;
		
		if (data.type === 'monitoring') {
			g.windowsVisible.monitoring = false;
			g.monitoringReady = false;
			stopMonitoringLoop();
			await applyRoutingState();
		}
		
		if (data.type === 'parameters') {
			g.windowsVisible.parameters = false;
			g.parametersOpen = false;
			// Phase 4A: Engine is stateless - do NOT reset params here.
			// Main process (app.js) owns state and sends cmd:setParams/cmd:applyParams.
			// Only handle pipeline routing: switch away from rubberband if active.
			if (g.currentAudio && g.currentAudio.isFFmpeg && g.activePipeline === 'rubberband') {
				try {
					g.rubberbandPlayer.reset();
					g.rubberbandPlayer.disconnect();
					await switchPipeline('normal');
				} catch (err) {
					console.error('Failed to switch to normal pipeline:', err);
				}
			} else if (g.rubberbandPlayer) {
				g.rubberbandPlayer.reset();
			}
			
			await applyRoutingState();
		}
	});
	
	// Receive MessagePort from main for direct renderer-to-renderer communication
	ipcRenderer.on('message-channel', (e, meta) => {
		const port = e.ports[0];
		if (!port) return;
		
		if (meta.role === 'engine' && meta.type) {
			// Close old port if exists
			if (g.messagePorts[meta.type]) {
				try { g.messagePorts[meta.type].close(); } catch (e) {}
			}
			
			// Store port for this window type
			g.messagePorts[meta.type] = port;
			
			// IMPORTANT: Start the port to receive messages
			// Without this, messages queue up in memory causing OOM
			port.start();
		}
	});
	
	// Batch window registration (used during engine restoration)
	ipcRenderer.on('windows:init', (e, data) => {
		if (data && data.windows) {

			for (const [type, info] of Object.entries(data.windows)) {
				if (info.windowId) {
					g.windows[type] = info.windowId;
					g.windowsVisible[type] = info.open;
					
					// Track parameters window state (for pipeline routing decisions)
					if (type === 'parameters' && info.open) {
						g.parametersOpen = true;
					}
					
					// Track monitoring window state only
					// NOTE: startMonitoringLoop and applyRoutingState are called AFTER file load
					if (type === 'monitoring') {
						g.monitoringReady = info.open;
					}
				}
			}
		}
	});

	// Single window registration (for new windows opened after engine is alive)
	ipcRenderer.on('window-created', (e, data) => {
		if (data && data.type && data.windowId) {
			const oldId = g.windows[data.type];
			g.windows[data.type] = data.windowId;
			g.windowsVisible[data.type] = true;

			
			// Track parameters window state for routing decisions
			if (data.type === 'parameters') {
				g.parametersOpen = true;
			}
			
			// Track monitoring window
			if (data.type === 'monitoring') {
				g.monitoringReady = true;
				startMonitoringLoop();
				applyRoutingState();
				// Send current file info if available
				if (g.currentAudio && g.currentAudio.fp) {
					const fp = g.currentAudio.fp;
					const ext = path.extname(fp).toLowerCase();
					const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
					const isTracker = g.supportedMpt && g.supportedMpt.includes(ext);
					sendToWindow(g.windows.monitoring, 'file-change', {
						filePath: fp,
						fileUrl: tools.getFileURL(fp),
						fileType: isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg',
						isMIDI: isMIDI,
						isTracker: isTracker
					});
					extractAndSendWaveform(fp);
				}
			}
			
			// Note: Parameters window state is managed by app.js
			// app.js will send set-mode after engine restoration with correct values
			// (Engine's local state may be defaults after recreate)
		}
	});
	
	ipcRenderer.on('window-closed', (e, data) => {
		if (data && data.type && g.windows[data.type] === data.windowId) {
			g.windows[data.type] = null;
			g.windowsVisible[data.type] = false;

			
			// Track parameters window state for routing decisions
			if (data.type === 'parameters') {
				g.parametersOpen = false;
			}
		}
	});
	
	// State debugger IPC - broadcast engine state for development debugging
	ipcRenderer.on('state-debug:request', (e, data) => {
		const windowId = data?.windowId;
		if (!windowId) return;
		
		const engineStateSnapshot = {
			// Audio params state
			audioParams: {
				mode: g.audioParams?.mode,
				tapeSpeed: g.audioParams?.tapeSpeed,
				pitch: g.audioParams?.pitch,
				tempo: g.audioParams?.tempo,
				formant: g.audioParams?.formant,
				locked: g.audioParams?.locked
			},
			// Pipeline state
			activePipeline: g.activePipeline,
			// Window states
			windows: {
				parametersOpen: g.parametersOpen,
				monitoringReady: g.monitoringReady
			},
			// MIDI/Tracker settings
			midiSettings: g.midiSettings,
			trackerParams: g.trackerParams
		};
		
		const audioStateSnapshot = g.currentAudio ? {
			isFFmpeg: g.currentAudio.isFFmpeg,
			isMidi: g.currentAudio.isMidi,
			isMod: g.currentAudio.isMod,
			fp: g.currentAudio.fp ? path.basename(g.currentAudio.fp) : null,
			paused: g.currentAudio.paused,
			currentTime: Math.round(g.currentAudio.currentTime * 100) / 100,
			duration: Math.round(g.currentAudio.duration * 100) / 100
		} : null;
		
		// Send directly to state-debug window
		tools.sendToId(windowId, 'state-debug:engine', {
			state: engineStateSnapshot
		});
		
		if (audioStateSnapshot) {
			tools.sendToId(windowId, 'state-debug:audio', audioStateSnapshot);
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

	ipcRenderer.on('open-soundfonts-folder', async () => {
		const userDataPath = await helper.app.getPath('userData');
		const userSoundfontsPath = path.join(userDataPath, 'soundfonts');
		try {
			await fs.mkdir(userSoundfontsPath, { recursive: true });
			await helper.shell.openPath(userSoundfontsPath);
		} catch (err) {
			console.error('[MIDI] Failed to open soundfonts folder:', err);
		}
	});

	ipcRenderer.on('midi-soundfont-changed', async (e, soundfontFile) => {
		const wasPlaying = g.currentAudio && !g.currentAudio.paused;
		const currentFile = g.currentAudio ? g.currentAudio.fp : null;
		const currentTime = g.currentAudio ? g.currentAudio.getCurrentTime() : 0;
		const currentLoop = g.isLoop;
		const isMIDI = currentFile && g.supportedMIDI && g.supportedMIDI.includes(path.extname(currentFile).toLowerCase());

		if (midi) {
			midi.dispose();
			midi = null;
		}

		// Only re-init MIDI if it was previously initialized (lazy-init respect)
		// If MIDI was never used, don't init it now
		if (isMIDI || midi) {
			await initMidiPlayer();
		}

		if (isMIDI && currentFile) {
			try {
				// Pass preserveRubberband=true if rubberband was active (HQ toggle preserves rubberband pipeline)
			await playAudio(currentFile, currentTime, !wasPlaying, false, false, wasRubberbandActive);

				await new Promise(resolve => setTimeout(resolve, 100));

				if (g.currentAudio && wasPlaying) {
					g.currentAudio.play();
				}

				checkState();
			} catch (err) {
				console.error('Failed to reload MIDI file after soundfont change:', err);
			}
		}
	});

	ipcRenderer.on('midi-metronome-toggle', (e, enabled) => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.metronome = enabled;
		if (midi && midi.setMetronome) {
			midi.setMetronome(enabled);
		}
	});

	ipcRenderer.on('midi-pitch-changed', (e, val) => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.pitch = val;
		if (midi && midi.setPitchOffset) {
			midi.setPitchOffset(val);
		}
	});

	ipcRenderer.on('midi-speed-changed', (e, val) => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.speed = val;
		if (midi && midi.setPlaybackSpeed) {
			midi.setPlaybackSpeed(val);
		}
	});

	ipcRenderer.on('midi-reset-params', () => {
		if (!g.midiSettings) g.midiSettings = {};
		g.midiSettings.pitch = 0;
		g.midiSettings.speed = null;
		g.midiSettings.metronome = false;

		if (midi) {
			if (midi.setPitchOffset) midi.setPitchOffset(0);
			if (midi.resetPlaybackSpeed) midi.resetPlaybackSpeed();
			else if (midi.setPlaybackSpeed) midi.setPlaybackSpeed(1.0);
			if (midi.setMetronome) midi.setMetronome(false);
		}
	});

	ipcRenderer.on('tracker-reset-params', () => {
		g.trackerParams = { pitch: 1.0, tempo: 1.0, stereoSeparation: 100 };

		if (player && player.setPitch) player.setPitch(1.0);
		if (player && player.setTempo) player.setTempo(1.0);
		if (player && player.setStereoSeparation) player.setStereoSeparation(100);
	});

	ipcRenderer.on('param-change', async (e, data) => {
		if (data.mode === 'midi') {
			if (!g.midiSettings) g.midiSettings = { pitch: 0, speed: null, metronome: false };

			if (data.param === 'transpose') {
				g.midiSettings.pitch = data.value;
				if (midi && midi.setPitchOffset) midi.setPitchOffset(data.value);
			}
			else if (data.param === 'bpm') {
				const orig = (midi && midi.getOriginalBPM) ? midi.getOriginalBPM() : 120;
				const safeOrig = orig > 0 ? orig : 120;
				const ratio = data.value / safeOrig;
				g.midiSettings.speed = ratio;
				if (midi && midi.setPlaybackSpeed) midi.setPlaybackSpeed(ratio);
			}
			else if (data.param === 'metronome') {
				g.midiSettings.metronome = !!data.value;
				if (midi && midi.setMetronome) midi.setMetronome(!!data.value);
			}
			else if (data.param === 'soundfont') {




				if (g.config && g.config.midiSoundfont !== data.value) {
					if (g.config_obj) {
						let c = g.config_obj.get();
						c.midiSoundfont = data.value;
						g.config_obj.set(c);
						g.config = c;
					}
					if (midi && midi.setSoundFont) {
						let fp = g.app_path;
						if (g.isPackaged) { fp = path.dirname(fp); }
						const userDataPath = await helper.app.getPath('userData');
						const userDir = path.join(userDataPath, 'soundfonts');
						const userPath = path.join(userDir, data.value);
						const bundledPath = path.resolve(fp + '/bin/soundfonts/' + data.value);
						let soundfontPath = bundledPath;
						try {
							await fs.access(userPath);
							soundfontPath = userPath;
						} catch (e) {
							// Use bundled path
						}
						const soundfontUrl = 'file:///' + soundfontPath.replace(/\\/g, '/');

						midi.setSoundFont(soundfontUrl);
					}
				} else {

				}
			}
		}
		else if (data.mode === 'audio') {

			if (data.param === 'audioMode') {
				const newMode = data.value; // 'tape' or 'pitchtime'
				const oldMode = g.audioParams.mode;

				g.audioParams.mode = newMode;

				// Apply routing state (centralized pipeline switching)
				await applyRoutingState();
			}
			else if (data.param === 'tapeSpeed') {
				ipcRenderer.send('debug:log', `[Engine] tapeSpeed changed from ${g.audioParams.tapeSpeed} to ${data.value}`);
				g.audioParams.tapeSpeed = data.value;
				applyTapeSpeed(data.value);
			}
			else if (data.param === 'locked') {
				ipcRenderer.send('debug:log', `[Engine] locked changed from ${g.audioParams.locked} to ${!!data.value}`);
				g.audioParams.locked = !!data.value;
			}
			else if (data.param === 'pipeline') {
				switchPipeline(data.value);
			}
			else if (data.param === 'pitch') {
				g.audioParams.pitch = data.value;
				console.log(`[Engine] Pitch change: ${data.value}, activePipeline=${g.activePipeline}, hasPlayer=${!!g.rubberbandPlayer}`);
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer) {
					const ratio = Math.pow(2, data.value / 12.0);
					if (typeof g.rubberbandPlayer.setPitch === 'function') {
						g.rubberbandPlayer.setPitch(ratio);
						console.log('[Engine] Pitch applied to rubberband');
					}
				} else {
					console.warn('[Engine] Pitch NOT applied - pipeline or player not ready');
				}
			}
			else if (data.param === 'tempo') {
				g.audioParams.tempo = data.value;
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer) {
					if (typeof g.rubberbandPlayer.setTempo === 'function') {
						g.rubberbandPlayer.setTempo(data.value);
					}
				}
			}
			else if (data.param === 'formant') {
				g.audioParams.formant = !!data.value;
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer) {
					// Options changes: use fade + stabilization pattern
					// (rubberband internally recreates kernel, which needs settling time)
					if (g.rubberbandPlayer.isPlaying && typeof g.rubberbandPlayer.fadeOut === 'function') {
						try {
							await g.rubberbandPlayer.fadeOut();
							
							// Re-check after async - player may have been destroyed
							if (!g.rubberbandPlayer) return;

							if (typeof g.rubberbandPlayer.setOptions === 'function') {
								g.rubberbandPlayer.setOptions({ formantPreserved: !!data.value });
							}

							// 300ms stabilization for kernel recreation
							await new Promise(resolve => setTimeout(resolve, 300));
							
							// Re-check after async - player may have been destroyed
							if (!g.rubberbandPlayer) return;

							await g.rubberbandPlayer.fadeIn();
						} catch (err) {
							console.error('[Stage] Error during formant change:', err);
						}
					} else {
						// Not playing - just apply option directly
						if (typeof g.rubberbandPlayer.setOptions === 'function') {
							g.rubberbandPlayer.setOptions({ formantPreserved: !!data.value });
						}
					}
				}
			}
		}
		else if (data.mode === 'tracker') {
			if (!g.trackerParams) g.trackerParams = { pitch: 1.0, tempo: 1.0, stereoSeparation: 100 };

			if (data.param === 'pitch') {
				g.trackerParams.pitch = data.value;
				// Convert semitones (-12 to +12) to multiplicative factor
				if (player && player.setPitch) player.setPitch(Math.pow(2, data.value / 12.0));
			}
			else if (data.param === 'tempo') {
				g.trackerParams.tempo = data.value;
				if (player && player.setTempo) player.setTempo(data.value);
			}
			else if (data.param === 'stereoSeparation') {
				g.trackerParams.stereoSeparation = data.value;
				if (player && player.setStereoSeparation) player.setStereoSeparation(data.value);
			}
			else if (data.param === 'channelMute') {
				if (player && player.setChannelMute) player.setChannelMute(data.value.channel, data.value.mute);
			}
		}
	});

	ipcRenderer.on('get-available-soundfonts', async (e, data) => {
		let fp = g.app_path;
		if (g.isPackaged) { fp = path.dirname(fp); }
		const bundledDir = path.resolve(fp + '/bin/soundfonts/');
		const userDataPath = await helper.app.getPath('userData');
		const userDir = path.join(userDataPath, 'soundfonts');

		const availableFonts = [];

		// Scan bundled soundfonts
		try {
			const files = await fs.readdir(bundledDir);
			const soundfontFiles = files.filter(f => f.endsWith('.sf2') || f.endsWith('.sf3'));
			for (const filename of soundfontFiles) {
				let label = filename.replace(/\.(sf2|sf3)$/i, '');
				label = label.replace(/_/g, ' ');
				availableFonts.push({ filename, label, location: 'bundled' });
			}
		} catch (err) {
			console.error('[MIDI] Failed to read bundled soundfonts directory:', err);
		}

		// Scan user soundfonts (AppData)
		try {
			await fs.mkdir(userDir, { recursive: true });
			const files = await fs.readdir(userDir);
			const soundfontFiles = files.filter(f => f.endsWith('.sf2') || f.endsWith('.sf3'));
			for (const filename of soundfontFiles) {
				// Skip if already in bundled list
				if (availableFonts.some(f => f.filename === filename)) continue;
				let label = filename.replace(/\.(sf2|sf3)$/i, '');
				label = label.replace(/_/g, ' ');
				availableFonts.push({ filename, label, location: 'user' });
			}
		} catch (err) {
			console.error('[MIDI] Failed to read user soundfonts directory:', err);
		}

		// Sort: TimGM first, then alphabetically
		availableFonts.sort((a, b) => {
			if (a.filename.startsWith('TimGM')) return -1;
			if (b.filename.startsWith('TimGM')) return 1;
			return a.label.localeCompare(b.label);
		});

		// Fallback if no fonts found
		if (availableFonts.length === 0) {
			availableFonts.push({ filename: 'default.sf2', label: 'Default', location: 'bundled' });
		}

		const targetWindow = data.windowId || g.windows.parameters || g.windows['midi'];
		tools.sendToId(targetWindow, 'available-soundfonts', { fonts: availableFonts });
	});

	ipcRenderer.on('theme-changed', (e, data) => {
		if (g.windows.settings) {
			sendToWindow(g.windows.settings, 'theme-changed', data);
		}
		if (g.windows.help) {
			sendToWindow(g.windows.help, 'theme-changed', data);
		}
		if (g.windows.playlist) {
			sendToWindow(g.windows.playlist, 'theme-changed', data);
		}
		if (g.windows.mixer) {
			sendToWindow(g.windows.mixer, 'theme-changed', data);
		}
		if (g.windows.pitchtime) {
			sendToWindow(g.windows.pitchtime, 'theme-changed', data);
		}
		if (g.windows['midi']) {
			tools.sendToId(g.windows['midi'], 'theme-changed', data);
		}
	});

	ipcRenderer.on('toggle-theme', (e, data) => {
		tools.sendToMain('command', { command: 'toggle-theme' });
	});

	ipcRenderer.on('mixer-state', (e, data) => {
		g.mixerPlaying = !!(data && data.playing);
	});

	ipcRenderer.on('monitoring-ready', async (e, data) => {

		// Store window ID and mark as ready
		if (data.windowId) {
			g.windows.monitoring = data.windowId;
		}
		g.monitoringReady = true;
		g.windowsVisible.monitoring = true;
		
		// Start the monitoring update loop (only when visible)
		startMonitoringLoop();
		
		// Apply routing state to activate monitoring resources
		await applyRoutingState();
		
		const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : null;
		if (currentFile && g.windows.monitoring) {
			// Send file-change so monitoring can parse MIDI timeline if applicable
			const ext = path.extname(currentFile).toLowerCase();
			const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
			const isTracker = g.supportedMpt && g.supportedMpt.includes(ext);
			try {
				sendToWindow(g.windows.monitoring, 'file-change', {
					filePath: currentFile,
					fileUrl: tools.getFileURL(currentFile),
					fileType: isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg',
					isMIDI: isMIDI,
					isTracker: isTracker
				}, 'monitoring');
			} catch (err) {
				console.warn('[Monitoring] Failed to send file-change on ready:', err && err.message);
			}
			// Send initial waveform for non-MIDI files

			extractAndSendWaveform(currentFile);
		}
	});

	ipcRenderer.on('waveform-chunk', (e, chunk) => {
		if (!g.windows.monitoring) return;
		try {
			sendToWindow(g.windows.monitoring, 'waveform-chunk', {
				...chunk,
				filePath: g.currentAudio ? path.basename(g.currentAudio.fp) : ''
			}, 'monitoring');
		} catch (err) {
			console.warn('[Monitoring] Failed to send waveform chunk (window may be closing):', err.message);
		}
	});

	// Forward analysis data and source-selection commands from other windows (e.g. Mixer)
	ipcRenderer.on('ana-data', (e, data) => {
		if (!g.windows.monitoring) return;
		try {

			sendToWindow(g.windows.monitoring, 'ana-data', data, 'monitoring');
		} catch (err) {
			console.warn('[Stage] failed to forward ana-data', err && err.message);
		}
	});

	ipcRenderer.on('set-monitoring-source', (e, src) => {
		if (!g.windows.monitoring) {
			console.warn('[Stage] set-monitoring-source received but monitoring window not open');
			return;
		}
		try {

			sendToWindow(g.windows.monitoring, 'set-monitoring-source', src, 'monitoring');
		} catch (err) {
			console.warn('[Stage] failed to forward set-monitoring-source', err && err.message);
		}
	});

    // Handle announce-monitoring-focus from other windows (e.g. Mixer)
    ipcRenderer.on('announce-monitoring-focus', (e, src) => {
        // Only track non-monitoring sources
        if (!src) return;
        g.lastFocusedSource = src;

        if (g.windows.monitoring) {
            try { sendToWindow(g.windows.monitoring, 'set-monitoring-source', g.lastFocusedSource, 'monitoring'); } catch (err) {}
        }
    });

	ipcRenderer.on('player-seek', (e, data) => {
		if (data && typeof data.time === 'number') {

			seekTo(data.time);
		}
	});

}

async function engineReady() {

	
	g.blocky = false;

	// File format support
	g.supportedMpt = ['.mptm', '.mod', '.mo3', '.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf',
		'.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus',
		'.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod',
		'.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];
	g.supportedMIDI = ['.mid', '.midi', '.kar', '.rmi'];
	g.supportedChrome = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.m4b', '.aac', '.webm'];
	g.supportedFFmpeg = ['.mpg', '.mp2', '.aif', '.aiff', '.aa', '.wma', '.asf', '.ape', '.wv', '.wvc', '.tta', '.mka',
		'.amr', '.3ga', '.ac3', '.eac3', '.dts', '.dtshd', '.caf', '.au', '.snd', '.voc', '.tak', '.mpc', '.mp+'];

	g.supportedFilter = [...g.supportedChrome, ...g.supportedFFmpeg, ...g.supportedMpt, ...g.supportedMIDI];

	function canFFmpegPlayFile(filePath) {

		const decoder = new g.FFmpegDecoder();
		try {
			if (decoder.open(filePath)) {
				const duration = decoder.getDuration();
				decoder.close();

				return duration > 0;
			}
			decoder.close();

			return false;
		} catch (e) {
			try { decoder.close(); } catch (e2) { }

			return false;
		}
	}
	g.canFFmpegPlayFile = canFFmpegPlayFile;

	g.music = [];
	g.idx = 0;
	g.isLoop = false;

	if (!g.config.audio) g.config.audio = {};
	
	// Notify main process that engine is ready
	ipcRenderer.send('engine:ready');
}

function _clamp01(v) {
	v = +v;
	if (!(v >= 0)) return 0;
	if (v > 1) return 1;
	return v;
}

function setVolume(v, persist = false) {
	v = _clamp01(v);
	if (!g.config.audio) g.config.audio = {};
	g.config.audio.volume = v;
	if (player) {
		try { player.gain.gain.value = v; } catch (e) { }
	}
	if (midi) {
		try { midi.setVol(v); } catch (e) { }
	}
	if (g.currentAudio?.isFFmpeg && g.currentAudio.player) {
		g.currentAudio.player.volume = v;
	}
	if (persist && g.config_obj) g.config_obj.set(g.config);
}

function playListFromSingle(fp, rec = true) {
	return new Promise(async (resolve, reject) => {
		let pl = [];
		let idx = 0;
		let stat = await fs.lstat(path.normalize(fp));
		if (stat.isDirectory()) {
			if (rec) {
				pl = await tools.getFilesRecursive(fp, g.supportedFilter);
			}
			else {
				pl = await tools.getFiles(fp, g.supportedFilter);
			}
		}
		else {
			if (tools.checkFileType(fp, g.supportedFilter)) {
				let info = path.parse(fp);
				pl = await tools.getFiles(info.dir, g.supportedFilter);
				idx = pl.findIndex(item => item == path.join(info.dir, info.base));
				if (idx == -1) { idx = 0 };
			}
			else {

			}
		}
		if (pl.length > 0) {
			g.music = pl;
			g.max = g.music.length - 1;
			g.idx = idx;
		}
		resolve();
	})
}

function playListFromMulti(ar, add = false, rec = false) {
	return new Promise(async (resolve, reject) => {
		let pl = [];
		for (let i = 0; i < ar.length; i++) {
			let fp = ar[i];
			let stat = await fs.lstat(path.normalize(fp));
			if (stat.isDirectory()) {
				let folder_files = [];
				if (rec) {
					folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
				}
				else {
					folder_files = await tools.getFiles(fp, g.supportedFilter);
				}
				pl = pl.concat(folder_files);
			}
			else {
				if (tools.checkFileType(fp, g.supportedFilter) || g.canFFmpegPlayFile(fp)) {
					pl.push(fp);
				}
				else {

				}
			}
		}
		if (pl.length > 0) {
			if (add && g.music.length > 0) {
				g.music = g.music.concat(pl);
				g.max = g.music.length - 1;
			}
			else {
				g.idx = 0;
				g.music = pl;
				g.max = g.music.length - 1;
			}
		}
		resolve(pl);
	})
}

async function playAudio(fp, n, startPaused = false, autoAdvance = false, restore = false, preserveRubberband = false) {
	if (!g.blocky) {
		if (fp && g.music && g.music.length > 0) {
			const idx = g.music.indexOf(fp);

			if (idx >= 0 && g.idx !== idx) {

				g.idx = idx;
				try { renderTopInfo(); } catch (e) { }
				if (g.info_win) {
					tools.sendToId(g.info_win, 'info', { list: g.music, idx: g.idx });
				}
			}
		}
		let parse = path.parse(fp);
		let bench = performance.now();

		if (!autoAdvance && g.currentAudio && !g.currentAudio.paused) {
			if (g.currentAudio.isFFmpeg && g.currentAudio.player && typeof g.currentAudio.player.fadeOut === 'function' && g.activePipeline !== 'rubberband') {
				await g.currentAudio.player.fadeOut();
			}
		}

		g.blocky = true;
		
		// --- DETERMINE DESIRED PIPELINE BEFORE clearAudio() RESETS IT ---
		// Store what pipeline we want for this file BEFORE clearing state
		// This is crucial for locked mode: we need to know if rubberband is needed
		const ext = parse.ext.toLocaleLowerCase();
		const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
		const isTracker = g.supportedMpt.includes(ext);
		const isFFmpeg = !isMIDI && !isTracker;
		
		// Calculate desired pipeline based on current params (before clearAudio resets activePipeline)
		let desiredPipeline = 'normal';
		if (isFFmpeg) {
			// If preserveRubberband is true, force rubberband pipeline regardless of g.audioParams
			// This handles HQ toggle case where we want to preserve the existing pipeline
			if (preserveRubberband) {
				desiredPipeline = 'rubberband';
			} else if (g.audioParams.locked && g.audioParams.mode === 'pitchtime') {
				desiredPipeline = 'rubberband';
			} else if (g.parametersOpen && g.audioParams.mode === 'pitchtime') {
				desiredPipeline = 'rubberband';
			}
		}

		

			// Skip rubberband dispose if we're preserving it (same file, rubberband active)
			// OR if explicitly requested (e.g., HQ toggle with rubberband active)
			// Explicitly convert to boolean to ensure proper conditional behavior
			const skipRubberbandDispose = Boolean(preserveRubberband) || (g.rubberbandPlayer &&
				g.activePipeline === 'rubberband' &&
				desiredPipeline === 'rubberband' &&
				g.currentAudio?.fp === fp);
			clearAudio(skipRubberbandDispose);
		
		// Restore the desired pipeline so we init with correct one
		if (isFFmpeg && desiredPipeline === 'rubberband') {
			g.activePipeline = 'rubberband';

		}

		if (player) { player.stop(); }
		if (midi) { midi.stop(); }



		// Notify monitoring window of file change (include file URL for renderer fetch)
		if (g.windows.monitoring) {
			try {
				sendToWindow(g.windows.monitoring, 'file-change', {
					filePath: fp,
					fileUrl: tools.getFileURL(fp),
					fileType: isMIDI ? 'MIDI' : isTracker ? 'Tracker' : 'FFmpeg',
					isMIDI: isMIDI,
					isTracker: isTracker
				}, 'monitoring');
			} catch (err) {
				console.warn('[Stage] Failed to notify monitoring window of file change:', err && err.message);
			}
		}

		if (isMIDI) {
			// Lazy-init MIDI on first use
			if (!midi) {
				await initMidiPlayer();
				if (!midi) {
					console.error('[Engine] MIDI init error:', g.midiInitError || 'MIDI playback not initialized.');
					g.blocky = false;
					return false;
				}
			}
			const targetVol = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			const initialVol = startPaused ? 0 : targetVol;
			g.currentAudio = {
				isMidi: true,
				fp: fp,
				bench: bench,
				currentTime: 0,
				get paused() { return midi ? midi.paused : true; },
				duration: 0,
				play: () => {
					try { midi.setVol((g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : targetVol); } catch (e) { }
					midi.play();
				},
				pause: () => { midi.pause(); },
				seek: (time) => midi.seek(time),
				getCurrentTime: () => midi.getCurrentTime()
			};
			try {
				await midi.load(tools.getFileURL(fp));

				// Reconnect monitoring taps for new MIDI player
				await updateMonitoringConnections();

				if (!g.currentAudio.duration && midi.getDuration() > 0) {
					g.currentAudio.duration = midi.getDuration();
				}

				midi.setVol(initialVol);
				midi.setLoop(g.isLoop);
				if (n > 0) {
					midi.seek(n);
					g.currentAudio.currentTime = n;
				}
				if (startPaused) {
					try { midi.setVol(0); } catch (e) { }
					midi.pause();
				} else {
					midi.play();
					startPositionPush();
					ipcRenderer.send('audio:state', { isPlaying: true });
				}

				await renderInfo(fp, g.currentAudio.metadata);
				g.blocky = false;
				checkState();


			} catch (err) {
				console.error('MIDI playback error:', err);
				console.error('[Engine] Error loading MIDI file!');
				g.blocky = false;
				return false;
			}
		}
		else if (isTracker) {
			// Lazy initialize tracker player if needed
			const trackerPlayer = await getTrackerPlayer();
			if (!trackerPlayer) {
				console.error('[Engine] Tracker player not available');
				g.blocky = false;
				return false;
			}

			const targetVol = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			const initialVol = startPaused ? 0 : targetVol;
			g.currentAudio = {
				isMod: true,
				fp: fp,
				bench: bench,
				currentTime: 0,
				paused: startPaused,
				duration: 0,
				play: () => {
					g.currentAudio.paused = false;
					try { trackerPlayer.gain.gain.value = (g && g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : targetVol; } catch (e) { }
					trackerPlayer.unpause();
					startPositionPush();
					ipcRenderer.send('audio:state', { isPlaying: true });
				},
				pause: () => { g.currentAudio.paused = true; trackerPlayer.pause() },
				getCurrentTime: () => trackerPlayer.getCurrentTime(),
				seek: (n) => trackerPlayer.seek(n)
			};
			if (g.windows.monitoring) {
				extractAndSendWaveform(fp);
			}
			// Load the file (tracker is now initialized and gain is connected)
			
			// Small delay to ensure chiptune internal init is complete
			setTimeout(() => {
				trackerPlayer.load(tools.getFileURL(fp));
				trackerPlayer.gain.gain.value = initialVol;
				
				// Ensure playback starts (chiptune should auto-play, but verify)
				if (!startPaused && trackerPlayer.unpause) {
					trackerPlayer.unpause();
				}
			}, 100);

			// Reconnect monitoring taps for new tracker player
			await updateMonitoringConnections();

			// Reset tracker params on new file (no lock feature for tracker)
			// Skip reset during restore to preserve saved parameters
			if (!restore) {
				g.trackerParams = { pitch: 1.0, tempo: 1.0, stereoSeparation: 100 };
			}

			// Apply tape speed if locked and in tape mode (overrides tracker params)
			const locked = g.audioParams && g.audioParams.locked;
			if (locked && g.audioParams.mode === 'tape' && g.audioParams.tapeSpeed !== 0) {
				const tempoFactor = Math.pow(2, g.audioParams.tapeSpeed / 12.0);
				trackerPlayer.setTempo(tempoFactor);
			}

			if (n > 0) {
				const seekTime = n;
				const seekFp = fp;
				let attempts = 0;
				const doSeek = () => {
					if (!g.currentAudio || !g.currentAudio.isMod || g.currentAudio.fp !== seekFp) return;
					if (!trackerPlayer || typeof trackerPlayer.seek !== 'function') return;
					if (trackerPlayer.duration && trackerPlayer.duration > 0) {
						trackerPlayer.seek(seekTime);
						g.currentAudio.currentTime = seekTime;
						return;
					}
					attempts++;
					if (attempts < 60) {
						setTimeout(doSeek, 25);
					}
				};
				setTimeout(doSeek, 25);
			}
			if (startPaused) {
				try { trackerPlayer.gain.gain.value = 0; } catch (e) { }
				try { trackerPlayer.pause(); } catch (e) { }
				setTimeout(() => {
					try {
						if (g.currentAudio && g.currentAudio.isMod && g.currentAudio.fp === fp && g.currentAudio.paused) {
							try { trackerPlayer.gain.gain.value = 0; } catch (e) { }
							trackerPlayer.pause();
						}
					} catch (e) { }
				}, 30);
				setTimeout(() => {
					try {
						if (g.currentAudio && g.currentAudio.isMod && g.currentAudio.fp === fp && g.currentAudio.paused) {
							try { trackerPlayer.gain.gain.value = 0; } catch (e) { }
							trackerPlayer.pause();
						}
					} catch (e) { }
				}, 250);
			} else {
				// Tracker auto-plays on load, start position push
				startPositionPush();
				ipcRenderer.send('audio:state', { isPlaying: true });
			}
			checkState();
		}
		else {

			try {
				// Note: applyRoutingState is called after g.currentAudio is set so calculateDesiredPipeline() works correctly
				
				// --- ENSURE RUBBERBAND IS INITIALIZED IF NEEDED ---
				// If we're supposed to use rubberband but it's not ready, initialize it now
				if (g.activePipeline === 'rubberband' && !g.rubberbandPlayer) {
					console.log('[playAudio] Rubberband not initialized, creating pipeline...');
					const rbReady = await ensureRubberbandPipeline();
					if (!rbReady) {
						console.error('[playAudio] Failed to initialize rubberband pipeline. Falling back to normal.');
						g.activePipeline = 'normal';
					}
				}
				
				// Ensure rubberband worklet is valid (recreate if disposed)
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer && !g.rubberbandPlayer.rubberbandNode) {
					console.log('[playAudio] Rubberband worklet disposed, will be recreated by open()');
				}
				
				const ffPlayer = (g.activePipeline === 'rubberband' && g.rubberbandPlayer) ? g.rubberbandPlayer : g.ffmpegPlayer;
				console.log(`[playAudio] Selected player: ${ffPlayer === g.rubberbandPlayer ? 'rubberband' : 'ffmpeg'}, activePipeline=${g.activePipeline}`);

				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer && !g.rubberbandPlayer.isConnected) {
					console.log('[playAudio] Reconnecting rubberband player to destination');
					g.rubberbandPlayer.connect(); // destination
					if (g.monitoringSplitter_RB) {
						g.rubberbandPlayer.connect(g.monitoringSplitter_RB);
					}
				}

				ffPlayer.onEnded(audioEnded);


				const metadata = await ffPlayer.open(fp);
				
				// Re-apply audio params after open() - reset() may have cleared them
				if (g.activePipeline === 'rubberband' && g.rubberbandPlayer) {
					const pitchRatio = Math.pow(2, (g.audioParams.pitch || 0) / 12.0);
					g.rubberbandPlayer.setPitch(pitchRatio);
					g.rubberbandPlayer.setTempo(g.audioParams.tempo || 1.0);
					g.rubberbandPlayer.setOptions({ formantPreserved: !!g.audioParams.formant });
				}

				ffPlayer.setLoop(g.isLoop);

				g.currentAudio = {
					isFFmpeg: true,
					pipeline: g.activePipeline,
					fp: fp,
					bench: bench,
					currentTime: 0,
					paused: startPaused,
					duration: metadata.duration,
					player: ffPlayer,
					volume: (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5,
					play: () => { g.currentAudio.paused = false; ffPlayer.play(); },
					pause: () => { g.currentAudio.paused = true; ffPlayer.pause(); },
					seek: (time) => ffPlayer.seek(time),
					getCurrentTime: () => ffPlayer.getCurrentTime()
				};

				// Now apply routing state (locked settings may require pipeline switch)
				// Pass shouldPlay to ensure correct playback state after pipeline switch
				await applyRoutingState(!startPaused);
				
				// Reconnect monitoring taps for new player (after g.currentAudio is set and pipeline is finalized)
				await updateMonitoringConnections();

				if (g.windows.monitoring) {
					extractAndSendWaveform(fp);
				}

				// Use g.currentAudio.player which may have been updated by applyRoutingState/switchPipeline
				const activePlayer = g.currentAudio.player;
				activePlayer.volume = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;

				// Seek to position if resuming from a specific time
				if (n > 0) {

					activePlayer.seek(n);
					g.currentAudio.currentTime = n;
				}

				// Apply locked settings based on mode
				// During restore, always apply (params were pre-set by app.js cmd:setParams)
				const locked = g.audioParams && g.audioParams.locked;
				if (locked || restore) {
					if (g.audioParams.mode === 'tape' && g.audioParams.tapeSpeed !== 0) {
						// Tape mode: apply playback rate
						activePlayer.setPlaybackRate(g.audioParams.tapeSpeed);
					} else if (g.audioParams.mode === 'pitchtime' && g.activePipeline === 'rubberband') {
						// Pitch/Time mode: apply rubberband parameters
						if (typeof activePlayer.setPitch === 'function') {
							const pitchRatio = Math.pow(2, (g.audioParams.pitch || 0) / 12.0);
							activePlayer.setPitch(pitchRatio);
						}
						if (typeof activePlayer.setTempo === 'function') {
							activePlayer.setTempo(g.audioParams.tempo || 1.0);
						}
						if (typeof activePlayer.setOptions === 'function') {
							activePlayer.setOptions({ formantPreserved: !!g.audioParams.formant });
						}
					}
				}

				if (!startPaused && !activePlayer.isPlaying) {

					await activePlayer.play();

					startPositionPush();
					ipcRenderer.send('audio:state', { isPlaying: true });
				}
				else if (startPaused) {

					if (typeof activePlayer.pause === 'function') await activePlayer.pause();
				}

				checkState();
				await renderInfo(fp, metadata);
				g.blocky = false;

				// After file load: update params window UI in normal mode (skip during restore)
				// During restore, settings are already applied (see block above) and UI is updated by app.js
				// Also skip if preserveRubberband is true (e.g., HQ toggle) to preserve the pipeline
				if (!restore && !preserveRubberband && g.windows.parameters) {
					// Normal (non-restore) flow: If locked, preserve all settings; otherwise reset to defaults
					const locked = g.audioParams && g.audioParams.locked;
					const params = locked ? {
						audioMode: g.audioParams.mode,
						tapeSpeed: g.audioParams.tapeSpeed,
						pitch: g.audioParams.pitch,
						tempo: g.audioParams.tempo,
						formant: g.audioParams.formant,
						locked: true,
						reset: false
					} : {
						audioMode: 'tape',
						tapeSpeed: 0,
						pitch: 0,
						tempo: 1.0,
						formant: false,
						locked: false,
						reset: true
					};

					// If not locked, also reset to tape mode and normal pipeline
					if (!locked) {
						g.audioParams.mode = 'tape';
						g.audioParams.tapeSpeed = 0;
						g.audioParams.pitch = 0;
						g.audioParams.tempo = 1.0;
						if (g.activePipeline === 'rubberband') {
							await switchPipeline('normal');
						}
						// Explicitly reset tape speed to 0 on the player
						applyTapeSpeed(0);
					} else {
						// If locked, apply the appropriate settings for the current mode
						if (g.audioParams.mode === 'tape') {
							// Tape mode: apply tape speed
							if (g.audioParams.tapeSpeed !== 0) {
								applyTapeSpeed(g.audioParams.tapeSpeed);
							}
						} else if (g.audioParams.mode === 'pitchtime') {
							// Pitchtime mode: switch to rubberband and apply pitch/tempo
							if (g.activePipeline !== 'rubberband') {
								await switchPipeline('rubberband');
							} else {
								// Already on rubberband, just apply the settings
								if (g.rubberbandPlayer) {
									if (typeof g.rubberbandPlayer.setPitch === 'function') {
										const pitchRatio = Math.pow(2, (g.audioParams.pitch || 0) / 12.0);
										g.rubberbandPlayer.setPitch(pitchRatio);
									}
									if (typeof g.rubberbandPlayer.setTempo === 'function') {
										g.rubberbandPlayer.setTempo(g.audioParams.tempo || 1.0);
									}
								}
							}
						}
					}
				}
			}
			catch (err) {
				console.error('FFmpeg playback error:', err);
				console.error('[Engine] Error loading file!');
				g.blocky = false;
				return false;
			}
		}
	}
	if (g.info_win) {
		tools.sendToId(g.info_win, 'info', { list: g.music, idx: g.idx });
	}
}

function collectMetadata(fp, metadata) {
	// Collect metadata for sending to UI (app.js will forward to player.js)
	g.currentInfo = { duration: g.currentAudio.duration };
	let parse = path.parse(fp);
	
	const result = {
		file: parse.base,
		folder: path.basename(parse.dir),
		ext: parse.ext.substring(1).toLowerCase(),
		duration: g.currentAudio.duration
	};
	
	if (g.currentAudio.isMod) {
		g.currentInfo.metadata = metadata;
		result.type = 'tracker';
		result.format = metadata.tracker;
		result.artist = metadata.artist;
		result.title = metadata.title;
		result.date = metadata.date;
	}
	else if (g.currentAudio.isMidi) {
		const md = metadata || g.currentAudio.metadata || {};
		g.currentInfo.metadata = md;
		if (md.duration && md.duration > 0) {
			g.currentAudio.duration = md.duration;
			result.duration = md.duration;
		}
		result.type = 'midi';
		result.title = md.title;
		result.copyright = md.copyright;
		result.timeSignature = md.timeSignature;
		result.originalBPM = md.originalBPM;
		result.keySignature = md.keySignature;
		result.ppq = md.ppq;
		// Convert Set to array for IPC serialization, or use channel count
		result.channels = md.channels ? (md.channels.size || (Array.isArray(md.channels) ? md.channels.length : 0)) : 0;
		result.markers = md.markers;
		result.text = md.text;
	}
	else {
		// For FFmpeg files, use metadata from ffPlayer.open() + g.getMetadata() for tags
		let metaFromOpen = metadata || {};
		let metaFromFile = g.getMetadata ? g.getMetadata(fp) : {};
		g.currentInfo.file = metaFromFile;
		result.type = 'ffmpeg';
		// Combine metadata from both sources for comprehensive info
		result.codec = metaFromFile.codec || metaFromOpen.codec || '';
		result.codecLongName = metaFromFile.codecLongName || metaFromOpen.codecLongName || '';
		result.format = metaFromFile.format || metaFromOpen.format || '';
		result.formatLongName = metaFromFile.formatLongName || metaFromOpen.formatLongName || '';
		result.bitrate = metaFromFile.bitrate || metaFromOpen.bitrate;
		result.channels = metaFromOpen.channels || metaFromFile.channels;
		result.sampleRate = metaFromOpen.sampleRate || metaFromFile.sampleRate;
		result.bitsPerSample = metaFromFile.bitsPerSample || metaFromOpen.bitsPerSample;
		result.artist = metaFromFile.artist || metaFromOpen.artist;
		result.album = metaFromFile.album || metaFromOpen.album;
		result.title = metaFromFile.title || metaFromOpen.title;
		result.coverArt = metaFromFile.coverArt;
		result.coverArtMimeType = metaFromFile.coverArtMimeType;
	}
	
	return result;
}

async function switchPipeline(newMode, shouldPlay = null) {
	if (g.activePipeline === newMode) return;
	if (!g.currentAudio || !g.currentAudio.isFFmpeg) return;



	// Determine if we should continue playing after the switch
	// If shouldPlay is explicitly provided (not null), use that value
	// Otherwise detect from current player state
	let wasPlaying;
	if (shouldPlay !== null) {
		wasPlaying = shouldPlay;
	} else {
		wasPlaying = g.currentAudio.player ? g.currentAudio.player.isPlaying : false;
	}
	const currentTime = g.currentAudio.getCurrentTime ? g.currentAudio.getCurrentTime() : 0;

	if (g.currentAudio.player) {
		try { await g.currentAudio.player.stop(true); } catch (e) { }
	}

	g.activePipeline = newMode;
	const newPlayer = (newMode === 'rubberband') ? g.rubberbandPlayer : g.ffmpegPlayer;

	if (newPlayer) {
		try {
			await newPlayer.open(g.currentAudio.fp);

			g.currentAudio.player = newPlayer;

			g.currentAudio.play = () => { g.currentAudio.paused = false; newPlayer.play(); };
			g.currentAudio.pause = () => { g.currentAudio.paused = true; newPlayer.pause(); };
			g.currentAudio.seek = (t) => newPlayer.seek(t);
			g.currentAudio.getCurrentTime = () => newPlayer.getCurrentTime();

			const vol = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? +g.config.audio.volume : 0.5;
			newPlayer.volume = vol;
			newPlayer.setLoop(g.isLoop);
			
			// Set up onEnded callback for track progression
			if (typeof newPlayer.onEnded === 'function') {
				newPlayer.onEnded(audioEnded);
			}

			// Apply stored audio params when switching to rubberband
			if (newMode === 'rubberband' && g.audioParams) {
				// Connect rubberband to both audio destination and monitoring tap (T-junction)
				if (typeof newPlayer.connect === 'function') {
					newPlayer.connect(); // Connects to destination by default
					if (g.monitoringSplitter_RB) {
						newPlayer.connect(g.monitoringSplitter_RB);

					} else {

					}
				}
				if (typeof newPlayer.setPitch === 'function') {
					const pitchRatio = Math.pow(2, (g.audioParams.pitch || 0) / 12.0);
					newPlayer.setPitch(pitchRatio);

				}
				if (typeof newPlayer.setTempo === 'function') {
					newPlayer.setTempo(g.audioParams.tempo || 1.0);

				}
				if (typeof newPlayer.setOptions === 'function') {
					newPlayer.setOptions({ formantPreserved: !!g.audioParams.formant });
				}
			}

			// Apply tape speed when switching to normal
			if (newMode === 'normal') {
				// Disconnect rubberband when switching away from it
				if (g.rubberbandPlayer && typeof g.rubberbandPlayer.disconnect === 'function') {
					g.rubberbandPlayer.disconnect();

				}
				if (g.audioParams && g.audioParams.tapeSpeed !== undefined) {
					applyTapeSpeed(g.audioParams.tapeSpeed);

				}
			}

			if (currentTime > 0) newPlayer.seek(currentTime);
			
			// Resume playback if it was playing
			if (wasPlaying) {
				g.currentAudio.paused = false;
				await newPlayer.play();
			} else {
				g.currentAudio.paused = true;
			}
			checkState();
		} catch (err) {
			console.error('Pipeline switch failed:', err);
		}
	}
}

function clearAudio(skipRubberbandDispose = false) {
	console.log('[clearAudio] called, rubberbandPlayer:', !!g.rubberbandPlayer, 'activePipeline:', g.activePipeline, 'skipRubberbandDispose:', skipRubberbandDispose);

	if (g.ffmpegPlayer) {
		if (typeof g.ffmpegPlayer.clearBuffer === 'function') g.ffmpegPlayer.clearBuffer();
		g.ffmpegPlayer.stop(true);

	}
	if (g.rubberbandPlayer) {
		console.log('[clearAudio] Cleaning up rubberband...');
		
		// Skip full cleanup if we're preserving rubberband (e.g., HQ toggle with rubberband active)
		// In this case, we only want to clear buffers, not disconnect/destroy the pipeline
		if (!skipRubberbandDispose) {
			g.rubberbandPlayer.disconnect();
		}

		// Dispose worklet to flush internal buffers and prevent audio bleed
		// Skip if we're preserving rubberband (e.g., HQ toggle with rubberband active)
		if (!skipRubberbandDispose && typeof g.rubberbandPlayer.disposeWorklet === 'function') {
			g.rubberbandPlayer.disposeWorklet().catch(e => {
				console.error('[clearAudio] Failed to dispose rubberband worklet:', e);
			});
		}

		if (!skipRubberbandDispose) {
			g.rubberbandPlayer.reset();
			if (g.rubberbandPlayer.player && typeof g.rubberbandPlayer.player.clearBuffer === 'function') {
				g.rubberbandPlayer.player.clearBuffer();
			}
			g.rubberbandPlayer.stop(true); // Use retain=true to preserve internal player resources
		}

		// Only reset activePipeline if we're not preserving rubberband
		if (!skipRubberbandDispose) {
			g.activePipeline = 'normal';
		}
	}
	if (g.currentAudio) {
		if (g.currentAudio.isMod) player.stop();
		if (g.currentAudio.isMidi && midi) midi.stop();

		g.currentAudio = undefined;
	}
}

function audioEnded(e) {
	// Notify app.js that track ended - app.js is the source of truth for playlist advancement
	// app.js will send cmd:load for the next track
	// audioEnded
	ipcRenderer.send('audio:ended');
}

function updatePlaybackState() {
	// Send playback state to app.js instead of updating UI directly
	if (g.currentAudio) {
		ipcRenderer.send('audio:state', {
			isPlaying: !g.currentAudio.paused,
			isLoop: g.isLoop,
			position: g.currentAudio.currentTime || 0,
			duration: g.currentAudio.duration || 0
		});
	}
}

// Stub for UI function removed in engine
function checkState() {
    // No-op: UI state is handled by player.js
}

// Stub for UI function - engine collects metadata and sends via IPC
async function renderInfo(fp, metadata) {
    // Collect metadata for sending to UI
    if (g.currentAudio) {
        const meta = collectMetadata(fp, metadata);
        // Send in format expected by app.js: { duration, metadata }
        ipcRenderer.send('audio:metadata', { 
            duration: meta.duration, 
            metadata: meta,
            fileType: meta.type 
        });
    }
}

function flashButton(btn) {
	if (!btn) return;
	btn.classList.add('flash');
	setTimeout(() => { btn.classList.remove('flash'); }, 50);
}

function shufflePlaylist() {
	ut.shuffleArray(g.music);
	g.idx = 0;
	playAudio(g.music[g.idx]);
}

function playNext(e, autoAdvance = false) {
	if (!g.blocky) {
		if (!g.music || g.music.length === 0) {
			console.warn('[playNext] Playlist not loaded, ignoring');
			return;
		}
		if (g.idx == g.max) { g.idx = -1; }
		g.idx++;
		const nextFile = g.music[g.idx];
		if (!nextFile) {
			console.warn('[playNext] No file at index', g.idx, 'max:', g.max);
			return;
		}
		playAudio(nextFile, 0, false, autoAdvance)
	}
}

function playPrev(e) {
	if (!g.blocky) {
		if (!g.music || g.music.length === 0) {
			console.warn('[playPrev] Playlist not loaded, ignoring');
			return;
		}
		if (g.idx == 0) { g.idx = g.max + 1; }
		g.idx--;
		const prevFile = g.music[g.idx];
		if (!prevFile) {
			console.warn('[playPrev] No file at index', g.idx, 'max:', g.max);
			return;
		}
		playAudio(prevFile)
	}
}

function playPause() {
	if (!g.currentAudio) {
		if (g.music && g.music.length > 0) {
			playAudio(g.music[g.idx]);
		}
		return;
	}

	if (g.currentAudio.paused) {
		g.currentAudio.play();
	}
	else {
		g.currentAudio.pause();
	}
	checkState();
}

function toggleLoop() {
	g.isLoop = !g.isLoop;
	if (g.currentAudio && g.currentAudio.isFFmpeg && g.currentAudio.player) {
		g.currentAudio.player.setLoop(g.isLoop);
	}
	if (g.currentAudio && g.currentAudio.isMidi && midi) {
		midi.setLoop(g.isLoop);
	}
	checkState();
}



async function initMidiPlayer() {
	if (!window.midi || !g.audioContext) return;
	
	// Allow disabling MIDI player to save CPU (0.3-0.5% constant usage even when idle)
	if (g.config?.audio?.disableMidiPlayer) {

		return;
	}
	let fp = g.app_path;
	if (g.isPackaged) { fp = path.dirname(fp); }
	const soundfontFile = (g.config && g.config.midiSoundfont) ? g.config.midiSoundfont : 'default.sf2';
	
	// Check user directory first, then bundled
	const userDataPath = await helper.app.getPath('userData');
	const userDir = path.join(userDataPath, 'soundfonts');
	const userPath = path.join(userDir, soundfontFile);
	const bundledPath = path.resolve(fp + '/bin/soundfonts/' + soundfontFile);

	let soundfontPath = null;
	try {
		await fs.access(userPath);
		soundfontPath = userPath;

	} catch (e) {
		try {
			await fs.access(bundledPath);
			soundfontPath = bundledPath;

		} catch (e2) {
			console.warn('[MIDI] SoundFont not found:', soundfontFile, '- falling back to default.sf2');
			const defaultPath = path.resolve(fp + '/bin/soundfonts/default.sf2');
			const soundfontUrl = tools.getFileURL(defaultPath);
			await initMidiWithSoundfont(soundfontUrl, defaultPath);
			return;
		}
	}

	const soundfontUrl = tools.getFileURL(soundfontPath);
	await initMidiWithSoundfont(soundfontUrl, soundfontPath);
}

async function initMidiWithSoundfont(soundfontUrl, soundfontPath) {
	if (!g.audioContext) return;
	const context = g.audioContext; // Capture stable context reference

	const midiConfig = {
		context: context,
		soundfontUrl: soundfontUrl,
		soundfontPath: soundfontPath
	};

	let tempMidi;
	try {
		tempMidi = new window.midi(midiConfig);
	} catch (e) {
		console.error('MIDI init failed:', e);
		g.midiInitError = 'MIDI init failed: ' + e.message;
		return;
	}

	tempMidi.onMetadata((meta) => {

		if (g.currentAudio && g.currentAudio.isMidi) {
			const dur = (meta && meta.duration) ? meta.duration : tempMidi.getDuration();
			if (dur > 0) {
				g.currentAudio.duration = dur;
				// UI updated via IPC: g.playremain.innerText = ...
			}

			if (meta) {
				g.currentAudio.metadata = meta;
			}

			// Send metadata to UI
			renderInfo(g.currentAudio.fp, meta);

			let keepMetronome = false;
			if (g.midiSettings && g.midiSettings.metronome !== undefined) {
				keepMetronome = !!g.midiSettings.metronome;
			} else if (tempMidi) {
				keepMetronome = !!tempMidi.metronomeEnabled;
				if (keepMetronome) {
					if (!g.midiSettings) g.midiSettings = {};
					g.midiSettings.metronome = true;
				}
			}

			if (!g.midiSettings) g.midiSettings = {};

			g.midiSettings.pitch = 0;
			g.midiSettings.speed = null;

			if (tempMidi && tempMidi.setMetronome) {
				tempMidi.setMetronome(keepMetronome);
			}

			if (tempMidi && tempMidi.setPitchOffset) tempMidi.setPitchOffset(0);
			if (tempMidi && tempMidi.resetPlaybackSpeed) tempMidi.resetPlaybackSpeed();



			if (g.windows['midi']) {
				const originalBPM = (tempMidi.getOriginalBPM && typeof tempMidi.getOriginalBPM === 'function') ? tempMidi.getOriginalBPM() : 120;
				let currentBPM = originalBPM;

				tools.sendToId(g.windows['midi'], 'update-ui', {
					originalBPM: originalBPM,
					speed: currentBPM,
					pitch: 0,
					metronome: keepMetronome
				});
			}
		}
	});
	tempMidi.onProgress((e) => {
		if (g.currentAudio && g.currentAudio.isMidi) {
			g.currentAudio.currentTime = e.pos || 0;
		}
	});
	tempMidi.onEnded(audioEnded);
	tempMidi.onError((err) => { console.error('[MIDI] Error:', err.message || err); audioEnded(); g.blocky = false; });

	try {
		await tempMidi.init();

		// MIDI library internally connects to context.destination (via resampling if needed).
		// Monitoring taps are managed lazily by applyRoutingState().
		// If resampling is active, the node in the main context is resamplerSource.
		if (g.monitoringSplitter && g.monitoringSplitter.context === context) {
			const sourceNode = tempMidi.needsResampling ? tempMidi.resamplerSource : tempMidi.gain;
			if (sourceNode) {
				sourceNode.connect(g.monitoringSplitter);

			}
		}

		// Sync to global as last step
		midi = tempMidi;
	} catch (e) {
		console.error('[MIDI] Failed to initialize MIDI player:', e);
		g.midiInitError = 'MIDI init failed: ' + e.message;
	}
}

async function toggleHQMode(desiredState, skipPersist = false) {
	if (!g.config.audio) g.config.audio = {};
	let next = !!g.config.audio.hqMode;
	if (typeof desiredState === 'boolean') { next = desiredState; }
	else { next = !g.config.audio.hqMode; }
	if (!!g.config.audio.hqMode !== next) {
		g.config.audio.hqMode = next;
		if (!skipPersist) { g.config_obj.set(g.config); }
	}

	const targetRate = g.config.audio.hqMode ? g.maxSampleRate : 48000;


	let wasPlaying = false;
	if (g.currentAudio) {
		if (g.currentAudio.isFFmpeg && g.currentAudio.player && typeof g.currentAudio.player.isPlaying !== 'undefined') {
			wasPlaying = !!g.currentAudio.player.isPlaying;
		}
		else {
			wasPlaying = !g.currentAudio.paused;
		}
	}
	const currentFile = (g.currentAudio && g.currentAudio.fp) ? g.currentAudio.fp : g.music[g.idx];
	const currentIdx = (currentFile && g.music && g.music.length > 0) ? g.music.indexOf(currentFile) : -1;
	const wasMod = g.currentAudio?.isMod;
	const wasMidi = g.currentAudio?.isMidi;
	const currentTime = wasMod ? (player?.getCurrentTime() || 0) : (wasMidi ? (midi?.getCurrentTime() || 0) : (g.currentAudio?.player?.getCurrentTime() || 0));
	const wasRubberbandActive = g.activePipeline === 'rubberband' && g.rubberbandPlayer;

	// Destroy rubberband pipeline ONLY if not currently active
	// Rubberband is always 48kHz, so HQ toggle doesn't affect it when playing
	// If active, preserve it; if not active, destroy to allow clean state
	if (!wasRubberbandActive) {
		await destroyRubberbandPipeline();
	} else {
		console.log('[toggleHQMode] Rubberband active - preserving pipeline (always 48kHz)');
	}

	if (g.currentAudio) {
		if (g.currentAudio.isMod && player) {
			player.stop();
		} else if (g.currentAudio.isMidi && midi) {
			midi.stop();
		} else if (g.currentAudio.player) {
			if (typeof g.currentAudio.player.stop === 'function') {
				g.currentAudio.player.stop();
			}
			if (typeof g.currentAudio.player.close === 'function') {
				await g.currentAudio.player.close();
			}
		}
		g.currentAudio = null;
	}

	if (g.audioContext && g.audioContext.state !== 'closed') {
		await g.audioContext.close();
	}

	// Destroy monitoring resources so they're recreated with new context
	destroyMonitoring();

	g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetRate });


	const devId = (g.config && g.config.audio && g.config.audio.output) ? g.config.audio.output.deviceId : '';
	if (devId) {
		try {
			await g.audioContext.setSinkId(devId);

		} catch (err) {
			console.error('Failed to re-apply output device, using system default:', err);
			if (g.config && g.config.audio && g.config.audio.output) g.config.audio.output.deviceId = '';
			if (!skipPersist) { g.config_obj.set(g.config); }
		}
	}

	if (g.ffmpegPlayer) {
		try { g.ffmpegPlayer.dispose(); } catch (e) { console.warn('ffmpegPlayer dispose error:', e); }
		g.ffmpegPlayer = null;
	}

	const { FFmpegDecoder } = require(g.ffmpeg_napi_path);
	const { FFmpegStreamPlayerSAB } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);
	const threadCount = (g.config && g.config.ffmpeg && g.config.ffmpeg.decoder && g.config.ffmpeg.decoder.threads !== undefined) ? (g.config.ffmpeg.decoder.threads | 0) : 0;
	g.ffmpegPlayer = new FFmpegStreamPlayerSAB(g.audioContext, g.ffmpeg_worklet_path, 'ffmpeg-stream-sab', 2, threadCount, false); // Internal connect off
	try { g.ffmpegPlayer.reuseWorkletNode = true; } catch (e) { }
	await g.ffmpegPlayer.init();

	// Connect to destination (monitoring taps managed lazily by applyRoutingState())
	g.ffmpegPlayer.gainNode.connect(g.audioContext.destination);

	// Check if tracker lazy-init is enabled
	const lazyInitTracker = g.main_env?.lazyLoadEngines || g.main_env?.lazyLoadTracker || false;
	
	if (lazyInitTracker) {
		console.log('[toggleHQMode] Tracker lazy-init enabled, skipping eager initialization');
		// Reset tracker state - will lazy-init on next tracker file
		_trackerInstance = null;
		_trackerInitPromise = null;
		_trackerInitialized = false;
		player = null;
	} else {
		// Eager-init: Create tracker player immediately
		const modConfig = {
			repeatCount: 0,
			stereoSeparation: (g.config && g.config.tracker && g.config.tracker.stereoSeparation !== undefined) ? (g.config.tracker.stereoSeparation | 0) : 100,
			context: g.audioContext
		};
		player = new window.chiptune(modConfig);

		await new Promise((resolve) => {
			player.onInitialized(() => {
				player.gain.connect(g.audioContext.destination);
				// Monitoring taps are managed lazily by applyRoutingState()
				resolve();
			});
		});

		// Set up tracker event handlers (only when player exists)
		player.onMetadata(async (meta) => {
			if (g.currentAudio) {
				g.currentAudio.duration = player.duration;
				// Store channel count from metadata for parameters window
				if (meta && meta.song && meta.song.channels) {
					g.currentAudio.channels = meta.song.channels.length;
				}
				// UI updated via IPC
				await renderInfo(g.currentAudio.fp, meta);
			}
			g.blocky = false;
		});
		player.onProgress((e) => {
			if (g.currentAudio) {
				g.currentAudio.currentTime = e.pos || 0;
			}
			// Forward VU data to Parameters window
			// Safety: limit to reasonable channel count and skip if disposed
			if (!g.isDisposed && e.vu && g.windows.parameters && e.vu.length > 0 && e.vu.length <= 64) {
				sendToWindow(g.windows.parameters, 'tracker-vu', { vu: e.vu, channels: e.vu.length }, 'parameters');
			}
		});
		player.onEnded(audioEnded);
		player.onError((err) => { console.log(err); audioEnded(); g.blocky = false; });
	}

	// Re-initialize monitoring if window is still open (new context)
	// Skip if rubberband was preserved - playAudio will handle routing setup
	if (!wasRubberbandActive) {
		await applyRoutingState();
	}
	
	// Only re-init MIDI if it was previously initialized (lazy-init respect)
	// If MIDI was never used, don't init it now
	if (midi) {
		await initMidiPlayer();
	}

	if (currentFile) {
		if (currentIdx >= 0) {
			g.idx = currentIdx;
		}
		// Pass preserveRubberband=true if rubberband was active (HQ toggle preserves rubberband pipeline)
		await playAudio(currentFile, currentTime, !wasPlaying, false, false, wasRubberbandActive);

		if (wasPlaying && g.currentAudio && g.currentAudio.paused && g.currentAudio.play) {
			g.currentAudio.play();
		}
	}

	// Send updated sample rate info after HQ mode toggle
	ipcRenderer.send('audio:sample-rate-info', {
		maxSampleRate: g.maxSampleRate,
		currentSampleRate: g.audioContext?.sampleRate
	});
	
	// Also send direct update to settings window if open
	if (g.windows.settings) {
		sendToWindow(g.windows.settings, 'sample-rate-updated', { currentSampleRate: g.audioContext?.sampleRate });
	}

	console.log('[toggleHQMode] completed successfully');
	checkState();
}

function volumeUp() {
	const v = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? (+g.config.audio.volume + 0.05) : 0.55;
	setVolume(v, true);
}

function volumeDown() {
	const v = (g.config && g.config.audio && g.config.audio.volume !== undefined) ? (+g.config.audio.volume - 0.05) : 0.45;
	setVolume(v, true);
}

function applyTapeSpeed(semitones) {
	semitones = Math.max(-12, Math.min(12, semitones | 0));


	g.audioParams.tapeSpeed = semitones;

	if (g.currentAudio?.isFFmpeg && g.currentAudio.player) {

		g.currentAudio.player.setPlaybackRate(semitones);
	}

	if (g.currentAudio?.isMod && player) {
		const tempoFactor = Math.pow(2, semitones / 12.0);

		player.setTempo(tempoFactor);
	}

	// Note: MIDI has its own tempo controls, tape speed does not apply
}

function seek(mx) {
	if (!g.currentAudio) return;
	let dur = g.currentAudio.duration;
	if (!(dur > 0)) {
		if (g.currentAudio.isMod && player && player.duration) dur = player.duration;
		else if (g.currentAudio.isFFmpeg && g.currentAudio.player && g.currentAudio.player.duration) dur = g.currentAudio.player.duration;
		else if (g.currentAudio.isMidi && midi && midi.duration) dur = midi.duration;
	}
	if (!(dur > 0)) return;
	let max = g.time_controls.offsetWidth;
	let x = mx - ut.offset(g.time_controls).left;
	if (x < 0) { x = 0; }
	if (x > max) { x = max; }
	let proz = x / max;
	let s = dur * proz;
	if (s < 0) s = 0;
	if (s > dur) s = dur;
	seekTo(s);
}

function seekTo(s) {
	if (g.currentAudio) {
		if (g.currentAudio.isMod) {
			player.seek(s);
			g.currentAudio.currentTime = s;
		}
		else if (g.currentAudio.isMidi) {
			g.currentAudio.seek(s);
			g.currentAudio.currentTime = s;
		}
		else {
			g.currentAudio.seek(s);
		}
	}
}

function seekFore() {
	if (g.currentAudio) {
		if (g.currentAudio.currentTime + 10 < g.currentAudio.duration) {
			seekTo(g.currentAudio.currentTime + 10)
		}
	}
}

function seekBack() {
	if (g.currentAudio) {
		if (g.currentAudio.currentTime - 10 > 0) {
			seekTo(g.currentAudio.currentTime - 10)
		}
		else {
			seekTo(0);
		}
	}
}

function loadImage(url) {
	return new Promise((resolve, reject) => {
		let image = new Image();
		image.src = url;
		image.addEventListener('load', done);
		function done(e) {
			image.removeEventListener('load', done);
			resolve(image);
		}
	})
}

function initMonitoring() {
	if (!g.audioContext) return;

	// Reset standard monitoring if context changed (e.g. HQ toggle)
	if (g.monitoringSplitter && g.monitoringSplitter.context !== g.audioContext) {

		g.monitoringSplitter = null;
		g.monitoringAnalyserL = null;
		g.monitoringAnalyserR = null;
	}

	if (!g.monitoringSplitter) {
		g.monitoringSplitter = g.audioContext.createChannelSplitter(2);
		g.monitoringAnalyserL = g.audioContext.createAnalyser();
		g.monitoringAnalyserR = g.audioContext.createAnalyser();

		// Use larger FFT for high sample rates to maintain frequency resolution
		const fftSize = g.audioContext.sampleRate > 48000 ? 8192 : 2048;
		g.monitoringAnalyserL.fftSize = fftSize;
		g.monitoringAnalyserR.fftSize = fftSize;

		g.monitoringSplitter.connect(g.monitoringAnalyserL, 0);
		g.monitoringSplitter.connect(g.monitoringAnalyserR, 1);
		// Tap only - do not connect to destination here!
	}

	// Context 2 (Rubberband) - Always 48kHz
	if (g.rubberbandContext) {
		if (g.monitoringSplitter_RB && g.monitoringSplitter_RB.context !== g.rubberbandContext) {

			g.monitoringSplitter_RB = null;
			g.monitoringAnalyserL_RB = null;
			g.monitoringAnalyserR_RB = null;
		}

		if (!g.monitoringSplitter_RB) {
			g.monitoringSplitter_RB = g.rubberbandContext.createChannelSplitter(2);
			g.monitoringAnalyserL_RB = g.rubberbandContext.createAnalyser();
			g.monitoringAnalyserR_RB = g.rubberbandContext.createAnalyser();

			g.monitoringAnalyserL_RB.fftSize = 2048;
			g.monitoringAnalyserR_RB.fftSize = 2048;

			g.monitoringSplitter_RB.connect(g.monitoringAnalyserL_RB, 0);
			g.monitoringSplitter_RB.connect(g.monitoringAnalyserR_RB, 1);
			// Tap only - do not connect to destination here!

		}
	}



	// Pre-allocate reusable buffers for monitoring data
	if (!g.monitoringBuffers) {
		g.monitoringBuffers = {
			freqL: null,
			freqR: null,
			timeL: null,
			timeR: null
		};
	}

	// Note: monitoring loop is started/stopped based on visibility
	// See startMonitoringLoop() and stopMonitoringLoop()
}

function startMonitoringLoop() {
	if (!g.monitoringLoop) {
		// Use setInterval for reliable timing (RAF pauses when window not visible)
		g.monitoringLoop = setInterval(updateMonitoring, 1000 / 60);
	}
}

function stopMonitoringLoop() {
	if (g.monitoringLoop) {
		clearInterval(g.monitoringLoop);
		g.monitoringLoop = null;
	}
}

function updateMonitoring() {
	if (!g.windows.monitoring || !g.windowsVisible.monitoring || !g.monitoringReady) return;

	// Determine which analysers to use
	let aL = g.monitoringAnalyserL;
	let aR = g.monitoringAnalyserR;
	let analyserSource = 'normal';

	if (g.activePipeline === 'rubberband' && g.monitoringAnalyserL_RB) {
		aL = g.monitoringAnalyserL_RB;
		aR = g.monitoringAnalyserR_RB;
		analyserSource = 'rubberband';
	}

	if (!aL || !aR) {

		return;
	}

	// Reuse buffers if size matches, otherwise recreate
	const buf = g.monitoringBuffers;
	if (!buf.freqL || buf.freqL.length !== aL.frequencyBinCount) {
		buf.freqL = new Uint8Array(aL.frequencyBinCount);
		buf.freqR = new Uint8Array(aR.frequencyBinCount);
		buf.timeL = new Uint8Array(aL.fftSize);
		buf.timeR = new Uint8Array(aR.fftSize);
	}

	aL.getByteFrequencyData(buf.freqL);
	aR.getByteFrequencyData(buf.freqR);
	aL.getByteTimeDomainData(buf.timeL);
	aR.getByteTimeDomainData(buf.timeR);

	// Debug: Check if rubberband analyser data is all zeros
	if (analyserSource === 'rubberband') {
		const maxVal = Math.max(...buf.freqL);
		if (maxVal === 0) {

		}
	}

	const pos = (g.currentAudio && typeof g.currentAudio.getCurrentTime === 'function') ? g.currentAudio.getCurrentTime() : 0;
	const dur = (g.currentAudio && g.currentAudio.duration) ? g.currentAudio.duration : 0;

		try {
			sendToWindow(g.windows.monitoring, 'ana-data', {
				source: 'main',
				freqL: Array.from(buf.freqL),
				freqR: Array.from(buf.freqR),
				timeL: Array.from(buf.timeL),
				timeR: Array.from(buf.timeR),
				pos,
				duration: dur,
				sampleRate: (g.activePipeline === 'rubberband' && g.rubberbandContext) ? g.rubberbandContext.sampleRate : (g.audioContext ? g.audioContext.sampleRate : 48000)
			}, 'monitoring');
		} catch (err) {
			// Silently ignore - window may be closing
		}
}

async function extractAndSendWaveform(fp) {
	if (!g.windows.monitoring || !g.monitoringReady) return;

	// Clear existing waveform immediately to avoid visual persistence
	try {
		sendToWindow(g.windows.monitoring, 'clear-waveform', null, 'monitoring');
	} catch (err) {
		console.warn('[Monitoring] Failed to clear waveform (window may be closing):', err.message);
		return;
	}

	// Check if this is a MIDI file (FFmpeg cannot decode MIDI)
	const ext = path.extname(fp).toLowerCase();
	const isMIDI = g.supportedMIDI && g.supportedMIDI.includes(ext);
	
	if (isMIDI) {

		// Send file info so monitoring window shows the filename
		try {
			sendToWindow(g.windows.monitoring, 'waveform-data', {
				peaksL: null,
				peaksR: null,
				points: 0,
				duration: 0,
				filePath: fp,
				isMIDI: true
			}, 'monitoring');
		} catch (err) {
			console.warn('[Monitoring] Failed to send MIDI info:', err.message);
		}
		return;
	}

	// Check cache first
	try {
		const cached = await ipcRenderer.invoke('waveform:get', fp);
		if (cached) {

			sendToWindow(g.windows.monitoring, 'waveform-data', {
				...cached,
				filePath: path.basename(fp)
			}, 'monitoring');
			return;
		}
	} catch (err) {
		console.warn('[Monitoring] Failed to check waveform cache:', err.message);
	}



	try {
		const workerPath = path.join(g.app_path, 'js', 'monitoring', 'waveform_worker.js');

		// Use Main process to handle the worker - avoid V8 platform limitations in renderer
		const peaks = await ipcRenderer.invoke('extract-waveform', {
			filePath: fp,
			binPath: g.ffmpeg_napi_path,
			numPoints: 1900,
			workerPath: workerPath
		});

		if (peaks && peaks.aborted) {

			return;
		}

		if (peaks && peaks.error) {
			console.error('[Monitoring] Waveform worker error:', peaks.error);
			return;
		}

		if (!peaks) {
			console.warn('[Monitoring] Waveform worker returned no data');
			return;
		}

		const hasData = peaks.peaksL && peaks.peaksL.some(p => p > 0);


		// Cache the waveform for future use
		if (hasData) {
			ipcRenderer.send('waveform:set', {
				filePath: fp,
				peaksL: peaks.peaksL,
				peaksR: peaks.peaksR,
				points: peaks.points,
				duration: peaks.duration
			});
		}

		if (g.windows.monitoring) {
			try {
				sendToWindow(g.windows.monitoring, 'waveform-data', {
					...peaks,
					filePath: path.basename(fp)
				});
			} catch (err) {
				console.warn('[Monitoring] Failed to send waveform data (window may be closing):', err.message);
			}
		}
	} catch (err) {
		console.error('[Monitoring] Waveform extraction IPC failed:', err);
	}
}

function getFileInfo(fp) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			let meta = g.getMetadata(fp);
			resolve(meta);
		}, 0);
	})
}



// Window management is handled by app.js in the new architecture
// This file only handles audio playback

// ---------------------------------------------------------------------------
// DEBUG CONSOLE COMMANDS - For CPU testing
// ---------------------------------------------------------------------------

// Expose engine disposal functions to console for testing
window.disposeEngines = {
	// Dispose MIDI player (stops soundfont synthesis)
	midi: () => {
		if (midi) {

			midi.dispose();
			midi = null;

		} else {

		}
	},
	
	// Dispose tracker player (stops chiptune worklet)
	tracker: () => {
		if (player || _trackerInstance) {
			const tracker = _trackerInstance || player;
			try { tracker.stop(); } catch (e) {}
			try { 
				if (tracker.gain) tracker.gain.disconnect(); 
			} catch (e) {}
		}
		// Reset module-scope lazy-init state
		_trackerInstance = null;
		_trackerInitPromise = null;
		_trackerInitialized = false;
		player = null;
	},
	
	// Dispose FFmpeg players
	ffmpeg: () => {

		if (g.ffmpegPlayer) {
			g.ffmpegPlayer.stop(true);

		}
		if (g.rubberbandPlayer) {
			g.rubberbandPlayer.disconnect();
			if (typeof g.rubberbandPlayer.disposeWorklet === 'function') {
				g.rubberbandPlayer.disposeWorklet();
			}
			g.rubberbandPlayer.stop(true);

		}

	},
	
	// Dispose all audio engines
	all: () => {

		window.disposeEngines.midi();
		window.disposeEngines.tracker();
		window.disposeEngines.ffmpeg();
		clearAudio();

	},
	
	// Check what's currently active
	status: () => {






		console.log('  Current type:', g.currentAudio ? 
			(g.currentAudio.isMidi ? 'MIDI' : 
			 g.currentAudio.isMod ? 'Tracker' : 
			 g.currentAudio.isFFmpeg ? 'FFmpeg' : 'Unknown') : 'none');
	}
};








module.exports.init = init;



