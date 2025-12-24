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

function fileBaseName(fp){
	if(!fp) return '';
	let s = '' + fp;
	s = s.replace(/\\/g, '/');
	let i = s.lastIndexOf('/');
	if(i >= 0) s = s.substring(i+1);
	return s;
}

async function init(){
	console.log('Main init')
	engine = new MixerEngine();
	Transport = engine.Transport;
	g.content = ut.el('#content');
	g.mixer_container = g.content.el('.mixer-container');
	g.mixer = g.content.el('.mixer');
	g.channels = g.mixer.el('.channels');
	g.add_zone = g.channels.el('.add-zone');
	g.name_tooltip = g.mixer.el('.name-tooltip');

	g.transport = ut.el('.transport');
	g.transport_current = g.transport.el('.time .current');
	g.transport_duration = g.transport.el('.time .duration');
	g.transport_bar = g.transport.el('.bar .inner');
	g.btn_play = ut.el('#btn_play');
	g.btn_reset = ut.el('#btn_reset');
	g.master_slider = ut.el('#master_slider');
	g.master_bar = g.master_slider.el('.inner');

	g.duration = 0;
	g.channels.classList.add('empty');

	if(g.add_zone){
		g.add_zone.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
			g.add_zone.classList.add('dragover');
		});
		g.add_zone.addEventListener('dragleave', () => {
			g.add_zone.classList.remove('dragover');
		});
		g.add_zone.addEventListener('drop', async (e) => {
			e.preventDefault();
			g.add_zone.classList.remove('dragover');
			const files = e.dataTransfer.files;
			if(files.length > 0){
				if(!g.currentChannels) {
					engine.start();
					g.currentChannels = [];
					ut.killMe(ut.el('.channels .dummy'));
					g.channels.classList.remove('empty');
					loop();
				}
				for(let i=0; i<files.length; i++){
					const file = files[i];
					const url = URL.createObjectURL(file);
					const track = engine.createTrack();
					const el = g.channels.insertBefore(renderChannel(g.currentChannels.length, file.name, g.currentChannels.length + 1), g.add_zone);
					await track.load(url);
					if(Transport.state === 'started') track._startAt(Transport.seconds);
					g.currentChannels.push({el, track});
					if(track.duration > g.duration) g.duration = track.duration;
				}
			}
		});
	}

	ut.dragSlider(g.transport, (e) => { seekProz(e.prozX) }, 120)
	ut.dragSlider(g.master_slider, (e) => { 
		engine.setMasterGain(e.prozX);
		g.master_bar.style.width = (e.prozX * 100) + '%';
	});

	g.btn_play.addEventListener("click", async () =>  {
		if(g.currentChannels){
			await engine.start();
			if(Transport.state == 'started'){
				Transport.pause();
			}
			else {
				Transport.start();
			}
		}
	});
	g.btn_reset.addEventListener("click", () => {
		seek(0);
		Transport.stop();
	});
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
			
			let el = target.appendChild(renderChannel(i, prop[i], prop.length));
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

function renderChannel(idx, fp, total){
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
			<div class="info">
				<img class="fileicon" src="../build/icons/pcm.ico" draggable="false">
				<svg class="close" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M0 0h24v24H0V0z" fill="none"/>
					<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
				</svg>
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
	html.info = html.el('.info');
	html.slider = html.el('.gain .slider');
	html.slider_num = html.el('.gain .slider .num');
	html.pan_line = html.pan.el('.line');
	html.mute = html.el('.mute');
	html.solo = html.el('.solo');
	html.btn_close = html.el('.info .close');
	html.filename = fileBaseName(fp);

	html.info.addEventListener('mouseenter', () => showNameTooltip(html, html.info));
	html.info.addEventListener('mouseleave', hideNameTooltip);
	
	html.addEventListener('dragover', (e) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		html.classList.add('dragover');
	});
	html.addEventListener('dragleave', () => {
		html.classList.remove('dragover');
	});
	html.addEventListener('drop', async (e) => {
		e.preventDefault();
		html.classList.remove('dragover');
		const files = e.dataTransfer.files;
		if(files.length > 0){
			const file = files[0];
			html.filename = file.name;
			const url = URL.createObjectURL(file);
			const trackObj = g.currentChannels.find(c => c.el === html);
			if(trackObj){
				await trackObj.track.load(url);
				if(Transport.state === 'started') {
					trackObj.track._stopSource();
					trackObj.track._startAt(Transport.seconds);
				}
				let maxD = 0;
				for(let i=0; i<g.currentChannels.length; i++){
					if(g.currentChannels[i].track.duration > maxD) maxD = g.currentChannels[i].track.duration;
				}
				g.duration = maxD;
			}
		}
	});

	html.mute.addEventListener('click', mute)
	html.solo.addEventListener('click', solo)
	html.btn_close.addEventListener('click', (e) => {
		e.stopPropagation();
		removeTrack(html);
	})

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

function removeTrack(el){
	if(!g.currentChannels) return;
	let idx = -1;
	for(let i=0; i<g.currentChannels.length; i++){
		if(g.currentChannels[i].el === el){
			idx = i;
			break;
		}
	}
	if(idx >= 0){
		const item = g.currentChannels[idx];
		item.track.dispose();
		ut.killMe(item.el);
		g.currentChannels.splice(idx, 1);
		
		// Recalculate duration
		let maxD = 0;
		for(let i=0; i<g.currentChannels.length; i++){
			if(g.currentChannels[i].track.duration > maxD) maxD = g.currentChannels[i].track.duration;
		}
		g.duration = maxD;
		if(g.currentChannels.length === 0) g.channels.classList.add('empty');
		hideNameTooltip();
	}
}


function showNameTooltip(stripEl, infoEl){
	if(!g.name_tooltip) return;
	const name = stripEl && stripEl.filename ? stripEl.filename : '';
	if(!name) return;
	g.name_tooltip.innerHTML = `<div class="text">${name}</div>`;
	g.name_tooltip.classList.add('active');

	const rMixer = g.mixer.getBoundingClientRect();
	const rInfo = (infoEl || stripEl).getBoundingClientRect();
	
	const tipW = g.name_tooltip.offsetWidth;
	const tipH = g.name_tooltip.offsetHeight;

	// Position below the info row
	let top = (rInfo.bottom - rMixer.top) + 8;
	let left = (rInfo.left + rInfo.width / 2 - rMixer.left) - tipW / 2;

	// Clamp horizontal: keep within mixer bounds
	if (left < 5) left = 5;
	if (left + tipW > rMixer.width - 5) left = rMixer.width - tipW - 5;

	g.name_tooltip.style.top = top + 'px';
	g.name_tooltip.style.left = left + 'px';

	// Center the spike on the info container
	const infoCenterX = rInfo.left + rInfo.width / 2 - rMixer.left;
	const spikeX = infoCenterX - left;
	g.name_tooltip.style.setProperty('--spike-x', spikeX + 'px');
}

function hideNameTooltip(){
	if(!g.name_tooltip) return;
	g.name_tooltip.classList.remove('active');
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
		if(state === 'started'){
			g.btn_play.classList.add('playing');
		} else {
			g.btn_play.classList.remove('playing');
		}
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