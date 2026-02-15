# SoundApp Logging System

Centralized logging system for SoundApp that writes to timestamped log files in development mode.

## Overview

- **Main Process** (`js/logger-main.js`): Writes logs to files, manages log rotation, captures all console output
- **Renderer Process** (`js/logger-renderer.js`): Sends logs to main via IPC, captures window console output
- **Scope-based**: Every log entry is tagged with its source (main, engine, player, etc.)
- **Clean Terminal**: All console.log/warn calls are captured to file, terminal stays clean (errors still show)

## Log Location

```
<project-root>/logs/soundapp-YYYY-MM-DDTHH-MM-SS.log
```

Logs are created in a `logs/` directory inside the project folder, making them easily accessible during development. Only created when running in development mode (`!app.isPackaged`).

## Usage

### In Main Process (app.js)

```javascript
const logger = require('./logger-main');

// Initialize early in app lifecycle
await logger.init(app);

// Capture all console.* output to file (keeps terminal clean)
logger.captureConsole(true);

// Log with scope
logger.info('main', 'Something happened', { detail: 'value' });
logger.debug('engine', 'Debug info');
logger.warn('state', 'Warning message');
logger.error('audio', 'Error occurred', error);

// All console.log/warn calls now automatically go to the log file
console.log('This goes to file, not terminal');
```

### In Renderer Process (windows)

```javascript
// Via window-loader.js (auto-initialized)
const logger = require('./logger-renderer');
logger.init(); // Auto-detects scope from URL

// Or explicit scope
logger.init('custom-scope');

// Log messages
logger.info('Window loaded', { windowId: 123 });
logger.error('Failed to load', error);
```

### Via Bridge (in child windows)

```javascript
// After bridge-ready event
window.bridge.logger.info('Message', data);
```

## Log Format

```
[2026-02-15T21:45:30.123Z] [INFO ] [main        ] App started | {"version":"2.1.3"}
[2026-02-15T21:45:30.456Z] [DEBUG] [engine      ] Engine initializing
[2026-02-15T21:45:31.789Z] [INFO ] [player      ] File loaded | {"file":"song.mp3"}
```

## Log Levels

- `DEBUG` - Detailed debugging information
- `INFO`  - General information
- `WARN`  - Warnings that don't prevent operation
- `ERROR` - Errors that affect functionality

## Log Retention

Only the 10 most recent log files are kept. Older files are automatically deleted on startup.

## Console Access

In DevTools console:

```javascript
// Get log file path (main process)
logger.getLogPath()

// Check if logging is enabled
logger.isEnabled()
```
