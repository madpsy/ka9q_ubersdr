# Decoder architecture and expansion catalog

UltraSDR separates decoders by the type and ownership of their input stream.
This prevents a per-browser audio plugin from being stretched into a
multi-megahertz, always-on IQ service.

## Extension contracts

| Contract | Lifetime | Input | Current integrations |
| --- | --- | --- | --- |
| Scheduled decoder plugin | Server-owned, timed | Recorded or streaming narrow audio | WSPR, FT8, FT4, FT2, JS8 |
| Interactive audio extension | One process/state machine per listening session | PCM tapped before browser encoding | CW, RTTY/FSK, NAVTEX, WEFAX, SSTV, packet/AX.25, FreeDV, DRM, DMR/P25 family, paging/signalling |
| Shared IQ service adapter | Server-owned, long-running | Named KA9Q IQ multicast channel plus metadata | Contract/design ready; service adapters below are the next implementation boundary |

Audio extensions use a registry/factory interface and fixed, typed client
parameters. External decoders are supervised, concurrency-limited processes.
Arbitrary client-supplied executables and flags are prohibited.

A shared IQ adapter must declare:

- decoder ID and version;
- center frequency, sample rate, sample format, and minimum usable bandwidth;
- whether it owns a tuner or consumes an already-available IQ channel;
- retune cost, restart policy, and CPU/memory limits;
- structured outputs, health, and readiness state;
- a fixed server-side command or container definition.

The scheduler, not the decoder, must arbitrate tuners. It needs the number of
receivers, instantaneous bandwidth, active center frequency, permissible RF
range, dwell time, priority, and whether a decoder may be interrupted.

## Priority shared-IQ adapters

| Priority | Target | Reference service | Typical input | Output |
| --- | --- | --- | --- | --- |
| 1 | ADS-B / Mode S | readsb | 1090 MHz, ~2–2.4 Msps IQ | Aircraft/tracks, Beast/JSON |
| 1 | 978 UAT | dump978-fa | 978 MHz, ~2 Msps IQ | Aircraft/weather JSON |
| 1 | ISM sensors | rtl_433 | 433/868/915 MHz IQ | Typed sensor JSON |
| 1 | AIS | AIS-catcher or rtl_ais | Marine VHF IQ | NMEA/JSON vessel reports |
| 2 | ACARS | acarsdec | Airband IQ/audio | ACARS messages |
| 2 | VDL Mode 2 | dumpvdl2 | Airband IQ | Structured VDL2 messages |
| 2 | HFDL | dumphfdl | HF IQ | Aircraft/ground messages |
| 2 | Broadcast FM RDS | redsea | WFM composite/baseband | RDS groups and station metadata |
| 2 | Digital radio | dablin/welle.io, nrsc5 | VHF/FM-band IQ | Services, metadata, audio |
| 3 | Satellite/weather | SatDump | Protocol-dependent wide IQ | Images, telemetry, products |
| 3 | Occupancy/astronomy | GNU Radio or FFT workers | Wide IQ | Spectra, events, metrics |

These tools are not all bundled into the main image: several require direct
tuner ownership, large bandwidth, GPU/CPU budgets, or separate licenses and
data-retention decisions. The supported deployment pattern is one container
per shared decoder, attached to a server-created KA9Q IQ channel. This also
avoids multiple containers fighting over the same USB device.

## Definition of done for a new adapter

An adapter is “supported” only when it has a pinned container/tool version, a
typed configuration schema, health/readiness reporting, recorded-IQ fixtures,
structured output tests, resource limits, restart behavior, Web UI display,
and hardware-in-the-loop results for at least one representative receiver.
Listing a protocol in this catalog alone does not claim operational support.
