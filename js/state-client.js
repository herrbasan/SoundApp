'use strict';

/**
 * State Client - Unified state management for renderer processes
 * 
 * Provides a synchronous, local-feeling API for accessing application state
 * that is actually maintained in the main process. Uses IPC for sync and
 * subscriptions for reactive updates.
 * 
 * Usage:
 *   const value = State.get('audio.pitch');
 *   await State.set('audio.pitch', 3);
 *   State.subscribe('audio.pitch', (newVal, oldVal) => { ... });
 *   await State.dispatch('play');
 */

const { ipcRenderer } = require('electron');

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL STATE
// ═══════════════════════════════════════════════════════════════════════════

// Local proxy of ground truth state (synced from main)
const _state = {};

// Subscription registry: key -> Set of callbacks
const _subscriptions = new Map();

// Pending request tracking for async operations
let _requestId = 0;
const _pendingRequests = new Map();

// Window visibility state (for pause processing optimization)
let _isVisible = true;
let _isInitialized = false;

// ═══════════════════════════════════════════════════════════════════════════
// KEY MAPPING
// ═══════════════════════════════════════════════════════════════════════════

// Map flat keys to nested paths in state object
const KEY_MAP = {
    // Audio params
    'audio.mode': 'mode',
    'audio.tapeSpeed': 'tapeSpeed',
    'audio.pitch': 'pitch',
    'audio.tempo': 'tempo',
    'audio.formant': 'formant',
    'audio.locked': 'locked',
    'audio.volume': 'volume',
    
    // Playback
    'playback.file': 'file',
    'playback.isPlaying': 'isPlaying',
    'playback.position': 'position',
    'playback.duration': 'duration',
    'playback.loop': 'loop',
    
    // MIDI
    'midi.transpose': 'midiParams.transpose',
    'midi.bpm': 'midiParams.bpm',
    'midi.metronome': 'midiParams.metronome',
    'midi.soundfont': 'midiParams.soundfont',
    
    // Tracker
    'tracker.pitch': 'trackerParams.pitch',
    'tracker.tempo': 'trackerParams.tempo',
    'tracker.stereoSeparation': 'trackerParams.stereoSeparation',
    
    // Playlist
    'playlist.items': 'playlist',
    'playlist.index': 'playlistIndex',
    
    // File/Metadata
    'file.metadata': 'metadata',
    'file.type': 'fileType',
    
    // UI/System
    'ui.monitoringSource': 'monitoringSource',
    'system.engineAlive': 'engineAlive',
    'system.activePipeline': 'activePipeline'
};

// Writable keys (can use State.set)
const WRITABLE_KEYS = new Set([
    'audio.mode',
    'audio.tapeSpeed',
    'audio.pitch',
    'audio.tempo',
    'audio.formant',
    'audio.locked',
    'audio.volume',
    'playback.loop',
    'ui.monitoringSource'
]);

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get nested value from state object using dot-notation path
 */
function _getPath(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Set nested value in state object using dot-notation path
 */
function _setPath(obj, path, value) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part];
    }
    const lastPart = parts[parts.length - 1];
    const oldValue = current[lastPart];
    current[lastPart] = value;
    return oldValue;
}

/**
 * Match key against subscription pattern (supports wildcards)
 */
function _matchPattern(key, pattern) {
    if (pattern === '*') return true;
    if (pattern === key) return true;
    if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        return key.startsWith(prefix + '.');
    }
    return false;
}

/**
 * Notify all subscribers matching a key
 */
function _notifySubscribers(key, newValue, oldValue) {
    for (const [pattern, callbacks] of _subscriptions) {
        if (_matchPattern(key, pattern)) {
            for (const callback of callbacks) {
                try {
                    callback(newValue, oldValue, key);
                } catch (err) {
                    console.error('[StateClient] Subscriber error:', err);
                }
            }
        }
    }
}

/**
 * Apply delta update from main process
 */
function _applyDelta(delta) {
    // OPTIMIZATION: Skip subscription notifications when window hidden
    // We still store the delta so state is current when window shows
    const shouldNotify = _isVisible;
    
    for (const [key, value] of Object.entries(delta)) {
        const oldValue = _state[key];
        
        // Skip if value hasn't changed
        if (oldValue === value) continue;
        
        _state[key] = value;
        
        if (shouldNotify) {
            _notifySubscribers(key, value, oldValue);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// Receive state updates from main process
ipcRenderer.on('state:update', (e, delta) => {
    _applyDelta(delta);
});

// Receive confirmation of set operations
ipcRenderer.on('state:confirm', (e, { key, value, error }) => {
    if (error) {
        console.error('[StateClient] Set failed:', key, error);
    }
    // Note: Actual state update comes via state:update broadcast
});

// Receive action completion
ipcRenderer.on('action:complete', (e, { requestId, result, error }) => {
    const pending = _pendingRequests.get(requestId);
    if (pending) {
        _pendingRequests.delete(requestId);
        if (error) {
            pending.reject(new Error(error));
        } else {
            pending.resolve(result);
        }
    }
});

// Handle visibility changes from main
ipcRenderer.on('window-visibility', (e, visible) => {
    _isVisible = visible;
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

const State = {
    /**
     * Initialize the State Client and sync with main process
     */
    init() {
        if (_isInitialized) return Promise.resolve();
        
        return new Promise((resolve, reject) => {
            // Request full state sync
            ipcRenderer.send('state:requestSync');
            
            // Wait for first state update
            const handler = (e, delta) => {
                _applyDelta(delta);
                _isInitialized = true;
                ipcRenderer.removeListener('state:update', handler);
                resolve();
            };
            
            ipcRenderer.on('state:update', handler);
            
            // Timeout fallback
            setTimeout(() => {
                if (!_isInitialized) {
                    ipcRenderer.removeListener('state:update', handler);
                    reject(new Error('StateClient init timeout'));
                }
            }, 5000);
        });
    },

    /**
     * Get a value from state (synchronous)
     * @param {string} key - State key (e.g., 'audio.pitch')
     * @returns {any} Current value
     */
    get(key) {
        return _state[key];
    },

    /**
     * Get entire state tree (use sparingly)
     * @returns {object} Full state
     */
    getAll() {
        return { ..._state };
    },

    /**
     * Set a value (asynchronous - sends intent to main)
     * @param {string} key - State key to set
     * @param {any} value - New value
     * @returns {Promise<void>}
     */
    async set(key, value) {
        if (!WRITABLE_KEYS.has(key)) {
            throw new Error(`Key "${key}" is read-only or unknown`);
        }
        
        // Optimistic update (will be confirmed/overridden by main)
        const oldValue = _state[key];
        _state[key] = value;
        _notifySubscribers(key, value, oldValue);
        
        // Send intent to main
        ipcRenderer.send('state:setIntent', { key, value });
    },

    /**
     * Toggle a boolean value
     * @param {string} key - Boolean state key
     * @returns {Promise<boolean>} New value
     */
    async toggle(key) {
        const current = this.get(key);
        if (typeof current !== 'boolean') {
            throw new Error(`Cannot toggle non-boolean key "${key}"`);
        }
        const newValue = !current;
        await this.set(key, newValue);
        return newValue;
    },

    /**
     * Subscribe to state changes
     * @param {string} pattern - Key or wildcard (e.g., 'audio.pitch', 'audio.*', '*')
     * @param {function} callback - (newValue, oldValue, key) => void
     * @returns {function} Unsubscribe function
     */
    subscribe(pattern, callback) {
        if (!_subscriptions.has(pattern)) {
            _subscriptions.set(pattern, new Set());
        }
        _subscriptions.get(pattern).add(callback);
        
        // Return unsubscribe function
        return () => {
            const callbacks = _subscriptions.get(pattern);
            if (callbacks) {
                callbacks.delete(callback);
                if (callbacks.size === 0) {
                    _subscriptions.delete(pattern);
                }
            }
        };
    },

    /**
     * Unsubscribe from state changes
     * @param {string} pattern - Key pattern
     * @param {function} callback - Same callback passed to subscribe
     */
    unsubscribe(pattern, callback) {
        const callbacks = _subscriptions.get(pattern);
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                _subscriptions.delete(pattern);
            }
        }
    },

    /**
     * Dispatch an action to the main process
     * @param {string} action - Action name (play, pause, toggle, seek, next, prev)
     * @param {object} payload - Optional action data
     * @returns {Promise<object>} Action result
     */
    async dispatch(action, payload = {}) {
        const requestId = ++_requestId;
        
        return new Promise((resolve, reject) => {
            // Store pending request
            _pendingRequests.set(requestId, { resolve, reject });
            
            // Send action to main
            ipcRenderer.send('action:dispatch', { action, payload, requestId });
            
            // Timeout cleanup
            setTimeout(() => {
                if (_pendingRequests.has(requestId)) {
                    _pendingRequests.delete(requestId);
                    reject(new Error(`Action "${action}" timeout`));
                }
            }, 10000);
        });
    },

    /**
     * Check if StateClient is initialized
     * @returns {boolean}
     */
    isInitialized() {
        return _isInitialized;
    },

    /**
     * Force a full state sync from main (rarely needed)
     */
    sync() {
        ipcRenderer.send('state:requestSync');
    }
};

// Auto-init on load (but don't block)
State.init().catch(err => {
    console.warn('[StateClient] Auto-init failed:', err.message);
});

module.exports = State;
