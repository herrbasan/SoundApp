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

let tools;
if(typeof window !== 'undefined' && window.bridge && window.bridge.isElectron){
	try {
		tools = require('../../libs/electron_helper/helper_new.js').tools;
	} catch(e) {}
}

let webUtils;
if(typeof window !== 'undefined' && window.bridge && window.bridge.isElectron){
	try {
		webUtils = require('electron').webUtils;
	} catch(e) {}
}

function _getElectronPathForFile(f){
	if(!webUtils || !f) return '';
	try {
		const p = webUtils.getPathForFile(f);
		return p ? ('' + p) : '';
	} catch(e) {}
	return '';
}

let _loopStarted = false;

let DEBUG_DND = true;

function _copyToClipboard(text){
	if(text == null) return false;
	text = '' + text;
	if(typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText){
		try {
			navigator.clipboard.writeText(text);
			return true;
		} catch(e) {}
	}
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		ta.style.top = '-9999px';
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand && document.execCommand('copy');
		document.body.removeChild(ta);
		return !!ok;
	} catch(e) {}
	return false;
}

function _setSyncOverlayVisible(v){
	v = !!v;
	g.sync_overlay_visible = v;
	if(g.sync_overlay){
		g.sync_overlay.style.display = v ? 'block' : 'none';
	}
}

function _buildSyncSnapshot(){
	const snap = {
		ts: Date.now(),
		iso: new Date().toISOString(),
		transportSeconds: Transport ? Transport.seconds : NaN,
		refSeconds: NaN,
		tracks: []
	};

	if(!g || !g.currentChannels || !g.currentChannels.length) return snap;

	let refSec = snap.transportSeconds;
	const tr0 = g.currentChannels[0] ? g.currentChannels[0].track : null;
	if(tr0 && tr0.ffPlayer && typeof tr0.ffPlayer.getCurrentTime === 'function'){
		refSec = tr0.ffPlayer.getCurrentTime();
	}
	snap.refSeconds = refSec;

	for(let i=0; i<g.currentChannels.length; i++){
		const item = g.currentChannels[i];
		const tr = item ? item.track : null;
		const fp = tr && tr.ffPlayer ? tr.ffPlayer : null;
		const name = (item && item.el && item.el.filename) ? ('' + item.el.filename) : '';
		const inIdx = tr ? (tr.idx | 0) : -1;
		const entry = {
			index: i + 1,
			input: inIdx,
			name,
			type: fp ? 'ff' : 'buf',
			timeSeconds: NaN,
			driftTransportMs: NaN,
			driftRefMs: NaN,
			underrunFrames: null,
			underrunMs: null,
			queuedChunks: null,
			frames: null,
			lastLoadMode: tr && tr.lastLoadMode ? ('' + tr.lastLoadMode) : '',
			lastLoadNote: tr && tr.lastLoadNote ? ('' + tr.lastLoadNote) : '',
			lastLoadError: tr && tr.lastLoadError ? ('' + tr.lastLoadError) : ''
		};

		if(fp && typeof fp.getCurrentTime === 'function'){
			const t = fp.getCurrentTime();
			entry.timeSeconds = t;
			entry.driftTransportMs = (t - snap.transportSeconds) * 1000;
			entry.driftRefMs = (t - refSec) * 1000;
			const ufr = (fp._underrunFrames !== undefined) ? (fp._underrunFrames | 0) : 0;
			const usr = (fp._sampleRate | 0) > 0 ? (fp._sampleRate | 0) : 44100;
			entry.underrunFrames = ufr;
			entry.underrunMs = (ufr / usr) * 1000;
			entry.queuedChunks = (fp._queuedChunks !== undefined) ? (fp._queuedChunks | 0) : -1;
			entry.frames = (fp.currentFrames | 0);
		}
		else {
			let t = NaN;
			if(tr && tr.source && tr.engine && tr._bufStartCtxTime >= 0){
				t = (tr.engine.ctx.currentTime - tr._bufStartCtxTime) + (tr._bufStartOffset || 0);
			}
			entry.timeSeconds = t;
			entry.driftTransportMs = isFinite(t) ? ((t - snap.transportSeconds) * 1000) : NaN;
			entry.driftRefMs = isFinite(t) ? ((t - refSec) * 1000) : NaN;
		}
		snap.tracks.push(entry);
	}

	return snap;
}

function _formatMs(v){
	if(!isFinite(v)) return '---.-';
	return (v >= 0 ? '+' : '') + v.toFixed(1);
}

function _padRight(s, n){
	s = '' + (s == null ? '' : s);
	if(s.length >= n) return s;
	return s + ' '.repeat(n - s.length);
}

function _padLeft(s, n){
	s = '' + (s == null ? '' : s);
	if(s.length >= n) return s;
	return ' '.repeat(n - s.length) + s;
}

async function _resetUiToEmpty(){
	if(!g || !g.channels || !g.add_zone) return;
	if(g.currentChannels){
		for(let i=0; i<g.currentChannels.length; i++){
			try { await g.currentChannels[i].track.dispose(); } catch(e) {}
			try { ut.killMe(g.currentChannels[i].el); } catch(e) {}
		}
	}
	// Remove any remaining strips/dummies, keep add-zone.
	const kids = g.channels.children;
	for(let i=kids.length-1; i>=0; i--){
		const el = kids[i];
		if(!el) continue;
		if(el === g.add_zone) continue;
		ut.killMe(el);
	}
	// Restore dummy placeholder.
	const dummy = document.createElement('div');
	dummy.className = 'dummy';
	g.channels.insertBefore(dummy, g.add_zone);
	g.channels.classList.add('empty');
	g.currentChannels = null;
	g.duration = 0;
	hideNameTooltip();
	if(g.transport_current) g.transport_current.innerText = '0:00';
	if(g.transport_duration) g.transport_duration.innerText = '0:00';
	if(g.transport_bar) g.transport_bar.style.width = '0%';
	if(g.btn_play) g.btn_play.classList.remove('playing');
	if(g.transport){
		g.transport.duration = -1;
		g.transport.current = -1;
		g.transport.proz = -1;
		g.transport.last_state = '';
	}
}

async function _disposeEngine(){
	if(!engine) return;
	try { await engine.dispose(); } catch(e) { console.error('Engine dispose error:', e); }
	engine = null;
	Transport = null;
}

async function resetForNewPlaylist(paths){
	await _resetUiToEmpty();
	await _disposeEngine();
	engine = new MixerEngine(g && g.initData ? g.initData : null);
	Transport = engine.Transport;
	if(paths && paths.length) await loadPaths(paths);
}

function fileBaseName(fp){
	if(!fp) return '';
	let s = '' + fp;
	s = s.replace(/\\/g, '/');
	let i = s.lastIndexOf('/');
	if(i >= 0) s = s.substring(i+1);
	return s;
}

function _decodeFileUri(u){
	let s = (u || '').trim();
	if(!s) return '';
	if(s.startsWith('file:///')) s = s.substring(8);
	else if(s.startsWith('file://')) s = s.substring(7);
	try { s = decodeURIComponent(s); } catch(e) {}
	// Normalize slashes for Windows paths
	s = s.replace(/\//g, '\\');
	return s;
}

function getDroppedPaths(dt){
	const out = [];
	if(!dt || !dt.getData) return out;
	let s = '';
	try { s = '' + (dt.getData('text/uri-list') || ''); } catch(e) {}
	if(!s){
		try { s = '' + (dt.getData('text/plain') || ''); } catch(e) {}
	}
	if(!s) return out;
	const lines = s.split(/\r?\n/);
	for(let i=0; i<lines.length; i++){
		let line = (lines[i] || '').trim();
		if(!line) continue;
		if(line[0] === '#') continue;
		if(line.startsWith('file:')){
			const p = _decodeFileUri(line);
			if(p) out.push(p);
		}
		else {
			// Plain paths (Windows) may appear here.
			out.push(line);
		}
	}
	return out;
}

function dumpDataTransfer(dt){
	const o = {};
	if(!dt) return o;
	try {
		if(dt.types && dt.types.length){
			const ar = [];
			for(let i=0; i<dt.types.length; i++) ar.push('' + dt.types[i]);
			o.types = ar;
		}
	} catch(e) {}
	try {
		o.filesLen = dt.files ? (dt.files.length | 0) : 0;
		if(o.filesLen > 0){
			const f0 = dt.files[0];
			const p0 = _getElectronPathForFile(f0);
			o.file0 = {
				name: '' + (f0 && f0.name ? f0.name : ''),
				size: f0 && f0.size ? (f0.size | 0) : 0,
				type: '' + (f0 && f0.type ? f0.type : ''),
				hasPath: !!(f0 && f0.path),
				path: f0 && f0.path ? ('' + f0.path) : '',
				webUtilsPath: p0 ? p0 : ''
			};
		}
	} catch(e) {}
	if(dt.getData){
		try {
			let s = '' + (dt.getData('text/uri-list') || '');
			s = s.replace(/\r/g, '');
			if(s.length > 800) s = s.substring(0, 800) + '...';
			o.uriList = s;
		} catch(e) {}
		try {
			let s = '' + (dt.getData('text/plain') || '');
			s = s.replace(/\r/g, '');
			if(s.length > 800) s = s.substring(0, 800) + '...';
			o.textPlain = s;
		} catch(e) {}
	}
	return o;
}

function collectDroppedFiles(dt){
	const out = [];
	// In Electron, dt.files provides File objects with a .path property.
	// dt.items.getAsFile() often drops .path, which forces us into the slower buffer decode path.
	if(window.bridge && window.bridge.isElectron && dt && dt.files && dt.files.length){
		const files = dt.files;
		for(let i=0; i<files.length; i++){
			const f = files[i];
			if(!f) continue;
			const name = '' + (f.name || '');
			const hasExt = name.lastIndexOf('.') > 0;
			// Heuristic: folders often come through with empty type, size=0, and no extension.
			if(!f.type && !f.size && !hasExt) continue;
			out.push(f);
		}
		return out;
	}
	if(dt && dt.items && dt.items.length){
		const items = dt.items;
		for(let i=0; i<items.length; i++){
			const it = items[i];
			if(!it || it.kind !== 'file') continue;
			let entry = null;
			if(it.webkitGetAsEntry){
				try { entry = it.webkitGetAsEntry(); } catch(e) {}
			}
			if(entry && entry.isDirectory) continue;
			let f = null;
			if(it.getAsFile){
				try { f = it.getAsFile(); } catch(e) {}
			}
			if(f) out.push(f);
		}
		if(out.length) return out;
	}
	if(dt && dt.files && dt.files.length){
		const files = dt.files;
		for(let i=0; i<files.length; i++){
			const f = files[i];
			if(!f) continue;
			const name = '' + (f.name || '');
			const hasExt = name.lastIndexOf('.') > 0;
			// Heuristic: folders often come through with empty type, size=0, and no extension.
			if(!f.type && !f.size && !hasExt) continue;
			out.push(f);
		}
	}
	return out;
}

async function init(initData){
	console.log('Mixer init', initData);
	g.initData = initData || {};

	engine = new MixerEngine(g.initData);
	Transport = engine.Transport;
	g.content = ut.el('#content');
	g.mixer_container = g.content.el('.mixer-container');
	g.mixer = g.content.el('.mixer');
	g.channels = g.mixer.el('.channels');
	g.add_zone = g.channels.el('.add-zone');
	g.name_tooltip = g.mixer.el('.name-tooltip');

	// Floating sync debug overlay (kept separate from the strips for readability)
	g.sync_overlay = document.createElement('div');
	g.sync_overlay.className = 'sync-overlay';
	g.sync_overlay_hdr = document.createElement('div');
	g.sync_overlay_hdr.className = 'hdr';
	g.sync_overlay_btn = document.createElement('button');
	g.sync_overlay_btn.className = 'btn';
	g.sync_overlay_btn.type = 'button';
	g.sync_overlay_btn.textContent = 'Snapshot';
	g.sync_overlay_hdr_info = document.createElement('div');
	g.sync_overlay_hdr_info.className = 'hint';
	g.sync_overlay_hdr_info.textContent = 'Ctrl+Shift+D';
	g.sync_overlay_hdr.appendChild(g.sync_overlay_btn);
	g.sync_overlay_hdr.appendChild(g.sync_overlay_hdr_info);
	g.sync_overlay_pre = document.createElement('pre');
	g.sync_overlay.appendChild(g.sync_overlay_hdr);
	g.sync_overlay.appendChild(g.sync_overlay_pre);
	document.body.appendChild(g.sync_overlay);

	g.sync_overlay_btn.addEventListener('click', () => {
		const snap = _buildSyncSnapshot();
		_copyToClipboard(JSON.stringify(snap, null, 2));
	});

	g.sync_overlay_visible = false;
	_setSyncOverlayVisible(false);

	window.addEventListener('keydown', (e) => {
		if(!e) return;
		if(!e.ctrlKey || !e.shiftKey) return;
		const code = '' + (e.code || '');
		const key = ('' + (e.key || '')).toLowerCase();
		if(code === 'KeyD' || key === 'd'){
			e.preventDefault();
			e.stopPropagation();
			_setSyncOverlayVisible(!g.sync_overlay_visible);
		}
	});

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

	// Prototype behavior: drag/drop add zone
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
			if(DEBUG_DND) console.log('[Mixer DnD] add-zone drop', dumpDataTransfer(e.dataTransfer));
			const files = collectDroppedFiles(e.dataTransfer);
			const dtPaths = (window.bridge && window.bridge.isElectron) ? getDroppedPaths(e.dataTransfer) : null;
			if(files.length > 0){
				if(!g.currentChannels) {
					await engine.start();
					g.currentChannels = [];
					ut.killMe(ut.el('.channels .dummy'));
					g.channels.classList.remove('empty');
					if(!_loopStarted){ _loopStarted = true; loop(); }
				}
				const promises = [];
				for(let i=0; i<files.length; i++){
					const file = files[i];
					let src = file;
					if(window.bridge && window.bridge.isElectron){
						const p = _getElectronPathForFile(file);
						if(p) src = p;
						else if(dtPaths && dtPaths.length){
							// Try order match first, otherwise fall back to first path.
							src = dtPaths[i] || dtPaths[0];
						}
					}
					if(DEBUG_DND) console.log('[Mixer DnD] add-zone item', { i, name: file && file.name ? file.name : '', hasFilePath: !!(file && file.path), webUtilsPath: _getElectronPathForFile(file), chosenSrcType: typeof src, chosenSrc: (typeof src === 'string' ? src : '[object]') });
					const track = engine.createTrack();
					const el = g.channels.insertBefore(renderChannel(g.currentChannels.length, file.name, g.currentChannels.length + 1), g.add_zone);
					g.currentChannels.push({el, track});
					
					promises.push((async () => {
						try {
							await track.load(src);
							if(track.duration > g.duration) g.duration = track.duration;
							if(Transport.state === 'started') {
								if(track.ffPlayer) track.ffPlayer.seek(Transport.seconds);
								track._startAt(Transport.seconds);
							}
						} catch(err) {
							console.error('Mixer load failed:', file && file.name ? file.name : file, err);
						}
					})());
				}
				await Promise.all(promises);
				// Auto-play when dropping files into the add-zone if not already playing
				if(Transport.state !== 'started' && g.currentChannels && g.currentChannels.length > 0){
					Transport.start();
				}
			}
		});
	}

	ut.dragSlider(g.transport, (e) => { seekProz(e.prozX) }, 120);
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

	// If Stage provides playlist data later, this is where we will hook it in.
	const pl = initData && initData.playlist ? initData.playlist : null;
	const paths = pl && Array.isArray(pl.paths) ? pl.paths : null;
	if(paths && paths.length){
		await loadPaths(paths);
		// Auto-play when opened with tracks (e.g. "Open in Mixer")
		if(g.currentChannels && g.currentChannels.length > 0){
			Transport.start();
		}
	}

	// Reset + reload when Stage hands over a new playlist to an already-open mixer window.
	if(window.bridge && window.bridge.isElectron && window.bridge.on){
		window.bridge.on('mixer-playlist', async (data) => {
			const p = data && Array.isArray(data.paths) ? data.paths : null;
			if(!p) return;
			// Keep initData (ffmpeg paths/config) but update playlist payload for consistency.
			if(g && g.initData){
				g.initData.playlist = { paths: p, idx: (data && (data.idx|0)) ? (data.idx|0) : 0 };
			}
			await resetForNewPlaylist(p);
			// Auto-play when receiving new playlist via "M" key
			if(g.currentChannels && g.currentChannels.length > 0){
				Transport.start();
			}
		});

		window.bridge.on('hide-window', async () => {
			console.log('Mixer hidden, disposing resources...');
			await _resetUiToEmpty();
			await _disposeEngine();
		});

		window.bridge.on('config-changed', async (newConfig) => {
			const oldBuffer = engine.initData.config.bufferSize;
			const oldThreads = engine.initData.config.decoderThreads;
			engine.initData.config = newConfig;

			// If streaming settings changed, perform a clean reset of all tracks
			if (g.currentChannels && (oldBuffer !== newConfig.bufferSize || oldThreads !== newConfig.decoderThreads)) {
				console.log('Mixer: Streaming settings changed, resetting all tracks...');
				const pos = Transport.seconds;
				const wasPlaying = Transport.state === 'started';

				// Stop all first
				Transport.stop();

				// Re-open all tracks with new settings
				const tasks = g.currentChannels.map(c => c.track.load(c.track.src));
				try {
					await Promise.all(tasks);
					if (pos > 0) seek(pos);
					if (wasPlaying) Transport.start();
				} catch (err) {
					console.error('Mixer: Failed to reset tracks after config change:', err);
				}
			}
		});
	}

	// Cleanup on close (Electron) and on reload/close (browser preview).
	window.addEventListener('beforeunload', () => {
		try { _resetUiToEmpty(); } catch(e) {}
		try { _disposeEngine(); } catch(e) {}
	});
}

async function loadPaths(paths){
	if(!paths || !paths.length) return;
	await engine.start();

	if(!g.currentChannels) {
		g.currentChannels = [];
		ut.killMe(ut.el('.channels .dummy'));
		g.channels.classList.remove('empty');
		if(!_loopStarted){ _loopStarted = true; loop(); }
	}

	for(let i=0; i<paths.length; i++){
		const fp = paths[i];
		const track = engine.createTrack();
		const el = g.channels.insertBefore(renderChannel(g.currentChannels.length, fp, g.currentChannels.length + 1), g.add_zone);
		try {
			await track.load(fp);
			if(track.duration > g.duration) g.duration = track.duration;
		} catch(err) {
			console.error('Mixer load failed:', fp, err);
		}
		g.currentChannels.push({ el, track });
	}
}

function seekProz(proz){ if(g.currentChannels){ seek(g.duration * proz); }}
function seek(sec){ Transport.seconds = sec; }

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
				<div class="trackno"></div>
				<svg class="close" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M0 0h24v24H0V0z" fill="none"/>
					<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
				</svg>
			</div>
		</div>
	`);

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
	html.trackno = html.el('.info .trackno');
	html.slider = html.el('.gain .slider');
	html.slider_num = html.el('.gain .slider .num');
	html.pan_line = html.pan.el('.line');
	html.mute = html.el('.mute');
	html.solo = html.el('.solo');
	html.btn_close = html.el('.info .close');
	html.filename = fileBaseName(fp);
	if(html.trackno){
		const n = (total || (idx + 1)) | 0;
		html.trackno.textContent = (n > 0 && n < 10 ? '0' : '') + n;
	}

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
		if(DEBUG_DND) console.log('[Mixer DnD] strip drop', dumpDataTransfer(e.dataTransfer));
		const files = collectDroppedFiles(e.dataTransfer);
		const dtPaths = (window.bridge && window.bridge.isElectron) ? getDroppedPaths(e.dataTransfer) : null;
		if(files.length > 0){
			const file = files[0];
			let src = file;
			if(window.bridge && window.bridge.isElectron){
				const p = _getElectronPathForFile(file);
				if(p) src = p;
				else if(dtPaths && dtPaths.length) src = dtPaths[0];
			}
			if(DEBUG_DND) console.log('[Mixer DnD] strip item', { name: file && file.name ? file.name : '', hasFilePath: !!(file && file.path), webUtilsPath: _getElectronPathForFile(file), chosenSrcType: typeof src, chosenSrc: (typeof src === 'string' ? src : '[object]') });
			html.filename = file.name;
			const trackObj = g.currentChannels.find(c => c.el === html);
			if(trackObj){
				try {
					await trackObj.track.load(src);
					if(Transport.state === 'started') {
						trackObj.track._stopSource();
						trackObj.track._startAt(Transport.seconds);
					}
				} catch(err) {
					console.error('Mixer load failed:', file && file.name ? file.name : file, err);
				}
				let maxD = 0;
				for(let i=0; i<g.currentChannels.length; i++){
					if(g.currentChannels[i].track.duration > maxD) maxD = g.currentChannels[i].track.duration;
				}
				g.duration = maxD;
			}
		}
	});

	html.mute.addEventListener('click', mute);
	html.solo.addEventListener('click', solo);
	html.btn_close.addEventListener('click', (e) => {
		e.stopPropagation();
		removeTrack(html);
	});

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
			updateState();
		}
	}

	function soloCount(){
		let solo_count = 0;
		for(let i=0; i<g.currentChannels.length; i++){
			if(g.currentChannels[i].el.state.solo){
				solo_count++;
			}
		}
		return solo_count;
	}

	function solo(){
		if(html.state.solo){
			if(soloCount() == 1){
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
		updateState();
	}

	ut.dragSlider(html.pan, (e) => {
		html.state.pan = e.prozX;
		updateState();
	});
	ut.dragSlider(html.gain, (e) => {
		html.state.gain = e.prozY;
		updateState();
	});
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
		try { if(engine && engine.removeTrack) engine.removeTrack(item.track); } catch(e) {}
		item.track.dispose();
		ut.killMe(item.el);
		g.currentChannels.splice(idx, 1);

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

	let top = (rInfo.bottom - rMixer.top) + 8;
	let left = (rInfo.left + rInfo.width / 2 - rMixer.left) - tipW / 2;

	if (left < 5) left = 5;
	if (left + tipW > rMixer.width - 5) left = rMixer.width - tipW - 5;

	g.name_tooltip.style.top = top + 'px';
	g.name_tooltip.style.left = left + 'px';

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
			channel.track.setMute(state.mute);
			state.last_mute = state.mute;
			if(state.mute){
				html.mute.classList.add('active');
			}
			else {
				html.mute.classList.remove('active');
			}
		}
		if(state.last_solo != state.solo){
			state.last_solo = state.solo;
			if(state.solo){
				html.solo.classList.add('active');
			}
			else {
				html.solo.classList.remove('active');
			}
		}
	}
}

function loop(){
	requestAnimationFrame(loop);
	if(g.currentChannels){
		updateTransport();

		// Floating sync debug overlay
		if(g.sync_overlay_pre && g.sync_overlay_visible){
			let refSec = Transport.seconds;
			if(g.currentChannels.length){
				const tr0 = g.currentChannels[0].track;
				if(tr0 && tr0.ffPlayer && typeof tr0.ffPlayer.getCurrentTime === 'function'){
					refSec = tr0.ffPlayer.getCurrentTime();
				}
			}

			let out = '';
			out += 'SYNC (N=' + g.currentChannels.length + ', ref=' + refSec.toFixed(3) + 's, T=' + Transport.seconds.toFixed(3) + 's)\n';
			out += ' i  in  ty  name                 t(s)    dT(ms)   dR(ms)   u(ms)   q   frames\n';
			const n = g.currentChannels.length;
			let errOut = '';
			for(let i=0; i<n; i++){
				const item = g.currentChannels[i];
				const tr = item ? item.track : null;
				const fp = tr && tr.ffPlayer ? tr.ffPlayer : null;
				let name = (item && item.el && item.el.filename) ? item.el.filename : '';
				name = name.length > 20 ? (name.substring(0, 17) + '...') : name;
				const inIdx = tr ? (tr.idx | 0) : -1;
				if(fp && typeof fp.getCurrentTime === 'function'){
					const t = fp.getCurrentTime();
					const driftT = (t - Transport.seconds) * 1000;
					const driftR = (t - refSec) * 1000;
					const ufr = (fp._underrunFrames !== undefined) ? (fp._underrunFrames | 0) : 0;
					const usr = (fp._sampleRate | 0) > 0 ? (fp._sampleRate | 0) : 44100;
					const uMs = (ufr / usr) * 1000;
					const q = (fp._queuedChunks !== undefined) ? (fp._queuedChunks | 0) : -1;
					const frames = fp.currentFrames | 0;
					out += _padLeft(i+1, 2) + '  ' + _padLeft(inIdx, 2) + '  ff  ' + _padRight(name, 20) + '  ' + _padLeft(t.toFixed(3), 6) + '  ' + _padLeft(_formatMs(driftT), 7) + '  ' + _padLeft(_formatMs(driftR), 7) + '  ' + _padLeft(_formatMs(uMs), 7) + '  ' + _padLeft(q, 2) + '  ' + frames + '\n';
				}
				else {
					let t = NaN;
					if(tr && tr.source && tr.engine && tr._bufStartCtxTime >= 0){
						t = (tr.engine.ctx.currentTime - tr._bufStartCtxTime) + (tr._bufStartOffset || 0);
					}
					const driftT = isFinite(t) ? ((t - Transport.seconds) * 1000) : NaN;
					const driftR = isFinite(t) ? ((t - refSec) * 1000) : NaN;
					out += _padLeft(i+1, 2) + '  ' + _padLeft(inIdx, 2) + '  buf ' + _padRight(name, 20) + '  ' + _padLeft(isFinite(t) ? t.toFixed(3) : '-', 6) + '  ' + _padLeft(isFinite(driftT) ? _formatMs(driftT) : '-', 7) + '  ' + _padLeft(isFinite(driftR) ? _formatMs(driftR) : '-', 7) + '  ' + _padLeft('-', 7) + '  ' + _padLeft('-', 2) + '  -\n';
					if(tr && (tr.lastLoadNote || tr.lastLoadError)){
						let note = (tr.lastLoadNote || '').trim();
						let msg = (tr.lastLoadError || '').replace(/\s+/g, ' ').trim();
						if(msg.length > 140) msg = msg.substring(0, 137) + '...';
						let line = '! ' + (i+1) + ' ' + name + ': ';
						if(note) line += note;
						if(note && msg) line += ' | ';
						if(msg) line += msg;
						errOut += line + '\n';
					}
				}
			}
			if(errOut){
				out += '\n' + errOut;
			}
			g.sync_overlay_pre.textContent = out;
		}
		else if(g.sync_overlay_pre && g.sync_overlay_visible){
			g.sync_overlay_pre.textContent = '';
		}

		for(let i=0; i<g.currentChannels.length; i++){
			let item = g.currentChannels[i];
			let level = item.track.getMeter();
			let proz = (level*6) * 100;
			if(proz > 100) { proz = 100; }
			if(proz < 1) { proz = 0; }
			item.el.meter.style.height = proz + '%';
		}
	}
	else if(g.sync_overlay_pre && g.sync_overlay_visible){
		const t = Transport ? Transport.seconds : 0;
		g.sync_overlay_pre.textContent = 'SYNC (N=0, ref=' + t.toFixed(3) + 's, T=' + t.toFixed(3) + 's)\n';
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
		if(window.bridge && window.bridge.sendToStage){
			window.bridge.sendToStage('mixer-state', { playing: state === 'started' });
		}
	}
}

main.init = init;
export { main };
