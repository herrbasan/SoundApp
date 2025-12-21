# FFmpeg NAPI Interface - Feature Roadmap

**Vision:** Expose the full power of FFmpeg libraries through a native Node.js NAPI interface, eliminating the need for CLI subprocess spawning and enabling real-time audio processing capabilities.

---

## Architecture Overview

### Design Decisions

1. **Layered API Design**
   - **Layer 1 (Low-level):** Direct wrappers around FFmpeg structures (FormatContext, CodecContext, etc.)
   - **Layer 2 (High-level):** Convenience classes combining multiple FFmpeg operations (Decoder, Encoder, Metadata)
   - Users can choose the abstraction level that fits their needs

2. **Async-First Operations**
   - File I/O operations (open, metadata extraction) use `Napi::AsyncWorker`
   - Both sync and async versions available: `open()` / `openAsync()`
   - Long operations support progress callbacks

3. **Buffer-Based Data**
   - Audio samples returned as `Float32Array` (zero-copy when possible)
   - Cover art returned as `Buffer` directly (cleaner API, avoids temp files)
   - Large metadata (cover art) is optional via `getMetadata({ includeCoverArt: true })`

4. **Module Structure**
   ```
   src/
   ├── core/                    # Low-level FFmpeg wrappers
   │   ├── format_context.cpp   # AVFormatContext (file/metadata access)
   │   ├── codec_context.cpp    # AVCodecContext (decoder/encoder state)
   │   ├── resampler.cpp        # SwrContext (sample format conversion)
   │   ├── filter_graph.cpp     # AVFilterGraph (effects chain)
   │   └── error.cpp            # Error handling, av_strerror wrapping
   │
   ├── decoder.cpp              # High-level decoder (current)
   ├── encoder.cpp              # High-level encoder (Phase 1.2)
   ├── metadata.cpp             # Metadata extraction (Phase 1.1)
   ├── waveform.cpp             # Waveform generation (Phase 2)
   ├── multi_track.cpp          # Multi-track mixer (Phase 2)
   │
   └── binding.cpp              # NAPI exports (all classes)
   
   lib/
   ├── index.js                 # Main export, feature detection
   ├── decoder.js               # FFmpegDecoder + async wrapper
   ├── metadata.js              # Standalone metadata utilities
   └── player.js                # AudioWorklet integration
   ```

5. **Error Handling**
   - No try/catch for control flow
   - Methods return success/failure boolean or null
   - `getLastError()` provides detailed error message
   - Errors propagate to JS with context (file path, operation, FFmpeg error code)

---

## Current Implementation (v1.0.0)

✅ **Basic Decoder**
- `open(filepath)` - Open audio file for decoding
- `read(numSamples)` - Read PCM samples (interleaved float32)
- `seek(seconds)` - Seek to timestamp
- `close()` - Clean up resources
- `getDuration()` - Get file duration
- `getSampleRate()` - Get sample rate
- `getChannels()` - Get channel count

---

## Phase 1: Replace FFmpeg CLI (SoundApp Requirements)

These features are needed to completely eliminate FFmpeg CLI usage in SoundApp.

### 1.1 Metadata Extraction (Replace ffprobe)

**Priority: HIGH** - Currently using `ffprobe` subprocess

**Implementation approach:**
- Add `getMetadata()` to existing `FFmpegDecoder` class (reuses open file handle)
- Also provide static `FFmpeg.getMetadata(path)` for standalone use
- Always return everything including cover art buffer - caller decides what to use
- Async versions available for UI responsiveness

```cpp
// C++ API - in decoder.h
struct AudioMetadata {
  // Tags (from AVFormatContext->metadata)
  std::string title;
  std::string artist;
  std::string album;
  std::string albumArtist;
  std::string genre;
  std::string date;
  std::string comment;
  int trackNumber;
  int trackTotal;
  int discNumber;
  int discTotal;
  
  // Format info (from AVStream/AVCodecParameters)
  std::string codec;          // "mp3", "flac", "aac"
  std::string codecLongName;  // "MP3 (MPEG audio layer 3)"
  std::string format;         // "mp3", "flac", "ogg"
  std::string formatLongName; // "MP2/3 (MPEG audio layer 2/3)"
  int64_t duration;           // microseconds
  int bitrate;                // bits/sec (0 for VBR/unknown)
  int sampleRate;             // original sample rate
  int channels;               // original channel count
  int bitsPerSample;          // for lossless formats
  
  // Cover art (from AV_DISPOSITION_ATTACHED_PIC stream)
  std::vector<uint8_t> coverArt;      // JPEG/PNG bytes, empty if none
  std::string coverArtMimeType;       // "image/jpeg", "image/png"
};

// Instance method (reuses open file)
AudioMetadata getMetadata() const;

// Static method (opens file just for metadata, closes immediately)
static AudioMetadata getFileMetadata(const char* path);
```

**JavaScript API:**
```javascript
// On decoder instance (file already open)
const decoder = new FFmpeg.Decoder();
decoder.open('music.mp3');
const meta = decoder.getMetadata();

// Static utility (opens, reads, closes)
const meta = FFmpeg.getMetadata('music.mp3');

// Async versions
const meta = await FFmpeg.getMetadataAsync('music.mp3');
const meta = await decoder.getMetadataAsync();

// Result shape - everything returned directly
{
  title: "Track Name",
  artist: "Artist Name",
  album: "Album Name",
  albumArtist: "Various Artists",
  genre: "Electronic",
  date: "2024",
  trackNumber: 3,
  trackTotal: 12,
  
  codec: "mp3",
  codecLongName: "MP3 (MPEG audio layer 3)",
  format: "mp3",
  duration: 180.5,         // seconds
  bitrate: 320000,         // bits/sec
  sampleRate: 44100,
  channels: 2,
  
  coverArt: Buffer,        // JPEG/PNG bytes, null if none
  coverArtMimeType: "image/jpeg"
}
```

### 1.2 Format Conversion/Encoding

**Priority: MEDIUM** - Planned for v1.2 (File Format Converter feature)

**Implementation approach:**
- New `FFmpegEncoder` class in `src/encoder.cpp`
- Mirrors decoder pattern: open, write, close
- Async write with progress callback for large files

```cpp
// C++ API - encoder.h
struct EncoderOptions {
  std::string codec;      // "mp3", "flac", "aac", "opus", "wav", "pcm_s16le"
  int sampleRate;         // Output sample rate (0 = match input)
  int channels;           // Output channels (0 = match input)
  int bitrate;            // For lossy codecs (bits/sec)
  int quality;            // Codec-specific quality (0-10, higher = better)
  std::map<std::string, std::string> metadata;
};

class FFmpegEncoder {
public:
  bool open(const char* outputPath, const EncoderOptions& options);
  bool write(float* samples, int numSamples);
  bool flush();  // Flush encoder buffers
  void close();
  
  // Progress
  int64_t getSamplesWritten() const;
  double getProgress() const;  // 0.0 to 1.0 if total known
  
  // Error handling
  bool hasError() const;
  std::string getLastError() const;
};
```

**JavaScript API:**
```javascript
const encoder = new FFmpeg.Encoder();
encoder.open('output.flac', {
  codec: 'flac',
  sampleRate: 44100,
  channels: 2,
  quality: 8,
  metadata: {
    title: 'Track Name',
    artist: 'Artist Name'
  }
});

// Feed samples from decoder
while (true) {
  const { buffer, samplesRead } = decoder.read(4096);
  if (samplesRead === 0) break;
  encoder.write(buffer);
}

encoder.flush();
encoder.close();

// Or use convenience function for file conversion
await FFmpeg.convert('input.aif', 'output.flac', {
  codec: 'flac',
  quality: 8,
  onProgress: (percent) => console.log(`${percent}%`)
});
```

---

## Phase 2: Advanced Playback Features

Features needed for SoundApp v1.2+ enhancements.

### 2.1 Real-Time Audio Effects

**Priority: HIGH** - Planned for v1.2

```cpp
class AudioProcessor {
public:
  // Time stretching (change speed without pitch shift)
  void setTimeStretch(float rate);  // 0.5 = half speed, 2.0 = double speed
  
  // Pitch shifting (change pitch without speed change)
  void setPitchShift(float semitones);  // -12 to +12
  
  // Equalization
  void setEqualizer(std::vector<float> bands);  // 10-band EQ
  
  // Dynamic range compression
  void setCompressor(float threshold, float ratio, float attack, float release);
  
  // Gain control
  void setGain(float db);  // -60 to +20 dB
  
  // Stereo pan
  void setPan(float pan);  // -1.0 (left) to 1.0 (right)
  
  // Apply effects chain
  int process(float* input, float* output, int numSamples);
};
```

**JavaScript API:**
```javascript
const processor = new FFmpeg.AudioProcessor();

// Time stretch to 150% speed (no pitch change)
processor.setTimeStretch(1.5);

// Pitch shift up 2 semitones
processor.setPitchShift(2.0);

// Apply processing
const processed = processor.process(samples);
```

### 2.2 Waveform Generation

**Priority: MEDIUM** - Planned for v2.0 visualization

```cpp
struct WaveformData {
  std::vector<float> peaks;      // Peak values for visualization
  std::vector<float> rms;        // RMS values for smooth waveform
  int samplesPerPoint;           // Downsampling factor
};

WaveformData generateWaveform(int numPoints, WaveformMode mode);
```

**JavaScript API:**
```javascript
// Generate 1000-point waveform for canvas rendering
const waveform = decoder.generateWaveform(1000, 'peak');
// Returns: { peaks: Float32Array(1000), rms: Float32Array(1000) }
```

### 2.3 Multi-Track Synchronous Playback

**Priority: MEDIUM** - Planned for v1.2 (Mixer feature)

```cpp
class MultiTrackDecoder {
public:
  bool addTrack(const char* filepath);
  bool removeTrack(int trackIndex);
  
  // Per-track controls
  void setTrackVolume(int trackIndex, float volume);
  void setTrackPan(int trackIndex, float pan);
  void setTrackMute(int trackIndex, bool muted);
  void setTrackSolo(int trackIndex, bool solo);
  
  // Synchronized playback
  int readMixed(float* output, int numSamples);
  int readSeparate(float** outputs, int numSamples);  // Each track separate
  
  void seekAll(double seconds);
};
```

**JavaScript API:**
```javascript
const mixer = new FFmpeg.MultiTrackDecoder();
mixer.addTrack('drums.wav');
mixer.addTrack('bass.wav');
mixer.addTrack('guitar.wav');

mixer.setTrackVolume(0, 0.8);
mixer.setTrackPan(1, -0.5);  // Pan bass left

// Read mixed output
const mixed = mixer.readMixed(4096);

// Or read tracks separately for custom mixing
const [drums, bass, guitar] = mixer.readSeparate(4096);
```

---

## Phase 3: Full FFmpeg Feature Exposure

Long-term goal: Expose all relevant FFmpeg capabilities.

### 3.1 Advanced Filtering (libavfilter)

Full access to FFmpeg's audio filter graph:

```cpp
class AudioFilterGraph {
public:
  bool init(const char* filterSpec);
  int process(float* input, float* output, int numSamples);
};
```

**JavaScript API:**
```javascript
const filter = new FFmpeg.AudioFilterGraph();

// FFmpeg filter syntax
filter.init('aecho=0.8:0.9:1000:0.3,aresample=48000');
const filtered = filter.process(samples);
```

**Examples of available filters:**
- `aecho` - Echo/reverb
- `chorus` - Chorus effect
- `flanger` - Flanger effect
- `tremolo` - Tremolo/vibrato
- `equalizer` - Parametric EQ
- `loudnorm` - Loudness normalization
- `compand` - Dynamic range compression
- `silenceremove` - Remove silence
- `aresample` - Sample rate conversion
- Hundreds more...

### 3.2 Stream Information

```cpp
struct StreamInfo {
  int streamIndex;
  std::string codecName;
  std::string codecLongName;
  std::string profile;
  int bitrate;
  int64_t duration;
  std::map<std::string, std::string> metadata;
};

std::vector<StreamInfo> getAllStreams();
int selectStream(int streamIndex);  // For multi-stream files
```

### 3.3 Advanced Seeking

```cpp
enum SeekMode {
  SEEK_EXACT,      // Slow but accurate
  SEEK_KEYFRAME,   // Fast but may overshoot
  SEEK_FRAME       // Seek by frame number
};

bool seek(double seconds, SeekMode mode);
bool seekFrame(int64_t frameNumber);
```

### 3.4 Format Detection & Validation

```cpp
struct FormatInfo {
  std::string format;
  std::string longName;
  std::vector<std::string> extensions;
  bool canDecode;
  bool canEncode;
};

static std::vector<FormatInfo> getSupportedFormats();
static bool canDecode(const char* filepath);
static std::string detectFormat(const char* filepath);
```

### 3.5 Codec Information

```cpp
struct CodecInfo {
  std::string name;
  std::string longName;
  bool isEncoder;
  bool isDecoder;
  std::vector<int> supportedSampleRates;
  std::vector<int> supportedChannelLayouts;
};

static std::vector<CodecInfo> getAvailableCodecs();
```

### 3.6 Hardware Acceleration

```cpp
enum HardwareAccel {
  NONE,
  CUDA,
  DXVA2,      // Windows
  QSV,        // Intel Quick Sync
  VIDEOTOOLBOX // macOS
};

void setHardwareAccel(HardwareAccel accel);
```

### 3.7 Network Streaming Support

```cpp
bool openStream(const char* url);  // HTTP, RTSP, etc.
bool isStreaming();
int64_t getBytesDownloaded();
```

### 3.8 Batch Processing

```cpp
class BatchProcessor {
public:
  struct Job {
    std::string inputPath;
    std::string outputPath;
    EncoderOptions options;
    std::function<void(float)> progressCallback;
  };
  
  void addJob(Job job);
  void processAll(int numThreads);
  void cancel();
};
```

---

## Implementation Priorities

### Immediate (v1.1)
1. ✅ Basic decoder (done)
2. Metadata extraction (replace ffprobe)
3. Cover art extraction

### Short-term (v1.2)
1. Format conversion/encoding
2. Basic audio effects (gain, pan, EQ)
3. Multi-track decoder
4. Waveform generation

### Medium-term (v1.3-1.5)
1. Time stretching & pitch shifting
2. Advanced filter graph support
3. Advanced seeking modes
4. Stream information & selection

### Long-term (v2.0+)
1. Full filter library exposure
2. Hardware acceleration
3. Network streaming
4. Batch processing utilities
5. Video frame extraction (for cover art from video files)

---

## Design Principles

1. **Zero-copy where possible** - Use Buffer views, avoid unnecessary copies
2. **Async operations** - Long operations should be async with progress callbacks
3. **Error handling** - Clear error messages, no silent failures
4. **Resource management** - RAII in C++, proper cleanup in JS
5. **Thread safety** - Safe for multi-threaded use
6. **Performance** - Native speed, minimal overhead
7. **API consistency** - Predictable naming, similar patterns throughout
8. **Documentation** - Every method documented with examples

---

## Testing Requirements

Each feature must include:
- Unit tests (C++ side)
- Integration tests (JavaScript side)
- Performance benchmarks
- Memory leak tests
- Example code
- Cross-platform validation (Windows, Linux, macOS)

---

## Compatibility

- **Node.js:** 16.x, 18.x, 20.x, 22.x
- **Electron:** 22+
- **FFmpeg:** 6.x, 7.x
- **Platforms:** Windows x64, Linux x64, macOS arm64/x64

---

## Notes for SoundApp Integration

This library is primarily developed to support SoundApp's audio playback needs, but is designed as a general-purpose FFmpeg binding that can be used in any Node.js/Electron project.

Features are prioritized based on SoundApp's roadmap, but all FFmpeg capabilities should eventually be exposed for maximum flexibility.

**Repository:** [herrbasan/ffmpeg-napi-interface](https://github.com/herrbasan/ffmpeg-napi-interface)
