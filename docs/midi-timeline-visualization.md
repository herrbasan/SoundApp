# MIDI Timeline Visualization - Implementation Plan

## Overview

Replace the blank waveform canvas with a MIDI channel activity visualization when playing MIDI files. The visualization shows all 16 MIDI channels as horizontal lanes with activity bars representing note events.

## Current Architecture

### Existing Components
- `js/monitoring/midi_analyzer.js` - **Already exists!** Parses MIDI file and extracts channel activity segments with gap detection
- `js/monitoring/visualizers.js` - Canvas rendering, includes `drawWaveform()` method
- `js/monitoring/main.js` - IPC handlers, receives `file-change` and `waveform-data` events
- `js/stage.js` - Sends `file-change` with `isMIDI: true`, triggers `extractAndSendWaveform()`

### Data Flow (Current)
```
stage.js (playAudio)
  ├─► file-change IPC → monitoring/main.js → clears waveform for MIDI
  └─► extractAndSendWaveform() → returns early for MIDI (no waveform data)
```

### Gap in Current Implementation
- `midi_analyzer.js` exists but is never called
- MIDI files show "no waveform" message instead of channel activity
- No IPC channel for MIDI timeline data

---

## Implementation Phases

### Phase 1: Data Pipeline (stage.js → monitoring)

**Files Modified:** `js/stage.js`

1. After loading MIDI file in `playAudio()`, parse MIDI buffer for channel activity
2. Send `midi-timeline` IPC with parsed data to monitoring window

**Implementation:**
```javascript
// In playAudio(), after midi.load() succeeds and we have duration:
if (isMIDI && g.windows.monitoring) {
    // Fetch MIDI buffer and parse channel activity
    const resp = await fetch(tools.getFileURL(fp));
    const buffer = await resp.arrayBuffer();
    const { parseMidiChannelActivity } = require('./monitoring/midi_analyzer.js');
    const activity = parseMidiChannelActivity(buffer, 4000); // 4s gap threshold
    
    tools.sendToId(g.windows.monitoring, 'midi-timeline', {
        channels: activity.channels,
        duration: activity.duration || midi.getDuration(),
        filePath: path.basename(fp)
    });
}
```

**Alternative:** Parse in monitoring window (simpler - avoids cross-context module loading):
- Stage sends MIDI file path/URL to monitoring
- Monitoring fetches and parses locally using existing `midi_analyzer.js`

---

### Phase 2: Visualizers - MIDI Timeline Rendering

**Files Modified:** `js/monitoring/visualizers.js`

1. Add `midiActivity` property to store channel data
2. Add `setMidiActivity(data)` method (parallel to `setWaveformData()`)
3. Add `drawMidiTimeline()` method for rendering
4. Modify `drawWaveform()` to call `drawMidiTimeline()` when `midiActivity` is set

**Visualization Design:**
```
┌─────────────────────────────────────────────────────────────┐
│ Ch 1  ████████░░░░░░░░░░░████████████░░░░░░░░░████░░░░░░░░░ │
│ Ch 2  ░░░░░░████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ Ch 3  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ ...                                                          │
│ Ch 10 ████████████████████████████████████████████████████░ │ (drums)
│ ...                                                          │
│ Ch 16 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└─────────────────────────────────────────────────────────────┘
          ▲ playhead
```

**Rendering Logic:**
```javascript
drawMidiTimeline() {
    const ctx = this.ctxs.waveform;
    const w = this.canvases.waveform.width;
    const h = this.canvases.waveform.height;
    ctx.clearRect(0, 0, w, h);

    if (!this.midiActivity || !this.midiActivity.channels.length) return;

    const padding = (this.layout && this.layout.padding) || 0;
    const innerW = w - (padding * 2);
    const innerH = h - (padding * 2);
    
    const duration = this.midiActivity.duration * 1000; // ms
    const channels = this.midiActivity.channels;
    
    // Show only active channels (compact view) or all 16 (full view)
    const showAllChannels = false; // Could be user preference
    const displayChannels = showAllChannels ? 16 : channels.length;
    const laneHeight = innerH / displayChannels;
    const laneGap = 1;
    
    // Draw lane backgrounds (subtle)
    ctx.fillStyle = this.colors.midiLaneBg || 'rgba(128,128,128,0.1)';
    for (let i = 0; i < displayChannels; i++) {
        const y = padding + (i * laneHeight);
        ctx.fillRect(padding, y, innerW, laneHeight - laneGap);
    }
    
    // Draw activity bars
    ctx.fillStyle = this.colors.midiActivity || this.colors.spectrum;
    
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const laneIndex = showAllChannels ? ch.channel : i;
        const y = padding + (laneIndex * laneHeight) + 2;
        const barHeight = laneHeight - laneGap - 4;
        
        for (const seg of ch.segments) {
            const x = padding + (seg.start / duration) * innerW;
            const segW = Math.max(2, ((seg.end - seg.start) / duration) * innerW);
            
            // Drums (Ch 10) get different color
            if (ch.channel === 9) {
                ctx.fillStyle = this.colors.midiDrums || '#f59e0b';
            } else {
                ctx.fillStyle = this.colors.midiActivity || this.colors.spectrum;
            }
            
            ctx.fillRect(x, y, segW, barHeight);
        }
    }
}
```

---

### Phase 3: IPC Integration (main.js)

**Files Modified:** `js/monitoring/main.js`

1. Add `midi-timeline` IPC handler
2. Call `visualizers.setMidiActivity(data)`
3. Update file info display

```javascript
window.bridge.on('midi-timeline', (data) => {
    console.log('[Monitoring] Received MIDI timeline. Channels:', data.channels.length);
    this.visualizers.setMidiActivity(data);
    if (data.filePath) {
        this.fileInfo.innerText = data.filePath;
    }
});
```

---

### Phase 4: Seeking Support

The waveform seek functionality already works via `setupWaveformSeek()` in main.js:
- Uses `visualizers.currentDuration` which is set from `ana-data` updates
- Playhead updates via `updatePlayhead(pos, duration)`

**Verification needed:** Ensure `ana-data` is sent during MIDI playback (it should be via `updateMonitoring()` in stage.js).

---

### Phase 5: CSS/Colors

**Files Modified:** `css/monitoring.css`

Add CSS variables for MIDI timeline colors:
```css
:root {
    --midi-lane-bg: rgba(128, 128, 128, 0.1);
    --midi-activity: rgb(64, 168, 59);
    --midi-drums: #f59e0b;
}

.dark {
    --midi-lane-bg: rgba(255, 255, 255, 0.05);
}
```

---

## Alternative: In-Window Parsing (Simpler)

Instead of parsing in stage.js and sending via IPC, parse directly in monitoring window:

**Pros:**
- No IPC for large MIDI data
- `midi_analyzer.js` already uses ES modules (works in renderer)
- Simpler to test

**Cons:**
- Needs file URL passed to monitoring
- Duplicate fetch of MIDI file

**Implementation:**
1. Stage sends `file-change` with `{ isMIDI: true, filePath: fp }`
2. Monitoring window fetches file, parses with `parseMidiChannelActivity()`
3. Calls `visualizers.setMidiActivity(result)`

---

## Considerations

### Performance
- MIDI files are small (KB), parsing is fast
- Channel activity is pre-computed once per file load
- Canvas rendering is lightweight (filled rectangles)

### Edge Cases
- Empty MIDI files (no notes) → Show empty lanes message
- Very long files → Timeline scales automatically
- Rapid track changes → Clear previous data in `file-change` handler

### Integration Points
1. **Track change:** `file-change` IPC clears old data, triggers new parse
2. **Monitoring open during playback:** `monitoring-ready` should trigger timeline parse for current MIDI file
3. **Mixer mode:** MIDI timeline only for main player, not mixer

---

## Recommended Approach

**In-Window Parsing** is simpler and avoids:
- Cross-context module loading issues
- Large IPC payloads
- Synchronization complexity

---

## Summary of Changes

| File | Changes |
|------|---------|
| `js/monitoring/main.js` | Add `midi-timeline` handler, or parse locally on `file-change` |
| `js/monitoring/visualizers.js` | Add `midiActivity`, `setMidiActivity()`, `drawMidiTimeline()` |
| `css/monitoring.css` | Add MIDI timeline CSS variables |
| `js/stage.js` | (If IPC approach) Parse and send `midi-timeline` |

The existing `midi_analyzer.js` already handles the heavy lifting - it just needs to be wired into the visualization pipeline.
