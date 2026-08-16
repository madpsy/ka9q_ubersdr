// The classic client NR: v1's NR2 spectral subtraction, kept as a type.
//
// A copy of static/nr2.js, not a reinterpretation — the test suite holds this
// file to sample-for-sample parity with v1's own file, so the two frontends
// sound identical when this type is chosen. Anything here that looks arbitrary
// is arbitrary in v1 too; change both or neither.
//
// It is no longer the default. lib/nr.js (MMSE-LSA over tracked minima) is
// better on voice by a distance — this stays because its 2048-point window
// (170 ms at 12 kHz) genuinely suits narrowband modes, because "learns then
// subtracts" is a behaviour some operators know and want, and because an A/B
// against the new engine should be one click, not an argument.
//
// Differences from v1's file: the class takes no AudioContext (v1 stored one
// and never used it), the FFT comes from lib/nr.js, and the console chatter is
// gone. None of that changes a sample.

import { FFT } from './nr.js';

// v1's Hann (fft.js createHannWindow): symmetric, size-1 denominator. The LSA
// engine uses a periodic one; parity means keeping v1's exactly.
function hannWindow(size) {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
    }
    return window;
}

export class NR2Processor {
    constructor(fftSize = 2048, overlapFactor = 4) {
        this.fftSize = fftSize;
        this.hopSize = fftSize / overlapFactor;
        this.overlapFactor = overlapFactor;

        this.fft = new FFT(fftSize);
        this.window = hannWindow(fftSize);

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
