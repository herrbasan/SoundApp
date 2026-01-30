'use strict';

import { Visualizers } from './visualizers.js';

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
        if (window.bridge) {
            window.bridge.sendToStage('monitoring-ready', { windowId: window.bridge.windowId });
        }
    },

    setupIPC() {
        if (!window.bridge) return;

        window.bridge.on('clear-waveform', () => {
            this.visualizers.clearWaveform();
            this.fileInfo.innerText = 'Loading...';
        });

        // Peak data for static waveform
        window.bridge.on('waveform-data', (data) => {
            console.log('[Monitoring] Received waveform data:', data ? data.filePath : 'null');
            this.visualizers.setWaveformData(data);
            if (data && data.filePath) {
                this.fileInfo.innerText = data.filePath;
            }
        });

        // Real-time analysis data
        window.bridge.on('ana-data', (data) => {
            // data: { freqL, freqR, timeL, timeR, pos, duration }
            this.visualizers.update(data);
            this.updatePlayhead(data.pos, data.duration);
        });
    },

    setupResizing() {
        window.addEventListener('resize', () => {
            this.visualizers.resize();
        });
    },

    updatePlayhead(pos, duration) {
        if (!duration) return;
        const percent = (pos / duration) * 100;
        this.playhead.style.left = `${percent}%`;
    }
};

window.addEventListener('bridge-ready', (e) => {
    main.init(e.detail);
});
