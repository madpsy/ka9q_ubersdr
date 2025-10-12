// Carrier Detection Logic for SDR
// Handles AM carrier peak detection and USB/LSB spectral edge detection

class CarrierDetector {
    constructor() {
        // Configuration for edge detection
        this.thresholdAboveNoise = 10; // dB above noise floor
        this.gradientLookahead = 5; // bins to look ahead/behind for gradient
        this.searchRange = 4000; // Hz to search outside bandwidth
    }

    // Calculate noise floor from spectrum data
    calculateNoiseFloor(spectrumData) {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < spectrumData.length; i++) {
            if (isFinite(spectrumData[i])) {
                sum += spectrumData[i];
                count++;
            }
        }
        return count > 0 ? sum / count : -120;
    }

    // Find AM/SAM carrier (peak within bandwidth)
    findAMCarrier(spectrumData, currentTunedFreq, bandwidthLow, bandwidthHigh, startFreq, totalBandwidth) {
        // Calculate bandwidth edges in absolute frequencies
        const lowFreq = currentTunedFreq + bandwidthLow;
        const highFreq = currentTunedFreq + bandwidthHigh;

        // Convert to bin indices
        const lowBinFloat = ((lowFreq - startFreq) / totalBandwidth) * spectrumData.length;
        const highBinFloat = ((highFreq - startFreq) / totalBandwidth) * spectrumData.length;
        const lowBin = Math.max(0, Math.floor(lowBinFloat));
        const highBin = Math.min(spectrumData.length - 1, Math.ceil(highBinFloat));

        // Find strongest signal (peak dB) within bandwidth
        let peakDb = -Infinity;
        let peakBin = -1;
        for (let i = lowBin; i <= highBin; i++) {
            if (i >= 0 && i < spectrumData.length && spectrumData[i] > peakDb) {
                peakDb = spectrumData[i];
                peakBin = i;
            }
        }

        if (peakBin === -1 || !isFinite(peakDb)) {
            return null;
        }

        // Calculate carrier frequency
        const carrierFreq = startFreq + (peakBin / spectrumData.length) * totalBandwidth;

        return {
            frequency: carrierFreq,
            bin: peakBin,
            strength: peakDb
        };
    }

    // Find USB spectral edge (lowest frequency where energy starts)
    findUSBEdge(spectrumData, currentTunedFreq, bandwidthLow, startFreq, totalBandwidth) {
        const noiseFloor = this.calculateNoiseFloor(spectrumData);
        const threshold = noiseFloor + this.thresholdAboveNoise;

        // USB: Search below current bandwidth for lowest frequency edge
        // Energy is above the carrier, so we search below to find where it starts
        const searchStartFreq = currentTunedFreq + bandwidthLow - this.searchRange;
        const searchEndFreq = currentTunedFreq + bandwidthLow;

        const searchStartBin = Math.max(0, Math.floor(((searchStartFreq - startFreq) / totalBandwidth) * spectrumData.length));
        const searchEndBin = Math.min(spectrumData.length - 1, Math.ceil(((searchEndFreq - startFreq) / totalBandwidth) * spectrumData.length));

        // Scan from low to high frequency, looking for threshold crossing with gradient confirmation
        let bestEdgeBin = -1;
        let maxGradient = 0;

        for (let i = searchStartBin; i < searchEndBin - this.gradientLookahead; i++) {
            const currentDb = spectrumData[i];
            const nextDb = spectrumData[i + this.gradientLookahead];

            // Check if we're crossing threshold (below to above)
            if (currentDb < threshold && nextDb > threshold) {
                // Calculate gradient (rate of change)
                const gradient = (nextDb - currentDb) / this.gradientLookahead;

                // Keep track of steepest gradient
                if (gradient > maxGradient) {
                    maxGradient = gradient;
                    bestEdgeBin = i + Math.floor(this.gradientLookahead / 2); // Use midpoint of transition
                }
            }
        }

        if (bestEdgeBin === -1) {
            return null;
        }

        // Calculate edge frequency and apply low bandwidth offset
        const edgeFreq = startFreq + (bestEdgeBin / spectrumData.length) * totalBandwidth;
        // For USB, the carrier should be positioned at edge - low_bandwidth
        const carrierFreq = edgeFreq - Math.abs(bandwidthLow);

        return {
            frequency: carrierFreq,
            edgeFrequency: edgeFreq,
            bin: bestEdgeBin,
            gradient: maxGradient
        };
    }

    // Find LSB spectral edge (highest frequency where energy ends)
    findLSBEdge(spectrumData, currentTunedFreq, bandwidthLow, bandwidthHigh, startFreq, totalBandwidth) {
        const noiseFloor = this.calculateNoiseFloor(spectrumData);
        const threshold = noiseFloor + this.thresholdAboveNoise;

        // LSB: Search above current bandwidth for highest frequency edge
        // Energy is below the carrier, so we search above to find where it ends
        const searchStartFreq = currentTunedFreq + bandwidthHigh;
        const searchEndFreq = currentTunedFreq + bandwidthHigh + this.searchRange;

        const searchStartBin = Math.max(0, Math.floor(((searchStartFreq - startFreq) / totalBandwidth) * spectrumData.length));
        const searchEndBin = Math.min(spectrumData.length - 1, Math.ceil(((searchEndFreq - startFreq) / totalBandwidth) * spectrumData.length));

        // Scan from high to low frequency, looking for threshold crossing with gradient confirmation
        let bestEdgeBin = -1;
        let maxGradient = 0;

        for (let i = searchEndBin; i > searchStartBin + this.gradientLookahead; i--) {
            const currentDb = spectrumData[i];
            const prevDb = spectrumData[i - this.gradientLookahead];

            // Check if we're crossing threshold (below to above, going backwards)
            if (currentDb < threshold && prevDb > threshold) {
                // Calculate gradient (rate of change)
                const gradient = (prevDb - currentDb) / this.gradientLookahead;

                // Keep track of steepest gradient
                if (gradient > maxGradient) {
                    maxGradient = gradient;
                    bestEdgeBin = i - Math.floor(this.gradientLookahead / 2); // Use midpoint of transition
                }
            }
        }

        if (bestEdgeBin === -1) {
            return null;
        }

        // Calculate edge frequency and apply high bandwidth offset
        const edgeFreq = startFreq + (bestEdgeBin / spectrumData.length) * totalBandwidth;
        // For LSB, the carrier should be positioned at edge - high_bandwidth
        // This positions the carrier so the high edge of the passband aligns with the signal edge
        const carrierFreq = edgeFreq - bandwidthHigh;

        return {
            frequency: carrierFreq,
            edgeFrequency: edgeFreq,
            bin: bestEdgeBin,
            gradient: maxGradient
        };
    }

    // Main detection method - routes to appropriate detector based on mode
    detectCarrier(mode, spectrumData, currentTunedFreq, bandwidthLow, bandwidthHigh, startFreq, totalBandwidth) {
        const modeLower = mode.toLowerCase();

        if (modeLower === 'am' || modeLower === 'sam') {
            return this.findAMCarrier(spectrumData, currentTunedFreq, bandwidthLow, bandwidthHigh, startFreq, totalBandwidth);
        } else if (modeLower === 'usb') {
            return this.findUSBEdge(spectrumData, currentTunedFreq, bandwidthLow, startFreq, totalBandwidth);
        } else if (modeLower === 'lsb') {
            return this.findLSBEdge(spectrumData, currentTunedFreq, bandwidthLow, bandwidthHigh, startFreq, totalBandwidth);
        }

        return null;
    }
}