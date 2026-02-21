# State Client Usage Guide

The State Client provides a unified API for accessing and modifying application state from any renderer process.

## Quick Start

The State Client is automatically available in all windows via `window.State`:

```javascript
// Read state synchronously
const isPlaying = State.get('playback.isPlaying');
const pitch = State.get('audio.pitch');

// Subscribe to changes
const unsubscribe = State.subscribe('playback.isPlaying', (newVal, oldVal) => {
    updatePlayButton(newVal);
});

// Later: unsubscribe
unsubscribe();
```

## API Reference

### Reading State

```javascript
// Get a specific value (synchronous)
const value = State.get('audio.pitch');

// Get entire state tree (use sparingly)
const allState = State.getAll();
```

### Writing State

```javascript
// Set a value (returns Promise)
await State.set('audio.pitch', 3);

// Toggle boolean
await State.toggle('playback.loop');

// Values are validated and confirmed by main process
```

### Subscribing to Changes

```javascript
// Subscribe to specific key
State.subscribe('audio.pitch', (newValue, oldValue, key) => {
    console.log(`Pitch changed from ${oldValue} to ${newValue}`);
});

// Subscribe to namespace wildcard
State.subscribe('audio.*', (newValue, oldValue, key) => {
    console.log(`Audio changed: ${key}`);
});

// Subscribe to all changes
State.subscribe('*', (newValue, oldValue, key) => {
    console.log(`State changed: ${key}`);
});
```

### Dispatching Actions

```javascript
// Simple actions
await State.dispatch('play');
await State.dispatch('pause');
await State.dispatch('toggle');
await State.dispatch('next');
await State.dispatch('prev');

// Actions with payload
await State.dispatch('seek', { position: 120 });
```

## Migration Examples

### Before: Manual IPC (player.js)

```javascript
// State cache that needs manual syncing
g.state = {
    isPlaying: false,
    position: 0,
    file: null
};

// Listen for broadcasts
ipcRenderer.on('state:update', (e, data) => {
    if (data.isPlaying !== undefined) {
        g.state.isPlaying = data.isPlaying;
        updatePlayButton();
    }
    if (data.position !== undefined) {
        g.state.position = data.position;
        updatePosition();
    }
});

// Send intents
ipcRenderer.send('audio:play');
ipcRenderer.send('audio:seek', position);
```

### After: State Client

```javascript
// No local cache needed - StateClient holds synced proxy

// Subscribe to specific changes
State.subscribe('playback.isPlaying', (isPlaying) => {
    updatePlayButton(isPlaying);
});

State.subscribe('playback.position', (position) => {
    updatePosition(position);
});

// Read anywhere
function someFunction() {
    if (State.get('playback.isPlaying')) {
        // ...
    }
}

// Dispatch actions
await State.dispatch('play');
await State.dispatch('seek', { position: newPos });
```

### Before: Parameters Window

```javascript
// Send param changes via bridge
bridge.sendToStage('param-change', {
    mode: 'audio',
    param: 'pitch',
    value: 3
});

// Listen for updates
bridge.on('set-mode', (data) => { /* ... */ });
bridge.on('update-params', (data) => { /* ... */ });
```

### After: State Client

```javascript
// Set value directly
await State.set('audio.pitch', 3);

// Subscribe to updates
State.subscribe('audio.pitch', (pitch) => {
    updatePitchControl(pitch);
});
```

## State Namespace Reference

| Key | Type | Description |
|-----|------|-------------|
| `audio.mode` | 'tape' \| 'pitchtime' | Audio processing mode |
| `audio.tapeSpeed` | number | Tape speed in semitones (-12 to +12) |
| `audio.pitch` | number | Pitch shift in semitones |
| `audio.tempo` | number | Tempo ratio (0.5 to 2.0) |
| `audio.formant` | boolean | Formant preservation |
| `audio.locked` | boolean | Lock settings across tracks |
| `audio.volume` | number | Volume (0.0 to 1.0) |
| `playback.file` | string \| null | Current file path |
| `playback.isPlaying` | boolean | Playing state |
| `playback.position` | number | Current position in seconds |
| `playback.duration` | number | Total duration in seconds |
| `playback.loop` | boolean | Loop mode |
| `midi.transpose` | number | MIDI transpose in semitones |
| `midi.bpm` | number \| null | MIDI BPM override |
| `midi.metronome` | boolean | Metronome enabled |
| `midi.soundfont` | string \| null | Current soundfont |
| `tracker.pitch` | number | Tracker pitch ratio |
| `tracker.tempo` | number | Tracker tempo ratio |
| `tracker.stereoSeparation` | number | Stereo separation (0-100) |
| `playlist.items` | string[] | Playlist file paths |
| `playlist.index` | number | Current playlist index |
| `file.metadata` | object \| null | File metadata |
| `file.type` | 'FFmpeg' \| 'MIDI' \| 'Tracker' \| null | File type |
| `ui.monitoringSource` | string | Monitoring source |
| `system.engineAlive` | boolean | Engine window alive |
| `system.activePipeline` | 'normal' \| 'rubberband' | Active audio pipeline |

## Read-Only vs Writable

### Writable Keys (via State.set)
- `audio.mode`
- `audio.tapeSpeed`
- `audio.pitch`
- `audio.tempo`
- `audio.formant`
- `audio.locked`
- `audio.volume`
- `playback.loop`
- `ui.monitoringSource`

### Read-Only Keys (state changes trigger these updates)
- `playback.file` - Set by loading files
- `playback.isPlaying` - Set by play/pause actions
- `playback.position` - Set by playback engine
- `playback.duration` - Set by file metadata
- `playlist.*` - Managed by playlist operations
- `system.*` - Managed by system events

## Error Handling

```javascript
try {
    await State.set('audio.pitch', 3);
} catch (err) {
    console.error('Failed to set pitch:', err.message);
    // UI automatically reverts to confirmed value
}
```

## Best Practices

1. **Use specific subscriptions** instead of wildcard subscriptions when possible
2. **Don't cache state locally** - State Client already holds synced proxy
3. **Use dispatch() for complex operations** like play/pause/seek
4. **Use set() for direct value changes** like pitch/tempo
5. **Always await set()** if you need to handle errors
6. **Unsubscribe when components unmount** to prevent memory leaks
