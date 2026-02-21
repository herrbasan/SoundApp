/**
 * State Client - Unified State Management for Renderer Processes
 * 
 * Provides a synchronous, local-feeling API for accessing the ground truth
 * state held in the main process (app.js). Abstracts away IPC communication.
 * 
 * Principles:
 * - Synchronous Reads: get() returns from local proxy immediately
 * - Asynchronous Writes: set() sends intent to Main, returns Promise
 * - Reactive: subscribe() for UI updates without parsing broadcasts
 * - Unified Namespace: audio.*, playback.*, midi.*, tracker.*, system.*, ui.*
 */

'use strict';

const { ipcRenderer } = require('electron');

// StateClient singleton
const StateClient = {
    // Local synchronized proxy of ground truth state
    _state: {
        audio: {
            mode: 'tape',
            tapeSpeed: 0,
            pitch: 0,
            tempo: 1.0,
            formant: false,
            locked: false,
            volume: 0.5
        },
        playback: {
            file: null,
            isPlaying: false,
            position: 0,
            duration: 0,
            loop: false
        },
        midi: {
            transpose: 0,
            bpm: null,
            metronome: false,
            soundfont: null
        },
        tracker: {
            pitch: 1.0,
            tempo: 1.0,
            stereoSeparation: 100
        },
        playlist: {
            items: [],
            index: 0
        },
        file: {
            metadata: null,
            type: null
        },
        ui: {
            monitoringSource: 'main'
        },
        system: {
            engineAlive: false,
            activePipeline: 'normal'
        }
    },

    // Subscription registry: key -> Set(callbacks)
    _subscriptions: new Map(),

    // Pending set() promises: key -> { resolve, reject, timeout }
    _pendingSets: new Map(),

    // Write timeout in ms
    _WRITE_TIMEOUT: 5000,

    // Initialization flag
    _initialized: false,

    /**
     * Initialize the StateClient
     * Sets up IPC listeners for state updates from main process
     */
    init() {
        if (this._initialized) return;
        this._initialized = true;

        // Listen for state broadcasts from main
        ipcRenderer.on('state:update', (e, delta) => {
            this._applyDelta(delta);
        });

        // Listen for state change confirmations
        ipcRenderer.on('state:confirm', (e, { key, value, error }) => {
            this._handleConfirmation(key, value, error);
        });

        // Request initial state sync
        ipcRenderer.send('state:requestSync');

        console.log('[StateClient] Initialized');
    },

    /**
     * Get a state value synchronously
     * @param {string} key - Dot-notation path (e.g., 'audio.pitch', 'playback.isPlaying')
     * @returns {any} Current value or undefined if not found
     */
    get(key) {
        return this._getPath(this._state, key);
    },

    /**
     * Get entire state tree (use with caution - prefer get())
     * @returns {Object} Deep copy of current state
     */
    getAll() {
        return JSON.parse(JSON.stringify(this._state));
    },

    /**
     * Set a state value (sends intent to main process)
     * @param {string} key - Dot-notation path
     * @param {any} value - New value
     * @returns {Promise} Resolves when main confirms update, rejects on error
     */
    async set(key, value) {
        // Optimistic local update for immediate UI feedback
        const oldValue = this.get(key);
        this._setPath(this._state, key, value);
        this._notifySubscribers(key, value, oldValue);

        // Send intent to main process
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._pendingSets.delete(key);
                reject(new Error(`State set timeout: ${key}`));
            }, this._WRITE_TIMEOUT);

            this._pendingSets.set(key, { resolve, reject, timeout });
            
            ipcRenderer.send('state:setIntent', { key, value });
        });
    },

    /**
     * Toggle a boolean state value
     * @param {string} key - Dot-notation path to boolean
     * @returns {Promise} Resolves with new value
     */
    async toggle(key) {
        const current = this.get(key);
        if (typeof current !== 'boolean') {
            throw new Error(`Cannot toggle non-boolean: ${key} = ${current}`);
        }
        await this.set(key, !current);
        return !current;
    },

    /**
     * Subscribe to state changes
     * @param {string} key - Dot-notation path (supports wildcards: 'audio.*')
     * @param {Function} callback - (newValue, oldValue, key) => void
     * @returns {Function} Unsubscribe function
     */
    subscribe(key, callback) {
        if (!this._subscriptions.has(key)) {
            this._subscriptions.set(key, new Set());
        }
        this._subscriptions.get(key).add(callback);

        // Return unsubscribe function
        return () => {
            const subs = this._subscriptions.get(key);
            if (subs) {
                subs.delete(callback);
                if (subs.size === 0) {
                    this._subscriptions.delete(key);
                }
            }
        };
    },

    /**
     * Unsubscribe from state changes
     * @param {string} key - Dot-notation path
     * @param {Function} callback - Same function passed to subscribe()
     */
    unsubscribe(key, callback) {
        const subs = this._subscriptions.get(key);
        if (subs) {
            subs.delete(callback);
            if (subs.size === 0) {
                this._subscriptions.delete(key);
            }
        }
    },

    /**
     * Dispatch an action (complex intent)
     * @param {string} action - Action name (e.g., 'play', 'pause', 'seek', 'next', 'prev')
     * @param {Object} payload - Optional payload
     * @returns {Promise} Resolves when action completes
     */
    async dispatch(action, payload = {}) {
        return new Promise((resolve, reject) => {
            const requestId = `${action}_${Date.now()}`;
            const timeout = setTimeout(() => {
                ipcRenderer.removeListener('action:complete', handler);
                reject(new Error(`Action timeout: ${action}`));
            }, this._WRITE_TIMEOUT);

            const handler = (e, data) => {
                if (data.requestId === requestId) {
                    clearTimeout(timeout);
                    ipcRenderer.removeListener('action:complete', handler);
                    if (data.error) {
                        reject(new Error(data.error));
                    } else {
                        resolve(data.result);
                    }
                }
            };

            ipcRenderer.on('action:complete', handler);
            ipcRenderer.send('action:dispatch', { action, payload, requestId });
        });
    },

    // --- Internal Methods ---

    /**
     * Apply delta update from main process
     * @param {Object} delta - Object with changed key-value pairs
     */
    _applyDelta(delta) {
        if (!delta || typeof delta !== 'object') return;

        for (const [key, value] of Object.entries(delta)) {
            const oldValue = this.get(key);
            if (JSON.stringify(oldValue) !== JSON.stringify(value)) {
                this._setPath(this._state, key, value);
                this._notifySubscribers(key, value, oldValue);
            }
        }
    },

    /**
     * Handle set() confirmation from main process
     */
    _handleConfirmation(key, value, error) {
        const pending = this._pendingSets.get(key);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this._pendingSets.delete(key);

        if (error) {
            // Revert optimistic update on error
            this._applyDelta({ [key]: value });
            pending.reject(new Error(error));
        } else {
            pending.resolve(value);
        }
    },

    /**
     * Notify subscribers of state change
     */
    _notifySubscribers(key, newValue, oldValue) {
        // Exact key match
        const exactSubs = this._subscriptions.get(key);
        if (exactSubs) {
            exactSubs.forEach(cb => {
                try { cb(newValue, oldValue, key); } catch (err) { console.error(err); }
            });
        }

        // Wildcard match (e.g., 'audio.*' matches 'audio.pitch')
        const parts = key.split('.');
        const parentKey = parts.slice(0, -1).join('.');
        if (parentKey) {
            const wildcardSubs = this._subscriptions.get(`${parentKey}.*`);
            if (wildcardSubs) {
                wildcardSubs.forEach(cb => {
                    try { cb(newValue, oldValue, key); } catch (err) { console.error(err); }
                });
            }
        }

        // Root wildcard ('*') - notify of any change
        const rootWildcard = this._subscriptions.get('*');
        if (rootWildcard) {
            rootWildcard.forEach(cb => {
                try { cb(newValue, oldValue, key); } catch (err) { console.error(err); }
            });
        }
    },

    /**
     * Get value at dot-notation path
     */
    _getPath(obj, path) {
        return path.split('.').reduce((o, p) => o?.[p], obj);
    },

    /**
     * Set value at dot-notation path (creates nested objects as needed)
     */
    _setPath(obj, path, value) {
        const parts = path.split('.');
        const last = parts.pop();
        const target = parts.reduce((o, p) => {
            if (!o[p]) o[p] = {};
            return o[p];
        }, obj);
        target[last] = value;
    }
};

// Auto-initialize if in renderer process
if (typeof window !== 'undefined' && window.process?.type === 'renderer') {
    StateClient.init();
}

module.exports = StateClient;
