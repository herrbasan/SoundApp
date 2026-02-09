'use strict';

import ut from '../../libs/nui/nui_ut.js';
import superSelect from '../../libs/nui/nui_select.js';
import dragSlider from '../../libs/nui/nui_drag_slider.js';
import { Visualizers } from './visualizers.js';

window.ut = ut;
window.superSelect = superSelect;
ut.dragSlider = dragSlider;

export const main = {
    async init(data) {
        // Monitoring window initialized

        this.canvasWaveform = document.getElementById('waveformCanvas');
        this.canvasSpectrum = document.getElementById('spectrumCanvas');
        this.canvasGonio = document.getElementById('gonioCanvas');
        this.canvasCorr = document.getElementById('corrCanvas');
        this.playhead = document.getElementById('playhead');
        this.fileInfo = document.getElementById('file-info');

        this.visualizers = new Visualizers({
            waveform: this.canvasWaveform,
            spectrum: this.canvasSpectrum,
            liveWave: document.getElementById('liveWaveCanvas'),
            gonio: this.canvasGonio,
            corr: this.canvasCorr,
            meters: {
                barS: document.getElementById('lufsBarS'),
                barM: document.getElementById('lufsBarM'),
                barI: document.getElementById('lufsBarI'),
                markerT: document.getElementById('targetMarker'),
                levelBarL: document.getElementById('levelBarL'),
                levelBarR: document.getElementById('levelBarR'),
                levelPeakL: document.getElementById('levelPeakL'),
                levelPeakR: document.getElementById('levelPeakR'),
                valS: document.getElementById('valS'),
                valI: document.getElementById('valI'),
                valLRA: document.getElementById('valLRA'),
                valPLR: document.getElementById('valPLR'),
                valMMax: document.getElementById('valMMax'),
                valPMax: document.getElementById('valPMax'),
                targetPreset: document.getElementById('targetPreset')
            }
        });

        // Title label element inside the NUI title bar
        this.titleLabel = document.querySelector('.nui-title-bar .title .label');
        if (this.titleLabel) this.titleLabel.innerText = 'Monitor - Main Player';

        this.setupIPC();
        this.setupResizing();
        this.setupWaveformSeek();

        // Target selection
        if (this.visualizers.meters.targetPreset) {
            // Initialize nui-select
            superSelect(this.visualizers.meters.targetPreset);
            
            this.visualizers.meters.targetPreset.addEventListener('change', (e) => {
                const val = e.target.value;
                // Toggle loudness calculations on/off
                this.visualizers.setLoudnessEnabled(val !== 'none');
                // Only set numeric target when not 'none'
                if (val !== 'none') this.visualizers.setTarget(parseFloat(val));
            });
            // Set initial loudness state and target
            const initialVal = this.visualizers.meters.targetPreset.value;
            this.visualizers.setLoudnessEnabled(initialVal !== 'none');
            if (initialVal !== 'none') {
                this.visualizers.setTarget(parseFloat(initialVal));
            }
        }

        // Initial draw
        this.visualizers.resize();
        this.visualizers.drawAll();

        // Active data source for monitoring ('main' or 'mixer')
        this.activeSource = 'main';

        // Create analysis worker for off-main-thread loudness/peaks computation
        try {
            this.analysisWorker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
            this.analysisWorker.onmessage = (ev) => {
                const data = ev.data;
                if (!data) return;
                if (data.error) {
                    console.warn('[AnalysisWorker] error:', data.error);
                    return;
                }
                if (this.visualizers && this.visualizers.updateAnalysis) {
                    this.visualizers.updateAnalysis(data);
                }
            };
        } catch (e) {
            console.warn('Failed to create analysis worker', e);
            this.analysisWorker = null;
        }

        if (data && data.filePath) {
            this.fileInfo.innerText = data.filePath;
        }

        // Send ready signal to Stage to trigger initial data push (like overview waveform)
        if (window.bridge && window.bridge.isElectron) {
            window.bridge.sendToStage('monitoring-ready', { windowId: window.bridge.windowId });

            // Global Shortcuts - relay playback controls to stage
            window.addEventListener('keydown', (e) => {
                const code = e.code || '';

                // N: Toggle monitoring window (hide when already open)
                if (e.key === 'n' || e.key === 'N') {
                    e.preventDefault();
                    if (window.bridge && window.bridge.closeWindow) window.bridge.closeWindow();
                    else if (window.bridge && window.bridge.window && window.bridge.window.hide) window.bridge.window.hide();
                    return;
                }

                // Escape: Close monitoring window
                if (code === 'Escape') {
                    e.preventDefault();
                    if (window.bridge && window.bridge.closeWindow) window.bridge.closeWindow();
                    else if (window.bridge && window.bridge.window && window.bridge.window.hide) window.bridge.window.hide();
                    return;
                }

                // F12: Toggle DevTools
                if (code === 'F12') {
                    e.preventDefault();
                    if (window.bridge && window.bridge.toggleDevTools) window.bridge.toggleDevTools();
                    return;
                }

                // Handle global shortcuts via shared module
                if (window.shortcuts && window.shortcuts.handleShortcut) {
                    const action = window.shortcuts.handleShortcut(e, 'monitoring');
                    if (action) return;
                }

                // Relay playback shortcuts to stage (volume, seek, play/pause, loop, shuffle, prev/next)
                if (window.bridge && window.bridge.sendToStage) {
                    window.bridge.sendToStage('stage-keydown', {
                        keyCode: e.keyCode | 0,
                        code: e.code || '',
                        key: e.key || '',
                        ctrlKey: !!e.ctrlKey,
                        shiftKey: !!e.shiftKey,
                        altKey: !!e.altKey,
                        metaKey: !!e.metaKey
                    });
                }
            });
        } else {
            this.startPreviewMode();
        }
    },

    setupIPC() {
        if (!window.bridge) return;
        const self = this;

        // Theme Sync
        window.bridge.on('theme-changed', (data) => {
            if (data.dark) document.body.classList.add('dark');
            else document.body.classList.remove('dark');

            if (this.visualizers) {
                this.visualizers.updateColors();
                this.visualizers.drawAll();
            }
        });

        window.bridge.on('clear-waveform', () => {
            this.visualizers.clearWaveform();
            this.fileInfo.innerText = 'Loading...';
            if (this.analysisWorker) this.analysisWorker.postMessage({ reset: true });
        });

        // File change notification with type
        window.bridge.on('file-change', (data) => {
            // File change event received - update UI accordingly
            
            // Handle MIDI files: fetch and parse timeline for visualization
            if (data.isMIDI) {
                // MIDI file detected - parsing timeline
                // Clear any existing waveform view
                this.visualizers.clearWaveform();
                this.fileInfo.innerText = data.filePath + ' (MIDI - loading timeline...)';

                (async () => {
                    try {
                        // Use provided fileUrl from stage.js (tools.getFileURL)
                        const url = data.fileUrl;
                        if (!url) throw new Error('No fileUrl provided for MIDI file');

                        const resp = await fetch(url);
                        if (!resp.ok) throw new Error('Failed to fetch MIDI file: ' + resp.status);
                        const buf = await resp.arrayBuffer();

                        // Dynamically import local analyzer module
                        const mod = await import(new URL('./midi_analyzer.js', import.meta.url).href);
                        if (!mod || typeof mod.parseMidiChannelActivity !== 'function') throw new Error('MIDI analyzer not available');

                        const activity = mod.parseMidiChannelActivity(buf, 1000); // 500ms gap threshold
                        // Set parsed timeline on visualizers
                        this.visualizers.setMidiActivity(activity);
                        if (data.filePath) this.fileInfo.innerText = data.filePath;
                    } catch (err) {
                        console.warn('[Monitoring] Failed to parse MIDI timeline:', err && err.message);
                        // Fallback to default message
                        this.visualizers.setWaveformData(null);
                        if (data.filePath) this.fileInfo.innerText = data.filePath + ' (MIDI - no timeline)';
                    }
                })();
            }
        });

        // Progressive waveform chunks (streaming for large files)
        window.bridge.on('waveform-chunk', (chunk) => {
            this.visualizers.setWaveformData(chunk);
            if (chunk.filePath) {
                this.fileInfo.innerText = chunk.filePath + (chunk.complete ? '' : ` (${(chunk.progress * 100).toFixed(0)}%)`);
            }
        });

        // Peak data for static waveform (complete, legacy path for small files)
        window.bridge.on('waveform-data', (data) => {
            
            // Handle MIDI files specially - set null data to clear waveform
            if (data && data.isMIDI) {
                this.visualizers.setWaveformData(null);
                if (data.filePath) {
                    this.fileInfo.innerText = data.filePath + ' (MIDI - no waveform)';
                }
                return;
            }
            
            this.visualizers.setWaveformData(data);
            if (data && data.filePath) {
                this.fileInfo.innerText = data.filePath;
            }
        });

        // Real-time analysis data - coalesce updates within RAF frames
        let pendingData = null;
        let rafId = 0;
        window.bridge.on('ana-data', (data) => {
            // Ignore data that isn't from the currently active source
            if (data && data.source && this.activeSource && data.source !== this.activeSource) return;
            pendingData = data;
            if (!rafId) {
                rafId = requestAnimationFrame(() => {
                    rafId = 0;
                    if (pendingData) {
                        self.visualizers.update(pendingData);
                        self.updatePlayhead(pendingData.pos, pendingData.duration);
                        // Post to worker for heavy analysis (transfer buffers if available)
                        try {
                            if (self.analysisWorker && pendingData.timeL) {
                                const timeLbuf = pendingData.timeL.buffer ? pendingData.timeL.buffer : pendingData.timeL;
                                const timeRbuf = pendingData.timeR && pendingData.timeR.buffer ? pendingData.timeR.buffer : pendingData.timeR;
                                self.analysisWorker.postMessage({
                                    timeLBuffer: timeLbuf,
                                    timeRBuffer: timeRbuf,
                                    sampleRate: pendingData.sampleRate,
                                    minimal: !self.visualizers.loudnessEnabled
                                }, timeRbuf ? [timeLbuf, timeRbuf] : [timeLbuf]);
                            }
                        } catch (e) {
                            // fallback: post without transfer
                            if (self.analysisWorker && pendingData.timeL) {
                                self.analysisWorker.postMessage({
                                    timeLBuffer: pendingData.timeL,
                                    timeRBuffer: pendingData.timeR,
                                    sampleRate: pendingData.sampleRate,
                                    minimal: !self.visualizers.loudnessEnabled
                                });
                            }
                        }
                    }
                });
            }
        });

        // Allow external windows to switch the active monitoring source
        window.bridge.on('set-monitoring-source', (src) => {
            // set-monitoring-source received
            this.activeSource = src || 'main';
            const titleText = this.activeSource === 'mixer' ? 'Monitoring - Mixer' : 'Monitoring - Main Player';
            document.title = titleText;
            if (this.titleLabel) this.titleLabel.innerText = titleText.replace('Monitoring - ', 'Monitor - ');
            if (this.activeSource === 'mixer') {
                this.visualizers.clearWaveform();
                this.fileInfo.innerText = 'Mixer';
            }
        });
    },

    setupResizing() {
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.visualizers.resize();
            }, 16); // ~60fps throttle
        });
    },

    setupWaveformSeek() {
        if (!this.canvasWaveform || !window.bridge || !window.bridge.isElectron) return;

        // Target the canvas container (which has dimensions), not the canvas itself
        const container = this.canvasWaveform.parentElement;
        if (!container) return;

        ut.dragSlider(container, (e) => {
            // Ignore end event - it causes duplicate seeks after start/move
            if (e.type === 'end') return;
            
            // Use stored duration (available even for MIDI files without waveform)
            const duration = this.visualizers.currentDuration;
            if (!duration) return;

            // Account for canvas padding (waveform is drawn with padding on both sides)
            const padding = (this.visualizers.layout && this.visualizers.layout.padding) || 0;
            const containerWidth = container.offsetWidth;
            const innerWidth = containerWidth - (padding * 2);
            
            // Convert click position from container space to inner waveform space
            const clickX = e.x - padding;
            const normalizedX = Math.max(0, Math.min(1, clickX / innerWidth));
            const seekTime = normalizedX * duration;
            
            // Seeking to new position
            window.bridge.sendToStage('player-seek', { time: seekTime });
        });
    },

    updatePlayhead(pos, duration) {
        if (!duration) return;
        
        // Account for canvas padding (waveform is drawn with padding on both sides)
        const padding = (this.visualizers.layout && this.visualizers.layout.padding) || 0;
        const containerWidth = this.canvasWaveform.parentElement.offsetWidth;
        const innerWidth = containerWidth - (padding * 2);
        
        // Position playhead within the inner waveform area
        const normalizedPos = pos / duration;
        const pixelPos = padding + (normalizedPos * innerWidth);
        
        this.playhead.style.left = `${pixelPos}px`;
    },

    /**
     * Preview Mode for Live-Server (Browser Styling)
     * lightweight, static data injection
     */
    startPreviewMode() {
        console.warn('⚠️ Starting Monitoring Preview Mode');
        document.body.classList.add('preview-mode');

        // Add Visual Indicator
        const badge = document.createElement('div');
        Object.assign(badge.style, {
            position: 'absolute', top: '0', right: '0', background: '#d00', color: '#fff',
            fontSize: '9px', padding: '2px 6px', zIndex: '9999', pointerEvents: 'none',
            fontWeight: 'bold', fontFamily: 'sans-serif', opacity: '0.8'
        });
        badge.innerText = 'PREVIEW';
        document.body.appendChild(badge);

        // Toggle Theme Shortcut (Preview Only)
        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'x') {
                document.body.classList.toggle('dark');
                if (window.visualizers) window.visualizers.updateColors();
                this.startPreviewMode(); // Re-draw with new colors
            }
        });

        // 1. Fake Waveform Overview (Simulate a track)
        const waveLen = 200;
        const peaksL = new Float32Array(waveLen);
        for (let i = 0; i < waveLen; i++) {
            // Envelope shaped noise
            let env = Math.sin((i / waveLen) * Math.PI);
            peaksL[i] = (Math.random() * 0.5 + 0.5) * env;
        }
        this.visualizers.setWaveformData({ peaksL, peaksR: peaksL, points: waveLen, duration: 180, filePath: 'Preview Track.wav' });

        // 2. Fake Spectrum (Pink Noise-ish curve)
        const freqLen = 512;
        const freqL = new Uint8Array(freqLen);
        for (let i = 0; i < freqLen; i++) {
            // Logarithmic drop-off
            let val = 255 - (Math.log(i + 1) / Math.log(freqLen)) * 200;
            // Add some "peaks"
            val += Math.sin(i * 0.1) * 20;
            freqL[i] = Math.max(0, Math.min(255, val));
        }

        // 3. Fake Live Wave (Nice sine/harmonic sum)
        const timeLen = 1024;
        const timeL = new Uint8Array(timeLen);
        const timeR = new Uint8Array(timeLen);
        for (let i = 0; i < timeLen; i++) {
            let t = i / timeLen * Math.PI * 4;
            let val = Math.sin(t) * 0.5 + Math.sin(t * 3) * 0.2 + Math.random() * 0.05;
            timeL[i] = 128 + val * 80;
            timeR[i] = 128 + (Math.sin(t + 0.5) * 0.5 + Math.sin(t * 3) * 0.2) * 80; // Slight phase offset
        }

        // Apply Data
        this.visualizers.update({
            freqL, freqR: freqL,
            timeL, timeR,
            sampleRate: 48000,
            pos: 60,
            duration: 180
        });

        // 4. Force stats for Meters (Override what update() calculated to show "ideal" values)
        const v = this.visualizers;
        const meters = v.meters;

        // Manually set text
        if (meters.valS) meters.valS.innerText = "-14.2";
        if (meters.valI) meters.valI.innerText = "-13.8";
        if (meters.valLRA) meters.valLRA.innerText = "5.4";
        if (meters.valPLR) meters.valPLR.innerText = "12.6";
        if (meters.valMMax) meters.valMMax.innerText = "-10.2";
        if (meters.valPMax) meters.valPMax.innerText = "-1.1";

        // Manually set bars (visualizers.drawLoudness would overwrite this on next frame, but we only update once)
        // We need to overwrite the internal smooth/stats or directly styling after update
        if (meters.barS) meters.barS.style.height = "75%";
        if (meters.barM) meters.barM.style.bottom = "80%";
        if (meters.barI) meters.barI.style.bottom = "78%";

        // Force danger class on PMax
        if (meters.valPMax) meters.valPMax.classList.add('danger');
    }
};

window.addEventListener('bridge-ready', (e) => {
    main.init(e.detail);
});
