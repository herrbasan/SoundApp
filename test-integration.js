/**
 * Integration Test for Audio Worker Refactor (Phases 1-3)
 * Validates consistency between app.js, engines.js, and player.js
 * Run with: node test-integration.js
 */

const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════════');
console.log('  AUDIO WORKER INTEGRATION TEST');
console.log('  Phases 1-3: Engine + State Machine + Player UI');
console.log('═══════════════════════════════════════════════════════════\n');

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

function testSection(title) {
    console.log(`\n${title}:`);
}

// Load files
const appPath = path.join(__dirname, 'js', 'app.js');
const enginesPath = path.join(__dirname, 'js', 'engines.js');
const playerPath = path.join(__dirname, 'js', 'player.js');
const enginesHtmlPath = path.join(__dirname, 'html', 'engines.html');
const playerHtmlPath = path.join(__dirname, 'html', 'player.html');

const appContent = fs.readFileSync(appPath, 'utf8');
const enginesContent = fs.readFileSync(enginesPath, 'utf8');
const playerContent = fs.readFileSync(playerPath, 'utf8');
const enginesHtmlContent = fs.readFileSync(enginesHtmlPath, 'utf8');
const playerHtmlContent = fs.readFileSync(playerHtmlPath, 'utf8');

// ============================================================================
// TEST 1: File Structure
// ============================================================================
testSection('FILE STRUCTURE');
test('app.js exists and readable', appContent.length > 0);
test('engines.js exists and readable', enginesContent.length > 0);
test('player.js exists and readable', playerContent.length > 0);
test('engines.html exists and readable', enginesHtmlContent.length > 0);
test('player.html exists and readable', playerHtmlContent.length > 0);

// ============================================================================
// TEST 2: IPC Channel Consistency (App ↔ Engine)
// ============================================================================
testSection('IPC CHANNEL CONSISTENCY (App ↔ Engine)');

// Commands from app.js to engines.js
const appToEngineCommands = [
    "'cmd:load'",
    "'cmd:play'",
    "'cmd:pause'",
    "'cmd:seek'",
    "'cmd:next'",
    "'cmd:prev'",
    "'cmd:setParams'",
    "'cmd:playlist'"
];

for (const cmd of appToEngineCommands) {
    const appSends = appContent.includes(`sendToEngine(${cmd}`);
    const engineReceives = enginesContent.includes(`ipcRenderer.on(${cmd}`);
    test(`Command ${cmd}: app sends → engine receives`, appSends && engineReceives);
}

// Events from engines.js to app.js
const engineToAppEvents = [
    "'audio:position'",
    "'audio:state'",
    "'audio:loaded'",
    "'audio:ended'",
    "'audio:metadata'",
    "'engine:ready'"
];

for (const evt of engineToAppEvents) {
    const engineSends = enginesContent.includes(`ipcRenderer.send(${evt}`);
    const appReceives = appContent.includes(`ipcMain.on(${evt}`) || appContent.includes(`ipcMain.once(${evt}`);
    test(`Event ${evt}: engine sends → app receives`, engineSends && appReceives);
}

// ============================================================================
// TEST 3: IPC Channel Consistency (App ↔ Player)
// ============================================================================
testSection('IPC CHANNEL CONSISTENCY (App ↔ Player)');

// Commands from player.js to app.js
const playerToAppCommands = [
    "'audio:play'",
    "'audio:pause'",
    "'audio:seek'",
    "'audio:load'",
    "'audio:setParams'",
    "'audio:setPlaylist'",
    "'audio:requestState'"
];

for (const cmd of playerToAppCommands) {
    const playerSends = playerContent.includes(`ipcRenderer.send(${cmd}`);
    const appReceives = appContent.includes(`ipcMain.on(${cmd}`);
    test(`Command ${cmd}: player sends → app receives`, playerSends && appReceives);
}

// Events from app.js to player.js
const appToPlayerEvents = [
    "'state:update'",
    "'position'"
];

for (const evt of appToPlayerEvents) {
    const appSends = appContent.includes(`sendToPlayer(${evt}`);
    const playerReceives = playerContent.includes(`ipcRenderer.on(${evt}`);
    test(`Event ${evt}: app sends → player receives`, appSends && playerReceives);
}

// ============================================================================
// TEST 4: State Structure Consistency
// ============================================================================
testSection('STATE STRUCTURE');

const stateFields = [
    'file', 'isPlaying', 'position', 'duration',
    'mode', 'tapeSpeed', 'pitch', 'tempo', 'formant', 'locked',
    'volume', 'loop', 'activePipeline'
];

for (const field of stateFields) {
    const inAppState = appContent.includes(`${field}:`) || appContent.includes(`${field} =`);
    test(`State field '${field}' defined in app.js`, inAppState);
}

// ============================================================================
// TEST 5: Engine Configuration
// ============================================================================
testSection('ENGINE WINDOW CONFIGURATION');
test('Engine window is hidden (show: false)', 
    appContent.includes('show: false') || appContent.includes('show:false')
);
test('Engine loads engines.html', appContent.includes('html/engines.html'));
test('Engine has backgroundThrottling: false', appContent.includes('backgroundThrottling: false'));
test('engines.html loads engines.js', enginesHtmlContent.includes('engines.js'));
test('engines.html loads required libraries', 
    enginesHtmlContent.includes('chiptune3.js') && 
    enginesHtmlContent.includes('midi.js')
);

// ============================================================================
// TEST 6: Player Configuration
// ============================================================================
testSection('PLAYER WINDOW CONFIGURATION');
test('Player loads player.html', appContent.includes('html/player.html'));
test('player.html loads player.js', playerHtmlContent.includes('player.js'));
test('player.html does NOT load audio libraries', 
    !playerHtmlContent.includes('chiptune2.js') && 
    !playerHtmlContent.includes('midi.js')
);
test('Player does NOT create AudioContext', !playerContent.includes('new AudioContext'));
test('Player does NOT initialize FFmpeg player', !playerContent.includes('FFmpegStreamPlayerSAB'));

// ============================================================================
// TEST 7: No Circular Dependencies
// ============================================================================
testSection('DEPENDENCY CHECK');
test('engines.js does not import app.js', !enginesContent.includes("require('./app.js')"));
test('engines.js does not import stage.js', !enginesContent.includes("require('./stage.js')"));
test('player.js does not import stage.js', !playerContent.includes("require('./stage.js')"));
test('player.js does not import engines.js', !playerContent.includes("require('./engines.js')"));

// ============================================================================
// TEST 8: Position Push Configuration
// ============================================================================
testSection('POSITION PUSH CONFIGURATION');
test('POSITION_PUSH_INTERVALS defined in engines.js', enginesContent.includes('POSITION_PUSH_INTERVALS'));
test('startPositionPush function exists', enginesContent.includes('function startPositionPush'));
test('stopPositionPush function exists', enginesContent.includes('function stopPositionPush'));
test('app.js handles audio:position', appContent.includes("ipcMain.on('audio:position'"));
test('Player receives position updates', playerContent.includes("ipcRenderer.on('position'"));

// ============================================================================
// TEST 9: Error Handling
// ============================================================================
testSection('ERROR HANDLING');
test('sendToEngine has try/catch', appContent.includes('try {') && appContent.includes('sendToEngine'));
test('engineWindow.isDestroyed() check', appContent.includes('isDestroyed()'));
test('Engine initialization flag', appContent.includes('engineInitializing'));

// ============================================================================
// TEST 10: Playlist Handling
// ============================================================================
testSection('PLAYLIST HANDLING');
test('handleTrackEnded function exists', appContent.includes('function handleTrackEnded'));
test('Playlist advance logic exists', appContent.includes('playlistIndex++'));
test('Loop logic exists', appContent.includes('audioState.loop'));
test('cmd:playlist sends playlist to engine', 
    appContent.includes("sendToEngine('cmd:playlist'") && 
    appContent.includes('music: audioState.playlist')
);
test('Player has playlist management', playerContent.includes('g.music = []'));
test('Player sends playlist to app', playerContent.includes('audio:setPlaylist'));

// ============================================================================
// Summary
// ============================================================================
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════');

if (failed > 0) {
    console.log('\n⚠️  Some integration checks failed.');
    console.log('   Review the output above before proceeding to Phase 4.');
    process.exit(1);
} else {
    console.log('\n✅ All integration tests passed!');
    console.log('   Ready for Phase 4: Engine Disposal/Restoration');
    process.exit(0);
}
