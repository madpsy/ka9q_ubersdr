// Keeps the DX cluster session's lifecycle off the panel that draws it.
//
// The session itself already outlived the panel — it lives in
// lib/dxclusterSession.js precisely because a collapsed dock unmounts the panel
// and that is not somebody asking to leave the cluster. But the three decisions
// *about* the session were still in the panel's effects, which meant they only
// happened while the panel was mounted, and the everyday case defeated the
// first of them: a remembered callsign in the bottom dock, collapsed, never
// logged in at all, because the effect that would have logged it in had never
// run. Tucked away is the normal state for this panel.
//
// So the same split the chat makes, and the same one ControlWatch and
// HardwareNoticeWatch make: what the session *should be* is decided here, for
// the life of the page, and the panel keeps what it is for — the transcript,
// the command line and the buttons.
//
// Three rules, all moved rather than invented:
//
//   auto-connect   a remembered callsign connects on its own, as the widget
//                  does, once per page load. The password is optional — plenty
//                  of clusters take a bare callsign — so only the callsign is
//                  required.
//   side docks     it does not connect into a left or right dock, and moving
//                  the panel there ends a live session. A cluster login held
//                  open behind a panel that cannot show the output is the worst
//                  of both, and in a side dock this panel is a signpost rather
//                  than a terminal — see DockTooNarrow. `cramped` is layout
//                  state rather than a measurement, so it is knowable from here
//                  with the panel unmounted.
//   Stop           stopping the receiver ends the session and starting it again
//                  brings it back, like every other feed on the page. See
//                  lib/serverFeeds.js.
//
// Collapsed is deliberately not one of them: tucking a panel away is where this
// started. Hidden is, though — a panel removed from the layout altogether is a
// stronger statement than one folded shut, and holding a login open for a panel
// the operator has taken off the page is the side-dock objection again.

import { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import useFeedsAllowed from '../lib/useServerFeeds.js';
import { savedLogin } from '../lib/dxclusterTerminal.js';
import { PANEL_ID, dxClusterAvailable } from '../panels/DXClusterPanel.jsx';
import {
    dxAutoTried, dxConnect, dxDisconnect, dxSession, dxSessionWanted, markDxAutoTried,
    onDxSession,
} from '../lib/dxclusterSession.js';

export default function DXClusterWatch() {
    const { serverInfo } = useRadio();
    const { placementOf, sections } = useLayout();
    const mobile = useMediaQuery(MOBILE_QUERY);
    const feeds = useFeedsAllowed();

    // Only the state, not the transcript: this decides whether there is a session,
    // and the lines that arrive on it are the panel's business.
    const [state, setState] = useState(() => dxSession().state);
    useEffect(() => onDxSession((next) => setState(next.state)), []);

    // The same test the panel's signpost makes, from the same layout state, so the
    // two cannot disagree about where the panel is. See useDockRoom.
    const where = placementOf(PANEL_ID);
    const cramped = !mobile && (where === 'left' || where === 'right');
    const hidden = !!sections[PANEL_ID]?.hidden;
    const wanted = dxSessionWanted({
        available: dxClusterAvailable(serverInfo), cramped, hidden, feeds,
    });

    // Was there a session when the reason to have one went away? Only then is one
    // restored — so a cluster nobody had logged into stays logged out, and coming
    // back from Stop does not log somebody in who had disconnected by hand. A ref
    // because it is a note about the past, not something to draw.
    const wasUp = useRef(false);

    useEffect(() => {
        if (!wanted) {
            if (state !== 'closed') {
                wasUp.current = true;
                dxDisconnect();
            }
            return;
        }
        if (state !== 'closed') return;

        const { callsign, password } = savedLogin();
        if (!callsign.trim()) return;

        // Two ways in, and they are different questions. Coming back from Stop, or
        // out of a side dock, restores a session that was up a moment ago and does
        // not spend the once-per-page auto-connect. The auto-connect proper is the
        // first login of the visit: it happens once however many times the panel is
        // moved about afterwards, because a disconnect is a decision.
        if (wasUp.current) {
            wasUp.current = false;
        } else {
            if (dxAutoTried()) return;
            markDxAutoTried();
        }
        // The password is passed as stored, empty included: it is optional, and
        // dxConnect sends it only when there is one.
        dxConnect({ callsign: callsign.trim(), password });
    }, [wanted, state]);

    return null;
}
