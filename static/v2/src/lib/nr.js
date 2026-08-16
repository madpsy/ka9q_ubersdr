// Client-side noise reduction — v1's NR2 spectral subtraction, renamed.
//
// A copy of static/nr2.js with static/fft.js folded in, not a reinterpretation:
// the algorithm (overlap-add spectral subtraction in the Hermes-Lite 2 style,
// with adaptive noise tracking) is the one v1 ships, and the test suite holds
// this file to sample-for-sample parity with it. Anything here that looks
// arbitrary is arbitrary in v1 too — change both or neither. What changed:
// the class is `NR` (the panel calls it that; "NR2" was a lineage label, not a
// name anyone chose — `NRProcessor` in code, because a bare `NR` collides
// with the letters appearing in interface copy), the unused AudioContext
// constructor argument is gone,
// and the console chatter is gone.
//
// How it works, in one paragraph: audio is windowed into overlapping FFT
// frames; for the first half second the magnitude spectrum is averaged into a
// noise profile; after that each bin has `alpha ×` its noise estimate
// subtracted (over-subtraction, the strength control) with a floor of `beta ×`
// the raw magnitude (the spectral floor control, which is what keeps the
// residue from turning into musical noise); and while a bin sits near its
// noise estimate the profile keeps adapting (the adaptation rate control), so
// band noise that drifts is tracked without re-learning. Retuning invalidates
// the profile — the caller resets learning then (see resetNoiseLearning in
// radio/audio-player.js).

// Cooley-Tukey radix-2 FFT — static/fft.js verbatim, minus the windows nothing
// here uses.
export class FFT {
    constructor(size) {
        this.size = size;
        this.halfSize = size / 2;

        this.cosTable = new Float32Array(this.halfSize);
        this.sinTable = new Float32Array(this.halfSize);
        for (let i = 0; i < this.halfSize; i++) {
            const angle = -2 * Math.PI * i / size;
            this.cosTable[i] = Math.cos(angle);
            this.sinTable[i] = Math.sin(angle);
        }

        this.reverseTable = new Uint32Array(size);
        const bits = Math.log2(size);
        for (let i = 0; i < size; i++) {
            let x = i;
            let y = 0;
            for (let b = 0; b < bits; b++) {
                y = (y << 1) | (x & 1);
                x >>= 1;
            }
            this.reverseTable[i] = y;
        }
    }

    forward(real, imag) {
        for (let i = 0; i < this.size; i++) {
            const j = this.reverseTable[i];
            if (j > i) {
                let temp = real[i];
                real[i] = real[j];
                real[j] = temp;
                temp = imag[i];
                imag[i] = imag[j];
                imag[j] = temp;
            }
        }

        for (let size = 2; size <= this.size; size *= 2) {
            const halfSize = size / 2;
            const tableStep = this.size / size;
            for (let i = 0; i < this.size; i += size) {
                for (let j = i, k = 0; j < i + halfSize; j++, k += tableStep) {
                    const l = j + halfSize;
                    const tpre = real[l] * this.cosTable[k] - imag[l] * this.sinTable[k];
                    const tpim = real[l] * this.sinTable[k] + imag[l] * this.cosTable[k];
                    real[l] = real[j] - tpre;
                    imag[l] = imag[j] - tpim;
                    real[j] += tpre;
                    imag[j] += tpim;
                }
            }
        }
    }

    inverse(real, imag) {
        for (let i = 0; i < this.size; i++) imag[i] = -imag[i];
        this.forward(real, imag);
        const scale = 1.0 / this.size;
        for (let i = 0; i < this.size; i++) {
            real[i] *= scale;
            imag[i] *= -scale;
        }
    }

    static createHannWindow(size) {
        const window = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
        }
        return window;
    }
}

// The panel's slider ranges and defaults, exactly v1's (index.html, the
// noise-reduction-* inputs). The makeup default is negative because spectral
// subtraction with these defaults leaves the speech peaks where they were and
// the average lower — a plain 0 dB sounded louder with NR on, which read as
// the filter "adding" signal.
export const NR_DEFAULTS = {
    enabled: false,
    strength: 40,       // % → alpha 1.0..4.0
    floor: 10,          // % → beta 0.001..0.1 (slider range 0..10)
    adaptRate: 1.0,     // %/frame → 0.001..0.05 (slider range 0.1..5)
    makeupDb: -3,       // plain output gain after the subtraction
};

export class NRProcessor {
    constructor(fftSize = 2048, overlapFactor = 4) {
        this.fftSize = fftSize;
        this.hopSize = fftSize / overlapFactor;
        this.overlapFactor = overlapFactor;

        this.fft = new FFT(fftSize);
        this.window = FFT.createHannWindow(fftSize);

        this.inputBuffer = new Float32Array(fftSize);
        this.outputBuffer = new Float32Array(fftSize);

        this.real = new Float32Array(fftSize);
        this.imag = new Float32Array(fftSize);

        // Noise profile (magnitude spectrum)
        this.noiseProfile = new Float32Array(fftSize / 2 + 1);
        this.noiseProfileCount = 0;
        this.learningFrames = 30; // ~0.5 seconds
        this.isLearning = true;

        // Adaptive noise tracking
        this.adaptiveNoiseTracking = true;
        this.noiseAdaptRate = 0.01;
        this.signalThreshold = 2.0;

        this.alpha = 2.0;  // over-subtraction factor
        this.beta = 0.01;  // spectral floor

        this.enabled = false;
    }

    // The panel's percentages → the algorithm's coefficients, v1's mapping.
    setParameters(strength, floor, adaptRate) {
        this.alpha = 1.0 + (strength / 100) * 3.0;
        this.beta = 0.001 + (floor / 100) * 0.099;
        if (adaptRate !== undefined) {
            this.noiseAdaptRate = adaptRate / 100;
        }
    }

    resetLearning() {
        this.noiseProfile.fill(0);
        this.noiseProfileCount = 0;
        this.isLearning = true;
    }

    process(input, output) {
        const inputLength = input.length;
        let inputPos = 0;
        let outputPos = 0;

        while (inputPos < inputLength) {
            const samplesToBuffer = Math.min(this.hopSize, inputLength - inputPos);

            for (let i = 0; i < this.fftSize - samplesToBuffer; i++) {
                this.inputBuffer[i] = this.inputBuffer[i + samplesToBuffer];
            }
            for (let i = 0; i < samplesToBuffer; i++) {
                this.inputBuffer[this.fftSize - samplesToBuffer + i] = input[inputPos + i];
            }

            this.processFrame();

            const samplesToOutput = Math.min(this.hopSize, output.length - outputPos);
            for (let i = 0; i < samplesToOutput; i++) {
                output[outputPos + i] = this.outputBuffer[i];
            }

            for (let i = 0; i < this.fftSize - this.hopSize; i++) {
                this.outputBuffer[i] = this.outputBuffer[i + this.hopSize];
            }
            for (let i = this.fftSize - this.hopSize; i < this.fftSize; i++) {
                this.outputBuffer[i] = 0;
            }

            inputPos += samplesToBuffer;
            outputPos += samplesToOutput;
        }
    }

    processFrame() {
        for (let i = 0; i < this.fftSize; i++) {
            this.real[i] = this.inputBuffer[i] * this.window[i];
            this.imag[i] = 0;
        }

        this.fft.forward(this.real, this.imag);

        const magnitude = new Float32Array(this.fftSize / 2 + 1);
        for (let i = 0; i <= this.fftSize / 2; i++) {
            magnitude[i] = Math.sqrt(this.real[i] * this.real[i] + this.imag[i] * this.imag[i]);
        }

        // Learn noise profile
        if (this.isLearning && this.noiseProfileCount < this.learningFrames) {
            for (let i = 0; i <= this.fftSize / 2; i++) {
                this.noiseProfile[i] += magnitude[i];
            }
            this.noiseProfileCount++;

            if (this.noiseProfileCount >= this.learningFrames) {
                for (let i = 0; i <= this.fftSize / 2; i++) {
                    this.noiseProfile[i] /= this.learningFrames;
                }
                this.isLearning = false;
            }

            // During learning, pass through with window compensation
            for (let i = 0; i < this.fftSize; i++) {
                this.outputBuffer[i] += this.inputBuffer[i] * this.window[i];
            }
            return;
        }

        if (this.enabled && !this.isLearning) {
            for (let i = 0; i <= this.fftSize / 2; i++) {
                // Update the noise estimate only while the bin sits near it —
                // a strong signal in the bin must not be learned as noise.
                if (this.adaptiveNoiseTracking) {
                    if (magnitude[i] < this.signalThreshold * this.noiseProfile[i]) {
                        this.noiseProfile[i] = (1 - this.noiseAdaptRate) * this.noiseProfile[i]
                                               + this.noiseAdaptRate * magnitude[i];
                    }
                }

                // Spectral subtraction with over-subtraction
                let cleanMag = magnitude[i] - this.alpha * this.noiseProfile[i];

                // Spectral floor, against musical noise
                cleanMag = Math.max(cleanMag, this.beta * magnitude[i]);

                if (magnitude[i] > 0) {
                    const scale = cleanMag / magnitude[i];
                    this.real[i] *= scale;
                    this.imag[i] *= scale;
                } else {
                    this.real[i] = 0;
                    this.imag[i] = 0;
                }
            }

            // Mirror for negative frequencies (real FFT symmetry)
            for (let i = this.fftSize / 2 + 1; i < this.fftSize; i++) {
                const mirrorIdx = this.fftSize - i;
                this.real[i] = this.real[mirrorIdx];
                this.imag[i] = -this.imag[mirrorIdx];
            }
        }

        this.fft.inverse(this.real, this.imag);

        for (let i = 0; i < this.fftSize; i++) {
            this.outputBuffer[i] += this.real[i] * this.window[i];
        }
    }
}
