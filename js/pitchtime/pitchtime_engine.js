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
		if(this.gainNode) this.gainNode.gain.value = v;
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
		this.player.play();
		this.isPlaying = true;
	}

	async pause(){
		if(!this.isPlaying) return;
		if(this.player) this.player.pause();
		this.isPlaying = false;
	}

	async stop(){
		if(this.player) this.player.pause();
		this.isPlaying = false;
		this.seek(0);
	}

	seek(time){
		if(this.player){
			this.player.seek(time);
		}
	}

	getCurrentTime(){
		return this.player ? this.player.getCurrentTime() : 0;
	}

	setPitch(semitones){
		this.currentPitch = semitones;
		// If we slow down the SAB player for time-stretch, pitch drops too.
		// Compensate by scaling RubberBand pitch by the stretch factor.
		const basePitch = Math.pow(2, semitones / 12);
		const ratio = basePitch * (this.useSABRateForTempo ? (this.currentTempo || 1.0) : 1.0);
		if(this.rubberbandNode){
			this.rubberbandNode.port.postMessage(JSON.stringify(['pitch', ratio]));
		}
	}

	setTempo(ratio){
		this.currentTempo = ratio;

		// Prefer implementing time stretch via the SAB player's playback-rate (speed)
		// and keep RubberBand time ratio at 1.0 to avoid RubberBand output backlog.
		if(this.player && this.player.setPlaybackRateRatio){
			this.useSABRateForTempo = true;
			const pr = 1.0 / (ratio || 1.0);
			this.player.setPlaybackRateRatio(pr);
			if(this.rubberbandNode){
				this.rubberbandNode.port.postMessage(JSON.stringify(['tempo', 1.0]));
				// Tempo affects the pitch compensation, so re-send pitch too.
				this.setPitch(this.currentPitch || 0);
			}
			return;
		}

		// Fallback: no playback-rate control available (e.g. other platforms).
		// Use RubberBand tempo directly.
		this.useSABRateForTempo = false;
		if(this.rubberbandNode){
			this.rubberbandNode.port.postMessage(JSON.stringify(['tempo', ratio]));
			// Pitch compensation is not needed in this mode.
			this.setPitch(this.currentPitch || 0);
		}
	}

	setHighQuality(enabled){
		this.currentHQ = enabled;
		if(this.rubberbandNode){
			this.rubberbandNode.port.postMessage(JSON.stringify(['quality', enabled]));
			// HQ toggle recreates the kernel in the worklet; re-send current params.
			this.setTempo(this.currentTempo || 1.0);
			this.setPitch(this.currentPitch || 0);
		}
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
