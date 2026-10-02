// Named graphs kept in this browser: the playground's "Save" and "Open".
//
// The canvas itself has always been kept — engine.js writes the graph open now
// to localStorage a moment after every change, so closing the window or the tab
// loses nothing. What that is not is a place to keep *more than one*: build a
// second graph and the first is gone. This is that place.
//
//   localStorage['ubersdr.v2.playground.library'] =
//     { v: 1, graphs: [{ name, savedAt, graph }] }
//
// `graph` is serializeGraph's form, the same as a file or a link carries, name
// included; `savedAt` is milliseconds since 1970. Names are unique without
// regard to case — they are what the operator picks a graph by, and two called
// "Voice filter" and "voice filter" would be one too many to tell apart.
//
// Under the `ubersdr.v2.` prefix on purpose: the desktop client shares every
// key there between its receivers (clients/electron/receiver-preload.js), so a
// graph saved while listening to one receiver is there when listening to
// another, which is what saving it was for.
//
// The graph open now remembers which saved graph it is a copy of (`savedAs`,
// kept beside it by engine.js and in nothing that leaves this browser). That is
// what lets Save write straight over its own entry, and ask before it writes
// over somebody else's of the same name — a shared "Voice filter" loaded over
// the top of the operator's own is not theirs to replace without asking.
//
// Files: one graph exports as a graph, exactly as before. More than one exports
// as a bundle,
//
//   { ubersdrPlayground: 'graphs', v: 1, ubersdr: '1.2.3', graphs: [graph, …] }
//
// which Import adds to the saved graphs rather than to the canvas.

import { GRAPH_VERSION, cleanGraphName, parseGraph, serializeGraph } from './graph.js';
import { uberSDRVersion } from './version.js';

export const LIBRARY_KEY = 'ubersdr.v2.playground.library';
export const LIBRARY_VERSION = 1;
export const BUNDLE_KIND = 'graphs';
// Past anything anybody builds by hand; a limit so that an imported file cannot
// fill the browser's storage with copies.
export const LIBRARY_MAX = 500;

const storage = () => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch (err) {
        return null;
    }
};

/** Whether two graph names are the same name: case does not count. */
export const sameGraphName = (a, b) => cleanGraphName(a).toLowerCase() === cleanGraphName(b).toLowerCase();

// The last read, by the text it was read from. The window asks where the graph
// stands on every render — and a drag renders every frame — so the library is
// parsed again only when what is stored has changed, including from another
// tab or another receiver's window.
let lastText = null;
let lastList = [];

/** The saved graphs, most recently saved first. Never throws. */
export function savedGraphs() {
    const ls = storage();
    if (!ls) return [];
    let text;
    try {
        text = ls.getItem(LIBRARY_KEY);
    } catch (err) {
        return [];
    }
    if (text === lastText) return lastList.slice();
    lastText = text;
    lastList = readLibrary(text);
    return lastList.slice();
}

function readLibrary(text) {
    let raw;
    try {
        raw = JSON.parse(text || 'null');
    } catch (err) {
        return [];
    }
    if (!raw || raw.v !== LIBRARY_VERSION || !Array.isArray(raw.graphs)) return [];
    const out = [];
    for (const e of raw.graphs) {
        const name = cleanGraphName(e && e.name);
        if (!name || !e.graph || typeof e.graph !== 'object' || out.some((x) => sameGraphName(x.name, name))) continue;
        out.push({ name, savedAt: Number(e.savedAt) || 0, graph: { ...e.graph, name } });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
}

function write(entries) {
    const ls = storage();
    if (!ls) throw new Error('This browser is not keeping anything for this page.');
    try {
        ls.setItem(LIBRARY_KEY, JSON.stringify({ v: LIBRARY_VERSION, graphs: entries }));
    } catch (err) {
        throw new Error('This browser’s storage for this page is full. Delete a saved graph, or export some and delete them.');
    }
}

/** The saved graph called `name`, or null. */
export function findSaved(name) {
    return savedGraphs().find((e) => sameGraphName(e.name, name)) || null;
}

/** A saved graph as the editor holds one: parsed, named, and tied to its entry. */
export function openSaved(entry) {
    const { graph, errors, ubersdr } = parseGraph(entry.graph);
    return { graph: { ...graph, name: entry.name, savedAs: entry.name }, errors, ubersdr };
}

/**
 * Save `graph` as `name`, over any saved graph of that name. Returns the
 * name it was saved under. Throws, with something to show, where it could
 * not be — storage full or refused.
 */
export function saveGraph(name, graph, now = Date.now()) {
    const n = cleanGraphName(name);
    if (!n) throw new Error('A saved graph needs a name.');
    const rest = savedGraphs().filter((e) => !sameGraphName(e.name, n));
    if (rest.length >= LIBRARY_MAX) throw new Error(`That is ${LIBRARY_MAX} saved graphs, which is all there is room for. Delete some first.`);
    write([{ name: n, savedAt: now, graph: serializeGraph({ ...graph, name: n }) }, ...rest]);
    return n;
}

/** Forget the saved graph called `name`. */
export function deleteSaved(name) {
    const all = savedGraphs();
    const rest = all.filter((e) => !sameGraphName(e.name, name));
    if (rest.length !== all.length) write(rest);
}

/**
 * `name`, or `name (2)`, `name (3)`… — the first not taken by a saved graph
 * (or by anything in `taken`, names already handed out in the same go).
 */
export function freeName(name, taken = []) {
    const base = cleanGraphName(name) || 'Untitled graph';
    const used = [...savedGraphs().map((e) => e.name), ...taken];
    const free = (n) => !used.some((u) => sameGraphName(u, n));
    if (free(base)) return base;
    for (let k = 2; ; k++) {
        const suffix = ` (${k})`;
        const n = `${base.slice(0, Math.max(1, 60 - suffix.length)).trim()}${suffix}`;
        if (free(n)) return n;
    }
}

// Two graphs the same as far as anybody could tell: what they would save as,
// without which UberSDR saved them. A saved entry's is worked out once.
const entryForms = new WeakMap();
const comparable = (g) => {
    const s = serializeGraph(g);
    delete s.ubersdr;
    delete s.name;
    return JSON.stringify(s);
};

/**
 * Where the graph open now stands against what is saved:
 *   'unsaved'   it is tied to no saved graph
 *   'saved'     it is its saved graph, unchanged
 *   'changed'   it has been changed since it was saved (or renamed)
 */
export function saveState(graph) {
    if (!graph.savedAs) return 'unsaved';
    const entry = findSaved(graph.savedAs);
    if (!entry) return 'unsaved';
    if (!sameGraphName(entry.name, graph.name || '')) return 'changed';
    if (!entryForms.has(entry.graph)) entryForms.set(entry.graph, comparable(parseGraph(entry.graph).graph));
    return entryForms.get(entry.graph) === comparable(graph) ? 'saved' : 'changed';
}

/** Several graphs, as one file's content. */
export function bundleGraphs(graphs) {
    const made = uberSDRVersion();
    return {
        ubersdrPlayground: BUNDLE_KIND,
        v: LIBRARY_VERSION,
        ...(made ? { ubersdr: made } : {}),
        graphs: graphs.map((g) => {
            const s = serializeGraph(g);
            delete s.ubersdr;
            return s;
        }),
    };
}

/** Whether a file's parsed JSON is a bundle of graphs rather than one. */
export function isBundle(raw) {
    return !!raw && typeof raw === 'object' && raw.ubersdrPlayground === BUNDLE_KIND;
}

/**
 * Add a bundle's graphs to the saved ones. A name already taken gets a number
 * rather than replacing anything: an import is not the place to lose work.
 * Returns `{ added: [names], errors: [messages] }`.
 */
export function importBundle(raw, now = Date.now()) {
    const errors = [];
    if (raw.v !== LIBRARY_VERSION) {
        return { added: [], errors: [Number(raw.v) > LIBRARY_VERSION ? 'This file was made by a newer version of the playground.' : 'Not a file of graphs this playground can read.'] };
    }
    const fresh = [];
    for (const g of Array.isArray(raw.graphs) ? raw.graphs : []) {
        const { graph, errors: errs } = parseGraph({ ...g, v: g && g.v != null ? g.v : GRAPH_VERSION, ubersdr: raw.ubersdr });
        if (!graph.nodes.length) {
            errors.push(`“${cleanGraphName(g && g.name) || 'A graph'}” could not be read${errs.length ? `: ${errs[0].message}` : ''}.`);
            continue;
        }
        const name = freeName(graph.name, fresh.map((e) => e.name));
        fresh.push({ name, savedAt: now, graph: serializeGraph({ ...graph, name }) });
    }
    if (fresh.length) {
        const all = [...fresh, ...savedGraphs()];
        if (all.length > LIBRARY_MAX) return { added: [], errors: [`That would be more than ${LIBRARY_MAX} saved graphs. Delete some first.`] };
        write(all);
    }
    return { added: fresh.map((e) => e.name), errors };
}

/** A file name for a graph: its name, made safe to save as. */
export function fileNameFor(name) {
    const slug = cleanGraphName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return `ubersdr-playground${slug ? `-${slug}` : ''}.json`;
}
