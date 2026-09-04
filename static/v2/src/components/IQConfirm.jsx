// The confirmation in front of IQ mode.
//
// Mounted in App beside IdleWatch, for the reason given there and in
// RadioContext's gateIQ: the mode can be set from the top bar, the Receiver
// panel, the Multipad twice over, a control surface and the bridge, and any of
// those panels can be collapsed — which unmounts it. A dialog belonging to one
// of them would be a dialog the other five never showed.
//
// What it is warning about is not that IQ is dangerous but that it is *not a
// listening mode*, and everything about the receiver changes on the way in. The
// three lines below are the three surprises worth naming in advance: the
// bandwidth lands on somebody else's bill, the audio chain goes away, and the
// meters stop moving. Anything else is discoverable from the panels themselves.

import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Modal } from './ui.jsx';

export default function IQConfirm() {
    const { iqPrompt, actions } = useRadio();
    if (!iqPrompt) return null;

    return (
        <Modal onClose={actions.cancelIQ} label="Use IQ mode">
            <div className="stack vibe">
                {/* Worded "Use IQ" rather than "Switch to IQ" to match the
                    lossless dialog's button, and because bare prose in JSX
                    is indistinguishable from an identifier to test/unresolved.js
                    — which reads a capitalised Switch as the ui.jsx component. */}
                <h2 className="vibe__title">Use IQ mode?</h2>
                <p className="vibe__text">
                    IQ sends the raw quadrature baseband &mdash; 12 kHz of RF as a
                    stereo pair, left I and right Q &mdash; rather than demodulated
                    audio. It is meant for recording and for feeding external
                    software, and what comes out of the speakers is not a signal
                    you can listen to.
                </p>
                <p className="vibe__text">
                    Sent whole it is roughly <strong>6&times; the bandwidth of
                    Opus</strong>, and that cost falls on whoever runs this receiver,
                    so it starts at the Audio panel&rsquo;s narrowest Quality setting
                    &mdash; bits below the band&rsquo;s own noise floor are dropped,
                    for well under half the bytes. Move that control up, or to the top
                    for lossless, if the capture needs it.
                </p>
                <p className="vibe__text">
                    While in IQ the noise blanker, noise reduction, filters and
                    squelch are all bypassed, and the S-meter stops updating. Your
                    settings are kept and come back when you leave.
                </p>
                <div className="vibe__row">
                    <Button size="sm" variant="ghost" onClick={actions.cancelIQ}>
                        Cancel
                    </Button>
                    <Button size="sm" variant="primary" onClick={actions.confirmIQ}>
                        Use IQ
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
