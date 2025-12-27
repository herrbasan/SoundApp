'use strict';

module.exports = {
	config_version: 1,
	transcode: {
		ext: '.wav',
		cmd: '-c:a pcm_s16le'
	},

	// Legacy (kept for backward compatibility until Phase 5 adoption)
	space: 14,
	win_min_width: 480,
	win_min_height: 217,

	volume: 0.5,
	theme: 'dark',
	hqMode: false,
	bufferSize: 10,
	decoderThreads: 0,
	modStereoSeparation: 100,
	modInterpolationFilter: 0,
	outputDeviceId: '',
	defaultDir: '',
	mixerPreBuffer: 50,

	// v1 structure (used by upcoming window/bounds phases)
	windows: {
		main: { x: null, y: null, width: 480, height: 217, scale: 14 },
		help: { x: null, y: null, width: 800, height: 700, scale: 14 },
		settings: { x: null, y: null, width: 500, height: 700, scale: 14 },
		playlist: { x: null, y: null, width: 960, height: 700, scale: 14 },
		mixer: { x: null, y: null, width: 1100, height: 760, scale: 14 }
	}
};
