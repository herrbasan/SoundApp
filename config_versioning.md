# Config Versioning

This document is the canonical record of SoundApp’s persisted **user config** structure over time.

The goal is to:
- make config migrations explicit and reviewable
- prevent accidental breaking changes (especially once nested structures exist)
- provide a stable reference for future refactors

## Rules

- The **single source of truth** is the main-process config managed by `helper.config.initMain('user', defaults)`.
- We strive to have **defaults for everything**. Config reads must be resilient:
  - Missing keys get repaired to defaults.
  - Corrupted/failed reads fall back to defaults (existing behavior), then persist a repaired structure.
- A config structure change that is not fully backward-compatible must:
  - bump `config_version`
  - either include a deterministic migration/repair step or intentionally reset the config (delete `user.json`)
- Never rely on a shallow `{...defaults, ...loaded}` merge for nested objects.
  - If we are not shipping repair logic, the intended solution for missing/corrupt nested keys is to delete `user.json` and restart.

## Version Index

- **v0** (legacy): no `config_version` key (flat settings)
- **v1** (legacy): introduces `config_version: 1` and `windows.*` structure (settings may remain flat)
- **v2** (current): introduces `config_version: 2` and nests settings into buckets

---

## v0 (Legacy; no `config_version`)

### Notes

- Defaults currently live in two places:
  - `js/app.js` (main process defaults passed into `initMain()`)
  - `js/stage.js` (renderer-side `default_config` plus repair code)
- Window bounds currently persist as a single `window` object (main window only).
- UI scale is persisted as `space`.

### Structure (typical)

```json
{
  "transcode": { "ext": ".wav", "cmd": "-c:a pcm_s16le" },
  "space": 10,
  "win_min_width": 480,
  "win_min_height": 217,
  "volume": 0.5,
  "theme": "dark",
  "hqMode": false,
  "bufferSize": 10,
  "decoderThreads": 0,
  "modStereoSeparation": 100,
  "modInterpolationFilter": 0,
  "outputDeviceId": "",
  "defaultDir": "",
  "mixerPreBuffer": 50,
  "window": { "x": 0, "y": 0, "width": 480, "height": 217 }
}
```

### Key meanings

- `transcode`: default conversion target for legacy pipeline
- `space`: UI scale base (used by Stage via CSS var `--space-base`)
- `win_min_width`, `win_min_height`: legacy persisted constraints (should become code constants)
- `window`: persisted bounds for the main window only

---

## v1 (Legacy; `config_version: 1`)

### Notes

- Introduces a nested `windows` object.
- Main window scale moves from `space` to `windows.main.scale`.
- Each window can persist its own bounds.
- Settings may remain as flat keys (v0-style); bucketed settings are introduced in v2.

### Migration (v0 → v1) mapping

- `config_version`: set to `1`
- `space` → `windows.main.scale`
- `window` → `windows.main` bounds:
  - `x`, `y`, `width`, `height`
- `win_min_width`, `win_min_height`: drop from persisted config (replace with code constants)
- Ensure `windows.help`, `windows.settings`, `windows.mixer` exist (repair missing keys)

### Repair requirements

Because the current config loader performs shallow merges, the migration/repair step must explicitly:
- create `windows` if missing
- create any missing `windows.*` entries
- fill missing properties (`x/y/width/height/scale`) with sane defaults

---

## v2 (Current; `config_version: 2`)

### Notes

- Introduces stable settings buckets (`ui`, `audio`, `ffmpeg`, `tracker`, `mixer`) alongside `windows`.
- This avoids shallow-merge breakage for nested config and keeps the schema evolvable.

### Structure

```json
{
  "config_version": 2,
  "ui": {
    "theme": "dark",
    "defaultDir": ""
  },
  "audio": {
    "volume": 0.5,
    "output": { "deviceId": "" },
    "hqMode": false
  },
  "ffmpeg": {
    "stream": { "prebufferChunks": 10 },
    "decoder": { "threads": 0 },
    "transcode": { "ext": ".wav", "cmd": "-c:a pcm_s16le" }
  },
  "tracker": {
    "stereoSeparation": 100,
    "interpolationFilter": 0
  },
  "mixer": {
    "preBuffer": 50
  },
  "windows": {
    "main": { "x": null, "y": null, "width": 480, "height": 217, "scale": 10 },
    "help": { "x": null, "y": null, "width": 800, "height": 700, "scale": 10 },
    "settings": { "x": null, "y": null, "width": 500, "height": 700, "scale": 10 },
    "mixer": { "x": null, "y": null, "width": 1100, "height": 760, "scale": 10 }
  }
}
```

### Migration (v0/v1 → v2) mapping

Note: this mapping describes how older keys relate to v2 buckets, but the app does not currently ship migration code. For breaking schema changes, reset the config by deleting `user.json`.

- `config_version`: set to `2`
- `theme` → `ui.theme`
- `defaultDir` → `ui.defaultDir`
- `volume` → `audio.volume`
- `outputDeviceId` → `audio.output.deviceId`
- `hqMode` → `audio.hqMode`
- `bufferSize` → `ffmpeg.stream.prebufferChunks`
- `decoderThreads` → `ffmpeg.decoder.threads`
- `transcode` → `ffmpeg.transcode` (keep for format conversion defaults)
- `modStereoSeparation` → `tracker.stereoSeparation`
- `modInterpolationFilter` → `tracker.interpolationFilter`
- `mixerPreBuffer` → `mixer.preBuffer`
- Preserve/repair `windows.*` (including `windows.main.scale` and bounds)

---

## Rollout Strategy (Recommended)

- Ship migrations + repair first (no UX change required).
- During a short transition period, allow Stage/Settings to read the new nested paths first and fall back to v0 keys if present.
- Once telemetry/testing confirms stability, remove the fallback reads and treat v0 keys as legacy-only.
