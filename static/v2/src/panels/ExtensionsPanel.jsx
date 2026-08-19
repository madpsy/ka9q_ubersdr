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
import { isIQ } from '../radio/constants.js';

export default function ExtensionsPanel() {
    const { list, activeId, minimised, toggle } = useExtensions();
    const { running, tuning } = useRadio();
    // Every extension decodes demodulated audio, and IQ is not that. The rows
    // stay listed and go dead, for the same reason an extension the operator
    // has not enabled does: a missing row cannot say why it is missing.
    // Anything open has already been closed by ExtensionsContext.
    const iq = isIQ(tuning.mode);

    return (
        <div className="stack exts">
            {iq && (
                <div className="note note--tight">
                    Not available in IQ mode — these decode demodulated audio,
                    and IQ carries raw quadrature samples instead.
                </div>
            )}
            <div className="list">
                {list.map((e) => {
                    const open = activeId === e.id;
                    const reason = iq
                        ? 'Not available in IQ mode'
                        : !e.enabled
                            ? 'Not enabled on this receiver'
                            : (e.requiresAudio && !running ? 'Start the receiver to use this' : null);
                    return (
                        <button
                            key={e.id}
                            type="button"
                            className={`list__row ext-row${open ? ' is-active' : ''}`}
                            disabled={iq || !e.enabled}
                            title={reason || e.summary}
                            onClick={() => toggle(e.id)}
                        >
                            <span className="ext-row__icon">{e.icon}</span>
                            <span className="ext-row__text">
                                <span className="ext-row__title">{e.title}</span>
                                <span className="ext-row__summary">{reason || e.summary}</span>
                            </span>
                            {/* A minimised extension is still running, so it
                                must not read as closed — and clicking the row
                                brings it back rather than shutting it down. */}
                            <span className="ext-row__state">
                                {open ? (minimised ? 'Minimised' : 'Open') : ''}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
