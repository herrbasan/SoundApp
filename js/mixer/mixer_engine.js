function createAudioContext(sampleRate){
	const Ctx = window.AudioContext || window.webkitAudioContext;
	return new Ctx(sampleRate ? { sampleRate } : {});
}

function clamp(v, lo, hi){
	if(v < lo) return lo;
	if(v > hi) return hi;
	return v;
}

function panToGains(pan){
	const p = clamp(pan, -1, 1);
	const ang = (p + 1) * 0.25 * Math.PI;
	return { lg: Math.cos(ang), rg: Math.sin(ang) };
}

class MixerTrack {
	constructor(engine, idx){
		this.engine = engine;
		this.idx = idx | 0;
		this.buffer = null;
		this.source = null;
		this.duration = 0;
		this.lastLoadMode = '';
		this.lastLoadError = '';
		this.lastLoadNote = '';
		this._bufStartCtxTime = -1;
		this._bufStartOffset = 0;
		this._gain = 1;
		this._pan = 0;
		this._mute = false;
		this._meter = 0;
		this._sendParams();
	}

	async load(src){
		this.lastLoadError = '';
		this.lastLoadMode = '';
		this.lastLoadNote = '';
		this._stopSource();
		this.buffer = null;
		this.duration = 0;

		// In Electron, if we get a File object, try to use its path to stay in the FFmpeg pipeline.
		if(window.bridge && window.bridge.isElectron && src && typeof src === 'object' && src.path){
			src = src.path;
		}
		
		this.src = src;
		const ctx = this.engine.ctx;
		const initData = this.engine.initData;
		let ab;

		// Electron + FFmpeg path available: use FFmpegStreamPlayer for high-performance streaming
		const canFF = !!(window.bridge && window.bridge.isElectron && initData.ffmpeg_napi_path && initData.ffmpeg_player_path);
		if(canFF && typeof src === 'string' && !src.startsWith('blob:')){
			try {
				const { FFmpegDecoder } = require(initData.ffmpeg_napi_path);
				const { FFmpegStreamPlayer } = require(initData.ffmpeg_player_path);
				FFmpegStreamPlayer.setDecoder(FFmpegDecoder);
				
				// Use the user-configured buffer size, but ensure a minimum of 20 chunks for mixer stability.
				// Force 1 thread per track to avoid CPU over-subscription with many parallel decoders.
				const bufferSize = Math.max(20, (initData.config.bufferSize || 10));
				const player = this.ffPlayer ? this.ffPlayer : new FFmpegStreamPlayer(ctx, initData.ffmpeg_worklet_path, bufferSize, 1, false);
				// Keep player settings in sync with config changes.
				player.prebufferSize = bufferSize;
				let filePath = src;
				if(filePath.startsWith('file:///')) filePath = decodeURIComponent(filePath.substring(8));
				else if(filePath.startsWith('file://')) filePath = decodeURIComponent(filePath.substring(7));
				
				// Connect once per track (gainNode -> mixer input). Reuse player avoids connection leaks.
				if(!this.ffPlayer){
					this.ffPlayer = player;
					this.ffPlayer.connect(this.engine.mixNode, 0, this.idx);
				}
				const info = await this.ffPlayer.open(filePath);
				this.duration = info.duration;
				this.lastLoadMode = 'ff';
				this.lastLoadNote = 'ff ok';
				return;
			} catch(err) {
				this.lastLoadError = (err && (err.stack || err.message)) ? ('' + (err.stack || err.message)) : ('' + err);
				this.lastLoadNote = 'ff failed';
				console.warn('FFmpegStreamPlayer failed, falling back to standard decoding:', err);
				// Ensure the FFmpeg player is not left in a half-initialized state.
				try { if(this.ffPlayer) this.ffPlayer.pause(); } catch(e) {}
			}
		}
		else if(canFF) {
			// We *could* have used FFmpeg, but the source isn't usable for it.
			this.lastLoadNote = (typeof src !== 'string') ? 'ff skipped: src not string' : (src && (''+src).startsWith('blob:') ? 'ff skipped: blob:' : 'ff skipped');
		}
		else {
			this.lastLoadNote = 'ff unavailable';
		}

		// Browser drag&drop: prefer File/Blob directly (more reliable than fetch(blob:...)).
		if(src && typeof src === 'object' && typeof src.arrayBuffer === 'function'){
			ab = await src.arrayBuffer();
		}
		else {
			const urlOrPath = '' + (src || '');
			if(!urlOrPath) throw new Error('Missing audio source');

			if(window.bridge && window.bridge.isElectron && !urlOrPath.startsWith('http') && !urlOrPath.startsWith('blob:')){
				// In Electron, if we have a path, use fs.readFile instead of fetch
				try {
					const fs = require('fs').promises;
					let filePath = urlOrPath;
					if(filePath.startsWith('file:///')) filePath = decodeURIComponent(filePath.substring(8));
					else if(filePath.startsWith('file://')) filePath = decodeURIComponent(filePath.substring(7));
					const buf = await fs.readFile(filePath);
					ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				} catch(e) {
					console.warn('fs.readFile failed, falling back to fetch:', e);
					const res = await fetch(urlOrPath);
					ab = await res.arrayBuffer();
				}
			} else {
				const res = await fetch(urlOrPath);
				ab = await res.arrayBuffer();
			}
		}

		this.buffer = await ctx.decodeAudioData(ab);
		this.duration = this.buffer ? (this.buffer.duration || 0) : 0;
		this.lastLoadMode = 'buf';
		if(!this.lastLoadNote) this.lastLoadNote = 'buf ok';
	}

	_startAt(offsetSec, skipSeek = false){
		if(this.ffPlayer){
			if(!skipSeek) this.ffPlayer.seek(offsetSec);
			this.ffPlayer.play();
			this._bufStartCtxTime = -1;
			return;
		}
		if(!this.buffer) return;
		const ctx = this.engine.ctx;
		const src = ctx.createBufferSource();
		src.buffer = this.buffer;
		src.connect(this.engine.mixNode, 0, this.idx);
		this.source = src;
		this._bufStartCtxTime = ctx.currentTime;
		this._bufStartOffset = offsetSec || 0;
		try { src.start(0, offsetSec); } catch(e) {}
	}

	_stopSource(){
		if(this.ffPlayer){
			this.ffPlayer.pause();
		}
		const src = this.source;
		if(src){
			this.source = null;
			try { src.stop(0); } catch(e) {}
			try { src.disconnect(); } catch(e) {}
		}
		this._bufStartCtxTime = -1;
	}

	_sendParams(){
		const g = this._mute ? 0 : this._gain;
		const pg = panToGains(this._pan);
		this.engine._setTrackParams(this.idx, g * pg.lg, g * pg.rg, this._mute);
	}

	setGain(v){
		this._gain = v;
		this._sendParams();
	}

	setPan(v){
		this._pan = v;
		this._sendParams();
	}

	setMute(on){
		this._mute = !!on;
		this._sendParams();
	}

	getMeter(){
		return this._meter;
	}

	_setMeter(v){
		this._meter = v;
	}

	dispose(){
		this._stopSource();
		if(this.ffPlayer){
			try { this.ffPlayer.stop(); } catch(e) {}
			this.ffPlayer = null;
		}
		this.engine._setTrackParams(this.idx, 0, 0, true);
		this.buffer = null;
	}
}

class MixerTransport {
	constructor(engine){
		this.engine = engine;
		this.state = 'stopped';
		this._offset = 0;
		this._t0 = 0;
	}

	get seconds(){
		if(this.state === 'started'){
			const t = this.engine.ctx.currentTime - this._t0;
			return t >= 0 ? t : 0;
		}
		return this._offset;
	}

	set seconds(v){
		const sec = v >= 0 ? v : 0;
		this._offset = sec;
		if(this.state === 'started'){
			this._t0 = this.engine.ctx.currentTime - this._offset;
			this.engine._seekAll(this._offset);
		}
	}

	start(){
		if(this.state === 'started') return;
		this._t0 = this.engine.ctx.currentTime - this._offset;
		this.state = 'started';
		this.engine._startAll(this._offset);
	}

	pause(){
		if(this.state !== 'started') return;
		this._offset = this.seconds;
		this.state = 'paused';
		this.engine._stopAll();
	}

	stop(){
		this._offset = 0;
		this.state = 'stopped';
		this.engine._stopAll();
	}
}

class MixerEngine {
	constructor(initData){
		this.initData = initData || {};
		this.ctx = createAudioContext(this.initData.currentSampleRate);
		this.masterGain = this.ctx.createGain();
		this.masterGain.gain.value = 1;
		this.masterGain.connect(this.ctx.destination);
		this.maxTracks = 128;
		this.mixNode = null;
		this.Transport = new MixerTransport(this);
		this.tracks = [];
		this._isReady = false;
	}

	async start(){
		if(!this._isReady){
			// Apply output device if configured
			if (this.initData.config && this.initData.config.outputDeviceId && this.ctx.setSinkId) {
				try {
					await this.ctx.setSinkId(this.initData.config.outputDeviceId);
				} catch (err) {
					console.warn('Mixer failed to set output device:', err);
				}
			}

			const url = new URL('./mixer-worklet-processor.js', import.meta.url);
			await this.ctx.audioWorklet.addModule(url);
			this.mixNode = new AudioWorkletNode(this.ctx, 'soundapp-mixer', {
				numberOfInputs: this.maxTracks,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			});
			this.mixNode.connect(this.masterGain);
			this.mixNode.port.postMessage({ t:'cfg', maxTracks: this.maxTracks });
			this.mixNode.port.onmessage = (e) => {
				const d = e.data;
				if(!d || d.t !== 'm' || !d.v) return;
				const v = d.v;
				const ar = this.tracks;
				const n = ar.length;
				for(let i=0; i<n; i++){
					const tr = ar[i];
					if(tr && tr.idx < v.length){
						let mv = v[tr.idx];
						if(mv < 0) mv = 0;
						if(mv > 1) mv = 1;
						tr._setMeter(mv);
					}
				}
			};
			this._isReady = true;
		}
		if(this.ctx.state !== 'running') await this.ctx.resume();
	}

	_setTrackParams(idx, lg, rg, mute){
		if(!this.mixNode) return;
		this.mixNode.port.postMessage({ t:'trk', i: idx|0, lg: +lg, rg: +rg, m: !!mute });
	}

	setMasterGain(v){
		if(this.masterGain){
			this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
		}
	}

	createTrack(){
		let idx = -1;
		for(let i=0; i<this.maxTracks; i++){
			if(!this.tracks[i]){ idx = i; break; }
		}
		if(idx < 0){
			throw new Error('maxTracks exceeded');
		}
		const tr = new MixerTrack(this, idx);
		this.tracks[idx] = tr;
		return tr;
	}

	removeTrack(track){
		if(!track) return;
		const idx = track.idx | 0;
		if(idx >= 0 && idx < this.tracks.length && this.tracks[idx] === track){
			this.tracks[idx] = null;
		}
	}

	_stopAll(){
		const ar = this.tracks;
		for(let i=0; i<ar.length; i++){
			const tr = ar[i];
			if(tr) tr._stopSource();
		}
	}

	_seekAll(offset){
		const ar = this.tracks;
		let hasBuf = false;
		for(let i=0; i<ar.length; i++){
			const tr = ar[i];
			if(!tr) continue;
			if(!tr.ffPlayer && tr.buffer){
				hasBuf = true;
				break;
			}
		}
		// Buffer-based tracks require stop/recreate to seek accurately.
		if(hasBuf){
			this._restartAll();
			return;
		}
		// FFmpeg-only seek: keep nodes connected to avoid reconnect timing offsets.
		for(let i=0; i<ar.length; i++){
			const tr = ar[i];
			if(tr && tr.ffPlayer){
				tr.ffPlayer.seek(offset);
			}
		}
	}

	_startAll(offset){
		const ar = this.tracks;
		// First, ensure all FFmpeg players have their first chunk ready to minimize staggered start.
		for(let i=0; i<ar.length; i++){
			const tr = ar[i];
			if(tr && tr.ffPlayer){
				tr.ffPlayer.seek(offset);
			}
		}
		// Then start them all as close together as possible.
		for(let i=0; i<ar.length; i++){
			const tr = ar[i];
			if(tr) tr._startAt(offset, true);
		}
	}

	_restartAll(){
		this._stopAll();
		if(this.Transport.state === 'started'){
			this._startAll(this.Transport.seconds);
		}
	}

	dispose(){
		this.Transport.stop();
		const ar = this.tracks;
		for(let i=0; i<ar.length; i++){
			const tr = ar[i];
			if(tr) tr.dispose();
		}
		this.tracks.length = 0;
		try { if(this.mixNode) this.mixNode.disconnect(); } catch(e) {}
		try { this.masterGain.disconnect(); } catch(e) {}
		try { this.ctx.close(); } catch(e) {}
	}
}

export { MixerEngine };
