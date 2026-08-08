// Spot the station you are listening to, from the spectrum's right-click menu.
//
// The frequency is the one thing this does not ask for — it is why the entry is on
// the spectrum rather than in a panel. What it needs is the callsign, because the
// receiver cannot know that: you have just heard it.
//
// The command is `DX <freq_kHz> <callsign> [comment]`, Spider-compatible and the
// addon's own — see spotCommand in lib/dxclusterTerminal.js, which does the Hz-to-kHz
// conversion, and handleDX in ubersdr_dxcluster/commands.go for what the far end
// accepts. A password is what the cluster grants spot rights off, so the menu entry
// appears and disappears with dxCanSpot — connected, with a callsign and a password —
// rather than being shown disabled: an entry that can never be pressed by somebody
// who logs in without a password is an entry that should not be in their menu.
//
// The reply — accepted, or a reason — comes back as ordinary cluster text and lands
// in the DX cluster panel's transcript. This closes on send rather than waiting for
// it, because that panel is collapsed most of the time and a modal that sat open
// waiting for a line nobody can see would be worse than one that gets out of the
// way. A refused spot is not silent: the panel has it whenever it is next opened.

import React, { useEffect, useRef, useState } from '../react.js';
import { Button, Modal } from './ui.jsx';
import { formatFreqShort } from '../lib/format.js';
import { dxSpot } from '../lib/dxclusterSession.js';
import { MAX_CALLSIGN } from '../lib/dxclusterTerminal.js';

// Long enough to say something useful and short enough that the addon does not
// truncate it. The comment is optional and usually empty — "CQ", "up 2", a signal
// report — so it is a second field rather than a second dialog.
const MAX_COMMENT = 60;

export default function SpotOnCluster({ frequency, onClose, onSent }) {
    const [callsign, setCallsign] = useState('');
    const [comment, setComment] = useState('');
    const [error, setError] = useState('');
    const inputRef = useRef(null);

    useEffect(() => {
        const el = inputRef.current;
        if (el) el.focus();
    }, []);

    const send = (e) => {
        e.preventDefault();
        const call = callsign.trim().toUpperCase();
        // Only that it is not empty. What counts as a callsign is the cluster's
        // question — it has the regex and the country tables — and a client-side
        // guess would refuse the odd but legal ones it has never met.
        if (!call) { setError('A callsign is needed.'); return; }
        if (!dxSpot({ hz: frequency, callsign: call, comment })) {
            // Between opening the menu and pressing Send: the session dropped, or
            // Stop closed it. Said here rather than closing silently, because the
            // spot did not go anywhere.
            setError('Not connected to the cluster — the spot was not sent.');
            return;
        }
        if (onSent) onSent(call);
        onClose();
    };

    return (
        <Modal onClose={onClose} label="Spot on DX cluster">
            <form className="stack addmark" onSubmit={send}>
                <h2 className="addmark__title">Spot on DX cluster</h2>
                <div className="addmark__at">{formatFreqShort(frequency)}</div>
                <input
                    ref={inputRef}
                    className="input"
                    value={callsign}
                    maxLength={MAX_CALLSIGN}
                    placeholder="Callsign heard"
                    aria-label="Callsign heard"
                    // Uppercased as it is typed: the cluster uppercases it anyway,
                    // and seeing it happen is how you notice a typo before sending.
                    onChange={(e) => { setCallsign(e.target.value.toUpperCase()); setError(''); }}
                />
                <input
                    className="input"
                    value={comment}
                    maxLength={MAX_COMMENT}
                    placeholder="Comment (optional)"
                    aria-label="Comment"
                    onChange={(e) => setComment(e.target.value)}
                />
                {error && <div className="note note--warn">{error}</div>}
                <div className="row-end">
                    <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button size="sm" variant="primary" type="submit">Send spot</Button>
                </div>
            </form>
        </Modal>
    );
}
