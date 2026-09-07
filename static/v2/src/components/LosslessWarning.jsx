// The confirmation in front of lossless audio.
//
// Extracted from the Audio panel's format picker, where it started, because two
// controls now lead to the same place: choosing Lossless there, and choosing WAV
// in the recorder — a WAV taken off an Opus stream is an uncompressed copy of a
// lossy signal, so the recorder raises the stream on the way. The cost lands on
// whoever runs the receiver either way, and the two warnings must not drift
// apart into one panel quoting figures the other has since corrected.
//
// Only the expensive direction asks. Going back to Opus costs nothing and
// stopping to confirm it would be a dialog in the way of the right answer, so
// there is deliberately no counterpart to this.
//
// `why` is the one thing that varies: in the Audio panel the operator has just
// pressed a button labelled Lossless and needs no telling what they asked for,
// and in the recorder they pressed WAV, where the connection is the whole point
// of the dialog appearing at all.

import React from '../react.js';
import { Button, Modal } from './ui.jsx';

export default function LosslessWarning({ why, onCancel, onAccept }) {
    return (
        <Modal onClose={onCancel} label="High bandwidth warning">
            <div className="stack vibe">
                <h2 className="vibe__title">High bandwidth warning</h2>
                {why && <p className="vibe__text">{why}</p>}
                {/* Measured against Opus on a live receiver, both
                    formats running at once on the same frequency:
                    1.9x on USB and LSB, 1.3x on CW, 3.1x on a medium
                    wave broadcast station.

                    The figures were 4x and 8x under protocol version 3,
                    which wrapped the samples in zstd and so sent them
                    very slightly LARGER than raw; version 4 predicts
                    and Rice-codes them, roughly halving every one.

                    What is on the frequency matters as much as the
                    mode. The same AM measurement against an empty HF
                    channel came out at 4.5x, because noise is the one
                    thing a predictor cannot help with — so the range is
                    given rather than the flattering end of it. CW is
                    lowest because a narrow tone in a quiet channel is
                    the easiest case there is. */}
                <p className="vibe__text">
                    Lossless audio uses approximately 2&times; more bandwidth
                    than Opus on SSB, and around 3&times; on AM, SAM and FM. On CW
                    it is close to Opus.
                </p>
                <p className="vibe__text">
                    An empty channel costs more than a busy one — there is only
                    noise to send, and noise is what compresses least.
                </p>
                <p className="vibe__text">
                    This increases costs for the instance owner. Only switch if you
                    have a specific reason to do so.
                </p>
                <div className="vibe__row">
                    <Button size="sm" variant="ghost" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button size="sm" variant="primary" onClick={onAccept}>
                        Use lossless
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
