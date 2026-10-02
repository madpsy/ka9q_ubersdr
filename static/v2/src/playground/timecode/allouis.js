// ALS162 (Allouis, formerly TDF) 162 kHz: phase modulation only — a port of
// ubersdr-ntp's AllouisDecoder (src/clock/AllouisDecoder.cpp), constant for
// constant.
//
// The broadcast, per ITU-R TF.2487 §9.1 and in detail from henningM1r's
// gr_ALS162_Receiver (GPLv3), whose tables are used here:
//
//   Data    every second but 59 starts with a phase excursion of +1 rad and
//           −1 rad in 100 ms: ramps of 25 ms, 0 → +1 → 0 → −1 → 0 rad. A
//           binary 1 sends it twice (0–200 ms); a 0 once, then 100 ms of
//           nothing. Second 59 has none: the minute marker.
//   Code    from 200 to 900 ms, a pseudo-random sequence of ramps of 0, ±1 and
//           ±2 rad per 25 ms, different for every second and returning to 0;
//           second 59's is empty. 900–1000 ms is always unmodulated.
//   Time    BCD LSB first, DCF77's layout from second 20, even parity 28, 35,
//           58. Before that: 0 always 0, 1/2 leap second warning, 3–6 the
//           count of 1s in 21–58 (weights 2, 4, 8, 16), 17/18 CEST/CET, 20
//           always 1. French legal time, naming the minute that BEGINS at the
//           next minute mark.
//
// Timing is a correlation of the whole second's known phase — the data
// excursion(s) and that second's position code — against the received phase,
// so the second is timed by 700 ms and more of known modulation, not by an
// amplitude edge. Everything is counted from the excursion's start, which is
// 50.48 ms BEFORE the second (measured against DCF77 and a GPS-disciplined
// stratum 1; nothing published says where). The edge reported is the second
// itself: the excursion's start plus 50.48 ms.
//
// Chain, per input sample of complex baseband at 12 kHz:
//
//   carrier search (once)  as DCF77: DFT bins across ±20 Hz, the peak refined;
//                          the mixer goes there and follows after, except
//                          while the carrier is gone (Allouis is off air every
//                          Tuesday morning).
//   phase                  y = Im(z·conj(r)) / |r|², r a 1 Hz one-pole of z,
//                          kept in a ring: acquisition's. Each second is timed
//                          on its own phase against a reference drawn from the
//                          quiet 900–1000 ms either side of it.
//
// Acquisition folds y at 1 kHz over six seconds and correlates the fold with
// the excursion every second but one starts with: that finds the second and
// which way round the phase reads. Then once per second, when its quiet tail
// is in: read the excursions, name the second by its position code, time it,
// sync, and at second 59 decode the minute.

import { TimeFrameVoter, WWVB_MAP, syntheticFrame } from './voter.js';
import {
    lround, clamp, LOCK, checkRate, CarrierSearch, LiveTone,
    decodeLegalMinute, leapSecondPossibleUtc, composeUtc, armPlausibility,
} from './pmcommon.js';

// ---- the broadcast -------------------------------------------------------
const kSubSec = 0.025;     // one ramp
const kCodeSubs = 32;      // 200–1000 ms
const kCodeStart = 0.200;
// The unmodulated stretch every second ends with, less 5 ms each side.
const kQuietFrom = 0.905;
const kQuietTo = 0.995;
// Where the second is: 50.48 ms after the excursion starts — close to its
// midpoint, the zero crossing between +1 and −1 rad, but not on it. Measured
// on M9PSY-1 against DCF77's phase modulation and against a GPS-disciplined
// stratum 1 (AllouisDecoder.cpp). Only what is reported is moved by it.
export const ALS162_SECOND_AFTER_START_SEC = 0.05048;
const kSecondAfterStartSec = ALS162_SECOND_AFTER_START_SEC;

// The position codes, per henningM1r/gr_ALS162_Receiver (GPLv3),
// python/ALS162_codes.py: the phase's change over each 25 ms of 200–1000 ms,
// in radians. Indexed by the second each is SENT in — the model's key for
// second s is s + 1 — as confirmed on the air. Copied verbatim from the C++.
export const ALS162_CODES = [
    [ 0,+1,-1, 0, 0, 0,+1,-1, 0, 0, 0, 0, 0, 0, 0,-1, 0,+2, 0,-2, 0,+2, 0,-2, 0,+1, 0, 0, 0, 0, 0, 0],   // s00 (key "01")
    [+1, 0,-2, 0,+2,-1,-1,+1,+1,-1,-1,+1, 0,+1, 0,-2,+1, 0, 0,+1,-2, 0,+1, 0,+1,-1,-1,+1, 0, 0, 0, 0],   // s01 (key "02")
    [+1,-1, 0, 0,-1,+2, 0,-1,-1, 0,+2,-1,-1,+2, 0,-1,-1, 0,+2,-1,-1,+2, 0,-1,-1, 0,+1, 0, 0, 0, 0, 0],   // s02 (key "03")
    [+1,-1,-1,+1,+1, 0,-1,-1,+1, 0,-1,+1, 0, 0, 0,+1, 0,-2,+1,+1,-1,-1, 0,+1,+1,-1,-1,+1, 0, 0, 0, 0],   // s03 (key "04")
    [+1,-1, 0,+1,-2, 0,+1, 0,+1, 0,-1,-1, 0,+2, 0,-1,-1, 0,+1,+1,-1,-1,+2,-1,-1,+1, 0, 0, 0, 0, 0, 0],   // s04 (key "05")
    [+1,-1,-1,+1,+1, 0,-1,-1, 0,+1, 0,+1, 0,-2, 0,+2, 0,-2,+1,+1,-1,-1, 0,+2,-1,-1,+1, 0, 0, 0, 0, 0],   // s05 (key "06")
    [ 0, 0, 0, 0,+1, 0,-1, 0,-1, 0,+1,+1, 0,-1,-1,+1, 0, 0, 0,-1,+1,+1, 0,-1,-1, 0,+1, 0, 0, 0, 0, 0],   // s06 (key "07")
    [ 0, 0,+1, 0,-1, 0, 0, 0, 0,-1, 0,+1, 0, 0, 0, 0, 0, 0, 0, 0, 0,+1,-1,-1,+2,-1,-1,+1, 0, 0, 0, 0],   // s07 (key "08")
    [+1,-1, 0,+1,-2,+1, 0,-1,+1,+1,-1,-1,+1,+1, 0,-1,-1, 0,+1,+1, 0,-1,-1, 0,+1, 0, 0, 0, 0, 0, 0, 0],   // s08 (key "09")
    [ 0,+1, 0,-1,-1, 0,+1,+1, 0,-1,-1, 0,+2,-1,-1,+1,+1, 0,-1,-1,+1,+1,-2, 0,+1, 0, 0, 0, 0, 0, 0, 0],   // s09 (key "10")
    [ 0,+1, 0,-1,-1,+1,+1,-2,+1, 0,-1,+1, 0,+1,-1, 0,+1,-1, 0,-1, 0,+2,-1, 0, 0,-1,+1, 0, 0, 0, 0, 0],   // s10 (key "11")
    [ 0,+1, 0,-1, 0, 0,-1, 0,+2,-1,-1,+1,+1, 0,-1, 0,-1, 0,+1, 0, 0, 0, 0, 0,+1,-1,-1,+1, 0, 0, 0, 0],   // s11 (key "12")
    [+1,-1,-1,+2, 0,-1,-1, 0,+1,+1,-1, 0,+1,-2, 0,+1,+1,-1,-1,+1, 0, 0,+1, 0,-1,-1, 0,+1, 0, 0, 0, 0],   // s12 (key "13")
    [+1, 0,-2,+1,+1,-2,+1, 0,-1,+2, 0,-2, 0,+1,+1,-1, 0, 0,-1,+1,+1,-1,-1,+2, 0,-2, 0,+1, 0, 0, 0, 0],   // s13 (key "14")
    [ 0,+1,-1,-1,+1,+1, 0,-1, 0,-1, 0,+2, 0,-1, 0,-1, 0,+2,-1, 0,+1,-2, 0,+2,-1,-1,+1, 0, 0, 0, 0, 0],   // s14 (key "15")
    [ 0, 0,+1, 0,-2,+1,+1,-1, 0, 0,-1,+1, 0,-1,+1, 0, 0, 0, 0,+1, 0,-2,+1,+1,-1,-1, 0,+1, 0, 0, 0, 0],   // s15 (key "16")
    [+1, 0,-2, 0,+2,-1, 0,+1,-1, 0, 0,-1,+1,+1,-1, 0, 0,-1,+1,+1,-2,+1,+1,-2, 0,+1, 0, 0, 0, 0, 0, 0],   // s16 (key "17")
    [+1,-1, 0,+1,-2, 0,+2,-1, 0,+1,-1, 0, 0,-1, 0,+2, 0,-1, 0,-1,+1, 0,-1,+1, 0, 0, 0, 0, 0, 0, 0, 0],   // s17 (key "18")
    [+1, 0,-1, 0,-1, 0,+1,+1,-1, 0,+1,-2, 0,+2,-1,-1,+1, 0, 0,+1,-1,-1,+1, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // s18 (key "19")
    [+1,-1,-1,+1, 0,+1, 0,-2, 0,+1, 0,+1,-1, 0,+1,-2, 0,+2,-1, 0,+1,-2, 0,+2,-1,-1,+1, 0, 0, 0, 0, 0],   // s19 (key "20")
    [ 0, 0,+1,-1,-1,+2,-1, 0,+1,-1, 0,-1, 0,+1,+1,-1, 0,+1,-2,+1,+1,-1, 0,-1, 0,+1, 0, 0, 0, 0, 0, 0],   // s20 (key "21")
    [+1,-1,-1,+2,-1, 0, 0,-1,+1, 0,+1, 0,-1,-1, 0,+2, 0,-2, 0,+2, 0,-1, 0,-1,+1, 0,-1,+1, 0, 0, 0, 0],   // s21 (key "22")
    [ 0, 0, 0, 0,+1, 0,-1, 0, 0, 0, 0, 0,-1,+1,+1,-2,+1, 0, 0,+1,-1,-1, 0,+2, 0,-2, 0,+1, 0, 0, 0, 0],   // s22 (key "23")
    [ 0, 0, 0, 0,+1,-1, 0, 0, 0,+1,-2,+1, 0,-1,+2, 0,-1,-1,+1,+1,-2,+1,+1,-1, 0,-1, 0,+1, 0, 0, 0, 0],   // s23 (key "24")
    [+1, 0,-2, 0,+1, 0, 0, 0,+1, 0,-2, 0,+2, 0,-1, 0, 0,-1,+1, 0, 0,+1,-2,+1,+1,-2, 0,+1, 0, 0, 0, 0],   // s24 (key "25")
    [+1,-1, 0,+1,-2, 0,+2,-1, 0, 0, 0,+1,-2, 0,+2,-1,-1,+1, 0,+1,-1, 0,+1,-1,-1, 0,+1, 0, 0, 0, 0, 0],   // s25 (key "26")
    [+1, 0,-2, 0,+1,+1,-1,-1,+1, 0,+1, 0,-2, 0,+2, 0,-1,-1,+1, 0,-1,+1,+1, 0,-2, 0,+1, 0, 0, 0, 0, 0],   // s26 (key "27")
    [+1, 0,-1,-1,+1,+1,-2,+1, 0, 0,+1,-2, 0,+1, 0,+1,-1,-1,+2, 0,-1, 0,-1,+1,+1,-2, 0,+1, 0, 0, 0, 0],   // s27 (key "28")
    [ 0,+1,-1,-1,+2, 0,-2, 0,+2, 0,-1, 0, 0, 0, 0,-1, 0,+2,-1,-1,+1, 0,+1,-1,-1,+1, 0, 0, 0, 0, 0, 0],   // s28 (key "29")
    [+1, 0,-2, 0,+2,-1,-1,+1, 0,+1, 0,-2, 0,+2, 0,-2,+1, 0, 0,+1,-2, 0,+1,+1, 0,-2, 0,+1, 0, 0, 0, 0],   // s29 (key "30")
    [ 0,+1,-1, 0,+1,-2, 0,+1,+1, 0,-2,+1,+1,-1, 0,-1, 0,+2, 0,-1,-1, 0,+2,-1,-1,+1, 0, 0, 0, 0, 0, 0],   // s30 (key "31")
    [ 0, 0,+1, 0,-2,+1,+1,-1,-1, 0,+1,+1, 0,-2, 0,+1, 0, 0, 0,+1, 0,-2,+1, 0, 0, 0,-1,+1, 0, 0, 0, 0],   // s31 (key "32")
    [+1, 0,-1, 0,-1,+1, 0,-1,+1, 0, 0,+1,-1, 0,+1,-1, 0, 0, 0,-1, 0,+1,+1, 0,-2, 0,+1, 0, 0, 0, 0, 0],   // s32 (key "33")
    [ 0, 0, 0, 0,+1, 0,-2, 0,+2,-1,-1,+2, 0,-1, 0, 0, 0,-1,+1,+1,-1, 0, 0, 0,-1, 0,+1, 0, 0, 0, 0, 0],   // s33 (key "34")
    [ 0, 0, 0,+1, 0,-1, 0, 0,-1, 0,+1, 0,+1, 0,-2,+1, 0, 0,+1,-1, 0,-1, 0,+1,+1,-1,-1,+1, 0, 0, 0, 0],   // s34 (key "35")
    [+1,-1, 0,+1,-1, 0, 0, 0,-1, 0,+2,-1, 0, 0, 0, 0,-1,+1, 0, 0, 0,+1,-1, 0, 0,-1,+1, 0, 0, 0, 0, 0],   // s35 (key "36")
    [+1,-1,-1,+1, 0,+1,-1,-1,+1,+1,-1,-1,+1, 0,+1, 0,-2,+1, 0, 0,+1,-1,-1, 0,+1, 0, 0, 0, 0, 0, 0, 0],   // s36 (key "37")
    [ 0,+1, 0,-2,+1,+1,-1, 0, 0, 0,-1, 0,+2,-1,-1,+1,+1, 0,-2, 0,+1,+1,-1,-1,+1, 0, 0, 0, 0, 0, 0, 0],   // s37 (key "38")
    [ 0,+1, 0,-1,-1,+1,+1,-2, 0,+2,-1,-1,+1,+1,-1, 0,+1,-1, 0,-1, 0,+2,-1,-1,+1, 0, 0, 0, 0, 0, 0, 0],   // s38 (key "39")
    [ 0,+1, 0,-1, 0, 0,-1, 0,+2,-1,-1,+1,+1,-1,-1,+1,+1, 0,-1, 0, 0, 0, 0, 0,-1, 0,+1, 0, 0, 0, 0, 0],   // s39 (key "40")
    [ 0,+1, 0,-1,-1,+1,+1,-2,+1,+1,-1, 0,-1, 0,+2,-1,-1,+1, 0,+1, 0,-2,+1, 0,-1,+1, 0, 0, 0, 0, 0, 0],   // s40 (key "41")
    [+1, 0,-1,-1,+1, 0,-1,+2, 0,-1,-1,+1,+1,-2, 0,+2,-1,-1,+2, 0,-2, 0,+2, 0,-1,-1, 0,+1, 0, 0, 0, 0],   // s41 (key "42")
    [+1, 0,-1, 0,-1, 0,+2, 0,-2, 0,+2,-1, 0,+1,-1, 0, 0, 0, 0,-1,+1, 0,-1,+1,+1,-1,-1,+1, 0, 0, 0, 0],   // s42 (key "43")
    [ 0,+1,-1,-1,+2, 0,-2, 0,+2,-1, 0, 0, 0, 0, 0,+1,-2,+1, 0,-1,+1, 0, 0, 0,+1,-1,-1,+1, 0, 0, 0, 0],   // s43 (key "44")
    [ 0,+1, 0,-1, 0, 0,-1,+1,+1,-2,+1, 0,-1,+2, 0,-2, 0,+1, 0, 0, 0, 0, 0,+1,-1,-1,+1, 0, 0, 0, 0, 0],   // s44 (key "45")
    [+1,-1,-1,+1,+1,-1,-1,+2, 0,-2, 0,+2,-1,-1,+1,+1, 0,-2,+1,+1,-2, 0,+2, 0,-2, 0,+1, 0, 0, 0, 0, 0],   // s45 (key "46")
    [ 0, 0,+1, 0,-2, 0,+1, 0,+1, 0,-2,+1, 0,-1,+2,-1, 0,+1,-1,-1,+1,+1,-2,+1,+1,-2, 0,+1, 0, 0, 0, 0],   // s46 (key "47")
    [+1, 0,-1,-1,+1, 0, 0,+1,-2,+1, 0,-1,+2, 0,-2,+1, 0,-1,+2, 0,-2,+1, 0, 0,+1,-2, 0,+1, 0, 0, 0, 0],   // s47 (key "48")
    [+1,-1,-1,+2,-1,-1,+2, 0,-2, 0,+2, 0,-1, 0, 0, 0,-1,+1,+1,-2,+1, 0,-1,+1,+1,-1,-1,+1, 0, 0, 0, 0],   // s48 (key "49")
    [ 0, 0,+1, 0,-2, 0,+1, 0,+1,-1, 0, 0, 0, 0, 0,+1,-1, 0, 0,-1,+1,+1,-1, 0,-1, 0,+1, 0, 0, 0, 0, 0],   // s49 (key "50")
    [+1,-1,-1,+1, 0, 0, 0,+1,-1, 0,+1,-1,-1, 0,+2, 0,-2,+1, 0, 0, 0,-1,+1, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // s50 (key "51")
    [+1, 0,-1,-1,+1,+1,-1, 0, 0, 0, 0,-1,+1, 0,-1,+2,-1,-1,+2, 0,-1,-1,+1,+1,-1,-1, 0,+1, 0, 0, 0, 0],   // s51 (key "52")
    [ 0,+1, 0,-1,-1, 0,+2, 0,-2, 0,+1,+1,-1,-1,+1,+1, 0,-1, 0,-1,+1, 0,-1,+1,+1,-1,-1,+1, 0, 0, 0, 0],   // s52 (key "53")
    [+1, 0,-1,-1, 0,+1,+1, 0,-2,+1, 0, 0, 0, 0, 0, 0, 0,-1,+2,-1, 0, 0, 0, 0,-1,+1, 0, 0, 0, 0, 0, 0],   // s53 (key "54")
    [ 0, 0,+1,-1, 0,+1,-2, 0,+2,-1,-1,+2,-1, 0, 0, 0, 0,-1,+2, 0,-1, 0,-1,+1, 0,-1,+1, 0, 0, 0, 0, 0],   // s54 (key "55")
    [ 0, 0, 0, 0, 0, 0, 0,+1,-1,-1,+2, 0,-2, 0,+1, 0, 0,+1,-1, 0, 0,-1,+2,-1, 0, 0,-1,+1, 0, 0, 0, 0],   // s55 (key "56")
    [ 0, 0,+1, 0,-2,+1, 0, 0,+1,-1,-1,+1, 0, 0,+1,-2,+1,+1,-1,-1, 0,+1, 0,+1, 0,-2, 0,+1, 0, 0, 0, 0],   // s56 (key "57")
    [+1, 0,-1, 0,-1,+1, 0,-1,+2,-1,-1,+2,-1,-1,+2,-1, 0,+1,-1,-1, 0,+1, 0, 0,+1,-1,-1,+1, 0, 0, 0, 0],   // s57 (key "58")
    [+1, 0,-2, 0,+2, 0,-2, 0,+2, 0,-2, 0,+2, 0,-2, 0,+2, 0,-2, 0,+1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // s58 (key "59")
    [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // s59 (key "00")
];

// ---- carrier search (as DCF77) -------------------------------------------
const kPullHz = 3.0;       // 20 ppm is 3.2 Hz at 162 kHz

// ---- carrier reference ---------------------------------------------------
const kRefHz = 1.0;
const kFreqGain = 0.2;
// The carrier counts as gone below this fraction of its usual level, and the
// mixer is not followed then.
const kCarrierGone = 1.0 / 3.0;

// ---- acquisition ---------------------------------------------------------
const kFoldRateHz = 1000;
const kAcqSeconds = 6;     // seconds folded before the excursion is looked for
// The fold's peak over the best peak elsewhere, and folds running that must
// agree on where it is.
const kAcqRatio = 1.25;
const kAcqAgree = 2;
// Seconds running, carrier present, in which no second has named itself by
// its position code: the phase is wrong, and the second is looked for again.
const kMaxUnnamedSeconds = 30;

// ---- timing --------------------------------------------------------------
// Lags searched either side of the tracker's prediction, while it settles and
// once it has.
const kSearchSec = 0.004;
const kSearchWarmSec = 0.0015;
// A second's correlation must stand this far above its own noise to time it.
const kTimeMinSig = 5.0;

// Edge tracker: as MsfDecoder's (its gain follows its own residuals).
const kTrkAlpha = 1.0 / 8.0;
const kTrkAlphaMin = 1.0 / 32.0;
const kTrkNoiseRefSec = 0.0001;
const kTrkWarm = 8;
const kTrkOutlierSec = 0.002;
const kTrkAcqOutlierSec = 0.010;

// Seconds with nothing timed before the second is looked for again.
const kMaxBlindSeconds = 60;

// ---- symbols & sync ------------------------------------------------------
// Confidences are z-scores mapped (z − 1)/5, as the other decoders'.
const kStructConf = 0.50;
const kBitMinConf = 0.05;
// A second is named by its position code when the best code scores this many
// σ, and beats the next best by kKeyMarginSig.
const kKeyMinSig = 6.0;
const kKeyMarginSig = 4.0;
const kMaxUnconfirmedMinutes = 2;
// Unread bits a minute may have and still be decoded, filled in by its checks.
const kMaxErasures = 2;
// The excursion's amplitude, learnt: the fraction taken each second.
const kAmpGain = 0.05;
// A minute is confirmed when this many of its 59 coded seconds named
// themselves as expected and none clearly named another.
const kConfirmMatches = 30;

/** The data excursion's phase t seconds into it (0 outside 0–100 ms). */
export function excursion(t) {
    if (t < 0 || t >= 4 * kSubSec) return 0;
    const u = t / kSubSec;             // 0..4
    if (u < 1) return u;               // 0 → +1
    if (u < 3) return 2 - u;           // +1 → −1
    return u - 4;                      // −1 → 0
}

/** Second s's position code's phase t seconds into the second. */
export function codePhase(s, t) {
    if (t < kCodeStart || t >= kCodeStart + kCodeSubs * kSubSec) return 0;
    const u = (t - kCodeStart) / kSubSec;
    const k = Math.trunc(u);
    const c = ALS162_CODES[s];
    let ph = 0;
    for (let i = 0; i < k; i++) ph += c[i];
    return ph + c[k] * (u - k);
}

// The edge tracker, as MsfDecoder's: its gain falls as its own residuals rise
// past a reference, so a noisy second moves it less.
class EdgeTracker {
    constructor() { this.noiseRef = 1.0; this.edge = 0; this.period = 0; this.reset(); }

    reset() { this.valid = false; this.count = 0; this.outliers = 0; this.resVar = 0; }

    alpha() {
        const rms = Math.sqrt(this.resVar);
        if (!(rms > this.noiseRef)) return kTrkAlpha;
        return Math.max(kTrkAlphaMin, (kTrkAlpha * this.noiseRef) / rms);
    }

    update(measured, raw, nominal, tol) {
        if (!this.valid) {
            if (!measured) return;
            this.edge = raw; this.period = nominal; this.valid = true; this.count = 1; this.outliers = 0;
            return;
        }
        const pred = this.edge + this.period;
        if (!measured) { this.edge = pred; return; }
        const r = raw - pred;
        if (Math.abs(r) > tol) {
            if (++this.outliers >= 3) {
                this.edge = raw; this.period = nominal; this.count = 1; this.outliers = 0; this.resVar = 0;
            } else this.edge = pred;
            return;
        }
        this.outliers = 0;
        ++this.count;
        this.resVar += (this.count <= 16 ? 1.0 / this.count : 1.0 / 16.0) * (r * r - this.resVar);
        const a = this.alpha();
        this.edge = pred + Math.max(1.0 / this.count, a) * r;
        if (this.count > kTrkWarm) {
            this.period = clamp(this.period + 0.5 * a * a * r, nominal * (1.0 - 2e-4), nominal * (1.0 + 2e-4));
        }
    }
}

// One second, read.
const emptyRec = () => ({
    edge: 0, edgeExact: NaN, read: false,
    marker: false, markConf: 0,     // no data excursion: second 59
    bit: 0, bitConf: 0,
    key: -1, keySig: 0,             // the second its position code names, −1 if none clearly
    expSig: 0,                      // the expected second's code's score, σ (anchored)
    timeSig: 0,                     // the timing correlation's SNR
});

const confOfZ = (z) => Math.fround(clamp((z - 1.0) / 5.0, 0, 1));

export class AllouisDecoder {
    constructor({ sampleRate = 12000, carrierOffsetHz = 0, referenceNow = null } = {}) {
        checkRate(sampleRate, 'AllouisDecoder');
        const sr = sampleRate;
        this.sr = sr;
        this.fNominal = carrierOffsetHz;
        this.search = new CarrierSearch(this.fNominal, sr, { pullHz: kPullHz });
        this.live = new LiveTone(sr);

        let cap = 1;
        while (cap < 4 * sr) cap <<= 1;
        this.yRing = new Float32Array(cap);
        this.zRe = new Float32Array(cap);
        this.zIm = new Float32Array(cap);
        this.yMask = cap - 1;
        this.yLoc = new Float32Array(0);
        this.yLocBase = 0;

        // Templates at the input rate: sin of the phase, as y is. Sample n of
        // a template is the instant n / sr into its span.
        this.nData = lround(4 * kSubSec * sr);
        this.tri = new Float32Array(this.nData);
        for (let n = 0; n < this.nData; n++) this.tri[n] = Math.sin(excursion(n / sr));
        this.triE = 0;
        for (const v of this.tri) this.triE += v * v;
        this.codeOff = lround(kCodeStart * sr);
        this.nCode = lround(kCodeSubs * kSubSec * sr);
        this.codeT = [];
        this.codeE = new Float64Array(60);
        for (let s = 0; s < 60; s++) {
            const c = new Float32Array(this.nCode);
            let e = 0;
            for (let n = 0; n < this.nCode; n++) {
                const v = Math.sin(codePhase(s, kCodeStart + n / sr));
                c[n] = v;
                e += v * v;
            }
            this.codeT.push(c);
            this.codeE[s] = e;
        }

        // The fold, at 1 kHz: one excursion's template there, at bin centres.
        this.foldDecim = Math.max(1, Math.round(sr / kFoldRateHz));
        this.foldLen = Math.round(sr / this.foldDecim);
        const nTriD = lround((4 * kSubSec * sr) / this.foldDecim);
        this.triD = new Float64Array(nTriD);
        for (let i = 0; i < nTriD; i++) this.triD[i] = Math.sin(excursion(((i + 0.5) * this.foldDecim) / sr));

        this.voter = new TimeFrameVoter({ fields: WWVB_MAP, minBitConfidence: 0.05, minLockQuality: 0.05 });
        armPlausibility(this.voter, referenceNow);
        this.trk = new EdgeTracker();
        this.reset();
    }

    // ---- the interface ---------------------------------------------------

    process(re, im, n) {
        for (let i = 0; i < n; i++) {
            ++this.samples;
            if (this.searching) this._feedAcquisition(re[i], im[i]);
            else this._feedSteady(re[i], im[i]);
        }
    }

    reset() {
        this.events = [];
        this.searching = true;
        this.search.clear();
        this.live.clear();
        this.lastToneSnrDb = null;
        this.f0 = this.fNominal;
        this.oscRe = 1; this.oscIm = 0; this.oscRenorm = 0;
        this.stepRe = 1; this.stepIm = 0;
        this.aRef = 0;
        this.refRe = 0; this.refIm = 0; this.freqCount = 0; this.freqPrevRe = 0; this.freqPrevIm = 0;
        this.carrierLevel = 0;
        this.carrierPresent = true;
        this.yRing.fill(0);
        this.yStart = 0;
        this.trk.noiseRef = 1.0;
        this._restartAcquisition();
        this.polarity = 1;
        this.amp = 1.0; this.ampHave = false;
        this.lastTimeSig = 0;
        this.timing = false;
        this.hist = [];
        this.voter.reset();
        this._dropAnchor();
        this.haveLastFrame = false; this.lastFrameStart = 0;
        this.lastFrameFrom = 0;
        this.lastErasures = 0;
        this.timeFrameStart = 0; this.haveTimeFrame = false;
        this.frames = 0;
        this.samples = 0;
        this.lockState = LOCK.NOSIGNAL;
    }

    drain() {
        const out = this.events;
        this.events = [];
        return out;
    }

    status() {
        const v = this.voter.verdict();
        return {
            state: this.lockState,
            station: 'ALS162',
            snrDb: this.lastToneSnrDb,
            carrierOffsetHz: this.searching ? null : this.f0,
            refusal: this.lockState === LOCK.LOCKED ? '' : v.reason,
            frames: this.voter.frameCount(),
            detail: {
                carrierFound: !this.searching,
                carrierPresent: this.carrierPresent,
                toneSnrDb: this.lastToneSnrDb,
                segmented: this.segValid,
                anchored: this.anchored,
                pmLocked: this.segValid && this.trk.valid,
                pmSnrDb: this.lastTimeSig > 0 ? 20 * Math.log10(this.lastTimeSig) : null,
                timing: this.timing,
                polarity: this.polarity,
                excursionAmp: this.ampHave ? this.amp : null,
                unnamedRun: this.unnamedRun,
                lastFrameFrom: this.lastFrameFrom === 2 ? 'PM' : 'none',
                erasures: this.lastErasures,
                framesDecoded: this.frames,
                voteQuality: this.voter.lockConfidence(),
                windowSize: this.voter.cfg.window,
            },
        };
    }

    _restartAcquisition() {
        this.segValid = false;
        this.segEdge = 0;
        this.trk.reset();
        this.blindSeconds = 0;
        this.foldAcc = 0; this.foldCount = 0; this.foldPos = 0;
        this.foldSlots = Array.from({ length: kAcqSeconds }, () => new Float64Array(this.foldLen));
        this.foldCur = new Float64Array(this.foldLen);
        this.foldSlotsN = 0; this.foldSlotNext = 0;
        this.foldBlockStart = -1;
        this.acqAgree = 0; this.acqLast = -1; this.acqSign = 1;
        this.foldFresh = 0;
        this.unnamedRun = 0;
    }

    // ---- carrier search (as DCF77) ---------------------------------------

    _feedAcquisition(xr, xi) {
        const r = this.search.feed(xr, xi);
        if (!r) return;
        if (r.snrDb !== null) this.lastToneSnrDb = r.snrDb;
        if (!r.found) return;
        this._setMixer(r.f);
        this.searching = false;
        this.yStart = this.samples;
        this.aRef = 1 - Math.exp((-2 * Math.PI * kRefHz) / this.sr);
        this.trk.noiseRef = kTrkNoiseRefSec * this.sr;
        this.lockState = LOCK.ACQUIRING;
    }

    _setMixer(f) {
        this.f0 = clamp(f, this.fNominal - kPullHz, this.fNominal + kPullHz);
        this.stepRe = Math.cos((-2 * Math.PI * this.f0) / this.sr);
        this.stepIm = Math.sin((-2 * Math.PI * this.f0) / this.sr);
    }

    // ---- per sample ------------------------------------------------------

    _feedSteady(xr, xi) {
        const k = this.samples - 1;
        const zr = xr * this.oscRe - xi * this.oscIm;
        const zi = xr * this.oscIm + xi * this.oscRe;
        const nr = this.oscRe * this.stepRe - this.oscIm * this.stepIm;
        this.oscIm = this.oscRe * this.stepIm + this.oscIm * this.stepRe;
        this.oscRe = nr;
        if (++this.oscRenorm >= 1024) {
            const m = Math.hypot(this.oscRe, this.oscIm);
            if (m > 1e-9) { this.oscRe /= m; this.oscIm /= m; }
            this.oscRenorm = 0;
        }
        const tone = this.live.feed(zr, zi);
        if (tone !== null) this.lastToneSnrDb = tone;

        this.refRe += this.aRef * (zr - this.refRe);
        this.refIm += this.aRef * (zi - this.refIm);
        const rp = this.refRe * this.refRe + this.refIm * this.refIm;
        const y = rp > 1e-30 ? (this.polarity * (zi * this.refRe - zr * this.refIm)) / rp : 0;
        const ix = k & this.yMask;
        this.yRing[ix] = y;
        this.zRe[ix] = zr;
        this.zIm[ix] = zi;

        // Follow the carrier: a residual offset shows as the reference turning.
        // Not while it is gone: a reference that is only noise turns at random,
        // and followed it walked the mixer to the edge of its range, where the
        // returning carrier was never found again. So the carrier's level is
        // watched, and the mixer held while it is under a third of usual.
        if (++this.freqCount >= this.sr) {
            this.freqCount = 0;
            const level = Math.hypot(this.refRe, this.refIm);
            const present = !(this.carrierLevel > 0) || level >= kCarrierGone * this.carrierLevel;
            this.carrierPresent = present;
            if (present) this.carrierLevel = this.carrierLevel > 0 ? this.carrierLevel + 0.1 * (level - this.carrierLevel) : level;
            if (present && (this.freqPrevRe !== 0 || this.freqPrevIm !== 0)) {
                const cr = this.refRe * this.freqPrevRe + this.refIm * this.freqPrevIm;
                const ci = this.refIm * this.freqPrevRe - this.refRe * this.freqPrevIm;
                this._setMixer(this.f0 + (kFreqGain * Math.atan2(ci, cr)) / (2 * Math.PI));
            }
            this.freqPrevRe = this.refRe; this.freqPrevIm = this.refIm;
        }

        if (!this.segValid) this._foldStep(k, y);
        while (this.segValid && this._canProcessSecond()) this._processSecond();
    }

    _yAt(n) { return this.yRing[n & this.yMask]; }
    _oldest() { return Math.max(this.yStart, this.samples - this.yRing.length + 1); }

    // ---- acquisition: the fold -------------------------------------------

    _foldStep(k, y) {
        if (this.foldBlockStart < 0) { this.foldBlockStart = k; this.foldPos = 0; this.foldAcc = 0; this.foldCount = 0; }
        this.foldAcc += y;
        if (++this.foldCount < this.foldDecim) return;
        this.foldCur[this.foldPos] = this.foldAcc / this.foldCount;
        this.foldAcc = 0; this.foldCount = 0;
        if (++this.foldPos < this.foldLen) return;
        // A second of 1 kHz phase, filed; look once enough are in.
        this.foldSlots[this.foldSlotNext] = this.foldCur.slice();
        this.foldSlotNext = (this.foldSlotNext + 1) % kAcqSeconds;
        this.foldSlotsN = Math.min(this.foldSlotsN + 1, kAcqSeconds);
        const blockStart = this.foldBlockStart;
        this.foldBlockStart = k + 1;
        this.foldPos = 0;
        // Only a fold of kAcqSeconds seconds none of which an earlier fold used.
        if (++this.foldFresh < kAcqSeconds || this.foldSlotsN < kAcqSeconds) return;
        this.foldFresh = 0;
        // Nor while the carrier is away: a fold of noise has a peak somewhere.
        if (!this.carrierPresent) { this.acqAgree = 0; return; }

        const L = this.foldLen;
        const S = new Float64Array(L);
        for (const sl of this.foldSlots) for (let i = 0; i < L; i++) S[i] += sl[i];
        const c = new Float64Array(L);
        const triD = this.triD;
        for (let l = 0; l < L; l++) {
            let v = 0;
            for (let i = 0; i < triD.length; i++) v += S[(l + i) % L] * triD[i];
            c[l] = v;
        }
        let best = 0;
        for (let l = 1; l < L; l++) if (Math.abs(c[l]) > Math.abs(c[best])) best = l;
        // Is it the excursion? Not a threshold on the peak: the position codes
        // leave structure at every lag of the fold. But the excursion is at the
        // same lag in every fold and that structure is not: the peak must clear
        // the best of the rest — more than 60 ms from it — by kAcqRatio, at the
        // same lag to 2 ms, kAcqAgree folds running, each of seconds the others
        // did not use.
        let rest = 0;
        for (let l = 0; l < L; l++) {
            let dd = Math.abs(l - best);
            dd = Math.min(dd, L - dd);
            if (dd > Math.trunc((kFoldRateHz * 6) / 100)) rest = Math.max(rest, Math.abs(c[l]));
        }
        const ratio = rest > 0 ? Math.abs(c[best]) / rest : 0;
        this.lastTimeSig = ratio;
        const sign = c[best] >= 0 ? 1 : -1;
        if (ratio < kAcqRatio) { this.acqAgree = 0; return; }
        let dd = Math.abs(best - this.acqLast);
        dd = Math.min(dd, L - dd);
        if (this.acqAgree > 0 && dd <= Math.trunc((2 * kFoldRateHz) / 1000) && sign === this.acqSign) ++this.acqAgree;
        else this.acqAgree = 1;
        this.acqLast = best;
        this.acqSign = sign;
        if (this.acqAgree < kAcqAgree) return;
        this.acqAgree = 0;

        // Found. Which way round the phase reads, and the excursion's start in
        // the block just folded; the per-second correlation times it.
        if (c[best] < 0) {
            this.polarity = -this.polarity;
            // y already in the ring was stored the other way round.
            for (let n = this._oldest(); n <= k; n++) this.yRing[n & this.yMask] = -this._yAt(n);
        }
        this.segValid = true;
        this.segEdge = blockStart + best * this.foldDecim - 0.5;
        // The oldest whole second still in the ring, so that nothing is lost.
        const sr = this.sr;
        while (this.segEdge - 0.1 * sr - sr > this._oldest()) this.segEdge -= sr;
        while (this.segEdge - 0.1 * sr < this._oldest()) this.segEdge += sr;
        this.trk.reset();
        this.blindSeconds = 0;
    }

    // ---- once per second -------------------------------------------------

    // A second is processed once its own quiet 900–1000 ms is in.
    _canProcessSecond() {
        return this.samples >= this.segEdge + (this.codeOff + this.nCode) + kSearchSec * this.sr + 3.0;
    }

    // The phase of the second at `c`, as y = sin φ, into yLoc. The carrier's
    // phase comes from the unmodulated 900–1000 ms either side — the second
    // before's and this one's — joined by a straight line. Not from a running
    // reference: a one-pole of the carrier follows the modulation a little,
    // which is a high-pass on the phase, and its lead put every edge 1.45 ms
    // early. Returns σ_y per sample from the two quiet windows, or −1 when the
    // stretch is not in the ring.
    _buildSecondPhase(c, L) {
        const sr = this.sr;
        const a0 = c - lround((1.0 - kQuietFrom) * sr);
        const a1 = c - lround((1.0 - kQuietTo) * sr);
        const b0 = c + lround(kQuietFrom * sr);
        const b1 = c + lround(kQuietTo * sr);
        // Everything a correlation at up to L lags either way can read: the
        // position code runs to the second's end.
        const lo = Math.min(a0, c - L);
        const hi = Math.max(b1, c + this.codeOff + this.nCode + L + 1);
        if (lo < this._oldest() || hi > this.samples - 1) return -1;
        const { zRe, zIm, yMask } = this;
        const sumZ = (from, to) => {
            let re = 0;
            let im = 0;
            for (let n = from; n <= to; n++) { re += zRe[n & yMask]; im += zIm[n & yMask]; }
            return [re, im];
        };
        const [ar, ai] = sumZ(a0, a1);
        const [br, bi] = sumZ(b0, b1);
        const na = a1 - a0 + 1;
        const nb = b1 - b0 + 1;
        const A = 0.5 * (Math.hypot(ar, ai) / na + Math.hypot(br, bi) / nb);
        if (!(A > 0)) return -1;
        const tA = Math.atan2(ai, ar);
        const raw = Math.atan2(bi, br) - tA;
        const d = raw - 2 * Math.PI * Math.round(raw / (2 * Math.PI));   // std::remainder
        const ca = 0.5 * (a0 + a1);
        const cb = 0.5 * (b0 + b1);
        const slope = d / (cb - ca);
        const len = hi - lo + 1;
        if (this.yLoc.length < len) this.yLoc = new Float32Array(len);
        const yLoc = this.yLoc;
        this.yLocBase = lo;
        for (let n = lo; n <= hi; n++) {
            const th = tA + slope * (n - ca);
            const ix = n & yMask;
            yLoc[n - lo] = (this.polarity * (zIm[ix] * Math.cos(th) - zRe[ix] * Math.sin(th))) / A;
        }
        let m2 = 0;
        for (let n = a0; n <= a1; n++) { const v = yLoc[n - lo]; m2 += v * v; }
        for (let n = b0; n <= b1; n++) { const v = yLoc[n - lo]; m2 += v * v; }
        return Math.sqrt(Math.max(1e-30, m2 / (na + nb)));
    }

    // <y, T> with T's sample 0 at instant `at` (integer), on this second's y.
    _dot(at, T) {
        const y = this.yLoc;
        const o = at - this.yLocBase;
        let s = 0;
        for (let i = 0; i < T.length; i++) s += y[o + i] * T[i];
        return s;
    }

    // The second at `pred` with symbol and code as given, correlated at lags
    // either side, the peak refined by a parabola. { sig, edge }: the SNR at
    // the peak (0 when there is none) and where it is.
    _timeSecond(pred, sof, bit, sigmaY, searchSec) {
        const c = lround(pred);
        const L = Math.max(2, lround(searchSec * this.sr));
        const hasTri = sof !== 59;
        const hasCode = sof >= 0 && sof !== 59;
        let E = 0;
        if (hasTri) E += this.triE * (bit === 1 ? 2.0 : 1.0);
        if (hasCode) E += this.codeE[sof];
        if (!(E > 0) || !(sigmaY > 0)) return { sig: 0, edge: pred };
        const y = new Float64Array(2 * L + 1);
        let bi = 0;
        for (let j = -L; j <= L; j++) {
            let v = 0;
            if (hasTri) {
                v += this._dot(c + j, this.tri);
                if (bit === 1) v += this._dot(c + j + this.nData, this.tri);
            }
            if (hasCode) v += this._dot(c + j + this.codeOff, this.codeT[sof]);
            y[j + L] = v;
            if (v > y[bi]) bi = j + L;
        }
        let frac = 0;
        if (bi > 0 && bi + 1 < y.length) {
            const den = y[bi - 1] - 2 * y[bi] + y[bi + 1];
            if (den < 0) frac = clamp((0.5 * (y[bi - 1] - y[bi + 1])) / den, -0.5, 0.5);
        } else {
            return { sig: 0, edge: pred };   // on the window's edge: not a peak
        }
        return { sig: y[bi] / (sigmaY * Math.sqrt(E)), edge: c - L + bi + frac };
    }

    _processSecond() {
        const sr = this.sr;
        const pred = this.segEdge;
        const c = lround(pred);
        const r = emptyRec();

        const sigmaY = this._buildSecondPhase(c, lround(kSearchSec * sr) + 1);
        if (sigmaY < 0) { this.segEdge += sr; return; }

        // The data excursions, at the prediction.
        const sTri = sigmaY * Math.sqrt(this.triE);
        const a1 = this._dot(c, this.tri) / this.triE;
        const a2 = this._dot(c + this.nData, this.tri) / this.triE;
        const sA = sTri / this.triE;
        const A = this.ampHave ? this.amp : Math.max(a1, 0);
        r.read = A > 0;
        r.marker = a1 < 0.5 * A;
        r.markConf = confOfZ(Math.abs(a1 - 0.5 * A) / sA);
        r.bit = a2 > 0.5 * A ? 1 : 0;
        r.bitConf = r.marker ? 0 : confOfZ(Math.abs(a2 - 0.5 * A) / sA);

        // Which second this is, by its position code.
        const score = new Float64Array(60);
        let best = -1;
        let second = -1;
        for (let s = 0; s < 59; s++) {
            const sc = this._dot(c + this.codeOff, this.codeT[s]) / (sigmaY * Math.sqrt(this.codeE[s]));
            score[s] = sc;
            if (best < 0 || sc > score[best]) { second = best; best = s; }
            else if (second < 0 || sc > score[second]) second = s;
        }
        if (best >= 0 && second >= 0 && score[best] >= kKeyMinSig && score[best] - score[second] >= kKeyMarginSig) {
            r.key = best;
            r.keySig = score[best];
        }
        const expect = this.anchored ? this.sofNext : -1;
        if (expect >= 0 && expect < 59) r.expSig = score[expect];
        // The excursion's amplitude, learnt from every second known to carry
        // one — counted into the minute and not second 59, or named by its own
        // position code — whatever this second's reading. Learnt only from
        // seconds already READ as carrying one, it came out 15% high in noise.
        if ((expect >= 0 && expect < 59) || r.key >= 0) {
            this.amp = this.ampHave ? this.amp + kAmpGain * (a1 - this.amp) : a1;
            this.ampHave = true;
        }

        // Timed by all of it: the excursion(s) and the code of the second it is
        // taken to be. A second 59 has nothing to time it by.
        const sofT = expect >= 0 ? expect : r.key >= 0 ? r.key : r.marker && r.markConf >= kStructConf ? 59 : -1;
        const warm = this.trk.valid && this.trk.count > kTrkWarm;
        let edgeMeas = pred;
        let tsig = 0;
        if (sofT !== 59 && (!r.marker || r.markConf < kStructConf)) {
            const t = this._timeSecond(pred, sofT, r.bitConf >= kStructConf ? r.bit : 0, sigmaY,
                warm ? kSearchWarmSec : kSearchSec);
            tsig = t.sig;
            if (t.sig > 0) edgeMeas = t.edge;
        }
        const meas = tsig >= kTimeMinSig;
        r.timeSig = tsig;
        if (meas) this.lastTimeSig = tsig;
        this.trk.update(meas, edgeMeas, this.trk.valid ? this.trk.period : sr,
            (warm ? kTrkOutlierSec : kTrkAcqOutlierSec) * sr);
        const edge = this.trk.valid ? this.trk.edge : pred;
        this.blindSeconds = meas ? 0 : this.blindSeconds + 1;
        this.timing = this.trk.valid && meas;

        // What is reported is the second, not the excursion's start.
        r.edgeExact = edge + kSecondAfterStartSec * sr;
        r.edge = lround(r.edgeExact);
        this.hist.push(r);
        if (this.hist.length > 8) this.hist.shift();

        this._handleSecond(r, meas);

        this.segEdge = this.trk.valid ? this.trk.edge + this.trk.period : pred + sr;

        // With the carrier there, a second at the right phase names itself;
        // thirty that do not, running, and the phase is not right.
        if (r.key >= 0 || !this.carrierPresent || (this.anchored && this.sofNext === 0)) this.unnamedRun = 0;
        else ++this.unnamedRun;

        if (this.blindSeconds >= kMaxBlindSeconds || this.unnamedRun >= kMaxUnnamedSeconds) {
            if (this.lockState === LOCK.LOCKED) this.lockState = LOCK.ACQUIRING;
            this._dropAnchor();
            this.hist = [];
            this._restartAcquisition();
        }
    }

    // ---- sync & frames ---------------------------------------------------

    _dropAnchor() {
        this.anchored = false;
        this.sofNext = 0;
        this.haveVoted = false;
        this.frame = Array.from({ length: 60 }, emptyRec);
        this.frFilled = 0;
        this.frStart = 0;
        this.frStartExact = 0;
        this.frMatches = 0; this.frMismatches = 0;
        this.slipRun = 0;
        this.unconfirmedRun = 0;
        this.lastLeapWarn = false;
    }

    _demote() {
        this.haveVoted = false;
        if (this.lockState === LOCK.LOCKED) this.lockState = LOCK.ACQUIRING;
    }

    // Anchor so that the second just read is `sof`.
    _anchorAt(sof, r) {
        this.anchored = true;
        this.frMatches = 0; this.frMismatches = 0;
        this.slipRun = 0;
        this.frame = Array.from({ length: 60 }, emptyRec);
        this.frFilled = 0;
        if (sof === 0) { this.frStart = r.edge; this.frStartExact = r.edgeExact; }
        this.sofNext = sof;
    }

    _handleSecond(r, measured) {
        let sof = -1;
        if (!this.anchored && this.hist.length >= 2) {
            // Two seconds in a row that name themselves, one after the other.
            const p = this.hist[this.hist.length - 2];
            if (r.key >= 0 && p.key >= 0 && r.key === p.key + 1) this._anchorAt(r.key, r);
            else if (r.key === 0 && p.marker && p.markConf >= kStructConf) this._anchorAt(0, r);
        }
        if (this.anchored) {
            sof = this.sofNext;
            if (sof === 0) {
                this.frStart = r.edge; this.frStartExact = r.edgeExact;
                this.frFilled = 0; this.frMatches = 0; this.frMismatches = 0;
            }
            // Does the second name itself as expected?
            if (sof < 59) {
                if (r.key >= 0 && r.key !== sof) {
                    ++this.frMismatches;
                    if (++this.slipRun >= 2) {
                        // Two seconds running that clearly name another: the
                        // count has slipped. Follow them.
                        this._demote();
                        this.haveLastFrame = false;
                        this._anchorAt(r.key, r);
                        sof = r.key;
                        if (sof === 0) { this.frStart = r.edge; this.frStartExact = r.edgeExact; }
                    }
                } else {
                    this.slipRun = 0;
                    if (r.expSig >= 3.0) ++this.frMatches;
                }
            } else if (!r.marker && r.markConf >= kStructConf) {
                ++this.frMismatches;   // an excursion in second 59
            }
            if (sof >= 0 && sof < 60) {
                this.frame[sof] = r;
                this.frFilled = Math.max(this.frFilled, sof + 1);
            }
            this.sofNext = (sof + 1) % 60;
        }

        this._emitSecond(r, measured, sof);

        if (this.anchored && sof === 59) this._finalizeFrame();

        if (this.lockState === LOCK.LOCKED && this.haveVoted && sof >= 0 && this.haveTimeFrame) {
            const utcMs = composeUtc(this.voted, r.edge, this.timeFrameStart, this.sr);
            if (utcMs !== null) {
                this.events.push({ type: 'time', utcMs, edge: r.edgeExact, quality: this.votedQuality, sof });
            }
        }
    }

    // The minute's bits, read; up to kMaxErasures that could not be read are
    // filled in by the checks. ALS162 carries a good deal of redundancy —
    // three parities, the count of 1s in 21–58, a weekday that must fit the
    // date, bits 0 and 20 fixed, exactly one of 17 and 18 — so every value of
    // the unread bits is tried and the minute taken only when exactly one
    // passes every check. Two that pass is ambiguous, and refused.
    _decode() {
        let minConf = 1;
        const b = new Array(60).fill(0);
        const unread = [];
        for (let s = 0; s <= 58; s++) {
            const r = this.frame[s];
            if (!r.read) return null;
            if (r.marker || r.bitConf < kBitMinConf) {
                unread.push(s);
                if (unread.length > kMaxErasures) return null;
                continue;
            }
            b[s] = r.bit;
            if (s >= 17) minConf = Math.min(minConf, r.bitConf);
        }
        let d = null;
        let passes = 0;
        for (let m = 0; m < 1 << unread.length; m++) {
            unread.forEach((s, i) => { b[s] = (m >> i) & 1; });
            const t = this._decodeBits(b);
            if (t) { d = t; if (++passes > 1) return null; }
        }
        if (!d) return null;
        // An unread bit filled in by the checks is worth what the checks are:
        // the minute stands on its weakest READ bit, held a little lower for
        // each one filled.
        if (unread.length) minConf *= unread.length === 1 ? 0.7 : 0.5;
        d.minConf = minConf;
        d.erasures = unread.length;
        return d;
    }

    _decodeBits(b) {
        const at = (s) => b[s];
        if (at(0) !== 0) return null;
        let ones = 0;
        for (let s = 21; s <= 58; s++) ones += at(s);
        if (ones !== 2 * at(3) + 4 * at(4) + 8 * at(5) + 16 * at(6)) return null;
        const d = decodeLegalMinute(at);
        if (!d) return null;
        d.leapWarn = at(1) === 1 || at(2) === 1;
        return d;
    }

    _finalizeFrame() {
        const contradicted = this.frMismatches > 1;
        const confirmed = this.frFilled >= 60 && this.frMatches >= kConfirmMatches && !contradicted;
        if (contradicted || (!confirmed && ++this.unconfirmedRun > kMaxUnconfirmedMinutes)) {
            this._demote();
            this.haveLastFrame = false;
            this.frMatches = 0; this.frMismatches = 0;
            return;
        }
        if (confirmed) this.unconfirmedRun = 0;

        const dec = confirmed ? this._decode() : null;
        this.lastFrameFrom = dec ? 2 : 0;
        if (dec) this.lastErasures = dec.erasures;

        const syn = syntheticFrame(dec ? dec.utc : null, dec ? dec.minConf : 0);
        this.timeFrameStart = this.frStart;
        this.haveTimeFrame = true;
        if (dec) {
            this.frames++;
            this.events.push({
                type: 'frame', utcMs: dec.utcMs, startEdge: this.frStartExact, confidence: dec.minConf,
                dut1Tenths: null, summer: dec.cest, leapPending: dec.leapWarn,
            });
        }

        const P = this.trk.valid ? this.trk.period : this.sr;
        const consecutive = this.haveLastFrame && Math.abs(this.frStart - this.lastFrameStart - 60.0 * P) <= 0.25 * this.sr;
        if (!consecutive) this.voter.reset();
        this.haveLastFrame = true;
        this.lastFrameStart = this.frStart;
        this.voter.addFrame(syn.symbols, syn.conf);

        const certified = this.voter.locked();
        if (certified) {
            this.voted = this.voter.resolve().value;
            this.votedQuality = this.voter.lockConfidence();
        }
        // A leap second after this minute: stop certifying before it; the
        // position codes find the count again after.
        const leapNext = !!dec && (dec.leapWarn || this.lastLeapWarn) && leapSecondPossibleUtc(dec.utc);
        this.lastLeapWarn = !!dec && dec.leapWarn;
        if (certified && confirmed && !leapNext) {
            this.haveVoted = true;
            this.lockState = LOCK.LOCKED;
        } else {
            this._demote();
        }
        this.frMatches = 0; this.frMismatches = 0;
    }

    _emitSecond(r, measured, sof) {
        const symbol = !r.read ? 'unknown' : r.marker ? 'marker' : r.bit ? 'one' : 'zero';
        this.events.push({
            type: 'second', edge: r.edgeExact, measured, servable: true,
            symbol, conf: r.marker ? r.markConf : r.bitConf, sof,
        });
    }
}
