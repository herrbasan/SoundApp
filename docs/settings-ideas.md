# Settings Window - Feature Ideas

Potential settings to expose in the Settings dialog, organized by category.

## Playback Behavior

### Auto-play on file open
Whether dropping/opening a file starts playback immediately or requires manual play button press.

### Resume last position
Remember playback position and current file on restart. Save state to config on close, restore on launch.

### Gapless playback
Remove silence between tracks for seamless album playback. Already supported by AudioContext, just needs configuration.

### Always scan folder
Auto-load all compatible files from dropped file's directory vs. single file mode. Common workflow when auditioning batches of files.

## Audio Configuration

### Output device selection
Choose which audio interface to use via `setSinkId()` API. Critical for audio professionals with multiple interfaces (monitors, headphones, external DACs).

### Master volume level
Default volume on startup. Prevents unexpected loud playback when launching app.

### Buffer size
AudioWorklet buffer size configuration (latency vs. stability tradeoff). Smaller buffers = lower latency but higher CPU/risk of dropouts.

## Module/Tracker Settings

### Stereo separation
Width control for tracker formats. Many MOD players offer 0-100% separation control. libopenmpt may expose this parameter.

### Interpolation filter
Quality setting for chiptune player (if libopenmpt supports it). Trade-off between authentic retro sound vs. clean modern rendering.

## UI/Display

### Always on top
Keep player window above other windows. Useful during production work when referencing audio while working in DAW.

### Theme selection
Dark/light theme toggle (if themes are implemented in future).

### Show file info
Toggle metadata display in main window. Some users prefer minimal UI, others want full track info.

## Advanced

### FFmpeg decoder threads
Performance tuning for multi-core systems. Allow manual thread count configuration for decode operations.

### Sample rate override
Manual selection instead of just HQ/Standard toggle. Dropdown with 44.1/48/96/192 options for precise control.

### Decode ahead buffer
How much to pre-decode for smooth playback. Larger buffer = more memory but smoother playback during CPU spikes.

---

## Priority Recommendations

**Highest Value for Target Audience:**

1. **Output device selection** - Critical for audio professionals with multiple interfaces
2. **Always scan folder** - Common workflow when auditioning files  
3. **Resume last position** - Quality of life improvement
4. **Stereo separation for MOD files** - Standard feature in tracker players

**Quick Wins:**

- Auto-play toggle (simple boolean, minimal implementation)
- Master volume default (already have volume system)
- Always on top (single window flag)
