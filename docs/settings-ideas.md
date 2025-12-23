# Settings Window - Feature Ideas

Potential settings to expose in the Settings dialog, organized by category.

## Implementation Notes

**Config Persistence:**
- All settings changes must be written to config file immediately via `g.config_obj.set(g.config)`
- Settings window sends changes to stage via IPC (`sendToStage('settings-changed', { key: value })`)
- Stage applies changes and persists to disk

**Immediate Effect:**
- Settings should take effect immediately when possible
- For settings requiring audio engine restart (sample rate, buffer size, decoder threads):
  - Store current playback position
  - Stop playback and mute/fade out
  - Destroy and recreate audio engine with new settings
  - Reload current file
  - Resume playback at stored position
  - Fade back in

**Change Throttling:**
- Apply 200ms "mute" delay to prevent rapid successive changes
- Use debounce: wait 200ms after last change before applying
- Example: User changing buffer size with arrow keys won't trigger restart on every keypress
- Show visual feedback during throttle period (e.g., "Applying changes...")

---

## Playback Behavior

### Gapless playback
Remove silence between tracks for seamless album playback. Already supported by AudioContext, just needs configuration. **Note:** This should be a toggle in the main window, not in settings.

## Audio Configuration

### Output device selection
Choose which audio interface to use via `setSinkId()` API. Critical for audio professionals with multiple interfaces (monitors, headphones, external DACs). 

**Current behavior:** Uses OS default audio device (AudioContext automatically connects to default output).

**Implementation approach:**
1. Use `navigator.mediaDevices.enumerateDevices()` to list available audio output devices
2. Display dropdown with device names
3. Apply selection via `audioContext.setSinkId(deviceId)`
4. Store selected device ID in config

**Fallback handling:**
- On startup, attempt to set stored device ID
- If `setSinkId()` fails (device unavailable/unplugged), catch the error and fall back to default
- Could show a notification: "Selected audio device not found, using system default"
- Periodically check device availability or listen to `devicechange` event
- Update settings UI to show "(unavailable)" next to missing devices

### Buffer size
AudioWorklet buffer size configuration (latency vs. stability tradeoff). Smaller buffers = lower latency but higher CPU/risk of dropouts. **Implementation:** Dropdown with fixed reasonable options (e.g., 128, 256, 512, 1024, 2048 samples).

## Module/Tracker Settings

### Stereo separation
Width control for tracker formats. Many MOD players offer 0-100% separation control. libopenmpt may expose this parameter.

### Interpolation filter
Quality setting for chiptune player (if libopenmpt supports it). Trade-off between authentic retro sound vs. clean modern rendering.

## UI/Display

### Theme selection
Dark/light theme toggle. Provides an alternative to keyboard shortcuts for users who prefer clicking.

## Advanced

### FFmpeg decoder threads
Performance tuning for multi-core systems. Allow manual thread count configuration for decode operations. **Options:** Auto (default - uses all CPU cores), 1, 2, 4, 8 threads. Lower thread counts can reduce CPU load.

### Decode ahead buffer
How many audio chunks to pre-buffer for smooth playback. **Current:** 10 chunks (~2 seconds @ 44.1kHz) on play/resume, continuous feeding every 20ms. **Implementation:** Dropdown with values: 5, 10 (default), 15, 20, 25, 30 chunks. Higher values = more resilient to CPU spikes but slightly higher memory usage. Lower values = less memory but risk of dropouts during CPU spikes. Each chunk is ~8820 samples (0.2 seconds).

---

## Priority Recommendations

**Highest Value for Target Audience:**

1. **Output device selection** - Critical for audio professionals with multiple interfaces
2. **Buffer size configuration** - Performance tuning for different systems
3. **Stereo separation for MOD files** - Standard feature in tracker players
4. **Interpolation filter for tracker formats** - Quality vs. authentic retro sound

**Quick Wins:**

- Theme selection toggle (alternative to keyboard shortcut)

**Removed Features:**

- ~~Auto-play toggle~~ - Auto-play is always on, no setting needed
- ~~Resume last position / Seek to position~~ - Seek precision not adequate; markers will handle this in future
- ~~Always scan folder~~ - Better achieved by dropping the folder directly
- ~~Always on top~~ - Not very useful in practice
- ~~Show file info toggle~~ - Would leave large empty space, always shown
