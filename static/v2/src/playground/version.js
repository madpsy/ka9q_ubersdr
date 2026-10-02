// Which UberSDR a graph was made on, and whether that is this one.
//
// Every graph saved — a file, a link, the JSON pane, this browser's own copy
// — carries the version of the receiver it was made on, as `ubersdr`
// (graph.js). The format has its own version, `v`, and a change that an old
// graph would read differently moves it; but a block can behave differently
// between releases without the format changing at all — a better decoder, a
// retuned default — and a graph made on one receiver and opened on another
// is worth a word about it.
//
// The version is the receiver's, from its description (serverInfo.version),
// put in by PlaygroundWatch once the page knows it. Before then — and in the
// tests — there is none, and graphs are saved without one.

let current = '';

/** This receiver's version, as the page has learned it; '' until then. */
export function uberSDRVersion() {
    return current;
}

export function setUberSDRVersion(version) {
    current = typeof version === 'string' ? version.trim().slice(0, 40) : '';
}

/**
 * What to say about a graph made on `made`, or null for nothing: the same
 * version, or one side not known — a graph from before graphs carried one,
 * or a page that has not learned its own yet, cannot be judged.
 */
export function versionNote(made, now = current) {
    if (!made || !now || made === now) return null;
    return `Made on UberSDR v${made}; this receiver runs v${now}. Blocks can change between versions, so check it does what you expect.`;
}
