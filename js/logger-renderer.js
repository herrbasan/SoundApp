'use strict';

/**
 * SoundApp Logger - Renderer Process
 * 
 * Wrapper for renderer processes to send logs to the main process.
 * Auto-detects window scope from URL or allows explicit override.
 * 
 * @example
 * const logger = require('./logger-renderer');
 * logger.init(); // Auto-detects scope from window URL
 * 
 * // Or with explicit scope:
 * logger.init('engine');
 * 
 * logger.info('Something happened', { detail: 'value' });
 * logger.error('Failed to load', error);
 */

const { ipcRenderer } = require('electron');

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

class RendererLogger {
    constructor() {
        this.initialized = false;
        this.scope = 'unknown';
    }

    /**
     * Initialize the logger and detect scope.
     * 
     * @param {string} explicitScope - Optional explicit scope (auto-detected if not provided)
     * @param {boolean} captureConsole - If true, also capture console.* calls (default: true)
     */
    init(explicitScope, captureConsole = true) {
        if (this.initialized) return;

        this.scope = explicitScope || this._detectScope();
        this.initialized = true;
        
        if (captureConsole) {
            this._captureConsole();
        }
    }

    /**
     * Capture console.* calls and send to main process.
     */
    _captureConsole() {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;

        console.log = (...args) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this._send('INFO', '[console] ' + message);
            // Suppress terminal output in renderer
        };

        console.warn = (...args) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this._send('WARN', '[console] ' + message);
            // Suppress terminal output in renderer
        };

        console.error = (...args) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this._send('ERROR', '[console] ' + message);
            // Still show errors in DevTools
            originalError.apply(console, args);
        };
    }

    /**
     * Detect scope from current window URL/path.
     */
    _detectScope() {
        const url = window.location.href;
        const pathname = window.location.pathname;
        
        // Check URL patterns
        if (url.includes('engines.html')) return 'engine';
        if (url.includes('player.html')) return 'player';
        if (url.includes('stage.html')) return 'player';
        if (url.includes('parameters')) return 'parameters';
        if (url.includes('monitoring')) return 'monitoring';
        if (url.includes('mixer')) return 'mixer';
        if (url.includes('settings')) return 'settings';
        if (url.includes('help')) return 'help';
        
        // Check for window-type meta or global
        if (typeof windowType !== 'undefined') return windowType;
        if (document.querySelector('meta[name="window-type"]')) {
            return document.querySelector('meta[name="window-type"]').content;
        }
        
        // Fallback: try to infer from process title or other hints
        if (pathname.includes('js/midi') || pathname.includes('js/tracker')) {
            return 'engine';
        }
        
        return 'renderer';
    }

    /**
     * Send log to main process via IPC.
     */
    _send(level, message, data) {
        if (!this.initialized) {
            this.init();
        }

        // Handle Error objects specially
        let logData = data;
        if (data instanceof Error) {
            logData = {
                error: data.message,
                stack: data.stack,
                name: data.name
            };
        } else if (data && typeof data === 'object') {
            // Sanitize: remove circular refs and non-serializable data
            try {
                JSON.stringify(data);
            } catch (e) {
                logData = '[Circular/Non-serializable data]';
            }
        }

        // Use send for fire-and-forget logging (doesn't block renderer)
        try {
            ipcRenderer.send('log:message', {
                level,
                scope: this.scope,
                message,
                data: logData
            });
        } catch (e) {
            // IPC not available, use console
            console.log(`[${level}] [${this.scope}]`, message, data);
        }
    }

    // Public API
    debug(message, data) { this._send('DEBUG', message, data); }
    info(message, data) { this._send('INFO', message, data); }
    warn(message, data) { this._send('WARN', message, data); }
    error(message, data) { this._send('ERROR', message, data); }

    /**
     * Get current scope.
     */
    getScope() {
        return this.scope;
    }

    /**
     * Set scope explicitly (useful for dynamic context changes).
     */
    setScope(scope) {
        this.scope = scope;
    }

    /**
     * Get log file path from main process.
     */
    async getLogPath() {
        try {
            return await ipcRenderer.invoke('log:getPath');
        } catch (e) {
            return null;
        }
    }

    /**
     * Get logger status from main process.
     */
    async getStatus() {
        try {
            return await ipcRenderer.invoke('log:getStatus');
        } catch (e) {
            return { enabled: false };
        }
    }
}

// Singleton instance
module.exports = new RendererLogger();
