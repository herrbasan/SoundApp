class PitchtimeSABProcessor extends AudioWorkletProcessor {
	constructor(options){
		super();
		this.sab = null;
		this.controlBuf = null;
		this.writePos = null;
		this.readPos = null;
		this.channels = 2;
		this.bufferSize = 0;
		this.rubberband = null;
		this.pitch = 1.0;
		this.tempo = 1.0;
		this.highQuality = false;
		this.sampleRate = sampleRate;
		this.blockSize = 128;
		
		this.port.onmessage = (e) => {
			const data = e.data;
			if(data.type === 'init'){
				this.sab = data.sab;
				this.controlBuf = new Int32Array(data.controlBuf);
				this.writePos = 0;
				this.readPos = 1;
				this.bufferSize = this.sab.byteLength / (Float32Array.BYTES_PER_ELEMENT * this.channels);
				this.audioData = [
					new Float32Array(this.sab, 0, this.bufferSize),
					new Float32Array(this.sab, this.bufferSize * Float32Array.BYTES_PER_ELEMENT, this.bufferSize)
				];
				this.initRubberband();
			} else if(data.type === 'pitch'){
				this.pitch = data.value;
				if(this.rubberband) this.rubberband.setPitchScale(this.pitch);
			} else if(data.type === 'tempo'){
				this.tempo = data.value;
				if(this.rubberband) this.rubberband.setTimeRatio(this.tempo);
			} else if(data.type === 'quality'){
				this.highQuality = data.value;
				this.blockSize = this.highQuality ? 512 : 128;
			}
		};
	}

	initRubberband(){
		try {
			const baseUrl = new URL('../../libs/rubberband-processor.js', import.meta.url || location.href);
			importScripts(baseUrl.href);
			this.rubberband = new RubberBandStretcher(this.sampleRate, this.channels, {
				pitchOption: 'OptionPitchHighConsistency',
				transientOption: 'OptionTransientsCrisp'
			});
			this.rubberband.setPitchScale(this.pitch);
			this.rubberband.setTimeRatio(this.tempo);
		} catch(err){
			console.error('Rubberband init failed:', err);
		}
	}

	process(inputs, outputs, parameters){
		if(!this.sab || !this.audioData || !this.rubberband) return true;

		const output = outputs[0];
		const frameCount = output[0].length;
		const available = Atomics.load(this.controlBuf, this.writePos) - Atomics.load(this.controlBuf, this.readPos);
		
		if(available < frameCount){
			for(let ch=0; ch<output.length; ch++){
				output[ch].fill(0);
			}
			return true;
		}

		const readIdx = Atomics.load(this.controlBuf, this.readPos);
		const chunk = [];
		for(let ch=0; ch<this.channels; ch++){
			chunk[ch] = new Float32Array(frameCount);
			for(let i=0; i<frameCount; i++){
				const idx = (readIdx + i) % this.bufferSize;
				chunk[ch][i] = this.audioData[ch][idx];
			}
		}

		this.rubberband.process(chunk, false);
		const processed = this.rubberband.retrieve(frameCount);
		
		if(processed && processed[0]){
			for(let ch=0; ch<Math.min(output.length, processed.length); ch++){
				output[ch].set(processed[ch]);
			}
		} else {
			for(let ch=0; ch<output.length; ch++){
				output[ch].set(chunk[ch]);
			}
		}

		Atomics.add(this.controlBuf, this.readPos, frameCount);
		return true;
	}
}

registerProcessor('pitchtime-sab-processor', PitchtimeSABProcessor);
