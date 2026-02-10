/**
 * Test script to verify player.js Phase 3 implementation
 * Run with: node test-player-phase3.js
 */

const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════════');
console.log('  PLAYER.JS PHASE 3 VERIFICATION');
console.log('═══════════════════════════════════════════════════════════\n');

const playerPath = path.join(__dirname, 'js', 'player.js');
const playerHtmlPath = path.join(__dirname, 'html', 'player.html');
const content = fs.readFileSync(playerPath, 'utf8');
const htmlContent = fs.readFileSync(playerHtmlPath, 'utf8');

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

// File structure
console.log('FILE STRUCTURE:');
test('player.js exists and readable', content.length > 0);
test('player.html exists and readable', htmlContent.length > 0);

// No audio code
console.log('\nAUDIO CODE REMOVED:');
test('No AudioContext creation', !content.includes('new AudioContext'));
test('No FFmpeg player initialization', !content.includes('FFmpegStreamPlayerSAB'));
test('No Rubberband pipeline', !content.includes('RubberbandPipeline'));
test('No MIDI player initialization', !content.includes('initMidiPlayer'));
test('No Tracker player initialization', !content.includes('new window.chiptune'));
test('No AnalyserNode creation', !content.includes('createAnalyser'));
test('No audio worklet references', !content.includes('ffmpeg-worklet'));

// IPC Commands to app.js
console.log('\nIPC COMMANDS (Player → App):');
test("ipcRenderer.send('audio:play'", content.includes("'audio:play'"));
test("ipcRenderer.send('audio:pause'", content.includes("'audio:pause'"));
test("ipcRenderer.send('audio:seek'", content.includes("'audio:seek'"));
test("ipcRenderer.send('audio:load'", content.includes("'audio:load'"));
test("ipcRenderer.send('audio:setParams'", content.includes("'audio:setParams'"));
test("ipcRenderer.send('audio:setPlaylist'", content.includes("'audio:setPlaylist'"));
test("ipcRenderer.send('audio:requestState'", content.includes("'audio:requestState'"));

// State listeners
console.log('\nSTATE LISTENERS (App → Player):');
test("ipcRenderer.on('state:update'", content.includes("'state:update'"));
test("ipcRenderer.on('position'", content.includes("'position'") && content.includes('updatePositionUI'));

// UI State management
console.log('\nUI STATE MANAGEMENT:');
test('g.uiState object defined', content.includes('g.uiState'));
test('updateUI function exists', content.includes('function updateUI'));
test('updatePositionUI function exists', content.includes('function updatePositionUI'));
test('updateVolumeUI function exists', content.includes('function updateVolumeUI'));

// Playlist management
console.log('\nPLAYLIST MANAGEMENT:');
test('g.music array for playlist', content.includes('g.music = []'));
test('playListFromSingle function', content.includes('function playListFromSingle'));
test('playListFromMulti function', content.includes('function playListFromMulti'));
test('sendPlaylistToApp function', content.includes('function sendPlaylistToApp'));

// Drag & Drop
console.log('\nDRAG & DROP:');
test('setupDragDrop function', content.includes('function setupDragDrop'));
test('dropZone creation', content.includes('dropZone'));

// Window management
console.log('\nWINDOW MANAGEMENT:');
test('openWindow function', content.includes('function openWindow'));
test('Child window refs (g.windows)', content.includes('g.windows = {'));
test('Window visibility tracking', content.includes('g.windowsVisible'));

// UI Controls
console.log('\nUI CONTROLS:');
test('playPause function', content.includes('function playPause'));
test('playNext function', content.includes('function playNext'));
test('playPrev function', content.includes('function playPrev'));
test('toggleLoop function', content.includes('function toggleLoop'));
test('shufflePlaylist function', content.includes('function shufflePlaylist'));
test('seekTo function', content.includes('function seekTo'));
test('setVolume function', content.includes('function setVolume'));

// Keyboard handlers
console.log('\nKEYBOARD HANDLERS:');
test('onKey function', content.includes('function onKey'));
test('Keyboard shortcut handling', content.includes('shortcuts.handleShortcut'));

// Metadata display
console.log('\nMETADATA DISPLAY:');
test('renderInfo function', content.includes('function renderInfo'));
test('renderInfoItem function', content.includes('function renderInfoItem'));
test('loadCoverArt function', content.includes('function loadCoverArt'));

// HTML file
console.log('\nPLAYER.HTML:');
test('Loads player.js', htmlContent.includes('player.js'));
test('Does NOT load stage.js', !htmlContent.includes('stage.js'));
test('Does NOT load chiptune2.js', !htmlContent.includes('chiptune2.js'));
test('Does NOT load midi.js', !htmlContent.includes('midi.js'));
test('Has UI structure (frame)', htmlContent.includes('frame'));
test('Has controls section', htmlContent.includes('class="controls"'));
test('Has time_controls section', htmlContent.includes('class="time_controls"'));

// Summary
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════');

if (failed > 0) {
    console.log('\n⚠️  Some checks failed. Review the output above.');
    process.exit(1);
} else {
    console.log('\n✅ All Phase 3 checks passed!');
    process.exit(0);
}
