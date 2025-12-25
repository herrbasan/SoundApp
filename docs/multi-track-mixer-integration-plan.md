# Multi‑Track Mixer Integration Plan (SoundApp)

Date: 2025‑12‑24

## Current Status (what we have now)
We currently have a committed **browser‑runnable prototype** in `mixer/` that already implements the **AudioWorklet-based mixing engine** and most of the base mixer UI behavior.

**Prototype location (committed):**
- `mixer/index.html`
- `mixer/css/main.css`
- `mixer/js/main.js`
- `mixer/js/mixer_engine.js`
- `mixer/js/mixer-worklet-processor.js`

**Prototype media location (NOT committed):**
- `_Material/mixer_media/` (intentionally ignored by git)

**Repo housekeeping (already done):**
- The old `AudioWorklet/` prototype folder was renamed to `mixer/` and is intended to be committed.
- `_Material/` stays ignored so test media never ships.

**What is already true in the prototype:**
- Tone.js is fully removed.
- Mixing runs inside an `AudioWorkletProcessor` (`soundapp-mixer`) with per-track gain/pan/mute and peak meters.
- UI uses shared SoundApp NUI modules (`libs/nui/*`) and shared NUI CSS.

**Already implemented in the prototype (confirmed in code):**
- Per-track remove button (close/cross)
- Drag & drop replace (drop onto strip)
- Drag & drop add (trailing “+” drop zone)
- Track name display via hover tooltip (shows filename)

**What is NOT implemented yet (still required):**
- No additional mixer UI changes are required beyond the current prototype.

**What is NOT integrated into SoundApp yet (separate window):**
- No `html/mixer.html` / `js/mixer.js` window.
- No Stage → Mixer playlist handoff.
- No “stop Stage on mixer open” wiring.
- No FFmpeg streaming per track yet (prototype uses buffered decode via `fetch + decodeAudioData`).

## Goal
Add a **separate multi‑track mixer window** that loads **the current SoundApp playlist** as multiple parallel tracks, with **simple mixer controls**:

- Volume (fader)
- Pan
- Mute
- Solo
- Shared transport (play/pause, stop, seek bar)
- Track metering (simple level)

Additions required beyond the prototype:

None. The current prototype UI behavior is the target.

UI target: **Use the existing prototype UI from `mixer/` as-is** (layout and controls). Tone.js is already removed in the prototype.

Entry point: the mixer is opened from the main SoundApp player window (Stage). The mixer loads the **current playlist** (initially: first 20 items).

## Non‑Goals (for the first integration)
- No editing / trimming / rendering / export
- No additional UI beyond what is described in this document
- No “smart” playlist management, track naming UI, grouping, etc.
- No attempt to keep this window in perfect sync with Stage playback

## Current Prototype Summary (what we reuse)
The prototype in `mixer/` provides:

- HTML structure: `mixer/index.html`
- Mixer UI + logic: `mixer/js/main.js`
- Styling: `mixer/css/main.css`
- Controls behavior:
  - Gain slider maps to gain $0..2$ (linear)
  - Pan slider maps to pan $-1..+1$
  - Mute + Solo logic with “mute memory” behavior
  - Transport bar seek + play/pause state
  - Meter animation loop
  - Per-track remove (close/cross)
  - Drag & drop replace on strip
  - Drag & drop add via trailing “+” zone
  - Track name tooltip (filename)

What we replace:
- Prototype-only drag/drop file source behavior (browser `File` → `URL.createObjectURL`).
- Buffered decode sources (`fetch + decodeAudioData`) with SoundApp-native sources (FFmpeg buffered/streaming) during integration.

What we keep:
- DOM structure and CSS (as close as possible)
- Control behaviors and mapping

Notes:
- The current prototype is driven by drag & drop (no “folder/song select” UI).
- In SoundApp, the initial tracks come from Stage’s playlist; drag & drop remains useful for replace/add.

## Integration Architecture
### 1) New Mixer Window (Electron renderer)
Add a new window type `mixer` using the existing window system:

- New page: `html/mixer.html`
- Uses `js/window-loader.js` bridge pattern like other windows

**Data in `init_data` from Stage** (sent when window is created):
- `type: 'mixer'`
- `stageId`
- `config` (theme, outputDeviceId, HQ mode, etc.)
- `currentSampleRate` and `maxSampleRate` (already sent today)
- `playlist`:
  - list of file paths (prefer absolute, as Stage uses)
  - optional display names
  - optional “selected index”

### 2) Lightweight Mixer Engine (no Tone.js)
We already have a lightweight engine in the prototype (`mixer/js/mixer_engine.js`) that provides:

- A simple `Transport` with play/pause/stop/seek via AudioContext time
- `createTrack()` with per-track gain/pan/mute
- Per-track meters provided by the mixer worklet processor

During SoundApp integration, we keep the same conceptual API/behavior but swap track sources.

**Core concepts**
- One `AudioContext` in the mixer window (created at `currentSampleRate`)
- One `Transport` clock (wallclock driven by AudioContext)
- Per‑track signal chain:

```
[Track Source] -> GainNode -> StereoPannerNode -> (optional MeterTap) -> MasterGain -> Destination
```

**Track Source**
Two viable implementations; start with the simplest that fits SoundApp’s constraints:

A) Preferred (matches SoundApp architecture): **FFmpeg streaming per track**
- Use `FFmpegStreamPlayer` (NAPI decoder + AudioWorklet)
- Each track owns its own decoder + worklet node
- Track output connects into the track chain instead of directly to destination

B) Fallback (if A is too heavy early): **Buffered decode per track**
- Use `FFmpegBufferedPlayer` (if present) or decode-to-AudioBuffer
- Simpler, but memory heavy on long files

Recommendation: start with **A** because SoundApp already optimized for streaming + large files.

Note: the current prototype is effectively option **B** (buffered decode) and is used only for rapid iteration.

### 3) Required Refactor: `FFmpegStreamPlayer` routing
Today `FFmpegStreamPlayer` auto-connects to destination:

- It creates `this.gainNode` and immediately `connect(audioContext.destination)`.

For a mixer we need **routing control** (connect to track chain, not to destination).

Proposed minimal compatible change (both win + linux copies):
- Add constructor option `connectDestination=true`
- If `false`, do not connect `gainNode` automatically
- Expose an output AudioNode for chaining:
  - `player.output` (alias to `player.gainNode`)
- Add `connect(node)` helper (thin wrapper)

This keeps Stage behavior unchanged (default still connects to destination).

### 4) Metering (replacement for Tone.Meter)
The current prototype already implements **peak metering in the mixer AudioWorklet** and posts meter values to the UI (~30fps). For SoundApp integration we can keep this approach (preferred) or switch to per-track `AnalyserNode` if routing constraints require it.

## Data Flow / Responsibilities
### Stage window
- Owns the “current playlist” state.
- Opens/creates mixer window and sends playlist in `init_data`.
- Stops Stage playback when mixer opens (to avoid double audio output).

Confirmed behavior:
- Mixer starts at 0:00 (no sync-to-Stage position)

### Mixer window
- Owns multi-track playback state.
- Creates its own `AudioContext` configured like Stage (sample rate + sink).
- Loads each playlist item as a track.

## Phased Development Plan
### Phase 0 — Prototype groundwork (DONE)
Already completed in `mixer/`:

1. Prototype UI exists and is stable (NUI modules + CSS wired).
2. Tone.js removed.
3. AudioWorklet mixer implemented with transport + controls + meters.
4. Media moved out to `_Material/mixer_media` and is not committed.

Deliverable: a fast iteration target for UI/engine work.

### Phase 1 — Minimal SoundApp wiring + UI parity (NEXT)
1. Add a new window page `mixer.html` and hook it into Stage’s `openWindow()`.
2. Port the prototype HTML/CSS/JS into SoundApp’s window structure with minimal changes.
3. Confirm all controls visually match the prototype.

Deliverable: mixer window renders correctly with dummy channels.

### Phase 2 — Engine skeleton (single track, SoundApp source)
1. Implement `MixerTransport` (play/pause/stop/seek time + callbacks).
2. Integrate one `FFmpegStreamPlayer` track routed into Gain/Pan nodes.
3. Wire Play/Pause/Stop and the transport bar.

Deliverable: one file plays, seeks, stops.

### Phase 3 — Multi-track load from Stage playlist
1. Add `playlist` to `init_data` when opening mixer.
2. Create N tracks, open them, and start them synced at t=0.
3. Apply an initial cap: load at most 20 tracks from the current playlist (first integration).
3. Derive `duration` as max track duration (like prototype).

Deliverable: playlist files play together, shared seek.

### Phase 4 — Track labels + remove (prototype first)
1. Ensure remove cleans up audio nodes/players and updates duration if needed.

Deliverable: remove track works reliably in the integrated window.

### Phase 5 — Drag & drop replace / add (prototype first)
Status: already implemented in the prototype. During SoundApp integration, we need to:
1. Implement drop-on-strip using file paths (not `URL.createObjectURL`).
2. Implement trailing “+” drop zone using file paths.
3. Keep the >20 add-track behavior as best-effort (may be CPU heavy).

Deliverable: drag/replace and drag/add are usable and reliable.

### Phase 6 — Mixer controls
1. Implement gain mapping exactly like prototype.
2. Implement pan mapping exactly like prototype.
3. Implement mute/solo behavior exactly like prototype (including “mute memory”).

Deliverable: mixer controls behave exactly like the screenshot/prototype.

### Phase 7 — Metering
1. Add per-track meter tap.
2. Update bar heights in animation loop.

Deliverable: meters show levels while playing.

### Phase 8 — Hardening / limits
1. Initial playlist load cap: 20 tracks.
2. Add-track beyond 20 is allowed via the “+” drop zone (best-effort).
2. Decide unsupported-format behavior (skip or show silent track).
3. Validate stop/cleanup on window close.

Deliverable: stable, no leaks, predictable CPU.

## Confirmed Decisions
- Opening the mixer stops Stage playback.
- Mixer starts at 0:00.
- Initial playlist load is capped at 20 tracks.
- Add-track via the “+” drop zone can exceed 20 tracks.

## Standalone Workflow (must remain true)
The mixer window page `html/mixer.html` must remain runnable in a regular browser for fast UI iteration.
It should detect Electron vs browser via `js/window-loader.js` (same pattern as help/settings).

## Files likely to be touched (when implementing)
- `js/stage.js` (add `mixer` window type, send playlist in init_data)
- `html/mixer.html` (new)
- `js/mixer.js` (new window logic + UI glue)
- `css/` (either reuse prototype css or place window-local css)
- `bin/win_bin/player.js` and `bin/linux_bin/player.js` (optional routing refactor)

