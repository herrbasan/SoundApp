import nui from '../../libs/nui/nui.js';
import ut from '../../libs/nui/nui_ut.js';
import superSelect from '../../libs/nui/nui_select.js';
import dragSlider from '../../libs/nui/nui_drag_slider.js';
import { MixerEngine } from './mixer_engine.js';

ut.dragSlider = dragSlider;

let main = {};
let g = {};
let engine;
let Transport;

async function init(){
	console.log('Main init')
	engine = new MixerEngine();
	Transport = engine.Transport;
	g.content = ut.el('#content');
	g.mixer_container = g.content.el('.mixer-container');
	g.mixer = g.content.el('.mixer');
	g.channels = g.mixer.el('.channels');

	g.transport = g.mixer.el('.transport');
	g.transport_current = g.transport.el('.time .current');
	g.transport_duration = g.transport.el('.time .duration');
	g.transport_bar = g.transport.el('.bar .inner');
	g.btn_play = ut.el('#btn_start');
	g.btn_play_label = g.btn_play.el('label');
	g.btn_stop = ut.el('#btn_stop');

	g.duration = 0;

	ut.el('#btn_load').addEventListener('click', initTone);

	ut.dragSlider(g.transport, (e) => { seekProz(e.prozX) }, 120)
	g.btn_play.addEventListener("click", async () =>  {
		if(g.currentChannels && !g.isLoading){
			await engine.start();
			if(Transport.state == 'started'){
				Transport.pause();
			}
			else {
				Transport.start();
			}
		}
	});
	g.btn_stop.addEventListener("click", () => Transport.stop());
	
	

	g.files = [
		{name:'Mist', dir:'mist', length:6, ext:'m4a'},
		{name:'Play 11', dir:'play11', length:14, ext:'m4a'},
		{name:'Rejam 2017', dir:'rejam', length:11, ext:'m4a'},
		{name:'Skipping Fantasy', dir:'skipping', length:11, ext:'m4a'},
		{name:'Anew', dir:'Anew', length:9, ext:'m4a'},
		{name:'Browsing UVI', dir:'Browsing_UVI', length:8, ext:'m4a'},
		{name:'Chip', dir:'Chip', length:8, ext:'m4a'},
		{name:'Does it really need a name?', dir:'doesit', length:12, ext:'m4a'},
		{name:'First move', dir:'first_move', length:6, ext:'m4a'},
		{name:'Groovlik', dir:'groovelik', length:6, ext:'m4a'},
		{name:'Hell is where the Heart is', dir:'hell', length:6, ext:'m4a'},
		{name:'Hussle', dir:'hussle', length:7, ext:'m4a'},
		{name:'KGroove', dir:'kgroove', length:7, ext:'m4a'},
		{name:'Omni', dir:'omni', length:15, ext:'m4a'},
		{name:'Freakin Freak', dir:'Freakinfreak', length:12, ext:'m4a'},
		{name:'The Game', dir:'tp_game', length:17, ext:'m4a'},
		{name:'Brattle', dir:'brattle', length:9, ext:'m4a'},
		{name:'Shits and Giggles', dir:'shits', length:10, ext:'m4a'},
		{name:'Speedo', dir:'speedo', length:7, ext:'m4a'},
		{name:'Again and Again', dir:'Again', length:13, ext:'m4a'},
		{name:'WeWriWa', dir:'wewriwa', length:10, ext:'m4a'}
	]

	g.fileSelect = ut.el('.file-select select');
	for(let i=0; i<g.files.length; i++){
		let html = ut.createElement('option', {attributes:{value:i}, inner:g.files[i].name})
		g.fileSelect.appendChild(html);
	}
	g.fileSelect = superSelect(g.fileSelect)
	g.fileSelect.container.addEventListener('click', firstClick)
	g.fileSelect.addEventListener('change', (e) => {
		let val = parseInt(e.detail.option.value);
		if(g.currentFile != g.files[val]){
			g.currentFile = g.files[val];
			console.log(g.currentFile);
			initTone();
		}
	})
	
}

function wait(ms){
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// NUI's app chrome / navigation is intentionally not used in this prototype.

function firstClick(e){
	console.log('First Click');
	e.currentTarget.removeEventListener('click', firstClick)
	//Tone.start();
}

function initTone(){
	if(!g.isLoading){
		engine.start();
		g.fileSelect.disable();
		if(g.currentChannels){
			cleanUp(g.currentChannels);
		}
		let loader = loaderShow(g.channels);
		ut.killMe(ut.el('.channels .dummy'));
		g.isLoading = true;
		makeChannels(loadList(g.currentFile.dir,g.currentFile.length,g.currentFile.ext), g.channels).then((ret) => {
			console.log('All Tracks Loaded', ret)
			
			g.currentChannels = ret;
			Transport.start();
			loop();
			
			for(let i=0; i<g.currentChannels.length; i++){
				if(g.currentChannels[i].track.duration > g.duration){
					g.duration = g.currentChannels[i].track.duration;
				}
			}
			console.log(g.duration);
			g.isLoading = false;
			nui.animate_away(loader);
			g.fileSelect.enable();
		})
	}
}

function seekProz(proz){ if(g.currentChannels){ seek(g.duration * proz); }}
function seek(sec){ Transport.seconds = sec; }

function makeChannels(prop, target) {
	let promises = [];
	let tracks = [];
	return new Promise(async (resolve, reject) => {
		for(let i=0; i<prop.length; i++){
			console.log('Create Channel for ' + prop[i])
			let track = engine.createTrack();
			
			let el = target.appendChild(renderChannel(i));
			promises.push(track.load(prop[i]));
			tracks.push({el, track})
		}
		await Promise.allSettled(promises);
		resolve(tracks);
	})
}

function cleanUp(ar){
	Transport.stop();
	for(let i=0; i<ar.length; i++){
		let obj = ar[i];
		for(let key in obj){
			
			if(key == 'el'){
				console.log(`Channel ${i} - ${key} killed`)
				ut.killMe(obj[key]);
			}
			else {
				if(obj[key] && obj[key].dispose) { obj[key].dispose(); console.log(`Channel ${i} - ${key} disposed`)};
			}
		}
	}
	g.currentChannels = undefined;
	g.duration = 0;
}

function renderChannel(idx){
	let html = ut.htmlObject(/*html*/ `
		<div class="strip">
			<div class="mute">M</div>
			<div class="solo">S</div>
			<div class="meter">
				<div class="gain">
					<div class="slider">
						<div class="num">1.00</div>
						<div class="line"></div>
					</div>
				</div>
				<div class="bar"></div>
			</div>
			<div class="pan">
				<div class="line"></div>
			</div>
		</div>
	`)

	html.idx = idx;
	html.state = {
		gain:0.5, 
		pan:0.5, 
		mute:false,
		mute_mem: false, 
		solo:false,
		last_gain:0.5,
		last_pan:0.5, 
		last_mute:false,
		last_solo:false
	};

	html.meter = html.el('.meter .bar');
	html.pan = html.el('.pan');
	html.gain = html.el('.gain');
	html.slider = html.el('.gain .slider');
	html.slider_num = html.el('.gain .slider .num');
	html.pan_line = html.pan.el('.line');
	html.mute = html.el('.mute');
	html.solo = html.el('.solo');
	
	html.mute.addEventListener('click', mute)
	html.solo.addEventListener('click', solo)

	function mute(){
		if(soloCount() > 0){
			solo();
		}
		else {
			if(html.state.mute){ 
				html.state.mute = false;
			}
			else {
				html.state.mute = true;
			}
			html.state.mute_mem = html.state.mute;
			updateState()
		}
	}

	function soloCount(){
		let solo_count = 0;
		for(let i=0; i<g.currentChannels.length; i++){
			if(g.currentChannels[i].el.state.solo){ 
				solo_count++
			}
		}
		return solo_count;
	}

	function solo(){
		if(html.state.solo){
			if(soloCount() == 1){
				console.log('last solo')
				for(let i=0; i<g.currentChannels.length; i++){
					let el = g.currentChannels[i].el;
					el.state.mute = el.state.mute_mem;
				}
				html.state.solo = false;
				html.state.mute = html.state.mute_mem;
			}
			else {
				html.state.solo = false;
				html.state.mute = true;
			}
		}
		else {
			for(let i=0; i<g.currentChannels.length; i++){
				let el = g.currentChannels[i].el;
				if(!el.state.solo){
					el.state.mute = true;
				}
			}
			html.state.mute = false;
			html.state.solo = true;
		}
		updateState()
	}

	ut.dragSlider(html.pan, (e) => { 
		html.state.pan = e.prozX;
		updateState();
	})
	ut.dragSlider(html.gain, (e) => { 
		html.state.gain = e.prozY;
		updateState();
	})
	return html;
}

function updateState(){
	for(let i=0; i<g.currentChannels.length; i++){
		let channel = g.currentChannels[i];
		let html = channel.el;
		let state = html.state;
		if(state.pan != state.last_pan){
			state.last_pan = state.pan;
			channel.track.setPan((2*state.pan)-1);
			html.pan_line.style.left = (state.pan*100) + '%';
		}
		if(state.gain != state.last_gain){
			state.last_gain = state.gain;
			html.slider.style.top = (state.gain*100) + '%';
			html.slider_num.innerText = Math.abs((2*state.gain)-2).toFixed(2);
			if(state.gain < 0.08){ html.slider_num.style.marginTop = html.slider_num.offsetHeight + 'px'}
			else { html.slider_num.style.marginTop = null }
			channel.track.setGain(Math.abs((2*state.gain)-2));
		}
		if(state.last_mute != state.mute){
			console.log('toggle mute to', state.mute)
			channel.track.setMute(state.mute);
			state.last_mute = state.mute;
			if(state.mute){
				html.mute.classList.add('active')
			}
			else {
				html.mute.classList.remove('active')
			}
		}
		if(state.last_solo != state.solo){
			console.log('toggle solo to', state.solo)

			state.last_solo = state.solo;
			if(state.solo){
				html.solo.classList.add('active')
			}
			else {
				html.solo.classList.remove('active')
			}
		}
	}
}



function loadList(dir,length, ext){
	let out = [];
	for(let i=1; i<length+1; i++){
		out.push(`../_Material/mixer_media/${dir}/${ut.lz(i,2)}.${ext}`)
	}
	return out;
}

function loop(){
	requestAnimationFrame(loop);
	if(g.currentChannels){
		updateTransport();
		for(let i=0; i<g.currentChannels.length; i++){
			let item = g.currentChannels[i];
			let level = item.track.getMeter();
			let proz = (level*6) * 100;
			if(proz > 100) { proz = 100; }
			if(proz < 1) { proz = 0; }
			item.el.meter.style.height = proz + '%';
		}
	}
}

function updateTransport(){
	if(g.transport.duration != g.duration){
		g.transport_duration.innerText = ut.playTime(g.duration*1000).minsec;
		g.transport.duration = g.duration;
	}
	let current = Transport.seconds;
	if(g.duration > 0 && current >= g.duration){
		Transport.stop();
	}
	if(g.transport.current != current){
		g.transport_current.innerText = ut.playTime(current*1000).minsec;
		g.transport.current = current;
	}
	let proz = current / g.duration;
	if(g.transport.proz != proz){
		g.transport_bar.style.width = proz*100 + '%';
		g.transport.proz = proz;
	}
	let state = Transport.state;
	if(state != g.transport.last_state){
		g.transport.last_state = state;
	}
}

function fetchBuffer(fp) {
	return new Promise(async (resolve, reject) => {
		let response = await fetch(fp);
		let ab = await response.arrayBuffer();
		resolve(ab);
	})
}

function loaderShow(t){
	let html = ut.htmlObject( /*html*/`
		<div class="loader">
			<div class="nui-loader-spinner"></div>
			<div class="nui-loader-spinner-text">Loading Tracks</div>
		</div>
	`)
	return t.appendChild(html);
}

main.init = init;
export { main };