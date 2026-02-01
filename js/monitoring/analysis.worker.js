/* analysis.worker.js
   Worker for computing peaks, correlation and LUFS (BS.1770-like)
   Receives messages: { timeLBuffer, timeRBuffer, sampleRate, minimal?, reset? }
   Expects time arrays as Uint8Array (0-255) like AnalyserNode.getByteTimeDomainData
*/

'use strict';

// KWeightFilter copied/adapted from visualizers.js
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

    calculateCoefficients(sr, stage) {
        if (stage === 1) {
            const fc = 1681.974450955533;
            const G = 3.999843853973347;
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
        if (sr !== this.lastSr) {
            this.coeffs = this.calculateCoefficients(sr, stage);
            this.lastSr = sr;
            this.z1 = 0;
            this.z2 = 0;
        }
        const { b0, b1, b2, a1, a2 } = this.coeffs;
        const output = b0 * input + this.z1;
        this.z1 = b1 * input - a1 * output + this.z2;
        this.z2 = b2 * input - a2 * output;
        return output;
    }
}

// Worker persistent state
const filtersL = [new KWeightFilter(), new KWeightFilter()];
const filtersR = [new KWeightFilter(), new KWeightFilter()];
let shortTermBuffer = [];
let lraHistory = [];
let gatedBlocks = [];
let lastSampleRate = 48000;
let stats = { mMax: -100, sMax: -100, pMax: -100, lra: 0 };

function resetState() {
    shortTermBuffer = [];
    lraHistory = [];
    gatedBlocks = [];
    stats = { mMax: -100, sMax: -100, pMax: -100, lra: 0 };
    filtersL.forEach(f => f.reset());
    filtersR.forEach(f => f.reset());
}

function computeFromByteArrays(tL, tR, sr, minimal) {
    // tL and tR are Uint8Array views centered at 128
    const len = tL.length;
    let peakL = 0, peakR = 0, peakChunk = 0;
    let meanSquareSumL = 0, meanSquareSumR = 0;

    // handle sample rate change
    if (sr && sr !== lastSampleRate) {
        lastSampleRate = sr;
        filtersL.forEach(f => f.reset());
        filtersR.forEach(f => f.reset());
    }

    for (let i = 0; i < len; i++) {
        const lRaw = (tL[i] - 128) / 128;
        const rRaw = (tR ? (tR[i] - 128) / 128 : lRaw);

        const absL = Math.abs(lRaw);
        const absR = Math.abs(rRaw);
        if (absL > peakL) peakL = absL;
        if (absR > peakR) peakR = absR;
        if (absL > peakChunk) peakChunk = absL;
        if (absR > peakChunk) peakChunk = absR;

        if (!minimal) {
            let l = filtersL[1].process(filtersL[0].process(lRaw, sr, 1), sr, 2);
            let r = filtersR[1].process(filtersR[0].process(rRaw, sr, 1), sr, 2);
            meanSquareSumL += l * l;
            meanSquareSumR += r * r;
        }
    }

    const peakDbL = 20 * Math.log10(Math.max(peakL, 1e-5));
    const peakDbR = 20 * Math.log10(Math.max(peakR, 1e-5));

    const result = {
        peaks: { peakL, peakR, peakDbL, peakDbR },
        correlation: 1.0,
        lufs: null,
        mMax: stats.mMax,
        pMax: stats.pMax
    };

    // correlation
    let sumLR = 0, sumL2 = 0, sumR2 = 0;
    for (let i = 0; i < len; i++) {
        const l = (tL[i] - 128) / 128;
        const r = (tR ? (tR[i] - 128) / 128 : l);
        sumLR += l * r;
        sumL2 += l * l;
        sumR2 += r * r;
    }
    const denom = Math.sqrt(sumL2 * sumR2);
    const instantCorr = denom > 1e-10 ? (sumLR / denom) : 1.0;
    result.correlation = instantCorr;

    if (!minimal) {
        const meanSquareCombined = (meanSquareSumL + meanSquareSumR) / (len * 2);
        const momentaryLUFS = -0.691 + 10 * Math.log10(Math.max(meanSquareCombined, 1e-10));
        if (momentaryLUFS > stats.mMax) stats.mMax = momentaryLUFS;
        const shortTermLimit = 180; // 3s if called at 60fps
        shortTermBuffer.push(meanSquareCombined);
        if (shortTermBuffer.length > shortTermLimit) shortTermBuffer.shift();
        const shortTermMeanSquare = shortTermBuffer.reduce((a, b) => a + b, 0) / shortTermBuffer.length;
        const shortTermLUFS = -0.691 + 10 * Math.log10(Math.max(shortTermMeanSquare, 1e-10));

        // gating
        if (momentaryLUFS > -70) {
            gatedBlocks.push(meanSquareCombined);
            lraHistory.push(shortTermMeanSquare);
        }

        let integratedLUFS = -Infinity;
        if (gatedBlocks.length > 0) {
            const absGatedSum = gatedBlocks.reduce((a, b) => a + b, 0);
            const absGatedAvg = absGatedSum / gatedBlocks.length;
            const absGatedLUFS = -0.691 + 10 * Math.log10(Math.max(absGatedAvg, 1e-10));
            const relativeThreshold = absGatedLUFS - 10;
            const relativeThresholdPower = Math.pow(10, (relativeThreshold + 0.691) / 10);
            let relGatedSum = 0, relGatedCount = 0;
            for (const block of gatedBlocks) {
                if (block >= relativeThresholdPower) { relGatedSum += block; relGatedCount++; }
            }
            if (relGatedCount > 0) integratedLUFS = -0.691 + 10 * Math.log10(relGatedSum / relGatedCount);
        }

        // LRA
        if (lraHistory.length > shortTermLimit) {
            const sorted = [...lraHistory].sort((a, b) => a - b);
            const p10 = sorted[Math.floor(sorted.length * 0.1)];
            const p95 = sorted[Math.floor(sorted.length * 0.95)];
            const l10 = -0.691 + 10 * Math.log10(Math.max(p10, 1e-10));
            const l95 = -0.691 + 10 * Math.log10(Math.max(p95, 1e-10));
            stats.lra = l95 - l10;
        }

        result.lufs = {
            momentary: momentaryLUFS,
            shortTerm: shortTermLUFS,
            integrated: isFinite(integratedLUFS) ? integratedLUFS : null,
            lra: stats.lra
        };
    }

    // pMax tracking
    const peakChunkDb = 20 * Math.log10(Math.max(peakChunk, 1e-5));
    if (peakChunkDb > stats.pMax) stats.pMax = peakChunkDb;
    result.mMax = stats.mMax;
    result.pMax = stats.pMax;

    return result;
}

onmessage = function (e) {
    const msg = e.data;
    if (msg.reset) {
        resetState();
        return;
    }
    if (msg.config) {
        // future config handling
        return;
    }

    // Expect buffers transferred as ArrayBuffers; reconstruct views
    try {
        const timeL = msg.timeLBuffer ? new Uint8Array(msg.timeLBuffer) : null;
        const timeR = msg.timeRBuffer ? new Uint8Array(msg.timeRBuffer) : null;
        const minimal = !!msg.minimal;
        const sr = msg.sampleRate || lastSampleRate;
        if (!timeL) {
            // nothing to do
            postMessage({ error: 'no timeL' });
            return;
        }

        const out = computeFromByteArrays(timeL, timeR, sr, minimal);
        postMessage(out);
    } catch (err) {
        postMessage({ error: err.message });
    }
};
