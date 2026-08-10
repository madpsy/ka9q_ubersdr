// The pages menu, as data.
//
// /api/pages-menu returns the groups of pages a receiver publishes, each group,
// subgroup and file optionally carrying a `depends_on` key checked against
// /api/description — so a receiver without, say, a CW skimmer never shows that
// group. This file is the pruning, and nothing else: no DOM, no React, no
// fetching, so the same answer can be rendered as the top bar's logo menu
// (components/LinksMenu.jsx) or as the desktop client's native Links menu
// (clients/electron/main.js, which bundles this to CJS at staging time).
//
// One implementation on purpose. Two menus claiming to list the same receiver's
// pages and disagreeing about which it has would be a bug nobody could see
// without opening both.

// v1's isEnabled(), against the /api/description payload.
export function isEnabled(key, info) {
    if (!key) return true;
    if (!info) return false;
    if (key.startsWith('addons:')) {
        const name = key.slice('addons:'.length);
        return Array.isArray(info.addons) && info.addons.includes(name);
    }
    const val = info[key];
    if (!val) return false;
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === 'object' && 'enabled' in val) return !!val.enabled;
    return true;
}

export function fileToLink(file) {
    const external = /^https?:\/\//.test(file.path);
    return {
        url: external ? file.path : '/' + file.path.replace(/^\//, ''),
        label: file.name,
        tooltip: file.description || '',
        // Downloads get a plain tab too — a popup window would be a poor place
        // to land a file save.
        external: external || file.download === true,
    };
}

/** Prune the fetched tree down to what this receiver actually has. */
export function buildGroups(data, info) {
    const mapNodes = (list) => (list || []).map((sg) => ({
        name: sg.name,
        links: (sg.files || []).filter((f) => isEnabled(f.depends_on, info)).map(fileToLink),
        subgroups: mapNodes(sg.subgroups),
    })).filter((sg) => sg.links.length || sg.subgroups.length);

    const groups = ((data && data.groups) || [])
        .filter((g) => isEnabled(g.depends_on, info))
        .map((g) => ({
            name: g.group,
            links: (g.files || []).filter((f) => isEnabled(f.depends_on, info)).map(fileToLink),
            subgroups: mapNodes(g.subgroups),
        }))
        .filter((g) => g.links.length || g.subgroups.length);

    if (info && Array.isArray(info.addons) && info.addons.length) {
        groups.push({
            name: '🔌 Add-ons',
            links: info.addons.map((name) => ({ url: `/addon/${name}/`, label: name.toUpperCase(), tooltip: '' })),
            subgroups: [],
        });
    }
    return groups;
}
