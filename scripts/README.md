# Release Scripts

## create-release.ps1

PowerShell script for creating GitHub releases with auto-update artifacts.

### Prerequisites

1. **GitHub CLI** must be installed and authenticated:
   ```powershell
   # Install
   winget install --id GitHub.cli
   
   # Authenticate
   gh auth login
   ```

2. **Clean main branch** with committed changes
3. **Version bumped** in `package.json`

### Usage

Basic release:
```powershell
.\scripts\create-release.ps1
```

Create draft release (won't trigger auto-updates):
```powershell
.\scripts\create-release.ps1 -Draft
```

Clean old builds first:
```powershell
.\scripts\create-release.ps1 -Clean
```

Add custom release notes:
```powershell
.\scripts\create-release.ps1 -Notes "Fixed critical playback bug"
```

### What it does

1. Reads version from `package.json`
2. Checks if tag already exists (prevents duplicates)
3. Validates clean working directory
4. Runs `npm run make` to build artifacts
5. Creates GitHub release with:
   - `soundApp_Setup.exe` (installer)
   - `soundapp-X.X.X-full.nupkg` (auto-update package)
   - `RELEASES` (version metadata)
6. Syncs tag to local repository

### Workflow

```
Bump version in package.json
    ↓
Commit and push to main
    ↓
Run create-release.ps1
    ↓
Release appears on GitHub
    ↓
Users receive auto-update
```

### Release tagging + notes

- A release is always tied to a Git tag (this script uses the `package.json` version to determine the tag).
- Release notes should include all major changes since the last tagged release.

Optional helper commands:

```powershell
# See the latest tag
git fetch --tags
git describe --tags --abbrev=0

# Draft notes from commits since the last tag
$LAST_TAG = git describe --tags --abbrev=0
git log "$LAST_TAG..HEAD" --oneline
```

### Troubleshooting

**"Release already exists"**  
→ Bump version in package.json

**"GitHub CLI is not authenticated"**  
→ Run `gh auth login`

**"Must be on main branch"**  
→ Switch to main: `git checkout main`

**"Working directory is not clean"**  
→ Commit or stash changes first

See [../docs/github-releases-migration.md](../docs/github-releases-migration.md) for more details.

---

## update-napi-binaries.ps1

PowerShell script for updating FFmpeg NAPI decoder binaries from GitHub releases.

### Usage

Update both Windows and Linux binaries (default):
```powershell
.\scripts\update-napi-binaries.ps1
```

Update single platform:
```powershell
.\scripts\update-napi-binaries.ps1 -Platform win
.\scripts\update-napi-binaries.ps1 -Platform linux
```

### What it does

1. Fetches latest release from [herrbasan/ffmpeg-napi-interface](https://github.com/herrbasan/ffmpeg-napi-interface)
2. Downloads platform-specific tar.gz archives
3. Extracts `.node` files and FFmpeg libraries (DLLs/SOs)
4. Copies to `bin/win_bin/` and/or `bin/linux_bin/`
5. Replaces existing binaries in repository

### When to run

- After updating ffmpeg-napi-interface to a new version
- When FFmpeg library versions change
- Before committing updated binaries to the repo

**Note:** Binaries are committed to the repository, not downloaded during install. This script is for manual updates only.

---

## patch-midiplayer-worklet.js

Node.js script for copying and patching js-synthesizer bundles from npm.

### Usage

```powershell
npm run patch-midiplayer-worklet
```

Runs automatically via `postinstall` hook.

### What it does

1. Copies js-synthesizer bundles from `node_modules/js-synthesizer/dist/` to:
   - `libs/midiplayer/`
   - `bin/midiplayer-runtime/`
2. Applies **UMD wrapper fix** to `js-synthesizer.js`:
   - Adds `root = root || globalThis;` for ES module compatibility
3. Applies **metronome hook** to `js-synthesizer.worklet.js`:
   - Injects `AudioWorkletGlobalScope.SoundAppMetronome` calls around `syn.render()`
   - Handles dynamic indentation

### When to run

- After `npm install` (automatic)
- After `npm update js-synthesizer`
- When developing metronome integration

### Files patched

| File | Patch Applied |
|------|---------------|
| `js-synthesizer.js` | UMD wrapper fix (globalThis fallback) |
| `js-synthesizer.worklet.js` | Metronome hook injection |
| `libfluidsynth.js` | None (copied as-is) |
