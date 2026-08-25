// Olivia: the modes worth naming, and where to point the receiver.
//
// The decoder is in ../../../../audio_extensions/olivia; what is here is the
// part that is about the mode as it is actually worked.

// Olivia is defined for any power-of-two tone count from 2 to 256 against any
// power-of-two multiple of 125 Hz from 125 to 2000. That is far more
// combinations than anybody uses, so this is fldigi's quick-change list — the
// same eighteen in the same order — with the three standard ones marked. Those
// three are what a bare "Olivia" on a spot means, and matching the rest of the
// list matters because it is what the operator at the other end picked from.
//
// Some of them want a higher centre than the 1000 Hz default, and it is not
// simply the wide ones. What matters is how coarse the FFT bins are: when the
// tone block starts within eight bins of DC the frequency search has nowhere to
// go and clamps to whatever room is left. That is every 2000 Hz mode and also
// 4/1000, whose 64-point transform puts 125 Hz in a bin and the block at
// carrier 5. Raising the centre to about 1500 Hz recovers the wide ones.
//
// None of this is refused — the reference does not refuse it either. It comes
// back in the config frame as `narrowed` and the panel says so.
export const MODES = [
    { tones: 4, bandwidth: 125 },
    { tones: 4, bandwidth: 250 },
    { tones: 4, bandwidth: 500 },
    { tones: 4, bandwidth: 1000 },
    { tones: 4, bandwidth: 2000 },
    { tones: 8, bandwidth: 125 },
    { tones: 8, bandwidth: 250, standard: true },
    { tones: 8, bandwidth: 500 },
    { tones: 8, bandwidth: 1000 },
    { tones: 8, bandwidth: 2000 },
    { tones: 16, bandwidth: 500, standard: true },
    { tones: 16, bandwidth: 1000 },
    { tones: 16, bandwidth: 2000 },
    { tones: 32, bandwidth: 1000, standard: true },
    { tones: 32, bandwidth: 2000 },
    { tones: 64, bandwidth: 500 },
    { tones: 64, bandwidth: 1000 },
    { tones: 64, bandwidth: 2000 },
];

export const MODE_ID = (tones, bandwidth) => `${tones}/${bandwidth}`;

// The three references disagree about what to open on — fldigi ships 8/500,
// PhantomSDR-Plus 8/250, sdr-j 32/1000 — so there is no default to inherit.
//
// 8/250 wins on consistency with the rest of this panel: the frequency menu's
// first group is the published 8/250 calling frequencies, and picking one of
// those and then having to change the mode by hand would be a panel arguing
// with itself. It agrees with PhantomSDR, and fldigi's 8/500 is one step down
// the list.
export const DEFAULT_MODE = { tones: 8, bandwidth: 250 };

// How long a block takes and how fast it prints, so the panel can say why
// nothing has appeared yet. Both come back from the server in its config frame
// as well — these are only for labelling the menu before anything is attached.
//
// Every one of these modes has SymbolLen a power of two by construction, which
// is the whole reason the tone spacing and the symbol rate are the same number:
// symbols per second is 8000/(SymbolLen/2), and a block is 64 symbols carrying
// log2(tones) characters.
export function modeRates({ tones, bandwidth }) {
    const bps = Math.round(Math.log2(tones));
    const bwExp = Math.round(Math.log2(bandwidth / 125));
    const symbolLen = 1 << (bps + 7 - bwExp);
    const baud = 8000 / (symbolLen / 2);
    const blockPeriod = (64 * (symbolLen / 2)) / 8000;
    return { baud, blockPeriod, charsPerSec: bps / blockPeriod };
}

export function modeLabel(m) {
    const { baud, charsPerSec } = modeRates(m);
    const std = m.standard ? ' ★' : '';
    return `${m.tones}/${m.bandwidth} — ${baud.toFixed(2)} Bd, ${charsPerSec.toFixed(1)} char/s${std}`;
}

export const LIMITS = {
    center_frequency: { min: 300, max: 2700, step: 10 },
    // fldigi's "Tune margin", in FFT bins either side of the tone block. How
    // far off frequency the decoder will look. Worth widening when you cannot
    // tune precisely, and worth narrowing on a crowded band — a wider search is
    // more chances for noise to win the sync race.
    sync_margin: { min: 1, max: 32, step: 1 },
    // fldigi's "Integration period", in FEC blocks. How many blocks the
    // synchroniser averages before it trusts a decision. Deeper copies further
    // into the noise but takes proportionally longer to acquire and to print,
    // because a block only leaves the pipe once this many have gone in.
    sync_integ_len: { min: 1, max: 8, step: 1 },
};

// The reference's defaults for both, which is what fldigi ships.
export const DEFAULT_SYNC_MARGIN = 8;
export const DEFAULT_SYNC_INTEG = 4;

// Squelch bounds, matching the server's. 3.0 is the floor the reference
// imposes; below it the FEC signal-to-noise no longer means anything and pure
// noise starts printing.
export const SQUELCH = { min: 3.0, max: 15.0, step: 0.1, default: 4.0 };

// Where Olivia is worked.
//
// These are dial frequencies in USB, which is the convention the mode is spotted
// and published in — unlike the FSK panel's list, which holds the RF centre of
// the signal itself. So the menu tunes the dial straight here and leaves the
// centre control to say where in the audio the decoder listens; it does not
// subtract the centre the way FSK does.
export const OLIVIA_FREQUENCIES = [
    {
        group: 'Calling frequencies (8/250)',
        options: [
            { hz: 1826900, label: '1.8269 MHz (160m)' },
            { hz: 3577200, label: '3.5772 MHz (80m)' },
            { hz: 7026900, label: '7.0269 MHz (40m)' },
            { hz: 10142600, label: '10.1426 MHz (30m)' },
            { hz: 14072900, label: '14.0729 MHz (20m)' },
            { hz: 18102900, label: '18.1029 MHz (17m)' },
            { hz: 21072900, label: '21.0729 MHz (15m)' },
            { hz: 24920900, label: '24.9209 MHz (12m)' },
            { hz: 28122900, label: '28.1229 MHz (10m)' },
        ],
    },
    {
        group: 'Wider activity',
        options: [
            { hz: 3583000, label: '3.583 MHz (80m)' },
            { hz: 7073000, label: '7.073 MHz (40m)' },
            { hz: 14105500, label: '14.1055 MHz (20m)' },
            { hz: 18103000, label: '18.103 MHz (17m)' },
            { hz: 21105000, label: '21.105 MHz (15m)' },
        ],
    },
];

/**
 * The attach parameters for a configuration.
 *
 * `sync_threshold` is taken from a snapshot rather than from live state on
 * purpose: it is the one setting the server can change without rebuilding the
 * decoder, so it travels by control message instead. Including its live value
 * here would make every drag of the squelch slider re-attach — and Olivia takes
 * seconds to re-acquire, so the slider would be unusable.
 */
export function attachParams(config, squelchAtAttach) {
    return {
        tones: config.tones,
        bandwidth: config.bandwidth,
        center_frequency: config.center_frequency,
        sync_margin: config.sync_margin,
        sync_integ_len: config.sync_integ_len,
        reverse: !!config.reverse,
        eight_bit: !!config.eight_bit,
        sync_threshold: squelchAtAttach,
    };
}
