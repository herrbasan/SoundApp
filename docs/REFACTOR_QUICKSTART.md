# Refactor Quick Start - For New Session

> **Goal:** Complete Phase 4A - Fix State Preservation  
> **Context:** The audio worker refactor is incomplete because engines.js still resets params

---

## What You Need to Know

### The Problem (1 minute read)

The refactor separated UI from audio engine:
- `app.js` = State machine (owns `audioState`)
- `engines.js` = Should be stateless audio executor
- `player.js` = UI only

**BUG:** `engines.js` still resets parameters on file load (inherited from old `stage.js`). This breaks state preservation when engine is disposed/restored.

**EXAMPLE:** User sets pitch to +5 → engine disposes (0% CPU) → restore → pitch is 0 (should be +5)

### The Fix (3 changes)

1. **Add `cmd:applyParams`** - New IPC command to apply params to active players
2. **Remove param resets** - Stop engines.js from resetting `g.audioParams`
3. **Fix restore sequence** - Apply params AFTER players are created

---

## Files to Modify

### 1. js/engines.js

#### Change A: Add cmd:applyParams handler
Find the IPC handlers in `init()` function, add after `cmd:setParams`:

```javascript
ipcRenderer.on('cmd:applyParams', (e, data) => {
    console.log('[Engine] cmd:applyParams', data);
    
    if (g.currentAudio?.isFFmpeg) {
        const player = g.currentAudio.player;
        if (data.mode === 'tape' && data.tapeSpeed !== 0) {
            player.setPlaybackRate(data.tapeSpeed);
        } else if (data.mode === 'pitchtime' && g.activePipeline === 'rubberband') {
            if (typeof player.setPitch === 'function') {
                player.setPitch(Math.pow(2, (data.pitch || 0) / 12.0));
            }
            if (typeof player.setTempo === 'function') {
                player.setTempo(data.tempo || 1.0);
            }
            if (typeof player.setOptions === 'function') {
                player.setOptions({ formantPreserved: !!data.formant });
            }
        }
    } else if (g.currentAudio?.isMidi && midi) {
        if (data.transpose !== undefined) midi.setPitchOffset(data.transpose);
        if (data.bpm !== undefined && midi.getOriginalBPM) {
            const ratio = data.bpm / midi.getOriginalBPM();
            midi.setPlaybackSpeed(ratio);
        }
        if (data.metronome !== undefined) midi.setMetronome(data.metronome);
    } else if (g.currentAudio?.isMod && player) {
        if (data.pitch !== undefined) player.setPitch(data.pitch);
        if (data.tempo !== undefined) player.setTempo(data.tempo);
        if (data.stereoSeparation !== undefined) player.setStereoSeparation(data.stereoSeparation);
    }
});
```

#### Change B: Remove param reset from window-hidden handler
Find lines ~741-767, look for:

```javascript
ipcRenderer.on('window-hidden', async (e, data) => {
    if (data.type === 'parameters') {
        // DELETE ALL PARAM RESETS HERE
        // Keep only: await applyRoutingState();
    }
}
```

**Remove:** All lines that reset `g.audioParams.*` to defaults.

**Keep:** Only the pipeline routing logic if needed.

#### Change C: Remove param reset from playAudio()
Find lines ~1723-1782, look for the block:

```javascript
if (!restore && g.windows.parameters) {
    // DELETE THIS ENTIRE BLOCK
    // It resets params and sends set-mode to parameters window
}
```

Replace with just notifying the parameters window of current state:

```javascript
if (g.windows.parameters) {
    // Just notify UI of current state, don't reset
    tools.sendToId(g.windows.parameters, 'set-mode', { 
        mode: isMIDI ? 'midi' : isTracker ? 'tracker' : 'audio',
        params: isMIDI ? {
            transpose: g.midiSettings?.pitch || 0,
            bpm: /* calculate from g.midiSettings.speed */,
            metronome: g.midiSettings?.metronome || false
        } : isTracker ? {
            pitch: g.trackerParams?.pitch || 1.0,
            tempo: g.trackerParams?.tempo || 1.0,
            stereoSeparation: g.trackerParams?.stereoSeparation || 100
        } : {
            audioMode: g.audioParams.mode,
            tapeSpeed: g.audioParams.tapeSpeed,
            pitch: g.audioParams.pitch,
            tempo: g.audioParams.tempo,
            formant: g.audioParams.formant,
            locked: g.audioParams.locked
        }
    });
}
```

---

### 2. js/app.js

#### Change: Fix restoreEngineIfNeeded() sequence

Find the function (~line 769), look for the current sequence:

```javascript
// CURRENT (broken):
sendToEngine('cmd:setParams', {...});  // Sets globals
sendToEngine('cmd:load', {...});        // playAudio resets them
sendParamsToParametersWindow();         // Too early
```

Replace with:

```javascript
// FIXED:
// Step 1: Set engine globals
sendToEngine('cmd:setParams', {
    mode: audioState.mode,
    tapeSpeed: audioState.tapeSpeed,
    pitch: audioState.pitch,
    tempo: audioState.tempo,
    formant: audioState.formant,
    locked: audioState.locked,
    volume: audioState.volume,
    loop: audioState.loop
});

// Step 2: Re-register child windows (keep existing code)
// ... child window registration ...

// Step 3: Load file
sendToEngine('cmd:load', {
    file: audioState.file,
    position: audioState.position,
    paused: !audioState.isPlaying
    // Note: remove 'restore' flag if no longer needed
});

// Step 4: Wait for file load, then apply params to players
const onLoaded = (e, data) => {
    if (data.file === audioState.file) {
        ipcMain.removeListener('audio:loaded', onLoaded);
        
        // Apply params to active players
        sendToEngine('cmd:applyParams', {
            mode: audioState.mode,
            tapeSpeed: audioState.tapeSpeed,
            pitch: audioState.pitch,
            tempo: audioState.tempo,
            formant: audioState.formant
        });
        
        // Apply format-specific params
        if (audioState.fileType === 'MIDI') {
            sendToEngine('param-change', { 
                mode: 'midi', 
                param: 'transpose', 
                value: audioState.midiParams.transpose 
            });
            // ... etc for bpm, metronome
        } else if (audioState.fileType === 'Tracker') {
            sendToEngine('param-change', { 
                mode: 'tracker', 
                param: 'pitch', 
                value: audioState.trackerParams.pitch 
            });
            // ... etc for tempo, stereoSeparation
        }
        
        // Update UI
        sendParamsToParametersWindow();
    }
};
ipcMain.on('audio:loaded', onLoaded);
```

---

## Testing

### Quick Test (DevTools)

1. **Open player window DevTools** (F12)
2. **Load audio file**
3. **Set pitch to +5** in parameters window
4. **Close engine:**
   ```javascript
   debugEngine.close()
   ```
5. **Re-open engine:**
   ```javascript
   debugEngine.open()
   ```
6. **Verify:** Pitch should still be +5 (not reset to 0)

### Full Test Checklist

- [ ] FFmpeg tape speed survives dispose/restore
- [ ] FFmpeg pitch/tempo/formant survives (pitchtime mode)
- [ ] MIDI transpose/BPM/metronome survives
- [ ] Tracker pitch/tempo/stereo survives
- [ ] Params window shows correct values after restore

---

## If You Get Stuck

### Check These:

1. **Are params being reset?** Add logging in engines.js:
   ```javascript
   console.log('[playAudio] g.audioParams:', g.audioParams);
   ```

2. **Is cmd:applyParams being called?** Add logging:
   ```javascript
   ipcRenderer.on('cmd:applyParams', (e, data) => {
       console.log('[Engine] cmd:applyParams', data);
       // ...
   });
   ```

3. **Are players initialized?** Check `g.currentAudio` before applying params.

### Key Concepts:

- `cmd:setParams` → Sets globals (`g.audioParams`) - use BEFORE load
- `cmd:applyParams` → Applies to players - use AFTER load
- `param-change` → User changed a slider - update globals AND apply immediately

---

## Documents

| Document | Purpose |
|----------|---------|
| [AUDIO_WORKER_REFACTOR.md](./AUDIO_WORKER_REFACTOR.md) | Full architecture and completion plan |
| [IDLE_DISPOSAL_IMPLEMENTATION.md](./IDLE_DISPOSAL_IMPLEMENTATION.md) | Detailed state preservation analysis |
| [AGENTS.md](./AGENTS.md) | Mental models, debugging snippets |
| [DETERMINISTIC_MIND_MERGED.md](./DETERMINISTIC_MIND_MERGED.md) | **Coding ethics** - How to approach this codebase |

---

## Coding Ethics for This Session

**Read:** [DETERMINISTIC_MIND_MERGED.md](./DETERMINISTIC_MIND_MERGED.md)

**Key principles for this refactor:**

1. **Design failures away** - Don't add error handlers for states that shouldn't exist. The engine resetting params is a design flaw - fix it, don't work around it.

2. **No defensive programming** - Don't add checks like `if (!g.audioParams) g.audioParams = {}` unless there's a genuine external boundary. For internal code, verify the invariant instead.

3. **Disposal is mandatory and verifiable** - Every resource must have a proven cleanup path. The engine disposal works; state preservation must work too.

4. **Block until truth** - The UI (and engine) should reflect actual state, not assumed state. Apply params only after players are confirmed ready.

5. **Single responsibility** - `cmd:setParams` sets globals. `cmd:applyParams` applies to players. `playAudio()` loads files. Don't mix them.

---

## One-Liner Summary

**Make engines.js stateless:** Remove all param reset logic, only apply what main process sends via `cmd:setParams` / `cmd:applyParams`.
