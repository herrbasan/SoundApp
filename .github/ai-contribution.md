# AI Contribution Notes

## Session: December 21, 2025 - FFmpeg NAPI Integration Complete

### What We Accomplished

**FFmpeg NAPI Player Integration - COMPLETE ✅**
- Integrated `ffmpeg-napi-interface` package (v1.1.3) with SoundApp
- Unified streaming player with gapless looping in all modes
- No more separate "loop mode" requiring full file decode

**Key Files Added/Modified:**
- `bin/win_bin/player.js` - FFmpegStreamPlayer class
- `bin/win_bin/ffmpeg-worklet-processor.js` - AudioWorklet for chunk streaming
- `bin/win_bin/ffmpeg_napi.node` - Native FFmpeg decoder
- `js/stage.js` - Integrated new player
- `scripts/update-napi-binaries.ps1` - Updated to copy .js files

**Bug Fixes Applied Locally (carry to ffmpeg-napi-interface repo):**
All documented in `bin/LOCAL_FIXES.md`:

1. **Fix 1: Pause doesn't freeze time display**
   - Added `_pausedAtFrames` caching in player.js
   - `getCurrentTime()` returns cached value when paused

2. **Fix 2: Resume resets time to 0**
   - Removed position reset from `play()`
   - Restore `currentFrames` from `_pausedAtFrames` on resume

3. **Fix 3: Seeking causes file skip**
   - Root cause: Worklet fired `ended` when buffer temporarily empty during seek
   - Solution: Added `reachedEOF` flag in worklet
   - Only fire `ended` after playing through EOF-marked chunk

**Performance Review Created:**
See `docs/ffmpeg-player-review.md` for critical analysis:
- Memory leak: Transferable ArrayBuffers not used
- Feed loop runs even after EOF
- Queue can grow unbounded
- Seek range not validated
- Recommendations for future fixes

### Technical Insights

**Gapless Looping Strategy:**
- First chunk stored as "loop chunk" in worklet
- When last chunk finishes and loop enabled, immediately play loop chunk
- Main thread notified via `loopStarted` message to refill queue
- Sample-accurate looping without full file buffering

**End Detection Fix (critical learning):**
```javascript
// Wrong: fires when buffer empty for ANY reason (including seek)
} else if (!this.loopEnabled && !this.hasEnded) {
  this.port.postMessage({ type: 'ended' });
}

// Right: only fire after actually reaching EOF-marked chunk
} else if (this.reachedEOF && !this.loopEnabled && !this.hasEnded) {
  this.port.postMessage({ type: 'ended' });
}
```

### Files to Clean Up
- `libs/howler/` - No longer needed (can remove entire directory)
- `js/ffmpeg_player.js` - Old implementation (superseded by bin/win_bin/player.js)

### Next Steps for Future Sessions
1. Apply fixes from `bin/LOCAL_FIXES.md` to ffmpeg-napi-interface repo
2. Implement improvements from `docs/ffmpeg-player-review.md`
3. Remove unused howler.js library
4. Consider removing FFmpegBufferedPlayer class (unused)

---

## Session: December 20, 2025 - v1.1.2 Phase 1 Complete: Unified Audio Controller

### What We Accomplished

**Howler.js Removal - COMPLETE ✅**
- Created `js/audio_controller.js` - Unified AudioController class using Web Audio API
- Removed all Howler.js dependencies from codebase
- Merged `playAudio()` and `playAudioLoop()` into single function with mode switching
- Version bumped to 1.1.2 in package.json

**AudioController Architecture:**
- Dual-mode operation:
  - **BufferSource** (loop mode): Loads entire file into AudioBuffer for gapless looping
  - **MediaElement** (streaming mode): Uses HTML5 audio element for efficient playback
- Unified interface: `play()`, `pause()`, `stop()`, `seek()`, `volume` properties
- Proper state tracking with `sourceStarted` flag (no try/catch for control flow)
- Ready for future features: gain node foundation for speed control, effects chain

**Technical Fixes Implemented:**
1. **Chiptune playback issue** - Connected player.gain to audioContext.destination (was disconnected when passing custom context)
2. **Progress bar tracking** - Fixed currentTime getter with null checks and edge case handling
3. **Gapless looping** - Used `buffer.duration` for loopEnd, 86400s duration parameter (matches Howler.js pattern)
4. **Seeking in loop mode** - Works correctly with loopStart/loopEnd boundaries
5. **State management** - Used explicit `sourceStarted` flag instead of try/catch blocks

**Code Philosophy Updates:**
- Added rules to copilot-instructions.md:
  - Avoid try/catch for control flow - use explicit state tracking
  - Graceful error handling - report fail states in UI, don't silently swallow
- Emphasized surgical, self-critical approach with context awareness

**Files Modified:**
- `js/audio_controller.js` (new file - 208 lines)
- `js/stage.js` (refactored playback logic, removed Howler.js)
- `package.json` (version 1.1.2)
- `.github/copilot-instructions.md` (added error handling rules)

### Key Technical Insights

**Why Looping Was Clicking:**
- BufferSource with loop=true needs `loopStart` and `loopEnd` properties
- Must use `buffer.duration` not `this.duration` for precise looping
- Duration parameter in `start(0, offset, duration)` should be 86400 (effectively infinite) for looped playback
- This prevents clicks at loop boundary and allows seeking while maintaining gapless loop

**State Tracking Pattern:**
```javascript
// Instead of try/catch for stopped sources
this.sourceStarted = false; // Track state explicitly
if (this.source && this.sourceStarted) {
    this.source.stop(); // Only stop if actually started
}
```

**Chiptune Context Issue:**
```javascript
// When passing custom context to chiptune player:
player = new chiptune({context: g.audioContext});
// Must manually connect in onInitialized:
player.gain.connect(g.audioContext.destination);
```

### What's Ready for v1.1.2 Next Steps

**Remaining v1.1.2 Features:**
1. GitHub Releases for Updates (migrate from HTTP server)
2. Playlist Window (use nui_list.js)
3. Help/Documentation Window

**Foundation Now In Place For v1.2:**
- Unified audio routing through Web Audio API ✅
- Gain nodes ready for effects chain ✅
- Architecture supports speed control, multi-track mixer ✅
- Ready for FFmpeg streaming implementation ✅

### State of the Codebase

**What's Working:**
- All playback modes: native formats, chiptune, FFmpeg transcoding ✅
- Loop mode with gapless playback ✅
- Seeking in all modes including loop ✅
- Volume control ✅
- Progress bar tracking ✅
- Play/pause/stop controls ✅

**Performance Characteristics:**
- Loop mode: Higher memory (full AudioBuffer), instant seeking
- Streaming mode: Lower memory, efficient for long files
- Automatic mode selection based on `g.isLoop` state

**Next Immediate Steps (for future sessions):**
1. GitHub Releases integration for auto-updates
2. Create playlist window with nui_list.js
3. Create help window with keyboard shortcuts
4. Consider removing `libs/howler/` directory (no longer needed)

---

## Session: December 20, 2025 - Project Foundation & Roadmap

### What We Accomplished

**Documentation Created:**
- Established comprehensive project overview in `.github/copilot-instructions.md`
- Updated `README.md` with full project context
- Created `docs/streaming-refactor.md` with detailed FFmpeg streaming plan
- Documented coding philosophy, architecture, and complete feature roadmap

**Code Migration:**
- Successfully migrated from `helper.js` to `helper_new.js` (v2.0)
- Updated both `app.js` (main process) and `stage.js` (renderer)
- New config API: `helper.config.initMain()` / `helper.config.initRenderer()`
- All tests passing, app running correctly

**Strategic Decisions:**
1. **Remove Howler.js** - Priority #1 for v1.1.2, establishes Web Audio foundation
2. **Unified Audio Controller** - Critical for all future features (speed, mixer, etc.)
3. **FFmpeg Streaming** - Hybrid approach (streaming + buffered looping)
4. **Version Roadmap** - Clear priorities: 1.1.2 → 1.2 → 2.0

### Key Insights About the Project

**Philosophy:**
- Performance-first code with explicit `for` loops over abstractions
- Functional patterns but pragmatic (not dogmatic about stateless)
- No comments - code should be self-documenting
- Minimal dependencies - build it ourselves when possible
- Only use own libraries (electron_helper, native-registry, nui) + specialized tools

**Target Audience:**
- Musicians who need to quickly audition audio files
- Inspired by classic Mac OS System 7 SoundApp
- Keyboard-driven workflow is essential
- "No bloat" philosophy - stay lightweight and focused

**Technical Architecture:**
- Three audio playback paths: Browser-native, Tracker/Module, FFmpeg-transcoded
- Current limitation: FFmpeg blocks on full file transcode
- Loop mode uses different playback methods (Howler.js for browser-native, player for tracker)

### Important Context for Future Work

**Version 1.1.2 Priorities:**
1. Remove Howler.js and create unified Web Audio controller
   - Current usage: Only for looping playback with AudioBuffer
   - Replace with native AudioBufferSourceNode + loop property
   - **Critical:** This sets the foundation for all v1.2 features
   
2. GitHub Releases for auto-update
   - Currently uses custom HTTP server
   - Migrate to GitHub Releases API
   
3. Playlist window (using nui_list.js)

4. Help/documentation window

**Version 1.2 Features:**
All require Web Audio API routing established in 1.1.2:
- FFmpeg streaming (biggest architectural change)
- Playback speed control (time stretching + pitch shifting)
- Multi-track mixer (killer feature for stem preview)
- File format converter

**Code Patterns to Follow:**
```javascript
// Preferred loop pattern
for(let i=0; i<items.length; i++){
    // Having 'i' accessible is often useful
}

// Self-contained functions
function doSomething(input){
    // Do all related work here, even as closures
    // Repetition is okay if it keeps functions independent
    return output;
}
```

### State of the Codebase

**What's Working:**
- App runs successfully with helper_new.js
- All existing features functional
- Submodules updated (chiptune, electron_helper, howler, native-registry, nui)

**Next Immediate Steps:**
1. Create unified audio controller class/module
2. Replace Howler.js usage in `playAudioLoop()` function
3. Test all playback scenarios (native, tracker, FFmpeg, loop mode)
4. Ensure seeking, volume, pause/resume all work with new controller

**Files to Focus On:**
- `js/stage.js` - Main audio playback logic (lines 340-440 for loop mode)
- `js/app.js` - Config initialization on main process
- Future: Create `js/audio-controller.js` or similar for unified controller

### Questions for Future Sessions

- Should the unified audio controller handle all three playback types (native, tracker, FFmpeg)?
- Or should it be specifically for browser-native formats, with tracker/FFmpeg as special cases?
- How much abstraction is too much given the "minimal dependencies" philosophy?

### Notes on Collaboration Style

User prefers:
- Direct implementation over suggestions
- Compact, action-oriented responses
- No unnecessary explanations unless asked
- Code that follows existing patterns in the project
- Working code over perfect code

---

*This file serves as a memory bridge between sessions. Feel free to add notes when work is done or decisions are made.*
