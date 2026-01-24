'use strict';

const fs = require('fs');
const path = require('path');

function copyFromNodeModules() {
	const srcDir = path.resolve(__dirname, '../node_modules/js-synthesizer/dist');
	const destDirs = [
		path.resolve(__dirname, '../libs/midiplayer'),
		path.resolve(__dirname, '../bin/midiplayer-runtime')
	];
	const files = ['js-synthesizer.js', 'js-synthesizer.worklet.js', 'libfluidsynth.js'];
	
	if (!fs.existsSync(srcDir)) {
		console.warn('[patch-midiplayer-worklet] Source not found:', srcDir);
		return false;
	}
	
	for (const dest of destDirs) {
		fs.mkdirSync(dest, { recursive: true });
		for (const file of files) {
			const src = path.join(srcDir, file);
			const dst = path.join(dest, file);
			if (fs.existsSync(src)) {
				let content = fs.readFileSync(src, 'utf8');
				// Fix UMD wrapper to use globalThis instead of 'this' for ES module compatibility
				if (file === 'js-synthesizer.js') {
					content = content.replace('(function webpackUniversalModuleDefinition(root, factory) {', 
						'(function webpackUniversalModuleDefinition(root, factory) {\n\troot = root || globalThis;');
				}
				fs.writeFileSync(dst, content, 'utf8');
			}
		}
	}
	console.log('[patch-midiplayer-worklet] Copied files from node_modules');
	return true;
}

const targets = [
	path.resolve(__dirname, '../libs/midiplayer/js-synthesizer.worklet.js'),
	path.resolve(__dirname, '../bin/midiplayer-runtime/js-synthesizer.worklet.js')
];


const hookSnippet = `\t\t\tconst out = outputs[0];\n\t\t\tconst metro = AudioWorkletGlobalScope.SoundAppMetronome;\n\t\t\tif (metro && out && out[0]) {\n\t\t\t\tmetro.beginBlock(syn, out[0].length, sampleRate);\n\t\t\t}\n\t\t\tsyn.render(out);\n\t\t\tif (metro && out && out[0]) {\n\t\t\t\tmetro.endBlock(outputs, syn);\n\t\t\t}`;

const originalPattern = /(\s+)syn\.render\(outputs\[0\]\);/;
const alreadyPatched = 'AudioWorkletGlobalScope.SoundAppMetronome';

copyFromNodeModules();

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
	const match = src.match(originalPattern);
	if (!match) {
		console.warn('[patch-midiplayer-worklet] No match in:', fp);
		continue;
	}
	const indent = match[1];
	const indentedHook = hookSnippet.split('\n').map(line => indent + line.substring(3)).join('\n');
	const out = src.replace(originalPattern, indentedHook);
	fs.writeFileSync(fp, out, 'utf8');
	changed++;
}

console.log(`[patch-midiplayer-worklet] Patched: ${changed}, Skipped: ${skipped}`);
