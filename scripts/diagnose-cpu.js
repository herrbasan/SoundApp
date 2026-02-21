/**
 * CPU Diagnostics for SoundApp
 * Run this in the DevTools console of the main window
 * or in the main process to diagnose idle CPU usage
 */

const os = require('os');
const { ipcRenderer } = require('electron');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  SoundApp CPU Diagnostics');
console.log('═══════════════════════════════════════════════════════════════');

// Check 1: Is the idle loop running?
console.log('\n[1] Idle Disposal Loop Status:');
ipcRenderer.send('debug:check-idle-loop');

// Check 2: Renderer performance stats
console.log('\n[2] Renderer Performance:');
console.log('  - Memory:', Math.round(performance.memory?.usedJSHeapSize / 1024 / 1024), 'MB');
console.log('  - Event Loop Lag:', 'Use Performance Monitor in DevTools');

// Check 3: Active intervals/timeouts
console.log('\n[3] Active Timers (cannot detect from JS - use DevTools):');
console.log('  - Open DevTools > Sources > Breakpoints');
console.log('  - Check for setInterval handlers');

// Check 4: Window visibility state
console.log('\n[4] Window State:');
console.log('  - Document Hidden:', document.hidden);
console.log('  - Visibility State:', document.visibilityState);

// Check 5: RequestAnimationFrame loops
console.log('\n[5] Check for RAF loops:');
let rafCount = 0;
const checkRAF = () => {
    rafCount++;
    if (rafCount < 60) {
        requestAnimationFrame(checkRAF);
    } else {
        console.log('  - RAF fired 60 times in 1 second (1s loop detected)');
    }
};

// Check 6: State Client activity
console.log('\n[6] State Client Activity:');
if (window.State) {
    console.log('  - State Client available: Yes');
    console.log('  - Current isPlaying:', State.get('playback.isPlaying'));
    console.log('  - Current engineAlive:', State.get('system.engineAlive'));
} else {
    console.log('  - State Client available: No');
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  To trace actual CPU usage:');
console.log('  1. Open DevTools > Performance tab');
console.log('  2. Record for 5-10 seconds while app is idle');
console.log('  3. Look for recurring events in the timeline');
console.log('═══════════════════════════════════════════════════════════════');
