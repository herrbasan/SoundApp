# FFmpeg Streaming Playback Refactor Plan

## Goal
Replace the current FFmpeg CLI transcoding approach (which requires full file conversion before playback) with a streaming solution that enables near-instant playback start for unsupported audio formats.

## Current Implementation Issues

### Existing Flow
1. User selects unsupported format file (`.aif`, `.aiff`, `.mpg`, `.mp2`, etc.)
2. `transcodeToFile()` spawns FFmpeg to convert entire file to WAV
3. WAV file written to temp directory
4. Only after transcoding completes, playback begins
5. Cache files persist until manually cleaned up

### Problems
- **Playback Delay:** Large files take significant time to transcode before any audio plays
- **Disk I/O:** Unnecessary writes to temp directory
- **Storage Waste:** Cache files accumulate (only cleaned on next playback)
- **User Experience:** Blocking operation with no feedback during transcoding

## Proposed Solution: Hybrid Streaming Approach

### Architecture Overview

**Non-Looping Playback (Default):**
- Stream PCM audio data from FFmpeg stdout directly to Web Audio API
- No intermediate file creation
- Playback starts within ~100-500ms

**Looping Playback:**
- Decode entire file to AudioBuffer in memory (similar to current Howler.js approach)
- Use Web Audio API BufferSource with `loop = true` for gapless looping
- Maintains seamless loop quality

### Implementation Strategy

#### Phase 1: FFmpeg PCM Streaming Module
Create new module `libs/ffmpeg-streamer/` with:

```javascript
class FFmpegPCMStreamer {
  constructor(filePath, audioContext, options) {
    // Spawn FFmpeg to pipe PCM to stdout
    // Setup Web Audio pipeline
    // Handle seeking, pausing, cleanup
  }
  
  async start() { /* Begin streaming */ }
  pause() { /* Pause without killing process */ }
  resume() { /* Resume streaming */ }
  seek(seconds) { /* Kill and restart at position */ }
  destroy() { /* Clean up process and audio nodes */ }
}
```

**FFmpeg Command:**
```bash
ffmpeg -i input.aif -f s16le -acodec pcm_s16le -ar 44100 -ac 2 pipe:1
```

**Web Audio Pipeline:**
```
FFmpeg stdout → PCM chunks → AudioWorklet/ScriptProcessor → AudioContext → Speakers
```

#### Phase 2: AudioBuffer Decoder for Looping
Create decoder that uses FFmpeg to populate AudioBuffer:

```javascript
async function decodeFileToAudioBuffer(filePath, audioContext) {
  // Spawn FFmpeg, collect all PCM data
  // Create AudioBuffer from complete PCM data
  // Return buffer for looping playback
}
```

#### Phase 3: Refactor `playAudio()` Function
Update `stage.js` to choose playback method based on loop state:

```javascript
async function playAudio(fp, n) {
  let parse = path.parse(fp);
  
  if (needsFFmpeg(parse.ext)) {
    if (g.isLoop) {
      // Decode to AudioBuffer, use BufferSource with loop
      await playAudioWithBuffer(fp, n);
    } else {
      // Stream from FFmpeg
      await playAudioStreaming(fp, n);
    }
  } else {
    // Existing logic for browser-native and tracker formats
  }
}
```

#### Phase 4: Progress Feedback
Add visual feedback during buffer loading for loop mode:
- Show loading indicator
- Display progress percentage if possible
- Communicate decode state to user

## Technical Considerations

### Seeking in Streaming Mode
FFmpeg doesn't support bidirectional seeking on pipes. Options:
1. **For forward seeks:** Buffer decoded data, seek within buffer
2. **For backward seeks:** Kill process, restart with `-ss` offset flag
3. **Trade-off:** Some latency on backward seeks, but acceptable for most use cases

### Memory Management
- **Streaming mode:** Minimal memory (~1-2 seconds of PCM in buffer)
- **Loop mode:** Entire file in AudioBuffer (same as current Howler.js approach)
- Monitor buffer sizes for large files

### Error Handling
- FFmpeg process crashes → Fall back to transcodeToFile() method
- Corrupt audio data → Display error, skip to next track
- Unsupported codec → Graceful error message

### Performance Testing Needed
- Test with various file sizes (1MB → 500MB+)
- Measure time-to-first-audio
- Monitor CPU usage during streaming
- Test seeking responsiveness

## Benefits Summary

### User Experience
✅ Near-instant playback start (no waiting for transcoding)  
✅ No temp file accumulation  
✅ Reduced disk wear on SSD systems  
✅ Smoother experience with large files  

### Developer Experience
✅ Cleaner architecture (streaming by default)  
✅ Better resource management  
✅ More control over audio pipeline  
✅ Easier to add features (real-time effects, EQ, etc.)  

### Performance
✅ Lower memory usage for non-looping playback  
✅ No disk I/O bottleneck  
✅ Faster playlist navigation  

## Migration Path

1. ✅ Document current architecture
2. ⬜ Implement FFmpegPCMStreamer class
3. ⬜ Implement decodeFileToAudioBuffer function
4. ⬜ Create feature flag to toggle between old/new system
5. ⬜ Integrate with existing playback logic
6. ⬜ Test thoroughly with all supported formats
7. ⬜ Remove old transcodeToFile() code
8. ⬜ Clean up orphaned cache files on first run

## Open Questions

- Should we support streaming for tracker formats too, or keep libopenmpt as-is?
- Do we need to implement a disk cache fallback for very large files in loop mode?
- Should we add a "buffer entire file" option for users who prefer consistent behavior?
- How to handle seeking during the initial buffer phase (first few seconds)?

## References

- [FFmpeg PCM output formats](https://ffmpeg.org/ffmpeg-formats.html#rawvideo-1)
- [Web Audio API AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [Howler.js source code](https://github.com/goldfire/howler.js) - reference for AudioBuffer approach
