'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function tryInitSubmodule() {
	try {
		execSync('git submodule update --init --recursive libs/midiplayer/src/js-synthesizer', {
			cwd: path.resolve(__dirname, '..'),
			stdio: 'ignore'
		});
		console.log('[patch-midiplayer-worklet] Submodule initialized');
	} catch (e) {
		console.warn('[patch-midiplayer-worklet] Submodule init skipped/failed');
	}
}

const targets = [
	path.resolve(__dirname, '../libs/midiplayer/js-synthesizer.worklet.js'),
	path.resolve(__dirname, '../bin/midiplayer-runtime/js-synthesizer.worklet.js')
];


const hookSnippet = `\t\t\tconst out = outputs[0];\n\t\t\tconst metro = AudioWorkletGlobalScope.SoundAppMetronome;\n\t\t\tif (metro && out && out[0]) {\n\t\t\t\tmetro.beginBlock(syn, out[0].length, sampleRate);\n\t\t\t}\n\t\t\tsyn.render(out);\n\t\t\tif (metro && out && out[0]) {\n\t\t\t\tmetro.endBlock(outputs, syn);\n\t\t\t}`;

const originalLine = '\t\t\tsyn.render(outputs[0]);';
const alreadyPatched = 'AudioWorkletGlobalScope.SoundAppMetronome';

tryInitSubmodule();

let changed = 0;
let skipped = 0;

for (let i = 0; i < targets.length; i++) {
	const fp = targets[i];
	if (!fs.existsSync(fp)) {
		console.warn('[patch-midiplayer-worklet] Missing:', fp);
		continue;
	}
	const src = fs.readFileSync(fp, 'utf8');
	if (src.includes(alreadyPatched)) {
		skipped++;
		continue;
	}
	if (!src.includes(originalLine)) {
		console.warn('[patch-midiplayer-worklet] No match in:', fp);
		continue;
	}
	const out = src.replace(originalLine, hookSnippet);
	fs.writeFileSync(fp, out, 'utf8');
	changed++;
}

console.log(`[patch-midiplayer-worklet] Patched: ${changed}, Skipped: ${skipped}`);
