export class PitchtimeEngine {
	constructor(initData){
		this.initData = initData || {};
		this.ctx = null;
		this.workletNode = null;
		this.player = null;
		this.gainNode = null;
		this.currentVolume = 1.0;
		this.isPlaying = false;
		this.loop = false;
		this.duration = 0;
		this.currentPitch = 0;
		this.currentTempo = 1.0;
		this.currentHQ = false;
		this.useSABRateForTempo = false;
		this.filePath = null;
	}

	async init(){
		this.ctx = new AudioContext({ sampleRate: 48000 });
		
		const workletUrl = new URL('../../libs/rubberband/realtime-pitch-shift-processor.js', import.meta.url);
		await this.ctx.audioWorklet.addModule(workletUrl);
		this.rubberbandNode = new AudioWorkletNode(this.ctx, 'realtime-pitch-shift-processor', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			processorOptions: { blockSize: 512 }
		});
		
		this.gainNode = this.ctx.createGain();
		this.gainNode.gain.value = this.currentVolume || 1.0;
		this.rubberbandNode.connect(this.gainNode);
		this.gainNode.connect(this.ctx.destination);
		
		const ffmpegNapiPath = this.initData.ffmpeg_napi_path;
		const ffmpegPlayerPath = this.initData.ffmpeg_player_sab_path;
		const workletPath = this.initData.ffmpeg_worklet_sab_path;
		
		if(ffmpegNapiPath && ffmpegPlayerPath && workletPath){
			const { FFmpegDecoder } = require(ffmpegNapiPath);
			const { FFmpegStreamPlayerSAB } = require(ffmpegPlayerPath);
			FFmpegStreamPlayerSAB.setDecoder(FFmpegDecoder);
			const ringSeconds = 4;
			this.player = new FFmpegStreamPlayerSAB(this.ctx, workletPath, ringSeconds, 1, false);
			// Route through Rubberband instead of direct to destination
			this.player.connect(this.rubberbandNode);
		}
	}

	setVolume(v){
		v = Math.max(0, Math.min(1, +v || 0));
		this.currentVolume = v;
		if(this.gainNode) this.gainNode.gain.setValueAtTime(v, this.ctx.currentTime);
	}

	async _fadeOut(){
		if(!this.gainNode) return;
		const now = this.ctx.currentTime;
		this.gainNode.gain.cancelScheduledValues(now);
		this.gainNode.gain.setValueAtTime(this.currentVolume, now);
		this.gainNode.gain.linearRampToValueAtTime(0, now + 0.012);
		await new Promise(r => setTimeout(r, 13));
	}

	async _fadeIn(){
		if(!this.gainNode) return;
		const now = this.ctx.currentTime;
		this.gainNode.gain.cancelScheduledValues(now);
		this.gainNode.gain.setValueAtTime(0, now);
		this.gainNode.gain.linearRampToValueAtTime(this.currentVolume, now + 0.015);
		await new Promise(r => setTimeout(r, 16));
	}

	async _fadeTransition(action, stabilize = false){
		if(!this.gainNode) return;
		await this._fadeOut();
		if(action) await action();
		if(stabilize){
			await new Promise(r => setTimeout(r, 300));
		}
		await this._fadeIn();
	}

	async _microFade(action){
		if(!this.gainNode) return;
		const now = this.ctx.currentTime;
		this.gainNode.gain.cancelScheduledValues(now);
		this.gainNode.gain.setValueAtTime(this.currentVolume, now);
		this.gainNode.gain.linearRampToValueAtTime(this.currentVolume * 0.3, now + 0.008);
		await new Promise(r => setTimeout(r, 8));
		if(action) action();
		const now2 = this.ctx.currentTime;
		this.gainNode.gain.cancelScheduledValues(now2);
		this.gainNode.gain.linearRampToValueAtTime(this.currentVolume, now2 + 0.010);
		await new Promise(r => setTimeout(r, 10));
	}

	async loadFile(pathOrFile){
		console.time('loadFile');
		if(this.isPlaying) await this.stop();
		this.filePath = null;
		this.duration = 0;

		if(typeof pathOrFile === 'string'){
			this.filePath = pathOrFile;
			if(this.filePath.startsWith('file:///')) this.filePath = decodeURIComponent(this.filePath.substring(8));
			else if(this.filePath.startsWith('file://')) this.filePath = decodeURIComponent(this.filePath.substring(7));
		} else {
			console.warn('File objects not supported in SAB mode, need path');
			console.timeEnd('loadFile');
			return;
		}

		if(!this.player){
			throw new Error('FFmpeg player not initialized');
		}

		console.time('playerOpen');
		const info = await this.player.open(this.filePath);
		console.timeEnd('playerOpen');
		
		this.duration = info.duration;
		
		if(this.player.setLoop){
			this.player.setLoop(this.loop);
		}
		
		console.timeEnd('loadFile');
	}

	async play(){
		if(!this.player) return;
		if(this.ctx.state === 'suspended'){
			await this.ctx.resume();
		}
		
		if(this.player._fillQueue){
			this.player._fillQueue(this.player.ringSize * 0.5, 8);
		}
		
		this.player.play();
		this.isPlaying = true;
		await this._fadeIn();
	}

	async pause(){
		if(!this.isPlaying) return;
		await this._fadeOut();
		if(this.player) this.player.pause();
		this.isPlaying = false;
	}

	async stop(){
		if(this.player) this.player.pause();
		this.isPlaying = false;
		await this.seek(0);
	}

	async seek(time){
		if(!this.player) return;
		await this._fadeTransition(()=>{
			this.player.seek(time);
		});
	}

	getCurrentTime(){
		return this.player ? this.player.getCurrentTime() : 0;
	}

	setPitch(semitones){
		this.currentPitch = semitones;
		const basePitch = Math.pow(2, semitones / 12);
		const ratio = basePitch * (this.useSABRateForTempo ? (this.currentTempo || 1.0) : 1.0);
		if(this.rubberbandNode){
			this.rubberbandNode.port.postMessage(JSON.stringify(['pitch', ratio]));
		}
	}

	setTempo(ratio){
		this.currentTempo = ratio;

		if(this.player && this.player.setPlaybackRateRatio){
			this.useSABRateForTempo = true;
			const pr = 1.0 / (ratio || 1.0);
			this.player.setPlaybackRateRatio(pr);
			if(this.rubberbandNode){
				this.rubberbandNode.port.postMessage(JSON.stringify(['tempo', 1.0]));
				this.setPitch(this.currentPitch || 0);
			}
			return;
		}

		this.useSABRateForTempo = false;
		if(this.rubberbandNode){
			this.rubberbandNode.port.postMessage(JSON.stringify(['tempo', ratio]));
			this.setPitch(this.currentPitch || 0);
		}
	}

	async setHighQuality(enabled){
		this.currentHQ = enabled;
		if(!this.gainNode || !this.rubberbandNode) return;
		
		await this._fadeTransition(async ()=>{
			this.rubberbandNode.port.postMessage(JSON.stringify(['quality', enabled]));
			this.setTempo(this.currentTempo || 1.0);
			this.setPitch(this.currentPitch || 0);
		}, true);
	}

	async setOptions(opts){
		if(!opts || !this.gainNode || !this.rubberbandNode) return;
		if(opts.highQuality !== undefined) this.currentHQ = opts.highQuality;
		
		await this._fadeTransition(async ()=>{
			this.rubberbandNode.port.postMessage(JSON.stringify(['options', opts]));
			this.setTempo(this.currentTempo || 1.0);
			this.setPitch(this.currentPitch || 0);
		}, true);
	}

	setLoop(enabled){
		this.loop = enabled;
		if(this.player && this.player.setLoop){
			this.player.setLoop(enabled);
		}
	}

	async dispose(){
		try {
			if(this.isPlaying) await this.stop();
		} catch(e) {}

		this.isPlaying = false;

		if(this.player){
			try { this.player.pause(); } catch(e) {}
			try { this.player.dispose(); } catch(e) {}
			this.player = null;
		}

		if(this.rubberbandNode){
			try { this.rubberbandNode.port.postMessage(JSON.stringify(['close'])); } catch(e) {}
			try { this.rubberbandNode.disconnect(); } catch(e) {}
			this.rubberbandNode = null;
		}

		if(this.gainNode){
			try { this.gainNode.disconnect(); } catch(e) {}
			this.gainNode = null;
		}

		if(this.ctx){
			try { await this.ctx.close(); } catch(e) {}
			this.ctx = null;
		}
	}
}
