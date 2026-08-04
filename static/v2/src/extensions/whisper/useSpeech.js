// The browser's speech synthesiser, as one hook.
//
// The Web Speech API is a global with an internal queue, no way to inspect it,
// and voices that arrive after the page does. This wraps it so the panel deals
// in "say this line" and "stop", and so that everything with a lifetime — the
// queue, the sentence buffer, the utterance the browser is holding — is torn
// down when the panel is.
//
// Sentences are batched rather than spoken one utterance each. The synthesiser
// leaves an audible gap between utterances, and a transcript arriving three
// sentences at a time would be read with a stumble between each. Whatever has
// queued up while the previous batch was speaking goes out as one utterance.
//
// See ./speech.js for the text handling: overlap removal, sentence extraction,
// and choosing a voice.

import { useCallback, useEffect, useRef, useState } from '../../react.js';
import { bufferSpeech, speechSupported } from './speech.js';

function currentVoices() {
    if (!speechSupported()) return [];
    try {
        return window.speechSynthesis.getVoices() || [];
    } catch (e) {
        return [];
    }
}

export function useSpeech({ enabled, voiceName, rate, lang }) {
    const supported = speechSupported();
    const [voices, setVoices] = useState(currentVoices);
    // Drives the receiver duck, so it has to be state rather than a ref.
    const [speaking, setSpeaking] = useState(false);

    // The queue and the sentence buffer. Never state: they change on every
    // decode and nothing renders from them.
    const q = useRef({ buffer: '', queue: [], busy: false, utterance: null });

    // Read at the moment an utterance is built, so changing the rate or the
    // voice affects the next batch without restarting anything.
    const cfg = useRef({});
    cfg.current = { voiceName, rate, lang };

    // Voices load asynchronously in every browser and are simply absent on the
    // first read in most of them. addEventListener rather than the onvoiceschanged
    // property: the property is global, and assigning it would silently replace
    // anything else on the page that had.
    useEffect(() => {
        if (!supported) return undefined;
        const update = () => setVoices(currentVoices());
        update();
        window.speechSynthesis.addEventListener('voiceschanged', update);
        return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
    }, [supported]);

    const stop = useCallback(() => {
        q.current.buffer = '';
        q.current.queue = [];
        q.current.busy = false;
        q.current.utterance = null;
        setSpeaking(false);
        if (!supported) return;
        try { window.speechSynthesis.cancel(); } catch (e) { /* nothing to cancel */ }
    }, [supported]);

    const drain = useCallback(() => {
        const s = q.current;
        if (s.busy || !s.queue.length || !speechSupported()) return;

        s.busy = true;
        setSpeaking(true);
        const text = s.queue.join(' ');
        s.queue = [];

        const { voiceName: name, rate: speed, lang: language } = cfg.current;
        const u = new SpeechSynthesisUtterance(text);
        u.rate = Number.isFinite(speed) ? speed : 1;
        u.volume = 1;
        u.pitch = 1;
        // The language the transcript is *in*, so a browser falling back to its
        // own default voice still reads it with the right phoneme set.
        if (language) u.lang = language;
        const voice = name ? currentVoices().find((v) => v.name === name) : null;
        if (voice) u.voice = voice;

        const finish = () => {
            s.busy = false;
            s.utterance = null;
            if (s.queue.length) {
                drain();
            } else {
                setSpeaking(false);
            }
        };
        u.onend = finish;
        // A failed utterance is not worth surfacing — a voice that has gone away
        // mid-session, or a cancel racing an end — but the queue behind it must
        // still move, or speech stops for the rest of the session.
        u.onerror = finish;

        // Held so it cannot be collected while the browser is still speaking it,
        // which silently truncates the utterance in Chrome.
        s.utterance = u;
        try {
            window.speechSynthesis.speak(u);
        } catch (e) {
            finish();
        }
    }, []);

    const speak = useCallback((text) => {
        if (!speechSupported() || !text) return;
        const { buffer, sentences } = bufferSpeech(q.current.buffer, text);
        q.current.buffer = buffer;
        if (!sentences.length) return;
        q.current.queue = q.current.queue.concat(sentences);
        drain();
    }, [drain]);

    // Switching it off has to silence what is already in flight, not just stop
    // adding to it — an utterance can be a minute long at 0.5×.
    useEffect(() => { if (!enabled) stop(); }, [enabled, stop]);
    useEffect(() => stop, [stop]);

    return { supported, voices, speaking, speak, stop };
}
