# Tape-Style Parameters Window Refactor Plan

## Goal
Move tape-style tempo control from main window into Parameters window as the default section, with Pitch/Time controls as opt-in advanced mode. Only switch to rubberband pipeline when Pitch/Time section is actively used.

## Architecture Changes

### Pipeline Switching Logic

**Current:**
- `parametersOpen` = true → switch to rubberband (48kHz fixed)
- `parametersOpen` = false → switch to normal (48kHz or HQ)

**New:**
- Rubberband pipeline active when:
  - Parameters window open AND
  - Pitch/Time section active AND
  - (pitch ≠ 1.0 OR tempo ≠ 1.0)
- Normal pipeline otherwise (even when Parameters window open)

### State Management

**New global state:**
- `g.audioParams.mode` - 'tape' or 'pitchtime'
- `g.audioParams.tapeSpeed` - -24 to +24 semitones (coupled pitch+speed)
- `g.audioParams.pitch` - 1.0 (independent pitch ratio)
- `g.audioParams.tempo` - 1.0 (independent tempo ratio)
- `g.audioParams.formant` - false (formant preservation)

## Implementation Steps

### Phase 1: Parameters Window UI Changes
**Files:** `html/parameters.html`, `css/parameters.css`, `js/parameters/main.js`

1. **Restructure Pitch/Time Tab:**
   - Section 1: Tape-Style Speed (default, radio button checked)
     - Speed slider (-24 to +24 semitones)
     - Reset button
   - Section 2: Pitch/Time Control (opt-in, radio button unchecked)
     - Move existing pitch/tempo/formant controls here
     - Initially disabled (opacity 0.4, pointer-events none)

2. **Add exclusive radio button behavior:**
   - Only one section active at a time
   - Switching sections visually enables/disables content
   - Send IPC message to stage.js on mode change

3. **Wire up controls:**
   - Tape speed slider → send `set-tape-speed` IPC
   - Pitch/Time toggle → send `set-pitch-time-active` IPC
   - Mode radio buttons → send `set-param-mode` IPC

### Phase 2: Stage.js Pipeline Management
**File:** `js/stage.js`

1. **Add IPC handlers:**
   - `set-param-mode` - Update `g.audioParams.mode`, switch pipeline if needed
   - `set-tape-speed` - Apply tape speed to current player (FFmpeg/MOD/MIDI)
   - `set-pitch-time-active` - Switch to rubberband pipeline if not already

2. **Implement applyTapeSpeed():**
   - Convert semitones to playback rate: `2^(semitones/12)`
   - Apply to FFmpegPlayer, ChiptunePlayer, or MidiPlayer
   - Works on normal pipeline (no rubberband needed)

3. **Update switchPipeline():**
   - Switch between normal and rubberband contexts
   - Preserve playback state (time, playing/paused)
   - Reload track on new pipeline

4. **Update window close handler:**
   - When Parameters window closes, switch back to normal pipeline if on rubberband

### Phase 3: Remove Speed Control from Main Window
**Files:** `html/stage.html`, `css/main.css`, `js/stage.js`, `js/shortcuts.js`

1. **Remove UI elements:**
   - Delete `#playspeed` display element
   - Remove any speed up/down buttons

2. **Remove keyboard shortcuts:**
   - Delete `+` key binding for `speedUp()`
   - Delete `-` key binding for `speedDown()`

3. **Remove functions:**
   - Delete `setPlaybackRate()`, `speedUp()`, `speedDown()`

4. **Clean up global state:**
   - Remove `g.playspeed` reference

### Phase 4: Config Migration
**File:** `js/stage.js`

1. **Add config defaults:**
   - `audioParams.mode = 'tape'`
   - `audioParams.tapeSpeed = 0`
   - `audioParams.pitch = 1.0`
   - `audioParams.tempo = 1.0`
   - `audioParams.formant = false`

2. **Migrate old configs:**
   - Move `config.audio.playbackRate` → `config.audioParams.tapeSpeed`
   - Delete old `playbackRate` field

### Phase 5: Testing Checklist

**Tape-Style Section (Default):**
- [ ] Opens Parameters window → no pipeline switch, no audio glitch
- [ ] Tape speed slider works at 48kHz normal pipeline
- [ ] Tape speed slider works at HQ mode (96k/192k)
- [ ] Works with FFmpeg files
- [ ] Works with tracker/MOD files
- [ ] Works with MIDI files
- [ ] Reset button resets to 0 semitones

**Pitch/Time Section (Opt-in):**
- [ ] Toggle to Pitch/Time → pipeline switches to rubberband (brief disconnect expected)
- [ ] Pitch slider works independently
- [ ] Tempo slider works independently
- [ ] Formant preservation toggle works
- [ ] Reset button resets both pitch and tempo to 1.0
- [ ] Toggle back to Tape → pipeline switches back to normal

**Window Lifecycle:**
- [ ] Close Parameters window (tape mode active) → stays on normal pipeline
- [ ] Close Parameters window (pitch/time mode active) → switches to normal pipeline
- [ ] Reopen Parameters window → remembers last mode
- [ ] Track change preserves mode and values

**Main Window Cleanup:**
- [ ] Speed display removed from main UI
- [ ] `+`/`-` keyboard shortcuts removed
- [ ] No remnants of old speed control functions

**Config Persistence:**
- [ ] Mode selection persists across app restarts
- [ ] Tape speed value persists
- [ ] Pitch/Time values persist
- [ ] Old configs migrate cleanly

## Benefits

1. **Better UX:** Parameters window feels lightweight by default
2. **Better Performance:** No forced 48kHz when using tape-style
3. **Better Quality:** Tape-style benefits from HQ mode
4. **Clearer Mental Model:** Pipeline switch is explicit pedagogical moment
5. **Simpler Main Window:** Removes confusing speed control

## Key Design Decisions

- **Tape-style as default** = no pipeline disruption on window open
- **Exclusive radio buttons** = clear that only one mode can be active
- **Pipeline switch on toggle** = teaches the difference between modes
- **Remove main window speed** = eliminates confusion about when it works
