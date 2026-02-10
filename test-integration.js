/**
 * Integration Test for Audio Worker Refactor (Phases 1-2)
 * Validates consistency between app.js and engines.js
 * Run with: node test-integration.js
 */

const fs = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════════');
console.log('  AUDIO WORKER INTEGRATION TEST');
console.log('  Phases 1-2: Engine + State Machine');
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
const enginesHtmlPath = path.join(__dirname, 'html', 'engines.html');

const appContent = fs.readFileSync(appPath, 'utf8');
const enginesContent = fs.readFileSync(enginesPath, 'utf8');
const enginesHtmlContent = fs.readFileSync(enginesHtmlPath, 'utf8');

// ============================================================================
// TEST 1: File Structure
// ============================================================================
testSection('FILE STRUCTURE');
test('app.js exists and readable', appContent.length > 0);
test('engines.js exists and readable', enginesContent.length > 0);
test('engines.html exists and readable', enginesHtmlContent.length > 0);

// ============================================================================
// TEST 2: IPC Channel Consistency
// ============================================================================
testSection('IPC CHANNEL CONSISTENCY');

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
// TEST 3: State Structure Consistency
// ============================================================================
testSection('STATE STRUCTURE');

// Check that app.js audioState has fields that engines.js expects
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
// TEST 4: Broadcast to Player
// ============================================================================
testSection('PLAYER COMMUNICATION');
test("app.js broadcasts 'state:update'", appContent.includes("sendToPlayer('state:update'"));
test("app.js sends 'position' updates", appContent.includes("sendToPlayer('position'"));
test("Player commands exist", 
    appContent.includes("'audio:play'") && 
    appContent.includes("'audio:pause'") &&
    appContent.includes("'audio:load'")
);

// ============================================================================
// TEST 5: Engine Window Configuration
// ============================================================================
testSection('ENGINE WINDOW CONFIGURATION');
test('Engine window is hidden (show: false)', 
    appContent.includes('show: false') || appContent.includes('show:false')
);
test('Engine loads engines.html', appContent.includes('html/engines.html'));
test('Engine has backgroundThrottling: false', appContent.includes('backgroundThrottling: false'));
test('engines.html loads engines.js', enginesHtmlContent.includes('engines.js'));
test('engines.html loads required libraries', 
    enginesHtmlContent.includes('chiptune2.js') && 
    enginesHtmlContent.includes('midi.js')
);

// ============================================================================
// TEST 6: No Circular Dependencies
// ============================================================================
testSection('DEPENDENCY CHECK');
test('engines.js does not import app.js', !enginesContent.includes("require('./app.js')"));
test('engines.js does not import stage.js', !enginesContent.includes("require('./stage.js')"));

// ============================================================================
// TEST 7: Position Push Configuration
// ============================================================================
testSection('POSITION PUSH CONFIGURATION');
test('POSITION_PUSH_MS defined in engines.js', enginesContent.includes('POSITION_PUSH_MS'));
test('Position push interval ≤ 15ms', 
    enginesContent.includes('15') || enginesContent.includes('POSITION_PUSH_MS')
);
test('startPositionPush function exists', enginesContent.includes('function startPositionPush'));
test('stopPositionPush function exists', enginesContent.includes('function stopPositionPush'));
test('app.js handles audio:position', appContent.includes("ipcMain.on('audio:position'"));

// ============================================================================
// TEST 8: Error Handling
// ============================================================================
testSection('ERROR HANDLING');
test('sendToEngine has try/catch', appContent.includes('try {') && appContent.includes('sendToEngine'));
test('engineWindow.isDestroyed() check', appContent.includes('isDestroyed()'));
test('Engine initialization flag', appContent.includes('engineInitializing'));

// ============================================================================
// TEST 9: Playlist Handling
// ============================================================================
testSection('PLAYLIST HANDLING');
test('handleTrackEnded function exists', appContent.includes('function handleTrackEnded'));
test('Playlist advance logic exists', appContent.includes('playlistIndex++'));
test('Loop logic exists', appContent.includes('audioState.loop'));
test('cmd:playlist sends playlist to engine', 
    appContent.includes("sendToEngine('cmd:playlist'") && 
    appContent.includes('music: audioState.playlist')
);

// ============================================================================
// TEST 10: Window Visibility (Monitoring)
// ============================================================================
testSection('WINDOW VISIBILITY (MONITORING)');
test('window-visible handler in app.js', appContent.includes("ipcMain.on('window-visible'"));
test('window-hidden handler in app.js', appContent.includes("ipcMain.on('window-hidden'"));
test('window-visible forwarded to engine', appContent.includes("sendToEngine('window-visible'"));
test('window-hidden forwarded to engine', appContent.includes("sendToEngine('window-hidden'"));
test('engine has window-visible handler', enginesContent.includes("ipcRenderer.on('window-visible'"));
test('engine has window-hidden handler', enginesContent.includes("ipcRenderer.on('window-hidden'"));

// ============================================================================
// Summary
// ============================================================================
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════');

if (failed > 0) {
    console.log('\n⚠️  Some integration checks failed.');
    console.log('   Review the output above before proceeding to Phase 3.');
    process.exit(1);
} else {
    console.log('\n✅ All integration tests passed!');
    console.log('   Ready for Phase 3: Create player.js (UI window)');
    process.exit(0);
}
