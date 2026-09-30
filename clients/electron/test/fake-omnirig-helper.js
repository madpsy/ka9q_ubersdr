'use strict';

// A stand-in for omnirig-helper.exe, for omnirig.test.js: the same stdin and
// stdout protocol, with the rig kept in memory.
//
//   node fake-omnirig-helper.js <scenario> <log> <rig> <vfo>
//
// Scenarios:
//   online         an IC-7300 on line on 14.074 MHz USB; freq and mode commands stick
//   offline        status 3 (not responding) and nothing else
//   not-installed  the error the real helper gives without OmniRig, then exit 2
//   gone           on line, then OmniRig "goes away" after 100 ms: exit 3
//
// Every start and every command is appended to <log> as a JSON line, so the
// test can see what the link actually sent. A file per link, because a helper
// told to quit may still be writing when the next test begins.

const fs = require('fs');

const [scenario, logFile, rig, vfo] = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
const say = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

log({ start: scenario, rig, vfo });

const PM_RX = 0x00200000;
const PM_TX = 0x00400000;
const MODES = 0x7f800000;
const state = {
    type: 'state', status: 4, statusText: 'On-line', rigType: 'IC-7300', freq: 14074000, mode: 0x02000000,
    tx: PM_RX, vfo: 0x80, split: 0x10000, readable: 0x2 | PM_RX | PM_TX | MODES, writeable: 0x2 | MODES,
};

if (scenario === 'not-installed') {
    say({ type: 'error', code: 'not-installed', message: 'OmniRig.OmniRigX is not registered' });
    process.exit(2);
}

say({ type: 'ready', rig: Number(rig), interfaceVersion: 257, softwareVersion: 65556 });
if (scenario === 'offline') {
    say({ ...state, status: 3, statusText: 'Rig is not responding', freq: 0, mode: 0, tx: 0 });
} else {
    say(state);
}
if (scenario === 'gone') {
    setTimeout(() => {
        say({ type: 'error', code: 'gone', message: 'OmniRig stopped answering' });
        process.exit(3);
    }, 100);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        log({ command: line });
        const [word, arg] = line.split(' ');
        if (word === 'quit') process.exit(0);
        if (word === 'freq') { state.freq = Number(arg); say(state); }
        if (word === 'mode') { state.mode = Number(arg); say(state); }
    }
});
// End of input is a quit, as it is for the real helper.
process.stdin.on('end', () => process.exit(0));
