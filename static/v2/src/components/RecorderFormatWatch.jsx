// The recorder's format, joined up to the stream's.
//
// WAV is offered as the uncompressed choice, and off an Opus stream it is not
// one: MediaRecorder's WebM is a second encode of audio the browser has already
// Opus-decoded, and WAV skips that second encode but cannot put back what the
// first one threw away. The file is then an uncompressed copy of a lossy
// signal, which is the worst of both — every byte of PCM and none of the
// fidelity it implies.
//
// So choosing WAV raises the audio stream to lossless, the way choosing IQ
// does, and the operator's standing format choice is kept and comes back when
// they go back to Opus. RadioContext's setLosslessHold owns both halves.
//
// Here rather than in the Recorder panel for the reason IQDemodWatch and
// MeasureWatch are here: a collapsed dock section is unmounted, and the
// recorder's format choice deliberately outlives that (it lives on the recorder
// object, not in the view). A hold that only existed while the panel was on
// screen would let go the moment somebody folded it away, quietly dropping the
// stream back to Opus under a recorder still set to WAV.
//
// It draws nothing.

import { useEffect, useReducer } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { getRecorder } from '../lib/recorder.js';

export default function RecorderFormatWatch() {
    const { player, actions } = useRadio();
    const rec = getRecorder(player);

    // The recorder is not React state. `preferredFormat` is an accessor that
    // emits on change precisely so this can follow it.
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => rec.on('change', bump), [rec]);

    const wav = rec.preferredFormat === 'wav';
    useEffect(() => {
        // Unconditional, including the false on mount: setLosslessHold returns
        // at once when nothing changes, so this costs a comparison and never a
        // reconnect.
        actions.setLosslessHold(wav);
    }, [actions, wav]);

    return null;
}
