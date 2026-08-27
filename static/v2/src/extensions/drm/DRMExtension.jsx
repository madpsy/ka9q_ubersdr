// DRM decoder — Digital Radio Mondiale, the shortwave digital broadcast mode.
//
// Closely related to the FreeDV panel and for the same reason: what comes back
// on the binary channel is not a decode to display but *audio*. The server runs
// ubersdr-drm on the session's IQ, and the AAC the broadcast carries arrives
// Opus-encoded (see ./frame.js). So most of this panel is a playback chain, and
// the FreeDV one is its direct ancestor.
//
// Three things are different, and they are the reason this is its own file:
//
//   * DRM needs *IQ*, not sideband audio. A DRM channel is 10 kHz of OFDM and
//     no demodulated mode preserves it, so this panel puts the receiver into
//     `iq` when it starts and stops itself if the mode is changed out from
//     under it. That is not a nicety: in any other mode the decoder is fed
//     demodulated audio and can never lock, so leaving it running would show a
//     permanently searching panel with no hint as to why.
//   * IQ mode is *noise* to listen to — the receiver plays the raw I/Q pair. So
//     the duck is not a politeness as it is in FreeDV, it is required, and it
//     goes on the moment the mode changes rather than when audio first arrives.
//   * A DRM signal identifies itself. The station label, its country and
//     language, the text message and the signal quality all arrive on a status
//     frame about once a second, and showing them is most of what makes the
//     panel worth looking at while it hunts for a lock.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Icon } from '../../components/ui.jsx';
import { getOpusDecoderClass } from '../../radio/audio-player.js';
import { isIQ } from '../../radio/constants.js';
import { countryFlag, formatHz } from '../../lib/format.js';
import { useAudioExtension } from '../useAudioExtension.js';
import {
    RX_OK, SIGNAL_TIMEOUT_MS, STATUS_STALE_MS, WMER_THRESHOLD_FRACTION,
    decodeFrame, hasAudioLock, languageName, progressLabel, qualityFraction,
} from './frame.js';

// One Opus frame is 20 ms. Far enough ahead for the Web Audio scheduler, short
// enough not to clip the first syllable — the value FreeDV arrived at.
const LEAD_IN_SEC = 0.02;

// The mode the decoder requires. Plain `iq` rather than a wide variant: at
// 12 kHz it covers the widest DRM channel with room to spare, and the wide ones
// need operator authorisation.
const REQUIRED_MODE = 'iq';

export default function DRMExtension({ minimal }) {
    const { running, audioState, tuning, actions, player, audio } = useRadio();
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [signal, setSignal] = useState(false);
    const [frames, setFrames] = useState(0);
    const [status, setStatus] = useState(null);
    // Status frames arrive about once a second. If they stop, the decoder has
    // stalled or the pipe has gone, and the last figures must stop being
    // presented as current — a confident "17.5 dB" from a dead decoder is
    // worse than an honest gap.
    const [statusStale, setStatusStale] = useState(false);
    // Why the decoder stopped, when it was not the operator who stopped it.
    // Detaching clears the hook's own error, so without keeping it here the
    // panel would drop straight back to "Stopped" with nothing to say why.
    const [failure, setFailure] = useState(null);

    // Playback chain and Opus decoder. None of it may live in state: frames
    // arrive fifty times a second and a re-render per frame would be absurd.
    const a = useRef({
        decoder: null, rate: 0, channels: 0,
        chain: Promise.resolve(), nextPlayTime: 0,
        gain: null, ctx: null, signalTimer: null, staleTimer: null,
    });

    // The mode to put back when the decoder stops, or null if it was already in
    // IQ when we started and there is nothing to restore.
    const restoreMode = useRef(null);

    // ── mode ────────────────────────────────────────────────────────────────

    const start = useCallback(() => {
        setFailure(null);
        // Remember where the operator was so stopping does not strand them in a
        // mode that plays broadband noise.
        restoreMode.current = isIQ(tuning.mode) ? null : tuning.mode;
        if (!isIQ(tuning.mode)) actions.setMode(REQUIRED_MODE);
        setDecoding(true);
    }, [tuning.mode, actions]);

    const stop = useCallback(() => {
        setDecoding(false);
        // Only if the receiver is still where we put it. If the operator has
        // since chosen a mode themselves, that is the one they want.
        if (restoreMode.current && isIQ(tuning.mode)) actions.setMode(restoreMode.current);
        restoreMode.current = null;
    }, [tuning.mode, actions]);

    // Changing mode by hand stops the decoder: it cannot lock on demodulated
    // audio, and a panel that sat there searching forever would be a bug report.
    // The mode is not put back — the operator picked it.
    useEffect(() => {
        if (decoding && !isIQ(tuning.mode)) {
            restoreMode.current = null;
            setDecoding(false);
        }
    }, [decoding, tuning.mode]);

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // ── playback ────────────────────────────────────────────────────────────

    // A gain of our own, straight to the speakers, following the receiver's
    // volume and mute. The decoded audio is not the receiver's audio and must
    // not go through its filter chain, but it is what is being listened to.
    const ensureGain = useCallback(() => {
        const s = a.current;
        const ctx = player && player.ctx;
        if (!ctx) return null;
        if (s.gain && s.ctx === ctx) return s.gain;
        s.gain = ctx.createGain();
        s.gain.connect(ctx.destination);
        s.ctx = ctx;
        s.nextPlayTime = 0;
        return s.gain;
    }, [player]);

    useEffect(() => { if (decoding && live) ensureGain(); }, [decoding, live, ensureGain]);

    useEffect(() => {
        const s = a.current;
        if (!s.gain || !s.ctx) return;
        s.gain.gain.setTargetAtTime(audio.muted ? 0 : audio.volume, s.ctx.currentTime, 0.015);
    }, [audio.volume, audio.muted, decoding, live]);

    const play = useCallback(async (frame) => {
        const s = a.current;
        const ctx = player && player.ctx;
        if (!ctx) return;

        if (!s.decoder || s.rate !== frame.sampleRate || s.channels !== frame.channels) {
            const Decoder = getOpusDecoderClass();
            if (!Decoder) return;
            if (s.decoder) { try { s.decoder.free(); } catch (e) { /* ignore */ } }
            s.decoder = new Decoder({ sampleRate: frame.sampleRate, channels: frame.channels });
            await s.decoder.ready;
            s.rate = frame.sampleRate;
            s.channels = frame.channels;
        }

        const decoded = await s.decoder.decodeFrame(frame.opus);
        if (!decoded || !decoded.samplesDecoded) return;

        const gain = ensureGain();
        if (!gain) return;

        const rate = decoded.sampleRate || frame.sampleRate;
        const buffer = ctx.createBuffer(decoded.channelData.length, decoded.samplesDecoded, rate);
        for (let ch = 0; ch < decoded.channelData.length; ch++) {
            buffer.copyToChannel(decoded.channelData[ch], ch);
        }

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(gain);
        // Chained end to end. Falling behind — the first frame, a backgrounded
        // tab, a fade — resets the cursor rather than playing a burst at speed.
        const now = ctx.currentTime;
        if (s.nextPlayTime < now) s.nextPlayTime = now + LEAD_IN_SEC;
        src.start(s.nextPlayTime);
        s.nextPlayTime += buffer.duration;
    }, [player, ensureGain]);

    const onResult = (msg) => {
        if (msg.kind === 'status') {
            setStatus(msg.status);
            setStatusStale(false);
            clearTimeout(a.current.staleTimer);
            a.current.staleTimer = setTimeout(() => setStatusStale(true), STATUS_STALE_MS);
            return;
        }
        const s = a.current;
        // Serialised: the Opus decoder is a stateful WASM module and is not
        // re-entrant, so two decodes must never overlap.
        s.chain = s.chain.then(() => play(msg)).catch(() => { /* one bad frame */ });

        setFrames((n) => n + 1);
        setSignal(true);
        clearTimeout(s.signalTimer);
        s.signalTimer = setTimeout(() => setSignal(false), SIGNAL_TIMEOUT_MS);
    };

    // The decoder takes no parameters: the server reads everything it needs
    // from the session. Attaching is gated on the mode as well as the audio —
    // the server rejects a non-IQ session anyway, and retrying that would be a
    // pointless round trip.
    const { state: attachState, error } = useAudioExtension({
        name: 'drm',
        active: decoding && live && isIQ(tuning.mode),
        parse: decodeFrame,
        onResult,
    });

    // A crash is a stop. When the decoder's subprocess dies the server tears
    // the extension down, so a panel still offering Stop is offering to stop
    // something that is already gone — and, worse, is still ducking the
    // receiver and holding it in IQ, so the operator is left with silence they
    // cannot explain. Retries do not come through here: the hook reports
    // 'error' only once it has given up.
    useEffect(() => {
        if (attachState !== 'error') return;
        setFailure(error || 'The decoder stopped unexpectedly.');
        stop();
    }, [attachState, error, stop]);

    // Silence the receiver. In IQ mode its own output is the raw I/Q pair,
    // which is broadband noise, so this is required rather than polite.
    useEffect(() => {
        if (!player) return undefined;
        player.setDucked(decoding && live);
        return () => player.setDucked(false);
    }, [player, decoding, live]);

    // Stopping tears the decoder down: it holds a WASM instance, and leaving it
    // alive would decode the next stream with the last one's state.
    useEffect(() => {
        if (decoding) return undefined;
        const s = a.current;
        clearTimeout(s.signalTimer);
        clearTimeout(s.staleTimer);
        setSignal(false);
        setStatus(null);
        setStatusStale(false);
        if (s.decoder) {
            try { s.decoder.free(); } catch (e) { /* ignore */ }
            s.decoder = null;
            s.rate = 0;
            s.channels = 0;
        }
        s.nextPlayTime = 0;
        return undefined;
    }, [decoding]);

    useEffect(() => () => {
        const s = a.current;
        clearTimeout(s.signalTimer);
        clearTimeout(s.staleTimer);
        if (s.decoder) { try { s.decoder.free(); } catch (e) { /* ignore */ } }
        if (s.gain) { try { s.gain.disconnect(); } catch (e) { /* ignore */ } }
    }, []);

    // ── presentation ────────────────────────────────────────────────────────

    const locked = hasAudioLock(status);
    const quality = useMemo(() => qualityFraction(status && status.wmer), [status]);

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    // The hook's error for the render it is raised on, the kept one from then
    // on — the same text either way, so the note does not flicker as the
    // decoder detaches.
    const problem = attachState === 'error' ? error : failure;

    const audioDesc = status && status.codec
        ? `${status.codec}${status.sbr ? '+SBR' : ''}${status.audioMode ? ` ${status.audioMode}` : ''}`
        : null;

    return (
        <div className="tp drm">
            <div className="tp__bar">
                <span className={`tp__status tp__status--${statusTone}`} title="Whether the decoder is attached to your audio session on the server">
                    {statusLabel}
                </span>
                <span
                    className={`fdv__signal${signal && locked ? ' is-on' : ''}`}
                    title={locked
                        ? 'A DRM broadcast is being decoded'
                        : 'No audio is being decoded — either nothing is on frequency or the signal is too weak'}
                >
                    {signal && locked ? 'Signal' : 'No signal'}
                </span>
                <span className="tp__bar-gap" />

                {decoding
                    ? (
                        <Button size="sm" onClick={stop} icon={<Icon.Stop size={13} />} title="Stop decoding and unmute the receiver">
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={start}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? 'Switch the receiver to IQ and decode the DRM broadcast'
                                : 'Start the receiver first — the decoder runs on your audio session'}
                        >
                            Start
                        </Button>
                    )}
            </div>

            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && (
                <div className="note note--tight">
                    Tune to a DRM broadcast and press Start. The receiver is switched to IQ — which is
                    what DRM needs and is silent on its own — and put back when you stop.
                </div>
            )}
            {problem && <div className="note note--warn">{problem}</div>}
            {decoding && statusStale && attachState === 'running' && (
                <div className="note note--warn">
                    The decoder has stopped reporting — the figures below are from
                    {' '}{Math.round(STATUS_STALE_MS / 1000)}s ago or more.
                </div>
            )}

            {decoding && (
                <div className={`drm__id${statusStale ? ' is-stale' : ''}`}>
                    <div className="drm__service" title="The station name carried in the broadcast">
                        {(status && status.service) || <span className="drm__waiting">{progressLabel(status)}</span>}
                    </div>
                    {status && status.service && (status.country || status.language) && (
                        <div className="drm__origin">
                            {status.country && (
                                <span className="drm__flag" title={status.country.toUpperCase()}>
                                    {countryFlag(status.country) || status.country.toUpperCase()}
                                </span>
                            )}
                            {status.language && <span>{languageName(status.language)}</span>}
                        </div>
                    )}
                    {status && status.text && <div className="drm__text">{status.text}</div>}
                </div>
            )}

            {decoding && !minimal && (
                <div className="drm__meters">
                    <div className="drm__meter" title="Weighted MER of the data channel — the figure that decides whether audio decodes. Around 16 dB is the threshold.">
                        <div className="drm__meter-bar">
                            <span
                                className={`drm__meter-fill${locked ? ' is-good' : ''}`}
                                style={{ width: `${Math.round(quality * 100)}%` }}
                            />
                            {/* Where audio starts decoding. Without it the bar
                                is a number with no scale: "is 14 dB nearly
                                there, or hopeless?" is the question someone
                                tuning actually has. */}
                            <span
                                className="drm__meter-mark"
                                style={{ left: `${Math.round(WMER_THRESHOLD_FRACTION * 100)}%` }}
                                title="Roughly the level at which DRM audio starts to decode"
                            />
                        </div>
                        <span className="fdv__stat">
                            {status && !statusStale && typeof status.wmer === 'number'
                                ? `${status.wmer.toFixed(1)} dB`
                                : '—'}
                        </span>
                    </div>
                    <div className="drm__blocks">
                        {[['FAC', status && status.fac], ['SDC', status && status.sdc], ['Audio', status && status.audio]].map(([name, v]) => (
                            <span
                                key={name}
                                className={`drm__block${v === RX_OK ? ' is-ok' : (v ? ' is-bad' : '')}`}
                                title={`${name}: ${v === RX_OK ? 'decoding' : (v ? 'errors' : 'not present')}`}
                            >
                                {name}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {!minimal && (
                <div className="tp__controls">
                    <span className="tp__bar-gap" />
                    {audioDesc && <span className="fdv__stat" title="What the broadcast says its audio is">{audioDesc}</span>}
                    {status && status.robm && (
                        <span className="fdv__stat" title="DRM robustness mode and signalled channel bandwidth">
                            Mode {status.robm}{status.bandwidth ? ` · ${status.bandwidth} kHz` : ''}
                        </span>
                    )}
                    <span className="fdv__stat" title="Audio frames decoded and played this session">
                        {frames.toLocaleString()} frames
                    </span>
                    <span className="fdv__stat" title="What the receiver is tuned to">
                        {formatHz(tuning.frequency)} {tuning.mode.toUpperCase()}
                    </span>
                </div>
            )}
        </div>
    );
}
