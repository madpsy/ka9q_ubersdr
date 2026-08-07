// The doppler addon: ionospheric Doppler shift on standard time stations.
//
// The addon tunes WWV, WWVH, CHU and the like as AM 500 Hz below the carrier, runs a
// 131k-point FFT over each, and measures where the carrier actually landed — to about
// a hundredth of a hertz. What that number moves with is the ionosphere: a solar flare,
// a travelling disturbance, the terminator crossing the path. It logs minute means to
// CSV for the HamSCI Doppler experiment and draws the curves on its own page.
//
// This is the dock version: what each station is doing right now, against the hour it
// has been doing it. Four figures and a row per station — the curves, the history, the
// CSV export and the station configuration are all a click away.
//
// ── What "zero" means, and why the baseline is shown next to the reading ─────
//
// Without a GPS-disciplined oscillator the receiver's own clock is off by tens of hertz
// at HF, and that offset lands in the reading as a constant. So the absolute number is
// arbitrary on most receivers and the *variation* around it is the measurement. The
// addon works out a one-hour mean per station for exactly this reason; showing the two
// together is the difference between a panel that says "+12.4 Hz" — which means nothing
// on its own — and one that says the carrier is 0.3 Hz above where it has been sitting.
//
// A receiver with a reference station configured (a leaky GPSDO on 10 MHz, say) gets a
// corrected figure with the clock drift subtracted, and that one is real. See
// baselineShift — named at length because plain `shift` is the FSK shift in half the
// digital extensions, and formatShift for the same reason: lib/format.js already has a
// formatHz, and two of those would be one too many.

export const BASE = '/addon/doppler';

export const ADDON_NAME = 'doppler';

/** The addon's own page, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the other addon panels make. */
export function dopplerAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

export const stationsUrl = (base = BASE) => `${base}/api/stations`;

// The live stream, and the knob that keeps it cheap.
//
// /api/events carries two things: an unnamed message per reading, which is what this
// panel wants, and a compressed FFT frame per station on a timer, which it does not —
// nothing here draws a spectrum. The addon lets each client choose that frame rate, so
// the panel asks for the slowest it offers rather than taking the default and throwing
// three fifths of it away. The token is how the addon knows which connection to slow:
// it is a client identifier and nothing else, so any random string will do.
export const SPECTRUM_INTERVAL_S = 5;
export const spectrumIntervalUrl = (base = BASE) => `${base}/api/spectrum-interval`;

export const streamUrl = (token, base = BASE) =>
    `${base}/api/events?client_token=${encodeURIComponent(token)}`;

export function clientToken() {
    // Not a secret and not an identity — the addon uses it to find one SSE connection.
    return `v2-${Math.random().toString(36).slice(2, 10)}`;
}

// How often the station list is re-read. The stream carries the live readings; this is
// for the hour-long baseline mean and for configuration somebody has changed on the
// addon's page — neither of which moves quickly, and the payload carries a spectrum per
// station, so asking often would cost far more than it told us.
export const STATIONS_POLL_MS = 60000;

// When a reading stops counting as live. The addon takes one a second and the FFT
// window is about eleven, so half a minute of nothing means the station has dropped
// rather than that it is between readings.
export const STALE_MS = 30000;

/**
 * One station, from /api/stations, in the shape the panel uses.
 *
 * `doppler` is the figure to show and `corrected` says whether it has had a reference
 * subtracted from it — the difference between a number that means something absolutely
 * and one that only means something relative to its own baseline.
 */
export function normaliseStation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cfg = raw.config || {};
    const cur = raw.current || {};
    const label = String(cfg.label || '').trim();
    if (!label) return null;
    const at = Date.parse(cur.timestamp);
    const corrected = num(raw.corrected_doppler_hz);
    const rawHz = num(cur.doppler_hz);
    return {
        id: cfg.id || label,
        label,
        hz: Number(cfg.freq_hz) || 0,
        mhz: cfg.freq_hz ? (Number(cfg.freq_hz) / 1e6).toFixed(3) : '',
        enabled: cfg.enabled !== false,
        reference: !!cfg.is_reference,
        valid: !!cur.valid,
        at: Number.isFinite(at) ? at : 0,
        raw: rawHz,
        corrected,
        doppler: corrected == null ? rawHz : corrected,
        baseline: num(raw.baseline_mean_hz),
        baselineN: Number(raw.baseline_n) || 0,
        snr: num(cur.snr_db),
        spread: num(cur.doppler_spread_hz),
        s4: num(cur.scintillation_s4),
    };
}

const num = (v) => {
    const n = Number(v);
    return v == null || !Number.isFinite(n) ? null : n;
};

/**
 * A live reading from the stream, folded into the station it belongs to.
 *
 * The stream is keyed by label and carries no configuration, so it updates a station
 * rather than replacing one: the frequency, the baseline and whether this is the
 * reference all come from /api/stations and must survive a reading arriving.
 */
export function applyReading(stations, msg, arrivedAt = Date.now()) {
    const label = msg && String(msg.station || '').trim();
    const r = msg && msg.reading;
    if (!label || !r) return stations;
    let touched = false;
    const out = stations.map((s) => {
        if (s.label !== label) return s;
        touched = true;
        const at = Date.parse(r.timestamp);
        const corrected = num(r.corrected_doppler_hz);
        const rawHz = num(r.doppler_hz);
        return {
            ...s,
            valid: !!r.valid,
            at: Number.isFinite(at) ? at : arrivedAt,
            raw: rawHz,
            corrected,
            doppler: corrected == null ? rawHz : corrected,
            snr: num(r.snr_db),
            spread: num(r.doppler_spread_hz),
            s4: num(r.scintillation_s4),
        };
    });
    // A station the panel has never heard of is ignored rather than invented: without
    // its configuration there is no frequency to show and no baseline to compare with,
    // and the next station poll will bring it in properly.
    return touched ? out : stations;
}

/**
 * How far the carrier is from where it should be — the ionospheric part.
 *
 * Three ways of knowing that, in the order they are trusted, and one way of not:
 *
 *   Against its own hour-long baseline. The number worth reading on a receiver without
 *   a GPSDO, and why the baseline is fetched at all.
 *
 *   A corrected reading is already absolute — the reference station's drift has been
 *   taken out of it — so it is its own departure from zero and needs no baseline.
 *
 *   The reference station itself has no baseline by design: the addon does not compute
 *   one for it, because it *is* the yardstick. Its raw reading is its error against
 *   truth, which is exactly the quantity this column shows for everything else.
 *
 * Only the last case is unknown: a plain reading with no baseline and no reference is
 * an arbitrary clock offset, and reporting "+12.40" as a shift would paint a receiver
 * that is working perfectly in red. That stays null and the panel shows a dash.
 */
export function baselineShift(station) {
    if (!station || station.doppler == null) return null;
    if (station.baseline != null) return station.doppler - station.baseline;
    if (station.reference || station.corrected != null) return station.doppler;
    return null;
}

/**
 * What that figure was worked out from, for the tooltip.
 *
 * The three are not the same claim — one is a departure from an hour of this station's
 * own history, one is an absolute measurement, one is the reference reporting its own
 * error — and a reader who cares about a tenth of a hertz cares which.
 */
export function shiftSource(station) {
    if (!station || station.doppler == null) return null;
    if (station.baseline != null) return 'baseline';
    if (station.reference) return 'reference';
    if (station.corrected != null) return 'corrected';
    return null;
}

/** Whether a station's last reading is recent enough to still mean anything. */
export function isLive(station, now = Date.now()) {
    return !!(station && station.valid && station.at && now - station.at < STALE_MS);
}

/**
 * How to colour a reading: how far it has moved from its own baseline.
 *
 * The thresholds are what the phenomena look like. A quiet path sits within a tenth of
 * a hertz; a few tenths is the ionosphere doing something you would notice on a chart;
 * a hertz or more on an HF carrier is a flare or the terminator, and is the thing the
 * whole experiment exists to catch.
 */
export const SHIFT_WARN_HZ = 0.3;
export const SHIFT_BIG_HZ = 1;

export function shiftBand(hz) {
    if (hz == null) return '';
    const v = Math.abs(hz);
    if (v >= SHIFT_BIG_HZ) return 'big';
    if (v >= SHIFT_WARN_HZ) return 'warn';
    return 'calm';
}

/** A Doppler figure, signed, at the precision the measurement actually has. */
export function formatShift(hz, places = 2) {
    if (hz == null || !Number.isFinite(hz)) return '—';
    const s = hz.toFixed(places);
    // A signed zero reads as an instrument fault rather than as a carrier on frequency.
    return (hz > 0 && Number(s) !== 0 ? '+' : '') + (Number(s) === 0 ? (0).toFixed(places) : s);
}

/** The headline: how many stations are being watched, and how they are doing. */
export function dopplerSummary(stations, now = Date.now()) {
    let live = 0;
    let biggest = null;
    let best = null;
    for (const s of stations) {
        if (!s.enabled) continue;
        if (isLive(s, now)) live++;
        if (s.snr != null && (best == null || s.snr > best)) best = s.snr;
        const d = baselineShift(s);
        if (d != null && (biggest == null || Math.abs(d) > Math.abs(biggest))) biggest = d;
    }
    return {
        watching: stations.filter((s) => s.enabled).length,
        live,
        biggest,
        bestSnr: best,
    };
}

