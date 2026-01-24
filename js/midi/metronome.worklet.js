const INVALID_POINTER = 0;

class SoundAppMetronome {
	constructor() {
		this.enabled = false;
		this.ppq = 96;
		this.timeSignatures = [{ tick: 0, n: 4, d: 4 }];
		this.high = null;
		this.low = null;
		this.highGain = 1.0;
		this.lowGain = 0.7;
		this.nextTick = null;
		this.voices = [];
		this._active = false;
		this._tick0 = 0;
		this._frames = 0;
		this._sampleRate = 44100;
		this._tsTick = 0;
		this._beatTicks = 0;
		this._tickSpan = 0;
	}
	configure(param) {
		if (!param) return;
		if (typeof param.enabled === 'boolean') this.enabled = param.enabled;
		if (typeof param.ppq === 'number' && param.ppq > 0) this.ppq = param.ppq;
		if (Array.isArray(param.timeSignatures) && param.timeSignatures.length) {
			this.timeSignatures = param.timeSignatures.slice().sort((a, b) => (a.tick || 0) - (b.tick || 0));
		}
		if (typeof param.highGain === 'number') this.highGain = param.highGain;
		if (typeof param.lowGain === 'number') this.lowGain = param.lowGain;
		if (param.highBuffer instanceof ArrayBuffer) {
			this.high = this.decodeWav(param.highBuffer);
		}
		if (param.lowBuffer instanceof ArrayBuffer) {
			this.low = this.decodeWav(param.lowBuffer);
		}
		if (param.reset) this.nextTick = null;
		if (!this.enabled) this.nextTick = null;
		if (param.reset || !this.enabled) {
			this.voices.length = 0;
		}
		if (typeof param.resetTick === 'number' && param.resetTick >= 0) {
			const ts = this.getTimeSignature(param.resetTick);
			const beatTicks = this.calcBeatTicks(ts);
			this.nextTick = this.nextBeatTick(param.resetTick, ts.tick || 0, beatTicks);
			this._tsTick = ts.tick || 0;
			this._beatTicks = beatTicks;
		}
	}
	beginBlock(synth, frames, sampleRate) {
		if (!this.enabled || !this.high || !this.low) {
			this._active = false;
			return;
		}
		if (!synth || !synth._playerPlaying || synth._player === INVALID_POINTER) {
			this._active = false;
			return;
		}
		const wasm = AudioWorkletGlobalScope.wasmModule;
		if (!wasm) {
			this._active = false;
			return;
		}
		this._tick0 = wasm._fluid_player_get_current_tick(synth._player);
		if (this.nextTick !== null && this.nextTick < this._tick0) {
			const ts = this.getTimeSignature(this._tick0);
			const beatTicks = this.calcBeatTicks(ts);
			this.nextTick = this.nextBeatTick(this._tick0, ts.tick || 0, beatTicks);
			this._tsTick = ts.tick || 0;
			this._beatTicks = beatTicks;
		}
		let tempo = wasm._fluid_player_get_midi_tempo(synth._player);
		if (!(tempo > 0)) tempo = 500000;
		const ticksPerSecond = (1000000 / tempo) * this.ppq;
		this._tickSpan = (frames / sampleRate) * ticksPerSecond;
		this._frames = frames;
		this._sampleRate = sampleRate;
		this._active = true;
	}
	endBlock(outputs, synth) {
		if (!this._active) return;
		const tickSpan = this._tickSpan || 0;
		if (!(tickSpan > 0)) return;
		const tick1 = this._tick0 + tickSpan;
		let nextTick = this.nextTick;
		if (nextTick === null) {
			const ts0 = this.getTimeSignature(this._tick0);
			const beatTicks0 = this.calcBeatTicks(ts0);
			nextTick = this.nextBeatTick(this._tick0, ts0.tick || 0, beatTicks0);
			this._tsTick = ts0.tick || 0;
			this._beatTicks = beatTicks0;
		}
		const out = outputs[0];
		while (nextTick !== null && nextTick <= tick1) {
			const ts = this.getTimeSignature(nextTick);
			const beatTicks = this.calcBeatTicks(ts);
			if (ts.tick !== this._tsTick || beatTicks !== this._beatTicks) {
				this._tsTick = ts.tick || 0;
				this._beatTicks = beatTicks;
				if (nextTick < (ts.tick || 0)) nextTick = ts.tick || 0;
				const rel = nextTick - (ts.tick || 0);
				const aligned = (ts.tick || 0) + Math.ceil(rel / beatTicks) * beatTicks;
				if (aligned !== nextTick) nextTick = aligned;
			}
			const beatsSince = Math.floor((nextTick - (ts.tick || 0)) / beatTicks);
			const isAccent = (beatsSince % (ts.n || 4)) === 0;
			const frameOffset = Math.round(((nextTick - this._tick0) / tickSpan) * this._frames);
			this.addVoice(isAccent ? this.high : this.low, isAccent ? this.highGain : this.lowGain, frameOffset, this._sampleRate);
			nextTick += beatTicks;
		}
		this.nextTick = nextTick;
		this.mixVoices(out);
	}
	getTimeSignature(tick) {
		let ts = { tick: 0, n: 4, d: 4 };
		const arr = this.timeSignatures || [];
		for (let i = 0; i < arr.length; i++) {
			const t = arr[i];
			if (t && typeof t.tick === 'number' && t.tick <= tick) ts = t;
		}
		return ts;
	}
	calcBeatTicks(ts) {
		const d = ts.d || 4;
		return Math.max(1, Math.round((this.ppq * 4) / d));
	}
	nextBeatTick(tick, base, beatTicks) {
		const rel = tick - base;
		if (rel <= 0) return base;
		return base + Math.ceil(rel / beatTicks) * beatTicks;
	}
	addVoice(sample, gain, frameOffset, outRate) {
		if (!sample || !sample.data || !sample.data[0]) return;
		let start = frameOffset | 0;
		if (start < 0) start = 0;
		this.voices.push({
			sample: sample,
			gain: gain,
			start: start,
			pos: 0,
			step: sample.sampleRate / outRate
		});
	}
	mixVoices(out) {
		if (!out || !out[0] || !this.voices.length) return;
		const outL = out[0];
		const outR = out[1] || outL;
		const frames = outL.length;
		const voices = this.voices;
		let w = 0;
		for (let v = 0; v < voices.length; v++) {
			const voice = voices[v];
			const sample = voice.sample;
			const ch0 = sample.data[0];
			const ch1 = sample.data[1] || ch0;
			let i = voice.start;
			let pos = voice.pos;
			const step = voice.step;
			if (i < 0) i = 0;
			for (; i < frames && pos < ch0.length - 1; i++) {
				const idx = pos | 0;
				const frac = pos - idx;
				const v0 = ch0[idx] + (ch0[idx + 1] - ch0[idx]) * frac;
				const v1 = ch1[idx] + (ch1[idx + 1] - ch1[idx]) * frac;
				outL[i] += v0 * voice.gain;
				if (outR !== outL) outR[i] += v1 * voice.gain;
				pos += step;
			}
			voice.pos = pos;
			voice.start = 0;
			if (pos < ch0.length - 1) {
				voices[w++] = voice;
			}
		}
		voices.length = w;
	}
	decodeWav(buf) {
		try {
			const dv = new DataView(buf);
			if (dv.getUint32(0, false) !== 0x52494646) return null; // RIFF
			if (dv.getUint32(8, false) !== 0x57415645) return null; // WAVE
			let offset = 12;
			let fmt = null;
			let dataOffset = 0;
			let dataSize = 0;
			while (offset + 8 <= dv.byteLength) {
				const id = dv.getUint32(offset, false);
				const size = dv.getUint32(offset + 4, true);
				offset += 8;
				if (id === 0x666d7420) { // fmt 
					fmt = {
						audioFormat: dv.getUint16(offset, true),
						numChannels: dv.getUint16(offset + 2, true),
						sampleRate: dv.getUint32(offset + 4, true),
						bitsPerSample: dv.getUint16(offset + 14, true)
					};
				} else if (id === 0x64617461) { // data
					dataOffset = offset;
					dataSize = size;
				}
				offset += size + (size & 1);
			}
			if (!fmt || !dataOffset || !dataSize) return null;
			const numChannels = fmt.numChannels || 1;
			const bits = fmt.bitsPerSample || 16;
			const audioFormat = fmt.audioFormat || 1;
			const bytesPerSample = bits >> 3;
			const frameCount = Math.floor(dataSize / (bytesPerSample * numChannels));
			const ch = new Array(numChannels);
			for (let c = 0; c < numChannels; c++) ch[c] = new Float32Array(frameCount);
			let p = dataOffset;
			for (let i = 0; i < frameCount; i++) {
				for (let c = 0; c < numChannels; c++) {
					let v = 0;
					if (audioFormat === 3 && bits === 32) v = dv.getFloat32(p, true);
					else if (bits === 16) v = dv.getInt16(p, true) / 32768;
					else if (bits === 24) {
						let x = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
						if (x & 0x800000) x |= 0xff000000;
						v = x / 8388608;
					} else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
					ch[c][i] = v;
					p += bytesPerSample;
				}
			}
			return { sampleRate: fmt.sampleRate || 44100, data: ch };
		} catch (e) {
			return null;
		}
	}
}

AudioWorkletGlobalScope.SoundAppMetronome = new SoundAppMetronome();
AudioWorkletGlobalScope.SoundAppMetronomeConfig = function (_synth, param) {
	const metro = AudioWorkletGlobalScope.SoundAppMetronome;
	if (metro) metro.configure(param);
};
