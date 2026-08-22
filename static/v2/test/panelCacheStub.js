// A localStorage with custom panels already in it, in place before the registry
// is imported.
//
// This is the whole point of the seam being tested: panels/registry.jsx reads
// the cache at module init, because LayoutProvider reconciles against the
// registry before the first render. A stub installed after the import would
// prove nothing — so it is a module of its own, imported ahead of the registry,
// for the same reason reactStub.js is.
const store = new Map();

globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
};

// One well-formed panel, one whose manifest is a mess, and two entries that must
// not survive at all.
export const SEEDED = [
    {
        id: 'x:aaaa-1111',
        version: 3,
        manifest: {
            ui: 2, schema: 1,
            title: 'World clocks', icon: 'Clock', group: 'activity',
            dock: 'right', minimal: true, weight: 2, height: 180,
        },
        name: 'World clocks', callsign: 'M9PSY', description: 'Clocks for the places you work',
    },
    {
        // Everything wrong that can be wrong without being unusable.
        id: 'x:bbbb-2222',
        version: 1,
        manifest: { ui: 2, icon: 'NotAnIconName', dock: 'nowhere', group: 'no-such-group', weight: 9999, height: 1 },
        name: 'Messy panel',
    },
    { id: 'not-namespaced', manifest: { title: 'Nope' } },
    'not even an object',
];

store.set('ubersdr.v2.panels', JSON.stringify(SEEDED));
