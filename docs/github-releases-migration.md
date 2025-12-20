# GitHub Releases Auto-Update Migration

## Overview
SoundApp now uses **GitHub Releases** for auto-updates instead of a custom HTTP server. This provides better reliability, automatic CDN distribution, and eliminates the need to maintain a separate update server.

## What Changed

### Previous System (Custom HTTP Server)
- Updates hosted on `https://raum.com/update/soundapp/stable/`
- Required maintaining a web server
- Manual upload of update files
- Update check via HTTP `RELEASES` file

### New System (GitHub Releases)
- Updates hosted on `https://github.com/herrbasan/SoundApp/releases`
- Fully automated via GitHub API
- Uses GitHub's CDN for global distribution
- Update check via GitHub Releases API

## How It Works

### For Users
**No change** in user experience:
- Updates still check automatically on launch
- Same splash screen UI for accepting/declining updates
- Squirrel installer handles installation seamlessly

### For Developers

#### Creating a Release

**Prerequisites:**
1. Install [GitHub CLI](https://cli.github.com/):
   ```powershell
   winget install --id GitHub.cli
   ```

2. Authenticate:
   ```powershell
   gh auth login
   ```

**Release Process:**

1. **Bump version** in `package.json`:
   ```json
   {
     "version": "1.1.3"
   }
   ```

2. **Commit and push** to main branch:
   ```bash
   git add package.json
   git commit -m "Bump version to 1.1.3"
   git push
   ```

3. **Run the release script**:
   ```powershell
   .\scripts\create-release.ps1
   ```

   Optional parameters:
   ```powershell
   # Create a draft release (won't trigger updates until published)
   .\scripts\create-release.ps1 -Draft

   # Clean old builds before creating release
   .\scripts\create-release.ps1 -Clean

   # Add custom release notes
   .\scripts\create-release.ps1 -Notes "Bug fixes and performance improvements"
   ```

The script will:
- Validate version doesn't already exist
- Build the application (`npm run make`)
- Create GitHub release with tag `v1.1.3`
- Upload installer, nupkg, and RELEASES files
- Sync tag to local repository

#### What Gets Published

Each release includes three files:
1. **`soundApp_Setup.exe`** - User-facing installer
2. **`soundapp-1.1.3-full.nupkg`** - Squirrel package for auto-updates
3. **`RELEASES`** - Metadata file for version checking

### Update Flow

```
App Launch
    ↓
Check GitHub API for latest release
    ↓
Compare remote version with app.getVersion()
    ↓
If newer: Download nupkg via GitHub CDN
    ↓
Squirrel installs update
    ↓
App restarts with new version
```

## Code Changes

### `js/app.js`
```javascript
// Before
let check = await update.checkVersion('https://raum.com/update/soundapp/stable/');
update.init({mode:'splash', url:'https://raum.com/update/soundapp/stable/', ...})

// After
let check = await update.checkVersion('herrbasan/SoundApp', 'git');
update.init({mode:'splash', url:'herrbasan/SoundApp', source:'git', ...})
```

### `package.json`
```json
// Before
"iconUrl": "https://raum.com/update/soundapp/app.ico"

// After
"iconUrl": "https://raw.githubusercontent.com/herrbasan/SoundApp/main/build/icons/app.ico"
```

## Benefits

✅ **No server maintenance** - GitHub handles hosting  
✅ **Global CDN** - Fast downloads worldwide  
✅ **Automated workflow** - Simple PowerShell script  
✅ **Version history** - All releases in one place  
✅ **Rollback capability** - Can unpublish/republish releases  
✅ **Free** - No hosting costs  

## Troubleshooting

### "Release already exists" error
Bump version in `package.json` first, or delete the existing release on GitHub.

### "GitHub CLI is not authenticated"
Run `gh auth login` and follow the prompts.

### Update check fails silently
Check network connectivity. The update check has a 5-second timeout to avoid blocking app startup.

### Users not receiving updates
Ensure release is **published** (not draft). Check that all three files (exe, nupkg, RELEASES) are attached to the release.

## Testing Updates

### Create a test release
```powershell
# Build with higher version number
# Edit package.json: "version": "1.1.99"
npm run make

# Create draft release
.\scripts\create-release.ps1 -Draft

# Test by running older version of app
# Manually publish release on GitHub when ready
```

### Manual update check
Currently not implemented in UI. Can be added as a menu item or keyboard shortcut if needed.

## Migration Checklist

- [x] Update `update.js` to support GitHub releases (already done)
- [x] Update `app.js` to use GitHub releases
- [x] Update `package.json` iconUrl
- [x] Create `create-release.ps1` script
- [ ] Create first GitHub release with v1.1.2
- [ ] Test update flow from v1.1.1 → v1.1.2
- [ ] Decommission old update server

## Future Enhancements

### Planned for v1.2+
- Manual "Check for Updates" menu item
- Update notification in system tray
- Changelog display in update window
- Beta/stable channel support via release tags

## References

- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)
- [GitHub CLI Documentation](https://cli.github.com/manual/)
- [Squirrel.Windows](https://github.com/Squirrel/Squirrel.Windows)
- [electron-helper update.js](../libs/electron_helper/update.js)
