// NAVTEX: the message frame, and where to point the receiver.
//
// The decoder underneath is SITOR-B and nothing more — the same CCIR476 stream
// FSK decodes, at the same 100 baud and 170 Hz shift (see ../teleprinter.js).
// What makes NAVTEX its own extension rather than a preset is what the
// characters mean once they arrive: they are not a continuous teleprinter feed
// but a series of numbered messages, each announced by a header that says who
// sent it, what it is about, and whether you have already had it.
//
//     ZCZC B1B2B3B4
//     <message text>
//     NNNN
//
// B1 is the transmitter's identifying letter, B2 the subject, and B3B4 a serial
// number. A receiver is meant to use the three to decide whether to print a
// message at all — that is the whole point of the scheme — so showing them as
// letters and a number, rather than leaving "ZCZC IA47" in a wall of text, is
// most of what this panel adds over the raw console.
//
// Nothing here is speculative about the text itself: a NAVTEX message body is
// free-form, and this does not try to read it.

// Messages kept. A NAVTEX slot is a few messages and a station transmits every
// four hours, so this is more than a day of one station's traffic.
export const MAX_MESSAGES = 200;

// The IMO subject indicator characters (B2). A receiver may be told to ignore
// most of these; A, B, D and L are the ones it may not, which is why they are
// marked — a panel that quietly filtered a search-and-rescue message would be
// doing the one thing the standard forbids.
//
// B1 is deliberately not decoded. Transmitter letters are assigned per NAVAREA
// and the same letter means a different station in each, so a lookup table
// would be wrong somewhere in the world and there would be no way to tell where.
export const SUBJECTS = {
    A: { label: 'Navigational warning', vital: true },
    B: { label: 'Meteorological warning', vital: true },
    C: { label: 'Ice report' },
    D: { label: 'Search and rescue', vital: true },
    E: { label: 'Meteorological forecast' },
    F: { label: 'Pilot service' },
    G: { label: 'AIS' },
    H: { label: 'LORAN' },
    I: { label: 'Not used' },
    J: { label: 'SATNAV' },
    K: { label: 'Other electronic navaid' },
    L: { label: 'Navigational warning (additional)', vital: true },
    V: { label: 'Notice to fishermen' },
    W: { label: 'Environmental' },
    X: { label: 'Special service' },
    Y: { label: 'Special service' },
    Z: { label: 'No messages on hand' },
};

/**
 * What a subject letter means, or null.
 *
 * Null for M to U, which the standard reserves and does not define: naming them
 * would be inventing a meaning, and the letter itself is still shown.
 */
export function subjectOf(letter) {
    return SUBJECTS[String(letter || '').toUpperCase()] || null;
}

/**
 * The messages in a console's worth of decoded lines.
 *
 * Runs over the whole buffer rather than incrementally. That is the simpler
 * thing by a wide margin — a marker split across two 100 ms flushes needs no
 * special case, and the parser is a pure function of what is on screen — and it
 * is cheap enough: NAVTEX is ten characters a second, so this scans a few tens
 * of kilobytes ten times a second at worst.
 *
 * A header the error correction could not recover does not match, and that
 * message simply is not here. That is deliberate: a message attributed to the
 * wrong station, or given someone else's serial number, is worse than one the
 * panel does not claim to have. The raw console still has every character.
 */
export function parseMessages(lines, cap = MAX_MESSAGES) {
    // One string, plus where each line began, so a message can be timed by the
    // line its header arrived on.
    let text = '';
    const starts = [];
    for (const l of lines) {
        starts.push(text.length);
        text += `${l.text}\n`;
    }

    const at = (index) => {
        // The last line that began at or before this offset.
        let lo = 0;
        for (let i = 0; i < starts.length; i++) {
            if (starts[i] > index) break;
            lo = i;
        }
        return lines.length ? lines[lo].at : 0;
    };

    const out = [];
    // The space after ZCZC is in the standard but not always in the air, and
    // the error correction can leave a stray character in its place.
    const header = /ZCZC\s*([A-Z])([A-Z])([0-9]{2})/g;
    let m = header.exec(text);
    while (m) {
        const bodyFrom = m.index + m[0].length;
        const end = text.indexOf('NNNN', bodyFrom);
        const nextHeader = text.indexOf('ZCZC', bodyFrom);

        // A message ends at its NNNN, or at the next header if the end was lost
        // — which happens, and is worth showing as an unterminated message
        // rather than swallowing the next one into it.
        let stop;
        let complete;
        if (end >= 0 && (nextHeader < 0 || end < nextHeader)) {
            stop = end;
            complete = true;
        } else {
            stop = nextHeader >= 0 ? nextHeader : text.length;
            complete = false;
        }

        out.push({
            id: `${m.index}-${m[1]}${m[2]}${m[3]}`,
            at: at(m.index),
            station: m[1],
            subject: m[2],
            // Kept as the two characters that were sent: 00 is the serial that
            // means "important, transmit every time", and 0 would lose that.
            serial: m[3],
            body: text.slice(bodyFrom, stop).trim(),
            complete,
        });

        header.lastIndex = complete ? stop + 4 : stop;
        m = header.exec(text);
    }

    return out.length > cap ? out.slice(out.length - cap) : out;
}

// The decoder's settings. Fixed, unlike FSK's: NAVTEX is SITOR-B by definition,
// so framing and encoding are not choices — v1's encoding menu had exactly one
// entry in it. The three numbers stay adjustable because a signal can be off
// frequency and a transmitter's clock can drift.
export const NAVTEX_CONFIG = {
    center_frequency: 500,
    shift: 170,
    baud_rate: 100,
    framing: '4/7',
    encoding: 'CCIR476',
    inverted: false,
};

// v1's station list. These are the assigned frequencies of the transmissions,
// which for NAVTEX is the centre of the FSK pair — so tuning one puts the dial
// an audio centre below it, exactly as v1's tuneToStation did.
export const NAVTEX_FREQUENCIES = [
    {
        group: 'NAVTEX — MF',
        options: [
            { hz: 518000, label: '518 kHz — International' },
            { hz: 490000, label: '490 kHz — National' },
            { hz: 4209500, label: '4.2095 MHz — Tropical' },
        ],
    },
    {
        group: 'NAVTEX — HF',
        options: [
            { hz: 4210000, label: '4.210 MHz' },
            { hz: 6314000, label: '6.314 MHz' },
            { hz: 8416500, label: '8.4165 MHz' },
            { hz: 12579000, label: '12.579 MHz' },
            { hz: 16806500, label: '16.8065 MHz' },
            { hz: 19680500, label: '19.6805 MHz' },
            { hz: 22376000, label: '22.376 MHz' },
            { hz: 26100500, label: '26.1005 MHz' },
        ],
    },
    {
        // Same modulation, different traffic: DSC is short bursts of digits
        // rather than text, so it reads as noise in the message view and lives
        // in the raw console. Kept because v1 offered it and it decodes.
        group: 'DSC — MF/HF',
        options: [
            { hz: 2187500, label: '2.1875 MHz' },
            { hz: 4207500, label: '4.2075 MHz' },
            { hz: 6312000, label: '6.312 MHz' },
            { hz: 8414500, label: '8.4145 MHz' },
            { hz: 12577000, label: '12.577 MHz' },
            { hz: 16804500, label: '16.8045 MHz' },
        ],
    },
];
