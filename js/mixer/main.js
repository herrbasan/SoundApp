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
		g.sync_overlay.style.display = v ? 'flex' : 'none';
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
			if(!f.type && !f.size && !hasExt) {
				// In Electron, allow folders (they have a path)
				if(!(window.bridge && window.bridge.isElectron && f.path)){
					continue;
				}
			}
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
	
	const title = document.createElement('div');
	title.className = 'title';
	title.textContent = 'Sync Debug';
	g.sync_overlay_hdr.appendChild(title);

	const controls = document.createElement('div');
	controls.className = 'controls';

	g.sync_overlay_btn = document.createElement('button');
	g.sync_overlay_btn.className = 'btn';
	g.sync_overlay_btn.type = 'button';
	g.sync_overlay_btn.textContent = 'Snapshot';
	controls.appendChild(g.sync_overlay_btn);

	g.sync_overlay_hdr_info = document.createElement('div');
	g.sync_overlay_hdr_info.className = 'hint';
	g.sync_overlay_hdr_info.textContent = 'Ctrl+Shift+D';
	controls.appendChild(g.sync_overlay_hdr_info);

	g.sync_overlay_hdr.appendChild(controls);
	g.sync_overlay.appendChild(g.sync_overlay_hdr);

	const cvsContainer = document.createElement('div');
	cvsContainer.className = 'canvas-container';
	g.sync_overlay_cvs = document.createElement('canvas');
	cvsContainer.appendChild(g.sync_overlay_cvs);
	g.sync_overlay.appendChild(cvsContainer);

	document.body.appendChild(g.sync_overlay);

	// Drag Logic
	let isDragging = false;
	let dragStartX, dragStartY, initialLeft, initialTop;

	g.sync_overlay_hdr.addEventListener('mousedown', (e) => {
		if(e.target === g.sync_overlay_btn) return;
		isDragging = true;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		const rect = g.sync_overlay.getBoundingClientRect();
		initialLeft = rect.left;
		initialTop = rect.top;
		document.body.style.userSelect = 'none';
	});

	window.addEventListener('mousemove', (e) => {
		if(!isDragging) return;
		const dx = e.clientX - dragStartX;
		const dy = e.clientY - dragStartY;
		g.sync_overlay.style.left = (initialLeft + dx) + 'px';
		g.sync_overlay.style.top = (initialTop + dy) + 'px';
		g.sync_overlay.style.transform = 'none';
	});

	window.addEventListener('mouseup', () => {
		isDragging = false;
		document.body.style.userSelect = '';
	});

	// Resize Observer for Canvas
	const ro = new ResizeObserver(entries => {
		for(let entry of entries){
			const cr = entry.contentRect;
			const dpr = window.devicePixelRatio || 1;
			g.sync_overlay_cvs.width = cr.width * dpr;
			g.sync_overlay_cvs.height = cr.height * dpr;
			// Keep CSS size matching container
			g.sync_overlay_cvs.style.width = cr.width + 'px';
			g.sync_overlay_cvs.style.height = cr.height + 'px';
		}
	});
	ro.observe(cvsContainer);

	g.sync_overlay_btn.addEventListener('click', () => {
		const snap = _buildSyncSnapshot();
		_copyToClipboard(JSON.stringify(snap, null, 2));
	});

	g.sync_overlay_visible = false;
	_setSyncOverlayVisible(false);

	window.addEventListener('keydown', (e) => {
		if(!e) return;
		const code = '' + (e.code || '');
		const key = ('' + (e.key || '')).toLowerCase();

		if(e.ctrlKey && e.shiftKey){
			if(code === 'KeyD' || key === 'd'){
				e.preventDefault();
				e.stopPropagation();
				_setSyncOverlayVisible(!g.sync_overlay_visible);
			}
			return;
		}

		// Space: Toggle Playback
		if(code === 'Space'){
			e.preventDefault();
			g.btn_play.click();
			return;
		}

		// Arrow Up/Down: Master Volume
		if(code === 'ArrowUp'){
			e.preventDefault();
			if(typeof g.master_gain_val === 'undefined') g.master_gain_val = 1.0;
			g.master_gain_val = Math.min(1.0, g.master_gain_val + 0.05);
			engine.setMasterGain(g.master_gain_val);
			g.master_bar.style.width = (g.master_gain_val * 100) + '%';
			return;
		}
		if(code === 'ArrowDown'){
			e.preventDefault();
			if(typeof g.master_gain_val === 'undefined') g.master_gain_val = 1.0;
			g.master_gain_val = Math.max(0.0, g.master_gain_val - 0.05);
			engine.setMasterGain(g.master_gain_val);
			g.master_bar.style.width = (g.master_gain_val * 100) + '%';
			return;
		}

		// Arrow Left/Right: Skip 10%
		if(code === 'ArrowLeft'){
			e.preventDefault();
			if(g.duration > 0){
				const current = Transport.seconds;
				const target = Math.max(0, current - (g.duration * 0.1));
				seek(target);
			}
			return;
		}
		if(code === 'ArrowRight'){
			e.preventDefault();
			if(g.duration > 0){
				const current = Transport.seconds;
				const target = Math.min(g.duration, current + (g.duration * 0.1));
				seek(target);
			}
			return;
		}

		// F1-F10: Solo Tracks 1-10 (Indices 0-9)
		if(code.startsWith('F') && code.length >= 2 && code.length <= 3){
			const fNum = parseInt(code.substring(1));
			if(!isNaN(fNum) && fNum >= 1 && fNum <= 10){
				e.preventDefault();
				handleSolo(fNum - 1, e.shiftKey);
				return;
			}
		}

		// 1-0: Solo Tracks 11-20 (Indices 10-19)
		if(key >= '0' && key <= '9'){
			if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
			e.preventDefault();
			let idx = -1;
			if(key === '0') idx = 19;
			else idx = 9 + parseInt(key);
			handleSolo(idx, e.shiftKey);
			return;
		}
	});

	g.transport = ut.el('.transport');
	g.transport_current = g.transport.el('.time .current');
	g.transport_duration = g.transport.el('.time .duration');
	g.transport_bar = g.transport.el('.bar .inner');
	g.btn_play = ut.el('#btn_play');
	g.btn_reset = ut.el('#btn_reset');
	g.btn_loop = ut.el('#btn_loop');
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

				// Expand folders if in Electron
				const finalItems = [];
				for(let i=0; i<files.length; i++){
					const file = files[i];
					let src = file;
					if(window.bridge && window.bridge.isElectron){
						const p = _getElectronPathForFile(file);
						if(p) src = p;
						else if(dtPaths && dtPaths.length){
							src = dtPaths[i] || dtPaths[0];
						}

						if(typeof src === 'string'){
							try {
								const fs = require('fs');
								const path = require('path');
								const stat = await fs.promises.stat(src);
								if(stat.isDirectory()){
									const getFiles = async (dir) => {
										let res = [];
										const entries = await fs.promises.readdir(dir, {withFileTypes:true});
										for(const e of entries){
											const full = path.join(dir, e.name);
											if(e.isDirectory()) res = res.concat(await getFiles(full));
											else if(/\.(mp3|wav|ogg|flac|m4a|aac|wma|aiff|mod|xm|it|s3m)$/i.test(e.name)) res.push({name: e.name, src: full});
										}
										return res;
									};
									const found = await getFiles(src);
									for(const f of found) finalItems.push(f);
									continue;
								}
							} catch(e){}
						}
					}
					finalItems.push({name: file.name, src: src});
				}

				const promises = [];
				for(let i=0; i<finalItems.length; i++){
					const item = finalItems[i];
					if(DEBUG_DND) console.log('[Mixer DnD] add-zone item', item);
					
					const track = engine.createTrack();
					const el = g.channels.insertBefore(renderChannel(g.currentChannels.length, item.name, g.currentChannels.length + 1), g.add_zone);
					g.currentChannels.push({el, track});
					
					promises.push((async () => {
						try {
							await track.load(item.src);
							if(track.duration > g.duration) g.duration = track.duration;
							if(Transport.state === 'started') {
								if(track.ffPlayer) track.ffPlayer.seek(Transport.seconds);
								track._startAt(Transport.seconds);
							}
						} catch(err) {
							console.error('Mixer load failed:', item.name, err);
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
		g.master_gain_val = e.prozX;
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

	g.btn_loop.addEventListener("click", () => {
		const newState = !engine.loop;
		engine.setLoop(newState);
		if(newState) g.btn_loop.classList.add('active');
		else g.btn_loop.classList.remove('active');
	});
	if(engine.loop) g.btn_loop.classList.add('active');

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

function handleSolo(index, exclusive){
	if(!g.currentChannels || !g.currentChannels[index]) return;
	const item = g.currentChannels[index];
	const el = item.el;

	if(exclusive){
		if(g.exclusiveSoloTrack === item){
			// Restore
			if(g.soloSnapshot){
				g.currentChannels.forEach((ch, i) => {
					ch.el.state.solo = g.soloSnapshot[i].solo;
					ch.el.state.mute = g.soloSnapshot[i].mute;
					ch.el.state.mute_mem = g.soloSnapshot[i].mute_mem;
				});
				g.soloSnapshot = null;
			}
			g.exclusiveSoloTrack = null;
		} else {
			// Save snapshot if not already in exclusive mode
			if(!g.exclusiveSoloTrack){
				g.soloSnapshot = g.currentChannels.map(ch => ({
					solo: ch.el.state.solo,
					mute: ch.el.state.mute,
					mute_mem: ch.el.state.mute_mem
				}));
			}
			
			// Exclusive solo: Solo this one, mute all others
			g.currentChannels.forEach(ch => {
				if(ch === item){
					ch.el.state.solo = true;
					ch.el.state.mute = false;
				} else {
					ch.el.state.solo = false;
					ch.el.state.mute = true;
				}
			});
			g.exclusiveSoloTrack = item;
		}
	} else {
		// Standard Solo Logic (Toggle)
		if(g.exclusiveSoloTrack){
			 g.exclusiveSoloTrack = null;
			 g.soloSnapshot = null;
		}

		let soloCount = 0;
		g.currentChannels.forEach(ch => { if(ch.el.state.solo) soloCount++; });

		if(el.state.solo){
			// Un-soloing
			if(soloCount === 1){
				// Last solo being removed -> restore mutes
				g.currentChannels.forEach(ch => {
					ch.el.state.mute = ch.el.state.mute_mem;
				});
				el.state.solo = false;
				el.state.mute = el.state.mute_mem;
			} else {
				// Still other solos -> just un-solo this one, it becomes muted
				el.state.solo = false;
				el.state.mute = true;
			}
		} else {
			// Soloing
			// Mute everyone who isn't soloed
			g.currentChannels.forEach(ch => {
				if(!ch.el.state.solo){
					ch.el.state.mute = true;
				}
			});
			el.state.mute = false;
			el.state.solo = true;
		}
	}
	updateState();
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
	html.solo.addEventListener('click', (e) => {
		const currentIdx = g.currentChannels.findIndex(c => c.el === html);
		handleSolo(currentIdx, e.shiftKey);
	});
	html.btn_close.addEventListener('click', (e) => {
		e.stopPropagation();
		removeTrack(html);
	});

	function mute(){
		const soloCount = g.currentChannels.filter(c => c.el.state.solo).length;
		if(soloCount > 0){
			const currentIdx = g.currentChannels.findIndex(c => c.el === html);
			handleSolo(currentIdx, false);
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

		// Handle Solo/Mute state before removal
		if(g.exclusiveSoloTrack === item){
			// If removing the exclusive solo track, restore others
			if(g.soloSnapshot){
				g.currentChannels.forEach((ch, i) => {
					if(ch !== item){
						ch.el.state.solo = g.soloSnapshot[i].solo;
						ch.el.state.mute = g.soloSnapshot[i].mute;
						ch.el.state.mute_mem = g.soloSnapshot[i].mute_mem;
					}
				});
				g.soloSnapshot = null;
			}
			g.exclusiveSoloTrack = null;
		} else if(item.el.state.solo){
			// Standard solo removal
			let soloCount = 0;
			g.currentChannels.forEach(ch => { if(ch.el.state.solo) soloCount++; });
			
			if(soloCount === 1){
				// This was the only solo track. Restore mutes on others.
				g.currentChannels.forEach(ch => {
					if(ch !== item){
						ch.el.state.mute = ch.el.state.mute_mem;
					}
				});
			}
		}

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
		
		updateState();
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
		if(g.sync_overlay_cvs && g.sync_overlay_visible){
			const cvs = g.sync_overlay_cvs;
			const ctx = cvs.getContext('2d');
			const w = cvs.width;
			const h = cvs.height;
			const dpr = window.devicePixelRatio || 1;

			ctx.fillStyle = '#222';
			ctx.fillRect(0, 0, w, h);

			// Scale context for DPI
			ctx.save();
			ctx.scale(dpr, dpr);

			// Logical width/height for drawing
			const lw = w / dpr;
			const lh = h / dpr;

			let refSec = Transport.seconds;
			if(g.currentChannels.length){
				const tr0 = g.currentChannels[0].track;
				if(tr0 && tr0.ffPlayer && typeof tr0.ffPlayer.getCurrentTime === 'function'){
					refSec = tr0.ffPlayer.getCurrentTime();
				}
			}

			// Header Info
			ctx.font = '12px "Consolas", "Monaco", "Courier New", monospace';
			ctx.fillStyle = '#aaa';
			ctx.fillText(`SYNC (N=${g.currentChannels.length}, ref=${refSec.toFixed(3)}s, T=${Transport.seconds.toFixed(3)}s)`, 10, 20);

			// Columns
			const rowH = 20;
			const headerY = 35;
			const startY = 60;
			
			// Column X positions
			const xIdx = 10;
			const xType = 35;
			const xName = 75;
			const xDriftBar = 380;
			const xDT = 540;
			const xDR = 590;
			const xUnderrun = 640;
			const xQ = 710;

			// Draw Grid/Headers
			ctx.fillStyle = '#333';
			ctx.fillRect(0, headerY - 14, lw, 18);
			ctx.fillStyle = '#fff';
			ctx.fillText('#', xIdx, headerY);
			ctx.fillText('Type', xType, headerY);
			ctx.fillText('Name', xName, headerY);
			ctx.fillText('Drift (ms)', xDriftBar, headerY);
			ctx.fillText('dT', xDT, headerY);
			ctx.fillText('dR', xDR, headerY);
			ctx.fillText('Underrun', xUnderrun, headerY);
			ctx.fillText('Q', xQ, headerY);

			const n = g.currentChannels.length;
			for(let i=0; i<n; i++){
				const y = startY + (i * rowH);
				if(y > lh) break;

				const item = g.currentChannels[i];
				const tr = item ? item.track : null;
				const fp = tr && tr.ffPlayer ? tr.ffPlayer : null;
				let name = (item && item.el && item.el.filename) ? item.el.filename : '';
				
				// Alternating row background
				if(i % 2 === 0) {
					ctx.fillStyle = 'rgba(255,255,255,0.02)';
					ctx.fillRect(0, y - 14, lw, rowH);
				}

				ctx.fillStyle = '#ccc';
				ctx.fillText((i+1).toString(), xIdx, y);
				
				const type = fp ? 'FF' : 'Buf';
				ctx.fillStyle = fp ? '#8f8' : '#88f';
				ctx.fillText(type, xType, y);

				ctx.fillStyle = '#ccc';
				ctx.fillText(name.substring(0, 35), xName, y);

				let driftT = 0;
				let driftR = 0;
				let uMs = 0;
				let q = -1;
				let isValid = false;

				if(fp && typeof fp.getCurrentTime === 'function'){
					const t = fp.getCurrentTime();
					driftT = (t - Transport.seconds) * 1000;
					driftR = (t - refSec) * 1000;
					const ufr = (fp._underrunFrames !== undefined) ? (fp._underrunFrames | 0) : 0;
					const usr = (fp._sampleRate | 0) > 0 ? (fp._sampleRate | 0) : 44100;
					uMs = (ufr / usr) * 1000;
					q = (fp._queuedChunks !== undefined) ? (fp._queuedChunks | 0) : -1;
					isValid = true;
				}
				else {
					let t = NaN;
					if(tr && tr.source && tr.engine && tr._bufStartCtxTime >= 0){
						t = (tr.engine.ctx.currentTime - tr._bufStartCtxTime) + (tr._bufStartOffset || 0);
					}
					if(isFinite(t)){
						driftT = (t - Transport.seconds) * 1000;
						driftR = (t - refSec) * 1000;
						isValid = true;
					}
				}

				if(isValid){
					// Visual Drift Bar
					const barX = xDriftBar;
					const barW = 140;
					const center = barX + (barW / 2);
					const scale = 2; // pixels per ms
					
					// Background line
					ctx.fillStyle = '#444';
					ctx.fillRect(barX, y - 4, barW, 2);
					// Center tick
					ctx.fillStyle = '#888';
					ctx.fillRect(center, y - 6, 1, 6);

					// Drift bar
					const dPx = driftT * scale;
					let barColor = '#0f0';
					if(Math.abs(driftT) > 20) barColor = '#ff0';
					if(Math.abs(driftT) > 50) barColor = '#f00';
					
					ctx.fillStyle = barColor;
					let bx = center;
					let bw = dPx;
					if(dPx < 0) { bx = center + dPx; bw = -dPx; }
					// Clamp
					if(bx < barX) { bw -= (barX - bx); bx = barX; }
					if(bx + bw > barX + barW) { bw = (barX + barW) - bx; }
					
					if(bw > 0) ctx.fillRect(bx, y - 5, bw, 4);

					// Text Values
					ctx.fillStyle = Math.abs(driftT) > 10 ? '#f88' : '#ccc';
					ctx.fillText(driftT.toFixed(1), xDT, y);
					
					ctx.fillStyle = Math.abs(driftR) > 10 ? '#f88' : '#888';
					ctx.fillText(driftR.toFixed(1), xDR, y);

					if(uMs > 0){
						ctx.fillStyle = '#f44';
						ctx.fillText(uMs.toFixed(1) + 'ms', xUnderrun, y);
					}
					if(q >= 0){
							ctx.fillStyle = q < 2 ? '#f88' : '#8f8';
							ctx.fillText(`Q:${q}`, xQ, y);
					}
				} else {
					ctx.fillStyle = '#666';
					ctx.fillText('-', xDT, y);
				}
			}
			ctx.restore();
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
	else if(g.sync_overlay_cvs && g.sync_overlay_visible){
		const cvs = g.sync_overlay_cvs;
		const ctx = cvs.getContext('2d');
		const w = cvs.width;
		const h = cvs.height;
		ctx.fillStyle = '#222';
		ctx.fillRect(0, 0, w, h);
		ctx.font = '12px monospace';
		ctx.fillStyle = '#aaa';
		const t = Transport ? Transport.seconds : 0;
		ctx.fillText(`SYNC (N=0, ref=${t.toFixed(3)}s, T=${t.toFixed(3)}s)`, 10, 20);
	}
}

function updateTransport(){
	if(g.transport.duration != g.duration){
		g.transport_duration.innerText = ut.playTime(g.duration*1000).minsec;
		g.transport.duration = g.duration;
	}
	let current = Transport.seconds;
	if(g.duration > 0 && current >= g.duration){
		if(engine.loop){
			Transport.seconds = 0;
			current = 0;
		} else {
			Transport.stop();
			current = g.duration;
		}
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
