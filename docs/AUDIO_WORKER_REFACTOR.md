# Audio Worker Refactor

> **Status:** ⚠️ **PHASE 4 INCOMPLETE** - State preservation needs completion  
> **Branch:** `feature/audio-worker`  
> **Goal:** 0% CPU when idle/tray by separating UI from audio engine

---

## Current Status

### What Works ✅

| Component | Status | Notes |
|-----------|--------|-------|
| Audio Engine (engines.js) | ✅ | Headless, all formats playing |
| Player UI (player.js) | ✅ | UI-only, communicates via IPC |
| State Machine (app.js) | ✅ | Basic state (file, position, playing) preserved |
| Engine Disposal/Restore | ✅ | Window destroy/recreate works, <300ms restore |
| CPU 0% when idle | ✅ | Confirmed working via window disposal |

### What's Broken ❌

| Component | Status | Notes |
|-----------|--------|-------|
| Parameter Preservation | ❌ | Pitch, tempo, formant, locked lost on restore |
| MIDI/Tracker Params | ❌ | Transpose, BPM, stereo separation lost on restore |
| Engine State Ownership | ❌ | engines.js still resets params (old stage.js behavior) |

**See:** [IDLE_DISPOSAL_IMPLEMENTATION.md](./IDLE_DISPOSAL_IMPLEMENTATION.md) for detailed analysis of the state preservation problem.

---

## The Core Problem

The refactor architecture is correct, but the implementation is incomplete. The engine (`engines.js`) was derived from `stage.js` by stripping UI code, but it **still thinks it owns state**:

```javascript
// engines.js - PROBLEM: Engine resets params on file load
if (!restore) {
    g.audioParams.mode = 'tape';      // ← Should NOT reset
    g.audioParams.tapeSpeed = 0;       // ← Should use what main sent
    g.audioParams.pitch = 0;
    // ... etc
}
```

The `locked` parameter exists as a **crutch** because the engine resets params. If the engine didn't reset, params would naturally persist.

### Why This Blocks Resource Management

The entire point of the refactor is resource management:

1. **Dispose engine when idle** → 0% CPU
2. **Restore when needed** → <300ms restore
3. **State preserved across restore** → Seamless user experience

If params are lost on restore, users must manually re-adjust every time the engine disposes. This makes the idle disposal feature unusable for anyone using parameters.

---

## Architecture (Correct Design)

```
┌─────────────────────────────────────────────────────────────────┐
│                     MAIN PROCESS (app.js)                        │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 STATE MACHINE (ground truth)                │  │
│  │  • file, isPlaying, position                               │  │
│  │  • mode, tapeSpeed, pitch, tempo, formant, locked          │  │
│  │  • midiParams: transpose, bpm, metronome                   │  │
│  │  • trackerParams: pitch, tempo, stereoSeparation           │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                       │
│         ┌─────────────────┼─────────────────┐                    │
│         │                 │                 │                    │
│         ▼                 ▼                 ▼                    │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐             │
│  │ engines.js  │  │ player.js   │  │ parameters/  │             │
│  │ AUDIO       │  │ UI          │  │ settings/    │             │
│  │ (stateless) │  │ (renders)   │  │ etc.         │             │
│  └─────────────┘  └─────────────┘  └──────────────┘             │
│                                                                   │
│  Command flow: player → app.js → engines                         │
│  State flow:   engines → app.js → broadcast to all               │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Key Principle: Engine is Stateless

The engine should be a **dumb executor**:
- Receives commands from main process
- Applies commands to audio players
- Reports state changes back to main
- **Never decides to reset or change params on its own**

---

## Completion Plan

### Phase 4A: Fix State Preservation (CRITICAL)

**Problem:** Engine resets params on file load and window hide.

**Solution:** Make engine truly stateless.

#### Step 1: Add `cmd:applyParams` IPC Command

New command to apply params to active players (players exist at this point):

```javascript
// engines.js - NEW handler
ipcRenderer.on('cmd:applyParams', (e, data) => {
    // Apply to CURRENT player (players now exist)
    if (g.currentAudio?.isFFmpeg) {
        applyFFmpegParams(data);
    } else if (g.currentAudio?.isMidi) {
        applyMidiParams(data);
    } else if (g.currentAudio?.isMod) {
        applyTrackerParams(data);
    }
});
```

#### Step 2: Remove Param Resets from `playAudio()`

**Remove:** The entire block that resets `g.audioParams` to defaults when `!restore`.

**Remove:** The `window-hidden` handler that resets params when parameters window closes.

**Keep:** Only pipeline routing logic (`applyRoutingState()`).

#### Step 3: Fix `restoreEngineIfNeeded()` Sequence

Current:
```
1. sendToEngine('cmd:setParams')  // Sets globals
2. sendToEngine('cmd:load')       // playAudio resets them 😠
```

Fixed:
```
1. sendToEngine('cmd:setParams')  // Set globals
2. sendToEngine('cmd:load')       // Load file (NO RESET)
3. Wait for 'audio:loaded'
4. sendToEngine('cmd:applyParams') // Apply to players
```

#### Step 4: Fix Param Change Flow

| Command | When to Use | Action |
|---------|-------------|--------|
| `cmd:setParams` | Before load, during restore | Set `g.audioParams` globals |
| `cmd:applyParams` | After load completes | Apply to active player |
| `param-change` | User adjusts slider | Update globals + apply to active player |

### Phase 4B: Remove "Locked" Crutch (Optional)

Once params persist naturally, `locked` becomes unnecessary:

1. Params always persist across file changes
2. User resets manually via "Reset" button
3. Remove `locked` from state, UI, and logic

**Decision needed:** Keep locked as explicit user choice, or remove?

### Phase 5: Lazy Engine Initialization

Once state preservation works, implement lazy engine init as described in [IDLE_DISPOSAL_IMPLEMENTATION.md](./IDLE_DISPOSAL_IMPLEMENTATION.md):

**Normal Mode:**
- Keep initialized engines alive
- Lazy-init new engines on format change
- Memory: 15-50MB depending on usage

**Resource-Saving Mode:**
- Dispose all engines on format change
- Init only the needed engine
- Memory: ~15MB max, but 200-300ms delay on format switch

---

## Implementation Order

### Week 1: State Preservation Core

1. **Add `cmd:applyParams`** handler in engines.js
2. **Remove param resets** from `playAudio()` 
3. **Update `restoreEngineIfNeeded()`** to use new flow
4. **Test:** Params survive dispose/restore cycle

### Week 2: Polish & Edge Cases

1. Fix MIDI param restoration (player created async)
2. Fix Tracker param restoration
3. Rubberband pipeline params on restore
4. Child window routing (update stageId correctly)

### Week 3: Lazy Engine Init (Optional)

1. Modularize engine initialization
2. Add `init-engine` IPC command
3. Implement lazy init on format change
4. Add "Resource-Saving Mode" toggle

---

## Resource Management Goals

| Scenario | Behavior | CPU | Memory |
|----------|----------|-----|--------|
| Playing, visible | Engine alive | Normal | Normal |
| Paused, visible | Engine alive, idle | ~0.3% | Normal |
| Paused, tray 5s | Engine disposed | **~0%** | Minimal |
| Restore from tray | Engine recreate + restore | Brief spike | Normal |
| File change (same format) | Engine stays, players swap | No change | No change |
| File change (diff format) | Lazy-init new player | Brief spike | +5-10MB |
| Resource-saving mode | Full reset + init one engine | Brief spike | **Minimal** |

---

## Testing Checklist

### State Preservation
- [ ] FFmpeg tape speed survives dispose/restore
- [ ] FFmpeg pitch/tempo/formant survives (pitchtime mode)
- [ ] MIDI transpose/BPM/metronome survives
- [ ] Tracker pitch/tempo/stereo survives
- [ ] Locked mode behavior (if kept)

### Engine Lifecycle
- [ ] 0% CPU when tray+paused after 5s
- [ ] Restore in <300ms
- [ ] File skip speed unchanged when engine alive
- [ ] Position correct after restore

### Parameter Window
- [ ] Params window shows correct values after restore
- [ ] Changing params applies immediately after restore
- [ ] No duplicate reset-to-defaults flicker

---

## Success Criteria

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | File skip latency | ✅ | Same as before (engine stays alive) |
| 2 | Tray + paused CPU | ✅ | ~0% CPU (engine disposed) |
| 3 | Tray + playing | ✅ | Audio continues, UI hidden |
| 4 | Restore time | ✅ | <300ms engine recreate |
| 5 | **State preservation** | ❌ | **Params lost - FIX IN PROGRESS** |
| 6 | No regressions | ⚠️ | Blocked by #5 |

**The refactor is not complete until #5 is fixed.**

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [IDLE_DISPOSAL_IMPLEMENTATION.md](./IDLE_DISPOSAL_IMPLEMENTATION.md) | Detailed state preservation analysis, lazy engine init design |
| [AGENTS.md](./AGENTS.md) | Mental models, debugging notes, future architecture |

---

## Notes

- **Don't write new code** - Fix existing architecture
- **Engine should be stateless** - Main process owns all state
- **Test dispose/restore cycle** - This is the core feature
- **Phase 4 must complete before Phase 5** - Lazy init depends on working state preservation
