// FreeDV decoder — v1's extension, rebuilt for v2.
//
// The only extension whose output is sound. The server runs freedv-ka9q on the
// session's audio, and what comes back on the binary channel is not a decode to
// display but the *speech* the RADE waveform was carrying, Opus-encoded (see
// ./reporter.js for the frame). So this panel's real job is to decode those
// frames and play them, and to get out of the way while it does.
//
// Three things follow from that, and they are most of the panel:
//
//   * The receiver's own audio has to stop, or you hear the digital signal over
//     the voice. v1 pressed the user's mute button and put it back afterwards.
//     This uses a duck instead — a gate on the output only, added to the player
//     for this — so the mute button still means what it says, the volume
//     control still works, and the recorder and the scope still see the
//     receiver's audio while the decoder plays over it.
//   * There is no "no signal" message. The server sends frames only while it is
//     decoding, so their arrival *is* the signal indicator and their absence
//     for a couple of seconds is signal loss.
//   * Where to point the receiver is the harder half of using FreeDV, so the
//     FreeDV Reporter list is here too. It runs whether or not the decoder is
//     on, filtered to the band the dial is in, and a row tunes to that station.
//     It is the whole body of the panel — v1 toggled between it and a waterfall
//     of the decoded voice, which the signal lamp and the frame count answer
//     more directly and in a fifth of the space.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon } from '../../components/ui.jsx';
import { getOpusDecoderClass } from '../../radio/audio-player.js';
import { dxcluster } from '../../radio/dxcluster-connection.js';
import { bandForFrequency, HAM_BANDS } from '../../lib/bands.js';
import { formatHz } from '../../lib/format.js';
import { useAudioExtension } from '../useAudioExtension.js';
import {
    SIGNAL_TIMEOUT_MS, applyUpdate, decodeFrame, isOnFrequency, isTunable,
    snapshotToMap, visibleUsers,
} from './reporter.js';

// One Opus frame is 20 ms. Starting a burst that far ahead of the clock is
// enough for the Web Audio scheduler and short enough not to clip the first
// syllable — v1 learned this the hard way at 50 ms, which lost half a word.
const LEAD_IN_SEC = 0.02;

const MODES = ['usb', 'lsb'];

export default function FreeDVExtension({ minimal }) {
    const { running, audioState, tuning, actions, player, audio } = useRadio();
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [signal, setSignal] = useState(false);
    const [frames, setFrames] = useState(0);
    const [users, setUsers] = useState(() => new Map());
    const [reporter, setReporter] = useState('connecting');

    // The playback chain and the decoder. None of it may live in state: frames
    // arrive fifty times a second and a re-render per frame would be absurd.
    const a = useRef({
        decoder: null, rate: 0, channels: 0,
        chain: Promise.resolve(), nextPlayTime: 0,
        gain: null, ctx: null, epoch: -1,
        signalTimer: null,
    });

    // ── playback ────────────────────────────────────────────────────────────

    // A gain of our own, straight to the speakers, following the receiver's
    // volume and mute. The decoded voice is not the receiver's audio and must
    // not go through its filter chain — but it is what the operator is
    // listening to, so the volume control has to reach it.
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

    // Built when decoding starts rather than on the first frame, so the volume
    // is right before there is anything to hear — and so this effect does not
    // have to run per frame to find out the node exists.
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
        // tab, or a real silence between overs — resets the cursor rather than
        // trying to catch up, which would play a burst at double speed.
        const now = ctx.currentTime;
        if (s.nextPlayTime < now) s.nextPlayTime = now + LEAD_IN_SEC;
        src.start(s.nextPlayTime);
        s.nextPlayTime += buffer.duration;
    }, [player, ensureGain]);

    const onResult = (frame) => {
        const s = a.current;
        // Serialised: the Opus decoder is a stateful WASM module and is not
        // re-entrant, so two decodes must never overlap.
        s.chain = s.chain.then(() => play(frame)).catch(() => { /* one bad frame */ });

        setFrames((n) => n + 1);
        setSignal(true);
        clearTimeout(s.signalTimer);
        s.signalTimer = setTimeout(() => setSignal(false), SIGNAL_TIMEOUT_MS);
    };

    // The decoder takes no parameters: the server reads the tuned frequency
    // from the session, and the callsign and locator from its own config.
    const { state: attachState, error } = useAudioExtension({
        name: 'freedv',
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    // Silence the receiver while the decoder is playing over it.
    useEffect(() => {
        if (!player) return undefined;
        player.setDucked(decoding && live);
        return () => player.setDucked(false);
    }, [player, decoding, live]);

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // Stopping tears the decoder down: it holds a WASM instance, and leaving it
    // alive across a settings change would decode the next stream with the last
    // one's state.
    useEffect(() => {
        if (decoding) return undefined;
        const s = a.current;
        clearTimeout(s.signalTimer);
        setSignal(false);
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
        if (s.decoder) { try { s.decoder.free(); } catch (e) { /* ignore */ } }
        if (s.gain) { try { s.gain.disconnect(); } catch (e) { /* ignore */ } }
    }, []);

    // ── the reporter ────────────────────────────────────────────────────────
    //
    // Subscribed for as long as the panel is open, not only while decoding:
    // its whole purpose is telling you where to tune before you start.
    useEffect(() => {
        const release = dxcluster.acquire('freedv_activity');
        const off = dxcluster.on('freedv', (ev) => {
            if (ev.kind === 'snapshot') {
                setUsers(snapshotToMap(ev.users));
                setReporter('ok');
            } else {
                setUsers((prev) => applyUpdate(prev, ev));
                setReporter('ok');
            }
        });
        const offStatus = dxcluster.on('subscribed', (ev) => {
            // Only a refusal, not the confirmation the server also sends when
            // this unsubscribes — both carry enabled:false.
            if (ev && ev.stream === 'freedv_activity' && !ev.enabled && ev.error) {
                setReporter('unavailable');
            }
        });
        return () => { off(); offStatus(); release(); };
    }, []);

    const bandName = bandForFrequency(tuning.frequency);
    const band = useMemo(() => {
        const hit = HAM_BANDS.find(([name]) => name === bandName);
        return hit ? { min: hit[1], max: hit[2] } : null;
    }, [bandName]);
    const rows = useMemo(() => visibleUsers(users, band), [users, band]);

    const tuneToStation = (user) => {
        if (!isTunable(user)) return;
        actions.tuneTo({
            frequency: user.freqHz,
            // FreeDV is USB above 10 MHz and LSB below, as SSB voice is.
            mode: user.freqHz >= 10000000 ? 'usb' : 'lsb',
        });
        actions.ensureVisible(user.freqHz);
    };

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    return (
        <div className="tp fdv">
            <div className="tp__bar">
                <span className={`tp__status tp__status--${statusTone}`} title="Whether the decoder is attached to your audio session on the server">
                    {statusLabel}
                </span>
                {/* Frames arrive only while a signal is being decoded, so this
                    lamp is the presence of traffic and nothing else. */}
                <span
                    className={`fdv__signal${signal ? ' is-on' : ''}`}
                    title={signal
                        ? 'A RADE signal is being decoded'
                        : 'No frames are arriving — either nothing is transmitting or the receiver is not on the signal'}
                >
                    {signal ? 'Signal' : 'No signal'}
                </span>
                <span className="tp__bar-gap" />

                {decoding
                    ? (
                        <Button size="sm" onClick={() => setDecoding(false)} icon={<Icon.Stop size={13} />} title="Stop decoding and unmute the receiver">
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setDecoding(true)}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? 'Decode the FreeDV signal and play the voice it carries'
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
                    Pick a station below, or tune to a FreeDV signal in USB, then press Start. The receiver is silenced while the decoder plays.
                </div>
            )}
            {decoding && !MODES.includes(tuning.mode) && (
                <div className="note note--warn">FreeDV is a sideband mode; nothing will decode in {tuning.mode.toUpperCase()}.</div>
            )}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}

            {!minimal && (
                <div className="tp__controls">
                    <span className="tp__bar-gap" />
                    <span className="fdv__stat" title="Audio frames decoded and played this session">
                        {frames.toLocaleString()} frames
                    </span>
                    <span className="fdv__stat" title="What the receiver is tuned to">
                        {formatHz(tuning.frequency)} {tuning.mode.toUpperCase()}
                    </span>
                </div>
            )}

            {/* One view, unlike v1, which toggled between this and a
                waterfall of the decoded voice. The signal lamp and the frame
                count already answer "is it decoding"; where to point the
                receiver is the question the list is here for. */}
            <div className="tp__console fdv__list">
                <div className="fdv__row fdv__row--head">
                    <span>Callsign</span>
                    <span>Country</span>
                    <span className="fdv__c-num">km</span>
                    <span>Grid</span>
                    <span className="fdv__c-num">Freq</span>
                    <span>Message</span>
                </div>
                {rows.length === 0 && (
                    <Empty>
                        {reporter === 'unavailable'
                            ? 'FreeDV Reporter is not available on this receiver.'
                            : (reporter === 'connecting'
                                ? 'Connecting to FreeDV Reporter…'
                                : `No FreeDV stations on ${bandName || 'the air'} right now.`)}
                    </Empty>
                )}
                {rows.map((u) => {
                    const tunable = isTunable(u);
                    return (
                        <button
                            key={u.sid}
                            type="button"
                            className={`fdv__row${u.transmitting ? ' fdv__row--tx' : ''}${isOnFrequency(u, tuning.frequency) ? ' fdv__row--here' : ''}`}
                            disabled={!tunable}
                            onClick={() => tuneToStation(u)}
                            title={tunable
                                ? `Tune to ${formatHz(u.freqHz)}`
                                : 'Outside this receiver’s range'}
                        >
                            <span className="fdv__c-call">
                                {u.transmitting && <span className="fdv__tx" title="Transmitting now">●</span>}
                                {u.callsign || '—'}
                            </span>
                            <span className="fdv__c-country">{u.country}</span>
                            <span className="fdv__c-num">{u.distanceKm == null ? '' : u.distanceKm.toFixed(0)}</span>
                            <span className="fdv__c-grid">{u.grid}</span>
                            <span className="fdv__c-num">{u.freqHz ? formatHz(u.freqHz) : '—'}</span>
                            <span className="fdv__c-msg">{u.message}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
