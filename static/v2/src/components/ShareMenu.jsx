// "Have a listen to this" — the receiver's state as a link somebody else can open.
//
// What is shared is the radio and only the radio: frequency, mode, filter edges,
// where the spectrum is pointed and how far in. Not the layout, not the palette,
// not which panels are open — those belong to whoever opens the link, and a link
// that rearranged their workspace is one they would not thank you for. The link
// itself is built in lib/share.js, which also reads it back on the other side.
//
// The targets are plain web intents: a URL each opens in a new tab. No script
// from any of them runs on this page, which keeps a share button from being the
// thing that puts a tracker on a receiver's front end.
//
// `navigator.share` is offered first where it exists, because on a phone it is
// the whole system's share sheet — every app the operator actually uses, in their
// own order — and no list here can compete with that. It is not offered where it
// does not: the desktop implementations are patchy and a button that does nothing
// on a click is worse than one that is not there.

import React, { useEffect, useRef, useState } from '../react.js';
import { Button, Icon, Menu, MenuItem } from './ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { SHARE_TARGETS, buildShareUrl, shareText } from '../lib/share.js';

// How long the button says it copied. Long enough to be read, short enough that
// it is back to being a share button before the next glance.
const COPIED_MS = 1600;

export default function ShareMenu() {
    const { tuning, view, serverInfo } = useRadio();
    const [copied, setCopied] = useState(false);
    const timer = useRef(null);
    useEffect(() => () => clearTimeout(timer.current), []);

    // Built when the menu is used rather than held in state: the dial moves
    // constantly and a link is only ever wanted at the moment it is asked for.
    const link = () => buildShareUrl({
        origin: location.origin,
        pathname: location.pathname,
        tuning,
        view,
    });
    const text = () => shareText({ tuning, receiver: serverInfo && serverInfo.receiver });

    const copy = async () => {
        const url = link();
        try {
            await navigator.clipboard.writeText(url);
        } catch (e) {
            // Denied, or no clipboard at all over plain HTTP. Falling back to a
            // prompt is not a nicety: without it the button silently does
            // nothing, and the operator has no other way to get the link out.
            // eslint-disable-next-line no-alert
            window.prompt('Copy this link', url);
            return;
        }
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    };

    // The system sheet. Anything the user cancels rejects, which is not an error
    // — it is them changing their mind, and there is nothing to report about it.
    const native = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const sheet = () => {
        navigator.share({ title: text(), text: text(), url: link() }).catch(() => {});
    };

    const open = (target) => {
        // noopener, and a new tab: these are other people's sites, and one of
        // them getting a handle on this window could navigate the receiver away
        // mid-session.
        window.open(target.href(link(), text()), '_blank', 'noopener,noreferrer');
    };

    return (
        <Menu
            align="end"
            trigger={(
                <Button
                    size="sm"
                    variant="ghost"
                    icon={copied ? <Icon.Tick /> : <Icon.Share />}
                    title="Share this frequency — the link opens on the same signal, filter and view"
                    aria-label="Share"
                />
            )}
        >
            {/* The link on its own, first: it is what the other entries are made
                of, and the one that works into anything — a logbook, a cluster
                comment, a message the sender is already writing. */}
            <MenuItem icon={<Icon.Copy size={14} />} onClick={copy}>
                {copied ? 'Link copied' : 'Copy link'}
            </MenuItem>
            {native && (
                <MenuItem icon={<Icon.Share size={14} />} onClick={sheet}>
                    Share…
                </MenuItem>
            )}
            {SHARE_TARGETS.map((t) => (
                <MenuItem key={t.id} icon={<Icon.External size={14} />} onClick={() => open(t)}>
                    {t.label}
                </MenuItem>
            ))}
        </Menu>
    );
}
