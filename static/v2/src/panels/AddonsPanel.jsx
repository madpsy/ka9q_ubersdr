// Addons published by this receiver.
//
// `/api/description` returns names only (the descriptions in addons.json are
// admin-side and not exposed), so this lists what the server offers and opens
// each at /addon/<name>/ — the same route v1's dropdown uses. They are separate
// applications with their own UI, so they open in a new tab rather than trying
// to embed them.

import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty, Icon } from '../components/ui.jsx';

export function addonList(serverInfo) {
    const list = serverInfo && serverInfo.addons;
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n) : [];
}

export default function AddonsPanel() {
    const { serverInfo } = useRadio();
    if (!serverInfo) return <Empty>Loading…</Empty>;

    const addons = addonList(serverInfo);
    if (addons.length === 0) return <Empty>No addons on this receiver.</Empty>;

    return (
        <div className="stack">
            <div className="list">
                {addons.map((name) => (
                    <a
                        key={name}
                        className="list__row addon"
                        href={`/addon/${encodeURIComponent(name)}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <span className="list__title">{name.toUpperCase()}</span>
                        <span className="addon__go"><Icon.External size={13} /></span>
                    </a>
                ))}
            </div>
            <div className="note note--tight">Each addon opens in a new tab.</div>
        </div>
    );
}
