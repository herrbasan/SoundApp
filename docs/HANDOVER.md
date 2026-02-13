# Handover: State Machine Issues (2026-02-13)

## Status: ✅ FIXED

## Problem

When `locked=false` and user skips to a new file while engines are closed:
- `tapeSpeed` was correctly reset to 0
- BUT `pitch` remained at old value (e.g., -3)
- AND `mode` remained "pitchtime" (should be "tape")

## Root Cause

The `playNext()` and `playPrev()` functions in `player.js` send `audio:load`, NOT `audio:next`/`audio:prev` IPC messages.

The `audio:load` handler in `app.js` was NOT resetting params when `locked=false` - it was just sending the current `audioState` values to the engine.

## Fix

### js/app.js (audio:load handler, ~line 1150)

Added reset logic when engine is not alive and `locked=false`:

```javascript
if (!audioState.engineAlive) {
    // ... create engine window ...
    
    // Reset params if locked=false
    if (!audioState.locked) {
        audioState.mode = 'tape';
        audioState.tapeSpeed = 0;
        audioState.pitch = 0;
        audioState.tempo = 1.0;
        audioState.formant = false;
    }
    
    // Send params to engine
    sendToEngine('cmd:setParams', { ... });
    
    // Update parameters window UI if we reset
    if (!audioState.locked && childWindows.parameters.open) {
        sendParamsToParametersWindow(true);
    }
}
```

## Files Modified

- `js/app.js` - Added reset logic to `audio:load` handler
- `js/parameters/main.js` - Clear debounce timeouts before updating sliders
- `js/state-debug/main.js` - Fixed to process actions array from main

## Testing

1. Open app, play audio file
2. Open Parameters window, switch to Pitch/Time
3. Set pitch to -3
4. Click Pause, wait for engine disposal
5. Click **Next** or **Prev** to skip file
6. **Result:** UI correctly resets to Tape mode with Speed 0

---

**Last Updated:** 2026-02-13 - Issue resolved
