'use strict';

const WINDOW_DIMENSIONS = {
	MIN_WIDTH: 480,
	MIN_HEIGHT_WITH_CONTROLS: 278,
	MIN_HEIGHT_WITHOUT_CONTROLS: 221
};

module.exports = {
	WINDOW_DIMENSIONS,
	config_version: 2,

	ui: {
		theme: 'dark',
		defaultDir: '',
		keepRunningInTray: false,
		showControls: false
	},

	audio: {
		volume: 0.5,
		output: { deviceId: '' },
		hqMode: false
	},

	ffmpeg: {
		stream: { prebufferChunks: 50 },
		decoder: { threads: 0 },
		transcode: { ext: '.wav', cmd: '-c:a pcm_s16le' }
	},

	tracker: {
		stereoSeparation: 100,
		interpolationFilter: 0
	},

	mixer: {
		preBuffer: 50,
		useSAB: false  // Experimental: use SharedArrayBuffer player instead of postMessage
	},

	// Window/bounds persistence
	windows: {
		main: { x: null, y: null, width: 480, height: 221, scale: 14 },
		help: { x: null, y: null, width: 1024, height: 768, scale: 14 },
		settings: { x: null, y: null, width: 1024, height: 768, scale: 14 },
		playlist: { x: null, y: null, width: 1024, height: 768, scale: 14 },
		mixer: { x: null, y: null, width: 1024, height: 768, scale: 14 }
	}
};
