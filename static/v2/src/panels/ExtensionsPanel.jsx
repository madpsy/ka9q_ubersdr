// Extensions — the launcher for the decoders and tools v2 ships.
//
// Two things decide what is offered: what this build can render (the v2
// extension registry) and what the operator has enabled (`/api/extensions`,
// from extensions.yaml). An extension we support but the receiver has not
// enabled is listed and disabled with the reason, rather than left out — the
// operator's own answer to "why is FT8 not here?" is in extensions.yaml, and a
// missing row cannot say that. What the receiver enables and v2 has no
// component for is simply absent: this is a launcher, not an inventory.
//
// Picking one opens it as a window and closes whichever was open: the server
// allows a single audio extension per session, so two open at once would show
// one live decoder and one that had been silently torn down. Pressing the open
// one again closes it.
//
// The panel is absent altogether unless at least one extension is both written
// for v2 and enabled here — see its `requires` in panels/registry.jsx — so this
// body never renders an empty list or a "loading" state.

import React from '../react.js';
import { useExtensions } from '../extensions/ExtensionsContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';

export default function ExtensionsPanel() {
    const { list, activeId, toggle } = useExtensions();
    const { running } = useRadio();

    return (
        <div className="stack exts">
            <div className="list">
                {list.map((e) => {
                    const open = activeId === e.id;
                    const reason = !e.enabled
                        ? 'Not enabled on this receiver'
                        : (e.requiresAudio && !running ? 'Start the receiver to use this' : null);
                    return (
                        <button
                            key={e.id}
                            type="button"
                            className={`list__row ext-row${open ? ' is-active' : ''}`}
                            disabled={!e.enabled}
                            title={reason || e.summary}
                            onClick={() => toggle(e.id)}
                        >
                            <span className="ext-row__icon">{e.icon}</span>
                            <span className="ext-row__text">
                                <span className="ext-row__title">{e.title}</span>
                                <span className="ext-row__summary">{reason || e.summary}</span>
                            </span>
                            <span className="ext-row__state">{open ? 'Open' : ''}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
