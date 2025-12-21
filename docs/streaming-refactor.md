# FFmpeg NAPI Decoder Implementation Plan

## Goal
Replace the current FFmpeg CLI transcoding approach with a **native NAPI addon** that interfaces directly with FFmpeg libraries. This enables instant playback start, perfect seeking, and opens the door for advanced audio processing features.

## Strategy: Platform Binaries in /bin

The NAPI addon is installed as a dependency but the compiled `.node` file is copied to the `/bin` directory alongside FFmpeg binaries. This ensures it works correctly when packaged via the existing `extraResource` mechanism.

**Implementation:**
- Install package normally: `"ffmpeg-napi-interface": "github:herrbasan/ffmpeg-napi-interface"`
- Post-install script copies `ffmpeg_napi.node` to `bin/win_bin/` or `bin/linux_bin/`
- Runtime loading uses same path resolution pattern as FFmpeg binaries
- No asarUnpack needed - already in extraResources

**Loading Pattern:**
```javascript
// Same pattern as FFmpeg binary paths
const basePath = isPackaged ? path.dirname(g.app_path) : g.app_path;
const napiPath = path.resolve(basePath, 'bin', 'win_bin', 'ffmpeg_napi.node');
const { FFmpegDecoder } = require(napiPath);
```

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

## Proposed Solution: NAPI Addon + FFmpeg Libraries

### Why NAPI Instead of CLI Streaming?

**CLI streaming problems:**
- Seeking requires killing/restarting FFmpeg process
- Race conditions with rapid seeking (scrubbing seek bar)
- Limited control over decode pipeline
- Can't access frames individually

**NAPI benefits:**
- Direct access to FFmpeg's `av_seek_frame()` - instant seeking
- Frame-by-frame control for streaming or buffering
- No process spawning overhead
- Foundation for future features (filters, effects, multi-track)

### ArchitectuCreate Separate NAPI Project

**Repository:** `herrbasan/ffmpeg-napi-decoder`

**Project Structure:**
```
ffmpeg-napi-interface/
├── src/
│   ├── decoder.cpp           # Main decoder class
│   ├── binding.cpp           # NAPI bindings
│   └── utils.cpp             # Helper functions
├── deps/
│   ├── win/                  # FFmpeg DLLs for Windows
│   │   ├── avformat-XX.dll
│   │   ├── avcodec-XX.dll
│   │   └── swresample-XX.dll
│   └── linux/                # FFmpeg .so for Linux
├── dist/                     # Pre-built binaries (committed)
│   ├── win32-x64/
│   │   └── ffmpeg_napi.node
│   └── linux-x64/
│       └── ffmpeg_napi.node
├── binding.gyp
├── package.json
└── README.md
```

**C++ API (decoder.cpp):**
```cpp
class FFmpegDecoder {
private:
  AVFormatContext* formatCtx = nullptr;
  AVCodecContext* codecCtx = nullptr;
  SwrContext* swrCtx = nullptr;
  int audioStreamIndex = -1;
  
public:
  bool open(const char* filePath);
  bool seek(double seconds);
  int read(float* buffer, int numSamples);
  void close();
  
  // Metadata
  double getDuration();
  int getSampleRate();
  int getChannels();
};
```

**JavaScript API (exposed via NAPI):**
```javascript
const FFmpeg = require('ffmpeg-napi-interface');

const decoder = new FFmpeg.Decoder();
decoder.open('track.aif');

// Get metadata
const duration = decoder.duration;    // seconds
const sampleRate = decoder.sampleRate; // e.g., 44100
const channels = decoder.channels;     // 1 or 2

// Seek
decoder.seek(30.5); // Jump to 30.5 seconds

// Read samples (returns Float32Array)
const samples = decoder.read(4096); // Read 4096 samples

decoder.close();
┌─────────────────────────────────────┐
│   FFmpeg Libraries (libav*)         │
│   - libavformat (demuxing)          │
│   - libavcodec (decoding)           │
│   - libswresample (resampling)      │
└─────────────────────────────────────┘
```

### Playback Modes

**Streaming Mode (Non-Loop):**
- Decode frames on-demand as AudioWorklet requests
- Keep small bIntegrate as Submodule in SoundApp

**Add submodule:**
```bash
cd /d/Work/_GIT/SoundApp
git submodule add https://github.com/herrbasan/ffmpeg-napi-decoder.git libs/ffmpeg-napi-decoder
```

**Load in SoundApp:**
```javascript
// js/audio_controller.js
let FFmpegDecoImplement Streaming Playback

**Create AudioWorklet processor:**
```javascript
// libs/ffmpeg-worklet-processor.js
class FFmpegStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = []; // Ring buffer
    this.port.onmessage = this.onMessage.bind(this);
  }
  
  onMessage(event) {
    // Receive PCM chunks from main thread
    if (event.data.type === 'chunk') {
      this.buffer.push(...event.data.samples);
    }
  }
  
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const chanImplement Buffered Playback (Loop Mode)

```javascript
class FFmpegBufferedPlayer {
  async play(filePath) {
    this.decoder = new FFmpeg.Decoder();
    this.decoder.open(filePath);
    
    // Decode entire file
    const duration = this.decoder.duration;
    const sampleRate = this.decoder.sampleRate;
    const channels = this.decoder.channels;
    const totalSamples = duration * sampleRate;
    
    // Create AudioBuffer
    const audioBuffer = this.audioContext.createBuffer(
      channels,
      totalSamples,
      sampleRate
    );
    
    // Fill buffer (show progress)
    let offset = 0;
    while (offset < totalSamples) {
      const chunk = this.decoder.read(44100); // Read 1 second at a time
      
      // Deinterleave and copy to AudioBuffer
      for (let i = 0; i < chunk.length / 2; i++) {
        audioBuffer.getChannelData(0)[offset + i] = chunk[i * 2];
        audioBuffer.getChannelData(1)[offset + i] = chunk[i * 2 + 1];
      }
      
      offset += chunk.length / 2;
      
      // Update UI progress
      const progress = (offset / totalSamples) * 100;
      this.updateProgress(progress);
    }
    
    this.decoder.close();
    
    // Now use Web Audio's native loop
    this.source = this.audioContext.createBufferSource();
    this.source.buffer = audioBuffer;
    this.source.loop = true; // Gapless!
    this.source.connect(this.audioContext.destination);
    this.source.start();
  }
}
```NAPI Addon Development

**Building the addon:**
```bash
# In ffmpeg-napi-decoder repo
npm install
npm run build  # Runs node-gyp rebuild
```

**binding.gyp:**
```python
{
  'targets': [{
    'target_name': 'ffmpeg_decoder',
    'sources': [
      'src/decoder.cpp',
      'src/binding.cpp'
    ],
    'include_dirs': [
      "<!@(node -p \"require('node-addon-api').include\")",
      'deps/ffmpeg/include'
    ],
    'libraries': [
      '-L../deps/win/lib',
      '-lavformat',
      '-lavcodec',
      '-lswresample'
    ],
    'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ]
  }]
}
```

**Pre-building binaries:**
```bash
# Build for Windows
npm run build

# Copy to dist/
cp build/Release/ffmpeg_decoder.node dist/win32-x64/

# Commit pre-built binaries so SoundApp doesn't need to compile
git add dist/
### Phase 1: Create NAPI Addon (Separate Repo)
1. ⬜ Create `herrbasan/ffmpeg-napi-interface` repository
2. ⬜ Set up binding.gyp with FFmpeg dependencies
3. ⬜ Implement C++ FFmpegDecoder class
4. ⬜ Create NAPI bindings
5. ⬜ Bundle FFmpeg DLLs for Windows
6. ⬜ Build and commit pre-built binaries to `dist/`
7. ⬜ Write tests and examples

### Phase 2: Integrate into SoundApp
1. ⬜ Add as git submodule: `git submodule add ...`
2. ⬜ Update forge config to unpack addon
3. ⬜ Create AudioWorklet processor for streaming
4. ⬜ Implement FFmpegStreamPlayer class
5. ⬜ Implement FFmpegBufferedPlayer class
6. ⬜ Add feature flag: `ENABLE_FFMPEG_NAPI`

### Phase 3: Testing & Migration
1. ⬜ Test with AIFF, AIF files (primary use case)
2. ⬜ Test seeking (forward/backward, rapid scrubbing)
3. ⬜ Test loop mode (gapless playback)
4. ⬜ Memory leak testing (long sessions)
5. ⬜ Compare CPU usage vs CLI approach
6. ⬜ Gradual rollout with fallback to transcodeToFile()

### Phase 4: Cleanup
1. ⬜ Remove CLI transcoding code (after stable period)
2. ⬜ Clean up temp file cache
3. ⬜ Update docs and copilot-instructions
###Future Enhancements (Enabled by NAPI)

Once NAPI addon is stable, we can add:

1. **Real-time audio filters:**
   ```cpp
   decoder.setEqualizer(bands); // FFmpeg's audio filters
   decoder.setCompressor(threshold, ratio);
   ```

2. **Multi-track decoding:**
   ```javascript
   // For mixer feature (v1.2)
   const tracks = [
     new FFmpeg.Decoder('drums.wav'),
     new FFmpeg.Decoder('bass.wav'),
     new FFmpeg.Decoder('guitar.wav')
   ];
   // Synchronous playback with per-track volume
   ```

3. **Waveform generation:**
   ```javascript
   const waveform = decoder.generateWaveform(1000); // 1000 points
   // Render waveform canvas
   ```

4. **Format conversion without temp files:**
   ```javascript
   decoder.open('input.aif');
   decoder.export('output.flac', { codec: 'flac', quality: 8 });
   ```

## References

- [FFmpeg libavformat](https://ffmpeg.org/doxygen/trunk/group__libavf.html)
- [FFmpeg libavcodec](https://ffmpeg.org/doxygen/trunk/group__libavc.html)
- [Node-API Documentation](https://nodejs.org/api/n-api.html)
- [LibreMon NAPI Example](https://github.com/herrbasan/Electron_LibreMon) - Similar architecture
- [Web Audio API AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
  // Find audio stream...
  return true;
}
```

**JavaScript error handling:**
```javascript
try {
  decoder.open('file.aif');
} catch (err) {
  // Fall back to CLI transcode or skip
  console.error('FFmpeg decoder failed:', err);
  await transcodeToFile(fp); // Fallback
}
```

### Performance Characteristics

**Seek performance:**
- AIFF/WAV: <10ms (direct frame seeking)
- MP3/AAC: 20-50ms (needs to find keyframe)
- Much faster than killing/restarting process

**Decode throughput:**
- Native FFmpeg performance (same as CLI)
- AIFF: Decode 10-minute file in ~1 second
- MP3: Decode 10-minute file in ~2 seconds

**CPU usage:**
- Streaming: ~1-3% (decode on-demand)
- Buffered: Spike during decode, then 0%
      if (this.buffer.length >= 2) {
        channel0[i] = this.buffer.shift();
        channel1[i] = this.buffer.shift();
      } else {
        channel0[i] = 0;
        channel1[i] = 0;
      }
    }
    
    return true; // Keep processing
  }
}
registerProcessor('ffmpeg-stream', FFmpegStreamProcessor);
```

**Streaming controller:**
```javascript
// js/audio_controller.js
class FFmpegStreamPlayer {
  async play(filePath) {
    this.decoder = new FFmpeg.Decoder();
    this.decoder.open(filePath);
    
    // Set up AudioWorklet
    await this.audioContext.audioWorklet.addModule('libs/ffmpeg-worklet-processor.js');
    this.workletNode = new AudioWorkletNode(this.audioContext, 'ffmpeg-stream');
    this.workletNode.connect(this.audioContext.destination);
    
    // Start decode loop
    this.startDecodeLoop();
  }
  
  startDecodeLoop() {
    const readNextChunk = () => {
      const chunk = this.decoder.read(4096);
      if (chunk) {
        this.workletNode.port.postMessage({ type: 'chunk', samples: chunk });
      }
      this.decodeTimer = setTimeout(readNextChunk, 50); // Read every 50ms
    };
    readNextChunk();
  }
  
  seek(seconds) {
    this.decoder.seek(seconds); // Instant!
- Higher memory, perfect seeking

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
