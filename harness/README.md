# Memory Harness (Electron)

This folder contains a standalone Electron **memory leak test harness** used to reproduce and isolate memory growth issues in the streaming/mixer pipeline.

The harness runs unattended by default and prints all relevant output to the terminal.

## Run

From repo root:

- `npm run harness`

This launches an Electron window and starts autopilot automatically.

## Modes

### 1) Matrix / A-B mode (default)

Default behavior is a **test matrix**: it runs multiple variants back-to-back in **fresh renderer windows** and prints a final summary.

At the end you will see a block like:

- `[HARNESS][AB] ===== FINAL SUMMARY =====`
- One line per variant: `multiDeltaMB= ... exp= {...}`

This is intended for fast, hands-free A/B comparisons.

### 2) Single-run mode (legacy)

Disable the matrix and run the “full” autopilot (single + decoder-only + multi) in one window:

PowerShell:

- `$env:HARNESS_NO_MATRIX = '1'; npm run harness`

(Reset for future shells: `Remove-Item Env:HARNESS_NO_MATRIX`)

## What it tests

The harness has three core scenarios:

- **Single-track** (Stage-like): open/seek/play/stop cycles on one player.
- **Decoder-only**: open/read/seek/read/close using the native decoder **without** AudioContext/AudioWorklet.
- **Multi-track** (Mixer-like): N players open/seek/scheduled-start/stop cycles.

In matrix mode the harness currently runs only the **multi-track stems test** per variant (fast, comparable).

## Output you should watch

The key signal is **process memory** vs **JS heap**:

- JS heap is reported as `jsHeapMB` (often stays near baseline).
- Renderer process growth is visible in:
  - `[HARNESS][RENDERER] ... rssMB: ...`
  - `[HARNESS][MEM] ... procs: ... { type: 'Tab', wsMB, privMB }`

If `jsHeapMB` stays flat but `Tab` memory grows, the retention is likely **outside V8** (audio graph/worklet/native buffers/Chromium internals).

## Understanding A/B (matrix) results

Each variant flips a small set of experiment toggles. The harness prints a final summary:

- `multiDeltaMB` is the growth during that variant’s multi-track run.

Interpretation:

- If `multiDeltaMB` drops near 0 for a variant, that toggle strongly implicates the corresponding subsystem.
- If `disableAggressiveFill` reduces growth, the leak is likely triggered by queue-fill/buffering behavior.
- If only `recreateContextPerIter` helps (when enabled), retention is likely tied to AudioContext/AudioWorklet lifecycle.

## Findings so far (Dec 2025)

What we’ve learned from repeated A/B runs:

- **The growth is mostly outside the JS heap.** `jsHeapMB` stays roughly flat while renderer/Tab memory (`rssMB`, `wsMB`/`privMB`) grows, pointing at AudioWorklet / native / Chromium-side retention rather than a classic JS object leak.

- **The dominant trigger is “burst enqueueing” into the AudioWorklet.** The “aggressive fill” pattern (posting many Float32Array chunks quickly) correlates strongly with memory growth. Disabling aggressive fill consistently reduces `multiDeltaMB`.

- **Backpressure helps.** A per-burst cap (`fillBurstMax`) was added to the streaming player’s internal queue fill to avoid huge bursts that create large message/backlog pressure. Sweeps show that **very high caps (e.g. 64) are clearly worse** than smaller caps.

- **Baseline already includes a default cap.** In matrix output, `fillBurstMax: 0` means “no override from the harness”, not “uncapped”. The player itself defaults to a capped value (currently 16), which is why baseline often matches the `fillBurstMax 16` variant.

- **Transferable chunk messaging helps, but doesn’t beat real backpressure.** Enabling `transferChunks` (sending `ArrayBuffer` via transfer list instead of posting `Float32Array` chunks by value) reduced growth in the latest run (baseline `multiDeltaMB=115` → `transferChunks=77.6`), suggesting a meaningful portion of the growth is tied to message copying/backlog pressure. However, `disableAggressiveFill` was still better in the same run (`multiDeltaMB=50`).

- **“Dispose too fast” is not the main explanation.** We added a short settle window after stopping tracks and deferred port close/disconnect slightly so the worklet has time to process `dispose`. This did **not** collapse baseline deltas toward ~0MB, so the remaining growth is unlikely to be just a measurement race.

Working hypothesis: memory growth is driven by worklet message/backlog/buffering behavior under multi-track stress (and/or slow reclamation in Chromium’s audio/worklet plumbing), and the highest-value mitigation is to keep queue fill bounded and avoid posting large bursts.

## Suggested next steps (to move the needle)

Based on the latest matrix results (especially `dropChunksWorklet` still growing, and the strong sensitivity to `chunkSeconds`), the most likely “single subsystem” retaining memory is **Chromium-side AudioWorklet/MessagePort allocation/backlog behavior** under sustained chunk messaging. This is largely outside the JS heap, so it won’t look like a classic JS leak.

Two practical next steps:

- **Ship a smaller `chunkSeconds` default (e.g. 0.02s)** and scale `prebufferChunks` to keep buffered *seconds* roughly constant.
  - This changes the message/alloc pattern and in recent runs produced the largest delta reduction.
  - Goal: reduce the amount of memory churn that seems to stick in the renderer/Tab process.

- **Long-term “hard fix”: replace per-chunk `postMessage` with a bounded ring buffer** (ideally `SharedArrayBuffer` + `Atomics`).
  - This makes memory usage **bounded and reusable by design** and avoids relying on the browser’s message queue to promptly release large amounts of transferred/copied audio data.
  - This is a larger refactor, but it directly targets the suspected retention mechanism.

## Editing the matrix (variants)

Edit the variant list in:

- [harness/main.js](main.js)

Look for `VARIANTS = [...]`.

Each entry has:

- `id`: label shown in logs
- `title`: human-readable name
- `exp`: experiment flags applied for that run

Example:

```js
{ id: 'B1', title: 'disableAggressiveFill', exp: { disableAggressiveFill: true } }
```

## Editing experiment toggles

Experiment flags are defined in:

- [harness/renderer.js](renderer.js)

They include:

- `disableAggressiveFill`
- `callFlushOnStop`
- `recreatePlayersPerIter`
- `recreateContextPerIter`

In matrix mode these are set automatically per variant.

## Test data paths

Autopilot uses these default folders (edit in `defaultPaths()` if needed):

- Stems: `D:\Work\_GIT\SoundApp\_Material\mixer_media`
- Single test files: `D:\Home\Music\Test Files`
- Optional archive: `Y:\# Audio Archive\# Archived Music - Reason Projects`

Matrix mode only scans/runs the stems set.

## Notes / Tips

- The harness forces `--expose-gc` and triggers GC between iterations to separate JS vs non-JS retention.
- Runs are intentionally short (limited iterations and hold time) to fit within log/monitoring constraints.
- Some FFmpeg warnings may appear in output; they are expected for certain files and not necessarily related to the leak.
