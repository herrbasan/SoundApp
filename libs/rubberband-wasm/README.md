# RubberBand WASM Build

Emscripten build system for compiling the [Rubber Band library](https://breakfastquay.com/rubberband/) to WebAssembly for use in SoundApp's pitch/time manipulation feature.

Based on [rubberband-web](https://github.com/delude88/rubberband-web) by delude88.

---

## Prerequisites

### Required Software
- **Emscripten SDK** - C++ to WASM compiler
- **CMake** (3.21+) - Build system
- **Ninja** - Fast build tool

### Installation (Windows)

1. **Install Emscripten:**
```powershell
git clone https://github.com/emscripten-core/emsdk.git C:\emsdk
cd C:\emsdk
.\emsdk.bat install latest
.\emsdk.bat activate latest
```

2. **Install CMake:**
```powershell
# Run as Administrator:
choco install cmake -y
```
Or download from: https://cmake.org/download/

3. **Install Ninja:**
```powershell
# Download and extract to C:\emsdk\ninja.exe
Invoke-WebRequest -Uri "https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip" -OutFile C:\emsdk\ninja.zip
Expand-Archive -Path C:\emsdk\ninja.zip -DestinationPath C:\emsdk -Force
Remove-Item C:\emsdk\ninja.zip
```

---

## Build Process

### Full Rebuild

```powershell
# Set up environment
$env:Path = "C:\emsdk;C:\emsdk\upstream\emscripten;C:\Program Files\CMake\bin;" + $env:Path

# Clean and rebuild
cd libs\rubberband-wasm\wasm
Remove-Item build -Recurse -Force -ErrorAction SilentlyContinue
C:\emsdk\upstream\emscripten\emcmake.bat cmake -G Ninja -B build -S .
cmake --build build --target rubberband

# Generate the final worklet processor
cd ..\..\..
node scripts\build-rubberband-processor.js
```

### Incremental Rebuild

After C++ changes in `wasm/src/rubberband/`:
```powershell
$env:Path = "C:\emsdk;C:\emsdk\upstream\emscripten;C:\Program Files\CMake\bin;" + $env:Path
cd libs\rubberband-wasm\wasm
cmake --build build --target rubberband
cd ..\..\..
node scripts\build-rubberband-processor.js
```

### JavaScript-Only Changes

Edit `scripts/build-rubberband-processor.js` (the `processorCode` template), then:
```powershell
node scripts\build-rubberband-processor.js
```

---

## Project Structure

```
libs/rubberband-wasm/
├── wasm/                          # WASM build system
│   ├── lib/third-party/           # RubberBand C++ library (v3.0.0)
│   ├── src/
│   │   ├── rubberband/            # C++ wrapper classes
│   │   │   ├── RealtimeRubberBand.cpp
│   │   │   └── ...
│   │   └── post-js/
│   │       └── heap-exports.js    # HEAPF32 export for worklet
│   ├── CMakeLists.txt             # Build configuration
│   └── build/
│       └── rubberband.js          # Build output (~448KB, WASM embedded)
└── README.md                      # This file
```

### Output Files

**WASM Module:**
- `wasm/build/rubberband.js` (~448KB) - Emscripten module with embedded WASM

**Final Worklet:**
- `libs/rubberband/realtime-pitch-shift-processor.js` (~426KB)
  - **Section 1:** Emscripten WASM module (auto-generated, do not edit)
  - **Section 2:** Vanilla JS worklet implementation (fully editable)

---

## Build Configuration

Key Emscripten flags in `wasm/CMakeLists.txt`:
- `-s WASM=1` - Enable WASM output
- `-s SINGLE_FILE=1` - **Embed WASM as base64** (required for AudioWorklet context)
- `-s ALLOW_MEMORY_GROWTH=1` - Dynamic memory allocation
- `-s MODULARIZE=1` - Export as factory function
- `--post-js heap-exports.js` - Attach HEAPF32 views to module

**⚠️ Do not remove `-s SINGLE_FILE=1`** - AudioWorklet cannot use `fetch()` to load external files.

---

## Troubleshooting

### "emcc not recognized"
Emscripten isn't in PATH:
```powershell
$env:Path = "C:\emsdk;C:\emsdk\upstream\emscripten;C:\Program Files\CMake\bin;" + $env:Path
```

### "cmake not recognized"
CMake isn't installed or not in PATH. Install via chocolatey or add `C:\Program Files\CMake\bin` to PATH.

### "no compatible cmake generator found"
Ninja is missing. See installation instructions above.

### Build fails with WASM errors
Clean rebuild:
```powershell
Remove-Item libs\rubberband-wasm\wasm\build -Recurse -Force
# Then run full rebuild
```

---

## Performance Notes

- Uncompressed WASM: ~365KB
- Base64 embedded: ~448KB (+33% overhead)
- Build time: ~10-30s (full), ~2-5s (incremental)
- The size increase from embedding is acceptable for AudioWorklet compatibility
