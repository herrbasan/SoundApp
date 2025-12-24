class MixerProcessor extends AudioWorkletProcessor {
	constructor(){
		super();
		this.maxTracks = 128;
		this.lg = new Float32Array(this.maxTracks);
		this.rg = new Float32Array(this.maxTracks);
		this.mute = new Uint8Array(this.maxTracks);
		this.meters = new Float32Array(this.maxTracks);
		for(let i=0; i<this.maxTracks; i++){
			this.lg[i] = 1;
			this.rg[i] = 1;
		}
		this._meterCountdown = 0;
		this._meterIntervalFrames = (sampleRate / 30) | 0;
		if(this._meterIntervalFrames < 256) this._meterIntervalFrames = 256;

		this.port.onmessage = (e) => {
			const d = e.data;
			if(!d || !d.t) return;
			if(d.t === 'cfg'){
				const mt = d.maxTracks | 0;
				if(mt > 0 && mt <= 512){
					this.maxTracks = mt;
					this.lg = new Float32Array(this.maxTracks);
					this.rg = new Float32Array(this.maxTracks);
					this.mute = new Uint8Array(this.maxTracks);
					this.meters = new Float32Array(this.maxTracks);
					for(let i=0; i<this.maxTracks; i++){
						this.lg[i] = 1;
						this.rg[i] = 1;
					}
				}
				return;
			}
			if(d.t === 'trk'){
				const i = d.i | 0;
				if(i < 0 || i >= this.maxTracks) return;
				if(d.lg !== undefined) this.lg[i] = +d.lg;
				if(d.rg !== undefined) this.rg[i] = +d.rg;
				if(d.m !== undefined) this.mute[i] = d.m ? 1 : 0;
				return;
			}
			if(d.t === 'rst'){
				for(let i=0; i<this.maxTracks; i++) this.meters[i] = 0;
				return;
			}
		};
	}

	process(inputs, outputs){
		const out = outputs[0];
		if(!out || out.length === 0) return true;

		const out0 = out[0];
		const out1 = out.length > 1 ? out[1] : out[0];
		const n = out0.length | 0;

		for(let j=0; j<n; j++){
			out0[j] = 0;
			out1[j] = 0;
		}

		const inp = inputs;
		const trackCount = inp.length;
		for(let i=0; i<trackCount; i++){
			if(this.mute[i]){ this.meters[i] = 0; continue; }
			const ch = inp[i];
			if(!ch || ch.length === 0){ this.meters[i] = 0; continue; }
			const in0 = ch[0];
			const in1 = ch.length > 1 ? ch[1] : ch[0];
			const lg = this.lg[i];
			const rg = this.rg[i];
			let peak = 0;
			for(let j=0; j<n; j++){
				const l = in0[j] * lg;
				const r = in1[j] * rg;
				out0[j] += l;
				out1[j] += r;
				const al = l < 0 ? -l : l;
				const ar = r < 0 ? -r : r;
				const a = al > ar ? al : ar;
				if(a > peak) peak = a;
			}
			this.meters[i] = peak;
		}

		this._meterCountdown -= n;
		if(this._meterCountdown <= 0){
			this._meterCountdown = this._meterIntervalFrames;
			this.port.postMessage({ t:'m', v: this.meters });
		}

		return true;
	}
}

registerProcessor('soundapp-mixer', MixerProcessor);
