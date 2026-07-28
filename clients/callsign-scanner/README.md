# Callsign Scanner (proof of concept)

Hops around detected voice activity, feeds each frequency to the Whisper
speech-to-text extension, extracts candidate callsigns from the transcript, and
validates every one against QRZ.

The real output is a JSONL log — one record per candidate, with the raw
transcript that produced it. That file is what tells you whether the approach
works on your bands and conditions.

---

## 1. Install

```bash
cd clients/callsign-scanner
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Only two dependencies: `requests` and `websocket-client`. No audio codecs — the
client never decodes audio (see [Why muting is free](#why-muting-is-free)).

## 2. Check the instance first

```bash
.venv/bin/python scanner.py --check --host 44.31.241.7 --port 8080
```

```
Pre-flight: http://44.31.241.7:8080

  OK    Instance reachable — UberSDR 0.1.58
  OK    Speech-to-text enabled
  OK    Lookup service enabled
  OK    Noise floor monitoring enabled
  OK    10 voice signals active across 3 band(s)
  OK    Bypassed IP — no lookup rate limit, no session time cap
  OK    CTY available — free unallocated-prefix filter active
  WARN  Cannot detect whisper.allow_client_params remotely...

Ready to scan.
```

`--check` exits without scanning. Any `FAIL` must be fixed first; `WARN` items
still let a scan run, and the output tells you which flags to add.

### Server requirements

| Setting | Needed for |
|---|---|
| `whisper.enabled: true` | Transcription at all. Also needs a reachable `whisper.server_url` |
| `lookup_services.enabled: true` | QRZ validation — without it there is nothing to check against |
| `noisefloor.enabled: true` | Voice activity detection, i.e. somewhere to hop |
| `whisper.allow_client_params: true` | The tuned recognition parameters. Optional — see below |

## 3. Run it

```bash
.venv/bin/python scanner.py --host 44.31.241.7 --port 8080 --verbose
```

Stop with Ctrl-C; it drains the transcription pipeline and prints a summary.

**Don't pipe through `tail`** — it buffers everything until exit and you will
see nothing while it runs. Use `tee` if you want a copy:

```bash
.venv/bin/python scanner.py --host 44.31.241.7 --verbose 2>&1 | tee run.log
```

### If the attach is rejected

`whisper.allow_client_params` defaults to `false`, and there is no way to detect
it remotely. If the attach fails with a message about per-attach recognition
parameters being disabled, either set it on the server or run:

```bash
.venv/bin/python scanner.py --host <host> --stock-whisper
```

`--stock-whisper` sends no recognition parameters, so the server's own config
applies: `task: translate` and auto-detect language. Expect noticeably worse
results — auto-detect misfires on noisy narrowband audio and translate-mode then
invents fluent prose from noise. The tuned path uses `transcribe`, a pinned
language, and a NATO-phonetics prompt.

### If you are not on a bypassed IP

`--check` tells you. Bypassed IPs (localhost and RFC1918 by default, per
`server.timeout_bypass_ips`) get unlimited lookups and no session time cap.
Otherwise:

```bash
.venv/bin/python scanner.py --host <host> --lookup-interval 6.0
```

That keeps you inside the default 10 lookups/minute. Without it you will see
`429` warnings and candidates will go unvalidated.

## 4. Read the results

```bash
.venv/bin/python analyse.py detections.jsonl
```

Reports precision overall and broken down by extraction path, by whether a cue
phrase was present, and by strict-token count — so you can see where the errors
concentrate and re-tune the gates. It also lists what the extractor invented,
which is the most useful thing in the file.

Raw records look like:

```json
{"time":"2026-07-28T14:22:31Z","band":"20m","frequency":14225000,"mode":"usb",
 "snr":14.2,"raw_text":"CQ CQ this is mike mike three november delta hotel",
 "candidate":"MM3NDH","normalised":"MM3NDH","source":"phonetic",
 "extract_confidence":0.8,"strict_tokens":4,"cued":true,
 "validated":true,"lookup_summary":"Nathan — Scotland",
 "dx_spot":"MM3NDH","agrees_with_dx_spot":true,
 "attribution_certain":true,"straddled_hop":false}
```

`agrees_with_dx_spot` is the metric to watch. The voice activity feed carries
`dx_callsign` when the DX cluster has spotted that frequency within 30 minutes,
so it is free ground truth — agreement means the whole chain worked end to end.
It only fires when the DX cluster is enabled *and* has a recent spot on that
exact frequency, so on a quiet instance expect zeroes.

## 5. Useful flags

| Flag | Default | Why change it |
|---|---|---|
| `--band 20m` | all | Restrict to one band for a focused test |
| `--dwell` | 45 s | Listen time per frequency (~3 VAD segments) |
| `--max-dwell` | 180 s | Ceiling, so a busy net cannot hold the scanner |
| `--revisit-cooldown` | 120 s | How long before a frequency may be revisited |
| `--min-snr` | 8.0 | Raise to skip marginal signals |
| `--min-extract-confidence` | 0.4 | Raise for precision, lower for recall |
| `--pipeline-latency` | 2.0 s | Raise if your WhisperLive is slow (affects frequency attribution) |
| `--verbose` | off | Log every transcript segment and rejection — use this while testing |
| `--no-prefilter` | off | Send every candidate to QRZ, skipping the free CTY filter |

A good first test, focused and chatty:

```bash
.venv/bin/python scanner.py --host <host> --band 40m --dwell 60 --verbose
```

## 6. Tests

```bash
.venv/bin/python -m unittest discover -p 'test_*.py'
```

The false-positive tests in `test_phonetics.py` matter more than the positive
ones — a recall improvement that lets ordinary conversation through is a bad
trade. `test_rotation.py` guards against camping on one frequency.

---

## Troubleshooting

**"Invalid session. Please refresh the page and try again."**
The UUID was never registered. The client calls `POST /connection` before
opening any socket; if that call fails the audio handler rejects the UUID
because it has no recorded User-Agent (`websocket.go:563`). Check the
`/connection` response in the log.

**"Session IP mismatch"**
`server.enforce_session_ip_match` is on and your outbound IP changed between the
`/connection` call and the WebSocket. Common behind round-robin proxies or VPNs.

**Whisper attaches but no segments ever arrive**
Check the server can reach its WhisperLive (`whisper.server_url`), and that
`whisper.max_users` is not already exhausted — the scanner holds one slot for
its whole run.

**"Server does not support reset_transcript"**
An older server. The scanner degrades automatically and warns once. It keeps
working, but Whisper's duplicate-suppression history now persists across
frequencies, so a repeated phrase on a new frequency may be dropped.

**Lots of `429` in the log**
Not a bypassed IP. Add `--lookup-interval 6.0`.

**Zero candidates after a long run**
Normal on quiet bands. Run with `--verbose` and look at the raw segments — if
Whisper is producing plausible English but no callsigns are being spoken, the
scanner is working correctly and the band is just not giving you anything.

---

## How it works

```
/api/voice-activity/stream ──► ActivityTracker ──► pick target
                                                        │
                                                     tune (in place)
                                                        │
  /ws (muted) ──► Whisper extension ──► /ws/dxcluster ──► segments
                                                        │
                                             timeline attribution
                                                        │
                                       extract ──► QRZ ──► detections.jsonl
```

### One session, never rebuilt

`POST /connection` registers the UUID, then two WebSockets are opened once and
held for the whole run:

- `/ws` — creates the audio session, immediately muted
- `/ws/dxcluster` — extension control and transcript results

Hopping uses the `tune` control message, which mutates the existing radiod
channel in place and leaves the Whisper tap attached. The audio session and the
Whisper attach are **never** torn down between frequencies — only at shutdown.

### Why muting is free

The extension tap is fed in the RTP receive path (`audio.go:286`), upstream of
the mute check in `streamAudio` (`websocket.go:1618`). So Whisper still receives
full-rate audio server-side while this client receives no audio bytes at all —
no Opus, no zstd, no decoding.

### Frequency attribution

Whisper's output lags its input: VAD accumulates up to 15 s of speech
(`max_speech_duration_s`) and inference adds more. A segment arriving two seconds
after a hop is usually audio from the *previous* frequency.

`timeline.py` maps each segment back onto whichever frequency was tuned while its
audio was captured:

```
audio_end   ≈ received_at − pipeline_latency
audio_start ≈ audio_end − segment_duration
```

Segments entirely inside one tune window are attributed with certainty. Segments
spanning a hop go to whichever frequency covered more audio and are flagged
`straddled_hop` / `attribution_certain: false`.

On every hop the scanner sends a `reset_transcript` control message, clearing
Whisper's duplicate-suppression history — without it a genuine new "this is …"
on the new frequency is dropped as a duplicate of the previous one. It is a
control message, not a teardown.

### Rotation

Selection is tiered rather than a plain priority sort, because priority alone
camps: a loud frequency with a DX spot and a previous success out-scores an
unvisited weak one even with its idle bonus at zero. So selection prefers
targets outside their cooldown, never repeats the immediately-previous
frequency, and only falls back to a repeat when it is genuinely the only target
on the air. Over a 24-dwell run across 6 targets this gives the best frequency
about a third of the dwells while still reaching every one.

### Extraction

Two problems make naive matching useless:

1. Operators routinely ignore NATO. "Germany Four Radio Sugar" is an ordinary
   way to send G4RS.
2. Many phonetic words are ordinary English — "for" is 4, "to" is 2, "king" is
   K — so plain conversation yields callsign-shaped token runs.

Mappings are split into STRICT (unambiguous on-air words: `foxtrot`, `niner`,
`zulu`) and LOOSE (ambiguous English and geographic phonetics). A run is promoted
only if it carries two strict tokens, or follows a cue phrase (`this is`, `cq`,
`de`, `qrz`, …) — which is where callsigns actually live. Callsigns Whisper
spelled out literally are matched separately and scored higher.

### Validation

**QRZ is the only validator.** A 200 from `/api/lookup` means the station
exists; a 404 means it does not.

Before a lookup is spent, a candidate must pass, in order:

1. ITU structural regex at extraction time
2. The strict-token / cue evidence gate
3. `--min-extract-confidence`
4. Re-check of the structure **after** normalisation — stripping a prefix
   overlay can leave something that is no longer a callsign
5. A free negative CTY filter: a 404 from `/api/cty/lookup` means the prefix
   belongs to no DXCC entity, so the callsign cannot be real
6. The local cache — each callsign is looked up at most once, negatives included

CTY is used **only** as a negative filter. It resolves by longest-prefix match,
so it returns "United Kingdom" for `G4ZZZZ` whether or not that station is
licensed — a CTY hit proves nothing, only a miss is informative.

---

## Known limitations

- One Whisper instance per session, and `whisper.max_users` defaults to 2, so
  the scanner occupies a slot for its whole run.
- Scanning is serial. With 20–40 active signals a full cycle takes many minutes,
  and callsigns are given at the start and end of overs, so the hit rate per
  dwell is inherently low. Parallel scanning would need multiple sessions.
- WhisperLive exposes no per-segment confidence, so ASR certainty cannot be
  thresholded — only the extractor's own heuristic is available.
- `--pipeline-latency` is a fixed estimate, not measured. Segments spanning a
  hop are flagged rather than resolved precisely.
