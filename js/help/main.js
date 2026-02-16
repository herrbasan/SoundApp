import ut from '../../libs/nui/nui_ut.js';
import nui from '../../libs/nui/nui.js';

window.ut = ut;
window.nui = nui;

let main = {};

async function init(data) {
	console.log('Help window initialized:', data);

	if (window.bridge && window.bridge.isElectron) {
		console.log('Help: Checking window.shortcuts:', window.shortcuts);
		window.addEventListener('keydown', (e) => {
			const code = e.code || '';

			// Handle global shortcuts via shared module
			let action = '';
			if (window.shortcuts && window.shortcuts.handleShortcut) {
				action = window.shortcuts.handleShortcut(e, 'help');
			}

			// Local overrides: H or Escape closes help
			if (action === 'toggle-help' || code === 'Escape') {
				e.preventDefault();
				window.bridge.closeWindow();
				return;
			}

			// F12: Toggle DevTools
			if (code === 'F12') {
				e.preventDefault();
				if (window.bridge.toggleDevTools) window.bridge.toggleDevTools();
				return;
			}

			if (action) return;

			// Relay playback shortcuts to stage (volume, seek, play/pause, loop, shuffle, prev/next)
			if (window.bridge.sendToStage) {
				window.bridge.sendToStage('stage-keydown', {
					keyCode: e.keyCode | 0,
					code: e.code || '',
					key: e.key || '',
					ctrlKey: !!e.ctrlKey,
					shiftKey: !!e.shiftKey,
					altKey: !!e.altKey,
					metaKey: !!e.metaKey
				});
			}
		});
	}
}

main.init = init;
export { main };
