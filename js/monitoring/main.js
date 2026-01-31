'use strict';

import ut from '../../libs/nui/nui_ut.js';
import dragSlider from '../../libs/nui/nui_drag_slider.js';
import { Visualizers } from './visualizers.js';

window.ut = ut;
ut.dragSlider = dragSlider;

export const main = {
    async init(data) {
        console.log('[Monitoring] Initializing with data:', data);

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

        this.setupIPC();
        this.setupResizing();
        this.setupWaveformSeek();

        // Target selection
        if (this.visualizers.meters.targetPreset) {
            this.visualizers.meters.targetPreset.addEventListener('change', (e) => {
                this.visualizers.setTarget(parseFloat(e.target.value));
            });
            // Set initial
            this.visualizers.setTarget(parseFloat(this.visualizers.meters.targetPreset.value));
        }

        // Initial draw
        this.visualizers.resize();
        this.visualizers.drawAll();

        if (data && data.filePath) {
            this.fileInfo.innerText = data.filePath;
        }

        // Send ready signal to Stage to trigger initial data push (like overview waveform)
        if (window.bridge && window.bridge.isElectron) {
            window.bridge.sendToStage('monitoring-ready', { windowId: window.bridge.windowId });

            // Global Shortcuts
            if (window.shortcuts) {
                window.addEventListener('keydown', (e) => {
                    window.shortcuts.handleShortcut(e, 'monitoring');
                });
            }
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
        });

        // Progressive waveform chunks (streaming for large files)
        window.bridge.on('waveform-chunk', (chunk) => {
            console.log('[Monitoring] Received waveform chunk. Progress:', (chunk.progress * 100).toFixed(1) + '%');
            this.visualizers.setWaveformData(chunk);
            if (chunk.filePath) {
                this.fileInfo.innerText = chunk.filePath + (chunk.complete ? '' : ` (${(chunk.progress * 100).toFixed(0)}%)`);
            }
        });

        // Peak data for static waveform (complete, legacy path for small files)
        window.bridge.on('waveform-data', (data) => {
            console.log('[Monitoring] Received waveform data:', data ? data.filePath : 'null');
            this.visualizers.setWaveformData(data);
            if (data && data.filePath) {
                this.fileInfo.innerText = data.filePath;
            }
        });

        // Real-time analysis data - coalesce updates within RAF frames
        let pendingData = null;
        let rafId = 0;
        window.bridge.on('ana-data', (data) => {
            pendingData = data;
            if (!rafId) {
                rafId = requestAnimationFrame(() => {
                    rafId = 0;
                    if (pendingData) {
                        self.visualizers.update(pendingData);
                        self.updatePlayhead(pendingData.pos, pendingData.duration);
                    }
                });
            }
        });
    },

    setupResizing() {
        window.addEventListener('resize', () => {
            this.visualizers.resize();
        });
    },

    setupWaveformSeek() {
        if (!this.canvasWaveform || !window.bridge || !window.bridge.isElectron) return;

        // Target the canvas container (which has dimensions), not the canvas itself
        const container = this.canvasWaveform.parentElement;
        if (!container) return;

        ut.dragSlider(container, (e) => {
            const waveData = this.visualizers.waveformData;
            if (!waveData || !waveData.duration) return;

            // Account for canvas padding (waveform is drawn with padding on both sides)
            const padding = (this.visualizers.layout && this.visualizers.layout.padding) || 0;
            const containerWidth = container.offsetWidth;
            const innerWidth = containerWidth - (padding * 2);
            
            // Convert click position from container space to inner waveform space
            const clickX = e.x - padding;
            const normalizedX = Math.max(0, Math.min(1, clickX / innerWidth));
            const seekTime = normalizedX * waveData.duration;
            
            console.log('[Monitoring] Seeking to:', seekTime.toFixed(2));
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
