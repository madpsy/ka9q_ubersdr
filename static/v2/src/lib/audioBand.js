// Which part of the decoded audio actually carries the signal.
//
// The audio stream's Nyquist is not the useful bandwidth: SSB at a 12 kHz
// stream rate has 6 kHz of spectrum but only ~2.7 kHz of passband, and the
// demodulated audio for a mode whose passband is negative (LSB) or straddles
// zero (AM) does not map onto FFT bins the way the passband numbers suggest.
// v1 works this out in app.js `getFrequencyBinMapping`; this is the same logic,
// pulled out as a pure function so it can be tested.
//
// Returns the audio-frequency window to display, in Hz:
//
//   CW            passband is narrow and near zero, and radiod puts the tone at
//                 a 500 Hz offset, so the window is centred there
//   straddles 0   AM/SAM: 0 up to the wider half
//   both negative LSB: mirrored into positive frequencies, so |high|..|low|
//   both positive USB and friends: low..high
export const CW_OFFSET = 500;

export function isCwPassband(low, high) {
    return Math.abs(low) < 500 && Math.abs(high) < 500;
}

export function audioWindow(low, high) {
    if (isCwPassband(low, high)) {
        const half = Math.max(Math.abs(low), Math.abs(high));
        return { startFreq: Math.max(0, CW_OFFSET - half), endFreq: CW_OFFSET + half };
    }
    if (low < 0 && high > 0) {
        return { startFreq: 0, endFreq: Math.max(Math.abs(low), Math.abs(high)) };
    }
    if (low < 0 && high <= 0) {
        return { startFreq: Math.abs(high), endFreq: Math.abs(low) };
    }
    return { startFreq: Math.max(0, low), endFreq: high };
}

// The slice of an FFT that window covers. `binCount` is analyser.frequencyBinCount.
export function audioBins(low, high, sampleRate, binCount) {
    const nyquist = sampleRate / 2;
    const { startFreq, endFreq } = audioWindow(low, high);
    if (!(nyquist > 0) || !(binCount > 0)) return { start: 0, count: 0, startFreq, endFreq };

    // A passband wider than the stream carries is clamped rather than dropped:
    // the audio above Nyquist simply is not there.
    const lo = Math.max(0, Math.min(nyquist, startFreq));
    const hi = Math.max(lo, Math.min(nyquist, endFreq));
    const start = Math.floor((lo / nyquist) * binCount);
    const count = Math.max(1, Math.min(binCount - start, Math.round(((hi - lo) / nyquist) * binCount)));
    return { start, count, startFreq: lo, endFreq: hi };
}
