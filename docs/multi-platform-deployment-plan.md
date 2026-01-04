
# Multi-Platform Deployment Plan (Linux First, macOS Later)

Date: 2026-01-02

## Goals

- **Linux deployments** should be possible without Windows-only dependencies breaking runtime.
- Keep **Windows behavior unchanged** (registry integration + Squirrel workflow).
- Prepare the project for **macOS later** (no mac hardware available right now).

Non-goals (for now):

- Full auto-update on Linux/macOS.
- Full macOS packaging + signing/notarization.

## Key decisions

- Linux primary distribution format: **AppImage**
	- Reason: best fit for a self-contained artifact + user-friendly “in-app update” story without root.

## Current blockers / risks

### 1) Windows-only dependency: `native-registry`

- `js/registry.js` unconditionally imports `libs/native-registry`.
- On non-Windows, this can fail at **require-time** (even if never called).
- Registry actions are triggered from:
	- `js/squirrel_startup.js` (Squirrel install/update/uninstall)
	- `js/stage.js` (manual register/unregister actions)

### 2) Packaging targets are Windows-only in Forge

- Forge config currently builds only the Squirrel maker.
- Forge config exists in two places:
	- `forge.config.js`
	- `package.json` → `config.forge`
	- Risk: config drift.

### 3) Auto-update workflow is Windows/Squirrel-centric

- `libs/electron_helper/update.js` is designed around Squirrel assumptions: `RELEASES` + `*-full.nupkg` and `autoUpdater.quitAndInstall()`.
- On Linux, the “correct” update mechanism depends on packaging type; `.deb/.rpm` are generally OS-managed.

## Recommended roadmap (high-level)

### Phase 1 — Make Linux safe to run (no crashes)

**Outcome:** Linux builds start and run without Windows-only modules causing errors.

- Guard `native-registry` loading:
	- Only load `libs/native-registry` on `process.platform === 'win32'`.
	- On non-Windows: export a safe no-op function (returns `{ ok:false, reason:'unsupported_platform' }`).
- Gate registry actions in UI/IPC:
	- Hide/disable “register/unregister file types” on non-Windows.
- Make Squirrel startup logic Windows-only:
	- Early return on non-Windows before referencing `Update.exe` / registry code.

### Phase 2 — Enable Linux packaging outputs

**Outcome:** Linux artifacts can be produced (on Linux CI/runner).

- Choose a single Forge config source of truth (recommend `forge.config.js`).
- Add Linux makers:
	- **AppImage (primary):** Electron Forge does not have an official AppImage maker. Options:
		- [`@electron-forge/maker-appimage`](https://github.com/nicholasrq/electron-forge-maker-appimage) (community maker — verify maintenance status)
		- Use `electron-builder` just for AppImage output (can coexist with Forge)
		- Run `appimagetool` manually as a post-build step on the packaged output
	- **Optional distro packages:**
		- `@electron-forge/maker-deb`
		- `@electron-forge/maker-rpm`
	- **Portable zip/tar.gz (optional fallback):**
		- `@electron-forge/maker-zip` — some users prefer a simple extractable archive
		- Can share the same update logic as AppImage (download + replace + restart)

Note: `.deb/.rpm` are useful for users who prefer system packages, but they don't support in-app update. AppImage (or portable zip) is the target for that.

### Phase 3 — Linux update strategy (AppImage)

**Outcome:** Linux gets a clean “update available → download → restart into new version” flow.

#### What “in-place update” means on Linux (practical definition)

For AppImage, the best practice is not to overwrite the running executable.
Instead:

- Download the new AppImage.
- Either:
	- swap/replace the current AppImage *after the app exits*, then relaunch, or
	- launch the newly downloaded AppImage and quit the old one.

This is the Linux equivalent of “in-place update” that doesn’t require admin rights.

#### What needs to change conceptually in `libs/electron_helper/update.js` (no implementation yet)

Split update logic into two phases:

1) **Check** (cross-platform):
	 - Determine if remote version is newer.
	 - Select the correct release asset for the platform.
2) **Apply** (platform-specific):
	 - Windows: keep current Squirrel flow.
	 - Linux AppImage: download + restart flow.

##### Suggested GitHub release asset selection

- Windows:
	- require `RELEASES` and `*-full.nupkg`.
- Linux:
	- require a `.AppImage` asset.
	- If multiple AppImages exist, prefer arch-matching names:
		- `x86_64` / `amd64` / `x64` for `process.arch === 'x64'`
		- `aarch64` / `arm64` for `process.arch === 'arm64'`

##### Suggested Linux apply flow (AppImage)

When packaged as AppImage, the running process typically has `APPIMAGE` set.

**The complete flow:**

```
┌─────────────────────────────────────────────────────────────┐
│  1. CHECK PHASE (same as Windows)                           │
│     - Query GitHub Releases API                             │
│     - Compare remote version with app.getVersion()          │
│     - If newer: find .AppImage asset in release             │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  2. USER PROMPT                                             │
│     - Show "Update available" UI (same as Windows)          │
│     - User clicks "Update" or "Ignore"                      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  3. DOWNLOAD PHASE                                          │
│     - Download new .AppImage to temp location               │
│       (e.g. ~/.config/soundapp_update/SoundApp-2.1.0...)    │
│     - chmod +x the downloaded file                          │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  4. APPLY PHASE                                             │
│     Running: /home/user/Apps/SoundApp.AppImage              │
│     (env var APPIMAGE points to this file)                  │
│                                                             │
│     a) Copy downloaded file to ${APPIMAGE}.new              │
│     b) Spawn detached shell script (see below)              │
│     c) App calls app.quit()                                 │
│     d) Shell script detects exit, swaps files, relaunches   │
└─────────────────────────────────────────────────────────────┘
```

**The shell helper script** (spawned detached before quit):

```bash
pid=12345
appimg="/home/user/Apps/SoundApp.AppImage"
newimg="/home/user/Apps/SoundApp.AppImage.new"

# Wait for app to exit
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done

# Swap files
mv -f "$newimg" "$appimg"
chmod +x "$appimg"

# Relaunch
nohup "$appimg" >/dev/null 2>&1 &
```

**From the user's perspective:**

1. They see "Update available (v2.1.0)"
2. They click "Update"
3. Progress bar shows download
4. App closes briefly
5. App reopens running the new version

This is nearly identical UX to Windows Squirrel, just with a different underlying mechanism.

**Key differences from Windows:**

| Aspect | Windows (Squirrel) | Linux (AppImage) |
|--------|-------------------|------------------|
| Apply mechanism | `Update.exe` handles swap | Custom shell script |
| File location | Squirrel manages versions in `AppData` | User's chosen location (wherever they put the AppImage) |
| Restart | `autoUpdater.quitAndInstall()` | Manual quit + shell relaunch |
| Fallback | N/A | Launch downloaded file directly if `APPIMAGE` unset |

**What needs to be implemented in `update.js`:**

1. In `checkVersionGit()`: select `.AppImage` asset instead of `.nupkg` on Linux
2. New `runUpdateLinuxAppImage()` function that:
   - Downloads to temp
   - `chmod +x`
   - Spawns the shell helper
   - Calls `app.quit()`
3. Branch `runUpdate()` by `process.platform`

##### When `APPIMAGE` is not set

If the user runs from a dev build, extracted folder, or portable zip (not an actual AppImage), the `APPIMAGE` env var won't exist. In that case:

- Fall back to launching the downloaded file directly, or
- Open the download folder and prompt the user to replace manually.

This ensures update still works for non-AppImage Linux distributions.

##### What not to do on Linux

- Do not call `autoUpdater.quitAndInstall()` for Linux when distributing AppImage.
- Do not attempt to install `.deb/.rpm` silently (root/polkit variability, distro differences).

### Phase 4 — Icons per platform

**Outcome:** Correct icons for Linux/macOS packaging and tray.

Note: This should be done early (before or alongside Phase 2) because Linux packaging tools expect PNG icons.

- Linux packaging generally wants PNG(s); macOS wants ICNS.
- Add:
	- Linux: `build/icons/app.png` (512x512 recommended)
	- Linux tray: `build/icons/app-tray.png` (or reuse `app.png`)
	- macOS later: `build/icons/app.icns`
- Update `createTray()` in `js/app.js` to select PNG on Linux.

### Phase 5 — Linux file associations (optional)

**Outcome:** Linux can "Open With SoundApp" and optionally set defaults.

- Provide `.desktop` file + MIME type definitions.
- Optional helper commands (`xdg-mime`, `update-desktop-database`).

## Linux tray behavior (“keep running in tray”)

The current “keep running in tray” behavior should work logically on Linux (the app can stay alive after closing the main window), but the **user experience depends on tray availability** in the desktop environment.

Key points:

- Many Linux desktops show tray icons normally (e.g. KDE, XFCE, Cinnamon).
- GNOME (especially default GNOME Shell / Wayland setups) often **does not show a tray by default** unless the user installs an extension (AppIndicator/KStatusNotifierItem support). In that scenario, users might enable “keep running in tray” and then have no obvious way to restore/quit.
- Icon format: `.ico` tray icons can be unreliable on Linux; **PNG is a safer default**.

Recommendations:

- Provide a Linux tray icon as PNG (e.g. `build/icons/app-tray.png` or reuse `app.png`) and select it on Linux.
- If the tray cannot be created (icon missing or environment lacks tray support), consider a fallback path so the app is not “hidden forever”, e.g.:
	- disable “keep running in tray” automatically when tray creation fails, or
	- provide an alternative restore mechanism (menu/shortcut).

### Phase 6 — CI build matrix (required for Linux)

**Important:** AppImage creation requires Linux-native tools (`appimagetool`, `linuxdeploy`, etc.) that don't run on Windows. Therefore **CI is effectively required** to produce Linux releases from a Windows development machine.

**Outcome:** One GitHub release with all platform artifacts.

```
GitHub Release: v2.1.0
├── soundApp_Setup.exe              ← Windows installer
├── soundApp-2.1.0-full.nupkg       ← Windows auto-update
├── RELEASES                        ← Windows auto-update manifest
├── SoundApp-2.1.0-x86_64.AppImage  ← Linux
└── (optionally) soundapp_2.1.0_amd64.deb
```

**Workflow structure:**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'  # Triggered by: git tag v2.1.0 && git push --tags

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
          - os: ubuntu-latest
    runs-on: ${{ matrix.os }}
    
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run make
      
      # Each job uploads its artifacts to the SAME release (by tag)
      - uses: softprops/action-gh-release@v1
        with:
          files: out/make/**/*
```

Both jobs run in parallel and upload to the same release identified by the tag.

**New release workflow:**

```
1. npm version patch              # bumps to 2.1.0
2. git add -A && git commit -m "Release v2.1.0"
3. git tag v2.1.0
4. git push origin main --tags
5. ☕ wait for CI
6. Release appears with all artifacts
```

The local `create-release.ps1` script becomes optional or can be retired.

### update.js: Asset selection per platform

Since one release contains multiple binaries, `update.js` must select the correct asset for the current platform:

| Platform | Asset to download | Selection criteria |
|----------|------------------|-------------------|
| Windows | `*-full.nupkg` + `RELEASES` | Existing logic (unchanged) |
| Linux (x64) | `*.AppImage` | Prefer filename containing `x86_64`, `amd64`, or `x64` |
| Linux (arm64) | `*.AppImage` | Prefer filename containing `aarch64` or `arm64` |
| macOS (later) | TBD | TBD |

**Implementation in `checkVersionGit()`:**

```javascript
// Pseudocode
if (process.platform === 'win32') {
    // Find RELEASES + nupkg (existing logic)
} 
else if (process.platform === 'linux') {
    // Find .AppImage asset
    // If multiple, match process.arch to filename hints
}
```

If no matching asset is found for the platform, the update check should report "no update available" (or "update not supported on this platform") rather than error.

## update.js API changes (backward-compatible)

The `update.js` module needs new configuration options to support multi-platform updates while preserving backward compatibility for existing apps.

### Current `init(prop)` API

```javascript
prop = {
    url: 'herrbasan/SoundApp',     // repo or URL
    source: 'git' | 'http',        // update source type
    mode: 'splash' | 'widget' | 'silent',
    progress: callback,            // progress updates
    check: preCheckResult,         // optional pre-fetched check
    useSemVer: true,               // version comparison mode
    start_delay: 1000              // delay before check
}
```

### New options (all optional, backward-compatible)

| New Option | Type | Default | Purpose |
|------------|------|---------|---------|
| `platforms` | object | `undefined` | Per-platform asset configuration |
| `platforms.win32` | object | (current behavior) | Windows asset selection |
| `platforms.linux` | object | `undefined` | Linux asset selection |
| `platforms.darwin` | object | `undefined` | macOS asset selection (future) |

### Platform config object structure

```javascript
platforms: {
    win32: {
        // Uses existing Squirrel logic (default, no config needed)
        // Looks for: RELEASES + *-full.nupkg
    },
    linux: {
        assetSuffix: '.AppImage',           // required asset suffix
        archPatterns: {                      // optional arch matching
            x64: ['x86_64', 'amd64', 'x64'],
            arm64: ['aarch64', 'arm64']
        },
        updateMode: 'appimage'              // 'appimage' | 'download-only'
    },
    darwin: {
        // Future: macOS support
    }
}
```

### Example: Multi-platform app (new usage)

```javascript
update.init({
    url: 'herrbasan/SoundApp',
    source: 'git',
    mode: 'splash',
    useSemVer: true,
    platforms: {
        win32: {},  // use defaults (Squirrel)
        linux: {
            assetSuffix: '.AppImage',
            archPatterns: {
                x64: ['x86_64', 'amd64', 'x64'],
                arm64: ['aarch64', 'arm64']
            }
        }
    }
})
```

### Example: Legacy Windows-only app (unchanged, still works)

```javascript
// No platforms object = fall back to Windows Squirrel behavior
update.init({
    url: 'herrbasan/SoundApp',
    source: 'git',
    mode: 'splash',
    useSemVer: true
})
```

### Backward compatibility guarantees

1. **If `platforms` is `undefined`:** Fall back to current Windows-only Squirrel behavior. No breaking change for existing apps.
2. **If `platforms` is defined but current platform is missing:** Report "update not available for this platform" gracefully (not an error).
3. **Function signatures unchanged:** `init()`, `checkVersion()`, `checkVersionGit()` keep same signatures.
4. **Internal branching:** Platform-specific logic handled inside existing functions.

### Internal refactoring (transparent to callers)

```javascript
// Store platform config in module state
let platformConfig = null;

function init(prop) {
    // ...existing code...
    platformConfig = prop.platforms || null;
    // ...
}

// checkVersionGit() branches based on platform
function checkVersionGit(repo, useSemVer = false) {
    // ...existing code to get release...
    
    if (process.platform === 'win32') {
        // Existing Squirrel asset selection (RELEASES + nupkg)
    } 
    else if (process.platform === 'linux' && platformConfig?.linux) {
        // Find asset matching platformConfig.linux.assetSuffix
        // Apply archPatterns if multiple matches
    }
    else {
        // Platform not configured or not supported
    }
}

// runUpdate() branches to platform-specific apply logic
async function runUpdate() {
    if (process.platform === 'win32') {
        return runUpdateSquirrel();  // existing code, renamed
    }
    if (process.platform === 'linux') {
        const mode = platformConfig?.linux?.updateMode || 'appimage';
        if (mode === 'appimage') {
            return runUpdateLinuxAppImage();  // new function
        }
        return runUpdateDownloadOnly();  // fallback: just download
    }
    // Unsupported platform
    emit('log', 'Update not supported on platform: ' + process.platform);
    updateAborted(-12);
}
```

### New functions to implement

```javascript
// Existing Squirrel logic, extracted to named function
async function runUpdateSquirrel() {
    let local_archive = path.join(temp_dir, current.package_name);
    let download = await tools.download(current.package_url, local_archive, (data) => { emit('download', data) });
    if(download.status){
        autoUpdater.setFeedURL(temp_dir);
        autoUpdater.checkForUpdates();
        emit('state', 3);
    }
    emit('log', 'Download Finished');
}

// New: AppImage update logic
async function runUpdateLinuxAppImage() {
    emit('log', 'Linux update: AppImage');
    await tools.ensureDir(temp_dir);
    let local_archive = path.join(temp_dir, current.package_name);
    
    let download = await tools.download(current.package_url, local_archive, (data) => { emit('download', data) });
    if (!download.status) {
        emit('log', 'Download failed');
        updateAborted(-11);
        return;
    }
    
    // Make executable
    try { await fs.chmod(local_archive, 0o755); } catch(e) {}
    
    const appImagePath = process.env.APPIMAGE;
    if (app.isPackaged && appImagePath) {
        // Stage replacement: copy to APPIMAGE.new, spawn helper, quit
        const targetNew = appImagePath + '.new';
        await fs.copyFile(local_archive, targetNew);
        try { await fs.chmod(targetNew, 0o755); } catch(e) {}
        
        // Spawn shell helper to swap after exit
        const { spawn } = require('child_process');
        const pid = process.pid;
        const script = `
            while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done
            mv -f "${targetNew}" "${appImagePath}"
            chmod +x "${appImagePath}"
            nohup "${appImagePath}" >/dev/null 2>&1 &
        `;
        const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
        child.unref();
        
        emit('log', 'Update staged, restarting...');
        emit('state', 4);
        app.quit();
    } else {
        // Fallback: launch downloaded file directly
        const { spawn } = require('child_process');
        const child = spawn(local_archive, [], { detached: true, stdio: 'ignore' });
        child.unref();
        emit('log', 'Launching downloaded update...');
        emit('state', 4);
        app.quit();
    }
}

// Fallback: just download and notify user
async function runUpdateDownloadOnly() {
    let local_archive = path.join(temp_dir, current.package_name);
    let download = await tools.download(current.package_url, local_archive, (data) => { emit('download', data) });
    if (download.status) {
        emit('log', 'Update downloaded to: ' + local_archive);
        emit('state', 5);  // New state: "download complete, manual action required"
        // Could open containing folder: shell.showItemInFolder(local_archive)
    }
}
```

## macOS later (when hardware/access exists)

macOS requires additional considerations:

- packaging target (zip/dmg)
- code signing + notarization
- macOS update strategy (Squirrel is Windows-only)

