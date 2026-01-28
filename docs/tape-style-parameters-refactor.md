# Tape-Style Parameters Window Refactor Plan

## Goal
Move tape-style tempo control from main window into Parameters window as the default section, with Pitch/Time controls as opt-in advanced mode. Only switch to rubberband pipeline when Pitch/Time section is actively used.

## Key Design Decisions (Clarified)

### Architecture
- **Dual-pipeline architecture:** Both Normal and Rubberband pipelines exist simultaneously from startup. Switching is instant routing change, no creation/destruction.
- **Don't touch rubberband pipeline:** The rubberband code is finicky. This refactor only adds tape-speed and restructures UI — no rubberband modifications.
- **MIDI is separate:** MIDI controls in Parameters window are completely independent. Tape-speed does not apply to MIDI playback.

### UX Philosophy
- **No labels on radio buttons:** Good UX patterns don't need labels. A grayed-out section with a visible radio button next to an active section with a checked radio button is self-explanatory.
- **Disabled section behavior:** `opacity: 0.4` and `pointer-events: none` for everything EXCEPT the radio button (which remains clickable to enable the section).

### Value Carry-Over Between Modes
- **Tape → Pitch/Time:** Tape semitones map to Pitch slider only (Tempo stays at 100%)
- **Pitch/Time → Tape:** Pitch semitones map to Tape speed (Tempo value is discarded)
- **Range limitation:** Both use ±12 semitones to allow seamless carry-over

### Lock Settings Behavior
- **Scope:** Locks BOTH values AND active mode selection
- **Location:** Moved to its own small section that applies globally to both Tape and Pitch/Time modes

## Visual Structure (Audio Controls)

```
┌─────────────────────────────────────────────┐
│ ◉ Tape Speed                                │  ← Section 1 (default active)
│     Speed slider (-12 to +12 semitones)     │
│     [Reset]                                 │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ○ Pitch/Time                                │  ← Section 2 (dimmed by default)
│     Pitch Shift slider                      │
│     Time Stretch slider                     │
│     ☐ Preserve Formants                     │
│     [Reset]                                 │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ☐ Lock Settings                             │  ← Section 3 (applies to both)
└─────────────────────────────────────────────┘
```

## Architecture Changes

### Pipeline Switching Logic

**Current:**
- `parametersOpen` = true → switch to rubberband (48kHz fixed)
- `parametersOpen` = false → switch to normal (48kHz or HQ)

**New:**
- Rubberband pipeline active when:
  - Parameters window open AND
  - Pitch/Time section active
- Normal pipeline otherwise (even when Parameters window open with Tape mode)

### State Management

**New global state:**
- `g.audioParams.mode` - 'tape' or 'pitchtime'
- `g.audioParams.tapeSpeed` - -12 to +12 semitones (coupled pitch+speed)
- `g.audioParams.pitch` - 0 (independent pitch in semitones, for display)
- `g.audioParams.tempo` - 1.0 (independent tempo ratio)
- `g.audioParams.formant` - false (formant preservation)
- `g.audioParams.locked` - false (lock settings across track changes)

## Implementation Steps

### Phase 1: Parameters Window UI Changes
**Files:** `html/parameters.html`, `css/parameters.css`, `js/parameters/main.js`

1. **Restructure Audio Controls (`#audio-controls`):**
   - Section 1: Tape Speed (like SoundFont section in MIDI tab)
     - Radio button (no label, checked by default)
     - Speed slider (-12 to +12 semitones)
     - Reset button
   - Section 2: Pitch/Time Control
     - Radio button (no label, unchecked by default)
     - Move existing pitch/tempo/formant controls here
     - Initially disabled (opacity 0.4, pointer-events none except radio)
     - Reset button (existing)
   - Section 3: Lock Settings (standalone, applies globally)
     - Move Lock Settings checkbox here from Section 2

2. **Add exclusive radio button behavior:**
   - Only one section active at a time
   - Switching sections: disabled section gets `opacity: 0.4`, `pointer-events: none` (except radio button)
   - Send IPC message to stage.js on mode change
   - Carry-over values: tape semitones ↔ pitch semitones

3. **Wire up controls:**
   - Tape speed slider → send `param-change` with `param: 'tapeSpeed'`
   - Mode radio buttons → send `param-change` with `param: 'mode'`
   - Handle pipeline switch in stage.js based on mode

### Phase 2: Stage.js Pipeline Management
**File:** `js/stage.js`

1. **Update IPC handlers for `param-change`:**
   - `param: 'mode'` - Update `g.audioParams.mode`, switch pipeline if needed (tape → normal, pitchtime → rubberband)
   - `param: 'tapeSpeed'` - Apply tape speed to current player (FFmpeg/MOD)
   - Existing pitch/tempo/formant handlers continue to work for rubberband

2. **Implement tape speed application:**
   - Convert semitones to playback rate: `2^(semitones/12)`
   - Apply to FFmpegPlayer or ChiptunePlayer
   - Works on normal pipeline (no rubberband needed)

3. **Pipeline switching on mode change:**
   - Tape mode: ensure normal pipeline is active
   - Pitch/Time mode: switch to rubberband pipeline
   - Both pipelines already exist (dual-pipeline architecture), just route between them

4. **Lock Settings handling:**
   - When `locked: true`, preserve mode + values on track change
   - When `locked: false`, reset to tape mode with 0 semitones on track change

### Phase 3: Remove Speed Control from Main Window
**Files:** `html/stage.html`, `css/main.css`, `js/stage.js`, `js/shortcuts.js`

1. **Remove UI elements:**
   - Delete `#playspeed` display element (if exists)
   - Remove any speed up/down buttons

2. **Remove keyboard shortcuts:**
   - Delete `+` key binding for `speedUp()`
   - Delete `-` key binding for `speedDown()`

3. **Remove functions:**
   - Delete `setPlaybackRate()`, `speedUp()`, `speedDown()`

4. **Clean up global state:**
   - Remove `g.playspeed` reference

### Phase 4: Config & State Management
**File:** `js/stage.js`, `js/config-defaults.js`

1. **Add config defaults:**
   - `audioParams.mode = 'tape'`
   - `audioParams.tapeSpeed = 0`
   - `audioParams.pitch = 0` (semitones, not ratio)
   - `audioParams.tempo = 1.0`
   - `audioParams.formant = false`
   - `audioParams.locked = false`

2. **No migration needed:**
   - Old `playbackRate` was ephemeral (not persisted)
   - New structure starts fresh

### Phase 5: Testing Checklist

**Tape-Style Section (Default):**
- [ ] Opens Parameters window → no pipeline switch, no audio glitch
- [ ] Tape speed slider works at 48kHz normal pipeline
- [ ] Tape speed slider works at HQ mode (96k/192k)
- [ ] Works with FFmpeg files
- [ ] Works with tracker/MOD files
- [ ] Does NOT apply to MIDI files (MIDI has its own controls)
- [ ] Reset button resets to 0 semitones

**Pitch/Time Section (Opt-in):**
- [ ] Toggle to Pitch/Time → pipeline switches to rubberband (brief disconnect expected)
- [ ] Pitch slider works independently
- [ ] Tempo slider works independently
- [ ] Formant preservation toggle works
- [ ] Reset button resets both pitch and tempo to defaults
- [ ] Toggle back to Tape → pipeline switches back to normal

**Value Carry-Over:**
- [ ] Tape at +5 → switch to Pitch/Time → Pitch shows +5, Tempo shows 100%
- [ ] Pitch/Time at -3 pitch, 80% tempo → switch to Tape → Tape shows -3

**Lock Settings:**
- [ ] Lock Settings checkbox is in its own section
- [ ] When locked: track change preserves mode AND values
- [ ] When unlocked: track change resets to Tape mode at 0 semitones

**Window Lifecycle:**
- [ ] Close Parameters window (tape mode active) → stays on normal pipeline
- [ ] Close Parameters window (pitch/time mode active) → switches to normal pipeline
- [ ] Reopen Parameters window → remembers last mode and values

**Main Window Cleanup:**
- [ ] Speed display removed from main UI (if existed)
- [ ] `+`/`-` keyboard shortcuts removed
- [ ] No remnants of old speed control functions

## Benefits

1. **Better UX:** Parameters window feels lightweight by default (no pipeline switch on open)
2. **Better Performance:** No forced 48kHz when using tape-style
3. **Better Quality:** Tape-style benefits from HQ mode (96k/192k)
4. **Clearer Mental Model:** Pipeline switch is explicit when choosing Pitch/Time mode
5. **Simpler Main Window:** Removes confusing speed control from main window
6. **Self-Explanatory UI:** Radio buttons without labels follow the "good UX needs no labels" principle
