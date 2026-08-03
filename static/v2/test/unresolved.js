// Catches a bug esbuild will not: using a name that another module exports
// without importing it here.
//
// Bundling leaves an unknown identifier alone, assuming it is a browser global,
// so the build succeeds and the panel throws "X is not defined" the moment it
// renders. That is exactly how `S_UNITS_MIN` shipped broken. Nothing in the
// protocol tests exercises the React tree, so this is a static check instead.
//
// Deliberate free globals (v1 classic scripts loaded at runtime) are listed in
// ALLOWED — they are always reached through `typeof X !== 'undefined'`.

const fs = require('fs');
const path = require('path');

const ALLOWED = new Set(['RotatorDisplay']);

const SRC = path.join(__dirname, '..', 'src');

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (/\.jsx?$/.test(entry.name)) out.push(p);
    }
    return out;
}

// Strip comments and string/template literals so a name mentioned in prose or
// in a class name does not count as a use.
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, '``')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const files = walk(SRC);

// Every name our own modules export.
const exported = new Set();
for (const file of files) {
    const src = code(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/export\s+(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
        exported.add(m[1]);
    }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const n of m[1].split(',')) {
            const name = n.trim().split(/\s+as\s+/).pop().trim();
            if (name) exported.add(name);
        }
    }
}

const problems = [];
for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = code(raw);

    const imported = new Set();
    for (const m of src.matchAll(/import\s+([\s\S]+?)\s+from/g)) {
        const clause = m[1];
        const braced = clause.match(/\{([\s\S]*)\}/);
        for (const n of (braced ? braced[1] : '').split(',')) {
            const name = n.trim().split(/\s+as\s+/).pop().trim();
            if (name) imported.add(name);
        }
        const dflt = clause.replace(/\{[\s\S]*\}/, '').split(',')[0].trim();
        if (dflt && dflt !== '*') imported.add(dflt);
    }

    const declared = new Set(
        [...src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    );

    const body = src.replace(/^\s*import[\s\S]*?from\s*[^\n]*$/gm, '');
    for (const name of exported) {
        if (imported.has(name) || declared.has(name) || ALLOWED.has(name)) continue;
        const used = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body);
        if (used) problems.push(`${path.relative(SRC, file)}: uses ${name} without importing it`);
    }
}

if (problems.length) {
    for (const p of problems) console.error('FAIL  ' + p);
    process.exit(1);
}
console.log(`ok    no unresolved cross-module identifiers (${files.length} files)`);
