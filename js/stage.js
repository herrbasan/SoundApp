'use strict';

const { ipcRenderer, webUtils, ipcMain } = require( "electron" );
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const helper = require('../libs/electron_helper/helper.js');
const { Howl, Howler} = require('../libs/howler/dist/howler.js');
const tools = helper.tools;
const app = helper.app;
//const openmpt = require('../html/libopenmpt');
const os = require('node:os');




let player;
let g = {};
g.test = {};
// Init
// ###########################################################################

/*window.libopenmpt = openmpt;
libopenmpt.onRuntimeInitialized = function () {
	console.log('openMPT Initialized')
	init();
};*/
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
	
	g.config_obj = await helper.config('user', default_config);
	g.config =  g.config_obj.data;
	
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
		g.ffmpath = path.resolve(fp + '/bin/linux_bin/ffmpeg');
		g.ffppath = path.resolve(fp + '/bin/linux_bin/ffprobe');
	
	}
	else {
		g.ffmpath = path.resolve(fp + '/bin/win_bin/ffmpeg.exe');
		g.ffppath = path.resolve(fp + '/bin/win_bin/ffprobe.exe');
	}

	
	/* Mod Player */
	player = new window.chiptune({repeatCount: 0, stereoSeparation: 100, interpolationFilter: 0});
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
		g.blocky = false;
		appStart();
	});

	//appStart();
	ipcRenderer.on('main', async (e, data) => {
		console.log(data);
		if(data.length == 1){
			await playListFromSingle(data[0], false);
		}
		else {
			await playListFromMulti(data, false, false);
		}
		playAudio(g.music[g.idx])
	})
	
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
				g.config_obj.write();
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
				pl = await helper.tools.getFilesRecursive(fp, g.supportedFilter);
			}
			else {
				pl = await helper.tools.getFiles(fp, g.supportedFilter);
			}
		}
		else {
			if(helper.tools.checkFileType(fp, g.supportedFilter)){
				let info = path.parse(fp);
				pl = await helper.tools.getFiles(info.dir, g.supportedFilter);
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
					folder_files = await helper.tools.getFilesRecursive(fp, g.supportedFilter);
				}
				else {
					folder_files = await helper.tools.getFiles(fp, g.supportedFilter);
				}
				pl = pl.concat(folder_files);
			}
			else {
				if(helper.tools.checkFileType(fp, g.supportedFilter)){
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



async function playAudio(fp,n){
	let parse = path.parse(fp);
	let bench = performance.now();
	if(player) { player.stop(); }
	if(g.isLoop && !g.supportedMpt.includes(parse.ext.toLocaleLowerCase())){
		playAudioLoop(fp,n);
	}
	else if(!g.blocky){
		g.blocky = true;
		clearAudio();

		if(g.supportedMpt.includes(parse.ext.toLocaleLowerCase())){
			let buffer = await player.load(helper.tools.getFileURL(fp));
			//player.play(buffer);
			player.gain.gain.value = g.config.volume;
			g.currentAudio = {isMod:true, fp:fp, bench:bench, currentTime:0, paused:false, duration:player.duration, 
				play:() =>  { g.currentAudio.paused = false; player.unpause() }, 
				pause:() => { g.currentAudio.paused = true; player.pause() }
			};
			checkState();
			g.currentAudio.fp = fp;
			/*
			player.onMetadata(async (meta) => {
				await renderInfo(fp, meta);
				console.log('Operation took: ' + Math.round((performance.now() - bench)) );
				g.blocky = false;
			})*/
			//await renderInfo(fp);
			//g.blocky = false;
		}
		else {
			let audio = ut.createElement('audio');
			audio.addEventListener('ended', audioEnded);
			if(!g.supportedChrome.includes(parse.ext.toLocaleLowerCase())){
				let tp = await transcodeToFile(fp);
				audio.src = helper.tools.getFileURL(tp);
				audio.cache_path = tp;
			}
			else {
				audio.src = helper.tools.getFileURL(fp);
			}

			let timeout = await ut.awaitEvent(audio, 'canplay', 5000);
			if(timeout != 'timeout'){
				if(n > 0) { audio.currentTime = n}
				audio.play();
			}
			else{
				g.text.innerHTML += 'Error!<br>';
				g.blocky = false;
				return false;
			}
			
			
			g.currentAudio = audio;
			audio.volume = g.config.volume;
			checkState();
			console.log('Operation took: ' + Math.round((performance.now() - bench)) );
			await renderInfo(fp);
			g.blocky = false;
		}
	}
	if(g.info_win) {
		helper.tools.sendToId(g.info_win, 'info', {list:g.music, idx:g.idx});
	}
}

async function playAudioLoop(fp, n){
	if(!g.blocky){
		let bench = performance.now();
		let parse = path.parse(fp);
		g.blocky = true;
		clearAudio();

		let audio;

		if(!g.supportedChrome.includes(parse.ext)){
			let tp = await transcodeToFile(fp);
			audio = new Howl({src:helper.tools.getFileURL(tp), html5:false, loop:true});
			audio.cache_path = tp;
		}
		else {
			audio = new Howl({src:helper.tools.getFileURL(fp), html5:false, loop:true});
		}
		audio.webaudioLoop = true;
		audio.once('load', async (e) => { 
			audio.duration = audio._duration;
			if(n > 0) { audio.seek(n)}
			audio.play();
			g.currentAudio = audio;
			audio.volume(g.config.volume);
			checkState();
			console.log('Operation took: ' + Math.round((performance.now() - bench)) );
			await renderInfo(fp);
			g.blocky = false;
		})
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
			gsap.to(prevCovers[i], {delay:0.2, duration:0.2, opacity:0, onComplete:() => { 
				ut.killMe(prevCovers[i]);
			}})
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
			
			let info = await getFileInfo(fp);
			let stream = info.streams[0];
			let tags = info.format.tags;
			g.currentInfo.file = info;

			if(info.format.format_long_name.includes('Tracker')){
				g.text.appendChild(renderInfoItem('Format:', 'Tracker Format'))
			}
			else {
				g.text.appendChild(renderInfoItem('Format:', stream.codec_long_name))
			}
			g.text.appendChild(renderInfoItem(' ', Math.round(stream.bit_rate/1000) + ' kbs / ' + (stream.channel_layout ? (stream.channel_layout + ' / ') : '') + stream.sample_rate))
			g.text.appendChild(ut.htmlObject(`<div class="space"></div>`))
			if(tags){
				if(tags.artist) { g.text.appendChild(renderInfoItem('Artist:', tags.artist)) }
				if(tags.album) { g.text.appendChild(renderInfoItem('Album:', tags.album)) }
				if(tags.title) { g.text.appendChild(renderInfoItem('Title:', tags.title)) }
			}
			

			
			let cover;
			let id3_cover = await getCoverArt(fp);
			if(id3_cover){
				cover = id3_cover;
			}
			else {
				let images = await helper.tools.getFiles(parse.dir, ['.jpg','.jpeg','.png','.gif']);
				if(images.length > 0){
					//cover = await loadImage(helper.tools.getFileURL(images[images.length-1]))
					cover = await helper.tools.loadImage(images[images.length-1])
				}
			}

			if(cover){
				g.cover.appendChild(cover)
				gsap.set(cover, {opacity:0});
				gsap.to(cover, {duration:0.2, opacity:1})
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
	if(g.currentAudio){
		if(g.currentAudio.isMod){
			player.stop();
			g.currentAudio = undefined;
		}
		else {
			let mem = g.currentAudio;
			if(!mem.webaudioLoop){
				mem.removeEventListener('ended', audioEnded);
			}
			gsap.to(mem, {duration:0.05, volume:0, ease:'linear', onComplete:() => {
				if(mem.webaudioLoop){
					mem.unload();
				}
				else {
					mem.pause();
					mem.src = '';
					mem.load();
				}
				if(mem.cache_path){
					setTimeout(() => { fs.unlink(mem.cache_path)}, 500);
				}
			}})
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
	else {
		if(e){ e.currentTarget.removeEventListener('ended', audioEnded);}
		playNext();
	}
	
}

function checkState(){
	if(g.currentAudio){
		if(g.currentAudio.webaudioLoop) { g.currentAudio.paused = !g.currentAudio.playing()} 
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
	if(g.isLoop){
		g.isLoop = false;
	}
	else {
		g.isLoop = true;
	}
	if(g.currentAudio){
		if(!g.currentAudio.isMod){
			if(g.currentAudio.webaudioLoop) { g.currentAudio.currentTime = g.currentAudio.seek()}
			console.log(g.currentAudio.currentTime);
			playAudio(g.music[g.idx], g.currentAudio.currentTime);
		}
	}
	checkState();
}


function volumeUp(){
	g.config.volume += 0.05;
	if(g.config.volume > 1) { g.config.volume = 1 }
	if(player) { player.gain.gain.value = g.config.volume; }
	if(g.currentAudio.webaudioLoop){ g.currentAudio.volume(g.config.volume)}
	else { g.currentAudio.volume = g.config.volume; }
}

function volumeDown(){
	g.config.volume -= 0.05;
	if(g.config.volume < 0) { g.config.volume = 0 }
	if(player) { player.gain.gain.value = g.config.volume; }
	if(g.currentAudio.webaudioLoop){ g.currentAudio.volume(g.config.volume)}
	else { g.currentAudio.volume = g.config.volume; }
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
		if(g.currentAudio.webaudioLoop){
			g.currentAudio.seek(s);
		}
		else {
			if(g.currentAudio.isMod){
				player.seek(s);
			}
			g.currentAudio.currentTime = s;
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
		let cp = spawn(g.ffppath, [
			'-hide_banner',
			'-print_format', 'json', 
			'-loglevel', 'fatal', 
			'-show_format',
			'-show_error',
			'-show_streams',
			'-show_private_data',
			fp
		]);

		let str = '';
		cp.stdout.on('data', (data) => { 
			str += data.toString();
		});
		cp.stderr.on('data', (data) => { 
			//str += data.toString();
		});
		cp.on('close', (code) => {
			let out = {};
			try{ 
				out = JSON.parse(str);
			}
			catch(err){
				console.log(err);
				out = {'error':err.toString()}
			}
			resolve(out)
		})
	})
}

function getCoverArt(fp){
	return new Promise((resolve, reject) => {
		let cp = spawn(g.ffmpath, [
			'-i',
			fp,
			'-an',
			'-vcodec', 'copy',
			'-f', 'image2pipe', '-'
		]);

		let bufs = [];
		cp.stdout.on('data', function(d){ bufs.push(d); });
		cp.stderr.on('data', (data) => { 
			//str += data.toString();
		});
		cp.on('close', (code) => {
			//console.log(`child process exited with code ${code}`);
			let buf = Buffer.concat(bufs);
			if(buf.length > 0){
				let img = new Image();
				img.src = 'data:image/jpg;base64,' + buf.toString("base64");
				buf = null;
				img.addEventListener('load', () => {
					resolve(img);
				}, {once:true})
			}
			else {
				resolve();
			}
		});
	})
}



function transcodeToFile(fp){
	let hash = crypto.createHash('md5').update(fp).digest("hex");
	let tp = path.join(g.cache_path, hash + g.config.transcode.ext);
	let ff = g.config.transcode.cmd.split(' ');
	ff.unshift('-i', fp, );
	ff.push(tp);

	
	return new Promise(async (resolve, reject) => {
		if(await (helper.tools.fileExists(tp))){
			resolve(tp);
		}
		else {
			let cp = spawn(g.ffmpath, ff);
			let count = 0;

			cp.stdout.on('data', function(d){
				//console.log(data.toString())
			});
			cp.stderr.on('data', (data) => {
				//console.log(data.toString())
			});
			cp.on('close', (code) => {
				resolve(tp);
			});
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
		if(g.currentAudio.webaudioLoop){
			g.currentAudio.currentTime = g.currentAudio.seek();
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
	//fb(e.keyCode)
	if (e.keyCode == 70 || e.keyCode == 102) {
		console.log(g.currentAudio.src)
	}
	
	if (e.keyCode == 123) {
		g.win.toggleDevTools();
	}
	else if(e.keyCode == 76){
		toggleLoop();
	}

	if (e.keyCode == 27) {
		await g.config_obj.write();
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
			g.info_win = await helper.tools.browserWindow('frameless', {show:false, file:'./html/info.html', init_data:{config:g.config, list:g.msuic, idx:g.idx}})
		}
		//helper.tools.sendToId(g.info_win, 'info', g.currentInfo);
		helper.tools.sendToId(g.info_win, 'command', 'show');
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
	g.config_obj.write();
}


function fb(o){
    console.log(o);
}

module.exports.init = init;