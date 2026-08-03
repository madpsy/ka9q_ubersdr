// The "🌐 Links" menu from v1 (static/pages-menu.js), hung off the top bar's
// logo instead of a button pinned to the page corner.
//
// Same source and same rules: /api/pages-menu returns groups of pages, each
// group, subgroup and file optionally carrying a `depends_on` key that is
// checked against /api/description — so a receiver without, say, a CW skimmer
// never shows that group. Subgroups nest arbitrarily deep and fly out to the
// right. Internal pages open in a centred popup window, external links and
// downloads in a plain tab. The dynamic add-ons group is appended last.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Icon } from './ui.jsx';

const POPUP_W = 1200;
const POPUP_H = 800;

// v1's isEnabled(), against the /api/description payload.
function isEnabled(key, info) {
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

function fileToLink(file) {
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

// Prune the fetched tree down to what this receiver actually has.
function buildGroups(data, info) {
    const mapNodes = (list) => (list || []).map((sg) => ({
        name: sg.name,
        links: (sg.files || []).filter((f) => isEnabled(f.depends_on, info)).map(fileToLink),
        subgroups: mapNodes(sg.subgroups),
    })).filter((sg) => sg.links.length || sg.subgroups.length);

    const groups = (data.groups || [])
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

function openPopup(url) {
    const left = Math.round((screen.width - POPUP_W) / 2);
    const top = Math.round((screen.height - POPUP_H) / 2);
    window.open(
        url,
        '_blank',
        `width=${POPUP_W},height=${POPUP_H},left=${left},top=${top},`
        + 'resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no',
    );
}

function LinkItem({ item, onDone }) {
    return (
        <a
            className="links__item"
            href={item.url}
            title={item.tooltip || undefined}
            role="menuitem"
            onClick={(e) => {
                e.preventDefault();
                if (item.external) window.open(item.url, '_blank', 'noopener,noreferrer');
                else openPopup(item.url);
                onDone();
            }}
        >
            {item.label}
        </a>
    );
}

// One row that opens a flyout. Nesting is pure CSS hover, as in v1, so a deep
// tree needs no open/close state per level.
function GroupRow({ node, onDone }) {
    return (
        <div className="links__row" role="menuitem" aria-haspopup="true">
            <span className="links__label">{node.name}</span>
            <span className="links__arrow">›</span>
            <div className="links__flyout" role="menu">
                {node.links.map((item) => <LinkItem key={item.url} item={item} onDone={onDone} />)}
                {node.subgroups.map((sg) => <GroupRow key={sg.name} node={sg} onDone={onDone} />)}
            </div>
        </div>
    );
}

export default function LinksMenu({ serverInfo, compact }) {
    const [open, setOpen] = useState(false);
    const [groups, setGroups] = useState(null);
    const ref = useRef(null);
    const fetched = useRef(false);

    // Fetched on first open — a receiver whose operator never opens this menu
    // should not pay for the request.
    useEffect(() => {
        if (!open || fetched.current) return;
        fetched.current = true;
        fetch('/api/pages-menu')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => setGroups(d ? buildGroups(d, serverInfo) : []))
            .catch(() => setGroups([]));
    }, [open, serverInfo]);

    // Rebuild when the receiver description lands after the menu was opened.
    useEffect(() => { fetched.current = false; }, [serverInfo]);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const close = useCallback(() => setOpen(false), []);

    return (
        <div className="links" ref={ref}>
            <button
                type="button"
                className={`topbar__logo links__btn${open ? ' is-open' : ''}`}
                title="Pages and links"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
            >
                <Icon.Radio size={compact ? 16 : 18} />
            </button>

            {open && (
                <div className="links__panel" role="menu">
                    {groups == null && <div className="links__note">Loading…</div>}
                    {groups && groups.length === 0 && <div className="links__note">No pages published.</div>}
                    {(groups || []).map((g) => <GroupRow key={g.name} node={g} onDone={close} />)}
                </div>
            )}
        </div>
    );
}
