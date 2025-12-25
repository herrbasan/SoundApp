function createAudioContext(){
	const Ctx = window.AudioContext || window.webkitAudioContext;
	return new Ctx();
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
		this._gain = 1;
		this._pan = 0;
		this._mute = false;
		this._meter = 0;
		this._sendParams();
	}

	async load(src){
		const ctx = this.engine.ctx;
		let ab;

		// Browser drag&drop: prefer File/Blob directly (more reliable than fetch(blob:...)).
		if(src && typeof src === 'object' && typeof src.arrayBuffer === 'function'){
			ab = await src.arrayBuffer();
		}
		else {
			const url = '' + (src || '');
			if(!url) throw new Error('Missing audio source');

			// In browser preview, Windows paths cannot be fetched (and file:// is blocked).
			const isWinAbs = /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('\\\\');
			if(isWinAbs && !(window.bridge && window.bridge.isElectron)){
				throw new Error('Browser preview cannot load Windows file paths. Use drag&drop or run in Electron.');
			}

			const res = await fetch(url);
			ab = await res.arrayBuffer();
		}

		this.buffer = await ctx.decodeAudioData(ab);
		this.duration = this.buffer ? (this.buffer.duration || 0) : 0;
	}

	_startAt(offsetSec){
		if(!this.buffer) return;
		const ctx = this.engine.ctx;
		const src = ctx.createBufferSource();
		src.buffer = this.buffer;
		src.connect(this.engine.mixNode, 0, this.idx);
		this.source = src;
		try { src.start(0, offsetSec); } catch(e) {}
	}

	_stopSource(){
		const src = this.source;
		if(src){
			this.source = null;
			try { src.stop(0); } catch(e) {}
			try { src.disconnect(); } catch(e) {}
		}
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
			this.engine._restartAll();
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
	constructor(){
		this.ctx = createAudioContext();
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
		const idx = this.tracks.length | 0;
		if(idx >= this.maxTracks){
			throw new Error('maxTracks exceeded');
		}
		const tr = new MixerTrack(this, idx);
		this.tracks.push(tr);
		return tr;
	}

	_stopAll(){
		const ar = this.tracks;
		for(let i=0; i<ar.length; i++) ar[i]._stopSource();
	}

	_startAll(offset){
		const ar = this.tracks;
		for(let i=0; i<ar.length; i++) ar[i]._startAt(offset);
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
		for(let i=0; i<ar.length; i++) ar[i].dispose();
		this.tracks.length = 0;
		try { if(this.mixNode) this.mixNode.disconnect(); } catch(e) {}
		try { this.masterGain.disconnect(); } catch(e) {}
		try { this.ctx.close(); } catch(e) {}
	}
}

export { MixerEngine };
