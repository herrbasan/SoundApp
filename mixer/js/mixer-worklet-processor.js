class MixerProcessor extends AudioWorkletProcessor {
	constructor(){
		super();
		this.maxTracks = 128;
		this.lg = new Float32Array(this.maxTracks);
		this.rg = new Float32Array(this.maxTracks);
		this.mute = new Uint8Array(this.maxTracks);
		this.meters = new Float32Array(this.maxTracks);
		this.m1 = new Float32Array(this.maxTracks); // HPF state
		this.m2 = new Float32Array(this.maxTracks); // LPF state
		this.m3 = new Float32Array(this.maxTracks); // Last input state
		for(let i=0; i<this.maxTracks; i++){
			this.lg[i] = 1;
			this.rg[i] = 1;
		}
		this._meterCountdown = 0;
		this._meterIntervalFrames = (sampleRate / 60) | 0;
		if(this._meterIntervalFrames < 128) this._meterIntervalFrames = 128;

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
					this.m1 = new Float32Array(this.maxTracks);
					this.m2 = new Float32Array(this.maxTracks);
					this.m3 = new Float32Array(this.maxTracks);
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
			let m1 = this.m1[i];
			let m2 = this.m2[i];
			let m3 = this.m3[i];

			let blockPeak = 0;
			for(let j=0; j<n; j++){
				const l = in0[j] * lg;
				const r = in1[j] * rg;
				out0[j] += l;
				out1[j] += r;

				// Simple band-pass for metering (approx 200Hz - 5kHz)
				// This reduces sensitivity to sub-bass and extreme highs (hi-hats)
				const s = (l + r) * 0.5;
				m1 = s - m3 + 0.97 * m1; // HPF
				m3 = s;
				m2 = m2 + 0.35 * (m1 - m2); // LPF

				const a = m2 < 0 ? -m2 : m2;
				if(a > blockPeak) blockPeak = a;
			}
			this.m1[i] = m1;
			this.m2[i] = m2;
			this.m3[i] = m3;
			
			if(blockPeak > this.meters[i]){
				this.meters[i] = blockPeak;
			} else {
				this.meters[i] *= 0.985; // Smooth decay
				if(this.meters[i] < 0.0001) this.meters[i] = 0;
			}
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
