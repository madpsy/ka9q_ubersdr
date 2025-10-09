// Simple FFT implementation for noise reduction
// Based on Cooley-Tukey FFT algorithm

class FFT {
    constructor(size) {
        this.size = size;
        this.halfSize = size / 2;
        
        // Pre-compute twiddle factors for efficiency
        this.cosTable = new Float32Array(this.halfSize);
        this.sinTable = new Float32Array(this.halfSize);
        
        for (let i = 0; i < this.halfSize; i++) {
            const angle = -2 * Math.PI * i / size;
            this.cosTable[i] = Math.cos(angle);
            this.sinTable[i] = Math.sin(angle);
        }
        
        // Bit reversal lookup table
        this.reverseTable = new Uint32Array(size);
        this.buildReverseTable();
    }
    
    buildReverseTable() {
        const bits = Math.log2(this.size);
        for (let i = 0; i < this.size; i++) {
            this.reverseTable[i] = this.reverseBits(i, bits);
        }
    }
    
    reverseBits(x, bits) {
        let y = 0;
        for (let i = 0; i < bits; i++) {
            y = (y << 1) | (x & 1);
            x >>= 1;
        }
        return y;
    }
    
    // Forward FFT: time domain -> frequency domain
    // Input: real (Float32Array), imag (Float32Array)
    // Output: modifies real and imag in-place
    forward(real, imag) {
        // Bit-reversal permutation
        for (let i = 0; i < this.size; i++) {
            const j = this.reverseTable[i];
            if (j > i) {
                // Swap real
                let temp = real[i];
                real[i] = real[j];
                real[j] = temp;
                
                // Swap imag
                temp = imag[i];
                imag[i] = imag[j];
                imag[j] = temp;
            }
        }
        
        // Cooley-Tukey decimation-in-time radix-2 FFT
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
    
    // Inverse FFT: frequency domain -> time domain
    // Input: real (Float32Array), imag (Float32Array)
    // Output: modifies real and imag in-place
    inverse(real, imag) {
        // Conjugate
        for (let i = 0; i < this.size; i++) {
            imag[i] = -imag[i];
        }
        
        // Forward FFT
        this.forward(real, imag);
        
        // Conjugate and scale
        const scale = 1.0 / this.size;
        for (let i = 0; i < this.size; i++) {
            real[i] *= scale;
            imag[i] *= -scale;
        }
    }
    
    // Create Hann window
    static createHannWindow(size) {
        const window = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
        }
        return window;
    }
    
    // Create Hamming window
    static createHammingWindow(size) {
        const window = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            window[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (size - 1));
        }
        return window;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FFT;
}