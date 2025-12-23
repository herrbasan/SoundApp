# SoundApp Looping: Assessment + Plan (fresh-session handoff)

Date context: I’m assuming **Germany (CET/CEST)**. The chat system time may differ, but it doesn’t affect the technical conclusions.

## Executive summary
- We had **two distinct looping problems** mixed together:
  1) **HQ-mode crackle at loop** (mostly at high sample rates like 96k/192k).
  2) A more severe **“loops too early” regression** that appeared after swapping `libs/ffmpeg-napi-interface` versions and syncing its deployed JS into `bin/*`.
- The “too early loop” symptom points strongly to **EOF being signaled early** (or treated as final too aggressively), causing the AudioWorklet to mark the “last chunk” too soon → loop triggers before actual audio ends.
- The session became confusing because **the deployed copies** in `bin/win_bin/*` and `bin/linux_bin/*` were repeatedly overwritten by `scripts/sync-ffmpeg-napi.ps1`, while SoundApp’s own logic stayed in `js/*`. In practice, the **submodule is the source of truth**, and `bin/*` is “what the app actually runs”.

## What is currently known (high confidence)
### A. Baseline behavior
- With `libs/ffmpeg-napi-interface` checked out at **tag `v1.1.3`** and synced into `bin/*`, looping is reported as **correct / “perfect again”**.
- With newer versions (observed around `v1.1.8` and a specific commit mentioned in the prior session), looping can become **early** (loop triggers before the true end).

#### Verified repo state (Dec 23, 2025)
- In this workspace, `libs/ffmpeg-napi-interface` is currently at **`v1.1.3`** (HEAD tagged `v1.1.3`).
- The version range `v1.1.3..v1.1.8` includes changes in the streaming player/worklet (EOF gating + feed-loop restart) and large native changes (metadata/cover art extraction).

### B. Looping mechanism (FFmpeg streaming path)
- The FFmpeg streaming player uses an AudioWorklet processor and a queue of float32 chunks.
- For gapless looping it captures a **`loopChunk`** (first decoded chunk) and, when it thinks it reached end-of-stream, it plays that `loopChunk` while the main thread seeks back to 0 and refills the queue.
- Therefore, if the system **believes EOF too early**, it will mark the last chunk too early and loop early.

#### Concrete worklet behavior (as implemented)
- Worklet receives `{type:'eof'}` and marks **the most recently queued chunk** as `isLast`.
- When the playback cursor reaches the end of that `isLast` chunk (and looping is enabled), the worklet immediately switches to `loopChunk` and emits `loopStarted` back to the main thread.

### C. A likely weak spot in current JS logic
- In `libs/ffmpeg-napi-interface/lib/player.js`, `_decodeAndSendChunk()` treats `samplesRead <= 0` as EOF immediately and posts `{type:'eof'}` to the worklet.
- That behavior is correct **only if** the native decoder never returns a transient 0 before true EOF (e.g., due to buffering, decoder pipeline state, or a decode/read protocol mismatch).

#### Verified: the JS/native contract currently cannot distinguish EOF vs error
- The NAPI `read()` wrapper returns only `{ buffer, samplesRead }` (no `eof` / no error status).
- In native `FFmpegDecoder::read()`, `decodeNextFrame()` returns `0` on true EOF, and `-1` on error; however, `read()` treats **`decoded <= 0`** as a stop condition and returns whatever was read so far (which can be `0`).
- Result: from JS, **`samplesRead === 0` can mean “true EOF” OR “decoder error”**, and the current JS immediately converts that into `{type:'eof'}`.

### D. Native decoder in `v1.1.3` (observed)
- `src/decoder.cpp`’s `FFmpegDecoder::read()` returns `0` on:
  - true EOF
  - *or* decode error (because `decodeNextFrame()` returns `-1` and we `break` the read loop).
- There is no explicit “error vs eof” status surfaced to JS, so JS currently can’t distinguish these cases.

#### Diff notes: `v1.1.3` → `v1.1.8` (relevant to looping)
- Worklet: adds `reachedEOF` and changes “ended” to only fire after EOF has been reached (reduces false-ended when queue is briefly empty).
- Player: stops the feed loop when `decoderEOF` is true, and explicitly restarts the feed loop after `loopStarted` and after `seek()`.
- The above changes are logically sound, but they don’t resolve the core ambiguity: a `samplesRead === 0` still immediately posts `{type:'eof'}`.

## What is still uncertain (needs measurement)
1) Whether “too early loop” is caused by:
   - A transient “empty read” / premature EOF signal from native (or from JS logic), **or**
   - Worklet logic changes (“ended” gating / `reachedEOF` flags) causing last-chunk selection or queue draining to behave differently, **or**
   - A seek/skip mismatch around `loopChunkFrames` (off-by-one chunk, sample alignment issues), **or**
   - Chunk size changes (buffering cadence) interacting with the above.
2) Whether the bug is on the JS side (player/worklet) or native side (decoder). The prior diff review suggested newer native changes were mainly metadata-related, but we still need to **verify runtime behavior**.

## Key failure mode hypothesis (most likely)
### Hypothesis H1: “early EOF” is signaled and latched
- Somewhere in newer code paths, `decoder.read()` returns `0` **before the real end** (or the JS wrapper interprets it as final too early).
- JS posts `{type:'eof'}` to the worklet.
- The worklet then marks the *current* last queued chunk as “final”.
- Playback reaches that chunk and loops early.

Why H1 fits:
- The symptom is not a small seam/crackle; it’s a **wrong loop point** (time is cut off).
- The loop system is explicitly driven by an EOF message.

## Secondary hypothesis (HQ crackle, separate issue)
### Hypothesis H2: HQ crackle is resampler / boundary behavior
- When output sample rate is high (HQ mode), the loop boundary is more sensitive to:
  - resampler state, 
  - buffer scheduling/underrun,
  - and discontinuities when seeking and re-priming the pipeline.
- This can produce a click/crackle even if the loop point is correct.

#### HQ discussion notes (Dec 23, 2025)
- In the **AudioWorklet streaming path**, WebAudio does **not** automatically resample “raw PCM chunks” for us. The worklet runs at the AudioContext sample rate, and samples written to `outputs[][]` are interpreted at that rate.
- Therefore, “FFmpeg outputs at file-native sample rate and WebAudio does the rest” is only viable if the stream is routed through nodes that perform resampling (e.g. `AudioBufferSourceNode` with an AudioBuffer that has its own sample rate). It is not automatic for the current worklet PCM push model.
- A likely HQ crackle driver (even when pitch/speed is correct) is **time-domain buffering shrinking at higher sample rates** due to fixed chunk sizes and fixed prebuffer/refill counts.
   - Example: if chunk length is fixed in frames, then at 192 kHz each chunk represents far fewer milliseconds than at 44.1 kHz.
   - If the app prebuffers “10 chunks” and refills “15 chunks” regardless of sample rate, the buffer-ahead time in seconds collapses in HQ mode, making underruns at the loop transition more likely.
- Working hypothesis for HQ crackle (separate from early-loop regression): the loop transition (worklet plays `loopChunk` while main thread seeks+refills) is more likely to underrun or hit discontinuities at high sample rates unless chunking + prebuffer are made **time-based**.

#### Proposed strategy (Option A): time-based chunking + real prebuffer support
- Use a target **chunk duration** (e.g. ~80–120 ms) and compute `framesPerChunk = round(audioContext.sampleRate * chunkSeconds)`.
- Keep `prebufferSize` in **chunks**, but ensure it represents a stable **time window** across sample rates (or make prebuffer also time-based).
- Feed loop should be driven by **queue depth** telemetry (e.g. `queuedChunks`) rather than a fixed `setTimeout(20ms)` cadence.

Important: H2 is “sound quality at loop”, while H1 is “loop point wrong”. Don’t mix them in the same debugging session.

## Strong recommendation for the next session
Start with **fixing “loops too early” (H1)** first, using a controlled regression test and instrumentation. Once the loop point is correct across versions, then tackle HQ crackle separately.

---

## Plan: make looping reliable again (step-by-step)

### Phase 0 — Lock down “source of truth”
Goal: ensure we’re testing the code we think we’re testing.
1) Decide which code is authoritative:
   - Use `libs/ffmpeg-napi-interface` as source.
   - Always run `scripts/sync-ffmpeg-napi.ps1` after changing submodule revision so `bin/*` matches.
2) Confirm at runtime which player/worklet is used:
   - The app uses `bin/win_bin/player.js` and `bin/win_bin/ffmpeg-worklet-processor.js` (Windows), so those must reflect the intended version.

Deliverable: a repeatable “checkout → sync → run” workflow.

### Phase 1 — Create a minimal reproduction harness
Goal: reproduce early-loop deterministically on 1–2 files.
1) Pick one short FLAC (and optionally an MP3) where early looping is obvious.
2) Define fixed settings for the reproduction:
   - Loop enabled.
   - HQ mode off.
   - A known chunk size (e.g., 2048/4096/8192) and thread count (whatever defaults are known-good).
3) Confirm:
   - `v1.1.3`: loop point correct.
   - `v1.1.8` (or known-bad commit): loops early.

Deliverable: a checklist with file names and expected behavior.

### Phase 2 — Add targeted instrumentation (minimal, low-risk)
Goal: measure whether EOF is posted early and why.

Add logging in **both** main thread and worklet (only during debug builds):
1) In player (`player.js`):
   - Log every `_decodeAndSendChunk()` result: `samplesRead`, `decoderEOF`, cumulative samples sent.
   - Log when posting `{type:'eof'}`.
   - Log seek/skip behavior when receiving `loopStarted` from worklet:
     - `loopChunkFrames`, how many samples are discarded, and the first chunk after seek.
2) In worklet (`ffmpeg-worklet-processor.js`):
   - Log when EOF is received.
   - Log which chunk index is marked as last.
   - Log when `loopStarted` is emitted.
   - Log queue depth around EOF/loop.

Success criteria:
- On a bad version, we should see `{type:'eof'}` posted while there is still real audio left.

Deliverable: a short log snippet that clearly shows the wrong event ordering.

### Phase 3 — Confirm whether native `read()` can return transient 0
Goal: distinguish “true EOF” from “no output yet / pipeline state / error”.

Best approach (native):
- Add two fields to the JS `read()` return object:
  - `eof: boolean`
  - `error: boolean` (or errorCode)
- In `decodeNextFrame()` / `read()` track:
  - AVERROR_EOF vs other errors.
  - If it’s not EOF but `decodeNextFrame()` returns -1, surface `error`.

Alternate approach (JS-only quick guard):
- Treat a single `samplesRead === 0` as “maybe EOF”, but require **N consecutive empty reads** before posting `{type:'eof'}`.
- This is a workaround; still do native status later.

Deliverable: proof that early-loop correlates with premature EOF signaling.

### Phase 4 — Implement the minimal correct fix
Goal: make loop point correct in all modes without adding crossfades.

Preferred fix:
1) Native decoder returns explicit EOF state.
2) JS posts `{type:'eof'}` only when `eof === true`.
3) Worklet should only mark the last chunk on true EOF.

If JS-only workaround is needed temporarily:
- Require (for example) 3 consecutive empty reads spaced over multiple feed ticks before declaring EOF.
- Reset that empty-read counter on any successful read.

Success criteria:
- Known-bad version no longer loops early.
- No regressions on v1.1.3 behavior.

### Phase 5 — Regression test matrix
Goal: ensure this doesn’t come back.
- Formats: FLAC, MP3, OGG.
- Loop on/off.
- Seek + loop.
- Vary chunk size.

Deliverable: documented “smoke test” list.

---

## After looping is correct: separate plan for HQ crackle
Only start this once early-loop is solved.
1) Re-enable HQ mode and reproduce crackle at loop.
2) Determine whether crackle is caused by:
   - underrun around the seek/refill window,
   - resampler state reset,
   - or discontinuity caused by loopChunk vs post-seek chunk mismatch.
3) Fix candidates (in order):
   - Increase prebuffer burst during loop transition.
   - Ensure `loopChunk` length and post-seek skip match exactly in frames.
   - Consider preserving/resuming resampler priming (native) rather than hard restarting.

No crossfade unless explicitly desired (it was tried and rejected).

---

## Practical “new session” checklist
1) Verify submodule revision: `libs/ffmpeg-napi-interface`.
2) Run `scripts/sync-ffmpeg-napi.ps1`.
3) Run the app and reproduce on the known test file.
4) Enable instrumentation and capture logs.
5) Decide: native EOF flag vs JS-only consecutive-empty workaround.
6) Implement fix in the submodule, re-sync, and re-test.

## Version discipline (avoid future confusion)
- SoundApp executes the deployed copies under `bin/win_bin/*` / `bin/linux_bin/*`; these are typically overwritten by `scripts/sync-ffmpeg-napi.ps1` from the submodule `libs/ffmpeg-napi-interface/lib/*`.
- When applying changes, be explicit about the baseline:
   - **Option “up”**: start from known-good `v1.1.3` and add changes forward.
   - **Option “down”**: start from latest (e.g. `v1.1.8`) and re-introduce correctness from `v1.1.3`.
- Do not patch `bin/*` directly unless it’s an intentional one-off experiment; the authoritative edits should be made in the submodule and then synced.

## Notes about session confusion (what to avoid next time)
- Don’t mix SoundApp UI/settings work with low-level loop debugging in the same run.
- Avoid frequent “sync back and forth” without recording which version is currently deployed to `bin/*`.
- Keep a single reproduction file + a single expected loop point until the root issue is fixed.
