'use strict';

// OmniRig, through a helper process. Windows only.
//
// OmniRig is a COM automation server rather than anything with a port, so
// neither the page nor Node can reach it. omnirig/omnirig-helper.exe does: a
// small C++ program this runs as a child, which talks to OmniRig over
// IDispatch and to us over its stdin and stdout — JSON lines out, one-line
// commands in. See omnirig/omnirig_helper.cpp for that end.
//
// It registers with the Radio Control panel like flrig and rigctld, from the
// receiver's preload, and lives here in the main process for the same reason
// they do: a page cannot start a process.
//
// The helper reports only when something changes, and OmniRig itself does the
// polling of the rig, so there is no poll loop here — just a process to keep
// alive while the link is wanted.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// RigParamX and RigStatusX, from OmniRig's type library (OmniRig_TLB.pas).
// The same numbers are in omnirig/omnirig_core.h.
const PM = {
    FREQ: 0x00000002,
    FREQA: 0x00000004,
    FREQB: 0x00000008,
    VFOAA: 0x00000080,
    VFOAB: 0x00000100,
    VFOBA: 0x00000200,
    VFOBB: 0x00000400,
    VFOA: 0x00000800,
    VFOB: 0x00001000,
    SPLITON: 0x00008000,
    SPLITOFF: 0x00010000,
    RX: 0x00200000,
    TX: 0x00400000,
    CW_U: 0x00800000,
    CW_L: 0x01000000,
    SSB_U: 0x02000000,
    SSB_L: 0x04000000,
    DIG_U: 0x08000000,
    DIG_L: 0x10000000,
    AM: 0x20000000,
    FM: 0x40000000,
};
const ST_ONLINE = 4;

// What the panel says, as a clause: it appends "— still trying; correct the
// settings above…" itself (RadioControlPanel.jsx), so none of these ends in a
// full stop. Worded for somebody looking at their radio rather than at COM.
//
// OmniRig's own StatusStr is not used: "Port is not available" does not say
// which program to close, and it is the same words for either rig.
const STATUS_TEXT = {
    0: (rig) => `Rig ${rig} is not set up in OmniRig — choose the radio and its port in OmniRig's settings`,
    1: (rig) => `Rig ${rig} is disabled in OmniRig`,
    2: () => 'OmniRig cannot open the radio\'s serial port — another program may be using it',
    3: (rig, name) => `${name ? `The ${name}` : 'The radio'} is not answering OmniRig — check it is on, and the port and baud rate in OmniRig`,
};
// The helper's fatal errors, by the code it gives (omnirig_helper.cpp).
const HELPER_ERRORS = {
    'not-installed': () => 'OmniRig is not installed — get it from dxatlas.com/omnirig',
    'no-start': () => 'OmniRig is installed but would not start',
    'access-denied': () => 'Windows would not let UberSDR reach OmniRig — run both as administrator, or neither',
    'no-rig': (rig) => `OmniRig has no Rig ${rig}`,
    gone: () => 'OmniRig was closed or stopped answering',
};

// Modes, both ways. The data modes are shown but never pushed either way, as
// with rigctld: the receiver has no equivalent, and a sideband stand-in would
// drag the rig out of the mode somebody put it in. OmniRig has one FM, so
// nfm has no counterpart.
const OMNIRIG_TO_SDR = {
    [PM.SSB_U]: 'usb', [PM.SSB_L]: 'lsb',
    [PM.CW_U]: 'cwu', [PM.CW_L]: 'cwl',
    [PM.AM]: 'am', [PM.FM]: 'fm',
};
const SDR_TO_OMNIRIG = {
    usb: PM.SSB_U, lsb: PM.SSB_L,
    cwu: PM.CW_U, cwl: PM.CW_L,
    am: PM.AM, fm: PM.FM,
};
// What the panel shows for the rig's mode.
const MODE_NAME = {
    [PM.SSB_U]: 'USB', [PM.SSB_L]: 'LSB',
    [PM.CW_U]: 'CW', [PM.CW_L]: 'CWR',
    [PM.DIG_U]: 'DIG-U', [PM.DIG_L]: 'DIG-L',
    [PM.AM]: 'AM', [PM.FM]: 'FM',
};

// After the helper exits unasked. Slow, because the usual reason is OmniRig
// having been closed — and starting the helper again starts OmniRig again, which
// somebody who has just closed it may not want every second.
const RESTART_MS = 5000;
// How long a helper asked to quit gets before it is killed.
const QUIT_GRACE_MS = 2000;

const HELPER_NAME = 'omnirig-helper.exe';

/**
 * Where the helper is: beside app.asar once packaged (build.win.extraResources
 * in package.json), or where omnirig/build.sh leaves it when run from source.
 */
function defaultHelper() {
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, HELPER_NAME));
    candidates.push(path.join(__dirname, 'omnirig', 'dist', HELPER_NAME));
    const found = candidates.find((p) => fs.existsSync(p));
    return { command: found || candidates[0], args: [] };
}

/** A fatal error from the helper, in words. */
function helperErrorText({ code, message }, rig) {
    const say = HELPER_ERRORS[code];
    return say ? say(rig) : `OmniRig: ${message || code || 'unknown error'}`;
}

/**
 * A to A, B to B, anything else — the panel's 'current', or a blank typed into
 * a page too old for buttons — to the VFO the rig is receiving on.
 */
function normaliseVfo(vfo) {
    const v = String(vfo || '').trim().toUpperCase();
    return v === 'A' || v === 'B' ? v : '-';
}

// Vfo, as the receive VFO and, where it differs, the transmit one.
const VFO_TEXT = {
    [PM.VFOA]: 'A', [PM.VFOAA]: 'A',
    [PM.VFOB]: 'B', [PM.VFOBB]: 'B',
    [PM.VFOAB]: 'A, transmitting on B',
    [PM.VFOBA]: 'B, transmitting on A',
};

/** OmniRig packs its version as major in the high word, minor in the low. */
function versionText(v) {
    if (!(v > 0)) return null;
    return `${Math.floor(v / 0x10000)}.${String(v % 0x10000).padStart(2, '0')}`;
}

/** What a readable or writeable mask covers, in the terms the panel syncs. */
function abilities(mask, withTx) {
    const out = [];
    if (mask & (PM.FREQ | PM.FREQA | PM.FREQB)) out.push('frequency');
    if (mask & (PM.CW_U | PM.CW_L | PM.SSB_U | PM.SSB_L | PM.DIG_U | PM.DIG_L | PM.AM | PM.FM)) out.push('mode');
    if (withTx && (mask & (PM.RX | PM.TX))) out.push('TX');
    return out.length ? out.join(', ') : 'nothing';
}

/**
 * The model name. A slot with no radio chosen reports an empty RigType, which
 * is not a name.
 */
function rigName(msg) {
    const s = String(msg.rigType || '').trim();
    return s && s.toUpperCase() !== 'NONE' ? s : null;
}

/**
 * The lines under the readout in the full panel. Things the operator set up in
 * OmniRig and cannot see from here — which slot, which VFO is being followed,
 * what this rig's description lets it read and set — plus the live ones the
 * readout has no room for.
 */
function detailsFrom(msg, ctx) {
    const d = [{ label: 'OmniRig slot', value: `Rig ${ctx.rig}` }];
    if (msg.status === ST_ONLINE) {
        if (VFO_TEXT[msg.vfo]) d.push({ label: 'VFO', value: VFO_TEXT[msg.vfo] });
        d.push({
            label: 'Following',
            value: ctx.vfo === '-' ? 'the VFO it receives on' : `VFO ${ctx.vfo}`,
        });
        if (msg.split === PM.SPLITON) d.push({ label: 'Split', value: 'On' });
        else if (msg.split === PM.SPLITOFF) d.push({ label: 'Split', value: 'Off' });
        d.push({ label: 'Can read', value: abilities(msg.readable, true) });
        d.push({ label: 'Can set', value: abilities(msg.writeable, false) });
    }
    const version = versionText(ctx.softwareVersion);
    if (version) d.push({ label: 'OmniRig version', value: version });
    return d;
}

/**
 * A state line from the helper, as the state object every link reports.
 *
 * `ctx` is what the link knows that the line does not: the slot, the VFO
 * setting, and OmniRig's version from the helper's ready line.
 */
function stateFrom(msg, ctx) {
    const name = rigName(msg);
    const extra = { rig: name, details: detailsFrom(msg, ctx) };
    if (msg.status !== ST_ONLINE) {
        const say = STATUS_TEXT[msg.status];
        return {
            connected: false,
            tx: false,
            error: say ? say(ctx.rig, name) : `OmniRig: ${msg.statusText || `status ${msg.status}`}`,
            ...extra,
        };
    }
    return {
        connected: true,
        error: null,
        frequency: msg.freq > 0 ? msg.freq : null,
        mode: MODE_NAME[msg.mode] || null,
        sdrMode: OMNIRIG_TO_SDR[msg.mode] || null,
        tx: msg.tx === PM.TX,
        // A rig description with no TX status is a rig the panel should not
        // offer mute-on-transmit for — see rigctl.js.
        pttAvailable: (msg.readable & (PM.RX | PM.TX)) !== 0,
        ...extra,
    };
}

/** One live link to OmniRig: keeps the helper running, and does what it is told. */
class OmniRigLink {
    /**
     * @param {object} o
     * @param {number} o.rig      1 or 2 — OmniRig's Rig1 or Rig2
     * @param {string} [o.vfo]    'A', 'B', or anything else for the current VFO
     * @param {Function} o.onState
     * @param {{command: string, args: string[]}} [o.helper]  for the tests
     * @param {number} [o.restartMs]  likewise
     */
    constructor({ rig, vfo, onState, helper, restartMs = RESTART_MS }) {
        this.rig = Number(rig);
        this.vfo = normaliseVfo(vfo);
        this.onState = onState;
        this.helper = helper || defaultHelper();
        this.restartMs = restartMs;
        this.child = null;
        this.ready = false;
        this.softwareVersion = 0;
        this.stopped = false;
        this.timer = null;
        // The last error reported, so one that persists is said once rather
        // than every time the helper is restarted into it.
        this.lastError = null;
        // What the helper said before it died, which is the useful half of an
        // exit — "not installed" rather than "exited with code 2".
        this.helperError = null;
    }

    start() {
        if (this.rig !== 1 && this.rig !== 2) {
            this.report({ connected: false, tx: false, error: 'OmniRig has only Rig 1 and Rig 2 — set Rig to 1 or 2' });
            return;
        }
        this.launch();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.timer = null;
        const child = this.child;
        this.child = null;
        this.ready = false;
        if (!child) return;
        // Asked first, so it lets go of OmniRig properly; killed if it will not.
        const kill = setTimeout(() => child.kill(), QUIT_GRACE_MS);
        child.once('exit', () => clearTimeout(kill));
        try { child.stdin.end('quit\n'); } catch { child.kill(); }
    }

    launch() {
        if (this.stopped) return;
        this.helperError = null;
        let child;
        try {
            child = spawn(this.helper.command, [...this.helper.args, String(this.rig), this.vfo], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            this.failed(err);
            return;
        }
        this.child = child;

        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let at;
            while ((at = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, at).trim();
                buffer = buffer.slice(at + 1);
                if (line) this.onLine(line);
            }
        });
        // Read and dropped: an unread pipe fills, and a helper blocked writing
        // to it stops answering.
        child.stderr.resume();
        // A write to a helper that has just died is reported by 'exit'.
        child.stdin.on('error', () => {});
        child.on('error', (err) => {
            if (this.child !== child) return;
            this.failed(err);
        });
        // 'close' rather than 'exit': exit can come before the last of stdout
        // has been read, and the last line is the error that says why.
        child.on('close', (code) => {
            if (this.child !== child) return;
            this.child = null;
            this.ready = false;
            if (this.stopped) return;
            this.report({
                connected: false,
                tx: false,
                error: this.helperError || `OmniRig support stopped unexpectedly (exit code ${code})`,
            });
            this.timer = setTimeout(() => this.launch(), this.restartMs);
        });
    }

    /** The helper could not be run at all. */
    failed(err) {
        this.child = null;
        this.ready = false;
        if (this.stopped) return;
        const error = err && err.code === 'ENOENT'
            ? `OmniRig support is missing from this build (${HELPER_NAME} not found) — reinstall UberSDR`
            : `OmniRig support could not start (${err.message})`;
        this.report({ connected: false, tx: false, error });
        // Nothing to retry: a missing file does not appear by itself.
        if (err && err.code === 'ENOENT') return;
        this.timer = setTimeout(() => this.launch(), this.restartMs);
    }

    onLine(line) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
        case 'ready':
            this.ready = true;
            this.softwareVersion = Number(msg.softwareVersion) || 0;
            break;
        case 'state':
            this.report(stateFrom(msg, { rig: this.rig, vfo: this.vfo, softwareVersion: this.softwareVersion }));
            break;
        case 'error':
            // Fatal to the helper, which exits next; kept for that report.
            this.helperError = helperErrorText(msg, this.rig);
            break;
        default:
            // 'warn' — a command refused. Not the link's health, which the next
            // state line says.
            break;
        }
    }

    report(state) {
        if (this.stopped) return;
        // A connected state always goes through; only failures are collapsed,
        // once per spell, as the other links do.
        if (!state.connected) {
            if (state.error === this.lastError) return;
            this.lastError = state.error;
        } else {
            this.lastError = null;
        }
        this.onState(state);
    }

    send(line) {
        if (!this.child || !this.ready) return Promise.reject(new Error('OmniRig is not connected'));
        this.child.stdin.write(line + '\n');
        return Promise.resolve();
    }

    setFrequency(hz) {
        const n = Math.round(Number(hz));
        if (!(n > 0)) return Promise.reject(new Error(`bad frequency: ${hz}`));
        return this.send(`freq ${n}`);
    }

    setMode(sdrMode) {
        const mode = SDR_TO_OMNIRIG[sdrMode];
        // A mode the pair does not share is not an error — see the table above.
        if (!mode) return Promise.resolve(false);
        return this.send(`mode ${mode}`).then(() => true);
    }
}

module.exports = {
    OmniRigLink, PM, OMNIRIG_TO_SDR, SDR_TO_OMNIRIG, MODE_NAME, stateFrom, detailsFrom, helperErrorText,
    normaliseVfo, versionText, defaultHelper,
};
