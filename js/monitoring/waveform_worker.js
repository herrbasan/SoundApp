'use strict';
const { parentPort, workerData } = require('worker_threads');
const { filePath, binPath, numPoints, chunkSizeMB } = workerData;

const CHUNK_SIZE_MB = chunkSizeMB || 10;
let aborted = false;

// Listen for abort signal
parentPort.on('message', (msg) => {
    if (msg === 'abort') {
        aborted = true;
    }
});

try {
    const { FFmpegDecoder } = require(binPath);
    const decoder = new FFmpegDecoder();

    if (!decoder.open(filePath, 44100, 0)) {
        throw new Error('Failed to open file');
    }

    const duration = decoder.getDuration();
    
    // Progress callback - returns false to abort
    const progressCallback = (data) => {
        if (aborted) return false; // Abort requested
        
        parentPort.postMessage({
            peaksL: Array.from(data.peaksL),
            peaksR: Array.from(data.peaksR),
            points: data.points,
            duration: duration,
            progress: data.progress,
            complete: data.progress >= 1.0
        });
        
        return true; // Continue processing
    };
    
    const result = decoder.getWaveformStreaming(numPoints, CHUNK_SIZE_MB, progressCallback);
    decoder.close();
    
    // Final message (may have been sent by callback already)
    if (!aborted) {
        parentPort.postMessage({
            peaksL: Array.from(result.peaksL),
            peaksR: Array.from(result.peaksR),
            points: result.points,
            duration: duration,
            progress: 1.0,
            complete: true
        });
    }
} catch (err) {
    if (!aborted) {
        parentPort.postMessage({ error: err.message, complete: true });
    }
}
