/* global gc */

'use strict';

const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

function el(id){ return document.getElementById(id); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function mb(n){
	if(!n || !isFinite(n)) return 0;
	return Math.round((n / (1024 * 1024)) * 10) / 10;
}

function log(){
	const ar = ['[HARNESS]'].concat([].slice.call(arguments));
	console.log.apply(console, ar);
	try { ipcRenderer.send('renderer-log', ar.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')); } catch(e) {}
}

function status(s){
	el('status').textContent = '' + s;
	try { ipcRenderer.send('renderer-status', '' + s); } catch(e) {}
}

function getRoot(){
	return path.resolve(__dirname, '..');
}

function getNativeDecoderPath(){
	const root = getRoot();
	if(process.platform === 'linux') return path.resolve(root, 'bin/linux_bin/ffmpeg_napi.node');
	return path.resolve(root, 'bin/win_bin/ffmpeg_napi.node');
}

function getWorkletPath(){
	const root = getRoot();
	return path.resolve(root, 'libs/ffmpeg-napi-interface/lib/ffmpeg-worklet-processor.js');
}

function getDropWorkletPath(){
	const root = getRoot();
	return path.resolve(root, 'libs/ffmpeg-napi-interface/lib/ffmpeg-worklet-processor-drop.js');
}

function getSABWorkletPath(){
	const root = getRoot();
	return path.resolve(root, 'bin/win_bin/ffmpeg-worklet-sab.js');
}

function getSABPlayerLibPath(){
	const root = getRoot();
	return path.resolve(root, 'bin/win_bin/player-sab.js');
}

function getPlayerLibPath(){
	const root = getRoot();
	return path.resolve(root, 'libs/ffmpeg-napi-interface/lib/player.js');
}

function getConfig(){
	return {
		iters: Math.max(1, (el('iters').value|0) || 1),
		tracks: Math.max(1, (el('tracks').value|0) || 1),
		holdMs: Math.max(0, (el('hold').value|0) || 0),
		seeks: Math.max(0, (el('seeks').value|0) || 0),
		forceGc: !!el('forcegc').checked
	};
}

const WORST = {
	chunkSeconds: 0.25,
	prebufferSingle: 80,
	prebufferMulti: 140,
	aggressiveFill: true
};

const AUTOPILOT = {
	// Keep runs short enough to observe in limited logs.
	itersSingle: 20,
	itersDecoder: 15,
	itersMulti: 50,
	tracks: 20,
	seeks: 2,
	holdMs: 250,
	// Slow/network drive run is off by default.
	archiveEnabled: false,
	archiveMaxIters: 10,
	// Snapshot throttling: emit postgc every N iterations.
	snapEvery: 5,
	// Allow a short settle window after stop/dispose so worklet messages can drain.
	postStopSettleMs: 50
};

// A/B experiment toggles - flip these to isolate the leak source.
const DEFAULT_EXPERIMENTS = {
	// If true, dispose and recreate all players each iteration (vs reuse).
	recreatePlayersPerIter: false,
	// If true, close and create a new AudioContext each iteration.
	recreateContextPerIter: false,
	// If true, call player.flush() before stop() to clear internal queues.
	callFlushOnStop: false,
	// If true, skip aggressiveFill() calls entirely.
	disableAggressiveFill: false,
	// If true, keep the AudioWorkletNode alive across open() calls.
	reuseWorkletNode: false,
	// If true, load a worklet variant that drops incoming chunks (no queueing).
	dropChunksWorklet: false,
	// 0 = no override; <=0 means uncapped; >0 is the hard cap.
	fillBurstMax: 0,
	// 0 = use WORST.chunkSeconds; >0 overrides chunk duration (milliseconds).
	chunkSecondsMs: 0,
	// 0 = use AUTOPILOT.postStopSettleMs; >0 overrides settle window.
	postStopSettleMs: 0,
	// If true, players send chunks as transferable ArrayBuffers.
	transferChunks: false,
	// If true, use SharedArrayBuffer-based player (experimental).
	useSAB: false
};

const EXPERIMENTS = Object.assign({}, DEFAULT_EXPERIMENTS);

function getQuery(){
	try { return new URLSearchParams((location && location.search) ? location.search : ''); } catch(e) {}
	return new URLSearchParams('');
}

function isControllerMode(){
	const q = getQuery();
	return (q.get('controller') === '1');
}

function getVariantInfo(){
	const q = getQuery();
	return {
		variant: q.get('variant') || '',
		title: q.get('title') || ''
	};
}

function applyExperimentOverridesFromQuery(){
	const q = getQuery();
	const raw = q.get('exp');
	if(!raw) return;
	let obj = null;
	try { obj = JSON.parse(raw); } catch(e) { obj = null; }
	if(!obj || typeof obj !== 'object') return;
	for(const k in DEFAULT_EXPERIMENTS) EXPERIMENTS[k] = DEFAULT_EXPERIMENTS[k];
	for(const k in obj){
		if(!Object.prototype.hasOwnProperty.call(EXPERIMENTS, k)) continue;
		if(typeof DEFAULT_EXPERIMENTS[k] === 'number') EXPERIMENTS[k] = (obj[k] | 0);
		else EXPERIMENTS[k] = !!obj[k];
	}
}

let g = {
	sets: { single: [], stems: [], archive: [] },
	stop: false,
	telemetry: false,
	snapEvery: AUTOPILOT.snapEvery,
	// Baseline tracking for delta reporting.
	baselines: {},
	growth: {}
};

function defaultPaths(){
	return {
		single: 'D:\\Home\\Music\\Test Files',
		stems: 'D:\\Work\\_GIT\\SoundApp\\_Material\\mixer_media',
		archive: 'Y:\\# Audio Archive\\# Archived Music - Reason Projects'
	};
}

function pathExists(p){
	try { return !!(p && fs.existsSync(p)); } catch(e) {}
	return false;
}

function parseFolders(){
	const raw = el('folders').value || '';
	const lines = raw.split(/\r?\n/);
	const out = [];
	for(let i=0; i<lines.length; i++){
		let s = (lines[i] || '').trim();
		if(!s) continue;
		out.push(s);
	}
	return out;
}

function emitRendererMem(tag){
	const mu = process.memoryUsage();
	const pm = (typeof performance !== 'undefined' && performance && performance.memory) ? performance.memory : null;
	ipcRenderer.send('renderer-mem', {
		tag: tag || '',
		rssMB: mb(mu.rss),
		heapUsedMB: mb(mu.heapUsed),
		heapTotalMB: mb(mu.heapTotal),
		externalMB: mb(mu.external),
		jsHeapMB: pm ? mb(pm.usedJSHeapSize) : null,
		jsHeapLimitMB: pm ? mb(pm.jsHeapSizeLimit) : null
	});
}

async function maybeGc(force){
	if(!force) return;
	// Multiple GC passes with delays to ensure thorough cleanup
	for(let pass = 0; pass < 3; pass++){
		await sleep(20);
		try { if(typeof gc === 'function') gc(); } catch(e) {}
		await sleep(20);
		try { if(globalThis && typeof globalThis.gc === 'function') globalThis.gc(); } catch(e) {}
	}
	await sleep(100);
}

async function memSnap(tag){
	// Keep logs manageable: for iteration snapshots log only postgc,
	// and only every N iterations (plus iteration 1).
	const s = '' + (tag || '');
	if(s.includes(':iter:')){
		if(!s.includes(':postgc')) return;
		const m = s.match(/:iter:(\d+):/);
		if(m && m[1]){
			const it = (m[1] | 0);
			const n = (g.snapEvery | 0) > 0 ? (g.snapEvery | 0) : 5;
			if(it !== 1 && (it % n) !== 0) return;
		}
	}
	emitRendererMem(tag);
	try { await ipcRenderer.invoke('mem-snapshot', tag); } catch(e) {}
}

async function ensureDeps(){
	const nativePath = getNativeDecoderPath();
	const workletPath = getWorkletPath();
	const playerLibPath = getPlayerLibPath();
	log('Paths', { nativePath, workletPath, playerLibPath });

	// Load native addon + player code
	const native = require(nativePath);
	const mod = require(playerLibPath);
	if(!native || !native.FFmpegDecoder) throw new Error('Native addon did not export FFmpegDecoder');
	if(!mod || !mod.FFmpegStreamPlayer) throw new Error('Player lib did not export FFmpegStreamPlayer');
	return { native, mod, workletPath };
}

function decoderOpen(dec, filePath, sampleRate, threads){
	// Avoid try/catch control flow: pick signature by arity.
	if(dec && dec.open && (dec.open.length|0) >= 3) return dec.open(filePath, sampleRate|0, threads|0);
	return dec.open(filePath);
}

function decoderRead(dec, n){
	if(!dec || !dec.read) return { samplesRead: 0, buffer: null };
	return dec.read(n|0);
}

function decoderSeek(dec, seconds){
	if(!dec || !dec.seek) return false;
	return dec.seek(+seconds);
}

function decoderClose(dec){
	if(!dec || !dec.close) return;
	dec.close();
}

async function runDecoderOnly(fileList, label){
	g.stop = false;
	const cfg = getConfig();
	const tag = label ? ('' + label) : 'dec';
	status('Running decoder-only (' + tag + ')...');
	log('Decoder-only start', { tag, cfg, files: fileList ? fileList.length : 0, worst: WORST });

	const { native } = await ensureDeps();
	const Dec = native && native.FFmpegDecoder ? native.FFmpegDecoder : null;
	if(!Dec) throw new Error('Native addon did not export FFmpegDecoder');

	const sr = 44100;
	const ch = 2;
	const chunkSamples = Math.max(256, Math.round(sr * ch * WORST.chunkSeconds));
	const readsPerIter = Math.max(1, (WORST.prebufferMulti|0));

	recordBaseline('dec:' + tag);
	await memSnap('dec:' + tag + ':before');

	for(let i=0; i<cfg.iters; i++){
		if(g.stop) break;
		const fp = pickFile(fileList, i);
		if(!fp) { status('No files for decoder-only (' + tag + ')'); break; }

		status('Decoder ' + (i+1) + '/' + cfg.iters + '\n' + fp);
		await memSnap('dec:' + tag + ':iter:' + (i+1) + ':preopen');

		const dec = new Dec();
		const ok = decoderOpen(dec, fp, sr, 0);
		if(!ok){
			decoderClose(dec);
			throw new Error('Decoder open failed: ' + fp);
		}
		await memSnap('dec:' + tag + ':iter:' + (i+1) + ':postopen');

		// Prebuffer stress: read lots of chunks (discard immediately)
		for(let r=0; r<readsPerIter; r++){
			if(g.stop) break;
			const res = decoderRead(dec, chunkSamples);
			if(!res || (res.samplesRead|0) <= 0) break;
		}

		// Seek stress
		for(let s=0; s<cfg.seeks; s++){
			if(g.stop) break;
			const sec = ((i + 1 + s) % 30);
			decoderSeek(dec, sec);
			// Read one chunk after seek
			decoderRead(dec, chunkSamples);
		}

		decoderClose(dec);
		await memSnap('dec:' + tag + ':iter:' + (i+1) + ':postclose');
		await maybeGc(cfg.forceGc);
		await memSnap('dec:' + tag + ':iter:' + (i+1) + ':postgc');
	}

	recordGrowth('dec:' + tag);
	await memSnap('dec:' + tag + ':after');
	status('Decoder-only done (' + tag + ').');
	log('Decoder-only done', tag);
}

function worstcaseTweakPlayer(p){
	try { p.chunkSeconds = WORST.chunkSeconds; } catch(e) {}
	return p;
}

function getChunkSeconds(){
	const ms = (EXPERIMENTS.chunkSecondsMs|0);
	if(ms > 0) return Math.max(0.005, ms / 1000);
	return WORST.chunkSeconds;
}

function getPrebufferSizeForChunkSeconds(baseChunks, baseChunkSeconds, chunkSeconds){
	const sec = Math.max(0.001, (baseChunks|0) * (+baseChunkSeconds || 0.001));
	const cs = Math.max(0.001, +chunkSeconds || 0.001);
	return Math.max(1, Math.round(sec / cs));
}

function aggressiveFill(p){
	if(!WORST.aggressiveFill) return;
	if(EXPERIMENTS.disableAggressiveFill) return;
	if(EXPERIMENTS.useSAB) return; // SAB uses fixed ring buffer, aggressive fill not applicable
	try {
		if(p && typeof p._fillQueue === 'function'){
			// MaxChunks intentionally large: this is a stress harness.
			p._fillQueue(p.prebufferSize, 512);
		}
	} catch(e) {}
}

function getTabPrivateMB(){
	// Quick helper: we can't get app metrics from renderer, so use RSS as proxy.
	try {
		const mu = process.memoryUsage();
		return mb(mu.rss);
	} catch(e) { return 0; }
}

function recordBaseline(phase){
	g.baselines[phase] = getTabPrivateMB();
}

function recordGrowth(phase){
	const now = getTabPrivateMB();
	const base = g.baselines[phase] || now;
	const delta = Math.round((now - base) * 10) / 10;
	g.growth[phase] = { before: base, after: now, delta: delta };
	log('Growth', phase, '+' + delta + 'MB', '(' + base + ' -> ' + now + ')');
}

function pickFile(ar, i){
	if(!ar || ar.length === 0) return '';
	return ar[i % ar.length];
}

async function runSingle(fileList, label){
	g.stop = false;
	const cfg = getConfig();
	const tag = label ? ('' + label) : 'single';
	status('Running single-track (' + tag + ')...');
	log('Single-track start', { tag, cfg, files: fileList ? fileList.length : 0 });

	let { native, mod, workletPath } = await ensureDeps();
	if(EXPERIMENTS.dropChunksWorklet) workletPath = getDropWorkletPath();
	const { FFmpegStreamPlayer } = mod;
	FFmpegStreamPlayer.setDecoder(native.FFmpegDecoder);

	const chunkSeconds = getChunkSeconds();
	const prebufferSingle = getPrebufferSizeForChunkSeconds(WORST.prebufferSingle, WORST.chunkSeconds, chunkSeconds);

	const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
	const player = worstcaseTweakPlayer(new FFmpegStreamPlayer(ctx, workletPath, prebufferSingle, 0, true));
	try { player.chunkSeconds = chunkSeconds; } catch(e) {}
	try { player.reuseWorkletNode = !!EXPERIMENTS.reuseWorkletNode; } catch(e) {}
	try { if(EXPERIMENTS.fillBurstMax !== 0) player.fillBurstMax = (EXPERIMENTS.fillBurstMax|0); } catch(e) {}
	try { if(EXPERIMENTS.transferChunks) player.transferChunks = true; } catch(e) {}

	recordBaseline('single:' + tag);
	await memSnap('single:' + tag + ':before');

	for(let i=0; i<cfg.iters; i++){
		if(g.stop) break;
		const fp = pickFile(fileList, i);
		if(!fp) { status('No files for single-track (' + tag + ')'); break; }
		status('Single ' + (i+1) + '/' + cfg.iters + '\n' + fp);
		await memSnap('single:' + tag + ':iter:' + (i+1) + ':preopen');

		const meta = await player.open(fp, workletPath);
		aggressiveFill(player);
		await memSnap('single:' + tag + ':iter:' + (i+1) + ':postopen');

		// Seek a few times to stress the queue + worklet
		const dur = meta && meta.duration ? +meta.duration : 0;
		for(let s=0; s<cfg.seeks; s++){
			if(g.stop) break;
			let t = 0;
			if(dur > 5){
				const frac = ((i + 1 + s) % 10) / 10;
				t = Math.max(0, Math.min(dur - 1, dur * frac));
			}
			player.seek(t);
			aggressiveFill(player);
			await sleep(10);
		}

		await player.play(ctx.currentTime + 0.05);
		await sleep(cfg.holdMs);
		player.pause();
		await sleep(10);
		player.stop(true); // mimic Stage-style reuse (keep decoder object)
		await memSnap('single:' + tag + ':iter:' + (i+1) + ':poststop');
		await maybeGc(cfg.forceGc);
		await memSnap('single:' + tag + ':iter:' + (i+1) + ':postgc');
	}

	if(EXPERIMENTS.callFlushOnStop && player.flush) try { player.flush(); } catch(e) {}
	try { player.dispose(); } catch(e) {}
	try { await ctx.close(); } catch(e) {}
	
	// Aggressive cleanup: null references and settle
	await sleep(200);
	await maybeGc(cfg.forceGc);
	await sleep(200);
	await maybeGc(cfg.forceGc);
	
	recordGrowth('single:' + tag);
	await memSnap('single:' + tag + ':after');
	status('Single-track done (' + tag + ').');
	log('Single-track done', tag);
}

async function runMulti(fileList, label){
	g.stop = false;
	const cfg = getConfig();
	const tag = label ? ('' + label) : 'multi';
	status('Running multi-track (' + tag + ')...');
	log('Multi-track start', { tag, cfg, files: fileList ? fileList.length : 0 });

	let { native, mod, workletPath } = await ensureDeps();
	if(EXPERIMENTS.dropChunksWorklet) workletPath = getDropWorkletPath();
	
	// SAB experiment: use SharedArrayBuffer-based player
	let PlayerClass;
	if(EXPERIMENTS.useSAB){
		const sabMod = require(getSABPlayerLibPath());
		PlayerClass = sabMod.FFmpegStreamPlayerSAB;
		workletPath = getSABWorkletPath();
		PlayerClass.setDecoder(native.FFmpegDecoder);
		log('Using SharedArrayBuffer player');
	} else {
		const { FFmpegStreamPlayer } = mod;
		FFmpegStreamPlayer.setDecoder(native.FFmpegDecoder);
		PlayerClass = FFmpegStreamPlayer;
	}

	const chunkSeconds = getChunkSeconds();
	const prebufferMulti = getPrebufferSizeForChunkSeconds(WORST.prebufferMulti, WORST.chunkSeconds, chunkSeconds);

	let ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
	let master = ctx.createGain();
	master.gain.value = 1;
	master.connect(ctx.destination);

	let players = [];
	function createPlayers(){
		players = [];
		for(let i=0; i<cfg.tracks; i++){
			const p = worstcaseTweakPlayer(new PlayerClass(ctx, workletPath, prebufferMulti, 1, false));
			try { p.chunkSeconds = chunkSeconds; } catch(e) {}
			try { p.reuseWorkletNode = !!EXPERIMENTS.reuseWorkletNode; } catch(e) {}
			if(EXPERIMENTS.fillBurstMax !== 0) p.fillBurstMax = (EXPERIMENTS.fillBurstMax|0);
			if(EXPERIMENTS.transferChunks) p.transferChunks = true;
			p.connect(master);
			players.push(p);
		}
	}
	function disposePlayers(){
		for(let t=0; t<players.length; t++){
			try {
				if(EXPERIMENTS.callFlushOnStop && players[t].flush) players[t].flush();
				players[t].stop(false); // full stop, close decoder
				players[t].disconnect();
				players[t].dispose();
			} catch(e) {}
			players[t] = null; // clear reference
		}
		players.length = 0;
		players = [];
	}
	async function recreateContext(){
		try { master.disconnect(); } catch(e) {}
		try { await ctx.close(); } catch(e) {}
		ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
		master = ctx.createGain();
		master.gain.value = 1;
		master.connect(ctx.destination);
	}

	createPlayers();
	recordBaseline('multi:' + tag);
	await memSnap('multi:' + tag + ':before');

	for(let iter=0; iter<cfg.iters; iter++){
		if(g.stop) break;
		status('Multi ' + (iter+1) + '/' + cfg.iters);
		await memSnap('multi:' + tag + ':iter:' + (iter+1) + ':preopen');

		// Open N tracks
		const openMeta = [];
		for(let t=0; t<players.length; t++){
			if(g.stop) break;
			const fp = pickFile(fileList, iter * players.length + t);
			if(!fp) break;
			openMeta[t] = await players[t].open(fp, workletPath);
			aggressiveFill(players[t]);
		}
		await memSnap('multi:' + tag + ':iter:' + (iter+1) + ':postopen');

		// Seek all
		for(let s=0; s<cfg.seeks; s++){
			if(g.stop) break;
			for(let t=0; t<players.length; t++){
				const meta = openMeta[t];
				const dur = meta && meta.duration ? +meta.duration : 0;
				let pos = 0;
				if(dur > 5){
					const frac = ((iter + 1 + t + s) % 10) / 10;
					pos = Math.max(0, Math.min(dur - 1, dur * frac));
				}
				players[t].seek(pos);
				aggressiveFill(players[t]);
			}
			await sleep(15);
		}

		const startAt = ctx.currentTime + 0.10;
		for(let t=0; t<players.length; t++){
			await players[t].play(startAt);
		}
		await sleep(cfg.holdMs);
		for(let t=0; t<players.length; t++) players[t].pause();
		await sleep(10);

		// Stop players - SAB uses keepDecoder=true to preserve SABs for reuse
		for(let t=0; t<players.length; t++){
			if(EXPERIMENTS.callFlushOnStop && players[t].flush) try { players[t].flush(); } catch(e) {}
			players[t].stop(EXPERIMENTS.useSAB ? true : false);
		}
		const settleMs = (EXPERIMENTS.postStopSettleMs|0) > 0 ? (EXPERIMENTS.postStopSettleMs|0) : (AUTOPILOT.postStopSettleMs|0);
		if(settleMs > 0) await sleep(settleMs);
		await memSnap('multi:' + tag + ':iter:' + (iter+1) + ':poststop');
		await maybeGc(cfg.forceGc);
		await memSnap('multi:' + tag + ':iter:' + (iter+1) + ':postgc');

		// Experiment: recreate players and/or context each iteration.
		if(EXPERIMENTS.recreatePlayersPerIter){
			disposePlayers();
			await maybeGc(cfg.forceGc);
			if(EXPERIMENTS.recreateContextPerIter){
				await recreateContext();
			}
			createPlayers();
		}
	}

	disposePlayers();
	try { master.disconnect(); } catch(e) {}
	master = null;
	try { await ctx.close(); } catch(e) {}
	ctx = null;
	
	// Aggressive cleanup: multiple GC passes with delays
	await sleep(300);
	await maybeGc(cfg.forceGc);
	await sleep(300);
	await maybeGc(cfg.forceGc);
	
	// Clear require cache for player modules to release any held references
	try {
		const playerPath = getPlayerLibPath();
		const sabPath = getSABPlayerLibPath();
		if(require.cache[playerPath]) delete require.cache[playerPath];
		if(require.cache[sabPath]) delete require.cache[sabPath];
	} catch(e) {}
	
	await sleep(200);
	await maybeGc(cfg.forceGc);
	
	recordGrowth('multi:' + tag);
	await memSnap('multi:' + tag + ':after');
	status('Multi-track done (' + tag + ').');
	log('Multi-track done', tag);
}

async function scan(){
	const folders = parseFolders();
	if(!folders.length){
		el('scaninfo').textContent = 'No folders set.';
		return;
	}
	el('scaninfo').textContent = 'Scanning...';
	const res = await ipcRenderer.invoke('scan-folders', { folders, limit: 5000 });
	g.sets.single = (res && res.files) ? res.files : [];
	el('scaninfo').textContent = 'Found ' + g.sets.single.length + ' files' + (res && res.count >= res.limit ? ' (hit limit)' : '');
	log('Scan result (manual)', { count: g.sets.single.length, first: g.sets.single[0] });
}

async function scanSet(label, folders, limit){
	const res = await ipcRenderer.invoke('scan-folders', { folders, limit: limit|0 });
	const files = (res && res.files) ? res.files : [];
	log('Scan result', { label, folders, count: files.length, first: files[0] });
	return files;
}

async function autoPilot(){
	applyExperimentOverridesFromQuery();
	const ctrl = isControllerMode();
	const vinfo = getVariantInfo();
	if(ctrl){
		log('Controller mode', { variant: vinfo.variant, title: vinfo.title, exp: EXPERIMENTS });
	}

	const p = defaultPaths();
	const singleOk = pathExists(p.single);
	const stemsOk = pathExists(p.stems);
	const archiveOk = pathExists(p.archive);
	const cfg0 = getConfig();

	log('Autopilot paths', { single: p.single, stems: p.stems, archive: p.archive, singleOk, stemsOk, archiveOk, cfg: cfg0, worst: WORST });
	status('Autopilot init...');

	// Telemetry tick is noisy; rely on explicit snapshots.
	setTelemetry(false);
	await memSnap('autopilot:boot');

	// In controller mode we only need the stems set.
	if(!ctrl && singleOk) g.sets.single = await scanSet('single', [p.single], 5000);
	if(stemsOk) g.sets.stems = await scanSet('stems', [p.stems], 5000);
	if(!ctrl && archiveOk) g.sets.archive = await scanSet('archive', [p.archive], 1500);

	const sN = g.sets.single ? g.sets.single.length : 0;
	const mN = g.sets.stems ? g.sets.stems.length : 0;
	const aN = g.sets.archive ? g.sets.archive.length : 0;
	el('scaninfo').textContent = 'Autopilot scan: single=' + sN + ' stems=' + mN + (aN ? (' archive=' + aN) : '');

	// Apply short autopilot values (still worst-case buffering).
	// Controller mode uses even smaller per-variant runtime.
	el('iters').value = '' + (ctrl ? 20 : AUTOPILOT.itersSingle);
	el('tracks').value = '' + AUTOPILOT.tracks;
	el('hold').value = '' + (ctrl ? 150 : AUTOPILOT.holdMs);
	el('seeks').value = '' + (ctrl ? 2 : AUTOPILOT.seeks);
	g.snapEvery = AUTOPILOT.snapEvery;

	if(!ctrl){
		// Run single test on local test files
		if(sN > 0 && !g.stop){
			await runSingle(g.sets.single, 'local');
		}

		// Run decoder-only stress on stems set (isolates native memory behavior)
		if(mN > 0 && !g.stop){
			const oldIters = el('iters').value;
			el('iters').value = '' + AUTOPILOT.itersDecoder;
			await runDecoderOnly(g.sets.stems, 'stems');
			el('iters').value = oldIters;
		}

		// Run multi test on stems folder
		if(mN > 0 && !g.stop){
			const oldIters = el('iters').value;
			el('iters').value = '' + AUTOPILOT.itersMulti;
			await runMulti(g.sets.stems, 'stems');
			el('iters').value = oldIters;
		}
	} else {
		// Controller/AB mode: only run the multi-track stems test (fast & comparable).
		if(mN > 0 && !g.stop){
			const lbl = vinfo && vinfo.variant ? ('stems_' + vinfo.variant) : 'stems';
			await runMulti(g.sets.stems, lbl);
		}
	}

	// Optional: run single test on slow/archive drive if present
	if(AUTOPILOT.archiveEnabled && aN > 0 && !g.stop){
		// Avoid extremely long hands-free runs on slow/network drives.
		const oldIters = el('iters').value;
		el('iters').value = '' + Math.min(AUTOPILOT.archiveMaxIters, 20);
		await runSingle(g.sets.archive, 'archive');
		el('iters').value = oldIters;
	}

	await memSnap('autopilot:done');

	// Summary of growth across all phases.
	log('===== GROWTH SUMMARY =====');
	log('Experiments:', JSON.stringify(EXPERIMENTS));
	for(const k in g.growth){
		const v = g.growth[k];
		log('  ' + k + ': +' + v.delta + 'MB (' + v.before + ' -> ' + v.after + ')');
	}
	log('==========================');

	if(ctrl){
		// Return results to controller; it will close window and launch next variant.
		try {
			await ipcRenderer.invoke('variant-finished', {
				variant: vinfo.variant,
				title: vinfo.title,
				experiments: EXPERIMENTS,
				growth: g.growth
			});
		} catch(e) {}
		status('Variant done. Waiting for controller...');
		return;
	}

	status('Autopilot finished. Exiting...');
	setTelemetry(false);
	await sleep(200);
	try { await ipcRenderer.invoke('quit'); } catch(e) {}
}

function setTelemetry(on){
	g.telemetry = !!on;
	ipcRenderer.send('telemetry', g.telemetry);
	el('telemetry').textContent = 'Telemetry: ' + (g.telemetry ? 'on' : 'off');
}

window.addEventListener('DOMContentLoaded', () => {
	// Prefill defaults so the window documents what it is doing.
	const p = defaultPaths();
	el('folders').value = p.single + '\n' + p.stems + '\n' + p.archive;
	// Defaults are mostly informational; autopilot may override.
	el('iters').value = '' + AUTOPILOT.itersSingle;
	el('tracks').value = '' + AUTOPILOT.tracks;
	el('hold').value = '' + AUTOPILOT.holdMs;
	el('seeks').value = '' + AUTOPILOT.seeks;
	el('forcegc').checked = false;

	el('scan').addEventListener('click', () => scan());
	el('snap').addEventListener('click', () => memSnap('manual'));
	el('telemetry').addEventListener('click', () => setTelemetry(!g.telemetry));
	el('runSingle').addEventListener('click', () => runSingle(g.sets.single, 'manual').catch(e => { console.error(e); status('ERROR: ' + (e && (e.stack || e.message) ? (e.stack || e.message) : e)); }));
	el('runMulti').addEventListener('click', () => runMulti(g.sets.stems, 'manual').catch(e => { console.error(e); status('ERROR: ' + (e && (e.stack || e.message) ? (e.stack || e.message) : e)); }));
	el('stop').addEventListener('click', () => { g.stop = true; status('Stopping...'); });
	setTelemetry(false);
	status('Autopilot starting...');
	log('Ready (autopilot)');
	setTimeout(() => {
		autoPilot().catch(e => {
			console.error(e);
			status('ERROR: ' + (e && (e.stack || e.message) ? (e.stack || e.message) : e));
		});
	}, 150);
});
