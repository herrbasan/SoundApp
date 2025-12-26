# AI Contribution Notes

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

## Session: December 22, 2025 - Multi-Window System & Global Theme Toggle

### What We Accomplished

**Multi-Window System Architecture - COMPLETE ✅**
- Designed and documented complete window system architecture
- Self-contained HTML pages work in both Electron and browser preview
- Created `js/window-loader.js` for context detection and bridge creation
- Implemented first window: `html/help.html` with keyboard shortcuts documentation

**Global Theme Toggle System - COMPLETE ✅**
- Implemented X key shortcut to toggle dark/light theme globally
- Theme state tracked in main process (app.js)
- Broadcasts to all windows using `tools.broadcast()`
- Theme persists to config file via stage window
- Works from any window (stage or secondary windows)

**Browser Preview Mode - COMPLETE ✅**
- All secondary windows previewable with live-server
- X key toggles theme in browser mode (localStorage persistence)
- Mock bridge logs IPC commands to console
- Separate theme state for browser vs Electron

**Same-Screen Window Positioning - COMPLETE ✅**
- Windows open on same display as stage window
- Finds correct display in multi-monitor setups
- Centers new window on target display

**Documentation Updates:**
- Updated README with keyboard shortcuts table in HTML format
- Positioned shortcuts prominently after "What This Is" section

### Key Files Created

**Documentation:**
- `docs/window-system-plan.md` - Complete architecture documentation
  - Window structure patterns
  - IPC communication patterns
  - Browser preview setup and workflow
  - Implementation learnings
  - Global broadcast pattern for settings sync

**Code:**
- `js/window-loader.js` - Shared loader for all secondary windows
  - Context detection (Electron vs browser)
  - Bridge creation with IPC wrappers
  - Chrome setup (close button, focus/blur)
  - Theme listener registration
  - Mock system for browser preview
  
- `html/help.html` - First window implementation
  - NUI framework structure
  - Keyboard shortcuts documentation
  
- `css/window.css` - Window layout rules

### Key Files Modified

- `js/app.js` - Main process theme state and broadcast
- `js/stage.js` - Theme integration, same-screen window positioning
- `js/window-loader.js` - Theme handling for all windows
- `README.md` - Added keyboard shortcuts table

### Architecture Patterns Established

**Global Command Pattern:**
```javascript
// Any window
tools.sendToMain('command', { command: 'toggle-theme' });

// Main process
function mainCommand(e, data) {
  if(data.command === 'toggle-theme') {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    tools.broadcast('theme-changed', { dark: currentTheme === 'dark' });
  }
}
```

**Same-Screen Positioning:**
```javascript
let displays = await helper.screen.getAllDisplays();
let targetDisplay = displays.find(d => 
  stageBounds.x >= d.bounds.x && 
  stageBounds.x < d.bounds.x + d.bounds.width
);
```

### Ready for Next Phase
- Settings window implementation
- Playlist window with virtualized list
- Additional windows per backlog

---

## Session: December 22, 2025 - GitHub Setup & Documentation

### What We Accomplished

**GitHub Repository Setup - COMPLETE ✅**
- Fixed README screenshot display issue
  - Root cause: Screenshot file wasn't committed to repository
  - Added `build/screenshot.png` to git
  - Updated README to use raw GitHub URL: `https://raw.githubusercontent.com/herrbasan/SoundApp/main/build/screenshot.png`
  - Screenshot now displays correctly on GitHub

**Project Licensing - COMPLETE ✅**
- Analyzed all project dependencies (MIT licensed: nui, electron_helper, native-registry, chiptune)
- Selected MIT License as best fit for open source desktop application
- Created and committed LICENSE file
- Project is now properly licensed for open source distribution

**Documentation Updates:**
- Updated `.github/copilot-instructions.md` with window system summary
- Added compact architecture overview to main instructions
- Documented window management patterns, global settings broadcast, and window creation workflow

### Commits Made
1. `Fix screenshot path in README` - Initial path fix attempt
2. `Add screenshot image and use raw URL in README` - Committed screenshot file and used raw URL
3. `Add MIT License` - Added MIT License file
4. `Add window system summary to instructions` - Updated copilot-instructions.md

### Window System Status Summary
**Foundation Complete:**
- Core window system with NUI framework ✅
- window-loader.js with Electron/browser detection ✅
- Help window with keyboard shortcuts ✅
- Window reuse and cleanup system ✅
- Theme broadcasting across windows ✅
- Browser preview mode ✅

**Next Up:**
- Settings window (settings.html)
- Playlist window (playlist.html)
- Future: waveform, mixer, converter windows

### Notes for Next Session
- Window system architecture is complete and documented
- Foundation is solid for creating additional windows
- Follow help.html template for new windows
- Use window-loader.js bridge API for IPC communication

---

## Session: December 22, 2025 - Settings Window & HQ Mode Implementation

### What We Accomplished

**Settings Window - COMPLETE ✅**
- Created `html/settings.html` with NUI framework components
- Implemented HQ Mode toggle using NUI checkbox (not custom toggle switch)
- Added default directory browser with path display
- Integrated with centralized CSS in `css/window.css`
- Settings persist via electron_helper config system

**HQ Mode Feature - COMPLETE ✅**
- Configurable sample rate for audio playback (44.1kHz standard vs 192kHz HQ)
- Modified FFmpeg NAPI decoder C++ code to accept configurable output sample rates
  - Changed `OUTPUT_SAMPLE_RATE` from static const to member variable `outputSampleRate`
  - Updated constructor signature: `FFmpegDecoder(int sampleRate = 44100)`
  - Modified SwResample initialization to use dynamic sample rate
- AudioContext now created with configurable sample rate
- Sample rate detection probes hardware: 192k→176.4k→96k→88.2k→48k→44.1k
- Real-time switching: destroys and recreates AudioContext, FFmpegPlayer, chiptune player
- Audio system info display shows max supported and current sample rates
- Measured CPU impact: 44.1kHz peaks at 1.5%, 192kHz peaks at 2.3% (~0.5% difference)

**Navigation Rate Limiting - COMPLETE ✅**
- Added 100ms rate limiting for next/previous track keyboard shortcuts
- Prevents rapid track skipping and UI flashing

**Centralized Keyboard Shortcuts - COMPLETE ✅**
- Created `js/shortcuts.js` module for shared shortcut definitions
- H (Help), S (Settings), X (Theme) work from any app window
- Shortcuts only active when app windows have focus (not system-wide)
- Input field detection prevents interference with typing
- Help/Settings windows forward shortcuts to stage via IPC bridge

**Window Management Improvements - COMPLETE ✅**
- Windows now hide/show instead of close/create for reliable toggling
- Visibility state tracked with `g.windowsVisible` object
- Focus returns to stage window when hiding/closing secondary windows
- Fixed bug: `tools.executeOnId` doesn't exist - was causing windows to respawn

### Key Files Created/Modified

**New Files:**
- `html/settings.html` - Settings dialog with HQ mode toggle, directory browser, audio info
- `js/shortcuts.js` - Centralized keyboard shortcut definitions
- `docs/settings-ideas.md` - Potential future settings features

**Modified Files:**
- `libs/ffmpeg-napi-interface/src/decoder.h` - Configurable sample rate support
- `libs/ffmpeg-napi-interface/src/decoder.cpp` - Dynamic sample rate implementation
- `libs/ffmpeg-napi-interface/src/binding.cpp` - Pass sample rate to decoder
- `bin/win_bin/player.js` - Create decoder with AudioContext sample rate
- `js/stage.js` - Sample rate detection, HQ mode toggle, window management fixes
- `js/window-loader.js` - Added hide-window listener, removed duplicate theme handler
- `css/window.css` - Settings window specific styles
- `html/help.html` - Keyboard shortcut updates (Q→S)
- `.github/copilot-instructions.md` - Removed help window from backlog

### Technical Insights

**FFmpeg NAPI Sample Rate Fix:**
```cpp
// Before: Hardcoded 44100Hz
static const int OUTPUT_SAMPLE_RATE = 44100;

// After: Configurable per instance
int outputSampleRate;
FFmpegDecoder(int sampleRate = 44100) : outputSampleRate(sampleRate) {}
```

**Sample Rate Detection:**
```javascript
async function detectMaxSampleRate() {
  const rates = [192000, 176400, 96000, 88200, 48000, 44100];
  for(let rate of rates) {
    try {
      let ctx = new AudioContext({ sampleRate: rate });
      if(ctx.sampleRate === rate) { ctx.close(); return rate; }
    } catch(e) {}
  }
  return 44100; // Fallback
}
```

**Window Visibility Tracking Fix:**
```javascript
// Bug: tools.executeOnId doesn't exist
let isVisible = await tools.executeOnId(g.windows[type], 'isVisible'); // ❌ Throws error

// Solution: Track state ourselves
g.windowsVisible = { help: false, settings: false, playlist: false };
if (g.windowsVisible[type]) {
  tools.sendToId(g.windows[type], 'hide-window'); // ✅ Works reliably
}
```

### Architecture Decisions

**Why HQ Mode is Optional:**
- CPU impact minimal but measurable (~0.5%)
- Nyquist theorem: 44.1kHz sufficient for human hearing (20kHz)
- Placebo effect consideration for professional users
- User preference: keep as toggle for flexibility

**Why Hide/Show Instead of Close/Create:**
- Reliable window IDs (no recreation needed)
- Windows remember state (scroll position, etc.)
- Simpler code - no async visibility checks
- Better UX - instant toggle response

**Centralized Shortcuts Strategy:**
- Not globalShortcut (would capture keys system-wide)
- Window-level keydown listeners in each window
- Forwards to stage via IPC for unified handling
- Input field detection prevents typing interference

### Bugs Fixed (with Claude Opus's help)

1. **Window Toggle Spawning New Windows**
   - Root cause: `tools.executeOnId()` doesn't exist in helper library
   - Every toggle threw error, caught by try/catch, reset window ID to null
   - Solution: Track visibility with `g.windowsVisible` object

2. **Theme Toggle Double-Flash**
   - Root cause: X key handled in both window-loader.js AND shortcuts.js
   - Caused rapid toggle-then-revert effect
   - Solution: Removed duplicate handler from window-loader.js

3. **Settings Not Persisting**
   - Root cause: Config set in two places causing value inversion
   - `settings-changed` handler set config, then `toggleHQMode` toggled it again
   - Solution: Removed hqMode from settings-changed handler

### Performance Metrics

**HQ Mode CPU Usage (measured during playback):**
- Standard (44.1kHz): Peaks at 1.5% CPU
- HQ Mode (192kHz): Peaks at 2.3% CPU
- Difference: ~0.5% (negligible on modern hardware)

**Sample Rate Hardware Support (tested system):**
- Maximum supported: 192000 Hz ✅
- Tested and working at: 192k, 96k, 48k, 44.1k

### Ready for Next Phase

**Settings Window Complete:**
- ✅ HQ mode toggle with real-time switching
- ✅ Default directory browser
- ✅ Audio system info display
- ✅ Settings persistence
- ✅ NUI framework integration

**Future Settings (documented in docs/settings-ideas.md):**
- Output device selection
- Always scan folder
- Resume last position
- Stereo separation for MOD files
- Master volume default
- Always on top

### State of the Codebase

**Working Features:**
- Multi-window system with hide/show toggle ✅
- Centralized keyboard shortcuts (H, S, X) ✅
- Theme toggle across all windows ✅
- HQ mode with configurable sample rates ✅
- Settings persistence ✅
- Focus management ✅

**Next Immediate Steps:**
1. Test HQ mode with various file formats
2. Consider adding more settings from settings-ideas.md
3. Playlist window implementation

---

## Session: December 24, 2025 - Multi-Track Mixer Prototype

### What We Accomplished

**Multi-Track Mixer Prototype - COMPLETE ✅**
- Created a standalone mixer prototype in `mixer/` folder.
- Implemented a custom `AudioWorklet` mixing engine (`soundapp-mixer`) supporting 128 tracks.
- Designed a compact, responsive UI with channel strips that wrap and fill space.
- Implemented drag-and-drop for adding and replacing tracks.
- Added track removal, solo/mute logic, and metering.
- Refactored the control bar (Play/Pause, Reset, Master Volume).
- Implemented a dynamic "empty state" for the Add zone.
- Established collaboration rules for Gemini 3 Flash in `copilot-instructions.md`.

**Key Files Added/Modified:**
- `mixer/js/main.js` - Main UI controller and logic.
- `mixer/js/mixer_engine.js` - Audio context and node management.
- `mixer/css/main.css` - Mixer styling (Grid layout, tooltips, controls).
- `mixer/index.html` - Standalone prototype entry point.
- `.github/copilot-instructions.md` - Added collaboration rules.

### Technical Insights

**CSS Grid for Responsive Strips:**
- Switched from Flexbox to CSS Grid for channel strips.
- Used `grid-template-columns: repeat(auto-fit, minmax(2.7rem, 1fr))` to ensure consistent widths across rows while filling available space.
- This solved the issue where wrapped items in Flexbox would not align vertically with the row above.

**AudioWorklet Mixing:**
- Implemented a custom `AudioWorkletProcessor` for mixing.
- Used `setTargetAtTime` for smooth master volume control.
- Direct parameter control via `AudioParam` or message passing is essential for smooth audio manipulation.

**Collaboration & Workflow:**
- **Lesson Learned:** It is crucial to announce intentions and wait for user confirmation before creating new files or making major architectural changes (e.g., the premature `mixer.html` creation).
- Added specific rules to `.github/copilot-instructions.md` to enforce this behavior for Gemini 3 Flash.

### Next Steps
1.  **SoundApp Integration:** Create `html/mixer.html` and `js/mixer.js` to integrate the mixer into the main Electron app.
2.  **Playlist Handoff:** Implement logic to transfer the main stage playlist to the mixer.
3.  **Refinement:** Polish the UI and add more advanced mixing features (EQ, Pan, etc.).

---

## Session: December 25, 2025 - Mixer Window System Integration (WIP)

### What We Accomplished

**Mixer window added to the SoundApp window system (Electron + browser preview):**
- Created a NUI-style mixer window page and assets:
  - `html/mixer.html`
  - `css/mixer.css`
  - `js/mixer/main.js`, `js/mixer/mixer_engine.js`, `js/mixer/mixer-worklet-processor.js`
- Ensured browser preview works via existing `js/window-loader.js` bridge pattern.

**Stage integration + playlist handover:**
- Added `M` shortcut to open mixer.
- Stage hands over the current playlist (first 20 items) to the mixer via `init_data.playlist.paths`.
- Stage stops its own playback when opening the mixer.

**Stability + cleanup:**
- Fixed a CSS class collision with NUI window layout that broke mixer rendering.
- Added mixer reset/cleanup logic so mixer state does not leak between sessions.
- Improved window close notification so Stage reliably cleans up `g.windows.*` even on OS-level close.

### Notes / Limitations (Known)

- Network-drive / custom-protocol loading for the mixer’s `fetch()` path is still under investigation; current mixer URL strategy was rolled back to keep local paths working.

---

## Session: December 25, 2025 - Mixer Sync Fixes + Diagnostics

### What We Accomplished

**Fixed “added track is permanently delayed” when drag & dropping into the mixer:**
- Root cause: dropped items often lacked a usable filesystem path string, so the mixer fell back to buffer decoding (`buf`) instead of FFmpeg streaming (`ff`). Mixed pipelines led to a persistent offset.
- Fix: in Electron, resolve dropped `File` objects to absolute filesystem paths (matching Stage’s drop strategy) so new tracks consistently load via the FFmpeg streaming path.

**Added a timing/sync diagnostics overlay (hidden by default):**
- Floating overlay with per-track mode (`ff`/`buf`), time, drift vs transport/reference, queue depth, and underrun metrics.
- Toggle with `Ctrl+Shift+D`.
- Snapshot button copies a JSON dump of current diagnostics to clipboard.

**Reduced apparent drift caused by worklet message cadence:**
- Worklet position updates arrive about every 50ms.
- `FFmpegStreamPlayer` now extrapolates current time using `AudioContext.currentTime` since the last reported position, reducing “false” drift in the overlay.

**Improved seeking sync when all tracks are FFmpeg-streamed:**
- When seeking while playing and all tracks are `ff`, the mixer now seeks in-place per track (avoids stop/restart ordering seams).
- If any track is `buf`, seeking falls back to the restart approach.

**Stage → Mixer refresh reliability:**
- “Open in Mixer” now force-shows the existing mixer window and always sends an updated `mixer-playlist`.
- Mixer reset on new playlist preserves `initData` so FFmpeg stays available (prevents unexpected `buf` fallback after refresh).

## Session: December 26, 2025 - Mixer Synchronization & Robust Streaming

### What We Accomplished

**Mixer Synchronization:**
- Implemented a **Scheduled Start** strategy for the multi-track mixer.
- Added a 200ms pre-roll buffer:
  - MixerEngine schedules playback to start at currentTime + 0.2s.
  - FFmpegStreamProcessor outputs silence until the scheduled start time is reached.
  - MixerTransport display logic updated to account for this offset, ensuring dT (delta Transport) shows ~0.0ms.
- Result: Perfect synchronization between tracks and the visual transport, eliminating drift.

**Robust FFmpeg Streaming:**
- Fixed a critical regression in fmpeg-worklet-processor.js where currentFrame or sampleRate could be undefined in some AudioWorklet environments.
- Added safety checks:
  - sampleRate falls back to 44100 if global is missing.
  - Time calculation checks currentFrame first, then falls back to currentTime.
- Updated player.js to allow re-triggering play() for seamless seeking updates.
- Verified that the streaming implementation is now robust enough to be the primary method, removing the need for a full-decode fallback experiment.

**Codebase Maintenance:**
- Synced the robust fmpeg-worklet-processor.js and player.js changes to the fmpeg-napi-interface submodule.
- Updated in/win_bin and in/linux_bin via the sync-ffmpeg-napi.ps1 script.


## Session: December 26, 2025 - Multitrack Preview & UX Improvements

### What We Accomplished

**Multitrack Preview (formerly Mixer):**
- Renamed "Mixer" to "Multitrack Preview" throughout the application (UI, Window Title, Dropzone).
- Changed "M" shortcut behavior: Now opens the Multitrack Preview with the currently playing file and its siblings (files in the same folder), instead of sending the entire playlist.
- Updated js/stage.js to implement getMixerPlaylist logic for context-aware opening.

**UX & Layout Improvements:**
- **Dropzone Layout:** Implemented a new 2-column grid layout for the dropzone overlay.
  - Left column (70%): "Add to Playlist" and "Replace Playlist".
  - Right column (30%): "Multitrack Preview" (full height).
- **Settings Window:** Added a "Clear" (x) button to the Default Directory input field, allowing users to easily unset the startup folder.
- **Startup Behavior:** Modified js/stage.js to respect an empty default directory. The app now starts with no files loaded if the default directory is not set (previously defaulted to the OS Music folder).
- **Empty Playlist Fix:** Fixed "Add to Playlist" dropzone behavior. Dropping files onto "Add to Playlist" when the playlist is empty now correctly creates a new playlist and starts playback immediately.

**Files Modified:**
- js/stage.js
- html/mixer.html
- html/settings.html
- css/main.css
"@
git add .
git commit -m "Multitrack Preview rename, UX improvements, and startup fixes"
git push origin main
git add .; git commit -m "Multitrack Preview rename, UX improvements, and startup fixes"; git push origin main
git status
git add . ; git commit -m "Multitrack Preview rename, UX improvements, and startup fixes" ; git push origin main
