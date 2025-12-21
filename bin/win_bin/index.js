/**
 * FFmpeg NAPI Interface - JavaScript Wrapper
 * 
 * Provides a clean JavaScript API for the native FFmpeg decoder
 * and audio player classes for Electron/Node.js applications.
 * 
 * @example
 * const { FFmpegDecoder, FFmpegStreamPlayer, getWorkletPath } = require('ffmpeg-napi-interface');
 * 
 * // For streaming playback with gapless looping:
 * const audioContext = new AudioContext({ sampleRate: 44100 });
 * FFmpegStreamPlayer.setDecoder(FFmpegDecoder);
 * const player = new FFmpegStreamPlayer(audioContext);
 * await player.init(getWorkletPath()); // or serve worklet file and use URL
 * await player.open('./music.flac');
 * player.setLoop(true);
 * await player.play();
 */

const path = require('path');

// Import player classes
const { FFmpegStreamPlayer, FFmpegBufferedPlayer, getWorkletPath } = require('./player');

// Lazy load the native addon
let nativeAddon = null;

function loadAddon() {
    if (!nativeAddon) {
        try {
            nativeAddon = require('../build/Release/ffmpeg_napi.node');
        } catch (err) {
            throw new Error(
                'Failed to load native FFmpeg addon. Make sure to run "npm install" or "npm run build" first.\n' +
                'Error: ' + err.message
            );
        }
    }
    return nativeAddon;
}

/**
 * FFmpegDecoder class - High-level JavaScript interface
 * 
 * @example
 * const decoder = new FFmpegDecoder();
 * decoder.open('./audio.mp3');
 * 
 * const { buffer, samplesRead } = decoder.read(44100 * 2); // Read 1 second
 * console.log(`Read ${samplesRead} samples`);
 * 
 * decoder.seek(30.0); // Seek to 30 seconds
 * decoder.close();
 */
class FFmpegDecoder {
    constructor() {
        const addon = loadAddon();
        this._decoder = new addon.FFmpegDecoder();
    }
    
    /**
     * Open an audio file
     * @param {string} filePath - Path to audio file
     * @returns {boolean} true if successful
     */
    open(filePath) {
        return this._decoder.open(filePath);
    }
    
    /**
     * Close the decoder and release resources
     */
    close() {
        this._decoder.close();
    }
    
    /**
     * Seek to a specific position in seconds
     * @param {number} seconds - Position in seconds
     * @returns {boolean} true if successful
     */
    seek(seconds) {
        return this._decoder.seek(seconds);
    }
    
    /**
     * Read audio samples
     * @param {number} numSamples - Number of samples to read (interleaved stereo)
     * @returns {{buffer: Float32Array, samplesRead: number}}
     */
    read(numSamples) {
        return this._decoder.read(numSamples);
    }
    
    /**
     * Get duration in seconds
     * @returns {number}
     */
    getDuration() {
        return this._decoder.getDuration();
    }
    
    /**
     * Get sample rate (always 44100)
     * @returns {number}
     */
    getSampleRate() {
        return this._decoder.getSampleRate();
    }
    
    /**
     * Get number of channels (always 2 for stereo)
     * @returns {number}
     */
    getChannels() {
        return this._decoder.getChannels();
    }
    
    /**
     * Get total number of samples
     * @returns {number}
     */
    getTotalSamples() {
        return this._decoder.getTotalSamples();
    }
    
    /**
     * Check if decoder is open
     * @returns {boolean}
     */
    isOpen() {
        return this._decoder.isOpen();
    }
}

module.exports = {
    FFmpegDecoder,
    FFmpegStreamPlayer,
    FFmpegBufferedPlayer,
    getWorkletPath
};
