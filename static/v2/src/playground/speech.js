// Text to speech for the playground's TTS block: what a decoder prints, read
// aloud.
//
// The graph runs in a worker, and the browser's speech is the page's alone,
// so the block in the graph only hands its text on (blocks/sinks.js) and the
// speaking happens here, on the page, per block. The voice is the one the
// rest of the interface speaks with (lib/announce.js): the Announcements
// panel's choice, or its own pick of the best installed.
//
// Decoded text does not arrive the way speech wants it. A decoder prints a
// character at a time, and a character spoken as it lands is noise; so text
// is gathered here and spoken in pieces:
//
//   letters   each word spelled, as it ends — "C Q", "M 9 P S Y". What CW and
//             anything full of callsigns and abbreviations wants: "CQ" read
//             as a word is "seek".
//   words     a phrase at a time, at the end of a sentence or a line, or every
//             few words — for RTTY or NAVTEX, which are written to be read.
//
// Either way a word that never ends — a decoder gone quiet mid-word — is
// spoken once the text has been still for IDLE_MS. And text can arrive faster
// than it can be said: RTTY prints six characters a second, more than a voice
// spells. Rather than fall further and further behind what is on the screen,
// the oldest unsaid pieces are dropped once the backlog passes MAX_BACKLOG,
// and counted, so the card can say so.

import { currentVoice, refreshVoice, speechAvailable, usableVoices } from '../lib/announce.js';

/**
 * The voice called `name`, if this browser has it; otherwise the receiver's
 * — the Announcements panel's choice, or its pick of the best. A name from
 * another machine falls back rather than going silent: an utterance nobody
 * hears is indistinguishable from the block not working.
 */
export function voiceNamed(name) {
    if (name && speechAvailable()) {
        const found = usableVoices(window.speechSynthesis.getVoices()).find((v) => v.name === name);
        if (found) return found;
    }
    return currentVoice() || refreshVoice();
}

export const IDLE_MS = 1200;
export const MAX_BACKLOG = 240;
// The most words a phrase holds before it is spoken anyway, in words mode.
const PHRASE_WORDS = 8;
const ENDS = /[.!?\n]/;

/** A word spelled for speaking: its characters, spaced, so they are read one by one. */
export function spellOut(word) {
    return Array.from(word).join(' ');
}

/**
 * Add `text` to what is waiting and take out what is ready to say. Returns
 * `{ buffer, pieces }`: the unfinished tail, and the pieces in order.
 * `flush` says everything now, finished or not — for when the text has gone
 * quiet.
 */
export function chunkSpeech(buffer, text, mode = 'letters', flush = false) {
    let all = `${buffer}${String(text || '').replace(/\r/g, '')}`;
    const pieces = [];
    if (mode === 'letters') {
        // Every word up to the last space or line end is finished; what
        // follows it may still be arriving.
        const cut = flush ? all.length : all.search(/\s\S*$/) + 1;
        for (const w of all.slice(0, cut).split(/\s+/)) if (w) pieces.push(spellOut(w));
        return { buffer: all.slice(cut), pieces };
    }
    // Words: a phrase at a sentence's or a line's end, or every few words.
    for (;;) {
        const end = all.search(ENDS);
        if (end >= 0) {
            const phrase = all.slice(0, end + 1).replace(/\s+/g, ' ').trim();
            if (phrase && /\S/.test(phrase.replace(ENDS, ''))) pieces.push(phrase);
            all = all.slice(end + 1);
            continue;
        }
        const words = all.trim().split(/\s+/).filter(Boolean);
        // Only finished words count: the last may still be arriving.
        const finished = /\s$/.test(all) ? words.length : words.length - 1;
        if (finished >= PHRASE_WORDS) {
            pieces.push(words.slice(0, finished).join(' '));
            all = /\s$/.test(all) ? '' : words[words.length - 1];
            continue;
        }
        break;
    }
    if (flush) {
        const rest = all.replace(/\s+/g, ' ').trim();
        if (rest) pieces.push(rest);
        return { buffer: '', pieces };
    }
    return { buffer: all, pieces };
}

/**
 * One TTS block's voice on the page. `synth` and `Utterance` are the
 * browser's unless given — the tests give their own.
 */
export class Speaker {
    constructor({
        synth = speechAvailable() ? window.speechSynthesis : null,
        Utterance = typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null,
        voice = voiceNamed,
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = (t) => clearTimeout(t),
    } = {}) {
        this.synth = synth;
        this.Utterance = Utterance;
        this.voice = voice;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.buffer = '';
        this.queue = [];
        this.speaking = null;       // the piece being said, or null
        this.last = '';             // the last piece said
        this.skipped = 0;           // pieces dropped to catch up
        this.params = { read: 'letters', rate: 1, pitch: 1, volume: 100, voice: '', muted: false };
        this._idle = null;
        this._watchdog = null;
    }

    /** Whether this page can speak at all. */
    get available() {
        return !!(this.synth && this.Utterance);
    }

    /** Text from the block, with its settings as they stand. */
    feed(text, params = this.params) {
        const read = params.read === 'words' ? 'words' : 'letters';
        if (read !== this.params.read) this.buffer = '';
        this.params = {
            read,
            rate: params.rate || 1,
            pitch: params.pitch || 1,
            volume: params.volume == null ? 100 : Number(params.volume),
            voice: params.voice || '',
            muted: !!params.muted,
        };
        if (this.params.muted || !this.available) {
            if (this.queue.length || this.speaking) this.stop();
            return;
        }
        if (!text) return;
        const r = chunkSpeech(this.buffer, text, read);
        this.buffer = r.buffer;
        this._queue(r.pieces);
        // Whatever is left is said once the text goes quiet.
        if (this._idle) this.clearTimer(this._idle);
        this._idle = this.buffer ? this.setTimer(() => this.flush(), IDLE_MS) : null;
    }

    /** Say what is waiting now, finished or not. */
    flush() {
        this._idle = null;
        const r = chunkSpeech(this.buffer, '', this.params.read, true);
        this.buffer = '';
        this._queue(r.pieces);
    }

    _queue(pieces) {
        if (!pieces.length) return;
        this.queue.push(...pieces);
        // Too far behind: drop the oldest until it is back within reach.
        let backlog = this.queue.reduce((n, p) => n + p.length, 0);
        while (backlog > MAX_BACKLOG && this.queue.length > 1) {
            backlog -= this.queue.shift().length;
            this.skipped++;
        }
        this._next();
    }

    _next() {
        if (this.speaking || !this.queue.length || !this.available) return;
        const piece = this.queue.shift();
        const u = new this.Utterance(piece);
        const v = this.voice(this.params.voice);
        if (v) {
            u.voice = v;
            u.lang = v.lang || 'en-GB';
        }
        u.rate = this.params.rate;
        u.pitch = this.params.pitch;
        u.volume = Math.max(0, Math.min(1, this.params.volume / 100));
        const done = () => {
            if (this._utterance !== u) return;
            this._utterance = null;
            if (this._watchdog) this.clearTimer(this._watchdog);
            this._watchdog = null;
            this.speaking = null;
            this._next();
        };
        u.onend = done;
        u.onerror = done;
        // Kept: Chromium forgets an utterance nothing holds, and never ends it.
        this._utterance = u;
        this.speaking = piece;
        this.last = piece;
        // And if the end never comes anyway, carry on after far longer than
        // the piece could take.
        this._watchdog = this.setTimer(done, 3000 + (piece.length * 300) / Math.max(0.5, this.params.rate));
        this.synth.speak(u);
    }

    /** Stop, and forget everything waiting. */
    stop() {
        this.queue = [];
        this.buffer = '';
        if (this._idle) this.clearTimer(this._idle);
        this._idle = null;
        if (this._watchdog) this.clearTimer(this._watchdog);
        this._watchdog = null;
        if (this.speaking && this.synth) this.synth.cancel();
        this._utterance = null;
        this.speaking = null;
    }

    /** For the card: what it is saying, how much is waiting, how much was dropped. */
    state() {
        return {
            available: this.available,
            muted: this.params.muted,
            speaking: this.speaking,
            last: this.last,
            waiting: this.queue.length + (this.buffer ? 1 : 0),
            skipped: this.skipped,
        };
    }
}
