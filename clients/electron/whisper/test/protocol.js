// The helper's protocol from the Node side, for the tests: frames out, JSON
// lines in, every line timestamped so a test can ask what arrived after what.
//
// The wire is documented at the top of ../whisper_helper.cpp.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRAME = { START: 1, AUDIO: 2, RESET: 3, STOP: 4 };
const RATE = 16000;

const HERE = __dirname;
const DIST = path.join(HERE, '..', 'dist');

function platformDir() {
    const os = { linux: 'linux', win32: 'win', darwin: 'darwin' }[process.platform] || process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return os === 'darwin' ? 'darwin-universal' : `${os}-${arch}`;
}

// WHISPER_HELPER_WRAPPER runs the helper through another program — `wine`, to
// drive the Windows build from Linux.
const WRAPPER = process.env.WHISPER_HELPER_WRAPPER || '';

const paths = {
    helper: process.env.WHISPER_HELPER ||
        path.join(DIST, platformDir(), process.platform === 'win32' ? 'whisper-helper.exe' : 'whisper-helper'),
    model: process.env.WHISPER_MODEL || path.join(DIST, 'models', 'ggml-base-q5_1.bin'),
    vad: process.env.WHISPER_VAD_MODEL || path.join(DIST, 'models', 'ggml-silero-v6.2.0.bin'),
};

function frame(type, payload) {
    const body = payload ? Buffer.from(payload.buffer ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : payload) : Buffer.alloc(0);
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32LE(body.length, 1);
    return Buffer.concat([head, body]);
}

class Helper {
    constructor({ args, env, helper = paths.helper } = {}) {
        this.t0 = Date.now();
        this.lines = [];      // { t, msg } — t in ms since spawn
        this.stderr = '';
        this.waiters = [];
        const argv = args || ['--model', paths.model, '--vad-model', paths.vad];
        this.proc = spawn(WRAPPER || helper, WRAPPER ? [helper, ...argv] : argv,
            { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(env || {}) } });
        let buf = '';
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { msg = { type: 'unparseable', line }; }
                this.lines.push({ t: this.now(), msg });
                this.poke();
            }
        });
        this.proc.stderr.setEncoding('utf8');
        this.proc.stderr.on('data', (d) => { this.stderr += d; });
        // Writing to a helper that has exited is the test's business to notice
        // through exit codes, not a crash of the test runner.
        this.proc.stdin.on('error', () => {});
        this.exited = new Promise((resolve) => {
            this.proc.on('exit', (code, signal) => { this.exitInfo = { code, signal, t: this.now() }; this.poke(); resolve(this.exitInfo); });
        });
    }

    now() { return Date.now() - this.t0; }

    poke() {
        const w = this.waiters;
        this.waiters = [];
        for (const f of w) f();
    }

    send(type, payload) { this.proc.stdin.write(frame(type, payload)); }
    start(lang, session) { this.send(FRAME.START, Buffer.from(JSON.stringify({ lang, session }))); }
    audio(pcm) { this.send(FRAME.AUDIO, pcm); }
    reset() { this.send(FRAME.RESET); }
    stop() { this.send(FRAME.STOP); }
    end() { this.proc.stdin.end(); }
    kill() { try { this.proc.kill('SIGKILL'); } catch (e) { /* gone */ } }

    messages(pred) { return this.lines.filter((l) => !pred || pred(l.msg, l.t)); }

    // The first line matching `pred` (from index `from`), waiting up to `ms`.
    waitFor(pred, ms, what, from = 0) {
        return new Promise((resolve, reject) => {
            const end = Date.now() + ms;
            const check = () => {
                for (let i = from; i < this.lines.length; i++) {
                    if (pred(this.lines[i].msg, this.lines[i].t)) return resolve(this.lines[i]);
                }
                if (this.exitInfo) return reject(new Error(`helper exited (${JSON.stringify(this.exitInfo)}) waiting for ${what}\n${this.stderr.slice(-2000)}`));
                if (Date.now() > end) return reject(new Error(`timed out waiting for ${what}`));
                this.waiters.push(check);
                setTimeout(check, Math.min(250, Math.max(1, end - Date.now())));
            };
            check();
        });
    }

    // `pcm` in 100 ms pieces, the way the page sends it, `speed` times real
    // time (Infinity: all at once).
    async play(pcm, speed = 1) {
        const step = RATE / 10;
        const begin = Date.now();
        for (let i = 0; i < pcm.length; i += step) {
            this.audio(pcm.subarray(i, Math.min(pcm.length, i + step)));
            if (Number.isFinite(speed)) {
                const due = begin + ((i + step) / RATE) * 1000 / speed;
                const wait = due - Date.now();
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            }
        }
    }
}

// A 16-bit PCM WAV as Int16Array. Mono at 16 kHz is all the helper takes, so
// anything else is refused rather than converted.
function readWav(file) {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV`);
    let off = 12, fmt = null;
    while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const size = b.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
        if (id === 'data') {
            if (!fmt || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`${file}: need 16 kHz mono 16-bit, got ${JSON.stringify(fmt)}`);
            const n = Math.floor(Math.min(size, b.length - off - 8) / 2);
            const out = new Int16Array(n);
            for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2);
            return out;
        }
        off += 8 + size + (size & 1);
    }
    throw new Error(`${file}: no data chunk`);
}

const silence = (seconds) => new Int16Array(Math.round(seconds * RATE));

// Band noise at about -38 dBFS RMS, the level measured between signals on the
// air: Gaussian, so the VAD has to tell it from speech.
function noise(seconds, rmsDb = -38, seed = 1) {
    const n = Math.round(seconds * RATE);
    const out = new Int16Array(n);
    const amp = 32768 * Math.pow(10, rmsDb / 20);
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
    for (let i = 0; i < n; i++) {
        const g = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
        out[i] = Math.max(-32768, Math.min(32767, Math.round(g * amp)));
    }
    return out;
}

function concat(...parts) {
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

module.exports = { Helper, FRAME, RATE, paths, frame, readWav, silence, noise, concat };
