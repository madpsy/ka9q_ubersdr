// One audio FFT, shared by everything that wants to look at the demodulated
// audio: the audio scope, and the filter panel's preview.
//
// The analyser node is always in the player's graph, but it only transforms
// when something reads it — so the rule is that nothing reads it unless a view
// is on screen. With two possible readers that has to be reference counted, or
// closing one panel would stop the other's display; and they must not each run
// their own animation frame over the same node.
//
// Subscribers get the raw arrays, not copies: they are read and drawn within
// the same frame, and copying 16k floats per subscriber per frame to protect
// against a hypothetical retainer would be worse than the problem.

const subs = new Set();

let running = null;      // { player, raf, bins, wave }

function loop() {
    if (!running) return;
    running.raf = requestAnimationFrame(loop);

    const { player } = running;
    const a = player.analyser;
    if (!a) return;

    if (!running.bins || running.bins.length !== a.frequencyBinCount) {
        running.bins = new Float32Array(a.frequencyBinCount);
    }
    if (!running.wave || running.wave.length !== a.fftSize) {
        running.wave = new Uint8Array(a.fftSize);
    }

    // Only transform what someone is actually looking at.
    let wantBins = false;
    let wantWave = false;
    for (const s of subs) {
        wantBins = wantBins || s.bins;
        wantWave = wantWave || s.wave;
    }
    if (wantBins) a.getFloatFrequencyData(running.bins);
    if (wantWave) a.getByteTimeDomainData(running.wave);

    const frame = {
        bins: running.bins,
        wave: running.wave,
        binCount: a.frequencyBinCount,
        fftSize: a.fftSize,
        sampleRate: player.sampleRate || 48000,
    };
    for (const s of subs) {
        try { s.cb(frame); } catch (e) { /* a broken view must not stop the others */ }
    }
}

// The node is sized for the largest request, so a coarse consumer never
// downgrades a fine one.
function applyFft(player) {
    let want = 0;
    for (const s of subs) if (s.fftSize > want) want = s.fftSize;
    if (want) player.acquireAnalyser(want);
    else player.releaseAnalyser();
}

/**
 * Read the audio spectrum until the returned function is called.
 *
 * opts: { fftSize, bins: true, wave: true } — declare what you need, so a panel
 * that only draws a waterfall does not pay for the time-domain read.
 */
export function subscribeAudioSpectrum(player, opts, cb) {
    const sub = {
        cb,
        fftSize: opts.fftSize || 2048,
        bins: opts.bins !== false,
        wave: !!opts.wave,
    };
    subs.add(sub);

    if (!running) {
        running = { player, raf: 0, bins: null, wave: null };
        running.raf = requestAnimationFrame(loop);
    }
    applyFft(player);

    return () => {
        subs.delete(sub);
        if (subs.size) {
            applyFft(player);
            return;
        }
        if (running) cancelAnimationFrame(running.raf);
        running = null;
        player.releaseAnalyser();
    };
}
