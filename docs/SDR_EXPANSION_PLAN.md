# SDR expansion plan

## Baseline findings

UberSDR is a Go web, session, and monitoring application rather than a hardware driver. A single `RadiodController` communicates with KA9Q `radiod` over multicast, and sessions are expressed as radiod channels identified by SSRC. The included receiver template is RX888-specific. The Docker deployment grants USB access only to the KA9Q container, so device support today is defined by that container's KA9Q Radio build and configuration.

The decoder scheduler consumes demodulated PCM/WAV audio from radiod. Its built-in modes are WSPR, FT8, FT4, JS8, and FT2; mode selection, binary paths, CLI arguments, parser expectations, reporting, and lifecycle policy are currently coupled to a `DecoderMode` enum.

This is a strong architecture for one wideband KA9Q receiver, but it assumes a multicast KA9Q control plane, radiod presets, a single source namespace, and a small fixed decoder list.

## Target architecture

Keep the existing session API stable while adding a receiver layer underneath it:

1. **SDR backend**: owns discovery, opening a source, tuning, gain, clock state, and a capability declaration (frequency limits, sample rate, channels, IQ, GPSDO).
2. **source adapter**: normalizes a device or network source to timestamped complex IQ with explicit sample format, rate, center frequency, and discontinuity events.
3. **channel engine**: makes demodulated audio, spectrum tiles, and optional IQ taps from normalized IQ. KA9Q radiod remains the first channel-engine adapter during migration.
4. **monitor scheduler**: allocates tuners/bandwidth using priority, dwell time, CPU budget, and recording policy; it must never assume that every frequency is visible from one capture.
5. **decoder plugins**: declare accepted input, timing/window needs, parser, result schema, and reporting targets. Plugins run as trusted built-ins or out-of-process adapters with a versioned RPC protocol—never arbitrary in-process downloads.

The initial implementation adds a capability-oriented `SDRBackendRegistry`
with native and external-radiod paths, a catalog covering every receive driver
currently exposed by KA9Q Radio, configuration-driven RF coverage, and a
radiod configuration preview generator. It also moves the five built-in
decoder definitions behind a `DecoderPluginRegistry`. Omitting the new receiver
block preserves the existing RX-888/10 kHz–30 MHz behavior.

## Priority hardware families

| Priority | Families | Why / first path |
| --- | --- | --- |
| P0 | KA9Q Radio with RX888/USRP-class wideband frontends | Preserve and document the production path; supports wide HF monitoring now. |
| P1 | RTL-SDR v3/v4 and compatible rtl_tcp | Lowest-cost receive-only deployment; use a supervised `rtl_tcp`/Soapy adapter first for portability. |
| P1 | Airspy HF+ and Airspy R2/Mini | Strong HF/VHF performance; implement through SoapySDR or native sidecar where its controls matter. |
| P1 | SDRplay RSP family | Broad coverage and popular hardware; sidecar isolates vendor API/licensing and USB permissions. |
| P2 | HackRF One, LimeSDR, bladeRF | Wideband experiments and transmit-capable hardware; receive-only initially, with explicit TX interlocks later. |
| P2 | Ettus USRP, ADALM-Pluto, Red Pitaya | Network/high-rate and synchronized deployments; use UHD/IIO sidecars and expose clock/PTP/GPSDO state. |
| P2 | KiwiSDR / OpenWebRX / SpyServer / rtl_tcp remote sources | Enables geographically distributed monitoring without local USB access. |

Use SoapySDR where it provides a reliable common denominator, but retain backend-specific sidecars for timing, bias tee, preselectors, coherent channels, and device-specific calibration.

## Monitoring and decoding roadmap

### Phase 1 — HF and existing audio pipeline

- Migrate WSPR, FT8, FT4, JS8, and FT2 to registered plugins (started).
- Add AM broadcast/utility monitoring, CW/RBN, NAVTEX, weather fax, DRM, FreeDV, and digital audio extension results to a common event schema.
- Add receiver capability checks to band/decoder validation and operator-visible coverage gaps.

### Phase 2 — VHF/UHF spectrum monitoring

- Add narrowband FM/AM/SSB monitoring and signal classification.
- Add ADS-B (1090 MHz), ACARS/VDL2, AIS (161.975/162.025 MHz), APRS (144.39 MHz regional), NOAA APT, DMR, P25, NXDN, dPMR, TETRA, and pager workflows where lawful.
- Keep trunked/digital-voice handling as opt-in plugins with local legal and access controls; do not build interception or decryption features.

### Phase 3 — microwave/satellite and distributed sensing

- Add 433/868/915 MHz ISM telemetry, LoRaWAN gateways, GOES/HRPT, Inmarsat AERO, satellite beacon tracking, and direction/TDOA workflows where hardware timing supports them.
- Add multi-receiver scheduling, health scoring, calibrated occupancy maps, recordings with provenance, and an event bus for alerts.

## Delivery sequence

1. Add a `receiver.backend` configuration block and select `ka9q-radiod` by default. **Implemented.**
2. Catalog all current KA9Q receive drivers and add a generic externally managed radiod/Soapy path. **Implemented.**
3. Introduce a versioned sidecar protocol for direct-IQ sources; ship `rtl_tcp` and SoapySDR reference adapters.
4. Adapt the channel engine so radiod and direct-IQ adapters both satisfy the existing session/spectrum contracts.
5. Add plugin manifests, an out-of-process decoder runner, resource limits, and normalized events.
6. Add monitoring schedules, storage quotas, receiver health/clock metrics, and UI coverage reporting.

## Compatibility and safety rules

- Preserve the current radiod multicast + SSRC behavior until the direct-IQ path reaches feature parity.
- Treat frequency, gain, bandwidth, sample format, and timestamps as explicit metadata; do not infer them from a decoder mode.
- Default new device backends to receive-only. Any future transmit support requires separate credentials, physical/firmware interlocks, band-plan enforcement, and explicit operator enablement.
- Enforce per-plugin CPU, memory, runtime, output-size, and network permissions. Record only operator-authorized bands and retention periods.
