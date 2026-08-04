// The three lines the OS shows, built from a plain snapshot.
//
// Pure, and separate from the controller, because this is the part that has an
// opinion — what belongs on a car stereo's one-line display — and the part
// worth testing without a browser.
//
// The mapping to a music player's fields, which is all the API offers:
//   title  — the receiver. Constant, and what the notification is "from".
//   artist — where you are: frequency, mode, and the callsign if you are on one.
//   album  — what is there: the bookmark or spot name, enriched with the
//            operator's name and country once the lookup lands.

import { CALLSIGN_TYPES } from '../../lib/markerNav.js';

// v1's format: MHz.kHz.Hz, so 21242500 reads "21.242.500 MHz". Period-grouped
// rather than decimal because at a glance it is unmistakably a frequency and
// not a number, and it stays readable at any band.
export function formatFrequency(hz) {
    if (!(hz > 0)) return '';
    const mhz = Math.floor(hz / 1000000);
    const khz = Math.floor((hz % 1000000) / 1000);
    const rest = hz % 1000;
    return `${mhz}.${String(khz).padStart(3, '0')}.${String(rest).padStart(3, '0')} MHz`;
}

// The album line for a marker, with whatever the callsign lookup has so far.
// `lookup` is the resolved lookup for a callsign marker, or null.
export function markerLabel(marker, lookup) {
    if (!marker) return 'Live SDR';
    const name = marker.name || '';
    if (!name) return 'Live SDR';
    if (!CALLSIGN_TYPES.has(marker.type) || !lookup) return name;

    // "G4ABC — Dave, England". The first name only: the album line is short and
    // a full name plus country runs off the end of most lock screens.
    const extra = [lookup.firstName, lookup.country].filter(Boolean).join(', ');
    return extra ? `${name} — ${extra}` : name;
}

// Builds the metadata text. Returns plain strings so the controller can compare
// them against what it last set — Chrome re-fetches all artwork whenever the
// MediaMetadata object is replaced, even with identical content, so replacing
// it only when something actually changed is not an optimisation but a fix.
export function buildMetadata({ frequency, mode, receiver, marker, lookup }) {
    const title = receiver ? `UberSDR • ${receiver}` : 'UberSDR';

    const markerCallsign = marker && CALLSIGN_TYPES.has(marker.type) ? marker.name : '';
    const artist = [
        formatFrequency(frequency),
        String(mode || '').toUpperCase(),
        markerCallsign,
    ].filter(Boolean).join(' • ');

    return { title, artist, album: markerLabel(marker, lookup) };
}

// Whether two metadata snapshots would show the same thing. The photo is part
// of the comparison because it arrives after the text, and the metadata has to
// be pushed again when it does.
export function sameMetadata(a, b) {
    if (!a || !b) return false;
    return a.title === b.title && a.artist === b.artist &&
        a.album === b.album && a.photo === b.photo;
}
