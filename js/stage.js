'use strict';

const { ipcRenderer, webUtils, ipcMain } = require( "electron" );
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const helper = require('../libs/electron_helper/helper_new.js');
const AudioController = require('./audio_controller.js');
const tools = helper.tools;
const app = helper.app;
const os = require('node:os');
const registry = require('../js/registry.js');

let player;
let g = {};
g.test = {};
g.audioContext = null;
g.ffmpegPlayer = null;
// Init
// ###########################################################################

init();
async function init(){
	fb('Init Stage')
	g.win = helper.window;
	g.main_env = await helper.global.get('main_env');
	g.basePath = await helper.global.get('base_path');
	g.isPackaged = await helper.global.get('isPackaged');
	g.cache_path = await helper.global.get('temp_path');
	g.start_vars = await helper.global.get('start_vars');
	g.app_path = await helper.app.getAppPath();

	let default_config = {
		transcode: {
			"ext":".wav",
			"cmd":"-c:a pcm_s16le"
		},
		space:10,
		win_min_width:480,
		win_min_height:217,
		volume: 0.5
	}
	
	g.config_obj = await helper.config.initRenderer('user', (newData) => {
		g.config = newData;
	});
	g.config = g.config_obj.get();
	
	ut.setCssVar('--space-base', g.config.space);

	if(g.config.window){
		if(g.config.window.width && g.config.window.height){
			await g.win.setBounds(g.config.window)
		}
	}
	g.win.show();
	//g.win.transparent
	if(!g.isPackaged) { g.win.toggleDevTools() }
	
	let fp = g.app_path;
	if(g.isPackaged){fp = path.dirname(fp);}

	if(os.platform() == 'linux'){
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/linux_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/linux_bin/player.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/linux_bin/ffmpeg-worklet-processor.js');
	}
	else {
		g.ffmpeg_napi_path = path.resolve(fp + '/bin/win_bin/ffmpeg_napi.node');
		g.ffmpeg_player_path = path.resolve(fp + '/bin/win_bin/player.js');
		g.ffmpeg_worklet_path = path.resolve(fp + '/bin/win_bin/ffmpeg-worklet-processor.js');
	}

	/* Init Web Audio Context at 44100Hz to match FFmpeg decoder output */
	g.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });

	/* FFmpeg NAPI Player - unified streaming with gapless looping */
	const { FFmpegDecoder, getMetadata } = require(g.ffmpeg_napi_path);
	g.getMetadata = getMetadata;
	const { FFmpegStreamPlayer } = require(g.ffmpeg_player_path);
	FFmpegStreamPlayer.setDecoder(FFmpegDecoder);
	g.ffmpegPlayer = new FFmpegStreamPlayer(g.audioContext, g.ffmpeg_worklet_path);
	try {
		await g.ffmpegPlayer.init();
	} catch (err) {
		console.error('Failed to initialize FFmpeg player:', err);
	}

	/* Mod Player */
	player = new window.chiptune({repeatCount: 0, stereoSeparation: 100, interpolationFilter: 0, context: g.audioContext});
	player.onMetadata(async (meta) => {
		if(g.currentAudio){
			g.currentAudio.duration = player.duration;
			g.playremain.innerText = ut.playTime(g.currentAudio.duration*1000).minsec;
			await renderInfo(g.currentAudio.fp, meta);
			console.log('Operation took: ' + Math.round((performance.now() - g.currentAudio.bench)) );
		}
		g.blocky = false;
	});
	player.onProgress((e) => {
		if(g.currentAudio){
			g.currentAudio.currentTime = e.pos || 0;
		}
	});
	player.onEnded(audioEnded);
	player.onError((err) => { console.log(err); audioEnded(); g.blocky = false;});
	player.onInitialized(() => {
		console.log('Player Initialized');
		player.gain.connect(g.audioContext.destination);
		g.blocky = false;
		appStart();
	});

	ipcRenderer.on('main', async (e, data) => {
		if(data.length == 1){
			await playListFromSingle(data[0], false);
		}
		else {
			await playListFromMulti(data, false, false);
		}
		playAudio(g.music[g.idx])
	})
	console.log(g.main_env)
	ipcRenderer.on('log', (e, data) => {
		console.log('%c' + data.context, 'color:#6058d6', data.data);
	});
	
}

async function appStart(){
	window.addEventListener("keydown", onKey);
	g.scale = window.devicePixelRatio || 1;
	g.body = document.body;
	g.frame = ut.el('.frame');
	g.top = ut.el('.top');
	g.top_num = g.top.el('.num');
	g.top_close = g.top.el('.close')

	g.bottom = ut.el('.bottom');
	g.playhead = ut.el('.playhead');
	g.prog = ut.el('.playhead .prog');
	g.cover = ut.el('.info .cover');
	g.type_band = g.cover.el('.filetype .type');
	g.playtime = ut.el('.playtime .time');
	g.playvolume = ut.el('.playtime .volume span');
	g.playremain = ut.el('.playtime .remain');
	g.top_btn_loop = ut.el('.top .content .loop');
	g.top_btn_playpause = ut.el('.top .content .playpause');

	g.text = ut.el('.info .text');

	g.blocky = false;

	
	g.supportedMpt = ['.mptm', '.mod','.mo3','.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf', 
	'.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus', 
	'.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod', 
	'.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];
	g.supportedChrome = ['.mp3','.wav','.flac','.ogg', '.m4a', '.m4b', '.aac','.webm'];
	g.supportedFFmpeg = ['.mpg','.mp2', '.aif', '.aiff','.aa'];


	g.supportedFilter = [...g.supportedChrome, ...g.supportedFFmpeg, ...g.supportedMpt]

	g.music = [];
	g.idx = 0;
	g.isLoop = false;
	g.useFFmpegForAll = true; // Set to true to route all audio through FFmpeg
	setupWindow();
	setupDragDrop();

	let arg = g.start_vars[g.start_vars.length-1];
	
	if(arg != '.' && g.start_vars.length > 1 && arg != '--squirrel-firstrun'){
		await playListFromSingle(arg);
	}
	else {
		let mp = await app.getPath('music');
		await playListFromSingle(mp);
	}
	
	if(g.music.length > 0){
		
		g.max = g.music.length-1;
		playAudio(g.music[g.idx])
	}

	g.bottom.addEventListener('mousedown', timeline)
	g.top_close.addEventListener('click', app.exit);

	g.top_btn_loop.addEventListener('click', toggleLoop);
	g.top_btn_playpause.addEventListener('click', playPause);

	loop();
	
}

function setupDragDrop(){
	g.dropZone = window.nui_app.dropZone(
		[
			{ name:'drop_add', label:'Add to Playlist' }, 
			{ name:'drop_replace', label:'Replace Playlist' }
		],
		dropHandler,
		document.body
	);
	async function dropHandler(e){
		console.log(e);
		e.preventDefault();
		if(e.target.id == 'drop_add'){
			let files = fileListArray(e.dataTransfer.files);
			await playListFromMulti(files, true, !e.ctrlKey);
		}
		if(e.target.id == 'drop_replace'){
			let files = fileListArray(e.dataTransfer.files);
			await playListFromMulti(files, false, !e.ctrlKey);
			playAudio(g.music[g.idx]);
		}
		renderTopInfo();
	}

	function fileListArray(fl){
		let out = [];
		for(let i=0; i<fl.length; i++){
			out.push(webUtils.getPathForFile(fl[i]));
		}
		return out;
	}
}


function setupWindow(){
	g.win.hook_event('blur', handler);
	g.win.hook_event('focus', handler);
	g.win.hook_event('move', handler);
	g.win.hook_event('resized', handler);
	function handler(e, data){
		//clearDrop();
		if(data.type == 'blur'){
			g.frame.classList.remove('focus');
		}
		if(data.type == 'focus'){
			g.frame.classList.add('focus');
		}
		if(data.type == 'move' || data.type == 'resized'){
			clearTimeout(g.window_move_timeout);
			g.window_move_timeout = setTimeout(async () => {
				let bounds = await g.win.getBounds();
				g.config.window = bounds;
				g.config_obj.set(g.config);
			}, 500)
		}
	}
}

function timeline(e){
	if(e.type == 'mousedown'){
		window.addEventListener('mouseup', timeline);
		window.addEventListener('mousemove', timeline);
		seek(e.clientX);
	}
	if(e.type == 'mousemove'){
		seek(e.clientX);
	}
	if(e.type == 'mouseup'){
		window.removeEventListener('mouseup', timeline);
		window.removeEventListener('mousemove', timeline);
	}
	
}

function playListFromSingle(fp, rec=true){
	return new Promise(async (resolve, reject) => {
		let pl = [];
		let idx = 0;
		let stat = await fs.lstat(path.normalize(fp));
		if(stat.isDirectory()){
			if(rec){
				pl = await tools.getFilesRecursive(fp, g.supportedFilter);
			}
			else {
				pl = await tools.getFiles(fp, g.supportedFilter);
			}
		}
		else {
			if(tools.checkFileType(fp, g.supportedFilter)){
				let info = path.parse(fp);
				pl = await tools.getFiles(info.dir, g.supportedFilter);
				idx = pl.findIndex(item => item == path.join(info.dir, info.base));
				if(idx == -1) { idx = 0};
			}
			else {
				console.log('Unsupported File Type')
			}
		}
		if(pl.length > 0){
			g.music = pl;
			g.max = g.music.length-1;
			g.idx = idx;
		}
		resolve();
	})
}

function playListFromMulti(ar, add=false, rec=false){
	return new Promise(async (resolve, reject) => {
		let pl = [];
		for(let i=0; i<ar.length; i++){
			let fp = ar[i];
			let stat = await fs.lstat(path.normalize(fp));
			if(stat.isDirectory()){
				let folder_files = [];
				if(rec){
					folder_files = await tools.getFilesRecursive(fp, g.supportedFilter);
				}
				else {
					folder_files = await tools.getFiles(fp, g.supportedFilter);
				}
				pl = pl.concat(folder_files);
			}
			else {
				if(tools.checkFileType(fp, g.supportedFilter)){
					pl.push(fp);
				}
				else {
					console.log('Unsupported File Type')
				}
			}
		}
		if(pl.length > 0){
			if(add){
				g.music = g.music.concat(pl);
				g.max = g.music.length-1;
			}
			else {
				g.idx = 0;
				g.music = pl;
				g.max = g.music.length-1;playListFromMulti
			}
		}
		resolve(pl);
	})
}



async function playAudio(fp, n){
	if(!g.blocky){
		let parse = path.parse(fp);
		let bench = performance.now();
		g.blocky = true;
		clearAudio();

		if(player) { player.stop(); }

		const needsFFmpeg = g.useFFmpegForAll || g.supportedFFmpeg.includes(parse.ext.toLocaleLowerCase());

		if(g.supportedMpt.includes(parse.ext.toLocaleLowerCase()) && !g.useFFmpegForAll){
			g.currentAudio = {
				isMod: true, 
				fp: fp, 
				bench: bench, 
				currentTime: 0,
				paused: false, 
				duration: 0,
				play: () =>  { g.currentAudio.paused = false; player.unpause() }, 
				pause: () => { g.currentAudio.paused = true; player.pause() }
			};
			player.load(tools.getFileURL(fp));
			player.gain.gain.value = g.config.volume;
			checkState();
		}
		else if (needsFFmpeg) {
				try {
					const ffPlayer = g.ffmpegPlayer;
					ffPlayer.onEnded(audioEnded);
					
					// Open file, set loop mode, then play
					const metadata = await ffPlayer.open(fp);
					ffPlayer.setLoop(g.isLoop);
					
					g.currentAudio = {
						isFFmpeg: true,
						fp: fp,
						bench: bench,
						currentTime: 0,
						paused: false,
						duration: metadata.duration,
						player: ffPlayer,
						volume: g.config.volume,
						play: () => { g.currentAudio.paused = false; ffPlayer.play(); },
						pause: () => { g.currentAudio.paused = true; ffPlayer.pause(); },
						seek: (time) => ffPlayer.seek(time),
						getCurrentTime: () => ffPlayer.getCurrentTime()
					};
					
					ffPlayer.volume = g.config.volume;
					
					if (n > 0) { ffPlayer.seek(n); }
					
					// Start playback
					await ffPlayer.play();
					
					checkState();
					console.log('Operation took: ' + Math.round((performance.now() - bench)));
					await renderInfo(fp);
					g.blocky = false;
				}
				catch(err) {
					console.error('FFmpeg playback error:', err);
					g.text.innerHTML += 'Error loading file with FFmpeg!<br>';
					g.blocky = false;
					return false;
				}
		}
		else {
			let audio = new AudioController(g.audioContext);
			audio.fp = fp;
			audio.bench = bench;
			audio.onEnded(audioEnded);

			let url = tools.getFileURL(fp);

			try {
					if(g.isLoop){
						await audio.loadBuffer(url, true);
						audio.webaudioLoop = true;
					}
					else {
						await audio.loadMediaElement(url, false);
					}
					
					if(n > 0) { audio.seek(n) }
					audio.volume = g.config.volume;
					audio.play();
					g.currentAudio = audio;
					checkState();
					console.log('Operation took: ' + Math.round((performance.now() - bench)) );
					await renderInfo(fp);
					g.blocky = false;
				}
				catch(err) {
					console.error('Playback error:', err);
					g.text.innerHTML += 'Error!<br>';
					g.blocky = false;
					return false;
				}
		}
	}
	if(g.info_win) {
		tools.sendToId(g.info_win, 'info', {list:g.music, idx:g.idx});
	}
}

function renderInfo(fp, metadata){
	g.currentInfo = { duration:g.currentAudio.duration };
	return new Promise(async (resolve, reject) => {
		let parse = path.parse(fp);
		let parent = path.basename(parse.dir);
		g.playremain.innerText = ut.playTime(g.currentAudio.duration*1000).minsec;
		ut.killKids(g.text);
		g.text.appendChild(renderInfoItem('Folder:', parent))
		g.text.appendChild(renderInfoItem('File:', parse.base))
		g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
		let ext_string = parse.ext.substring(1).toLowerCase();
		g.type_band.className = 'type ' + ext_string;
		g.type_band.innerText = ext_string;

		let prevCovers = g.cover.els('img');
		for(let i=0; i<prevCovers.length; i++){
			let el = prevCovers[i];
			el.animate([{opacity: 1}, {opacity: 0}], {duration: 200, delay: 200, fill: 'forwards'})
				.onfinish = () => ut.killMe(el);
		}
		renderTopInfo(); 
		
		if(g.currentAudio.isMod){
			g.currentInfo.metadata = metadata;
			g.text.appendChild(renderInfoItem('Format:', metadata.tracker))
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
			if(metadata){
				if(metadata.artist) { g.text.appendChild(renderInfoItem('Artist:', metadata.artist)) }
				if(metadata.title) { g.text.appendChild(renderInfoItem('Title:', metadata.title)) }
				if(metadata.date) { g.text.appendChild(renderInfoItem('Date:', metadata.date)) }
			}
			resolve();
		}
		else {
			
			let meta = await getFileInfo(fp);
			g.currentInfo.file = meta;

			if(meta.formatLongName && meta.formatLongName.includes('Tracker')){
				g.text.appendChild(renderInfoItem('Format:', 'Tracker Format'))
			}
			else {
				g.text.appendChild(renderInfoItem('Format:', meta.codecLongName || meta.codec || 'Unknown'))
			}
			
			let bitrateStr = meta.bitrate ? Math.round(meta.bitrate/1000) + ' kbps' : '';
			let channelStr = meta.channels == 2 ? 'stereo' : (meta.channels == 1 ? 'mono' : (meta.channels ? meta.channels + ' ch' : ''));
			let sampleStr = meta.sampleRate ? meta.sampleRate + ' Hz' : '';
			let infoLine = [bitrateStr, channelStr, sampleStr].filter(s => s).join(' / ');
			if(infoLine) g.text.appendChild(renderInfoItem(' ', infoLine))
			
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
			
			if(meta.artist) { g.text.appendChild(renderInfoItem('Artist:', meta.artist)) }
			if(meta.album) { g.text.appendChild(renderInfoItem('Album:', meta.album)) }
			if(meta.title) { g.text.appendChild(renderInfoItem('Title:', meta.title)) }
			

			
			let cover;
			let id3_cover = await getCoverArt(meta);
			if(id3_cover){
				cover = id3_cover;
			}
			else {
				let images = await tools.getFiles(parse.dir, ['.jpg','.jpeg','.png','.gif']);
				if(images.length > 0){
					cover = await tools.loadImage(images[images.length-1])
				}
			}

			if(cover){
				g.cover.appendChild(cover)
				cover.style.opacity = '0';
				cover.animate([{opacity: 0}, {opacity: 1}], {duration: 200, fill: 'forwards'});
				g.currentInfo.cover_src = cover.src;
			}
			
			resolve();
		}
	})
}


function renderInfoItem(label, text){
	let el = ut.htmlObject( /*html*/ `
		<div id="#item_folder" class="item">
			<div class="label">${label}</div>
			<div class="content">${text}</div>
		</div>`)
	return el;
}

function renderTopInfo(){
	g.top_num.innerText = (g.idx+1) + ' of ' + (g.max+1); 
}

function clearAudio(){
	if(g.ffmpegPlayer) g.ffmpegPlayer.stop();
	
	if(g.currentAudio){
		if(g.currentAudio.isMod){
			player.stop();
			g.currentAudio = undefined;
		}
		else if(g.currentAudio.isFFmpeg){
			g.currentAudio = undefined;
		}
		else {
			let mem = g.currentAudio;
			let targetVol = mem.volume || 0;
			if(targetVol > 0){
				mem.fadeOut(0.05, () => {
					mem.unload();
					if(mem.cache_path){
						setTimeout(() => { fs.unlink(mem.cache_path)}, 500);
					}
				});
			}
			else {
				mem.unload();
				if(mem.cache_path){
					setTimeout(() => { fs.unlink(mem.cache_path)}, 500);
				}
			}
		}
	}
}

function audioEnded(e){
	if(g.currentAudio?.isMod){
		if(g.isLoop){
			playAudio(g.music[g.idx]);
		}
		else {
			playNext();
		}
	}
	else if(g.currentAudio?.isFFmpeg){
		// FFmpeg player handles looping internally, onEnded only fires when not looping
		playNext();
	}
	else {
		if(e){ e.currentTarget.removeEventListener('ended', audioEnded);}
		playNext();
	}
	
}

function checkState(){
	if(g.currentAudio){
		if(g.isLoop){
			g.body.addClass('loop')
		}
		else {
			g.body.removeClass('loop')
		}
		if(g.currentAudio.paused){
			g.body.addClass('pause')
		}
		else {
			g.body.removeClass('pause')
		}
	}
}

function shufflePlaylist(){
	ut.shuffleArray(g.music);
	g.idx = 0;
	playAudio(g.music[g.idx]);
}

function playNext(e){
	if(!g.blocky){
		if(g.idx == g.max){ g.idx = -1; }
		g.idx++;
		playAudio(g.music[g.idx])
	}
}

function playPrev(e){
	if(!g.blocky){
		if(g.idx == 0){ g.idx = g.max+1; }
		g.idx--;
		playAudio(g.music[g.idx])
	}
}

function playPause(){
	if(g.currentAudio.webaudioLoop) { g.currentAudio.paused = !g.currentAudio.playing()} 
	if(g.currentAudio.paused){
		g.currentAudio.play();
	}
	else {
		g.currentAudio.pause();
	}
	checkState();
}

function toggleLoop(){
	g.isLoop = !g.isLoop;
	if(g.currentAudio){
		// FFmpeg player supports dynamic loop toggling
		if(g.currentAudio.isFFmpeg && g.currentAudio.player){
			g.currentAudio.player.setLoop(g.isLoop);
		}
		// Other players need to reload
		else if(!g.currentAudio.isMod){
			let currentTime = g.currentAudio.getCurrentTime ? g.currentAudio.getCurrentTime() : g.currentAudio.currentTime;
			playAudio(g.music[g.idx], currentTime);
			return;
		}
	}
	checkState();
}


function volumeUp(){
	g.config.volume += 0.05;
	if(g.config.volume > 1) { g.config.volume = 1 }
	if(player) { player.gain.gain.value = g.config.volume; }
	if(g.currentAudio) {
		if(g.currentAudio.isFFmpeg && g.currentAudio.player) {
			g.currentAudio.player.volume = g.config.volume;
		} else if(!g.currentAudio.isMod) {
			g.currentAudio.volume = g.config.volume;
		}
	}
}

function volumeDown(){
	g.config.volume -= 0.05;
	if(g.config.volume < 0) { g.config.volume = 0 }
	if(player) { player.gain.gain.value = g.config.volume; }
	if(g.currentAudio) {
		if(g.currentAudio.isFFmpeg && g.currentAudio.player) {
			g.currentAudio.player.volume = g.config.volume;
		} else if(!g.currentAudio.isMod) {
			g.currentAudio.volume = g.config.volume;
		}
	}
}


function seek(mx){
	let max = g.bottom.offsetWidth;
	let x = mx - ut.offset(g.bottom).left;
	if(x < 0) { x = 0; }
	if(x > max) { x = max; }
	let proz = x / max;
	seekTo(g.currentAudio.duration * proz);
}

function seekTo(s){
	if(g.currentAudio){
		if(g.currentAudio.isMod){
			player.seek(s);
			g.currentAudio.currentTime = s;
		}
		else {
			g.currentAudio.seek(s);
		}
	}
}

function seekFore(){
	if(g.currentAudio){
		if(g.currentAudio.currentTime + 10 < g.currentAudio.duration){
			seekTo(g.currentAudio.currentTime + 10)
		}
	}
}

function seekBack(){
	if(g.currentAudio){
		if(g.currentAudio.currentTime - 10 > 0){
			seekTo(g.currentAudio.currentTime - 10)
		}
		else {
			seekTo(0);
		}
	}
}

function loadImage(url){
	return new Promise((resolve, reject) => {
		let image = new Image();
		image.src = url;
		image.addEventListener('load', done);
		function done(e){
			image.removeEventListener('load', done);
			resolve(image);
		}
	})
}

function getFileInfo(fp){
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			let meta = g.getMetadata(fp);
			resolve(meta);
		}, 0);
	})
}

function getCoverArt(meta){
	return new Promise((resolve, reject) => {
		if(meta && meta.coverArt && meta.coverArt.length > 0){
			let img = new Image();
			let mime = meta.coverArtMimeType || 'image/jpeg';
			img.src = 'data:' + mime + ';base64,' + meta.coverArt.toString('base64');
			img.addEventListener('load', () => {
				resolve(img);
			}, {once:true});
			img.addEventListener('error', () => {
				resolve();
			}, {once:true});
		}
		else {
			resolve();
		}
	})
}

function loop(){
	renderBar();
	requestAnimationFrame(loop);
	//setTimeout(loop, 100);
}


function renderBar(){
	let proz = 0;
	let time = 0;
	if(g.currentAudio){
		if(g.currentAudio.isFFmpeg && g.currentAudio.player){
			g.currentAudio.currentTime = g.currentAudio.player.getCurrentTime();
		}
		
		if(g.currentAudio.lastTime != g.currentAudio.currentTime){
			g.currentAudio.lastTime = g.currentAudio.currentTime;
			time = g.currentAudio.currentTime;
			proz = time / g.currentAudio.duration;
			g.prog.style.width = (proz*100) + '%';
			let minsec = ut.playTime(time*1000).minsec;
			if(g.lastMinsec !=  minsec){
				g.playtime.innerText = minsec;
				g.lastMinsec = minsec;
			}
		}
	}
	
	
	if(g.last_vol != g.config.volume){
		g.playvolume.innerText = (Math.round(g.config.volume*100)) + '%';
		g.last_vol = g.config.volume;
	}
	
}



// Tools
// ###########################################################################



async function onKey(e) {
	fb(e.keyCode)
	if(e.keyCode == 88){
		document.body.toggleClass('dark');
	}
	if (e.keyCode == 70 || e.keyCode == 102) {
		console.log(g.currentAudio.src)
	}
	if(e.keyCode == 112 && e.ctrlKey && e.shiftKey){
		if(main_env.startType == 'installed'){
			console.log(await registry('register', g.main_env.app_exe, g.main_env.app_path));
		}
	}
	if(e.keyCode == 113 && e.ctrlKey && e.shiftKey){
		if(main_env.startType == 'installed'){
			console.log(await registry('unregister', g.main_env.app_exe, g.main_env.app_path));
		}
	}
	if (e.keyCode == 123) {
		g.win.toggleDevTools();
	}
	else if(e.keyCode == 76){
		toggleLoop();
	}

	if (e.keyCode == 27) {
		g.config_obj.set(g.config);
		app.exit();
	}
	if (e.keyCode == 39) {
		if(e.ctrlKey){ seekFore()}
		else { playNext(); }
	}
	if (e.keyCode == 37) {
		if(e.ctrlKey){ seekBack()}
		else { playPrev(); }
	}
	if (e.keyCode == 38) {
		volumeUp();
	}
	if (e.keyCode == 40) {
		volumeDown();
	}

	if (e.keyCode == 82) {
		shufflePlaylist();
	}
	if (e.keyCode == 73){
		helper.shell.showItemInFolder(g.music[g.idx]);
		//helper.ipcInvoke('w_info', {command:'show'});
		//let win_id = await helper.tools.browserWindow('default', {devTools:true, file:'./html/info.html'});
		//helper.tools.sendToId(win_id, 'frommain', 'helloes');
	}
	
	if(e.keyCode == 32){
		playPause();
	}
	if(e.keyCode == 109 && e.ctrlKey){
		let val = ut.getCssVar('--space-base').value;
		scaleWindow(val-1)
	}
	if(e.keyCode == 107 && e.ctrlKey){
		let val = ut.getCssVar('--space-base').value;
		scaleWindow(val+1)
	}
	if(e.keyCode == 87){
		if(!g.info_win){
			g.info_win = await tools.browserWindow('frameless', {show:false, file:'./html/info.html', init_data:{config:g.config, list:g.msuic, idx:g.idx}})
		}
		//tools.sendToId(g.info_win, 'info', g.currentInfo);
		tools.sendToId(g.info_win, 'command', 'show');
	}
}

async function scaleWindow(val){
	//let bounds = await g.win.getBounds();
	let w_scale = g.config.win_min_width / 10;
	let h_scale = g.config.win_min_height / 10;
	g.config.window.width = parseInt(w_scale * val);
	g.config.window.height = parseInt(h_scale * val);
	if(g.config.window.width < g.config.win_min_width) { g.config.window.width = g.config.win_min_width; val = 10};
	if(g.config.window.height < g.config.win_min_height) { g.config.window.height = g.config.win_min_height; val = 10};
	await g.win.setBounds(g.config.window);
	g.config.space = val;
	ut.setCssVar('--space-base', g.config.space);
	g.config_obj.set(g.config);
}


function fb(o){
    console.log(o);
}

module.exports.init = init;