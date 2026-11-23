// What the ELAD TM-2's LCD, LEDs and backlight show about the receiver.
//
// Pure — a function of the receiver snapshot, the operator's settings and the
// driver's own state (which page each small knob is on, any popup) — so it is
// tested without a page or a device. tm2.js calls it; ControlWatch feeds it
// the same receiver state it sends the UberSDR Dial.
//
// The layout follows ELAD's, as the product photographs show it running ELAD's
// own software:
//
//   RX  ▮▮▮▯▯▯…        -107 dBm  AM      S-meter bar and scale, level, mode
//   S 1 3 5 7 9 +20 +40 +60
//   VFO B     7.074.000 Hz              VFO, frequency, unit
//                  ‾                    underline: the digit the step moves
//   [E1] VOL          [E2] HIGH         what each small knob is adjusting
//
// The manual (ELAD TM-2 User Manual, Rev 2, 05/2021) says what the controls
// do but nothing about the LCD, so where an element's meaning is read off a
// photograph or inferred from its name in Tmate2_C's bitfields.h, the comment
// says so — "TM-2 UNVERIFIED" — and those are the ones to check against a unit.

import {
    displayMainNumber, displayMainText, displaySmeterNumber, encoderSetup, newFrame,
    setBars, setField, setRgb, setSmeterGraph, setSmeterS,
} from './tm2frame.js';
import { dbfsToSUnits, sMeterColour } from '../lib/format.js';
import { filterShift } from '../radio/constants.js';

// What each small knob steps through when its push is tapped — ELAD's own
// arrangement: E1 "volume, squelch, noise reducer, noise blanker, auto notch",
// E2 the filter "High / Low / Shift" (SDR-Console's wording). v2 has no noise
// blanker or auto-notch to offer, so E1 stops at NR. Each page lights the
// LCD label of the same name beside the knob's E1/E2 box.
export const E1_PAGES = ['vol', 'sql', 'nr'];
export const E2_PAGES = ['high', 'low', 'shift'];
export const PAGE_LABEL = { vol: 'VOL', sql: 'SQL', nr: 'NR', high: 'HIGH', low: 'LOW', shift: 'SHIFT' };

// TM-2 UNVERIFIED: the page labels are assumed to be the LCD's vol / sql / nr /
// high / low / shift segments. The photographs show "[E1] VOL" and
// "[E2] HIGH", which is what supports it; the rest are read off the names.
const PAGE_FIELDS = ['vol', 'sql', 'nr', 'high', 'low', 'shift'];

// v2 mode -> the LCD's mode annunciators.
// TM-2 UNVERIFIED: FM vs W-FM, and CW-/CW+, are read off Tmate2_C's field
// names (w_fm, cw_minus, cw_plus); a unit may draw them differently. IQ has no
// annunciator of its own and shows none rather than borrowing DIG.
export const MODE_FIELDS = {
    lsb: ['lsb'],
    usb: ['usb'],
    am: ['am'],
    sam: ['sam'],
    nfm: ['fm'],
    fm: ['fm', 'w_fm'],
    cwl: ['cw', 'cw_minus'],
    cwu: ['cw', 'cw_plus'],
};
const ALL_MODE_FIELDS = ['lsb', 'usb', 'am', 'sam', 'dsb', 'fm', 'w_fm', 'cw', 'cw_minus', 'cw_plus',
    'drm', 'dig', 'dig_plus', 'dig_minus', 'stereo'];

// The main encoder's built-in acceleration, as main_encoder_setup's three
// speeds: counts per click slow, faster, fastest, switching at trans12 and
// trans23 (Tmate2_C's 32 and 64).
// TM-2 UNVERIFIED: what "speed" means exactly is inferred — Tmate2_C uses
// 1 / 100 / 1000 (232 once it is a byte) because it tunes 1 Hz a count. Here a
// count is one Receiver-panel step, so much gentler values.
export const ACCEL = {
    off: [1, 1, 1],
    mild: [1, 2, 5],
    strong: [1, 5, 25],
};
export const ACCEL_OPTIONS = [
    { value: 'off', label: 'Off' },
    { value: 'mild', label: 'Mild' },
    { value: 'strong', label: 'Strong' },
];
const TRANS12 = 32;
const TRANS23 = 64;
const TRANS_TIME = 10;     // not sent — see tm2frame.js — but set, as Tmate2_C does

// The three digits beside the S-meter. ELAD's software shows the signal in dBm
// there ("-107 dBm" in the photographs). v2's level is dBFS, which its own
// S-meter already reads as dBm (S9 = -73, lib/format.js) — so 'dbm' shows that
// number with the dBm label, as the S-meter beside it implies; 'dbfs' is the
// same number without the label, for anyone who would rather not claim dBm.
export const READOUTS = [
    { value: 'dbm', label: 'Signal, labelled dBm' },
    { value: 'dbfs', label: 'Signal (dBFS), no label' },
    { value: 'snr', label: 'SNR (dB)' },
    { value: 'off', label: 'Off' },
];

export const DEFAULT_TM2_DISPLAY = {
    // White, as Tmate2_C starts it. ELAD's own software ships a light blue.
    backlight: '#ffffff',
    // TM-2 UNVERIFIED: Tmate2_C never sets the contrast, so the unit it was
    // written against ran at 0 — and so did the WebHID test page that worked.
    contrast: 0,
    readout: 'dbm',
    // Backlight in the S-meter's colour (red through green), as v2's meter is.
    meterColour: false,
    // Dim the backlight while the receiver's audio is down.
    dimWhenDown: true,
    // The green LED blinks, and ERR lights, while the receiver is down.
    blinkWhenDown: true,
    // A click from the TM-2 the moment a press becomes a hold.
    clickOnHold: true,
    accel: 'mild',
};

const HEX = /^#[0-9a-f]{6}$/i;

/** The settings with every gap filled and every value in range. */
export function tm2Settings(raw) {
    const s = { ...DEFAULT_TM2_DISPLAY, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (typeof s.backlight !== 'string' || !HEX.test(s.backlight)) s.backlight = DEFAULT_TM2_DISPLAY.backlight;
    s.contrast = Math.max(0, Math.min(255, Math.round(Number(s.contrast)) || 0));
    if (!READOUTS.some((r) => r.value === s.readout)) s.readout = DEFAULT_TM2_DISPLAY.readout;
    if (!ACCEL[s.accel]) s.accel = DEFAULT_TM2_DISPLAY.accel;
    for (const k of ['meterColour', 'dimWhenDown', 'blinkWhenDown', 'clickOnHold']) s[k] = !!s[k];
    return s;
}

/**
 * Which main-display digit (1 = units) the tuning step moves, for its
 * underline: 1 Hz the units, 1 kHz the fourth. A step that is not a power of
 * ten — 500 Hz, 5 kHz, 9 kHz — underlines the digit it changes most often.
 * The photograph shows 1 kHz underlined that way.
 */
export function stepDigit(stepHz) {
    const s = Number(stepHz);
    if (!(s >= 1)) return 0;
    return Math.min(9, Math.floor(Math.log10(s) + 1e-9) + 1);
}

function label(name, value) {
    const v = String(value);
    return name + v.padStart(Math.max(1, 9 - name.length), ' ');
}

// A value with three decimals, drawn against the display's own thousands dot
// (dot2, between the fourth digit and the third): 4.5 ms is "4500" with the dot
// lit, so it reads "4.500". Seven segments have no decimal point of their own
// that sits anywhere else, and a '.' glyph would cost a whole digit.
function fixed3(name, value) {
    const n = Math.round((Number(value) || 0) * 1000);
    const digits = String(Math.abs(n)).padStart(4, '0');
    return label(name, (n < 0 ? '-' : '') + digits);
}

// The popups drawn with fixed3, which light dot2 — see renderTm2.
const FIXED3 = new Set(['nbwidth', 'cnrmakeup', 'cnrfloor', 'cnradapt']);

// The client NR engines as six characters can spell them. 'nr2' is labelled
// plain "NR" in the Noise panel, and is here.
const CNR_SHORT = { lsa: 'LSA', nr2: 'NR', rmn: 'RMN' };

function stepText(hz) {
    if (hz >= 1000 && hz % 1000 === 0) return `${hz / 1000}K`;
    if (hz >= 1000) return `${(hz / 1000).toFixed(1)}K`;
    return String(hz);
}

/**
 * The nine characters a popup shows on the main display: what a small knob is
 * set to, or a setting that just changed. Seven segments draw letters
 * approximately, so the words are short and the numbers do the work.
 */
export function popupText(kind, rx) {
    const r = rx || {};
    switch (kind) {
        case 'vol': return r.muted ? 'VOL  MUTE' : label('VOL', Math.round((Number(r.volume) || 0) * 100));
        case 'sql': return r.squelchOn ? label('SQL', Math.round(Number(r.squelchDb) || 0)) : 'SQL   OFF';
        // The filter's own name, as far as seven segments and six places go —
        // turning E1 on NR walks the filters, so the name is the point.
        case 'nr': {
            if (!r.dspEnabled) return 'NR    OFF';
            const name = String(r.dspFilter || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            return label('NR', name || 'ON');
        }
        case 'high': return label('HI', Math.round(Number(r.bwHigh) || 0));
        case 'low': return label('LO', Math.round(Number(r.bwLow) || 0));
        case 'shift': return label('SH', Math.round(filterShift(r.mode, Number(r.bwLow) || 0, Number(r.bwHigh) || 0)));
        case 'step': return label('STEP', stepText(Number(r.stepHz) || 0));
        case 'mute': return r.muted ? 'MUTED' : 'UNMUTED';
        case 'lock': return r.locked ? 'LOCKED' : 'UNLOCKED';
        // NR, whichever kind is in charge (nr_*_any in controls/functions.js):
        // the receiver's where it has filters, the client's where it has none.
        case 'nrany': return popupText(r.dspAvailable ? 'nr' : 'cnr', r);
        // The client noise stage, under the names its segments carry: NB the
        // blanker, NR2 the client NR (the receiver's is NR).
        case 'nb': return r.nbEnabled ? 'NB     ON' : 'NB    OFF';
        case 'nbthr': return label('NB TH', Math.round(Number(r.nbThresholdDb) || 0));
        case 'nbwidth': return fixed3('NBW', r.nbWidthMs);
        case 'cnr': return r.cnrEnabled ? label('NR2', CNR_SHORT[r.cnrType] || 'ON') : 'NR2   OFF';
        case 'cnrstr': return label('STR', Math.round(Number(r.cnrStrength) || 0));
        case 'cnrmakeup': return fixed3('MKUP', r.cnrMakeupDb);
        case 'cnrfloor': return fixed3('FLR', r.cnrFloor);
        case 'cnradapt': return fixed3('ADPT', r.cnrAdaptRate);
        default: return '';
    }
}

/**
 * The popup a change between two receiver snapshots deserves, or null. Only
 * the changes the LCD otherwise shows poorly: a step of 500 Hz and one of
 * 100 Hz underline the same digit, mute and lock have no words of their own.
 * Mode and VFO have annunciators, and the frequency is already the display.
 */
export function changePopup(prev, rx) {
    if (!prev || !rx) return null;
    if (prev.stepHz !== rx.stepHz && rx.stepHz) return 'step';
    if (!!prev.muted !== !!rx.muted) return 'mute';
    if (!!prev.locked !== !!rx.locked) return 'lock';
    if (!!prev.dspEnabled !== !!rx.dspEnabled || (rx.dspEnabled && prev.dspFilter !== rx.dspFilter)) return 'nr';
    if (!!prev.nbEnabled !== !!rx.nbEnabled) return 'nb';
    if (!!prev.cnrEnabled !== !!rx.cnrEnabled || (rx.cnrEnabled && prev.cnrType !== rx.cnrType)) return 'cnr';
    return null;
}

// What a mapped function's popup is, so a small knob shows what it is actually
// mapped to rather than what its page is called: E1's NR page remapped to the
// blanker threshold says "NB TH 19", not the NR filter. A function with no
// entry shows nothing — its page label is still lit, and a wrong number would
// be worse than none.
const FUNCTION_POPUP = {
    volume_up: 'vol',
    volume_down: 'vol',
    volume_set: 'vol',
    squelch_set: 'sql',
    squelch_toggle: 'sql',
    squelch_auto: 'sql',
    dsp_toggle: 'nr',
    dsp_next: 'nr',
    dsp_prev: 'nr',
    nr_toggle_any: 'nrany',
    nr_next_any: 'nrany',
    nr_prev_any: 'nrany',
    bw_high: 'high',
    bw_low: 'low',
    bw_shift: 'shift',
    filter_reset: 'high',
    nb_toggle: 'nb',
    nb_threshold: 'nbthr',
    nb_width: 'nbwidth',
    cnr_toggle: 'cnr',
    cnr_next: 'cnr',
    cnr_prev: 'cnr',
    cnr_strength: 'cnrstr',
    cnr_makeup: 'cnrmakeup',
    cnr_floor: 'cnrfloor',
    cnr_adapt: 'cnradapt',
};

export function functionPopup(fnId) {
    const id = String(fnId || '');
    if (FUNCTION_POPUP[id]) return FUNCTION_POPUP[id];
    if (id.startsWith('dsp_select_')) return 'nr';
    if (id.startsWith('cnr_select_')) return 'cnr';
    return null;
}

function hexRgb(hex) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

// lib/format.js gives the meter colour as `hsl(h, s%, l%)`.
function hslRgb(css) {
    const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(css || '');
    if (!m) return [255, 255, 255];
    const h = Number(m[1]) / 360;
    const sat = Number(m[2]) / 100;
    const lum = Number(m[3]) / 100;
    const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat;
    const p = 2 * lum - q;
    const hue = (t) => {
        let x = t;
        if (x < 0) x += 1;
        if (x > 1) x -= 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
    };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255));
}

// How far the backlight drops while the receiver is down.
const DIM = 0.25;

/**
 * The frame for this moment. `rx` is the receiver snapshot (see ControlWatch):
 *
 *   frequency, mode, stepHz          what is tuned, and by how much a click moves it
 *   dbfs, snr                        the signal, or null before a reading
 *   audioUp                          the receiver's audio stream is open
 *   squelchOn, squelchOpen, squelchDb
 *   muted, volume (0..1), locked
 *   bwLow, bwHigh                    passband edges, Hz
 *   vfo                              'A'..'D', the VFO in use
 *   dspEnabled, dspFilter            the receiver's NR on, and which filter
 *   dspAvailable                     the receiver offers NR filters at all
 *   nbEnabled, nbThresholdDb, nbWidthMs
 *                                    the client noise blanker
 *   cnrEnabled, cnrType, cnrStrength, cnrMakeupDb, cnrFloor, cnrAdaptRate
 *                                    the client NR ('lsa' | 'nr2' | 'rmn')
 *   iq                               IQ mode, where the client stage is bypassed
 *
 * `ui` is the driver's: { e1Page, e2Page, popup, blinkOn }. The click bit is
 * the driver's too and is left 0 here.
 */
export function renderTm2({ rx, settings, ui }) {
    const f = newFrame();
    const s = tm2Settings(settings);
    const r = rx || {};
    const u = ui || {};
    const up = !!r.audioUp;
    const blinkOn = u.blinkOn !== false;

    // Main display: the frequency, or a popup over it.
    if (u.popup) {
        displayMainText(f, popupText(u.popup, r));
        if (FIXED3.has(u.popup)) setField(f, 'dot2', 1);
    } else if (Number.isFinite(Number(r.frequency)) && r.frequency !== null) {
        displayMainNumber(f, Number(r.frequency));
        // TM-2 UNVERIFIED: the photograph shows "Hz" lit beside the digits;
        // k, mw_m and mw_w are presumably the rest of kHz / MHz and are left
        // dark, since the digits are always Hz.
        setField(f, 'hz', 1);
        const d = stepDigit(r.stepHz);
        if (d) setField(f, `underline_${d}`, 1);
    } else {
        displayMainText(f, '');
    }

    // Mode.
    for (const name of ALL_MODE_FIELDS) setField(f, name, 0);
    for (const name of MODE_FIELDS[r.mode] || []) setField(f, name, 1);

    // S-meter: the printed scale always, the bar on v2's own S-unit scale.
    // TM-2 UNVERIFIED: the bar's 15 segments are taken to sit at S1..S9 then
    // +10..+60, so segment n is S-unit n — which is where v2 puts S1 S3 S5 S7
    // S9 +20 +40 +60 (units 1, 3, 5 … 15), the very labels printed under it.
    setSmeterGraph(f, true);
    setSmeterS(f, true);
    // -998 and below is v2's "no reading" (lib/format.js), not a signal.
    const level = up && r.dbfs != null && Number.isFinite(Number(r.dbfs)) && Number(r.dbfs) > -998
        ? Number(r.dbfs) : null;
    setBars(f, level === null ? 0 : Math.floor(dbfsToSUnits(level)));
    let readout = 1000;     // blank
    if (up && s.readout === 'snr' && r.snr != null && Number.isFinite(Number(r.snr))) readout = Number(r.snr);
    else if (up && (s.readout === 'dbm' || s.readout === 'dbfs') && level !== null) readout = level;
    displaySmeterNumber(f, readout);
    setField(f, 'dbm', s.readout === 'dbm' && readout !== 1000 ? 1 : 0);

    // Status.
    // RX: something is coming out of the speakers — the stream is up and the
    // squelch, if any, is letting it through.
    setField(f, 'rx', up && (!r.squelchOn || r.squelchOpen) ? 1 : 0);
    setField(f, 'tx', 0);
    // TM-2 UNVERIFIED: ERR read as "the receiver is not working", which a
    // dropped stream is.
    setField(f, 'err', !up && s.blinkWhenDown ? 1 : 0);
    // VFO A or B, as the photograph's "VFO B". The LCD has no C or D, so those
    // show VFO alone.
    if (r.vfo) {
        setField(f, 'vfo', 1);
        setField(f, 'a', r.vfo === 'A' ? 1 : 0);
        setField(f, 'b', r.vfo === 'B' ? 1 : 0);
    }

    // The client noise stage: NB the blanker, NR2 the client NR — "the second
    // NR", beside the receiver's. Dark in IQ, where the player bypasses both
    // (AudioPlayer.setIQ): lit would claim a cut nobody is getting.
    // TM-2 UNVERIFIED: NB and NR2 are taken to be status labels. If the
    // segment cycle shows NR, NB and AN are one row of them, NR is not E1's
    // page label either and the page display wants another home.
    setField(f, 'nb', r.nbEnabled && !r.iq ? 1 : 0);
    setField(f, 'nr2', r.cnrEnabled && !r.iq ? 1 : 0);

    // The small knobs: both boxes, and the label of the page each is on. Volume
    // blinks while muted, so a dead knob says why.
    setField(f, 'e1', 1);
    setField(f, 'e2', 1);
    for (const name of PAGE_FIELDS) setField(f, name, 0);
    const e1 = E1_PAGES.includes(u.e1Page) ? u.e1Page : E1_PAGES[0];
    const e2 = E2_PAGES.includes(u.e2Page) ? u.e2Page : E2_PAGES[0];
    setField(f, e1, e1 === 'vol' && r.muted && !blinkOn ? 0 : 1);
    setField(f, e2, 1);

    // LEDs, as the manual has them: green "the TMate 2 is operating", red
    // "Tune Lock". Green blinks while the receiver is down, as the RC-28's Link
    // does.
    setField(f, 'usb_led', !up && s.blinkWhenDown ? (blinkOn ? 1 : 0) : 1);
    setField(f, 'lock_led', r.locked ? 1 : 0);

    // Backlight and contrast.
    let rgb = hexRgb(s.backlight);
    if (s.meterColour && level !== null) rgb = hslRgb(sMeterColour(level));
    if (s.dimWhenDown && !up) rgb = rgb.map((v) => Math.round(v * DIM));
    setRgb(f, ...rgb);
    setField(f, 'contrast', s.contrast);

    const [s1, s2, s3] = ACCEL[s.accel];
    encoderSetup(f, s1, s2, s3, TRANS12, TRANS23, TRANS_TIME);
    return f;
}

