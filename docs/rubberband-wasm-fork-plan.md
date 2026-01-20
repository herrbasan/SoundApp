# Rubberband WASM Fork Plan

## Goal
Fork rubberband-web and rebuild with better settings for quality time-stretching.

## Repository
- Source: https://github.com/delude88/rubberband-web
- Clone to: `libs/rubberband-wasm/` (or separate repo)

---

## Step 1: Clone and Setup

```powershell
cd D:\Work\_GIT\SoundApp\libs
git clone https://github.com/delude88/rubberband-web.git rubberband-wasm
cd rubberband-wasm
```

## Step 2: Install Emscripten

```powershell
# Option A: Use emsdk
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
.\emsdk install latest
.\emsdk activate latest
# Then run: emsdk_env.bat in each terminal session

# Option B: Use chocolatey
choco install emscripten
```

## Step 3: Verify Build Works (Before Changes)

```powershell
cd wasm
mkdir build
cd build
emcmake cmake ..
emmake make
```

This should produce `rubberband.js` and `rubberband.wasm` in build folder.

---

## Step 4: C++ Changes

### File: `wasm/src/rubberband/RealtimeRubberBand.h`

Change the hardcoded block size constant:

```cpp
// BEFORE:
const size_t kBlockSize_ = 1024;

// AFTER: Make it a member variable set in constructor
size_t block_size_ = 512;  // Default 512, configurable
```

Add block_size parameter to constructor declaration.

### File: `wasm/src/rubberband/RealtimeRubberBand.cpp`

#### 4a. Update constructor signature:

```cpp
// BEFORE:
RealtimeRubberBand::RealtimeRubberBand(size_t sample_rate, size_t channel_count, bool high_quality)

// AFTER:
RealtimeRubberBand::RealtimeRubberBand(size_t sample_rate, size_t channel_count, bool high_quality, size_t block_size)
    : block_size_(block_size > 0 ? block_size : 512)
```

#### 4b. Update Rubberband options (always use higher quality):

```cpp
// BEFORE:
const RubberBand::RubberBandStretcher::Options kDefaultOption = 
    RubberBand::RubberBandStretcher::OptionProcessRealTime |
    RubberBand::RubberBandStretcher::OptionPitchHighConsistency |
    RubberBand::RubberBandStretcher::OptionEngineFaster;

// AFTER:
const RubberBand::RubberBandStretcher::Options kDefaultOption = 
    RubberBand::RubberBandStretcher::OptionProcessRealTime |
    RubberBand::RubberBandStretcher::OptionPitchHighConsistency |
    RubberBand::RubberBandStretcher::OptionEngineFiner |
    RubberBand::RubberBandStretcher::OptionWindowLong;
```

Also update `kHighQuality` similarly (add `OptionWindowLong`).

#### 4c. Call setMaxProcessSize after stretcher creation:

```cpp
// After creating stretcher_, add:
stretcher_->setMaxProcessSize(block_size_);
```

#### 4d. Replace all uses of `kBlockSize_` with `block_size_`

Search and replace throughout the file.

### File: `wasm/src/rubberband.cc` (embind bindings)

```cpp
// BEFORE:
.constructor<size_t, size_t, bool>()

// AFTER:
.constructor<size_t, size_t, bool, size_t>()
```

---

## Step 5: Rebuild

```powershell
cd wasm/build
emmake make clean
emmake make
```

Output: `rubberband.js` (contains embedded WASM as base64)

---

## Step 6: Create Custom AudioWorklet Processor

Create new file: `libs/rubberband-wasm/soundapp-rubberband-processor.js`

Key changes from their processor:
1. Accept `blockSize` in options (default 512)
2. Accumulate samples until we have `blockSize` before calling push()
3. Pull in larger batches

```javascript
class SoundAppRubberbandProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.blockSize = options.processorOptions?.blockSize || 512;
        this.inputBuffer = [];  // Accumulator per channel
        this.outputBuffer = []; // Output accumulator
        // ... rest of init
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        
        if (!this.api || !input.length) return true;
        
        // Accumulate input samples
        for (let ch = 0; ch < input.length; ch++) {
            if (!this.inputBuffer[ch]) this.inputBuffer[ch] = [];
            this.inputBuffer[ch].push(...input[ch]);
        }
        
        // Process when we have enough samples
        while (this.inputBuffer[0].length >= this.blockSize) {
            // Extract blockSize samples per channel
            const chunk = [];
            for (let ch = 0; ch < input.length; ch++) {
                chunk[ch] = new Float32Array(this.inputBuffer[ch].splice(0, this.blockSize));
            }
            
            // Push to rubberband
            this.api.push(chunk);
        }
        
        // Pull available samples to output buffer
        while (this.api.samplesAvailable >= 128) {
            const pulled = this.api.pull(/* 128 samples */);
            for (let ch = 0; ch < output.length; ch++) {
                if (!this.outputBuffer[ch]) this.outputBuffer[ch] = [];
                this.outputBuffer[ch].push(...pulled[ch]);
            }
        }
        
        // Copy from output buffer to actual output
        for (let ch = 0; ch < output.length; ch++) {
            if (this.outputBuffer[ch]?.length >= 128) {
                const samples = this.outputBuffer[ch].splice(0, 128);
                output[ch].set(samples);
            }
        }
        
        return true;
    }
}
```

---

## Step 7: Update SoundApp Integration

### Copy built files to SoundApp:
```powershell
copy wasm/build/rubberband.js D:\Work\_GIT\SoundApp\libs\rubberband-wasm.js
copy soundapp-rubberband-processor.js D:\Work\_GIT\SoundApp\libs\
```

### Update pitchtime_engine.js:
- Load our custom `rubberband-wasm.js` instead of npm package
- Load our custom processor instead of `rubberband-processor.js`
- Pass `blockSize: 512` in AudioWorkletNode options

---

## Step 8: Test

1. Restart app
2. Open Pitch & Time window (P key)
3. Test pitch shift - should work same as before
4. Test tempo stretch - should now work without degradation

---

## Troubleshooting

### Build fails - missing emscripten
- Make sure `emcmake` and `emmake` are in PATH
- Run `emsdk_env.bat` first

### WASM won't load
- Check browser console for errors
- May need CORS headers if loading from file://

### Still has artifacts
- Try increasing blockSize to 1024 or 2048
- Try adding more latency compensation

---

## Files Changed Summary

| File | Change |
|------|--------|
| `RealtimeRubberBand.h` | Add block_size_ member, remove const kBlockSize_ |
| `RealtimeRubberBand.cpp` | Constructor param, better options, setMaxProcessSize() |
| `rubberband.cc` | Update embind constructor signature |
| New: custom processor | Buffering logic for larger blocks |

---

## Latency Note

Larger block sizes add latency:
- 512 samples @ 48kHz = ~10.7ms
- 1024 samples @ 48kHz = ~21.3ms
- 2048 samples @ 48kHz = ~42.7ms

For a practice/manipulation tool, 20-40ms is acceptable. DAWs typically use ~512-1024.
