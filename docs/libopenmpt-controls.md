# libopenmpt Controls Investigation

This document outlines the available controls in the libopenmpt library that could be exposed in SoundApp's Parameters window for tracker/MOD file playback.

## Current Implementation Status

The chiptune worklet (`libs/chiptune/chiptune3.worklet.js`) already implements several controls:

| Control | Command | API Used | Status |
|---------|---------|----------|--------|
| Pitch Factor | `setPitch` | `play.pitch_factor` ctl | ✅ Implemented |
| Tempo Factor | `setTempo` | `play.tempo_factor` ctl | ✅ Implemented |
| Stereo Separation | `setStereoSeparation` | `STEREOSEPARATION_PERCENT` render param | ✅ Implemented |
| Interpolation Filter | `setInterpolationFilter` | `INTERPOLATIONFILTER_LENGTH` render param | ✅ Implemented |
| Repeat Count | `repeatCount` | `set_repeat_count` | ✅ Implemented |
| Seek (seconds) | `setPos` | `set_position_seconds` | ✅ Implemented |
| Seek (order/row) | `setOrderRow` | `set_position_order_row` | ✅ Implemented |
| Select Subsong | `selectSubsong` | `select_subsong` | ✅ Implemented |

---

## Available Controls - No WASM Rebuild Required

These controls use APIs already available in the current WASM build.

### Render Parameters

Set via `openmpt_module_set_render_param(modulePtr, param, value)`:

| Parameter | Constant | Range | Default | Description |
|-----------|----------|-------|---------|-------------|
| **Master Gain** | `MASTERGAIN_MILLIBEL` (1) | unlimited | 0 | Relative gain in milliBel. +600 = 2x volume, -600 = 0.5x |
| **Stereo Separation** | `STEREOSEPARATION_PERCENT` (2) | 0-200 | 100 | 0 = mono, 100 = normal, 200 = wide stereo |
| **Interpolation Filter** | `INTERPOLATIONFILTER_LENGTH` (3) | 0,1,2,4,8 | 0 | 0=auto, 1=none, 2=linear, 4=cubic, 8=sinc |
| **Volume Ramping** | `VOLUMERAMPING_STRENGTH` (4) | -1 to 10 | -1 | -1=auto, 0=off (may click), higher=softer |

### CTL Settings

Set via `openmpt_module_ctl_set(modulePtr, key, value)`:

| Key | Type | Values | Description |
|-----|------|--------|-------------|
| `play.tempo_factor` | float | 0.0-4.0 | 1.0 = normal speed |
| `play.pitch_factor` | float | 0.0-4.0 | 1.0 = normal pitch. `pow(2, semitones/12)` for pitch shift |
| `render.resampler.emulate_amiga` | bool | 0/1 | Enable Paula chip emulation for Amiga modules |
| `render.resampler.emulate_amiga_type` | string | `auto`, `a500`, `a1200`, `unfiltered` | Amiga filter type |
| `render.opl.volume_factor` | float | 0.0+ | Volume for OPL/FM synthesis (AdLib formats) |
| `dither` | int | 0-3 | Dithering for 16-bit output (0=off, 1=auto, 2=rect, 3=shaped) |
| `play.at_end` | string | `fadeout`, `continue`, `stop` | Behavior when song ends |

### Playback Position

| Function | Description |
|----------|-------------|
| `set_position_seconds(seconds)` | Seek to time position |
| `set_position_order_row(order, row)` | Seek to pattern position |
| `select_subsong(index)` | Switch subsong (-1 = play all consecutively) |

### Module Information (Read-Only)

Already retrieved by `getMeta()` and `getSong()`:

- Duration, title, artist, tracker, message
- Number of channels, instruments, samples, patterns, orders, subsongs
- Channel names, instrument names, sample names
- Pattern data (notes, effects, volumes per channel per row)
- Current position: order, pattern, row
- Current tempo, speed, estimated BPM
- Per-channel VU levels (commented out but available)

---

## Advanced Controls - Requires WASM Rebuild

The `libopenmpt_ext` API provides interactive control but requires rebuilding the WASM with additional exports.

### Interactive Interface (`openmpt_module_ext_interface_interactive`)

| Function | Parameters | Description |
|----------|------------|-------------|
| `set_channel_mute_status` | channel, mute | Mute/unmute individual channels |
| `get_channel_mute_status` | channel | Get mute state |
| `set_channel_volume` | channel, volume (0.0-1.0) | Per-channel volume |
| `get_channel_volume` | channel | Get channel volume |
| `set_instrument_mute_status` | instrument, mute | Mute specific instruments/samples |
| `get_instrument_mute_status` | instrument | Get instrument mute state |
| `set_global_volume` | volume (0.0-1.0) | Module global volume |
| `get_global_volume` | - | Get global volume |
| `set_tempo_factor` | factor (0.0-4.0) | Alternative to ctl method |
| `set_pitch_factor` | factor (0.0-4.0) | Alternative to ctl method |
| `set_current_speed` | ticks (1-65535) | Ticks per row |
| `set_current_tempo` | bpm (32-512) | Beats per minute |
| `play_note` | instrument, note, volume, panning | Manually trigger a note |
| `stop_note` | channel | Stop note on channel |

### Interactive Interface 2 (`openmpt_module_ext_interface_interactive2`)

| Function | Parameters | Description |
|----------|------------|-------------|
| `set_channel_panning` | channel, panning (-1.0 to 1.0) | Per-channel panning |
| `get_channel_panning` | channel | Get channel pan position |
| `set_note_finetune` | channel, finetune (-1.0 to 1.0) | Fine pitch adjustment |
| `get_note_finetune` | channel | Get finetune value |
| `note_off` | channel | Send key-off (release envelope) |
| `note_fade` | channel | Fade out using instrument fadeout |

### Pattern Visualization (`openmpt_module_ext_interface_pattern_vis`)

| Function | Description |
|----------|-------------|
| `get_pattern_row_channel_volume_effect_type` | Categorize effect types for highlighting |

Effect types: `UNKNOWN`, `GENERAL`, `GLOBAL`, `VOLUME`, `PANNING`, `PITCH`

---

## Recommended Implementation Phases

### Phase 1: Easy Wins (Current WASM)

Add to Parameters window tracker mode:

1. **Stereo Separation** - Slider 0-200%, default 100
2. **Interpolation Filter** - Dropdown: Auto / None / Linear / Cubic / 8-tap Sinc
3. **Master Gain** - Slider in dB (-12 to +12)
4. **Amiga Mode** - Toggle + type selector (A500/A1200/Unfiltered)
5. **Volume Ramping** - Slider 0-10 (or Auto toggle)

Implementation:
- Add commands to worklet (some already exist)
- Wire up UI in `js/parameters/main.js`
- Store settings in config for persistence

### Phase 2: Navigation & Info

6. **Order/Pattern Jump** - Navigation controls
7. **Subsong Selector** - For multi-song modules
8. **Module Info Display** - Show metadata, channel count, etc.
9. **VU Meters** - Per-channel activity visualization (already has API, commented out)

### Phase 3: Channel Mixer (Requires WASM Rebuild)

10. **Channel Mute/Solo** - Toggle buttons per channel
11. **Channel Volume** - Per-channel faders
12. **Channel Pan** - Per-channel pan controls
13. **Instrument Mute** - Hide specific instruments

This requires:
- Rebuilding libopenmpt WASM with `libopenmpt_ext` exports
- Using `openmpt_module_ext_create_from_memory` instead of `openmpt_module_create_from_memory`
- Getting the interactive interface via `openmpt_module_ext_get_interface`

---

## WASM Rebuild Considerations

The current build system is in `libs/chiptune/docker/`. To add ext support:

1. Modify the Emscripten build to export additional functions:
   - `_openmpt_module_ext_create_from_memory`
   - `_openmpt_module_ext_destroy`
   - `_openmpt_module_ext_get_interface`
   - `_openmpt_module_ext_get_module`

2. The ext interface uses function pointer structs, which is complex in WASM. May need wrapper functions.

3. Alternative: Some ctl-based workarounds might exist for basic muting (research needed).

---

## UI Considerations for Parameters Window

### Tracker Mode Layout Options

**Option A: Compact Controls**
```
┌─────────────────────────────────────┐
│ Tempo    [====|====]  +0%           │
│ Pitch    [====|====]  +0 st         │
│ Stereo   [========|]  100%          │
│ Gain     [====|====]  0 dB          │
├─────────────────────────────────────┤
│ Filter: [Cubic ▼]  Amiga: [Off ▼]   │
│ Ramping: [Auto ▼]                   │
└─────────────────────────────────────┘
```

**Option B: With Channel Mixer (Phase 3)**
```
┌─────────────────────────────────────┐
│ [Tempo/Pitch controls as above]     │
├─────────────────────────────────────┤
│ Channels:                           │
│ 1 [M][S] ═══|═══  [|]               │
│ 2 [M][S] ═══|═══  [|]               │
│ 3 [M][S] ═══════  [|===]            │
│ 4 [M][S] ═══════  [===|]            │
│    Mute Solo Vol   Pan              │
└─────────────────────────────────────┘
```

---

## References

- [libopenmpt C API Documentation](https://lib.openmpt.org/doc/group__libopenmpt__c.html)
- [libopenmpt_ext C API Documentation](https://lib.openmpt.org/doc/group__libopenmpt__ext__c.html)
- [Render Parameters](https://lib.openmpt.org/doc/group__openmpt__module__render__param.html)
- [Interactive Interface](https://lib.openmpt.org/doc/structopenmpt__module__ext__interface__interactive.html)
