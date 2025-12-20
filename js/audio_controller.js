'use strict';

class AudioController {
	constructor(audioContext) {
		this.ctx = audioContext;
		this.gainNode = this.ctx.createGain();
		this.gainNode.connect(this.ctx.destination);
		this.source = null;
		this.sourceType = null;
		this.sourceStarted = false;
		this.audioElement = null;
		this.buffer = null;
		this.startTime = 0;
		this.pauseTime = 0;
		this.duration = 0;
		this.paused = true;
		this.loop = false;
		this.ended = false;
		this.onEndedCallback = null;
		this.fp = null;
		this.cache_path = null;
		this.isMod = false;
		this.webaudioLoop = false;
		this.bench = 0;
		this.metadata = null;
	}

	async loadBuffer(url, loop = false) {
		this.sourceType = 'buffer';
		this.loop = loop;
		this.webaudioLoop = loop;
		let response = await fetch(url);
		let arrayBuffer = await response.arrayBuffer();
		this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
		this.duration = this.buffer.duration;
		return this;
	}

	async loadMediaElement(url, loop = false) {
		this.sourceType = 'element';
		this.loop = loop;
		this.audioElement = document.createElement('audio');
		this.audioElement.src = url;
		this.audioElement.loop = loop;
		await new Promise((resolve, reject) => {
			this.audioElement.addEventListener('canplay', resolve, { once: true });
			this.audioElement.addEventListener('error', reject, { once: true });
		});
		this.duration = this.audioElement.duration;
		let mediaSource = this.ctx.createMediaElementSource(this.audioElement);
		mediaSource.connect(this.gainNode);
		this.source = mediaSource;
		this.audioElement.addEventListener('ended', () => {
			this.ended = true;
			if (this.onEndedCallback && !this.loop) {
				this.onEndedCallback();
			}
		});
		return this;
	}

	play() {
		if (this.sourceType === 'buffer') {
			if (this.source && this.sourceStarted) {
				this.source.stop();
				this.source.disconnect();
			}
			this.source = this.ctx.createBufferSource();
			this.source.buffer = this.buffer;
			this.source.loop = this.loop;
			if (this.loop) {
				this.source.loopStart = 0;
				this.source.loopEnd = this.buffer.duration;
			}
			this.source.connect(this.gainNode);
			this.source.onended = () => {
				this.sourceStarted = false;
				this.ended = true;
				if (this.onEndedCallback && !this.loop) {
					this.onEndedCallback();
				}
			};
			let offset = this.pauseTime || 0;
			if (this.loop) {
				this.source.start(0, offset, 86400);
			} else {
				this.source.start(0, offset);
			}
			this.sourceStarted = true;
			this.startTime = this.ctx.currentTime - offset;
			this.paused = false;
			this.ended = false;
		} else if (this.sourceType === 'element') {
			this.audioElement.play();
			this.paused = false;
			this.ended = false;
		}
	}

	pause() {
		if (this.sourceType === 'buffer') {
			if (this.source && this.sourceStarted && !this.paused) {
				let elapsed = this.ctx.currentTime - this.startTime;
				this.pauseTime = elapsed;
				this.source.stop();
				this.source.disconnect();
				this.sourceStarted = false;
				this.paused = true;
			}
		} else if (this.sourceType === 'element') {
			this.audioElement.pause();
			this.paused = true;
		}
	}

	stop() {
		if (this.sourceType === 'buffer') {
			if (this.source && this.sourceStarted) {
				this.source.stop();
				this.source.disconnect();
				this.sourceStarted = false;
			}
			this.source = null;
			this.pauseTime = 0;
			this.startTime = 0;
			this.paused = true;
		} else if (this.sourceType === 'element' && this.audioElement) {
			this.audioElement.pause();
			this.audioElement.currentTime = 0;
			this.paused = true;
		}
	}

	seek(time) {
		if (this.sourceType === 'buffer') {
			let wasPlaying = !this.paused;
			if (this.source && this.sourceStarted && !this.paused) {
				this.source.stop();
				this.source.disconnect();
				this.sourceStarted = false;
			}
			this.pauseTime = Math.max(0, Math.min(time, this.duration));
			if (wasPlaying) {
				this.play();
			}
		} else if (this.sourceType === 'element' && this.audioElement) {
			this.audioElement.currentTime = time;
		}
	}

	get currentTime() {
		if (this.sourceType === 'buffer') {
			if (this.paused || !this.source) {
				return this.pauseTime || 0;
			}
			let time = this.ctx.currentTime - this.startTime;
			if (this.loop && this.duration > 0) {
				time = time % this.duration;
			}
			return this.duration > 0 ? Math.min(time, this.duration) : time;
		} else if (this.sourceType === 'element') {
			return this.audioElement ? this.audioElement.currentTime : 0;
		}
		return 0;
	}

	set currentTime(time) {
		this.seek(time);
	}

	get volume() {
		return this.gainNode.gain.value;
	}

	set volume(val) {
		this.gainNode.gain.value = val;
	}

	playing() {
		return !this.paused;
	}

	onEnded(callback) {
		this.onEndedCallback = callback;
	}

	unload() {
		this.stop();
		if (this.source) {
			this.source.disconnect();
			this.source = null;
		}
		if (this.audioElement) {
			this.audioElement.pause();
			this.audioElement.src = '';
			this.audioElement.load();
			this.audioElement = null;
		}
		this.buffer = null;
		this.duration = 0;
		this.pauseTime = 0;
		this.startTime = 0;
	}

	fadeOut(duration, onComplete) {
		let startVol = this.gainNode.gain.value;
		let startTime = this.ctx.currentTime;
		this.gainNode.gain.setValueAtTime(startVol, startTime);
		this.gainNode.gain.linearRampToValueAtTime(0, startTime + duration);
		setTimeout(() => {
			if (onComplete) onComplete();
		}, duration * 1000);
	}
}

module.exports = AudioController;
