# Config Refactor Plan

## Executive Summary

**The centralized config system already exists in `helper_new.js` and works correctly.** We're just not using it properly in secondary windows. This refactor is primarily about:

1. **Using the existing system correctly** - Secondary windows should call `initRenderer()` 
2. **Adding new features** - Config versioning, migrations, window bounds tracking, tray icon

### Decisions (Locked In)

1. **Centralize renderer config wiring in `window-loader.js`**
    - Secondary windows should *not* individually call `initRenderer()`.
    - The shared loader will:
      - receive `init_data` from Stage,
      - call `helper.config.initRenderer('user', ...)`,
      - apply theme from the live config,
      - then dispatch `bridge-ready` with a consistent `data.config`.

2. **All settings become config-driven**
    - Settings window writes to config (`config_obj.set(...)`) only.
    - Stage reacts to config changes inside its `initRenderer` update callback (diff old → new), and performs side effects (audio restarts, sink changes, etc.).
    - We remove ad-hoc “set-buffer-size / set-output-device / toggle-hq-mode” style control messages long-term.

3. **Stop using `init_data.config` and stop broadcasting `config-changed`**
    - `init_data` remains for non-config bootstrapping (paths, stageId, playlist, sample-rate info).
    - Config distribution is always via `config-updated-user` broadcasts coming from the helper.

---

## Current State Analysis

### What Already Works (helper_new.js)

The `helper.config` system is well-designed and functional:

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                             │
│  helper.config.initMain('user', defaults)                       │
│    → Creates masterConfigs['user']                              │
│    → Sets up IPC handler: 'config-get'                          │
│    → Sets up IPC handler: 'config-set'                          │
│    → On set(): broadcasts 'config-updated-user' to ALL windows  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ IPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RENDERER PROCESS                           │
│  helper.config.initRenderer('user', callback)                   │
│    → Fetches config via 'config-get' IPC                        │
│    → Subscribes to 'config-updated-user' broadcasts             │
│    → On set(): sends update via 'config-set' IPC                │
│    → callback() fires on every broadcast                        │
└─────────────────────────────────────────────────────────────────┘
```

### Important Gotcha: Nested Defaults Are Not Deep-Merged

`helper_new.js` currently merges loaded config with defaults using a **shallow** merge:

```js
cnf.data = { ...defaultConfig, ...loadedData };
```

This is fine for flat keys, but it **will break** when we introduce nested structures like `windows.main`, `windows.help`, etc.

Example: if a user config contains `windows: { main: {...} }`, it will overwrite the entire default `windows` object and you will lose new keys like `windows.mixer` that are added later.

**Implementation note:** before we ship nested config objects, we must add a repair/deep-merge step (either in migrations or in config loading).

### Current Usage

| Component | Uses initMain/initRenderer? | Status |
|-----------|----------------------------|--------|
| app.js (main) | ✅ `initMain()` | Correct |
| stage.js | ✅ `initRenderer()` | Correct |
| help window | ❌ Uses `init_data.config` | Bypassed |
| settings window | ❌ Uses `init_data.config` + ad-hoc IPC | Bypassed |
| mixer window | ❌ Uses `init_data.config` | Bypassed |

### The Problems

1. **Secondary windows bypass the system** - They receive a snapshot via `init_data.config` instead of calling `initRenderer()`

2. **Duplicate defaults** - `default_config` defined in both app.js and stage.js

3. **Manual broadcasting** - stage.js calls `tools.broadcast('config-changed')` manually, duplicating what the helper already does

4. **Ad-hoc IPC** - Settings uses custom messages (`set-buffer-size`, `set-output-device`) instead of just writing to config

5. **No config versioning** - No migration path for breaking changes like the new window structure

---

## Proposed Architecture

### Fix 1 (Core): Centralize `initRenderer()` in `window-loader.js`

**This is the core fix.** Secondary windows should not manually implement config wiring.

Instead, in Electron mode, `window-loader.js` will:

1) wait for `init_data` (Stage → window),
2) call `helper.config.initRenderer('user', ...)`,
3) attach the returned config object to the event payload,
4) apply theme from the live config,
5) dispatch `bridge-ready`.

Pseudo-code:

```js
ipcRenderer.once('init_data', async (e, data) => {
    const config_obj = await helper.config.initRenderer('user', (newConfig) => {
        // keep bridge-ready consumers in sync
        // apply theme immediately
        applyTheme(newConfig);
        // optionally also re-dispatch a window event if a window needs it
    });
    data.config_obj = config_obj;
    data.config = config_obj.get();
    applyTheme(data.config);
    dispatchBridgeReady(data);
});
```

This keeps windows simple and consistent.

**What to keep in init_data:**
- `type` - window type identifier
- `stageId` - parent window ID
- `ffmpeg_*_path` - paths for mixer/audio
- `maxSampleRate`, `currentSampleRate`
- `playlist` (for mixer)

**What to remove from init_data:**
- `config` - fetch via `initRenderer()` instead

### Fix 2: Centralized Defaults

Move default config to a single location - suggest a new `js/config-defaults.js`:

```javascript
module.exports = {
    config_version: 1,
    transcode: { ext: ".wav", cmd: "-c:a pcm_s16le" },
    volume: 0.5,
    theme: 'dark',
    hqMode: false,
    bufferSize: 10,
    decoderThreads: 0,
    modStereoSeparation: 100,
    modInterpolationFilter: 0,
    outputDeviceId: '',
    defaultDir: '',
    mixerPreBuffer: 50,
    windows: {
        main: { x: null, y: null, width: 480, height: 217, scale: 10 },
        help: { x: null, y: null, width: 800, height: 700, scale: 10 },
        settings: { x: null, y: null, width: 500, height: 700, scale: 10 },
        mixer: { x: null, y: null, width: 1100, height: 760, scale: 10 }
    }
};
```

**Implementation note:** if we keep nested objects (`windows`), we must ensure migrations/deep-merge repair happens so new `windows.*` keys do not get dropped.

### 3. Window Minimum Sizes (Code Constants)

These aren't configurable, so make them constants:

```javascript
const WIN_CONSTRAINTS = {
    main: { minWidth: 480, minHeight: 217 },
    help: { minWidth: 400, minHeight: 300 },
    settings: { minWidth: 400, minHeight: 400 },
    mixer: { minWidth: 600, minHeight: 400 }
};
```

### 4. Secondary Windows Use initRenderer()

This is now handled centrally by `window-loader.js` (see Fix 1).

This means:
- No more `init_data.config`
- No more manual `tools.broadcast('config-changed')` from stage.js
- All windows become equal citizens via the built-in `config-updated-user` broadcast

### 5. Window Bounds Saving Pattern

Each window saves its own bounds. Add to helper or as a utility:

```javascript
// In each window's init
async function setupWindowBoundsTracking(windowType) {
    const win = helper.window;
    const config_obj = await helper.config.initRenderer('user');
    
    let saveTimeout;
    const saveBounds = async () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            const bounds = await win.getBounds();
            const config = config_obj.get();
            config.windows[windowType] = {
                ...config.windows[windowType],
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height
            };
            config_obj.set(config);
        }, 500);
    };
    
    win.hook_event('move', saveBounds);
    win.hook_event('resized', saveBounds);
}
```

---

## Implementation Steps

### Phase 1 (Step 1): Centralized Config Wiring (No Behavior Changes)

Goal: make every secondary window a first-class config subscriber **without** changing how Settings/Mixer currently control Stage.

1. **Update `window-loader.js` (Electron path)**
    - Call `helper.config.initRenderer('user', onConfigUpdated)`.
    - Before firing `bridge-ready`, set:
      - `data.config_obj = config_obj`
      - `data.config = config_obj.get()`
    - Apply theme from `data.config.theme` (live config), not from `init_data.config`.
    - This step is *backwards compatible* because windows that still read `data.config` keep working.

2. **Keep current Stage → window init payload as-is (temporarily)**
    - Stage may continue to include `init_data.config` during Step 1.
    - After Step 1 is verified, we remove `init_data.config` in Phase 2.

Verification checklist for Step 1:
- Open Settings/Help/Mixer: theme matches Stage config on open.
- Toggle theme in Stage: secondary windows still react via existing `theme-changed` wiring.
- No functional behavior changes beyond more reliable config availability.

### Phase 2 (Step 2): Remove Snapshot Config + Remove Custom Broadcast

Goal: remove the bypass paths and rely only on the centralized helper broadcasts.

1. **Update Stage window creation (`openWindow()` in stage.js)**
    - Stop including `init_data.config`.
    - Keep: `type`, `stageId`, ffmpeg paths, sample-rate info, playlist.

2. **Remove `tools.broadcast('config-changed', ...)`**
    - Mixer should rely on the built-in `config-updated-user` flow (via the central loader).

### Phase 3 (Step 3): Fully Config-Driven Settings + Stage Side Effects

Goal: Settings writes config only; Stage reacts to config diffs.

1. **Make Settings window write config directly**
    - Use `config_obj` from `bridge-ready`.
    - Replace `sendToStage('set-*')` with `config_obj.set(...)` updates.

2. **Make Stage react to config changes (single source of truth)**
    - In Stage `helper.config.initRenderer('user', callback)`, diff old vs new and apply side effects:
      - `outputDeviceId` → `audioContext.setSinkId(...)` (revert on failure).
      - `hqMode` → rebuild AudioContext + re-init players; broadcast `sample-rate-updated`.
      - `bufferSize/decoderThreads` → already handled; keep.
      - `mod*` options → reload current MOD if needed.
      - `defaultDir` → used by file pickers / playlist loading.

### Phase 4: Config Foundation (Versioning + Migrations)
1. Create `js/config-defaults.js` (single source of defaults)
2. Create `js/config-migrations.js` (v0 → v1 migration + repair)
3. Modify `app.js` to:
    - load defaults,
    - load existing config,
    - run migrations/repair,
    - then `initMain()` with the resulting data.

### Phase 5: Window Bounds Tracking
1. Introduce `config.windows.{type}` structure (via migrations)
2. Stage reads and writes `windows.main` (including `scale`)
3. Each window reads its bounds from `config.windows[type]` on open
4. Each window saves its bounds on move/resize (debounced)

### Phase 6: Tray Icon
1. Add tray icon in `app.js`
2. Implement “Reset Windows” by writing `config.windows.*` centered positions
3. Broadcast `windows-reset` so open windows reposition themselves

### Phase 7: Cleanup & Testing
1. Remove duplicate defaults from Stage (`default_config`)
2. Verify: changes in Settings update Stage + Mixer live (no restart)
3. Verify: config persists and updates survive restart
4. Verify: browser preview mode still works (mock config)

---

## Technical Considerations

### Startup Timing

Secondary windows must wait for config to be available. This is async, so:

```javascript
window.addEventListener('bridge-ready', async (e) => {
    // In the new design, window-loader already created it.
    const config_obj = e.detail.config_obj;
    initUI(config_obj.get());
});
```

### What init_data Still Needs

Even without config, `init_data` is still useful for:
- `type` - window type identifier
- `stageId` - parent window ID
- `ffmpeg_napi_path`, `ffmpeg_player_path`, `ffmpeg_worklet_path` - paths for mixer
- `maxSampleRate`, `currentSampleRate` - audio context info
- `playlist` (for mixer) - initial track list

### Theme Handling

Currently `window-loader.js` applies theme based on `init_data.config.theme`. After this refactor, theme should be applied from the live config (`config_obj.get().theme`) inside `window-loader.js`.

Note: `theme-changed` broadcasts can remain for UI-only immediate toggling if desired, but the source of truth should be `config.theme`.

### Browser Preview Mode

`window-loader.js` provides mock IPC for browser preview. The mock `initRenderer()` would need to:
- Return mock config data
- Not depend on main process

Current implementation at line 163 already does this with localStorage.

### Concurrent Writes

If two windows write config simultaneously, last write wins. The helper already debounces writes (500ms), so rapid changes coalesce. Cross-window race conditions are unlikely since writes are debounced and broadcast updates local copies.

### Deep Merge / Repair Strategy (Required for Nested Config)

When introducing `config.windows`, ensure that after loading config we repair nested objects so missing keys are re-inserted.

Two acceptable strategies:

1) **Migration-based repair:** in `config-migrations.js`, after loading, ensure:
    - `config.config_version` exists
    - `config.windows` exists
    - `config.windows.{main,help,settings,mixer}` exist with sane defaults

2) **Loader deep-merge:** enhance `_loadAndWatchConfigFile` to deep-merge specific keys (at minimum `windows`).

Migration-based repair is usually safer (explicit, versioned).

---

## New Config Structure (v1)

```json
{
    "config_version": 1,
    "transcode": {
        "ext": ".wav",
        "cmd": "-c:a pcm_s16le"
    },
    "volume": 0.65,
    "theme": "dark",
    "hqMode": false,
    "bufferSize": 10,
    "decoderThreads": 0,
    "modStereoSeparation": 100,
    "modInterpolationFilter": 0,
    "outputDeviceId": "",
    "defaultDir": "",
    "mixerPreBuffer": 50,
    "windows": {
        "main": {
            "x": -510,
            "y": 1031,
            "width": 480,
            "height": 219,
            "scale": 10
        },
        "help": {
            "x": 200,
            "y": 100,
            "width": 800,
            "height": 700,
            "scale": 10
        },
        "settings": {
            "x": null,
            "y": null,
            "width": 500,
            "height": 700,
            "scale": 10
        },
        "mixer": {
            "x": 100,
            "y": 200,
            "width": 1100,
            "height": 760,
            "scale": 10
        }
    }
}
```

---

## Design Decisions (Resolved)

1. **Scale per window**: Deferred. Currently all secondary windows share `window.css` with `--space-base`. Decision pending on whether each window needs independent scale or shared scale for secondary windows. For now, track `scale` per window in config but only `main` uses it.

2. **Maximized state**: Not tracking. Windows don't have minimize buttons in UI. Taskbar minimize is unplanned use case.

3. **Off-screen handling**: Add tray icon with "Reset Windows" function that centers all windows on primary display. This handles disconnected monitors gracefully.

4. **Settings window**: Communicates setting changes directly to related windows via IPC. Config persistence is separate concern - settings writes to config, windows receive updates via broadcast.

---

## New Feature: Tray Icon

Add system tray icon with context menu:

```javascript
// In app.js
const { Tray, Menu, nativeImage } = require('electron');

let tray = null;

function createTray() {
    const iconPath = path.join(__dirname, '../build/icons/icon.png'); // or .ico on Windows
    tray = new Tray(iconPath);
    
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'Reset Windows', 
            click: () => resetAllWindows() 
        },
        { type: 'separator' },
        { 
            label: 'Show Main Window', 
            click: () => wins.main?.show() 
        },
        { type: 'separator' },
        { 
            label: 'Quit', 
            click: () => app.quit() 
        }
    ]);
    
    tray.setToolTip('SoundApp');
    tray.setContextMenu(contextMenu);
    
    // Click on tray icon shows main window
    tray.on('click', () => wins.main?.show());
}

async function resetAllWindows() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const { x: displayX, y: displayY } = primaryDisplay.workArea;
    
    // Get config and reset all window positions
    const config = masterConfigs['user'].data;
    
    const windowDefaults = {
        main: { width: 480, height: 217 },
        help: { width: 800, height: 700 },
        settings: { width: 500, height: 700 },
        mixer: { width: 1100, height: 760 }
    };
    
    for (const [winType, defaults] of Object.entries(windowDefaults)) {
        const w = defaults.width;
        const h = defaults.height;
        config.windows[winType] = {
            ...config.windows[winType],
            x: displayX + Math.round((width - w) / 2),
            y: displayY + Math.round((height - h) / 2),
            width: w,
            height: h
        };
    }
    
    // Save config
    masterConfigs['user'].write();
    
    // Apply to open windows
    if (wins.main) {
        wins.main.setBounds(config.windows.main);
    }
    // Broadcast to renderer windows to reposition themselves
    helper.tools.broadcast('windows-reset', config.windows);
}
```

Secondary windows listen for `windows-reset`:

```javascript
// In each secondary window
window.bridge.on('windows-reset', (windowsConfig) => {
    const myConfig = windowsConfig[windowType];
    if (myConfig) {
        helper.window.setBounds({
            x: myConfig.x,
            y: myConfig.y,
            width: myConfig.width,
            height: myConfig.height
        });
    }
});

---

## Migration Testing Checklist

- [ ] Fresh install (no existing config) → creates v1 structure
- [ ] Existing v0 config → migrates to v1, preserves window position/size
- [ ] Existing v0 config with `space` → migrates to `windows.main.scale`
- [ ] Corrupted config → falls back to defaults (existing behavior)
- [ ] All windows can read config after migration
- [ ] Window bounds persist after app restart
- [ ] Scale persists per window after app restart

