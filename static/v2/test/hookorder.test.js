// A hook whose dependency array names a `const` declared further down.
//
// Two of these shipped in one afternoon, and neither the bundler nor
// unresolved.js can see them: a `const` referenced above its own declaration is
// valid syntax and a valid module, and throws "can't access lexical declaration
// before initialization" the first time the component renders. The usual shape
// is a hook whose dependency array names a callback declared further down —
// dependency arrays are evaluated at render time, not when the effect runs.
//
// Narrow by design: what is checked is what the render itself evaluates, against
// component-body `const` declarations in the same function. A name used inside a
// callback body is fine however far up it appears — the body runs later — so
// widening past that would flag a page of legal code and be turned off.
//
// Two places qualify. A hook's dependency array, which is built at render time
// however late the effect runs. And the head of a plain body `const` — the part
// of its initialiser before any `=>`, which is the part evaluated on the spot.
// The second was added after a group menu shipped with
//     const openGroup = panel ? ... : null;
//     const panel = ...;
// which is not a hook, passed this test, and turned every phone black on load.
// Desktop never renders that component, so it looked like a mobile-only fault
// rather than a line in the wrong order.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.jsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

// Comments and string bodies out, line count preserved so numbers still line up.
function blank(line) {
    return line
        .replace(/`[^`\n]*`/g, '``')
        .replace(/'[^'\n]*'/g, "''")
        .replace(/"[^"\n]*"/g, '""')
        .replace(/\/\/.*$/, '')
        .replace(/^\s*\*.*$/, '')
        .replace(/\/\*.*?\*\//g, '');
}

const problems = [];

for (const file of walk(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').map(blank);

    // Function boundaries at column 0: `function X(` or `export default function`.
    const starts = [];
    lines.forEach((l, i) => { if (/^(export\s+)?(default\s+)?function\s/.test(l)) starts.push(i); });
    starts.push(lines.length);

    for (let f = 0; f < starts.length - 1; f++) {
        const from = starts[f];
        const to = starts[f + 1];
        const decl = new Map();          // name → line it is declared on
        for (let i = from; i < to; i++) {
            const m = lines[i].match(/^ {4}const\s+([A-Za-z_$][\w$]*)\s*=/);
            if (m) decl.set(m[1], i);
        }
        // A plain body const whose initialiser reads one declared further down.
        //
        // Only up to the first arrow: everything after it is a function body,
        // which runs when it is called rather than now. `groups.find((g) => ...)`
        // is therefore checked as far as `groups`, which is exactly the part that
        // has to exist already — the call happens during the render even though
        // the callback it takes does not close over anything yet.
        for (let i = from; i < to; i++) {
            const m = lines[i].match(/^ {4}const\s+[A-Za-z_$][\w$]*\s*=\s*(.*)$/);
            if (!m) continue;
            // A const that *is* a function is not evaluated now, and its
            // parameter list is not a set of references — `const f = (img) => …`
            // says nothing about anything declared anywhere.
            if (/^(async\s+)?(function\b|\(?[\w$,\s]*\)?\s*=>)/.test(m[1])) continue;
            const head = m[1].split('=>')[0]
                // Property names are not bindings, neither the `.id` kind nor
                // the `{ id: … }` kind.
                .replace(/\.\s*[A-Za-z_$][\w$]*/g, '')
                .replace(/[A-Za-z_$][\w$]*\s*:/g, '');
            for (const name of head.match(/[A-Za-z_$][\w$]*/g) || []) {
                const at = decl.get(name);
                if (at !== undefined && at > i) {
                    problems.push(`${path.relative(SRC, file)}:${i + 1}: `
                        + `\`${name}\` is read here and declared below, at line ${at + 1}`);
                }
            }
        }

        // Dependency arrays: the closing line of a hook call, or an inline one.
        for (let i = from; i < to; i++) {
            const m = lines[i].match(/^\s*(?:\}|\)),\s*\[([^\]]*)\]\s*\)/)
                || lines[i].match(/use(?:Effect|Memo|Callback|LayoutEffect)\([^)]*\)\s*,\s*\[([^\]]*)\]\s*\)/);
            if (!m) continue;
            for (const raw of m[1].split(',')) {
                const name = raw.trim().split('.')[0];
                if (!name) continue;
                const at = decl.get(name);
                if (at !== undefined && at > i) {
                    problems.push(`${path.relative(SRC, file)}:${i + 1}: `
                        + `dependency \`${name}\` is declared below it, at line ${at + 1}`);
                }
            }
        }
    }
}

if (problems.length) {
    console.log('FAIL  nothing evaluated during a render reads a const declared below it');
    for (const p of problems) console.log('      ' + p);
    process.exitCode = 1;
} else {
    console.log('ok    nothing evaluated during a render reads a const declared below it');
}
