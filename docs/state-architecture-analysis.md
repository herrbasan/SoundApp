# SoundApp State Architecture Analysis

## Executive Summary

The **intent-based state architecture** described in `AGENTS.md` is fundamentally sound and functional, with the main process (`app.js`) acting as the single source of truth (`audioState`). However, a comprehensive review of the renderer scripts (`js/`) reveals significant **state fragmentation and duplication** that creates technical debt and maintenance burden.

Currently, there is **no unified get/set abstraction layer**. Instead, each child window implements its own ad-hoc caching and IPC communication patterns. While the current implementation works correctly, it requires developers to understand multiple IPC patterns when adding new windows or features.

The goal is to design a **solid get/set architecture** (a State Client) that abstracts away the IPC communication with the state machine, exposing the ground truth data to remote scripts as if it were local, synchronous state.

---

## Current Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           MAIN PROCESS (app.js)                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Ground Truth State (audioState & WindowManager)                │   │
│  │  - Playback: file, isPlaying, position, duration                │   │
│  │  - Audio: mode, tapeSpeed, pitch, tempo, formant, locked        │   │
│  │  - MIDI: transpose, bpm, metronome, soundfont                   │   │
│  │  - Tracker: pitch, tempo, stereoSeparation                      │   │
│  │  - App: playlist, metadata, fileType, engineAlive               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                            │                                            │
│          ┌─────────────────┼─────────────────┐                         │
│          ▼                 ▼                 ▼                         │
│    ┌──────────┐      ┌──────────┐      ┌──────────┐                   │
│    │broadcast │      │ sendTo   │      │ sendTo   │                   │
│    │State()   │      │Engine()  │      │Window()  │                   │
│    └────┬─────┘      └────┬─────┘      └────┬─────┘                   │
└─────────┼────────────────┼────────────────┼───────────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────┐ ┌──────────┐ ┌─────────────────┐
│   Player Window │ │  Engine  │ │  Child Windows  │
│   (player.js)   │ │(engines) │ │ (params, etc.)  │
│                 │ │          │ │                 │
│  g.state cache  │ │ Stateless│ │ Ad-hoc caches   │
│  (Duplicates    │ │ Receives │ │ (controls,      │
│   audioState)   │ │  params  │ │  config, etc.)  │
└─────────────────┘ └──────────┘ └─────────────────┘
```

---

## ✅ What's Working (Correct Implementation)

1. **Ground Truth in Main**: `app.js` successfully holds the definitive `audioState` and `WindowManager` state. It survives engine disposal.
2. **Stateless Engine**: `engines.js` correctly avoids maintaining its own state. It receives parameters (`g.currentAudioParams`, etc.) from Main via IPC commands (`cmd:setParams`, `cmd:applyParams`) and applies them directly to the audio nodes.
3. **Intent-Based Flow**: Renderers generally send intents (e.g., `audio:play`, `param-change`) rather than mutating state directly.
4. **State Restoration**: Engine disposal/restoration correctly preserves and restores state via `restoreEngineIfNeeded()`.
5. **Mixer Isolation**: `mixer/main.js` intentionally maintains its own local state (`g.currentChannels`) because it operates in a completely separate audio domain from the main player. This is a valid architectural exception.

---

## ⚠️ The Problem: State Fragmentation & Duplication

A review of the renderer scripts reveals that while the "dumb renderer" principle is generally followed, there's extensive local caching and inconsistent IPC patterns.

### 1. Player Window (`js/player.js`) - MEDIUM RISK
- **State Duplication**: Maintains a massive `g.state` object that manually mirrors almost every property of `audioState`.
- **Window State Duplication**: Maintains `g.windows` and `g.windowsClosing`, duplicating the ground truth held by `WindowManager` in `app.js`.
- **Communication**: Listens to a generic `state:update` broadcast and manually patches `g.state`.
- **Risk**: Cache could drift if updates are missed; no mechanism to force refresh.

### 2. Parameters Window (`js/parameters/main.js`) - LOW RISK
- **Ad-hoc State**: Uses a local `controls` object to track UI control state (sliders, etc.).
- **Communication**: Does not use the standard `state:update` broadcast. Instead, it relies on custom `set-mode` and `update-params` IPC events. It sends updates via `param-change`.
- **Risk**: Low - controls object is UI-only, not application state.

### 3. Settings Window (`js/settings/main.js`) - LOW RISK
- **Configuration State**: Maintains a local `config` object.
- **Communication**: Uses custom wrapper functions `getCfg()` and `setCfgValue()` which communicate with the main process via `get-config` and `update-config` IPC channels.
- **Risk**: Low - this is actually correct for UX (draft/edit mode before applying).

### 4. Monitoring Window (`js/monitoring/main.js`) - LOW RISK
- **Local State**: Tracks `this.activeSource` locally.
- **Communication**: Receives data via MessagePorts (for high-frequency VU data at 60fps) and IPC (`ana-data`).
- **Risk**: Low - `activeSource` is UI-only; high-frequency data correctly bypasses IPC.

### Summary of Inconsistencies

| Window | Local State Cache | Read Pattern | Write Pattern |
|--------|-------------------|--------------|---------------|
| **Player** | `g.state`, `g.windows` | `ipcRenderer.on('state:update')` | `ipcRenderer.send('audio:*')` |
| **Params** | `controls` object | `bridge.on('set-mode' / 'update-params')` | `ipcRenderer.send('param-change')` |
| **Settings**| `config` object | `ipcRenderer.invoke('get-config')` | `ipcRenderer.send('update-config')` |
| **Engine** | None (Stateless) | `ipcRenderer.on('cmd:*')` | `ipcRenderer.send('audio:*')` |

---

## 📋 State Inventory

### Ground Truth (app.js audioState)
| Property | Type | Namespace |
|----------|------|-----------|
| file | string | `playback.file` |
| isPlaying | boolean | `playback.isPlaying` |
| position | number | `playback.position` |
| duration | number | `playback.duration` |
| mode | 'tape' \| 'pitchtime' | `audio.mode` |
| tapeSpeed | number | `audio.tapeSpeed` |
| pitch | number | `audio.pitch` |
| tempo | number | `audio.tempo` |
| formant | boolean | `audio.formant` |
| locked | boolean | `audio.locked` |
| volume | number | `audio.volume` |
| loop | boolean | `playback.loop` |
| transpose | number | `midi.transpose` |
| bpm | number | `midi.bpm` |
| metronome | boolean | `midi.metronome` |
| soundfont | string | `midi.soundfont` |
| trackerPitch | number | `tracker.pitch` |
| trackerTempo | number | `tracker.tempo` |
| stereoSeparation | number | `tracker.stereoSeparation` |
| playlist | array | `playlist.items` |
| playlistIndex | number | `playlist.index` |
| metadata | object | `file.metadata` |
| fileType | string | `file.type` |
| monitoringSource | string | `ui.monitoringSource` |
| engineAlive | boolean | `system.engineAlive` |

---

## 🎯 Proposed Solution: The State Client Architecture

To resolve these issues, we need a **unified get/set abstraction layer** (a State Client) that runs in every renderer process. This client will abstract away the IPC communication, providing a synchronous, local-feeling API while ensuring the Main process remains the single source of truth.

### Core Principles of the State Client

1. **Synchronous Reads**: `state.get('property')` should return immediately using a synchronized local proxy of the ground truth.
2. **Asynchronous Writes**: `state.set('property', value)` should send an intent to the Main process and return a Promise that resolves when the Main process confirms the update.
3. **Reactive Subscriptions**: `state.subscribe('property', callback)` allows UI components to react to specific state changes without manually parsing generic broadcast events.
4. **Unified Namespace**: The client should handle `audioState`, `windowState`, and `configState` under a single, consistent API (see State Inventory above).

### Proposed API Design

```javascript
// js/state-client.js (Injected into renderers via window-loader.js)

const State = {
    // --- READ (Synchronous, reads from local proxy updated by Main) ---
    get(key) { ... },              // e.g., get('audio.pitch')
    getAll() { ... },               // Get entire state tree
    
    // --- WRITE (Asynchronous, sends intent to Main) ---
    async set(key, value) { ... },  // e.g., set('audio.pitch', 3)
    async toggle(key) { ... },      // e.g., toggle('playback.loop')
    
    // --- REACTIVE (Subscribe to specific changes) ---
    subscribe(key, callback) { ... },
    unsubscribe(key, callback) { ... },
    
    // --- ACTIONS (Complex intents) ---
    async dispatch(action, payload) { ... } // e.g., dispatch('play'), dispatch('seek', 120)
};
```

---

## 🔧 Refactoring Strategy

### 1. Refactoring `player.js`
- **Remove**: `g.state` and `g.windows`.
- **Replace**: `ipcRenderer.on('state:update')` with `State.subscribe()`.
- **Example**:
  ```javascript
  // Before
  ipcRenderer.on('state:update', (e, data) => {
      if (data.isPlaying !== undefined) {
          g.state.isPlaying = data.isPlaying;
          updatePlayButton();
      }
  });
  
  // After
  State.subscribe('playback.isPlaying', (isPlaying) => {
      updatePlayButton(isPlaying);
  });
  ```

### 2. Refactoring `parameters/main.js`
- **Remove**: Custom `set-mode` and `update-params` IPC listeners.
- **Replace**: Subscribe directly to the relevant audio/MIDI/tracker parameters.
- **Example**:
  ```javascript
  // Before
  bridge.sendToStage('param-change', { mode: 'audio', param: 'pitch', value: 3 });
  
  // After
  State.set('audio.pitch', 3);
  ```

### 3. Refactoring `settings/main.js`
- **Keep**: Local `config` cache and custom `getCfg()` / `setCfgValue()` for UX reasons.
- **Add**: Optional sync with State Client for values that should apply immediately.

### 4. Refactoring `app.js` (Main Process)
- **Update**: `broadcastState()` should send delta updates to the State Client proxy in all renderers, rather than custom payloads to specific windows.
- **Update**: Centralize intent handling to respond to `State.set()` requests, validate them, update `audioState` or `config`, and broadcast the delta.

---

## ⚡ Exceptions & Special Cases

Not all state should go through the State Client:

### Settings Window (Config State)
Unlike playback state, config changes in the settings window should NOT immediately apply to give users a chance to cancel. The current pattern of local buffering with `getCfg()`/`setCfgValue()` is correct for UX. The State Client can read config, but writes should remain explicit.

### High-Frequency Data (Monitoring)
VU meter data at 60fps should continue using **MessagePort** directly, not the State Client. The State Client is for application state, not streaming audio analysis data. Monitoring correctly uses:
- MessagePort for 60fps VU/streaming data
- State Client for `activeSource` (which window is being monitored)

### Mixer Window
The mixer is explicitly a separate audio domain. It correctly maintains local track state (`g.currentChannels`) and should NOT use the main State Client for track data.

---

## 🚀 Implementation Priority

| Priority | Task | Rationale |
|----------|------|-----------|
| **High** | Create `js/state-client.js` with `get/set/subscribe` API | Foundation for all other changes |
| **High** | Replace `g.state` in `player.js` | Eliminates largest state duplication |
| **Medium** | Unify parameters window to use State Client | Reduces IPC pattern complexity |
| **Low** | Migrate settings window (optional) | Current pattern is UX-correct |

---

## Conclusion

The current architecture successfully centralizes the ground truth in the Main process, but lacks a clean, unified interface for renderers. The existing implementation is **functional and correct**, but requires developers to understand multiple IPC patterns.

By implementing a **State Client abstraction layer**, we can:
- Eliminate local state duplication (`g.state`, `g.windows`)
- Standardize IPC communication across windows
- Expose the remote state machine to UI scripts as if it were local, synchronous data
- Make the codebase more robust, deterministic, and easier to extend

This is an **architectural improvement**, not a bug fix - the current system works, but a State Client would make it significantly more maintainable.
