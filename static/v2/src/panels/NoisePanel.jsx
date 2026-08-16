// Noise reduction, and in time everything else that is done to the audio on its
// way out of the receiver.
//
// It was the bottom half of the Audio panel, under a divider. The move is not
// tidying: Audio is a panel of things set once — the output device, the buffer,
// the stream format — and this is the one worked at while listening, so it was
// the part you scrolled past a settings block to reach, in the panel least
// likely to be open. On a phone it was worse: the Audio sheet's cut-down view
// was *only* this, so the volume and the channel had no minimal view at all.
//
// The panel is here whether or not the receiver offers any filters. DspControl
// says which of the two it is — reading, unavailable, or a list to choose from —
// and an empty panel that exists is what a filter appearing mid-session can
// appear *in*.

import React from '../react.js';
import DspControl from './DspControl.jsx';

export default function NoisePanel() {
    return (
        <div className="stack">
            <DspControl />
        </div>
    );
}
