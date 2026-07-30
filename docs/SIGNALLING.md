# Paging and signalling decoder

UltraSDR includes a receive-only `multimon-ng` integration for common analogue
signalling carried in demodulated NFM audio. It runs inside the normal Docker
image and appears as **Paging & Signalling** in the decoder panel.

## Decoder profiles

| Profile | Formats |
| --- | --- |
| Paging | POCSAG 512/1200/2400 and FLEX |
| POCSAG | POCSAG 512/1200/2400 with alphanumeric output |
| FLEX | Motorola FLEX paging |
| SAME / EAS | Emergency Alert System SAME headers |
| DTMF | Dual-tone multi-frequency digits |
| Two-tone | ZVEI1/2/3, DZVEI, PZVEI, CCIR, EEA, and EIA |
| Legacy telemetry | UFSK1200, CLIPFSK, and FMSFSK |
| Auto / all | All formats above |

The server resamples the selected mono audio channel to the 22,050 Hz raw PCM
input expected by `multimon-ng`. The Web UI automatically selects NFM and a
12–15 kHz receive bandwidth before attaching the decoder.

## Configuration

```yaml
signalling_extension:
  enabled: true
  binary_path: "multimon-ng"
  max_users: 5
```

The Docker image installs `multimon-ng`. For a native deployment, install it
with the operating-system package manager or set `binary_path` to an absolute
executable path. Each listener owns one process, so set a conservative
`max_users` value on public receivers.

Clients select only a fixed server-side profile. They cannot supply command
arguments, executable paths, or additional demodulator names.

## Practical limits

- Paging and selective-calling traffic can contain personal or operational
  information. Operators are responsible for local monitoring and privacy law.
- Decoding requires clean discriminator/baseband audio. Voice filtering,
  squelch clipping, or incorrect deviation reduces reliability.
- FLEX support depends on the `multimon-ng` version packaged by the target
  distribution.
- The integration displays decoder lines as received and does not attempt to
  interpret, forward, archive, or alert on message content.
