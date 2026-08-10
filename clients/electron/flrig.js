'use strict';

// flrig, over XML-RPC.
//
// flrig serves XML-RPC on http://host:port/RPC2 and sends no CORS headers, so
// no page can talk to it however hard it tries — this has to be the main
// process. The receiver window's preload registers a "flrig" transport with the
// Radio Control panel over the page API and relays between the two; see
// receiver-preload.js.
//
// The wire format is the same handful of calls the Chrome extension makes
// (clients/chrome-bridge), because it is the same rig control: rig.get_vfo,
// rig.set_vfo, rig.get_mode, rig.set_mode, rig.get_ptt.

const http = require('http');

// flrig answers locally and instantly; a poll that has not come back by now is
// a flrig that has gone away, and waiting longer only delays saying so.
const TIMEOUT_MS = 4000;

// How often the rig is read. flrig itself polls the radio over CAT, so asking
// faster than this buys nothing and adds serial traffic the operator's own
// logging software is competing for.
const POLL_MS = 500;

// Mode names, both ways. flrig speaks the rig's own vocabulary and the receiver
// speaks v2's; the pairs that have no counterpart are simply absent, and a rig
// sitting in one of them is shown but not pushed either way.
const FLRIG_TO_SDR = {
    USB: 'usb', LSB: 'lsb',
    CW: 'cwu', CWR: 'cwl', CWL: 'cwl',
    AM: 'am', SAM: 'sam',
    FM: 'fm', NFM: 'nfm', WFM: 'fm',
};
const SDR_TO_FLRIG = {
    usb: 'USB', lsb: 'LSB',
    cwu: 'CW', cwl: 'CWR',
    am: 'AM', sam: 'SAM',
    fm: 'FM', nfm: 'NFM',
};

const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function encodeParam(p) {
    if (p !== null && typeof p === 'object' && p.__type) {
        return `<param><value><${p.__type}>${escapeXml(p.value)}</${p.__type}></value></param>`;
    }
    if (typeof p === 'number') {
        return Number.isInteger(p)
            ? `<param><value><int>${p}</int></value></param>`
            : `<param><value><double>${p}</double></value></param>`;
    }
    return `<param><value><string>${escapeXml(p)}</string></value></param>`;
}

/**
 * The reply, as the one value it carries.
 *
 * Regex rather than a parser, as the extension does: these are flrig's own
 * replies, which are a single scalar in a fixed shape, and a dependency for
 * that would be a dependency this client otherwise does not have.
 */
function parseResponse(xml) {
    if (/<fault>/.test(xml)) {
        const m = xml.match(/<name>faultString<\/name>\s*<value><string>([^<]*)<\/string>/);
        throw new Error(m ? m[1] : 'XML-RPC fault');
    }
    let m = xml.match(/<value><double>([^<]*)<\/double><\/value>/);
    if (m) return parseFloat(m[1]);
    m = xml.match(/<value><(?:int|i4)>([^<]*)<\/(?:int|i4)><\/value>/);
    if (m) return parseInt(m[1], 10);
    m = xml.match(/<value><boolean>([^<]*)<\/boolean><\/value>/);
    if (m) return m[1] === '1';
    m = xml.match(/<value><string>([^<]*)<\/string><\/value>/);
    if (m) return m[1];
    m = xml.match(/<value>([^<]+)<\/value>/);
    return m ? m[1] : null;
}

function call(host, port, method, params = []) {
    const body = '<?xml version="1.0"?><methodCall>'
        + `<methodName>${method}</methodName>`
        + `<params>${params.map(encodeParam).join('')}</params>`
        + '</methodCall>';

    return new Promise((resolve, reject) => {
        const req = http.request({
            host,
            port,
            path: '/RPC2',
            method: 'POST',
            headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) },
            timeout: TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                try { resolve(parseResponse(Buffer.concat(chunks).toString('utf8'))); }
                catch (err) { reject(err); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('flrig did not answer')));
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * One live link to flrig: polls it, and takes settings from the receiver.
 *
 * The sync itself is not here — this reports what the rig is doing and does
 * what it is told. Which way the sync runs is the panel's setting, and applying
 * it is the preload's job, because that is the side holding a bridge client
 * that can tune the receiver.
 */
class FlrigLink {
    constructor({ host, port, onState }) {
        this.host = host;
        this.port = port;
        this.onState = onState;
        this.timer = null;
        this.stopped = false;
        // Reported once per transition rather than every failed poll, so a
        // flrig that is not running does not fill the panel with one message
        // per half second.
        this.failing = false;
    }

    start() {
        this.poll();
        this.timer = setInterval(() => this.poll(), POLL_MS);
    }

    stop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = null;
    }

    async poll() {
        if (this.stopped) return;
        try {
            // Sequential, not parallel: flrig serialises requests onto one CAT
            // link, and three at once simply queue inside it with a worse
            // chance of one timing out.
            const freq = await call(this.host, this.port, 'rig.get_vfo');
            const mode = await call(this.host, this.port, 'rig.get_mode');
            const ptt = await call(this.host, this.port, 'rig.get_ptt');
            if (this.stopped) return;
            this.failing = false;
            this.onState({
                connected: true,
                error: null,
                frequency: Math.round(parseFloat(freq)) || null,
                mode: String(mode || ''),
                sdrMode: FLRIG_TO_SDR[String(mode || '').toUpperCase()] || null,
                tx: !!ptt,
            });
        } catch (err) {
            if (this.stopped || this.failing) return;
            this.failing = true;
            this.onState({ connected: false, tx: false, error: `flrig: ${err.message}` });
        }
    }

    setFrequency(hz) {
        return call(this.host, this.port, 'rig.set_vfo', [{ __type: 'double', value: Number(hz) }]);
    }

    setMode(sdrMode) {
        const mode = SDR_TO_FLRIG[sdrMode];
        // A mode the rig has no equivalent for is not an error — it is a mode
        // this pair does not share, and forcing the nearest one would drag the
        // rig somewhere nobody asked for.
        if (!mode) return Promise.resolve(false);
        return call(this.host, this.port, 'rig.set_mode', [mode]).then(() => true);
    }
}

module.exports = { FlrigLink, FLRIG_TO_SDR, SDR_TO_FLRIG, call, parseResponse, encodeParam };
