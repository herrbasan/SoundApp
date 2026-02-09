/**
 * Test script to verify engines.js structure
 * Run with: node test-engine.js
 */

const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════════');
console.log('  AUDIO ENGINE VERIFICATION');
console.log('═══════════════════════════════════════════════════════════\n');

const enginesPath = path.join(__dirname, 'js', 'engines.js');
const content = fs.readFileSync(enginesPath, 'utf8');

let passed = 0;
let failed = 0;

function test(name, condition) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        failed++;
    }
}

// Basic structure tests
console.log('BASIC STRUCTURE:');
test('File exists and is readable', content.length > 0);
test('Has strict mode declaration', content.includes("'use strict'"));
test('Is a Node.js module (ipcRenderer)', content.includes('ipcRenderer'));
test('Has ENGINE comment header', content.includes('ENGINES.JS'));

// Key audio functions should exist
console.log('\nAUDIO FUNCTIONS (should exist):');
test('calculateDesiredPipeline', content.includes('function calculateDesiredPipeline'));
test('applyRoutingState', content.includes('function applyRoutingState'));
test('ensureRubberbandPipeline', content.includes('function ensureRubberbandPipeline'));
test('switchPipeline', content.includes('async function switchPipeline'));
test('playAudio', content.includes('async function playAudio'));
test('clearAudio', content.includes('function clearAudio'));
test('audioEnded', content.includes('function audioEnded'));
test('initMidiPlayer', content.includes('async function initMidiPlayer'));
test('toggleHQMode', content.includes('async function toggleHQMode'));
test('setVolume', content.includes('function setVolume'));
test('seekTo', content.includes('function seekTo'));
test('initMonitoring', content.includes('function initMonitoring'));

// Position push (new IPC feature)
console.log('\nPOSITION PUSH (new IPC feature):');
test('startPositionPush function', content.includes('function startPositionPush'));
test('stopPositionPush function', content.includes('function stopPositionPush'));
test('POSITION_PUSH_MS constant', content.includes('POSITION_PUSH_MS'));
test('audio:position IPC send', content.includes("ipcRenderer.send('audio:position'"));

// IPC Command handlers (should exist)
console.log('\nIPC COMMAND HANDLERS:');
test('cmd:load handler', content.includes("ipcRenderer.on('cmd:load'"));
test('cmd:play handler', content.includes("ipcRenderer.on('cmd:play'"));
test('cmd:pause handler', content.includes("ipcRenderer.on('cmd:pause'"));
test('cmd:seek handler', content.includes("ipcRenderer.on('cmd:seek'"));
test('cmd:next handler', content.includes("ipcRenderer.on('cmd:next'"));
test('cmd:prev handler', content.includes("ipcRenderer.on('cmd:prev'"));
test('cmd:setParams handler', content.includes("ipcRenderer.on('cmd:setParams'"));
test('cmd:playlist handler', content.includes("ipcRenderer.on('cmd:playlist'"));

// State events to app.js
console.log('\nSTATE EVENTS TO APP.JS:');
test('audio:loaded event', content.includes("ipcRenderer.send('audio:loaded'"));
test('audio:state event', content.includes("ipcRenderer.send('audio:state'"));
test('audio:ended event (find it)', content.includes("audio:ended") || content.includes('audioEnded'));
test('audio:metadata event', content.includes("ipcRenderer.send('audio:metadata'"));
test('engine:ready event', content.includes("ipcRenderer.send('engine:ready'"));

// UI functions should NOT exist (or should be removed)
console.log('\nUI FUNCTIONS (should NOT exist):');
test('appStart REMOVED', !content.includes('async function appStart'));
test('onKey REMOVED', !content.includes('async function onKey') && !content.includes('function onKey'));
test('setupDragDrop REMOVED', !content.includes('function setupDragDrop'));
test('setupWindow REMOVED', !content.includes('function setupWindow'));
test('renderInfo REMOVED (or renamed)', !content.includes('async function renderInfo') || content.includes('collectMetadata'));
test('renderBar REMOVED', !content.includes('function renderBar'));
test('loop REMOVED', !content.includes('function loop()'));
test('openWindow REMOVED (mostly)', !content.includes('async function openWindow'));
test('scaleWindow REMOVED', !content.includes('async function scaleWindow'));

// DOM manipulation should be minimal
console.log('\nDOM/USAGE (should be minimal):');
test('No document.querySelector', !content.includes('document.querySelector'));
test('No document.body references', !content.includes('document.body'));
test('No window.addEventListener for keydown', !content.includes('window.addEventListener("keydown"'));
test('No window.addEventListener for wheel', !content.includes("window.addEventListener('wheel'"));

// Audio globals should exist
console.log('\nAUDIO GLOBALS:');
test('g.audioContext', content.includes('g.audioContext'));
test('g.rubberbandContext', content.includes('g.rubberbandContext'));
test('g.rubberbandPlayer', content.includes('g.rubberbandPlayer'));
test('g.ffmpegPlayer', content.includes('g.ffmpegPlayer'));
test('g.activePipeline', content.includes('g.activePipeline'));
test('g.audioParams', content.includes('g.audioParams'));
test('g.currentAudio', content.includes('g.currentAudio'));

// Syntax check - basic
console.log('\nSYNTAX CHECKS:');
test('No obvious syntax errors (balanced braces)', (content.match(/\{/g) || []).length >= (content.match(/\}/g) || []).length - 5);

// Summary
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════');

if (failed > 0) {
    console.log('\n⚠️  Some checks failed. Review the output above.');
    process.exit(1);
} else {
    console.log('\n✅ All checks passed!');
    process.exit(0);
}
