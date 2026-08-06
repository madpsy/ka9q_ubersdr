// A hook whose dependency array names a `const` declared further down.
//
// Two of these shipped in one afternoon, and neither the bundler nor
// unresolved.js can see them: a `const` referenced above its own declaration is
// valid syntax and a valid module, and throws "can't access lexical declaration
// before initialization" the first time the component renders. The usual shape
// is a hook whose dependency array names a callback declared further down —
// dependency arrays are evaluated at render time, not when the effect runs.
//
// Narrow by design: only dependency arrays are checked, against component-body
// `const` declarations in the same function. A name used inside a callback body
// is fine however far up it appears — the body runs later — so widening this
// would flag a page of legal code and be turned off. The dependency array is the
// one place a later `const` is read during the render itself.

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
    console.log('FAIL  no hook depends on a const declared below it');
    for (const p of problems) console.log('      ' + p);
    process.exitCode = 1;
} else {
    console.log('ok    no hook depends on a const declared below it');
}
