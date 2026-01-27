# Architectural Constraints & Guardrails

This file serves as a hard set of rules for the AI Assistant. **Read this file before planning any major refactors.**

## 1. Frozen Code (Legacy / Stable)
The following modules are considered "Legacy Stable". Do not refactor them unless explicitly instructed to "Refactor Legacy". Only apply surgical bug fixes.
- `js/pitchtime/` (Legacy window implementation)
- `libs/rubberband/` (WASM integration)
- `js/midi/` (Midi implementation)

## 2. Integrated Systems
- **Pipeline Strategy**: The app uses a "Dual Pipeline" for main audio.
  - Pipeline A: `FFmpegStreamPlayerSAB` (Direct to destination).
  - Pipeline B: `RubberbandPipeline` (FFmpeg -> Rubberband -> Destination).
  - *Constraint*: Do not try to merge these into one "Mega Player" class. Keep them swappable.
- **IPC Protocol**: NUI windows communicate via `window.bridge` (renderer) <-> `ipcMain` (main) <-> `webContents.send` (other renderers).
  - *Constraint*: Do not introduce new IPC libraries or patterns. Use existing `tools.sendToId` or `bridge.sendToStage`.

## 3. Deployment & Environment
- **Platform**: Windows (Primary), Linux (Secondary).
- **Paths**: Must treat all binary paths as dynamic (packaged vs dev). Use `g.app_path` or `g.ffmpeg_napi_path`.

## 4. Process Guardrails
- **Refactoring**: If a user asks to "fix a bug", **do not refactor the architecture** to fix it unless the architecture IS the bug.
- **Clarification**: If a change requires touching >3 files or modifying core `js/stage.js` logic significantly, STOP and ask for confirmation.
