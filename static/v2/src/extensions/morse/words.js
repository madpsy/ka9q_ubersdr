// What the CW console marks in its copy, word by word: call signs (which open
// the callsign lookup), the words a call is sent with (CQ, DE, TEST, QRZ),
// common abbreviations (their meaning shown on hover) and reports. A Q code's
// statement and question are given as "... / ...?".

export const CW_ABBREVIATIONS = {
  "73": "Best Regards",
  "88": "Love & Kisses",
  A: "Number 1",
  ABT: "About",
  AGN: "Again",
  ANT: "Antenna",
  AR: "End of this transmission",
  B4: "Before",
  BCNU: "Be Seeing You",
  BK: "Back or Break",
  BT: "Dash (often used in place of period or comma)",
  BURO: "QSL Bureau",
  CL: "Closing Station Down",
  CLDY: "Cloudy",
  CLR: "Clear",
  CONDX: "Conditions",
  CONGRATS: "Congratulations",
  CPY: "Copy",
  CQ: "General Call for a QSO (Contact)",
  CUZ: "Because",
  DE: "From (eg... W3AA de W3DF)",
  DSW: "See You Again (Russian)",
  DWN: "Down",
  DX: "Long Distance Contact, or a Rare Station",
  EL: "Element (as in 3 EL Yagi)",
  ES: "And",
  FB: "Fine Business (jargon for very good)",
  FD: "Field Day",
  FER: "For",
  FIST: "Unique characteristic of an operator’s sending of CW",
  FONE: "Phone (as in AM or SSB)",
  FM: "From or Frequency Modulation",
  FREQ: "Frequency",
  GA: "Good Afternoon or Go Ahead",
  GB: "Good Bye",
  GD: "Good or Good Day",
  GE: "Good Evening",
  GG: "Going",
  GL: "Good luck",
  GM: "Good Morning",
  GMT: "Greenwich Mean Time (standard time used by hams)",
  GN: "Good Night",
  GND: "Ground",
  GP: "Ground Plane",
  GUD: "Good",
  HAM: "Amateur Radio Operator",
  HI: "Laughter on CW",
  HNY: "Happy New Year",
  HPE: "Hope",
  HR: "Here",
  HV: "Have",
  HW: "How, or How Do You Copy Me?",
  "HW?": "How, or How Do You Copy Me?",
  II: "Error",
  K: "Please Transmit",
  KN: "Only the station I am working should transmit",
  KNW: "Know",
  LIL: "Little",
  LID: "Poor Operator Don’t confuse with “SOLID”",
  LP: "Log Periodic (type of directional antenna) or Long Path",
  LSB: "Lower Sideband",
  LW: "Long Wire (type of antenna)",
  MGR: "QSL Manager",
  MNI: "Many",
  MANI: "Many",
  MSG: "Message",
  MULT: "Multiplier",
  N: "No or the number 9. (599 IS 5NN IN MORSE)",
  NIL: "Nothing Heard or No Copy",
  NW: "Now",
  OM: "Old Man (Ham jargon for an experienced operator)",
  OP: "Operator, or Name",
  OPR: "Operator or Operate",
  PSE: "Please",
  PWR: "Power",
  QRL: "The frequency is busy / Is the frequency busy?",
  QRM: "Your transmission is being interfered with / Is my transmission being interfered with?",
  QRN: "I am troubled by static / Are you troubled by static?",
  QRO: "Increase power. / Should I increase power?",
  QRP: "Decrease power. Also a station using low power. / Should I decrease power?",
  QRQ: "Send faster / Should I send faster?",
  QRS: "Send slower / Should I send slower?",
  QRT: "Stop transmitting / Should I stop transmitting?",
  QRU: "I don’t have anything more",
  QRV: "I am ready / Are you ready?",
  QRX: "Wait as in QRX 1 (wait a minute)",
  QRZ: "You are being called by ... / Who is calling me? Also used to be sure frequency is clear before calling a CQ.",
  "QRZ?": "You are being called by ... / Who is calling me? Also used to be sure frequency is clear before calling a CQ.",
  QSB: "Your signal is fading / Is my signal fading?",
  QSK: "I can operate break-in / Can you operate break-in?",
  QSL: "I acknowledge receipt / Do you acknowledge receipt?",
  QSO: "I can communicate with ... / Can you communicate with ...?",
  QSY: "I will change my transmit frequency / Should I change my transmit frequency?",
  QTH: "My location is ... / What is your location?",
  R: "Message Received or Correct, or Roger (affirmative)",
  RR: "Message Received or Correct, or Roger (affirmative)",
  RCVR: "Receiver",
  RIG: "Equipment",
  RPRT: "Report or Repeat",
  RPT: "Report or Repeat",
  RX: "Receiver",
  SHUD: "Should",
  SIG: "Signal",
  SK: "This is my last transmission",
  SKED: "Schedule",
  SP: "Short Path",
  SRI: "Sorry",
  STN: "Station",
  SWL: "Short Wave Listner",
  T: "Short hand for the number Zero",
  TEMP: "Temperature",
  TEST: "Contest",
  TIL: "Until",
  TKS: "Thanks",
  TCVR: "Transceiver",
  TT: "That",
  TU: "Thank You",
  TX: "Transmitter",
  TNX: "Thanks",
  U: "You",
  UR: "Your",
  USB: "Upper Sideband",
  UTC: "Universal Time Coordinated (same as GMT)",
  VERT: "Vertical Antenna",
  VFO: "Variable Frequency Oscillator",
  VY: "Very",
  W: "Watts",
  WID: "With",
  WKD: "Worked (Ham jargon for making a contact with a station)",
  WKG: "Working",
  WPM: "Words Per Minute (a measure of code speed)",
  WRK: "Work",
  WUD: "Would",
  WX: "Weather",
  XCVR: "Transceiver",
  XMTR: "Transmitter",
  XTAL: "Crystal",
  XYL: "Wife",
  YL: "Young Lady",
  Z: "Zulu, GMT, or UTC Time (all the same)",
  ZZ: "Sleep",
};

// A word's kind: a call sign (letters and a digit, with any /prefix or
// /suffix), a word a call is sent with, another common abbreviation, a report
// or serial number, or any other word.
const KEYS = new Set(['CQ', 'DE', 'TEST', 'QRZ', 'QRZ?']);
const REPORT = /^(5NN|5[1-9][9N]|[0-9TN]{1,4}|5NN[0-9TN]+|599[0-9]+)$/;
const CALL = /^(?:[A-Z0-9]{1,4}\/)?(?:[A-Z]{1,2}\d|\d[A-Z]\d?|[A-Z]\d[A-Z]?)\d?[A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?$/;

export function wordKind(w) {
    if (KEYS.has(w)) return 'key';
    if (Object.prototype.hasOwnProperty.call(CW_ABBREVIATIONS, w)) return 'abbr';
    if (/\d/.test(w) && REPORT.test(w)) return 'report'; // before calls: 5NN is call-shaped
    if (CALL.test(w) && /[A-Z]/.test(w) && /\d/.test(w)) return 'call';
    return 'word';
}

/**
 * A line's chunks (each a run of text with the decoder's confidence) as its
 * words and the spaces between, each word's characters kept in runs of one
 * confidence: a word the decoder gave in pieces, or partly unsure, is still
 * one word to mark.
 *
 * Returns [{ space: ' ' } | { word, kind, runs: [{ text, conf }] }].
 */
export function wordsOf(chunks) {
    const out = [];
    let cur = null;
    const push = (ch, conf) => {
        if (ch === ' ') {
            if (cur) out.push(cur);
            cur = null;
            out.push({ space: ' ' });
            return;
        }
        if (!cur) cur = { word: '', runs: [] };
        cur.word += ch;
        const last = cur.runs[cur.runs.length - 1];
        if (last && last.conf === conf) last.text += ch;
        else cur.runs.push({ text: ch, conf });
    };
    for (const c of chunks) for (const ch of c.text) push(ch, c.conf);
    if (cur) out.push(cur);
    for (const w of out) if (w.word) w.kind = wordKind(w.word);
    return out;
}
