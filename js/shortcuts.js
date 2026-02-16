// Centralized keyboard shortcuts for all windows
// Import this in stage.js, help.html, settings.html to handle shortcuts consistently

const shortcuts = {
	H: { key: 72, action: 'toggle-help', description: 'Toggle Help Window' },
	S: { key: 83, action: 'toggle-settings', description: 'Toggle Settings Window' },
	M: { key: 77, action: 'toggle-mixer', description: 'Toggle Mixer Window' },
	P: { key: 80, action: 'toggle-pitchtime', description: 'Toggle Pitch/Time or MIDI Settings' },
	X: { key: 88, action: 'toggle-theme', description: 'Toggle Theme' },
	C: { key: 67, action: 'toggle-controls', description: 'Toggle Controls Bar' },
	N: { key: 78, action: 'toggle-monitoring', description: 'Toggle Monitoring Window' }
};

function handleShortcut(e, windowType = 'stage') {
	const shortcut = Object.values(shortcuts).find(s => s.key === e.keyCode);
	if (!shortcut) return false;

	// Don't interfere with normal typing - only handle when not in input fields
	const target = e.target || e.srcElement;
	if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
		return false;
	}

	// Prevent default to avoid key propagation
	e.preventDefault();

	// Map window types to their toggle actions to prevent IPC loop/race
	const selfToggleMap = {
		'monitoring': 'toggle-monitoring',
		'mixer': 'toggle-mixer',
		'help': 'toggle-help',
		'settings': 'toggle-settings',
		'parameters': 'toggle-pitchtime'
	};

	// Send command to appropriate handler based on window type
	if (windowType !== 'stage') {
		const isSelfToggle = selfToggleMap[windowType] === shortcut.action;

		// Only forward if it's NOT a self-toggle (self-toggles are handled locally by the window to close itself)
		if (!isSelfToggle && typeof window.bridge !== 'undefined') {
			// Map actions to window types for direct Main Process toggling
			const actionToWindowType = {
				'toggle-monitoring': 'monitoring',
				'toggle-mixer': 'mixer',
				'toggle-help': 'help',
				'toggle-settings': 'settings',
				'toggle-pitchtime': 'parameters'
			};

			const targetWindowType = actionToWindowType[shortcut.action];

			if (targetWindowType) {
				// Send directly to Main Process (app.js handles window:toggle)
				window.bridge.sendToMain('window:toggle', { type: targetWindowType });
			} else if (shortcut.action === 'toggle-theme') {
				// Toggle theme is handled by Main Process
				window.bridge.sendToMain('command', { command: 'toggle-theme' });
			} else {
				// Fallback: Send to stage (Player) for other actions (e.g. toggle-controls)
				window.bridge.sendToStage('shortcut', { action: shortcut.action });
			}
		}
	} else {
		// Stage window handles directly (return action for caller to handle)
		return shortcut.action;
	}

	return shortcut.action;
}

// For browser context (non-Electron preview)
if (typeof module !== 'undefined' && module.exports) {
	module.exports = { shortcuts, handleShortcut };
}

// For ES modules
if (typeof window !== 'undefined') {
	window.shortcuts = { shortcuts, handleShortcut };
}
