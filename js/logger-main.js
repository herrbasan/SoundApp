'use strict';

/**
 * SoundApp Logger - Main Process
 * 
 * Centralized logging system for the main process.
 * Creates timestamped log files in development mode.
 * Provides IPC endpoint for renderer processes to log through.
 * 
 * Log Format: [ISO_TIMESTAMP] [LEVEL] [SCOPE] message {data}
 * 
 * @example
 * const logger = require('./logger-main');
 * logger.init(app); // Initialize with app instance
 * logger.info('main', 'App started', { version: '2.1.3' });
 */

const fs = require('fs').promises;
const path = require('path');
const { ipcMain } = require('electron');

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

class Logger {
    constructor() {
        this.initialized = false;
        this.enabled = false;
        this.logDir = null;
        this.currentLogFile = null;
        this.minLevel = LOG_LEVELS.DEBUG;
        this.writeQueue = [];
        this.writing = false;
    }

    /**
     * Initialize the logger.
     * Creates logs directory in project folder and opens log file.
     * Only operates when app is not packaged (dev mode).
     * 
     * @param {App} app - Electron app instance
     * @param {Object} options - Optional configuration
     * @param {string} options.minLevel - Minimum log level ('DEBUG', 'INFO', 'WARN', 'ERROR')
     */
    async init(app, options = {}) {
        if (this.initialized) return;

        this.enabled = !app.isPackaged;
        
        if (!this.enabled) {
            this._noop = true;
            this.initialized = true;
            return;
        }

        this.minLevel = LOG_LEVELS[options.minLevel] ?? LOG_LEVELS.DEBUG;
        // Use logs directory in project folder (dev mode only)
        this.logDir = path.join(app.getAppPath(), 'logs');
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        this.currentLogFile = path.join(this.logDir, `soundapp-${timestamp}.log`);

        try {
            await fs.mkdir(this.logDir, { recursive: true });
            await this._cleanupOldLogs();
            await this._writeHeader(app);
            this._setupIPC();
            this.initialized = true;
        } catch (err) {
            console.error('[Logger] Failed to initialize:', err);
            this.enabled = false;
        }
    }

    /**
     * Write log file header with app info.
     */
    async _writeHeader(app) {
        const header = [
            '═══════════════════════════════════════════════════════════════',
            `  SoundApp Log`,
            `  Started: ${new Date().toISOString()}`,
            `  Version: ${app.getVersion()}`,
            `  Electron: ${process.versions.electron}`,
            `  Node: ${process.versions.node}`,
            `  Platform: ${process.platform}`,
            '═══════════════════════════════════════════════════════════════',
            ''
        ].join('\n');
        
        await fs.writeFile(this.currentLogFile, header, 'utf8');
    }

    /**
     * Clean up old log files, keeping only the last 10.
     */
    async _cleanupOldLogs() {
        try {
            const files = await fs.readdir(this.logDir);
            const logFiles = files
                .filter(f => f.startsWith('soundapp-') && f.endsWith('.log'))
                .map(f => ({
                    name: f,
                    path: path.join(this.logDir, f),
                    time: fs.stat(path.join(this.logDir, f)).then(s => s.mtime)
                }));
            
            const withStats = await Promise.all(
                logFiles.map(async f => ({ ...f, mtime: await f.time }))
            );
            
            withStats.sort((a, b) => b.mtime - a.mtime);
            
            // Delete logs older than the 10 most recent
            for (const file of withStats.slice(10)) {
                await fs.unlink(file.path).catch(() => {});
            }
        } catch (err) {
            // Directory might not exist yet
        }
    }

    /**
     * Setup IPC handler for renderer process logging.
     */
    _setupIPC() {
        // Only register handler once to avoid "handler already registered" error
        if (this._ipcRegistered) return;
        this._ipcRegistered = true;
        
        // Use 'on' for fire-and-forget messages from renderer
        ipcMain.on('log:message', (event, { level, scope, message, data }) => {
            this._log(level, scope, message, data);
        });
    }

    /**
     * Core logging function.
     */
    _log(level, scope, message, data) {
        if (!this.enabled || this._noop) return;
        if (LOG_LEVELS[level] < this.minLevel) return;

        const timestamp = new Date().toISOString();
        const levelStr = level.padStart(5);
        const scopeStr = scope.padEnd(12);
        
        let line = `[${timestamp}] [${levelStr}] [${scopeStr}] ${message}`;
        
        if (data !== undefined) {
            const dataStr = typeof data === 'object' 
                ? JSON.stringify(data) 
                : String(data);
            line += ` | ${dataStr}`;
        }
        
        line += '\n';
        
        this.writeQueue.push(line);
        this._flush();
    }

    /**
     * Flush queued writes to disk.
     */
    async _flush() {
        if (this.writing || this.writeQueue.length === 0) return;
        
        this.writing = true;
        const batch = this.writeQueue.splice(0, this.writeQueue.length);
        
        try {
            await fs.appendFile(this.currentLogFile, batch.join(''), 'utf8');
        } catch (err) {
            console.error('[Logger] Write failed:', err);
        } finally {
            this.writing = false;
            if (this.writeQueue.length > 0) {
                this._flush();
            }
        }
    }

    // Public API
    debug(scope, message, data) { this._log('DEBUG', scope, message, data); }
    info(scope, message, data) { this._log('INFO', scope, message, data); }
    warn(scope, message, data) { this._log('WARN', scope, message, data); }
    error(scope, message, data) { this._log('ERROR', scope, message, data); }

    /**
     * Get the path to the current log file.
     */
    getLogPath() {
        return this.currentLogFile;
    }

    /**
     * Get the logs directory path.
     */
    getLogDir() {
        return this.logDir;
    }

    /**
     * Check if logging is enabled.
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Capture all console output and redirect to log file.
     * Keeps terminal clean by suppressing console output (optional).
     * 
     * @param {boolean} silent - If true, suppresses terminal output (default: true)
     */
    captureConsole(silent = true) {
        if (!this.enabled) return;

        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;

        console.log = (...args) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this._log('INFO', 'console', message);
            if (!silent) originalLog.apply(console, args);
        };

        console.warn = (...args) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this._log('WARN', 'console', message);
            if (!silent) originalWarn.apply(console, args);
        };

        console.error = (...args) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            this._log('ERROR', 'console', message);
            // Always show errors in terminal even in silent mode
            originalError.apply(console, args);
        };

        // Store originals for restoration if needed
        this._originalConsole = { log: originalLog, warn: originalWarn, error: originalError };
    }

    /**
     * Restore original console methods.
     */
    restoreConsole() {
        if (this._originalConsole) {
            console.log = this._originalConsole.log;
            console.warn = this._originalConsole.warn;
            console.error = this._originalConsole.error;
        }
    }
}

// Singleton instance
module.exports = new Logger();
