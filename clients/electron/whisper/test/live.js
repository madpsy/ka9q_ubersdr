// A live receiver through the helper, in real time, with the clock running.
//
//   node live.js [seconds] [log.jsonl]
//
// Plays a broadcast off the air into the helper exactly as the page would —
// 16 kHz PCM16 in 100 ms frames, as it arrives — and prints every result with
// the time it came, the helper's own account of each decode (--verbose), and
// what it cost: CPU every five seconds and the peak memory at the end. Linux
// only, for /proc.
//
// The audio comes from clients/python/radio_client.py through sox; the same
// UBERSDR_* and PYTHON variables as record.sh choose the receiver, and
// WHISPER_HELPER / WHISPER_MODEL / WHISPER_VAD_MODEL / WHISPER_THREADS the
// helper. Not part of run.sh: what is on the air is not a fixture.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Helper, RATE, paths } = require('./protocol.js');

const SECONDS = Number(process.argv[2] || 60);
const LOG = process.argv[3] || null;
const URL = process.env.UBERSDR_URL || 'ws://44.31.241.7:8080/ws';
const FREQ = process.env.UBERSDR_FREQ || '909000';
const MODE = process.env.UBERSDR_MODE || 'am';
// What radio_client.py writes for AM; see record.sh.
const IN_RATE = process.env.UBERSDR_RATE || '24000';
const PY = process.env.PYTHON || 'python3';
const CLIENT = path.resolve(__dirname, '../../../python/radio_client.py');
const TICK = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));

const args = ['--model', paths.model, '--vad-model', paths.vad, '--verbose'];
if (process.env.WHISPER_THREADS) args.push('--threads', process.env.WHISPER_THREADS);
const h = new Helper({ args });
const log = LOG ? fs.createWriteStream(LOG) : null;
const stamp = () => (h.now() / 1000).toFixed(1).padStart(6);
const record = (o) => { if (log) log.write(JSON.stringify({ t: h.now(), ...o }) + '\n'); };

// The helper's stderr, line by line, timestamped.
let errBuf = '';
const decodes = { interim: [], final: [] };
h.proc.stderr.on('data', (d) => {
    errBuf += d;
    let nl;
    while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl);
        errBuf = errBuf.slice(nl + 1);
        if (!line.startsWith('whisper-helper:')) continue;
        const m = /(interim|final)\s+([\d.]+) s audio.*-> ([\d.]+) s/.exec(line);
        if (m) decodes[m[1]].push({ audio: Number(m[2]), took: Number(m[3]) });
        console.log(`${stamp()}   · ${line.slice(16)}`);
        record({ stderr: line });
    }
});

function cpuTicks(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return Number(f[11]) + Number(f[12]);  // utime + stime
    } catch (e) { return null; }
}
function peakRss(pid) {
    try { return /VmHWM:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1] / 1024; } catch (e) { return null; }
}

(async () => {
    await h.waitFor((m) => m.type === 'ready', 15000, 'ready');
    h.start(process.env.WHISPER_LANG || 'en', 1);
    await h.waitFor((m) => m.type === 'started', 5000, 'started');
    console.log(`${stamp()}  live from ${URL} ${FREQ} Hz ${MODE}, ${SECONDS} s`);

    const radio = spawn(PY, [CLIENT, '--no-gui', '-u', URL, '-f', FREQ, '-m', MODE, '-o', 'stdout'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const sox = spawn('sox', ['-t', 'raw', '-r', IN_RATE, '-e', 'signed', '-b', '16', '-c', '1', '-',
        '-t', 'raw', '-r', String(RATE), '-e', 'signed', '-b', '16', '-c', '1', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    radio.stdout.pipe(sox.stdin);
    sox.stdin.on('error', () => {});

    // 100 ms frames, as the page's Pcm16Batcher sends them.
    const FRAME = RATE / 10 * 2;
    let pending = Buffer.alloc(0);
    let sent = 0;
    sox.stdout.on('data', (d) => {
        pending = Buffer.concat([pending, d]);
        while (pending.length >= FRAME) {
            h.audio(pending.subarray(0, FRAME));
            pending = pending.subarray(FRAME);
            sent += FRAME / 2;
        }
    });

    let seen = 0;
    const printer = setInterval(() => {
        for (; seen < h.lines.length; seen++) {
            const { t, msg } = h.lines[seen];
            record({ out: msg });
            const at = (t / 1000).toFixed(1).padStart(6);
            if (msg.type === 'result') console.log(`${at}  ${msg.final ? 'FINAL  ' : 'interim'} ${msg.text}`);
            else console.log(`${at}  ${JSON.stringify(msg)}`);
        }
    }, 50);

    const pid = h.proc.pid;
    const cpu = [];
    let lastTicks = cpuTicks(pid), lastAt = Date.now();
    const sampler = setInterval(() => {
        const ticks = cpuTicks(pid), at = Date.now();
        if (ticks == null) return;
        const pct = ((ticks - lastTicks) / TICK) / ((at - lastAt) / 1000) * 100;
        cpu.push(pct);
        console.log(`${stamp()}   cpu ${pct.toFixed(0).padStart(4)} % of one core, ${(sent / RATE).toFixed(0)} s of audio sent`);
        record({ cpu: pct, audio: sent / RATE });
        lastTicks = ticks; lastAt = at;
    }, 5000);

    const startTicks = cpuTicks(pid), startAt = Date.now();
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    const endTicks = cpuTicks(pid), endAt = Date.now();
    radio.kill();
    sox.kill();
    clearInterval(sampler);
    const rss = peakRss(pid);
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(printer);
    for (; seen < h.lines.length; seen++) record({ out: h.lines[seen].msg });
    h.end();
    await h.exited;

    const results = h.messages((m) => m.type === 'result');
    const stat = (xs) => xs.length ? `mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)} s, max ${Math.max(...xs).toFixed(2)} s` : 'none';
    const summary = {
        audioSeconds: +(sent / RATE).toFixed(1),
        finals: results.filter((r) => r.msg.final).length,
        interims: results.filter((r) => !r.msg.final).length,
        errors: h.messages((m) => m.type === 'error').map((l) => l.msg),
        cpuMeanPercentOfOneCore: +(((endTicks - startTicks) / TICK) / ((endAt - startAt) / 1000) * 100).toFixed(0),
        cpuPeak5sPercent: cpu.length ? +Math.max(...cpu).toFixed(0) : null,
        peakRssMB: rss && +rss.toFixed(0),
    };
    console.log('\nsummary');
    console.log(`  ${summary.audioSeconds} s of audio: ${summary.finals} finals, ${summary.interims} interims, ${summary.errors.length} errors`);
    console.log(`  final decodes:   ${decodes.final.length}, ${stat(decodes.final.map((d) => d.took))} (utterances ${stat(decodes.final.map((d) => d.audio))})`);
    console.log(`  interim decodes: ${decodes.interim.length}, ${stat(decodes.interim.map((d) => d.took))}`);
    console.log(`  CPU ${summary.cpuMeanPercentOfOneCore} % of one core on average, ${summary.cpuPeak5sPercent} % at the busiest 5 s; peak RSS ${summary.peakRssMB} MB`);
    record({ summary });
    if (log) log.end();
})().catch((e) => { console.error(e); h.kill(); process.exit(1); });
