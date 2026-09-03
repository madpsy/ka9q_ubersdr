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
// Every literal matcher here is line-bounded on purpose. A multi-line-capable
// template-literal pattern went runaway on an unpaired backtick and silently
// swallowed half of ui.jsx — including the very usage this file exists to
// catch. Templates and strings in this codebase never span lines, so refusing
// to cross one costs nothing and cannot delete real code.
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/`[^`\n]*`/g, '``')
        .replace(/'[^'\n]*'/g, "''")
        .replace(/"[^"\n]*"/g, '""');
}

// The names a destructuring pattern binds.
//
// `{ a, b: renamed, c = 1, ...rest }` binds a, renamed, c and rest. Aliases bind
// the right-hand name, defaults are not part of the name, and a rest element
// drops its dots.
function namesIn(inner) {
    const out = [];
    for (const part of inner.split(',')) {
        const name = part
            .split(':').pop()       // `b: renamed` binds renamed
            .split('=')[0]          // `c = 1` binds c
            .replace(/\.\.\./, '')  // `...rest` binds rest
            .trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
    }
    return out;
}

// Every destructuring pattern that introduces names into a scope.
//
// Three shapes, and the third is the one this check was missing. A component
// taking its props apart in its parameter list -- `function VfoRow({ gateOpen,
// … })` -- binds those names as surely as a `const` does, but read as a use it
// looks exactly like referring to an unimported helper of the same name. That is
// not hypothetical: audio-filters.js exports a `gateOpen` function, IQPanel has a
// prop called `gateOpen`, and the two are unrelated.
//
// Call sites are deliberately not matched. `foo({ bar })` passes an object and
// binds nothing, so treating it as a declaration would blind the check to a real
// unimported `bar` somewhere else in the same file. Requiring `function` before
// the parenthesis, or `=>` after it, separates the two without a parser.
function destructurePatterns(src) {
    const out = [];
    // const/let/var { … } =
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) out.push(m[1]);
    // function name({ … })  and  function({ … })
    for (const m of src.matchAll(/function\s*[A-Za-z_$][\w$]*\s*\(\s*\{([^}]*)\}/g)) out.push(m[1]);
    for (const m of src.matchAll(/function\s*\(\s*\{([^}]*)\}/g)) out.push(m[1]);
    // ({ … }) =>
    for (const m of src.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g)) out.push(m[1]);
    return out;
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
    // `export const { useState, useEffect, … } = React` — how react.js
    // re-exports the hooks. Missing this let a hook used without importing it
    // slip straight through, which is the exact bug this file is here for.
    for (const m of src.matchAll(/export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
        for (const name of namesIn(m[1])) exported.add(name);
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
    for (const pattern of destructurePatterns(src)) {
        for (const name of namesIn(pattern)) declared.add(name);
    }

    // Strip the import statements themselves, so importing a name does not
    // count as using it. Bounded by the semicolon: a lazy match up to `from`
    // silently ate the rest of the file, which is why a missing hook import
    // slipped through this check once already.
    const body = src.replace(/^\s*import\b[^;]*;/gm, ' ');
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
