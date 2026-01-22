const fs = require('fs');
const path = require('path');

const wasmModulePath = path.join(__dirname, '../libs/rubberband-wasm/wasm/build/rubberband.js');
const outputPath = path.join(__dirname, '../libs/rubberband/realtime-pitch-shift-processor.js');

// Read the original WASM module
let wasmModule = fs.readFileSync(wasmModulePath, 'utf8');

// Find where to cut (before CJS/AMD exports)
const endMarker = ';return moduleRtn}})();';
const endIdx = wasmModule.indexOf(endMarker);
if (endIdx === -1) {
	console.error('End marker not found in rubberband.js');
	process.exit(1);
}
wasmModule = wasmModule.substring(0, endIdx + endMarker.length);

// Rename Module to createRubberBandModule for clarity
wasmModule = wasmModule.replace('var Module=(', 'var createRubberBandModule=(');

const header = `// ═══════════════════════════════════════════════════════════════════════════════
// Realtime Pitch Shift AudioWorklet Processor
// Vanilla JS wrapper for RubberBand WASM
// 
// This file contains:
// 1. Emscripten-compiled RubberBand WASM module (with embedded base64 WASM)
// 2. HeapArray helper for WASM memory management
// 3. RealtimeRubberBandWrapper class
// 4. AudioWorkletProcessor implementation
//
// Based on rubberband-web by delude88 (GPL-2.0-or-later)
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Emscripten WASM Module (auto-generated, do not edit)
// ─────────────────────────────────────────────────────────────────────────────

`;

const processorCode = `

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Vanilla JS Worklet Implementation (editable)
// ─────────────────────────────────────────────────────────────────────────────

const RENDER_QUANTUM = 128;
const BYTES_PER_SAMPLE = 4;  // Float32
const BYTES_PER_UNIT = 2;    // Uint16 (for pointer math: >>2 for float32)

// HeapArray - Manages Float32Array data on WASM heap
class HeapArray {
	constructor(module, length, channelCount) {
		this.module = module;
		this.length = length;
		this.channelCount = channelCount || 1;
		this.channelData = [];
		this.heapBuffer = null;
		
		const channelByteSize = this.length * BYTES_PER_SAMPLE;
		const totalBytes = this.channelCount * channelByteSize;
		this.dataPtr = this.module._malloc(totalBytes);
		this._refreshViews(channelByteSize);
	}
	
	_refreshViews(channelByteSize) {
		const heap = this.module.HEAPF32;
		if (!heap) return;
		
		const heapBuf = heap.buffer;
		if (this.heapBuffer === heapBuf && heapBuf.byteLength !== 0 && this.channelData.length === this.channelCount) {
			return;
		}
		
		this.heapBuffer = heapBuf;
		const perChannelBytes = channelByteSize || (this.length * BYTES_PER_SAMPLE);
		
		for (let ch = 0; ch < this.channelCount; ++ch) {
			const startOffset = this.dataPtr + ch * perChannelBytes;
			const endOffset = startOffset + perChannelBytes;
			this.channelData[ch] = this.module.HEAPF32.subarray(startOffset >> BYTES_PER_UNIT, endOffset >> BYTES_PER_UNIT);
		}
	}
	
	getChannelArray(channel) {
		this._refreshViews();
		return this.channelData[channel];
	}
	
	getHeapAddress() {
		return this.dataPtr;
	}
	
	close() {
		this.module._free(this.dataPtr);
	}
}

// RealtimeRubberBandWrapper - JS wrapper around WASM kernel
class RealtimeRubberBandWrapper {
	constructor(module, sampleRate, channelCount, options) {
		this._channelCount = channelCount;
		this._highQuality = options?.highQuality || false;
		this._formantPreserved = options?.formantPreserved || false;
		this._transients = options?.transients || 'mixed';
		this._detector = options?.detector || 'compound';
		this._blockSize = Math.max(RENDER_QUANTUM, (options?.blockSize || RENDER_QUANTUM) | 0);
		this._tempo = options?.tempo || 1;
		this._pitch = options?.pitch || 1;
		
		const transientsMap = { mixed: 0, crisp: 1, smooth: 2 };
		const detectorMap = { compound: 0, percussive: 1, soft: 2 };
		const transientsInt = transientsMap[this._transients] || 0;
		const detectorInt = detectorMap[this._detector] || 0;
		
		const Kernel = module.RealtimeRubberBand;
		this._kernel = new Kernel(sampleRate, channelCount, this._highQuality, this._formantPreserved, transientsInt, detectorInt, this._blockSize);
		this._inputArray = new HeapArray(module, this._blockSize, channelCount);
		this._outputArray = new HeapArray(module, RENDER_QUANTUM, channelCount);
		
		this._kernel.setPitch(this._pitch);
		this._kernel.setTempo(this._tempo);
	}
	
	get channelCount() { return this._channelCount; }
	get highQuality() { return this._highQuality; }
	get formantPreserved() { return this._formantPreserved; }
	get transients() { return this._transients; }
	get detector() { return this._detector; }
	get samplesAvailable() { return this._kernel?.getSamplesAvailable() || 0; }
	
	get timeRatio() { return this._tempo; }
	set timeRatio(v) {
		this._tempo = v;
		this._kernel.setTempo(v);
	}
	
	set pitchScale(v) {
		this._pitch = v;
		this._kernel.setPitch(v);
	}
	
	push(channels, numSamples) {
		const channelCount = channels.length;
		if (channelCount <= 0) return;
		
		for (let ch = 0; ch < channelCount; ++ch) {
			this._inputArray.getChannelArray(ch).set(channels[ch]);
		}
		const n = (numSamples || RENDER_QUANTUM) | 0;
		this._kernel.push(this._inputArray.getHeapAddress(), Math.min(n, this._blockSize));
	}
	
	pull(channels) {
		const channelCount = channels.length;
		if (channelCount <= 0) return channels;
		
		this._kernel.pull(this._outputArray.getHeapAddress(), RENDER_QUANTUM);
		
		for (let ch = 0; ch < channelCount; ++ch) {
			channels[ch].set(this._outputArray.getChannelArray(ch));
		}
		return channels;
	}
}

// AudioWorklet Processor
class RealtimePitchShiftProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this._module = null;
		this._api = null;
		this.running = true;
		this.pitch = 1;
		this.tempo = 1;
		this.highQuality = false;
		this.formantPreserved = false;
		this.transients = 'mixed';
		this.detector = 'compound';
		this.blockSize = 512;
		this._inputBuffers = null;
		this._inputWriteIndex = 0;
		
		const bs = options?.processorOptions?.blockSize;
		if (typeof bs === 'number' && isFinite(bs)) {
			this.blockSize = (bs | 0) || 512;
		}
		if (this.blockSize < 128) this.blockSize = 128;
		
		this.port.onmessage = (e) => {
			const data = JSON.parse(e.data);
			const event = data[0];
			const payload = data[1];
			
			switch (event) {
				case 'pitch':
					this.pitch = payload;
					if (this._api) this._api.pitchScale = this.pitch;
					break;
				case 'quality':
					this.highQuality = payload;
					break;
				case 'options':
					if (payload.highQuality !== undefined) this.highQuality = payload.highQuality;
					if (payload.formantPreserved !== undefined) this.formantPreserved = payload.formantPreserved;
					if (payload.transients !== undefined) this.transients = payload.transients;
					if (payload.detector !== undefined) this.detector = payload.detector;
					break;
				case 'tempo':
					this.tempo = payload;
					if (this._api) this._api.timeRatio = this.tempo;
					break;
				case 'close':
					this.close();
					break;
			}
		};
		
		createRubberBandModule()
			.then((module) => { this._module = module; })
			.catch((err) => { console.error('RealtimePitchShiftProcessor: WASM load failed', err); });
	}
	
	_ensureInputBuffers(channelCount) {
		if (!this._inputBuffers || this._inputBuffers.length !== channelCount || this._inputBuffers[0].length !== this.blockSize) {
			this._inputBuffers = new Array(channelCount);
			for (let ch = 0; ch < channelCount; ++ch) {
				this._inputBuffers[ch] = new Float32Array(this.blockSize);
			}
			this._inputWriteIndex = 0;
		}
	}
	
	_getApi(channelCount) {
		const m = this._module;
		if (!m || typeof m._malloc !== 'function' || !m.HEAPF32) return null;
		
		if (!this._api || this._api.channelCount !== channelCount || 
		    this._api.highQuality !== this.highQuality ||
		    this._api.formantPreserved !== this.formantPreserved ||
		    this._api.transients !== this.transients ||
		    this._api.detector !== this.detector) {
			this._api = new RealtimeRubberBandWrapper(m, sampleRate, channelCount, {
				highQuality: this.highQuality,
				formantPreserved: this.formantPreserved,
				transients: this.transients,
				detector: this.detector,
				pitch: this.pitch,
				tempo: this.tempo,
				blockSize: this.blockSize
			});
			this._inputBuffers = null;
			this._inputWriteIndex = 0;
		}
		return this._api;
	}
	
	close() {
		this.port.onmessage = null;
		this.running = false;
	}
	
	process(inputs, outputs) {
		const input0 = inputs[0];
		const output0 = outputs[0];
		const inputChannels = input0?.length || 0;
		const outputChannels = output0?.length || 0;
		const numChannels = outputChannels || inputChannels;
		
		if (numChannels <= 0) return this.running;
		
		const api = this._getApi(numChannels);
		if (!api) return this.running;
		
		if (inputChannels > 0 && input0 && input0[0]) {
			const frameCount = input0[0].length;
			this._ensureInputBuffers(numChannels);
			
			let srcOffset = 0;
			while (srcOffset < frameCount) {
				const canCopy = Math.min(frameCount - srcOffset, this.blockSize - this._inputWriteIndex);
				
				for (let ch = 0; ch < numChannels; ++ch) {
					const src = ch < inputChannels ? input0[ch] : input0[0];
					this._inputBuffers[ch].set(src.subarray(srcOffset, srcOffset + canCopy), this._inputWriteIndex);
				}
				
				this._inputWriteIndex += canCopy;
				srcOffset += canCopy;
				
				if (this._inputWriteIndex === this.blockSize) {
					for (let ch = 0; ch < numChannels; ++ch) {
						const buf = this._inputBuffers[ch];
						for (let i = 0; i < this.blockSize; ++i) {
							if (buf[i] !== buf[i]) buf[i] = 0;
						}
					}
					api.push(this._inputBuffers, this.blockSize);
					this._inputWriteIndex = 0;
				}
			}
		}
		
		if (outputChannels > 0 && output0 && output0[0]) {
			const outputLength = output0[0].length;
			api.pull(output0);
			
			for (let ch = 0; ch < outputChannels; ++ch) {
				const out = output0[ch];
				for (let i = 0; i < outputLength; ++i) {
					if (out[i] !== out[i]) out[i] = 0;
				}
			}
		}
		
		return this.running;
	}
}

registerProcessor('realtime-pitch-shift-processor', RealtimePitchShiftProcessor);
`;

const combined = header + wasmModule + processorCode;
fs.writeFileSync(outputPath, combined, 'utf8');
console.log('Created: ' + outputPath);
console.log('Size: ' + combined.length + ' bytes');
