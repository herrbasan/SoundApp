'use strict';

function _clone(o){
	return (o && typeof o === 'object') ? JSON.parse(JSON.stringify(o)) : {};
}

function _numOr(v, fb){
	v = (v === undefined || v === null) ? NaN : +v;
	return isFinite(v) ? v : fb;
}

function _pickStr(v, fb){
	return (typeof v === 'string') ? v : fb;
}

function _pickBool(v, fb){
	return (typeof v === 'boolean') ? v : !!fb;
}

function _repairWindows(loaded, defaults){
	const dWin = (defaults && defaults.windows) ? defaults.windows : {};
	const lWin = (loaded && loaded.windows && typeof loaded.windows === 'object') ? loaded.windows : null;

	const out = {
		main: _clone(dWin.main || {}),
		help: _clone(dWin.help || {}),
		settings: _clone(dWin.settings || {}),
		playlist: _clone(dWin.playlist || {}),
		mixer: _clone(dWin.mixer || {})
	};

	if(lWin){
		if(lWin.main) out.main = { ...out.main, ...lWin.main };
		if(lWin.help) out.help = { ...out.help, ...lWin.help };
		if(lWin.settings) out.settings = { ...out.settings, ...lWin.settings };
		if(lWin.playlist) out.playlist = { ...out.playlist, ...lWin.playlist };
		if(lWin.mixer) out.mixer = { ...out.mixer, ...lWin.mixer };
	}

	// Legacy → v1 bridge: Stage previously stored bounds in `window` + scale in `space`.
	if(!lWin || !lWin.main){
		const legacyBounds = (loaded && loaded.window && typeof loaded.window === 'object') ? loaded.window : null;
		if(legacyBounds){
			if(legacyBounds.x !== undefined) out.main.x = legacyBounds.x;
			if(legacyBounds.y !== undefined) out.main.y = legacyBounds.y;
			if(legacyBounds.width !== undefined) out.main.width = legacyBounds.width;
			if(legacyBounds.height !== undefined) out.main.height = legacyBounds.height;
		}
	}

	const legacyScale = (loaded && loaded.space !== undefined) ? (loaded.space | 0) : undefined;
	if(isFinite(legacyScale) && legacyScale > 0){
		out.main.scale = legacyScale;
		out.help.scale = legacyScale;
		out.settings.scale = legacyScale;
		out.playlist.scale = legacyScale;
		out.mixer.scale = legacyScale;
	}

	return out;
}

function migrateUserConfig(loadedConfig, defaults){
	const loaded = (loadedConfig && typeof loadedConfig === 'object') ? loadedConfig : {};
	const def = (defaults && typeof defaults === 'object') ? defaults : {};

	const out = { ..._clone(def), ..._clone(loaded) };

	// Versioning
	let v = (loaded.config_version !== undefined) ? (loaded.config_version | 0) : 0;
	if(!isFinite(v) || v < 0) v = 0;

	// v0 → v1: introduce `config_version` + `windows` structure.
	if(v < 1){
		out.config_version = 1;
		out.windows = _repairWindows(loaded, def);

		// Keep legacy fields until Phase 5 adoption updates all reads/writes.
		// - `space` and `window` are still used by Stage.
		// - Later phases will migrate Stage to `windows.main.*`.
		out.space = (loaded.space !== undefined) ? (loaded.space | 0) : _numOr(def.space, 14);
		if(out.space < 14) out.space = 14;

		if(loaded.window && typeof loaded.window === 'object'){
			out.window = { ...loaded.window };
		}
		else {
			const m = out.windows && out.windows.main ? out.windows.main : null;
			if(m){
				out.window = { x: m.x, y: m.y, width: m.width, height: m.height };
			}
		}
	}

	// Ensure common keys exist with sane defaults
	out.volume = _numOr(out.volume, _numOr(def.volume, 0.5));
	if(out.volume < 0) out.volume = 0;
	if(out.volume > 1) out.volume = 1;

	out.theme = _pickStr(out.theme, _pickStr(def.theme, 'dark'));
	out.hqMode = _pickBool(out.hqMode, _pickBool(def.hqMode, false));

	out.bufferSize = _numOr(out.bufferSize, _numOr(def.bufferSize, 10)) | 0;
	out.decoderThreads = _numOr(out.decoderThreads, _numOr(def.decoderThreads, 0)) | 0;
	out.modStereoSeparation = _numOr(out.modStereoSeparation, _numOr(def.modStereoSeparation, 100)) | 0;
	out.modInterpolationFilter = _numOr(out.modInterpolationFilter, _numOr(def.modInterpolationFilter, 0)) | 0;
	out.outputDeviceId = _pickStr(out.outputDeviceId, _pickStr(def.outputDeviceId, ''));
	out.defaultDir = _pickStr(out.defaultDir, _pickStr(def.defaultDir, ''));
	out.mixerPreBuffer = _numOr(out.mixerPreBuffer, _numOr(def.mixerPreBuffer, 50)) | 0;

	if(!out.transcode || typeof out.transcode !== 'object') out.transcode = _clone(def.transcode || {});
	if(out.transcode.ext === undefined) out.transcode.ext = _pickStr(def.transcode && def.transcode.ext, '.wav');
	if(out.transcode.cmd === undefined) out.transcode.cmd = _pickStr(def.transcode && def.transcode.cmd, '-c:a pcm_s16le');

	// Windows repair always (protect against shallow merge and future additions)
	out.windows = _repairWindows(out, def);

	return out;
}

module.exports = { migrateUserConfig };
