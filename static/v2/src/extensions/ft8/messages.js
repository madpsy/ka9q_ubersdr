// FT8 decodes: normalisation, filtering, sorting and export.
//
// The server's payload is defined in audio_extensions/ft8/decoder.go. Every
// field is optional except the message itself — a decode with no callsign the
// CTY database recognises carries no country, distance or bearing — so this
// normalises once, on arrival, and the rest of the extension reads plain values
// rather than repeating the same `!= null` dance in every cell.
//
// The rules here are v1's (static/extensions/ft8/main.js), including the ones
// that look arbitrary: the 1000-decode cap, the 100 kept by auto-clear, and
// "latest cycle only" meaning the *current* slot rather than the last complete
// one. On a busy 20 m evening a slot is 40-odd decodes, so the cap is about an
// hour of history.

// Hard cap on retained decodes, and what auto-clear keeps when a slot rolls.
export const MAX_MESSAGES = 1000;
export const AUTO_CLEAR_KEEP = 100;

// An FT8 transmission cycle. Used for the progress bar only — slot numbering
// comes from the server, which is the one clock that matters.
export const CYCLE_SEC = 15;

// The passband the decoder wants: FT8 occupies the first 3 kHz of a USB slot.
export const FT8_MODE = 'usb';
export const FT8_BANDWIDTH = { low: 0, high: 3200 };

// The audio spectrum the decoder actually looks at, and so the width of the
// extension's own spectrum display.
export const MAX_AUDIO_HZ = 3000;

// v1's frequency menu, unchanged.
export const FT8_FREQUENCIES = [
    {
        group: 'FT8 — most active',
        options: [
            { hz: 7074000, label: '7.074 MHz (40m)' },
            { hz: 14074000, label: '14.074 MHz (20m — primary)' },
            { hz: 21074000, label: '21.074 MHz (15m)' },
            { hz: 28074000, label: '28.074 MHz (10m)' },
        ],
    },
    {
        group: 'Other FT8 bands',
        options: [
            { hz: 3573000, label: '3.573 MHz (80m)' },
            { hz: 10136000, label: '10.136 MHz (30m)' },
            { hz: 18100000, label: '18.100 MHz (17m)' },
            { hz: 24915000, label: '24.915 MHz (12m)' },
            { hz: 50313000, label: '50.313 MHz (6m)' },
        ],
    },
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * One decode from the wire, in the shape the table renders.
 *
 * `seq` makes the React key: the server sends no id, and two stations can share
 * a slot, a frequency and a message ("CQ" from a split beacon pair), so nothing
 * in the payload is reliably unique.
 */
export function normaliseMessage(raw, seq) {
    const message = String(raw.message || '');
    return {
        key: `${seq}`,
        utc: String(raw.utc || ''),
        snr: num(raw.snr) ?? 0,
        deltaT: num(raw.delta_t) ?? 0,
        frequency: num(raw.frequency) ?? 0,
        distanceKm: num(raw.distance_km),
        bearingDeg: num(raw.bearing_deg),
        country: raw.country || '',
        countryCode: raw.country_code || '',
        continent: raw.continent || '',
        txCallsign: raw.tx_callsign && raw.tx_callsign !== '-' ? raw.tx_callsign : '',
        callsign: raw.callsign || '',
        locator: raw.locator || '',
        message,
        protocol: raw.protocol || 'FT8',
        slot: num(raw.slot_number) ?? 0,
        // CQ is what most people are looking for, and the test is the same one
        // the filter and the row highlight use.
        isCQ: message.startsWith('CQ'),
    };
}

// Per-slot decoder statistics, which ride along on every decode rather than
// arriving as their own message.
export function statsFrom(raw) {
    return {
        candidates: num(raw.candidate_count),
        ldpcFailures: num(raw.ldpc_failures),
        crcFailures: num(raw.crc_failures),
    };
}

// Newest first, capped. The cap drops from the end because the list is already
// in display order.
export function addMessage(list, msg, cap = MAX_MESSAGES) {
    const next = [msg, ...list];
    return next.length > cap ? next.slice(0, cap) : next;
}

export function filterMessages(list, { cqOnly, latestOnly, text, currentSlot }) {
    const needle = String(text || '').trim().toLowerCase();
    return list.filter((m) => {
        // "Latest cycle only" hides everything but the slot now being decoded.
        // Before the first decode there is no current slot, so nothing is hidden.
        if (latestOnly && currentSlot > 0 && m.slot !== currentSlot) return false;
        if (cqOnly && !m.isCQ) return false;
        if (needle) {
            const inMessage = m.message.toLowerCase().includes(needle);
            const inCountry = m.country.toLowerCase().includes(needle);
            if (!inMessage && !inCountry) return false;
        }
        return true;
    });
}

// The table's columns. `sort` says how the column compares — the numeric ones
// must not be compared as text, or -12 sorts above -3.
export const COLUMNS = [
    { id: 'utc', label: 'UTC', sort: 'text', cls: 'ft8__c-time' },
    { id: 'snr', label: 'SNR', sort: 'num', cls: 'ft8__c-num' },
    { id: 'deltaT', label: 'ΔT', sort: 'num', cls: 'ft8__c-num' },
    { id: 'frequency', label: 'Freq', sort: 'num', cls: 'ft8__c-num' },
    { id: 'distanceKm', label: 'km', sort: 'num', cls: 'ft8__c-num' },
    { id: 'bearingDeg', label: 'Brg', sort: 'num', cls: 'ft8__c-num' },
    { id: 'country', label: 'Country', sort: 'text', cls: 'ft8__c-country' },
    { id: 'continent', label: 'Cont', sort: 'text', cls: 'ft8__c-cont' },
    { id: 'txCallsign', label: 'TX call', sort: 'text', cls: 'ft8__c-call' },
    { id: 'message', label: 'Message', sort: 'text', cls: 'ft8__c-msg' },
    { id: 'slot', label: 'Slot', sort: 'num', cls: 'ft8__c-num' },
];

const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

/**
 * Sorted copy, or the list untouched when no column is chosen.
 *
 * No column is the default and it means "arrival order, newest first" — which
 * is what a decoder should show while it is running. A missing value always
 * sorts last, in both directions: a decode with no distance is not nearer than
 * one at 0 km, and burying them at the bottom keeps the real values together.
 */
export function sortMessages(list, column, dir = 'asc') {
    const col = COLUMN_BY_ID[column];
    if (!col) return list;
    const sign = dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        const aMissing = av == null || av === '';
        const bMissing = bv == null || bv === '';
        if (aMissing || bMissing) return aMissing && bMissing ? 0 : (aMissing ? 1 : -1);
        if (col.sort === 'num') return sign * (av - bv);
        return sign * String(av).localeCompare(String(bv));
    });
}

const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

const CSV_COLUMNS = [
    ['UTC', (m) => m.utc],
    ['SNR', (m) => m.snr],
    ['DeltaT', (m) => m.deltaT],
    ['Frequency', (m) => m.frequency],
    ['Distance_km', (m) => (m.distanceKm == null ? '' : m.distanceKm.toFixed(1))],
    ['Bearing_deg', (m) => (m.bearingDeg == null ? '' : m.bearingDeg.toFixed(1))],
    ['Country', (m) => m.country],
    ['CountryCode', (m) => m.countryCode],
    ['Continent', (m) => m.continent],
    ['TX_Callsign', (m) => m.txCallsign],
    ['Callsign', (m) => m.callsign],
    ['Locator', (m) => m.locator],
    ['Message', (m) => m.message],
    ['Protocol', (m) => m.protocol],
    ['Slot', (m) => m.slot],
];

/**
 * CSV of the decodes given, oldest first.
 *
 * Every field is quoted, unlike v1, which quoted only the ones it expected to
 * contain a comma — an FT8 message never holds one, but a country name can
 * ("Korea, Republic of"), and one unquoted comma shifts every later column.
 */
export function toCSV(list) {
    const rows = [CSV_COLUMNS.map(([h]) => h).join(',')];
    for (let i = list.length - 1; i >= 0; i--) {
        rows.push(CSV_COLUMNS.map(([, get]) => csvCell(get(list[i]))).join(','));
    }
    return rows.join('\n') + '\n';
}

/**
 * Where we are in the 15-second cycle, from the wall clock.
 *
 * FT8 slots start on the minute and every 15 seconds after it, so the position
 * is the seconds-past-the-minute modulo the cycle. This is the receiver's own
 * clock: if it is off, so is this bar, which is exactly the problem it exists
 * to make visible.
 */
export function cycleProgress(nowMs) {
    const d = new Date(nowMs);
    const seconds = d.getSeconds() + d.getMilliseconds() / 1000;
    const at = seconds % CYCLE_SEC;
    return { seconds: at, fraction: at / CYCLE_SEC };
}
