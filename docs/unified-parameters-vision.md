# Unified Parameters Window - Vision

## Overview

SoundApp will have a single **Parameters Window** that adapts its controls based on the currently playing file type. This window is always passive - playback control remains in the main window, while the parameters window only exposes file-type-specific playback parameters.

## Quick Reference

### New Files
```
html/parameters.html          # Unified parameters window
css/parameters.css            # Consolidated styles from midi.css + pitchtime.css
js/parameters/main.js         # Window UI logic (container switching, IPC)
```

### Modified Files
```
js/stage.js                   # Add g.rubberbandPlayer, pipeline switching logic
```

### Files to Eventually Remove
```
html/pitchtime.html           # Replaced by parameters.html
css/pitchtime.css             # Merged into parameters.css
js/pitchtime/                 # Functionality moved to stage.js + parameters/
html/midi.html                # Replaced by parameters.html (Phase 4)
js/midi-settings/             # Merged into parameters/ (Phase 4)
```

### State in stage.js
```javascript
g.ffmpegPlayer        // Normal pipeline (variable rate, HQ mode)
g.rubberbandPlayer    // Rubberband pipeline (48kHz fixed) + rubberband worklet
g.rubberbandContext   // Separate 48kHz AudioContext for rubberband
midi                  // MIDI player (unchanged)
player                // Tracker player (unchanged)
g.activePipeline      // 'normal' | 'rubberband' | 'midi' | 'tracker'
g.parametersOpen      // boolean - is parameters window visible
```

## Vision

### The Problem

Currently, the pitch/time functionality operates as a completely separate player with its own transport controls. This creates UX inconsistency:
- MIDI controls work as a parameters window (no transport controls)
- Pitch/Time controls work as a separate player instance (has transport controls)

Additionally, the rubberband pipeline is locked to 48kHz sample rate while the main player supports variable sample rates up to 192kHz. Attempts to resample or integrate rubberband into the variable-rate pipeline have failed.

### The Solution

**One unified pattern across all file types:**
- Main window = always controls playback (play/pause/seek/next/prev/loop)
- Parameters window = shows relevant controls for the current file's processing

The main player intelligently switches audio pipelines when needed:
- **Normal playback**: FFmpeg streaming with variable sample rate (HQ mode support)
- **With pitch/time processing**: Rubberband pipeline at fixed 48kHz

## User Experience

### Opening the Parameters Window

**Keyboard shortcut:** `P` (or existing MIDI shortcut for MIDI files)

**Behavior:**
- Window opens/shows and displays controls appropriate for the currently playing file
- Main window pauses current playback (if needed) and initializes appropriate pipeline
- Main window transport controls remain active and control playback
- Parameters window only shows sliders/controls - no play/pause/seek

### File Type Adaptations

**Audio Files (MP3, FLAC, WAV, etc.):**
- Shows: Pitch slider (-12 to +12 semitones)
- Shows: Tempo slider (0.5x to 1.5x speed)
- Main window switches to 48kHz rubberband pipeline

**MIDI Files (.mid, .midi):**
- Shows: Transpose slider
- Shows: BPM/Speed control
- Shows: Metronome toggle
- Main window uses MIDI player (already implemented this way)

**Tracker Files (.mod, .xm, .it, etc.):**
- Shows: Future tracker-specific controls (TBD)
- Main window uses libopenmpt player

### Closing the Parameters Window

- Window hides (doesn't destroy - reusable like other windows)
- For audio files: main window switches back to normal FFmpeg pipeline
- Playback can continue with saved position or restart depending on pipeline switch requirements
- All ephemeral settings reset (pitch/tempo back to normal)

## Architecture Pattern

This follows the **MIDI window pattern** established in SoundApp:

### Main Window Responsibilities
- Audio pipeline management (switching between normal/rubberband)
- Playback state (playing/paused/seeking)
- Transport controls
- Window lifecycle management
- Broadcasting parameter changes to audio pipeline

### Parameters Window Responsibilities
- Display appropriate controls for file type
- Send parameter value changes back to main window via IPC
- React to external state changes (theme, file changes)
- UI updates only (no audio processing)

## Pipeline Switching

### Core Principle: Seamless & Stable

Pipeline switching must be rock-solid and transparent to the user. The system intelligently routes audio based on:
- Whether parameters window is open
- What file type is currently playing

### Dual-Pipeline Architecture

**Both pipelines exist simultaneously:**
- **Normal Pipeline**: FFmpeg player with variable sample rate (respects HQ mode)
- **Rubberband Pipeline**: FFmpeg → Rubberband → Output at fixed 48kHz

Only one pipeline is active at a time. Switching is instant - just route to the active pipeline and disconnect the other.

**Benefits:**
- No creation/destruction overhead during rapid track changes
- Settings can be applied to inactive pipeline without disruption
- Eliminates memory leak risks from rapid pipeline cycling
- Instant switching - just routing change, no initialization delay

**Memory footprint:**
- Both audio contexts exist (~minimal overhead)
- Only active pipeline has loaded audio file
- Inactive pipeline sits idle (no processing cost)

### Dynamic Switching During Playback

**Parameters window is open:**
- Audio file plays → Use rubberband pipeline (48kHz fixed)
- MIDI file plays → Use MIDI player, show MIDI controls in parameters window
- Tracker file plays → Use libopenmpt player, show tracker controls in parameters window
- Next audio file → Switch back to rubberband pipeline automatically

**Parameters window is closed:**
- All files use their normal playback engines (FFmpeg, MIDI, libopenmpt)
- No rubberband processing

### Switching Flow

**Opening parameters window (audio file playing):**
1. Save current playback position from normal pipeline
2. Fade out and pause normal pipeline
3. Load current file into rubberband pipeline (already initialized)
4. Seek to saved position
5. Connect rubberband pipeline to output
6. Resume playback (if it was playing)

**Track changes while parameters window is open:**
1. Detect new file type

### Stability
- Settings changes never break active pipeline
- Pipeline switching is deterministic and predictable
- Each file type always uses its optimal playback engine
2. If audio file:
   - Stay on rubberband pipeline
   - Load new file and apply current pitch/tempo settings
3. If MIDI/tracker file:
   - Switch to appropriate native player
   - Update parameters window UI to show relevant controls
   - Next audio file will switch back to rubberband

**Closing parameters window:**
1. Save current position from active pipeline
2. If on rubberband: dispose rubberband pipeline
3. Switch to normal pipeline for current file type
4. Load file with user's actual settings (HQ mode, etc.)
5. Seek to saved position
6. Reset all pitch/tempo to neutral
7. Resume playback (if it was playing)

### Settings Isolation

**Critical requirement:** Settings changes must never disrupt active playback.

**With dual-pipeline architecture, this becomes simple:**

**HQ Mode / Sample Rate Changes:**
- User changes setting in config
- If normal pipeline is active: recreate normal pipeline context, reload file
- If rubberband pipeline is active: recreate normal pipeline context in background (idle)
- No disruption to active playback
- Setting is ready when user switches back to normal pipeline

**FFmpeg Settings (buffer size, threads):**
- Changes stored to config
- If normal pipeline is active: recreate FFmpeg player with new settings, reload file
- If rubberband pipeline is active: recreate normal pipeline FFmpeg player in background
- Active playback unaffected

**Audio Output Device:**
- Apply setSinkId to both pipeline contexts immediately
- User hears change on currently active pipeline
- Other pipeline picks up setting automatically

**Pitch/Tempo Parameters:**
- Only affect rubberband pipeline
- When rubberband is active: apply immediately
- When normal is active: staged and ready for next rubberband activation

**UI Settings (theme, controls visibility):**
- Always applied immediately (no pipeline dependency)

## Benefits

### Consistency
- All file types follow the same UX pattern
- User learns one mental model for parameters vs playback

### Simplicity
- Main window is always the source of truth for playback state
- No confusion about which window controls what

### Flexibility
- Easy to add new file types with custom parameters
- Parameters window can grow to show format-specific controls without affecting playback logic

### Performance
- Pipeline switching happens only when needed
- Normal playback gets full HQ mode support (up to 192kHz)
- Rubberband processing isolated to when pitch/time is actually needed

### Stability
- Settings changes never break active pipeline
- Pipeline switching is deterministic and predictable
- Each file type always uses its optimal playback engine

## Implementation Priorities

### Phase 1: Dual-Pipeline Setup
1. Initialize both pipelines at startup
2. Create routing logic (only one connected to output at a time)
3. State management (track which pipeline is active)
4. File loading into appropriate pipeline

### Phase 2: Switching Logic
1. Seamless transitions with fade in/out
2. Position preservation across switches
3. Track changes while parameters window is open
4. Settings updates to inactive pipeline

### Phase 3: Integration & Polish
1. Parameters window unified UI (audio/MIDI/tracker controls)
2. Keyboard shortcuts remain consistent
3. Visual indicators in main window when rubberband is active

### Phase 4: Testing
1. Rapid track changes (audio → MIDI → audio)
2. Settings changes during rubberband playback
3. Window open/close cycles
4. Memory stability (both pipelines coexisting)

## Gotchas & Critical Considerations

### Two Audio Contexts
**Issue:** Rubberband pipeline needs its own 48kHz AudioContext, separate from the main variable-rate context.

**Gotchas:**
- Only ONE context can be connected to output at a time (both playing = doubled audio or fighting)
- `setSinkId()` must be called on BOTH contexts when output device changes
- Browser may suspend inactive contexts - must resume before switching
- Context state (`running`, `suspended`) must be tracked for both

### MIDI and Tracker Players Share Main Context
**Issue:** The MIDI player and tracker player (libopenmpt) are initialized with `g.audioContext`. They cannot work with the 48kHz rubberband context.

**Gotchas:**
- When parameters window is open and file changes to MIDI/tracker, rubberband pipeline deactivates but MIDI/tracker use the main context
- Must NOT try to route MIDI/tracker through rubberband pipeline
- When switching audio→MIDI→audio, rubberband context may need to be resumed if browser suspended it

### FFmpeg Player Per-Context
**Issue:** `FFmpegStreamPlayerSAB` is tightly bound to one AudioContext (worklet registered there).

**Gotchas:**
- Need TWO `FFmpegStreamPlayerSAB` instances - one for each context
- Both must be initialized at startup
- Only one loads/plays at a time
- `reuseWorkletNode = true` applies to each instance independently
- File must be loaded into the correct player when switching pipelines

### Position Synchronization
**Issue:** When switching pipelines, we save position from one player and seek to it in another.

**Gotchas:**
- Different sample rates may cause slight position drift
- Seeking is async - must wait for seek completion before resuming playback
- If file duration differs between players (shouldn't, but check), clamp position
- Loop state must transfer: if looping and near end, position might wrap around during switch

### Audio Routing
**Issue:** Only one pipeline can be connected to speakers at a time.

**Gotchas:**
- Order matters: disconnect old BEFORE connecting new (avoid doubled audio)
- Use fades to avoid clicks (current pattern: 12ms out, 15ms in)
- Both pipelines have gain nodes - ensure volumes match after switch
- Master volume setting must apply to both pipelines

### Settings During Rubberband Active
**Issue:** User can change HQ mode, buffer size, threads while rubberband is playing.

**Gotchas:**
- Changes must NOT recreate rubberband context (breaks playback)
- Changes must queue for normal context (recreate it in background)
- If recreating normal context while rubberband plays, must not lose the normal FFmpegPlayer's init state
- Output device changes: apply to BOTH contexts immediately

### Parameters Window State
**Issue:** Parameters window can show different controls (audio/MIDI/tracker).

**Gotchas:**
- When file changes, must update parameters window UI dynamically
- Pitch/tempo sliders only relevant for audio - hide/disable for MIDI/tracker
- MIDI transpose/BPM only relevant for MIDI - hide for others
- Window must receive IPC about current file type when track changes
- Previous parameter values should reset when file type changes

### Startup Race Conditions
**Issue:** Both pipelines initialize at startup.

**Gotchas:**
- First file load must wait for both pipelines to be ready
- Rubberband worklet module must be loaded even if not immediately used
- If parameters window is open at app start (window position restored), must use rubberband pipeline immediately

### Memory Management
**Issue:** Two full audio pipelines exist simultaneously.

**Gotchas:**
- Both FFmpegPlayer instances keep SABs allocated even when idle
- Rubberband worklet stays loaded even when normal pipeline active
- No automatic cleanup - both exist for app lifetime
- If memory is concern, could lazy-init rubberband on first parameters window open (adds delay)

### Click-Free Transitions
**Issue:** Current player has sophisticated fade logic for click-free audio.

**Gotchas:**
- Pipeline switch needs the SAME fade treatment as seek/pause
- Fade out on old pipeline, load new, fade in on new pipeline
- Both pipelines must have consistent fade timing (12ms out, 15ms in)
- If switching during fade, must handle interrupted fade state

## Edge Cases to Handle

**Handled inherently by dual-pipeline design:**
- User changes tracks rapidly while parameters window is open → No pipeline recreation, just file loading
- Settings changes while rubberband active → Apply to inactive normal pipeline
- Parameters window closed mid-playback → Instant switch, position preserved
- File load failures → Only affects inactive pipeline if loading in background

**Still need explicit handling:**
- Audio context suspend/resume (system audio changes) → Both contexts must handle
- Seeking during exact moment of pipeline switch → Queue seek for newly active pipeline
- Loop playback edge (end of file during switch) → Ensure loop state transfers
- Initial file load (which pipeline to use?) → Detect if parameters window is open
- Output device changes → Apply to both contexts
- Parameters window opened with no file loaded → Show appropriate empty state

## Implementation Phases

### Phase 1: Parameters Window UI
Create the passive UI window with container switching.

**Tasks:**
1. Create `html/parameters.html` with NUI chrome
2. Add three containers: `#audio-controls`, `#midi-controls`, `#tracker-controls`
3. Create `css/parameters.css` consolidating styles from midi.css + pitchtime.css
4. Create `js/parameters/main.js` with:
   - Container switching based on IPC `set-mode` message
   - Slider value changes send IPC back to stage
   - Theme handling, window show/hide
5. Wire up in stage.js: `g.windows.parameters`, keyboard shortcut `P`

**Test:** Window opens, shows correct container based on mock file type, sliders send IPC.

### Phase 2: Rubberband Pipeline in Stage
Add second FFmpeg player with rubberband processing.

**Tasks:**
1. Create `g.rubberbandContext` (48kHz AudioContext)
2. Create `g.rubberbandPlayer` (FFmpegStreamPlayerSAB on rubberband context)
3. Load rubberband worklet, route: FFmpegPlayer → RubberbandWorklet → destination
4. Add `g.activePipeline` state tracking
5. Implement `switchToRubberband()` and `switchToNormal()` functions

**Test:** Can manually switch pipelines, audio plays through both.

### Phase 3: Pipeline Switching Integration
Wire parameters window to pipeline switching.

**Tasks:**
1. Parameters window open (audio file) → call `switchToRubberband()`
2. Parameters window close → call `switchToNormal()`
3. Track change while open → detect type, switch if needed
4. IPC from parameters window → apply pitch/tempo to rubberband worklet
5. Position preservation across switches

**Test:** Full flow works - open parameters, adjust pitch, close, position preserved.

### Phase 4: MIDI Controls Migration
Move MIDI controls into unified parameters window.

**Tasks:**
1. Add MIDI controls to `#midi-controls` container
2. IPC for transpose/BPM/metronome → apply to midi player
3. Remove or deprecate standalone `html/midi.html`
4. Update keyboard shortcut to use unified window

**Test:** MIDI files show transpose controls in parameters window.

### Phase 5: Cleanup
Remove legacy code.

**Tasks:**
1. Remove `html/pitchtime.html`, `css/pitchtime.css`, `js/pitchtime/`
2. Remove `html/midi.html`, `js/midi-settings/` (if fully migrated)
3. Update documentation
4. Clean up any dead code in stage.js

## Future Extensions

- Quick presets for common pitch/tempo combinations
- Per-file-type parameter memory (optional)
- Visual feedback in main window when parameters are active
- Integration with future features (markers, quick compare mode)
- Tracker-specific controls (when we know what they should be)
