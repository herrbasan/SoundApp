'use strict';

export class Visualizers {
    constructor(canvases) {
        this.canvases = canvases;
        this.ctxs = {
            waveform: canvases.waveform.getContext('2d'),
            spectrum: canvases.spectrum.getContext('2d'),
            liveWave: canvases.liveWave.getContext('2d'),
            gonio: canvases.gonio.getContext('2d'),
            corr: canvases.corr.getContext('2d')
        };
        this.meters = canvases.meters; // { rmsL, rmsR, lufsL, lufsR, readoutM, readoutI }

        this.waveformData = null;
        this.anaData = null;

        // Colors
        this.colors = {};
        this.updateColors();

        if (window.ut) {

            // Use NUI utility to read CSS variables
            const waveColor = ut.getCssVar('--waveform-color');
            const specColor = ut.getCssVar('--spectrum-color');
            const accColor = ut.getCssVar('--accent-color');

            this.colors.waveform = waveColor.value || '#444';
            this.colors.spectrum = specColor.value || 'rgb(64, 168, 59)';

            // Compute fill from spectrum color
            if (this.colors.spectrum.includes('rgb')) {
                this.colors.spectrumFill = this.colors.spectrum.replace('rgb', 'rgba').replace(')', ', 0.3)');
            } else {
                this.colors.spectrumFill = 'rgba(64, 168, 59, 0.3)';
            }

            this.colors.liveWave = accColor.value || 'rgb(64, 168, 59)';
            this.colors.gonio = accColor.value || 'rgb(64, 168, 59)';
            this.colors.corr = accColor.value || 'rgb(64, 168, 59)';
        }

        // State for smoothing
        this.smoothCorr = 1.0;
        this.lufsHold = { L: 0, R: 0 };
        this.rmsSmooth = { L: 0, R: 0 };

        // LUFS State
        this.filtersL = [new KWeightFilter(), new KWeightFilter()]; // Stage 1 & 2
        this.filtersR = [new KWeightFilter(), new KWeightFilter()];

        this.shortTermBuffer = []; // Sliding window for S LUFS (3s)
        this.lraHistory = [];      // Gated history for LRA
        this.gatedBlocks = [];     // BS.1770-4: Store absolute-gated power blocks for relative gating
        this.integratedSum = 0;
        this.integratedCount = 0;
        this.lastSampleRate = 48000;

        // Stats
        this.stats = {
            mMax: -100,
            sMax: -100,
            pMax: -100,
            lra: 0,
            target: -14
        };

        // Smoothing for S and I bars
        this.smoothS = 0;
        this.smoothI = 0;

        // Spectrum State (64 bands, log-spaced 20Hz-20kHz)
        this.spectrumBands = this.generateLogBands(20, 20000, 64);
        this.bandLevels = new Array(64).fill(0);
        this.bandPeaks = new Array(64).fill(0);

        // Temporal smoothing for live waveform
        this.smoothedL = null;
        this.smoothedR = null;
        this.waveSmoothing = 0.7; // 0 = no smoothing, 0.9 = very smooth
    }

    generateLogBands(minFreq, maxFreq, numBands) {
        const bands = [];
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);
        const step = (logMax - logMin) / (numBands - 1);
        for (let i = 0; i < numBands; i++) {
            bands.push(Math.pow(10, logMin + i * step));
        }
        return bands;
    }

    updateColors() {
        if (!window.ut) return;

        // Use NUI utility to read CSS variables
        const waveColor = ut.getCssVar('--waveform-color');
        const specColor = ut.getCssVar('--spectrum-color');
        const accColor = ut.getCssVar('--accent-color');

        // Layout props
        const waveGap = ut.getCssVar('--waveform-gap');
        const waveMin = ut.getCssVar('--waveform-min-width');
        const specGap = ut.getCssVar('--spectrum-gap');
        const liveWidth = ut.getCssVar('--live-width');
        const gridColor = ut.getCssVar('--grid-color');
        const gonioBg = ut.getCssVar('--gonio-bg');
        const labelColor = ut.getCssVar('--label-color');
        const padding = ut.getCssVar('--canvas-padding');

        this.colors.waveform = waveColor.value || '#444';
        this.colors.spectrum = specColor.value || 'rgb(64, 168, 59)';
        this.colors.grid = gridColor.value || 'rgba(255, 255, 255, 0.1)';
        this.colors.gonioBg = gonioBg.value || 'rgba(0, 0, 0, 0.8)';
        this.colors.label = labelColor.value || '#888';

        this.layout = this.layout || {};
        this.layout.padding = padding.computed !== undefined ? padding.computed : 0;
        this.layout.waveGap = waveGap.computed !== undefined ? waveGap.computed : 0;
        this.layout.waveMin = waveMin.computed !== undefined ? waveMin.computed : 1;
        this.layout.specGap = specGap.computed !== undefined ? specGap.computed : 2;
        this.layout.liveWidth = liveWidth.computed !== undefined ? liveWidth.computed : 1.2;

        // Compute fill from spectrum color
        if (this.colors.spectrum.includes('rgb')) {
            this.colors.spectrumFill = this.colors.spectrum.replace('rgb', 'rgba').replace(')', ', 0.3)');
        } else {
            this.colors.spectrumFill = 'rgba(64, 168, 59, 0.3)';
        }

        this.colors.liveWave = accColor.value || 'rgb(64, 168, 59)';
        this.colors.gonio = accColor.value || 'rgb(64, 168, 59)';
        this.colors.corr = accColor.value || 'rgb(64, 168, 59)';
    }

    setTarget(val) {
        this.stats.target = val;
        if (this.meters.markerT) {
            this.meters.markerT.style.bottom = `${this.mapToPercent(val)}%`;
        }
    }

    mapToPercent(lufs) {
        // Range 0 to -60 LUFS
        return Math.max(0, Math.min(100, (lufs + 60) * (100 / 60)));
    }

    resize() {
        for (const key in this.canvases) {
            if (key === 'meters') continue;
            const canvas = this.canvases[key];
            if (!canvas) continue;
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width * window.devicePixelRatio;
            canvas.height = rect.height * window.devicePixelRatio;
        }
        this.drawAll();
    }

    setWaveformData(data) {
        console.log('[Visualizers] setWaveformData received. points:', data ? data.points : 'null');
        this.waveformData = data;
        this.midiActivity = null; // Clear MIDI data when waveform is set
        this.drawWaveform();
    }

    update(data) {
        this.anaData = data;

        // Handle Sample Rate changes for Filters
        if (data.sampleRate && data.sampleRate !== this.lastSampleRate) {
            this.lastSampleRate = data.sampleRate;
            [...this.filtersL, ...this.filtersR].forEach(f => f.reset());
        }

        this.drawSpectrum();
        this.drawLiveWave();
        this.drawGonio();
        this.drawCorr();
        this.drawLoudness();
    }

    drawAll() {
        this.drawWaveform();
        this.drawSpectrum();
        this.drawLiveWave();
        this.drawGonio();
        this.drawCorr();
    }

    clearWaveform() {
        this.waveformData = null;
        const ctx = this.ctxs.waveform;
        ctx.clearRect(0, 0, this.canvases.waveform.width, this.canvases.waveform.height);

        // Reset Stats
        this.integratedSum = 0;
        this.integratedCount = 0;
        this.shortTermBuffer = [];
        this.lraHistory = [];
        this.gatedBlocks = [];
        this.stats.mMax = -100;
        this.stats.sMax = -100;
        this.stats.pMax = -100;
        this.stats.lra = 0;
        this.smoothS = 0;
        this.smoothI = 0;

        // Reset Level meters
        this.levelPeakHoldL = 0;
        this.levelPeakHoldR = 0;
        this.levelPeakDecayL = 0;
        this.levelPeakDecayR = 0;
    }

    drawWaveform() {
        const ctx = this.ctxs.waveform;
        const w = this.canvases.waveform.width;
        const h = this.canvases.waveform.height;
        ctx.clearRect(0, 0, w, h);

        if (!this.waveformData || !this.waveformData.peaksL) return;

        const peaks = this.waveformData.peaksL;
        const padding = (this.layout && this.layout.padding) || 0;
        const innerW = w - (padding * 2);

        const step = innerW / peaks.length;
        const mid = h / 2;

        ctx.beginPath();
        ctx.strokeStyle = this.colors.waveform;

        // Dynamic width with small gap
        const gap = (this.layout && this.layout.waveGap !== undefined) ? this.layout.waveGap : 0;
        const minW = (this.layout && this.layout.waveMin !== undefined) ? this.layout.waveMin : 1;

        const barWidth = Math.max(minW, step - gap);
        ctx.lineWidth = barWidth;

        // Use "butt" cap for precise gap rendering
        ctx.lineCap = 'butt';

        for (let i = 0; i < peaks.length; i++) {
            // Draw in the center of the "step" slot, offset by padding
            const x = padding + (i * step) + (step / 2);
            const amp = peaks[i] * (h - padding * 2) * 0.45;
            ctx.moveTo(x, mid - amp);
            ctx.lineTo(x, mid + amp);
        }
        ctx.stroke();
        // Reset lineCap
        ctx.lineCap = 'round';
    }

    drawSpectrum() {
        const ctx = this.ctxs.spectrum;
        const w = this.canvases.spectrum.width;
        const h = this.canvases.spectrum.height;

        ctx.clearRect(0, 0, w, h);
        if (!this.anaData || !this.anaData.freqL) return;

        const dataL = this.anaData.freqL;
        const dataR = this.anaData.freqR;
        const len = dataL.length;
        const sr = this.lastSampleRate;

        // AnalyserNode.frequencyBinCount is N/2
        const fftSize = len * 2;

        const padding = (this.layout && this.layout.padding) || 0;
        const innerW = w - (padding * 2);

        const numBands = this.spectrumBands.length;
        const barGap = (this.layout && this.layout.specGap !== undefined) ? this.layout.specGap : 2;
        const barWidth = (innerW - (numBands - 1) * barGap) / numBands;

        // Gradient for bars
        // const gradient = ctx.createLinearGradient(0, h, 0, 0);
        // gradient.addColorStop(0, '#9d50bb');
        // gradient.addColorStop(0.5, '#6e48aa');
        // gradient.addColorStop(1, '#00d2ff');

        const gradient = 'rgb(64, 168, 59)';

        for (let i = 0; i < numBands; i++) {
            const centerFreq = this.spectrumBands[i];
            const lowFreq = centerFreq / 1.122; // 2^(1/6)
            const highFreq = centerFreq * 1.122;

            // Map frequencies to FFT indices
            const startIdx = Math.max(0, Math.floor(lowFreq * fftSize / sr));
            const endIdx = Math.min(len - 1, Math.floor(highFreq * fftSize / sr));

            let sum = 0;
            let count = 0;

            // Average current band energy (mono sum of L+R)
            for (let j = startIdx; j <= endIdx; j++) {
                const monoVal = dataR ? (dataL[j] + dataR[j]) / 2 : dataL[j];
                sum += monoVal / 255;
                count++;
            }

            // Ensure we catch energy even if the band is narrow
            if (count === 0 && startIdx < len) {
                const monoVal = dataR ? (dataL[startIdx] + dataR[startIdx]) / 2 : dataL[startIdx];
                sum = monoVal / 255;
                count = 1;
            }

            let val = count > 0 ? sum / count : 0;

            // Attack/Release ballistics (nearly instant attack, fast release)
            if (val > this.bandLevels[i]) {
                this.bandLevels[i] = val; // Instant attack
            } else {
                this.bandLevels[i] += (val - this.bandLevels[i]) * 0.6; // Fast release
            }

            const barHeight = this.bandLevels[i] * (h - padding * 2) * 0.9;
            const x = padding + (i * (barWidth + barGap));

            // Draw Bar
            ctx.fillStyle = gradient;
            ctx.fillRect(x, (h - padding) - barHeight, barWidth, barHeight);
        }

        // Draw basic labels for octaves
        ctx.fillStyle = this.colors.label || 'rgba(255, 255, 255, 0.3)';
        ctx.font = '10px Inter, sans-serif';
        const octaves = [100, 1000, 10000];
        octaves.forEach(freq => {
            const bandIdx = this.spectrumBands.findIndex(f => f >= freq);
            if (bandIdx !== -1) {
                const x = padding + (bandIdx * (barWidth + barGap));
                ctx.fillText(freq >= 1000 ? (freq / 1000) + 'k' : freq, x, h - padding - 5);
            }
        });
    }

    drawLiveWave() {
        const ctx = this.ctxs.liveWave;
        const w = this.canvases.liveWave.width;
        const h = this.canvases.liveWave.height;

        ctx.clearRect(0, 0, w, h);
        if (!this.anaData || !this.anaData.timeL) return;

        const tL = this.anaData.timeL;
        const tR = this.anaData.timeR;
        const len = tL.length;
        const mid = h / 2;
        const padding = (this.layout && this.layout.padding) || 0;
        const innerW = w - (padding * 2);
        const smooth = this.waveSmoothing;

        // Initialize smoothing buffer on first run or size change
        if (!this.smoothedMono || this.smoothedMono.length !== len) {
            this.smoothedMono = new Float32Array(len);
            for (let i = 0; i < len; i++) {
                const mono = tR ? (tL[i] + tR[i]) / 2 : tL[i];
                this.smoothedMono[i] = mono;
            }
        }

        // Apply temporal smoothing: blend previous frame with current (mono mix)
        for (let i = 0; i < len; i++) {
            const mono = tR ? (tL[i] + tR[i]) / 2 : tL[i];
            this.smoothedMono[i] = this.smoothedMono[i] * smooth + mono * (1 - smooth);
        }

        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';

        // Draw mono waveform
        ctx.beginPath();
        ctx.strokeStyle = this.colors.liveWave;
        for (let i = 0; i < len; i++) {
            const x = padding + ((i / len) * innerW);
            const y = mid + ((this.smoothedMono[i] - 128) / 128) * mid * 2.5;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Midline
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.colors.grid || 'rgba(255, 255, 255, 0.05)';
        ctx.beginPath();
        ctx.moveTo(padding, mid);
        ctx.lineTo(w - padding, mid);
        ctx.stroke();
    }

    drawGonio() {
        const ctx = this.ctxs.gonio;
        const w = this.canvases.gonio.width;
        const h = this.canvases.gonio.height;
        const midX = w / 2;
        const midY = h / 2;
        const padding = (this.layout && this.layout.padding) || 0;
        const innerW = w - (padding * 2);
        const innerH = h - (padding * 2);

        ctx.fillStyle = this.colors.gonioBg || 'rgba(0,0,0,0.8)';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = this.colors.grid || 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(padding, midY); ctx.lineTo(w - padding, midY);
        ctx.moveTo(midX, padding); ctx.lineTo(midX, h - padding);
        ctx.stroke();

        if (!this.anaData || !this.anaData.timeL) return;

        const tL = this.anaData.timeL;
        const tR = this.anaData.timeR;
        const len = tL.length;

        ctx.beginPath();
        ctx.strokeStyle = this.colors.gonio;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 5;
        ctx.shadowColor = this.colors.gonio;

        for (let i = 0; i < len; i += 4) {
            const l = (tL[i] - 128) / 128;
            const r = (tR[i] - 128) / 128;

            const x = (l - r) * 0.707 * (innerW / 2);
            const y = (l + r) * 0.707 * (innerH / 2);

            if (i === 0) ctx.moveTo(midX + x, midY - y);
            else ctx.lineTo(midX + x, midY - y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    drawCorr() {
        const ctx = this.ctxs.corr;
        const w = this.canvases.corr.width;
        const h = this.canvases.corr.height;
        ctx.clearRect(0, 0, w, h);

        const padding = (this.layout && this.layout.padding) || 0;
        const innerW = w - (padding * 2);

        ctx.strokeStyle = this.colors.grid || 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(padding, h / 2); ctx.lineTo(w - padding, h / 2);
        ctx.moveTo(w / 2, padding); ctx.lineTo(w / 2, h - padding);
        ctx.stroke();

        if (!this.anaData || !this.anaData.timeL || !this.anaData.timeR) return;

        const tL = this.anaData.timeL;
        const tR = this.anaData.timeR;

        let sumLR = 0;
        let sumL2 = 0;
        let sumR2 = 0;

        for (let i = 0; i < tL.length; i++) {
            const l = (tL[i] - 128) / 128;
            const r = (tR[i] - 128) / 128;
            sumLR += l * r;
            sumL2 += l * l;
            sumR2 += r * r;
        }

        const denominator = Math.sqrt(sumL2 * sumR2);
        const instantCorr = denominator > 0.00001 ? (sumLR / denominator) : 1.0;

        const coef = 0.1;
        this.smoothCorr += (instantCorr - this.smoothCorr) * coef;

        const x = padding + ((this.smoothCorr + 1) / 2) * innerW;
        const barW = 4;

        ctx.fillStyle = this.colors.corr;
        ctx.shadowBlur = 10;
        ctx.shadowColor = this.colors.corr;
        ctx.fillRect(x - barW / 2, 5 + padding, barW, h - 15 - (padding * 2));
        ctx.shadowBlur = 0;
    }

    drawLoudness() {
        if (!this.anaData || !this.anaData.timeL || !this.meters) return;

        const tL = this.anaData.timeL;
        const tR = this.anaData.timeR;
        const sr = this.lastSampleRate;

        // 1. K-Weighting & Peak Tracking
        let peakChunk = 0;
        let peakL = 0, peakR = 0;
        let meanSquareSumL = 0;
        let meanSquareSumR = 0;

        for (let i = 0; i < tL.length; i++) {
            let l = (tL[i] - 128) / 128;
            let r = (tR[i] - 128) / 128;

            // Track peak per channel for level meters
            const absL = Math.abs(l);
            const absR = Math.abs(r);
            if (absL > peakL) peakL = absL;
            if (absR > peakR) peakR = absR;

            peakChunk = Math.max(peakChunk, absL, absR);

            l = this.filtersL[1].process(this.filtersL[0].process(l, sr, 1), sr, 2);
            r = this.filtersR[1].process(this.filtersR[0].process(r, sr, 1), sr, 2);

            meanSquareSumL += l * l;
            meanSquareSumR += r * r;
        }

        const meanSquareCombined = (meanSquareSumL + meanSquareSumR) / (tL.length * 2);
        const momentaryLUFS = -0.691 + 10 * Math.log10(Math.max(meanSquareCombined, 1e-10));

        const peakDB = 20 * Math.log10(Math.max(peakChunk, 1e-5));
        if (peakDB > this.stats.pMax) this.stats.pMax = peakDB;
        if (momentaryLUFS > this.stats.mMax) this.stats.mMax = momentaryLUFS;

        // 2. Short-term LUFS (3s sliding window)
        this.shortTermBuffer.push(meanSquareCombined);
        if (this.shortTermBuffer.length > 180) this.shortTermBuffer.shift();

        const shortTermMeanSquare = this.shortTermBuffer.reduce((a, b) => a + b, 0) / this.shortTermBuffer.length;
        const shortTermLUFS = -0.691 + 10 * Math.log10(Math.max(shortTermMeanSquare, 1e-10));

        // 3. BS.1770-4 Integrated LUFS with Two-Pass Gating
        // Pass 1: Absolute Gate (-70 LUFS)
        if (momentaryLUFS > -70) {
            this.gatedBlocks.push(meanSquareCombined);
            this.lraHistory.push(shortTermMeanSquare); // Collect gated S samples for LRA
        }

        // Pass 2: Relative Gate (Absolute Gated Average - 10 LU)
        let integratedLUFS = -Infinity;
        if (this.gatedBlocks.length > 0) {
            // Calculate absolute-gated average
            const absGatedSum = this.gatedBlocks.reduce((a, b) => a + b, 0);
            const absGatedAvg = absGatedSum / this.gatedBlocks.length;
            const absGatedLUFS = -0.691 + 10 * Math.log10(Math.max(absGatedAvg, 1e-10));

            // Relative gate threshold = absolute gated average - 10 LU
            const relativeThreshold = absGatedLUFS - 10;
            const relativeThresholdPower = Math.pow(10, (relativeThreshold + 0.691) / 10);

            // Filter blocks that pass relative gate and recalculate
            let relGatedSum = 0;
            let relGatedCount = 0;
            for (const block of this.gatedBlocks) {
                if (block >= relativeThresholdPower) {
                    relGatedSum += block;
                    relGatedCount++;
                }
            }

            if (relGatedCount > 0) {
                integratedLUFS = -0.691 + 10 * Math.log10(relGatedSum / relGatedCount);
            }
        }

        // 4. LRA Calculation (BS.1770-4: 10th to 95th percentile of gated S values)
        if (this.lraHistory.length > 180) { // Need at least 3s to start LRA
            const sorted = [...this.lraHistory].sort((a, b) => a - b);
            const p10 = sorted[Math.floor(sorted.length * 0.1)];
            const p95 = sorted[Math.floor(sorted.length * 0.95)];
            const l10 = -0.691 + 10 * Math.log10(Math.max(p10, 1e-10));
            const l95 = -0.691 + 10 * Math.log10(Math.max(p95, 1e-10));
            this.stats.lra = l95 - l10;
        }

        // 5. Update Visuals
        const perM = this.mapToPercent(momentaryLUFS);
        const perS = this.mapToPercent(shortTermLUFS);
        const perI = this.mapToPercent(integratedLUFS);

        // Smoothing for bars
        this.smoothS += (perS - this.smoothS) * 0.3;
        this.smoothI += (perI - this.smoothI) * 0.05;

        // Update DOM Bars
        if (this.meters.barS) this.meters.barS.style.height = `${this.smoothS}%`;
        if (this.meters.barM) this.meters.barM.style.bottom = `${perM}%`;
        if (this.meters.barI) this.meters.barI.style.bottom = `${this.smoothI}%`;

        // 6. Level Meters (Peak-based, L/R channels, instant response)
        const peakDbL = 20 * Math.log10(Math.max(peakL, 1e-5));
        const peakDbR = 20 * Math.log10(Math.max(peakR, 1e-5));

        // Map dB to percent: -48dB = 0%, 0dB = 100%
        const mapLevel = (db) => Math.max(0, Math.min(100, ((db + 48) / 48) * 100));

        const lvlL = mapLevel(peakDbL);
        const lvlR = mapLevel(peakDbR);

        // Update Level DOM bars (no smoothing - instant like spectrum)
        if (this.meters.levelBarL) this.meters.levelBarL.style.height = `${lvlL}%`;
        if (this.meters.levelBarR) this.meters.levelBarR.style.height = `${lvlR}%`;

        // Peak hold with decay
        if (!this.levelPeakHoldL) { this.levelPeakHoldL = 0; this.levelPeakHoldR = 0; this.levelPeakDecayL = 0; this.levelPeakDecayR = 0; }

        if (lvlL >= this.levelPeakHoldL) { this.levelPeakHoldL = lvlL; this.levelPeakDecayL = 20; }
        else if (this.levelPeakDecayL > 0) { this.levelPeakDecayL--; }
        else { this.levelPeakHoldL = Math.max(0, this.levelPeakHoldL - 2); }

        if (lvlR >= this.levelPeakHoldR) { this.levelPeakHoldR = lvlR; this.levelPeakDecayR = 20; }
        else if (this.levelPeakDecayR > 0) { this.levelPeakDecayR--; }
        else { this.levelPeakHoldR = Math.max(0, this.levelPeakHoldR - 2); }

        if (this.meters.levelPeakL) this.meters.levelPeakL.style.bottom = `${this.levelPeakHoldL}%`;
        if (this.meters.levelPeakR) this.meters.levelPeakR.style.bottom = `${this.levelPeakHoldR}%`;

        // Update Readouts
        const setVal = (el, val, precision = 1) => {
            if (el) el.innerText = isFinite(val) ? val.toFixed(precision) : '---';
        };

        setVal(this.meters.valS, shortTermLUFS);
        setVal(this.meters.valI, integratedLUFS);
        setVal(this.meters.valLRA, this.stats.lra);
        setVal(this.meters.valMMax, this.stats.mMax);
        setVal(this.meters.valPMax, this.stats.pMax);

        // PLR = Peak Max - Integrated
        const plr = this.stats.pMax - integratedLUFS;
        setVal(this.meters.valPLR, Math.abs(plr));

        // Color coding for Peak
        if (this.meters.valPMax) {
            if (this.stats.pMax > 0) this.meters.valPMax.classList.add('danger');
            else this.meters.valPMax.classList.remove('danger');
        }
    }
}

/**
 * ITU-R BS.1770-4 K-Weighting Filter
 * Implements the two-stage weighting filter with sample-rate-aware coefficients.
 * Stage 1: Pre-filter (High Shelf) - models head/ear resonance
 * Stage 2: RLB (Revised Low-frequency B-weighting) - high-pass filter
 * 
 * Coefficients are calculated using bilinear transform from analog prototypes.
 */
class KWeightFilter {
    constructor() {
        this.z1 = 0;
        this.z2 = 0;
        this.coeffs = null;
        this.lastSr = 0;
    }

    reset() {
        this.z1 = 0;
        this.z2 = 0;
    }

    /**
     * Calculate filter coefficients for a given sample rate.
     * Based on ITU-R BS.1770-4 Annex 2.
     */
    calculateCoefficients(sr, stage) {
        // Pre-calculated analog prototype frequencies
        if (stage === 1) {
            // Pre-filter (High Shelf)
            // Analog prototype: fc = 1681.97 Hz, Q = 0.7071, gain = +4 dB
            const fc = 1681.974450955533;
            const G = 3.999843853973347; // dB
            const Q = 0.7071752369554196;

            const K = Math.tan(Math.PI * fc / sr);
            const Vh = Math.pow(10, G / 20);
            const Vb = Math.pow(Vh, 0.4996667741545416);

            const a0 = 1 + K / Q + K * K;
            const b0 = (Vh + Vb * K / Q + K * K) / a0;
            const b1 = 2 * (K * K - Vh) / a0;
            const b2 = (Vh - Vb * K / Q + K * K) / a0;
            const a1 = 2 * (K * K - 1) / a0;
            const a2 = (1 - K / Q + K * K) / a0;

            return { b0, b1, b2, a1, a2 };
        } else {
            // RLB (High-Pass)
            // Analog prototype: fc = 38.13547087602444 Hz
            const fc = 38.13547087602444;

            const K = Math.tan(Math.PI * fc / sr);
            const a0 = 1 + Math.SQRT2 * K + K * K;
            const b0 = 1 / a0;
            const b1 = -2 / a0;
            const b2 = 1 / a0;
            const a1 = 2 * (K * K - 1) / a0;
            const a2 = (1 - Math.SQRT2 * K + K * K) / a0;

            return { b0, b1, b2, a1, a2 };
        }
    }

    process(input, sr, stage) {
        // Recalculate coefficients if sample rate changed
        if (sr !== this.lastSr) {
            this.coeffs = this.calculateCoefficients(sr, stage);
            this.lastSr = sr;
            this.z1 = 0;
            this.z2 = 0;
        }

        const { b0, b1, b2, a1, a2 } = this.coeffs;

        // Direct Form II Transposed Biquad
        const output = b0 * input + this.z1;
        this.z1 = b1 * input - a1 * output + this.z2;
        this.z2 = b2 * input - a2 * output;

        return output;
    }
}
