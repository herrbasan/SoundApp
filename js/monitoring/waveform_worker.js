'use strict';
const { parentPort, workerData } = require('worker_threads');
const { filePath, binPath, numPoints } = workerData;

try {
    const { FFmpegDecoder } = require(binPath);
    const decoder = new FFmpegDecoder();

    // open(fp, sampleRate, threads)
    // We use 44100 as resample target for analysis
    if (decoder.open(filePath, 44100, 0)) {
        const result = decoder.getWaveform(numPoints);
        const duration = decoder.getDuration();
        decoder.close();

        parentPort.postMessage({
            peaksL: result.peaksL ? Array.from(result.peaksL) : [],
            peaksR: result.peaksR ? Array.from(result.peaksR) : [],
            points: result.points || 0,
            duration: duration
        });
    } else {
        throw new Error('Failed to open file');
    }
} catch (err) {
    parentPort.postMessage({ error: err.message });
}
