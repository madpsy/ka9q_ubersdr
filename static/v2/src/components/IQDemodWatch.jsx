// The frontend demodulator's lifetime, kept away from its panel.
//
// The engine in lib/iqDemod.js has the same lifetime as the page — it has to,
// because a collapsed dock section is unmounted and a demodulator that stopped
// when somebody folded the panel away would leave the receiver in IQ, playing
// the broadband noise the duck was hiding, with nothing on screen to say why.
// The consequence is that three things it cannot see for itself have to be
// pushed in, and this is where from. It draws nothing. Same job and the same
// placing as MeasureWatch; see App.jsx.
//
//   the mode      IQ or not. The engine refuses to read a stream as quadrature
//                 until told it is one, and the duck follows the same flag, so
//                 this is what stops a demodulator switched on in USB from
//                 shouting over the audio while the confirmation is up.
//   the volume    demodulated audio is not the receiver's audio and must not go
//                 through its filter chain, but it *is* what is being listened
//                 to, so it follows the same volume and mute. The DRM panel does
//                 this with its own gain node for the same reason.
//   the way out   a receiver switched off, or a mode changed by hand, stops it.
//
// The mode is deliberately *not* put back on that last path: if the operator has
// chosen a mode themselves that is the one they want. Stop puts it back, and
// that is the panel's to do — see IQPanel.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { isIQ } from '../radio/constants.js';
import { getIQDemod } from '../lib/iqDemod.js';

export default function IQDemodWatch() {
    const { running, tuning, audio, player, iqPrompt } = useRadio();
    const demod = getIQDemod(player);
    const iq = isIQ(tuning.mode);

    useEffect(() => {
        demod.setQuadrature(iq && running);
    }, [demod, iq, running]);

    useEffect(() => {
        demod.setOutput(audio.volume, audio.muted);
    }, [demod, audio.volume, audio.muted]);

    // A mode change stops it — but not while the operator is still being asked
    // whether they want IQ at all. Start from a listening mode asks for IQ, and
    // asking puts a dialog up; between the press and the answer the mode is
    // still the old one, so without this the demodulator would switch itself
    // off in the moment before the operator said yes, and pressing Start would
    // appear to do nothing at all.
    useEffect(() => {
        if (!demod.running) return;
        if (iqPrompt) return;
        if (!running || !iq) {
            demod.restoreMode = null;
            demod.stop();
        }
    }, [demod, running, iq, iqPrompt]);

    return null;
}
