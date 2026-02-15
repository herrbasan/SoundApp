/**
 * Test script to verify app.js Phase 2 additions
 * Run with: node test-app-phase2.js
 */

const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════════');
console.log('  APP.JS PHASE 2 VERIFICATION');
console.log('═══════════════════════════════════════════════════════════\n');

const appPath = path.join(__dirname, 'js', 'app.js');
const content = fs.readFileSync(appPath, 'utf8');

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

// State machine
console.log('STATE MACHINE:');
test('audioState object defined', content.includes('const audioState = {'));
test('audioState.file field', content.includes('file: null'));
test('audioState.isPlaying field', content.includes('isPlaying: false'));
test('audioState.engineAlive field', content.includes('engineAlive: false'));
test('audioState.playlist field', content.includes('playlist: []'));

// Engine lifecycle
console.log('\nENGINE LIFECYCLE:');
test('createEngineWindow function', content.includes('async function createEngineWindow'));
test('disposeEngineWindow function', content.includes('function disposeEngineWindow'));
test('sendToEngine function', content.includes('function sendToEngine'));
test('engineWindow variable', content.includes('let engineWindow = null'));
test('wins object for window management', content.includes('let wins = {}') || content.includes('wins = {}'));

// IPC Setup
console.log('\nIPC SETUP:');
test('setupAudioIPC function', content.includes('function setupAudioIPC'));
test('setupAudioIPC called in appStart', content.includes('setupAudioIPC();'));

// Player → Engine commands
console.log('\nPLAYER → ENGINE COMMANDS:');
test('audio:play handler', content.includes("ipcMain.on('audio:play'"));
test('audio:pause handler', content.includes("ipcMain.on('audio:pause'"));
test('audio:seek handler', content.includes("ipcMain.on('audio:seek'"));
test('audio:load handler', content.includes("ipcMain.on('audio:load'"));
test('audio:next handler', content.includes("ipcMain.on('audio:next'"));
test('audio:prev handler', content.includes("ipcMain.on('audio:prev'"));
test('audio:setParams handler', content.includes("ipcMain.on('audio:setParams'"));
test('audio:setPlaylist handler', content.includes("ipcMain.on('audio:setPlaylist'"));

// Engine → Main events
console.log('\nENGINE → MAIN EVENTS:');
test('audio:position handler', content.includes("ipcMain.on('audio:position'"));
test('audio:state handler', content.includes("ipcMain.on('audio:state'"));
test('audio:loaded handler', content.includes("ipcMain.on('audio:loaded'"));
test('audio:ended handler', content.includes("ipcMain.on('audio:ended'"));
test('audio:metadata handler', content.includes("ipcMain.on('audio:metadata'"));
test('engine:ready handler', content.includes("ipcMain.once('engine:ready'"));

// State broadcasting
console.log('\nSTATE BROADCASTING:');
test('broadcastState function', content.includes('function broadcastState'));
test('sendToPlayer function', content.includes('function sendToPlayer'));
test('state:update event', content.includes("sendToPlayer('state:update'"));
test('position event', content.includes("sendToPlayer('position'"));

// Track advancement
console.log('\nTRACK ADVANCEMENT:');
test('handleTrackEnded function', content.includes('async function handleTrackEnded'));

// Engine commands
console.log('\nENGINE COMMANDS (cmd:*):');
test('cmd:play send', content.includes("sendToEngine('cmd:play'"));
test('cmd:pause send', content.includes("sendToEngine('cmd:pause'"));
test('cmd:load send', content.includes("sendToEngine('cmd:load'"));
test('cmd:seek send', content.includes("sendToEngine('cmd:seek'"));
test('cmd:next send', content.includes("sendToEngine('cmd:next'"));
test('cmd:prev send', content.includes("sendToEngine('cmd:prev'"));
test('cmd:setParams send', content.includes("sendToEngine('cmd:setParams'"));
test('cmd:playlist send', content.includes("sendToEngine('cmd:playlist'"));

// Summary
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════');

if (failed > 0) {
    console.log('\n⚠️  Some checks failed. Review the output above.');
    process.exit(1);
} else {
    console.log('\n✅ All Phase 2 checks passed!');
    process.exit(0);
}
