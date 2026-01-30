'use strict';

/**
 * Extracts peak data from an audio file using the native FFmpegDecoder.getWaveform method.
 * 
 * @param {string} filePath - Path to the audio file
 * @param {Object} FFmpegDecoder - The native FFmpegDecoder class
 * @param {Object} options - Options for extraction
 * @param {number} [options.samples=1000] - Number of peak points to extract
 * @returns {Promise<Object>} - Peak data for L and R channels
 */
async function extractPeaks(filePath, FFmpegDecoder, options = {}) {
    const numPoints = options.samples || 1000;

    return new Promise((resolve, reject) => {
        const decoder = new FFmpegDecoder();

        try {
            // open(filePath, outSampleRate, threads)
            // For waveform generation, we don't care about the sample rate, 
            // but we'll use 44100 as a sane default for the internal resampler.
            if (!decoder.open(filePath, 44100, 0)) {
                return reject(new Error(`Failed to open file for peak analysis: ${filePath}`));
            }

            const result = decoder.getWaveform(numPoints);
            const duration = decoder.getDuration();
            decoder.close();

            resolve({
                peaksL: result.peaksL ? Array.from(result.peaksL) : [],
                peaksR: result.peaksR ? Array.from(result.peaksR) : [],
                points: result.points || 0,
                duration: duration
            });
        } catch (err) {
            try { decoder.close(); } catch (e) { }
            reject(err);
        }
    });
}

module.exports = {
    extractPeaks
};
