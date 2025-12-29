'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-precise-memory-info');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
// Enable SharedArrayBuffer (required for SAB experiment)
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

let win = null;
let telemetryTimer = null;

const VARIANTS = [
	{ id: 'A0', title: 'baseline', exp: {} },
	{ id: 'SAB', title: 'SharedArrayBuffer player', exp: { useSAB: true } }
];

let controller = {
	enabled: true,
	idx: 0,
	results: []
};

function mb(n){
	if(!n || !isFinite(n)) return 0;
	return Math.round((n / (1024 * 1024)) * 10) / 10;
}

function nowIso(){
	return new Date().toISOString();
}

async function walkDir(root, out, exts, limit){
	if(out.length >= limit) return;
	let ents;
	try {
		ents = await fs.readdir(root, { withFileTypes: true });
	} catch(e) {
		return;
	}
	for(let i=0; i<ents.length; i++){
		if(out.length >= limit) return;
		const ent = ents[i];
		if(!ent) continue;
		const fp = path.join(root, ent.name);
		if(ent.isDirectory()){
			await walkDir(fp, out, exts, limit);
			continue;
		}
		if(!ent.isFile()) continue;
		const ext = (path.extname(ent.name) || '').toLowerCase();
		if(!exts.has(ext)) continue;
		out.push(fp);
	}
}

function getSupportedExts(){
	// Mirror stage.js supportedFilter
	const supportedMpt = ['.mptm', '.mod','.mo3','.s3m', '.xm', '.it', '.669', '.amf', '.ams', '.c67', '.dbm', '.digi', '.dmf',
		'.dsm', '.dsym', '.dtm', '.far', '.fmt', '.imf', '.ice', '.j2b', '.m15', '.mdl', '.med', '.mms', '.mt2', '.mtm', '.mus',
		'.nst', '.okt', '.plm', '.psm', '.pt36', '.ptm', '.sfx', '.sfx2', '.st26', '.stk', '.stm', '.stx', '.stp', '.symmod',
		'.ult', '.wow', '.gdm', '.mo3', '.oxm', '.umx', '.xpk', '.ppm', '.mmcmp'];
	const supportedChrome = ['.mp3','.wav','.flac','.ogg', '.m4a', '.m4b', '.aac','.webm'];
	const supportedFFmpeg = ['.mpg','.mp2', '.aif', '.aiff','.aa', '.wma', '.asf', '.ape', '.wv', '.wvc', '.tta', '.mka',
		'.amr', '.3ga', '.ac3', '.eac3', '.dts', '.dtshd', '.caf', '.au', '.snd', '.voc', '.tak', '.mpc', '.mp+'];
	const all = supportedMpt.concat(supportedChrome).concat(supportedFFmpeg);
	const set = new Set();
	for(let i=0; i<all.length; i++) set.add(all[i]);
	return set;
}

async function getMainMem(){
	const mu = process.memoryUsage();
	let pinfo = null;
	try { pinfo = await process.getProcessMemoryInfo(); } catch(e) {}
	return {
		rssMB: mb(mu.rss),
		heapUsedMB: mb(mu.heapUsed),
		heapTotalMB: mb(mu.heapTotal),
		externalMB: mb(mu.external),
		privateMB: pinfo ? mb(pinfo.private) : 0,
		workingSetMB: pinfo ? mb(pinfo.workingSetSize) : 0
	};
}

async function getRendererMem(){
	if(!win || win.isDestroyed()) return null;
	let info = null;
	try { info = await win.webContents.getProcessMemoryInfo(); } catch(e) {}
	return info ? { privateMB: mb(info.private), workingSetMB: mb(info.workingSetSize) } : null;
}

async function logSnapshot(tag){
	const ts = nowIso();
	const mainMem = await getMainMem();
	const renMem = await getRendererMem();
	let metrics = [];
	try {
		const ar = app.getAppMetrics();
		for(let i=0; i<ar.length; i++){
			const m = ar[i];
			metrics.push({
				pid: m.pid,
				type: m.type,
				wsMB: mb(m.memory && m.memory.workingSetSize ? m.memory.workingSetSize * 1024 : 0),
				privMB: mb(m.memory && m.memory.privateBytes ? m.memory.privateBytes * 1024 : 0)
			});
		}
	} catch(e) {}
	console.log('[HARNESS][MEM]', ts, tag || '', { main: mainMem, renderer: renMem, procs: metrics });
}

function startTelemetry(){
	if(telemetryTimer) return;
	telemetryTimer = setInterval(() => {
		logSnapshot('tick');
	}, 2000);
}

function stopTelemetry(){
	if(!telemetryTimer) return;
	clearInterval(telemetryTimer);
	telemetryTimer = null;
}

function createWindow(){
	createWindowForVariant(null);
}

function createWindowForVariant(v){
	win = new BrowserWindow({
		width: 980,
		height: 720,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			backgroundThrottling: false
		}
	});
	const qp = v ? {
		controller: '1',
		variant: '' + v.id,
		title: '' + v.title,
		exp: JSON.stringify(v.exp || {})
	} : {
		controller: controller.enabled ? '1' : '0'
	};
	win.loadFile(path.join(__dirname, 'index.html'), { query: qp });
	win.on('closed', () => {
		win = null;
		stopTelemetry();
	});
}

function startControllerIfEnabled(){
	// If HARNESS_NO_MATRIX is set, run a single window (legacy behavior).
	if(process.env.HARNESS_NO_MATRIX === '1') controller.enabled = false;
	if(!controller.enabled){
		createWindowForVariant(null);
		return;
	}
	controller.idx = 0;
	controller.results = [];
	createWindowForVariant(VARIANTS[controller.idx]);
}

function nextVariant(){
	controller.idx++;
	if(controller.idx >= VARIANTS.length){
		printFinalSummary();
		setTimeout(() => { try { app.quit(); } catch(e) {} }, 50);
		return;
	}
	createWindowForVariant(VARIANTS[controller.idx]);
}

function printFinalSummary(){
	console.log('[HARNESS][AB] ===== FINAL SUMMARY =====');
	for(let i=0; i<controller.results.length; i++){
		const r = controller.results[i];
		const g = r && r.growth ? r.growth : {};
		let multiKey = '';
		for(const k in g){ if(k.startsWith('multi:')) { multiKey = k; break; } }
		const mg = multiKey ? g[multiKey] : null;
		const delta = mg ? mg.delta : null;
		console.log('[HARNESS][AB]', (r.variant || '?'), (r.title || ''), 'multiDeltaMB=', delta, 'exp=', JSON.stringify(r.exp || {}));
	}
	console.log('[HARNESS][AB] =========================');
}

ipcMain.handle('scan-folders', async (ev, payload) => {
	const folders = payload && payload.folders ? payload.folders : [];
	const limit = (payload && payload.limit) ? (payload.limit | 0) : 5000;
	const exts = getSupportedExts();
	const out = [];
	for(let i=0; i<folders.length; i++){
		const fp = folders[i];
		if(!fp) continue;
		await walkDir(fp, out, exts, limit);
		if(out.length >= limit) break;
	}
	return { files: out, limit: limit, count: out.length };
});

ipcMain.handle('mem-snapshot', async (ev, tag) => {
	await logSnapshot(tag || 'snapshot');
	return true;
});

ipcMain.handle('quit', async () => {
	try { await logSnapshot('quit'); } catch(e) {}
	setTimeout(() => {
		try { app.quit(); } catch(e) {}
	}, 50);
	return true;
});

ipcMain.handle('variant-finished', async (ev, payload) => {
	// Renderer completed one variant.
	try {
		const v = payload || {};
		controller.results.push({
			variant: v.variant || '',
			title: v.title || '',
			exp: v.experiments || {},
			growth: v.growth || {}
		});
		console.log('[HARNESS][AB] VARIANT DONE', v.variant || '', v.title || '', 'growthKeys=', Object.keys(v.growth || {}));
	} catch(e) {}

	// Close window to force a fresh renderer for the next variant.
	try { if(win && !win.isDestroyed()) win.close(); } catch(e) {}
	
	// Allow system to breathe and clear memory between variants
	console.log('[HARNESS][AB] Waiting 2s for memory cleanup before next variant...');
	setTimeout(() => {
		try { if(global.gc) global.gc(); } catch(e) {}
		setTimeout(() => { try { nextVariant(); } catch(e) {} }, 1000);
	}, 1000);
	return true;
});

ipcMain.on('telemetry', (ev, on) => {
	if(on) startTelemetry();
	else stopTelemetry();
});

ipcMain.on('renderer-mem', (ev, data) => {
	try {
		console.log('[HARNESS][RENDERER]', nowIso(), data);
	} catch(e) {}
});

ipcMain.on('renderer-log', (ev, data) => {
	try {
		console.log('[HARNESS][LOG]', nowIso(), data);
	} catch(e) {}
});

ipcMain.on('renderer-status', (ev, data) => {
	try {
		console.log('[HARNESS][STATUS]', nowIso(), data);
	} catch(e) {}
});

app.whenReady().then(() => {
	startControllerIfEnabled();
});

app.on('window-all-closed', () => {
	// Controller mode keeps running across windows.
	if(controller && controller.enabled && controller.idx < VARIANTS.length) return;
	app.quit();
});
