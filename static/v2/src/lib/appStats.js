// What this app is costing the machine it is running on — when there is a host
// that can say.
//
// The stats readout already answers "is this machine keeping up?" with FPS, and
// then has nowhere to say why. A receiver that has been open for six hours with
// a waterfall, an audio graph, a recorder and four decoders is a plausible
// answer, and on a phone it is the difference between "this receiver is slow"
// and "this app is eating the battery" — two complaints with nothing in common
// except how they look from the corner of the screen.
//
// ── Why this cannot come from the page ───────────────────────────────────────
//
// There is no browser API for it. Chrome's `performance.memory` is the
// JavaScript heap, which on this page is a minority of what the tab costs — the
// canvases, the decoded audio, the WebGL textures and the workers are all
// outside it — and there is nothing at all for CPU. Reporting the heap as "the
// app" would be a number that is always wrong and always reassuring.
//
// So it is the host's to answer, and only the hosts that are a whole
// application can: the Android and iOS clients (clients/capacitor) and the
// desktop client (clients/electron), each of which can ask the operating system
// about its own process. In an ordinary browser tab the line is simply absent,
// which is the honest answer rather than a blank or a zero.
//
// ── The contract ─────────────────────────────────────────────────────────────
//
//     window.ubersdrAppStats = {
//         read() { return { cpu: 12.4, mem: 193000000 } | null; }
//     }
//
// `cpu` is a percentage of one core's worth of time, as every system monitor
// reports it, so a machine with eight cores can legitimately show more than
// 100. `mem` is bytes of real memory — the figure the OS would blame this
// process for, not the address space it has reserved.
//
// **Pull, not push.** `read()` is synchronous and returns the last thing the
// host measured; asking is what tells the host to measure again, and the answer
// arrives in time for the next call a second later. That is why nothing here
// subscribes: the readout is off by default, and a host that is never asked
// never does the work. A push would have every client sampling /proc once a
// second for a display almost nobody has open.
//
// A second-old reading is exactly right for this. CPU is a rate and has to be
// averaged over an interval to mean anything, and memory that moved in the last
// second has not moved by much.

/** The host's last reading, or null where there is no host to ask. */
export function readAppStats() {
    try {
        const host = typeof window !== 'undefined' ? window.ubersdrAppStats : null;
        if (!host || typeof host.read !== 'function') return null;
        const s = host.read();
        if (!s) return null;
        // Taken apart rather than passed through, so a host that answers with
        // extra fields, strings, or a NaN from a counter that has not been read
        // twice yet cannot put any of that on screen.
        const cpu = Number(s.cpu);
        const mem = Number(s.mem);
        const out = {};
        if (Number.isFinite(cpu) && cpu >= 0) out.cpu = cpu;
        if (Number.isFinite(mem) && mem > 0) out.mem = mem;
        return out.cpu == null && out.mem == null ? null : out;
    } catch (e) {
        return null;
    }
}
