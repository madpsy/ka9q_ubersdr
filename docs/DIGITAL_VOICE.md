# Digital voice decoding

UberSDR provides a receive-only digital voice extension backed by
[DSD-FME](https://github.com/lwvmobile/dsd-fme). It is separate from the
scheduled weak-signal decoder subsystem because DMR and similar protocols are
continuous, listener-selected audio decoders rather than cycle-based FT8/WSPR
jobs.

## Supported profiles

| Profile | DSD-FME mode | Typical occupied bandwidth | Notes |
| --- | --- | ---: | --- |
| Auto | `-fa` | 12 kHz | Automatic DMR, P25, YSF, D-Star, and X2-TDMA detection |
| DMR | `-fs` | 7–12 kHz | Tier II base/mobile and simplex; two time slots |
| P25 Phase 1 | `-f1` | 12 kHz | Conventional FDMA |
| P25 Phase 2 | `-f2` | 12 kHz | TDMA traffic channel; some systems need trunking context not yet supplied by UberSDR |
| NXDN48 / IDAS | `-fi` | 7 kHz | 6.25 kHz channel |
| NXDN96 | `-fn` | 12 kHz | 12.5 kHz channel |
| D-Star | `-fd` | 12 kHz | Explicit selection required |
| YSF | `-fy` | 12 kHz | Yaesu System Fusion |
| M17 | `-fz` | 12 kHz | Explicit selection required |
| dPMR | `-fm` | 7 kHz | Explicit selection required |
| ProVoice | `-fp` | up to 24 kHz | Conventional ProVoice |
| EDACS / ProVoice | `-fh` | up to 24 kHz | Single-frequency control/voice decode only |
| X2-TDMA | `-fx` | 12 kHz | Explicit selection required |

This first integration handles a tuned conventional channel. Full trunk
following needs a separate channel-control service that can coordinate a
control-channel decoder, channel maps, talkgroup policy, and one or more
receiver VFOs. That belongs behind the same plugin boundary but is not implied
by the single-listener extension.

## Signal path

```text
SDR hardware -> radiod NFM demodulator -> 24 kHz mono audio tap
             -> stateful 48 kHz resampler -> DSD-FME stdin
             -> loopback UDP decoded PCM -> WebSocket -> browser playback
             -> stderr event parser       -> WebSocket -> event panel
```

DSD-FME expects 48 kHz, 16-bit, mono discriminator/baseband audio. UberSDR's
standard NFM preset supplies 24 kHz mono PCM, so the extension resamples it to
48 kHz while preserving phase across network packet boundaries.

The decoded-audio UDP socket binds to `127.0.0.1` on an ephemeral port. It is
not exposed on the network. Each listener receives a separate supervised
DSD-FME process and loopback socket.

## Installation and configuration

Build or install DSD-FME using its upstream instructions and make the
`dsd-fme` executable available to the UberSDR process. Then enable the server
extension:

```yaml
digital_voice_extension:
  enabled: true
  binary_path: "dsd-fme"
  max_users: 3
```

Also add the browser extension to `config/extensions.yaml`:

```yaml
extensions:
  - digitalvoice
```

An absolute `binary_path` can be used when DSD-FME is installed outside the
service `PATH`. Each active listener creates a decoder process, so public
instances should use a conservative `max_users` limit.

## Clear reception only

UberSDR does not accept privacy or encryption keys, key files, arbitrary
DSD-FME arguments, or client-selected executables. Protocol selection maps to a
fixed allowlist of decoding switches in
`audio_extensions/digitalvoice/profiles.go`.

DSD-FME may identify an encrypted call in its event output. UberSDR marks that
event as encrypted, and its UI labels the audio as suppressed. The integration
does not provide a decryption workflow.

## Current limitations and next steps

- A clean NFM discriminator/baseband signal is required. Voice-emphasized or
  aggressively filtered audio can prevent symbol synchronization.
- Auto mode is intentionally limited to the protocols DSD-FME can reliably
  auto-detect. NXDN, M17, dPMR, ProVoice, and EDACS use explicit profiles;
  explicit D-Star, YSF, and X2-TDMA profiles remain available when auto
  detection is undesirable.
- P25 Phase 2 traffic channels can require WACN/SYSID/NAC context. The public
  extension does not yet accept those advanced fields.
- Trunk following, talkgroup allow/block lists, channel maps, and multi-VFO
  coordination are planned as a separate privileged server-side controller.
- Metadata normalization is best-effort because DSD-FME currently exposes
  human-readable console events rather than a stable machine-readable event
  API. The original line is retained in every event.

The package has unit coverage for the protocol allowlist, safe command
construction, streaming resampler continuity, and common event parsing. A
hardware-in-the-loop test should feed known clear-air recordings for every
profile before a deployment claims RF-level interoperability.
