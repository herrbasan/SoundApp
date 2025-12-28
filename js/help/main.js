import ut from '../../libs/nui/nui_ut.js';
import nui from '../../libs/nui/nui.js';

window.ut = ut;
window.nui = nui;

let main = {};

function init(data) {
	console.log('Help window initialized:', data);

	if (window.bridge && window.bridge.isElectron) {
		const shortcuts = require('../js/shortcuts.js');
		window.addEventListener('keydown', (keyEvent) => {
			shortcuts.handleShortcut(keyEvent, 'help');
		});
	}
}

main.init = init;
export { main };
