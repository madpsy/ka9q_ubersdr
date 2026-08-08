// The DX cluster addon's terminal.
//
// The addon runs a DX Spider-style cluster with a telnet server, and proxies it
// over a WebSocket at /addon/dxcluster/api/terminal. That socket *is* the
// feature: you log in with a callsign, type Spider commands (`show/dx`,
// `set/filter band 20m`, `help`) and read what comes back. Spots arrive as
// lines of text in that stream like everything else — there is no spot API and
// no structured feed to subscribe to.
//
// Ported from widgets/dxcluster.widget.html, which is the reference for all of
// it: the same socket, the same login handshake, the same command set, and the
// same rule for turning a spot line into a frequency and a mode.
//
// The login is a handshake rather than a header. The server prints a prompt
// containing the word "callsign" and the first line back is the callsign;
// watching the output for it is the only signal there is.

// The widget's key, so a callsign entered in either place is remembered in both.
const CALLSIGN_KEY = 'dxc_widget_callsign';

// The addon's own terminal page stores the callsign under a different name and
// the spot password under this one. Read as a fallback for the callsign and as
// the only home for the password, so logging in on either side carries over.
const ADDON_CALLSIGN_KEY = 'ubersdr_terminal_callsign';
const PASSWORD_KEY = 'ubersdr_terminal_spotpass';

// Long enough for the longest real callsign with a prefix and a suffix —
// VP2E/GM4ABC/P is 13 — and short enough that the field cannot be used as a
// notepad.
export const MAX_CALLSIGN = 16;
export const MAX_PASSWORD = 32;

// What the server prints when it wants the login.
const CALLSIGN_PROMPT = 'callsign';

// Lines kept in the transcript. The widget's number: a terminal left running
// for an evening is otherwise a memory leak with a cursor.
export const SCROLLBACK_LIMIT = 2000;

// The quick commands, as the widget offers them. `prompt` means the command
// needs an argument — a callsign — before it is worth sending.
export const QUICK_COMMANDS = [
    { label: 'sh/dx', cmd: 'show/dx' },
    { label: 'last 10', cmd: 'show/dx 10' },
    { label: 'filters', cmd: 'show/filter' },
    { label: 'status', cmd: 'show/status' },
    { label: 'time', cmd: 'show/time' },
    { label: 'upstream', cmd: 'set/dxcluster', title: 'Enable the upstream DX Cluster feed' },
    { label: 'qrz', prompt: 'sh/qrz', title: 'Look up a callsign' },
    { label: 'check call', prompt: 'sh/dx', title: 'Show spots for a callsign' },
    { label: 'help', cmd: 'help' },
];

export function savedLogin() {
    try {
        return {
            callsign: localStorage.getItem(CALLSIGN_KEY)
                || localStorage.getItem(ADDON_CALLSIGN_KEY) || '',
            password: localStorage.getItem(PASSWORD_KEY) || '',
        };
    } catch (e) {
        return { callsign: '', password: '' };
    }
}

export function saveLogin({ callsign, password }) {
    try {
        localStorage.setItem(CALLSIGN_KEY, callsign || '');
        localStorage.setItem(PASSWORD_KEY, password || '');
    } catch (e) { /* private mode */ }
}

/**
 * The line sent in answer to the callsign prompt.
 *
 * A cluster that wants a password for spotting takes it on the same line,
 * separated by a space; one that does not is given the callsign alone rather
 * than a trailing space it would have to strip.
 */
export function loginLine(callsign, password) {
    const call = String(callsign || '').trim().toUpperCase();
    const pass = String(password || '').trim();
    return pass ? `${call} ${pass}` : call;
}

/**
 * `DX <freq_kHz> <callsign> [comment]` — a spot, in the addon's own syntax.
 *
 * Spider-compatible; see handleDX in ubersdr_dxcluster/commands.go for the far end.
 * Frequency goes in kHz where the receiver works in Hz, and to one decimal, which is
 * 100 Hz — finer than that is below what a spot means and would only ever disagree
 * with the spotter's own dial.
 *
 * The callsign is validated at the far end, which has the regex and the country
 * tables; guessing here would refuse the odd but legal ones. Newlines are stripped
 * from the comment because those would make the rest of it a second command.
 *
 * @returns {string} the command, or '' if there is nothing sendable.
 */
export function spotCommand({ hz, callsign, comment }) {
    const call = String(callsign || '').trim().toUpperCase();
    const khz = Math.round(Number(hz) / 100) / 10;
    if (!call || !Number.isFinite(khz) || khz <= 0) return '';
    const note = String(comment || '').replace(/[\r\n]+/g, ' ').trim();
    return `DX ${khz.toFixed(1)} ${call}${note ? ` ${note}` : ''}`;
}

/**
 * The line the cluster prints once a session may submit spots.
 *
 * The addon says it in exactly two places and in the same words — in the banner when
 * the login line carried a correct password, and in reply to SET/SPOTPASS. Matched
 * from the transcript rather than assumed from "we sent a password", because a wrong
 * password is not an error there: the client connects normally and simply has no spot
 * rights. Assuming would offer a Spot command that always failed, into a terminal
 * panel that is collapsed most of the time.
 */
export const spotsEnabledBy = (text) => /spot submission enabled/i.test(String(text || ''));

/** Where the addon's own full web UI lives. */
export const webUrl = (base = '/addon/dxcluster') => `${base}/`;

/** The desktop client download the widget links to. */
export const clientUrl = (base = '/addon/dxcluster') => `${base}/client/download`;

// The command line the cluster accepts. The widget's limit.
export const MAX_COMMAND = 512;

export function terminalUrl(base = '/addon/dxcluster') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${base}/api/terminal`;
}

// ── Spot lines ──────────────────────────────────────────────────────────────
//
// A spot arrives as a line of cluster text:
//
//   DX de SPOTTER:   14033.0  R6AU           13 dB  23 WPM  CQ   1701Z
//
// Everything about the shape below is the widget's, which in turn mirrors the
// desktop client's audiotune.go. Two spaces or more separate the callsign from
// the comment, and the trailing 1701Z is what makes a spot line a spot line.

const SPOT_LINE_RE = /^DX de \S+\s+([\d.]+)\s+(\S+)\s{2,}(.+?)\s+(\d{4})Z\s*$/;
const DIGITAL_COMMENT_RE = /^\S+\s+-?\d+\s+dB/i;

// The 10 MHz boundary is the IARU convention: CW is lower sideband below it and
// upper above, and the same split is used for the SSB fallback.
const SIDEBAND_SPLIT_HZ = 10000000;

/**
 * The mode a spot should be listened to in, or '' for one that should not be
 * tuned at all.
 *
 * Order matters. A CW skimmer spot carries WPM *and* a dB figure, so the WPM
 * test has to come before the digital one or every skimmer spot would be
 * refused as a decode.
 */
export function modeFromSpot(freqHz, comment) {
    const text = String(comment || '');
    if (text.includes('WPM')) return freqHz >= SIDEBAND_SPLIT_HZ ? 'cwu' : 'cwl';

    const upper = text.toUpperCase().trimStart();
    if (upper.startsWith('USB')) return 'usb';
    if (upper.startsWith('LSB')) return 'lsb';

    // A digital decode — "FT8 -12 dB". There is nothing to listen to, so the
    // line is left unclickable rather than tuning you to a carrier.
    if (DIGITAL_COMMENT_RE.test(text)) return '';

    return freqHz >= SIDEBAND_SPLIT_HZ ? 'usb' : 'lsb';
}

/**
 * A spot line as something tuneable, or null if the line is not one.
 *
 * Returns the callsign and the comment as well, which the widget did not need
 * but a panel does: it is what the row can say about where it is sending you.
 */
export function parseSpotLine(line) {
    const m = SPOT_LINE_RE.exec(String(line).replace(/[\r\n]+$/, ''));
    if (!m) return null;
    const khz = parseFloat(m[1]);
    if (!Number.isFinite(khz)) return null;
    const hz = Math.round(khz * 1000);
    const mode = modeFromSpot(hz, m[3].trim());
    if (!mode) return null;                       // a digital decode: not tuneable
    return { hz, mode, khz: m[1], callsign: m[2], comment: m[3].trim(), utc: m[4] };
}

/** Keep the tail of a transcript, in whole lines. */
export function trimLines(text, max = SCROLLBACK_LIMIT) {
    const lines = String(text).split('\n');
    return lines.length <= max ? String(text) : lines.slice(lines.length - max).join('\n');
}

// ── The socket ──────────────────────────────────────────────────────────────

/**
 * Open the terminal.
 *
 * @param on.text   (chunk, isEcho) => void  server output, and our own echoed
 *                  commands — flagged, because a terminal always follows what
 *                  you typed even when you have scrolled back to read
 * @param on.state  ('connecting'|'open'|'closed', detail) => void
 */
export function openTerminal({ callsign, password, base, on = {} }) {
    let ws = null;
    let sentCallsign = false;
    let byUser = false;

    const say = (state, detail) => { if (on.state) on.state(state, detail || ''); };
    const write = (chunk, isEcho) => { if (on.text) on.text(chunk, !!isEcho); };

    try {
        ws = new WebSocket(terminalUrl(base));
    } catch (e) {
        say('closed', e.message);
        return { close() {}, send() { return false; }, get connected() { return false; } };
    }

    say('connecting');
    ws.onopen = () => say('open');

    ws.onmessage = (e) => {
        const text = typeof e.data === 'string' ? e.data : '';
        if (!sentCallsign && text.includes(CALLSIGN_PROMPT)) {
            sentCallsign = true;
            ws.send(`${loginLine(callsign, password)}\r\n`);
        }
        write(text);
    };

    ws.onclose = (e) => {
        ws = null;
        sentCallsign = false;
        say('closed', byUser || e.wasClean ? '' : `connection lost (${e.code})`);
    };

    // Always followed by onclose, which is where the message belongs.
    ws.onerror = () => {};

    return {
        get connected() { return !!ws && ws.readyState === WebSocket.OPEN; },
        send(line) {
            const cmd = String(line || '').trim();
            if (!cmd || !ws || ws.readyState !== WebSocket.OPEN) return false;
            // Echoed locally: a telnet server does not echo, so without this you
            // cannot see what you typed once the input clears.
            write(`> ${cmd}\n`, true);
            ws.send(`${cmd}\r\n`);
            return true;
        },
        close() {
            byUser = true;
            if (ws && ws.readyState === WebSocket.OPEN) {
                // Leave politely, so the cluster drops the login now rather
                // than holding it until it times out.
                ws.send('bye\r\n');
                ws.close(1000, 'user disconnect');
            } else if (ws) {
                ws.close();
            }
            ws = null;
        },
    };
}
