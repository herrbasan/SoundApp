'use strict';

/**
 * WindowManager - Centralized window state and focus management
 * 
 * Handles lifecycle events for child windows (Parameters, Monitoring, Mixer, etc.)
 * and ensures robust focus restoration to the main player window.
 */

const { BrowserWindow } = require('electron');

const WindowManager = {
    // Dependencies
    logger: console,
    mainWin: null, // User instructions: Singleton object pattern, not class

    // State
    windows: {
        parameters: { open: false, visible: false, windowId: null },
        monitoring: { open: false, visible: false, windowId: null },
        mixer: { open: false, visible: false, windowId: null },
        settings: { open: false, visible: false, windowId: null },
        help: { open: false, visible: false, windowId: null }
    },

    // Flag to prevent focus restoration when going to tray
    isGoingToTray: false,

    /**
     * Initialize the manager with dependencies
     * @param {Object} loggerInstance - Logger to use
     * @param {BrowserWindow} mainWindow - Reference to the main player window
     */
    init(loggerInstance, mainWindow) {
        if (loggerInstance) this.logger = loggerInstance;
        this.mainWin = mainWindow;
        this.logger.info('window-manager', 'Initialized WindowManager');
    },

    /**
     * Get the current state of child windows
     * @returns {Object} Reference to windows state object
     */
    getState() {
        return this.windows;
    },

    /**
     * Handle window creation event
     * @param {Object} data - { type, windowId }
     * @param {Function} onNativeHide - Optional callback for native hide event
     */
    handleWindowCreated(data, onNativeHide) {
        if (!data || !data.type) return;

        const type = data.type;
        const windowId = data.windowId;

        this.logger.info('window-manager', 'window-created', { type, windowId });

        // Update state
        if (this.windows[type]) {
            this.windows[type].open = true;
            this.windows[type].windowId = windowId;
            this.windows[type].visible = true;
        }

        // Attach native listeners if window ID is valid
        if (windowId) {
            const childWin = BrowserWindow.fromId(windowId);
            if (childWin && !childWin.isDestroyed()) {

                // Remove existing listeners to avoid duplicates
                childWin.removeAllListeners('hide');

                childWin.on('hide', () => {
                    this.logger.info('window-manager', 'Native window hide event', { type, windowId });

                    // Update internal state
                    if (this.windows[type]) this.windows[type].visible = false;

                    // Notify Main (callback if provided)
                    if (onNativeHide) onNativeHide({ type, windowId });

                    // Restore Focus
                    this.restoreMainFocus('native hide handler');
                });

                childWin.on('close', () => {
                    this.logger.info('window-manager', 'Native window close event', { type, windowId });
                });
            }
        }
    },

    /**
     * Handle window hidden event (from IPC)
     * @param {Object} data - { type, windowId }
     */
    handleWindowHidden(data) {
        const type = data?.type;
        const windowId = data?.windowId;

        this.logger.info('window-manager', 'window-hidden IPC received', { type, windowId });

        if (type && this.windows[type]) {
            this.windows[type].visible = false;
        }

        this.restoreMainFocus('IPC window-hidden');
    },

    /**
     * Handle window closed event (from IPC)
     * @param {Object} data - { type, windowId }
     */
    handleWindowClosed(data) {
        const type = data?.type;

        this.logger.info('window-manager', 'window-closed IPC received', { type });

        if (type && this.windows[type]) {
            this.windows[type].open = false;
            this.windows[type].visible = false;
            this.windows[type].windowId = null;
        }

        this.restoreMainFocus('IPC window-closed');
    },

    /**
     * Toggle a specific window type
     * @param {Object} data - { type }
     * @param {Function} sendToStage - Callback to send command to UI
     */
    toggleWindow(data, sendToStage) {
        const type = data?.type;
        if (!type || !this.windows[type]) return;

        const winState = this.windows[type];

        if (!winState.windowId) {
            // Window doesn't exist yet, ask UI to open it
            this.logger.info('window-manager', 'Opening new window', { type });
            sendToStage('open-window', { type });
        } else {
            // Window exists, check if we can toggle it directly
            const childWin = BrowserWindow.fromId(winState.windowId);
            if (childWin && !childWin.isDestroyed()) {
                if (childWin.isVisible()) {
                    this.logger.info('window-manager', 'Hiding window', { type });
                    // Explicit focus restore happens in 'hide' event handler
                    childWin.hide();
                } else {
                    this.logger.info('window-manager', 'Showing window', { type });
                    childWin.show();
                    winState.visible = true;
                }
            } else {
                // Stale ID, open fresh
                this.logger.warn('window-manager', 'Stale window ID, opening fresh', { type });
                winState.open = false;
                winState.windowId = null;
                sendToStage('open-window', { type });
            }
        }
    },

    /**
     * Robustly restore focus to the main window
     * Handles minimized, hidden, and background states
     * @param {String} reason - For logging
     */
    restoreMainFocus(reason) {
        if (!this.mainWin || this.mainWin.isDestroyed()) return;

        const isMinimized = this.mainWin.isMinimized();
        const isVisible = this.mainWin.isVisible();

        this.logger.debug('window-manager', `Restoring focus (${reason})`, { isMinimized, isVisible });

        // Skip focus restoration if going to tray
        if (this.isGoingToTray) {
            this.logger.debug('window-manager', 'Skipping focus restore - going to tray');
            return;
        }

        // Small timeout to allow OS animations/state updates to settle
        setTimeout(() => {
            if (this.mainWin.isDestroyed()) return;

            // 1. Ensure visible (main window was minimized, not hidden)
            if (!this.mainWin.isVisible()) {
                this.mainWin.show();
            }

            // 2. Ensure not minimized
            if (this.mainWin.isMinimized()) {
                this.mainWin.restore();
            }

            // 3. Force Focus (Windows hack)
            if (process.platform === 'win32') {
                this.mainWin.setAlwaysOnTop(true);
                this.mainWin.show(); // 'show' also focuses
                this.mainWin.focus();
                this.mainWin.setAlwaysOnTop(false);
                // immediate activation
                this.mainWin.moveTop();
            } else {
                this.mainWin.focus();
            }
        }, 50);
    }
};

module.exports = WindowManager;
