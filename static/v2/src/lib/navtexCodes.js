// NAVTEX's own codes, shared.
//
// This was the decoder extension's, until the panel for the NAVTEX addon wanted the
// same table: one is a live decode of what this receiver is hearing, the other is what
// a dedicated addon has already decoded, and the letters mean the same thing in both.
// Two copies of an IMO table is exactly the kind of thing that ends with one of them
// being wrong.

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
