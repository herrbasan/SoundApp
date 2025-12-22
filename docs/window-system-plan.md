# Window System Development Plan

## Overview
Create a window system where each window type is a **complete, standalone HTML page** that works in both browser (live-server preview) and Electron. The chrome (title bar, controls) is included in markup but hidden via CSS in browser preview, allowing you to focus on styling content.

## Architecture

### Self-Contained Window Pages
Each window is a complete HTML page with:
- Shared CSS (reset, main, window chrome)
- Window chrome markup (hidden in browser via CSS)
- Content area (what you style in live-server)
- Shared loader script (detects context, provides bridge)

### File Structure
```
html/
  help.html           # Complete page - previewable in browser
  settings.html       # Complete page - previewable in browser
  playlist.html       # etc.

js/
  window-loader.js    # Shared: context detection, bridge creation
  stage.js            # Main player window

css/
  reset.css           # CSS reset
  main.css            # Shared app styles
  window.css          # Window chrome + content layout
```

### HTML Template Structure
```html
<!DOCTYPE html>
<html>
<head>
	<title>Help - SoundApp</title>
	<link media="all" rel="stylesheet" type="text/css" href="../css/fonts.css">
	<link media="all" rel="stylesheet" type="text/css" href="../libs/nui/css/nui_main.css">
	<link media="all" rel="stylesheet" type="text/css" href="../libs/nui/css/nui_app.css">
	<link rel="stylesheet" href="../css/window.css">
</head>
<body class="dark">
	<div class="nui-app">
		<div class="nui-title-bar">
			<div class="title">
				<div class="nui-icon-container">
					<i>help</i>
				</div>
				<div class="label">Help</div>
			</div>
			<div class="controls">
				<div class="nui-icon-container close"><i>close</i></div>
			</div>
		</div>
		<div class="content">
			<main>
				<!-- Page-specific content here -->
			</main>
		</div>
		<div class="nui-status-bar"></div>
	</div>
	
	<script type="module">
		import ut from '../libs/nui/nui_ut.js';
		import nui from '../libs/nui/nui.js';
		window.ut = ut;
		window.nui = nui;
	</script>
	<script src="../js/window-loader.js"></script>
</body>
</html>
```

**Important Structure Notes:**
- Uses existing NUI framework (nui_main.css, nui_app.css)
- `.content` container with absolute positioning (top: titlebar height, bottom: statusbar height)
- `<main>` element inside `.content` with absolute inset and overflow-y: auto for scrolling
- This matches the pattern used in window.html
- window.css adds the layout rules for `.content > main` to match nui_app.css pattern

### CSS Layout Rules
```css
/* NUI App Window Layout (in window.css) */
.nui-app > .content {
	position: absolute;
	top: var(--app-window-titlebar-height, 3rem);
	left: 0;
	right: 0;
	bottom: var(--app-window-statusbar-height, 2rem);
	overflow: hidden;
}

.nui-app .content > main {
	position: absolute;
	inset: 0;
	overflow-y: auto;  /* Scrollable content */
	padding: var(--window-padding);
}
```

## Communication Architecture

### Built-in Helper Utilities (helper_new.js)
The electron_helper provides the communication infrastructure:

- `tools.sendToId(windowId, channel, data)` - Send to specific window
- `tools.broadcast(channel, data)` - Send to all windows
- `ipcRenderer.on(channel, callback)` - Listen for messages
- `tools.browserWindow(template, options)` - Create window with init_data

### Window Loader (window-loader.js)
Detects context and creates appropriate bridge:

**Electron Mode:**
- Requires electron_helper
- Creates real IPC bridge
- Wires up chrome controls (close button, focus/blur)
- Listens for init_data from stage

**Browser Preview Mode:**
- Creates mock bridge that logs to console
- Uses localStorage for mock config persistence
- Dispatches bridge-ready event with mock data
- Allows full UI testing without Electron

### Bridge API
```javascript
window.bridge = {
  // Communication
  sendToStage: (channel, data) => {},    // Send to stage window
  sendToId: (id, channel, data) => {},   // Send to specific window
  broadcast: (channel, data) => {},       // Send to all windows
  on: (channel, callback) => {},          // Listen for messages
  once: (channel, callback) => {},        // Listen once
  
  // Config (real or mock)
  config: helper.config,                  // Electron: real config
                                          // Browser: localStorage mock
  
  // Window control
  window: helper.window,                  // Window API
  closeWindow: () => {},                  // Close this window
  
  // Context info
  isElectron: Boolean,
  stageId: Number,                        // Stage window ID (Electron only)
  windowId: Number                        // This window's ID (Electron only)
};
```

## Development Workflow

### Creating New Window Content
1. Copy template HTML structure
2. Open in live-server
3. Add content to `<main class="window-content">`
4. Style using browser devtools
5. Test in Electron to verify integration

### Live Preview Benefits
- No Electron restart needed for CSS changes
- Hot reload via live-server
- Mock bridge logs IPC calls to console
- Mock config persists to localStorage
- Full UI interaction testing

## Implementation Phases

### Phase 1: Foundation
1. Create `js/window-loader.js` with context detection
2. Create `css/window.css` with chrome styles
3. Create `html/help.html` as first complete window
4. Update `js/stage.js` to open help window

### Phase 2: Help Window Content
1. Add keyboard shortcuts table
2. Add feature documentation
3. Style for readability

### Phase 3: Settings Window
1. Create `html/settings.html`
2. Integrate with helper.config
3. Test save/load with mock and real config

### Phase 4: Additional Windows
- Playlist window (with nui_list.js)
- Future: waveform, mixer, converter

## Window Types

| Window | Key | Description |
|--------|-----|-------------|
| Help | H | Keyboard shortcuts, feature docs |
| Settings | S | App configuration |
| Playlist | P | Full playlist with search |
| Waveform | W | Audio visualization (future) |
| Mixer | M | Multi-track mixer (future) |

## Stage.js Integration

### Window Management
```javascript
// Track open windows
g.windows = { help: null, settings: null, playlist: null };

// Open window (reuse if already open)
async function openWindow(type) {
  if (g.windows[type]) {
    tools.sendToId(g.windows[type], 'command', 'show');
    return;
  }
  
  g.windows[type] = await tools.browserWindow('frameless', {
    file: `./html/${type}.html`,
    show: false,
    init_data: {
      type: type,
      stageId: await g.win.getId(),
      config: g.config
    }
  });
}

// Key bindings
if (e.keyCode == 72) openWindow('help');     // H
if (e.keyCode == 83) openWindow('settings'); // S (with modifier?)
```

### Cleanup on Window Close
```javascript
// Window notifies stage when closing
ipcRenderer.on('window-closed', (e, data) => {
  if (g.windows[data.type] === data.windowId) {
    g.windows[data.type] = null;
  }
});
```

## Mock System for Browser Preview

All secondary windows can be previewed in a browser using a local development server (like live-server). This enables rapid iteration without restarting the Electron app.

### Preview Setup
```bash
# Install live-server globally
npm install -g live-server

# From project root, serve the app
live-server --no-browser

# Open in browser
# http://localhost:8080/html/help.html
```

### Environment Detection
**window-loader.js** automatically detects the environment:
```javascript
const isElectron = typeof process !== 'undefined' && process.versions && process.versions.electron;

if (isElectron) {
  // Full IPC, helper, and tools functionality
} else {
  // Mock bridge with localStorage-based config
}
```

### Browser Preview Features

**Theme Toggle:**
- X key toggles dark/light theme
- Theme persisted to `localStorage.preview-theme`
- Separate from Electron app theme

**Mock Bridge:**
All IPC commands are logged to console for debugging.

**Mock Config:**
Uses localStorage for persistence in browser preview.

### Mock Config Implementation
```javascript
function createMockConfig() {
  return {
    initRenderer: async (name, onChange) => {
      let data = JSON.parse(localStorage.getItem('mock-config-' + name) || '{}');
      return {
        get: () => data,
        set: (newData) => {
          data = {...data, ...newData};
          localStorage.setItem('mock-config-' + name, JSON.stringify(data));
          onChange?.(data);
        }
      };
    }
  };
}
```

### Mock Data per Window Type
```javascript
function getMockInitData() {
  const pageName = location.pathname.split('/').pop().replace('.html', '');
  const mockData = {
    help: { 
      shortcuts: [
        { key: 'Space', action: 'Play/Pause' },
        { key: 'L', action: 'Toggle Loop' },
        // ...
      ]
    },
    settings: { 
      config: { volume: 0.8, loop: false } 
    },
    playlist: { 
      music: ['track1.mp3', 'track2.mp3'], 
      idx: 0 
    }
  };
  return mockData[pageName] || {};
}
```

### Development Workflow
1. Edit HTML/CSS in window file
2. Refresh browser to see changes instantly
3. Mock any dynamic data in `getMockInitData()`
4. Test theme switching, layout, and styling
5. Verify full functionality in Electron app

**Preview Limitations:**
- No real IPC communication
- No file system access
- No native dialogs
- Dynamic data requires manual mocking

## Testing Checklist

### Browser Preview
- [ ] Chrome hidden, content visible
- [ ] Styles apply correctly
- [ ] Mock bridge logs to console
- [ ] Mock config saves to localStorage
- [ ] bridge-ready event fires

### Electron Integration
- [ ] Chrome visible, window controls work
- [ ] Close button closes window
- [ ] Focus/blur states apply
- [ ] init_data received from stage
- [ ] IPC communication works both directions
- [ ] Window reuse works (don't open duplicate)
- [ ] Window close cleans up reference in stage

## Implementation Learnings

### Window ID Handling
**Issue:** Window ID needs to be retrieved dynamically, not passed via init_data.

**Solution:** In window-loader.js, get the window ID after the window is created:
```javascript
ipcRenderer.once('init_data', async (e, data) => {
  stageId = data.stageId;
  windowId = await helper.window.getId();  // Get ID from window itself
  windowType = data.type;
  // ...
});
```

Don't pass `windowId` in init_data - it's always retrieved from the window instance.

### Window Reopen After Close
**Issue:** After closing a window, reopening it fails because the window ID is stale.

**Solution:** Check if window is destroyed before trying to reuse it:
```javascript
async function openWindow(type) {
  if (g.windows[type]) {
    let win = BrowserWindow.fromId(g.windows[type]);
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    // Window was destroyed, clear reference
    g.windows[type] = null;
  }
  
  // Create new window
  g.windows[type] = await tools.browserWindow('frameless', {
    file: `./html/${type}.html`,
    show: false,
    init_data: { type, stageId: await g.win.getId(), config: g.config }
  });
}
```

**Required import:** `const { BrowserWindow } = require('electron');` in stage.js

### Close Button Selector
**Issue:** Wrong CSS selector for close button.

**Solution:** Use NUI framework selector: `.nui-app .controls .close` (not `.window-chrome .close`)

The NUI framework already handles `-webkit-app-region: no-drag` on all `.nui-icon-container` elements, so icons are clickable even in the drag region.

### Window Chrome Styling
**Learnings:**
- NUI framework provides all window chrome styling via nui_app.css
- No need for custom chrome - use existing `.nui-title-bar`, `.content`, `<main>` structure
- The `.content > main` absolute positioning pattern provides the scrollable content area
- window.css only needs to add content-specific styles, not chrome styles

### Focus/Blur States
The NUI framework expects `.focus` class on body element. Window-loader handles this automatically:
```javascript
helper.window.hook_event('blur', (e, data) => {
  document.body.classList.remove('focus');
});
helper.window.hook_event('focus', (e, data) => {
  document.body.classList.add('focus');
});
```

### Window Cleanup
Windows notify stage when closing via IPC:
```javascript
// In window-loader.js closeWindow():
if (stageId && windowType) {
  tools.sendToId(stageId, 'window-closed', { type: windowType, windowId });
}

// In stage.js init():
ipcRenderer.on('window-closed', (e, data) => {
  if (g.windows[data.type] === data.windowId) {
    g.windows[data.type] = null;
  }
});
```

### Global Settings Broadcast
**Pattern:** Changes in stage window broadcast to all windows and persist to config.

**Example - Dark/Light Mode Toggle:**
```javascript
// In stage.js init - Apply theme from config at startup
if(g.config.theme === undefined) { g.config.theme = 'dark'; }
if(g.config.theme === 'dark') {
  document.body.classList.add('dark');
} else {
  document.body.classList.remove('dark');
}

// In stage.js - X key toggles dark mode globally
if(e.keyCode == 88){
  document.body.toggleClass('dark');
  let isDark = document.body.classList.contains('dark');
  g.config.theme = isDark ? 'dark' : 'light';
  g.config_obj.set(g.config);  // Save to config
  tools.broadcast('theme-changed', { dark: isDark });
}

// In stage.js and window-loader.js - All windows listen for theme changes
ipcRenderer.on('theme-changed', (e, data) => {
  if (data.dark) {
    document.body.classList.add('dark');
  } else {
    document.body.classList.remove('dark');
  }
});

// In window-loader.js init - Apply theme from config when window opens
ipcRenderer.once('init_data', async (e, data) => {
  // ... other init code
  if (data.config && data.config.theme === 'dark') {
    document.body.classList.add('dark');
  } else {
    document.body.classList.remove('dark');
  }
});
```

This pattern ensures:
1. Theme persists across app restarts (stored in config)
2. All windows sync to the same theme
3. New windows open with current theme
4. Can be used for any global setting (volume, playback state, etc.)

