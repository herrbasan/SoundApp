// Centralized keyboard shortcuts for all windows
// Import this in stage.js, help.html, settings.html to handle shortcuts consistently

const shortcuts = {
	H: { key: 72, action: 'toggle-help', description: 'Toggle Help Window' },
	S: { key: 83, action: 'toggle-settings', description: 'Toggle Settings Window' },
	X: { key: 88, action: 'toggle-theme', description: 'Toggle Theme' }
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
	
	// Send command to appropriate handler based on window type
	if (windowType !== 'stage') {
		// Help/Settings windows forward to stage via bridge
		if (typeof window.bridge !== 'undefined') {
			window.bridge.sendToStage('shortcut', { action: shortcut.action });
		}
	} else {
		// Stage window handles directly
		return shortcut.action;
	}
	
	return true;
}

// For browser context (non-Electron preview)
if (typeof module !== 'undefined' && module.exports) {
	module.exports = { shortcuts, handleShortcut };
}

// For ES modules
if (typeof window !== 'undefined') {
	window.shortcuts = { shortcuts, handleShortcut };
}
