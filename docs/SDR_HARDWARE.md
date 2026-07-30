# SDR hardware support

UberSDR uses KA9Q Radio's `radiod` as its channel, spectrum, and multicast
engine. Hardware support therefore has two layers:

1. UberSDR describes the active receiver, validates its advertised RF coverage,
   and stops clients from tuning outside that coverage.
2. `radiod` or an external bridge opens the physical/network SDR and publishes
   KA9Q-compatible status and sample groups.

This boundary lets the web and decoder layers support HF, VHF, UHF, and
microwave deployments without embedding every vendor SDK into the web server.
It also keeps USB failures and high-rate IQ processing out of user sessions.

## Supported paths

| Family | `receiver.driver` | Integration path | Extra runtime dependency |
| --- | --- | --- | --- |
| RX-888 MkII/compatible | `rx888` | Native KA9Q Radio driver | FX3 firmware/libusb as required by the radiod build |
| RTL-SDR compatible | `rtlsdr` | Native KA9Q Radio driver | `librtlsdr` |
| Airspy R2/Mini | `airspy` | Native KA9Q Radio driver | `libairspy` |
| Airspy HF+ family | `airspyhf` | Native KA9Q Radio driver | `libairspyhf` |
| SDRplay RSP family | `sdrplay` | Native KA9Q Radio driver | SDRplay API matching the radiod build |
| HackRF family | `hackrf` | Native KA9Q Radio driver | `libhackrf` |
| Nuand bladeRF | `bladerf` | Native KA9Q Radio driver | `libbladeRF` |
| RigExpert Fobos | `fobos` | Native KA9Q Radio driver | Fobos library |
| FUNcube Dongle Pro+ | `funcube` | Native KA9Q Radio driver | ALSA/USB HID support |
| HydraSDR | `hydrasdr` | Native KA9Q Radio driver | HydraSDR library |
| LimeSDR, USRP, PlutoSDR, Red Pitaya, remote receivers, and future devices | bridge-defined | `external-radiod` | A separately managed KA9Q-compatible bridge, commonly backed by SoapySDR or the vendor API |

The profile catalog describes drivers available in current KA9Q Radio source.
A particular binary can contain fewer optional drivers if it was built without
their development libraries. UberSDR cannot make a missing vendor library or
kernel USB permission appear; verify the driver in the deployed radiod image.

## Receiver configuration

The `receiver` block is the source of truth for browser and API frequency
validation:

```yaml
receiver:
  backend: ka9q-radiod
  driver: rtlsdr
  device: rtlsdr
  description: VHF/UHF receiver
  sample_rate: 2400000
  center_frequency: 145000000
  frequency_min_hz: 24000000
  frequency_max_hz: 1766000000
  options:
    agc: "true"
    bias: "no"
```

Set the range to frequencies the *deployment* can actually serve. Account for
direct-sampling modes, up/down-converters, preselectors, antenna switching, and
regional restrictions. Device headline limits are not reliable service limits.
UberSDR accepts both endpoints as tunable.

When `sample_rate` is smaller than that tunable range, the initial spectrum
uses one sample-rate-wide window around `center_frequency`; it does not pretend
that the entire tunable range is visible simultaneously. The native UI can pan
and retune within the wider coverage. WebSDR/Kiwi compatibility pages advertise
that instantaneous window because their legacy single-band coordinate systems
cannot separately express tunable range and current capture bandwidth.
Noise-floor bands outside that instantaneous window are skipped with a startup
log entry. Monitoring disjoint bands on one narrow device requires the planned
dwell/retune scheduler; configuring a large tuning range alone cannot make
those frequencies simultaneous.

The legacy behavior is preserved when the block is omitted:

```yaml
receiver:
  backend: ka9q-radiod
  driver: rx888
  frequency_min_hz: 10000
  frequency_max_hz: 30000000
```

For a receiver service managed outside the UberSDR deployment:

```yaml
receiver:
  backend: external-radiod
  driver: soapy
  description: Remote SoapySDR bridge
  frequency_min_hz: 500000
  frequency_max_hz: 6000000000

radiod:
  status_group: remote-status.local:5006
  data_group: remote-pcm.local:5004
  interface: eth0
```

`external-radiod` intentionally does not validate a driver name. The bridge is
responsible for discovery, sample-format conversion, time/discontinuity
metadata, tuning, gain controls, and publishing the KA9Q multicast protocol.

## Generating a native radiod configuration

Authenticated administrators can inspect the catalog:

```text
GET /admin/receiver-profiles
```

The response includes the active receiver, backend capabilities, and native
driver profiles. To preview a minimal radiod configuration without changing
files or restarting a service, post a receiver JSON object to the same endpoint:

```text
POST /admin/receiver-profiles
Content-Type: application/json
```

Review the preview against the matching KA9Q Radio example and the installed
driver version. The existing `/admin/radiod-config` endpoint remains the
explicit apply step.

## What “all SDRs” means in practice

No finite application can ship or test every SDR, firmware revision, vendor
SDK, FPGA image, and network protocol. The supported contract is therefore:

- native profiles for every receiver driver currently exposed by KA9Q Radio;
- a generic external receiver-service adapter for everything else;
- configuration-driven RF coverage throughout session and spectrum creation;
- driver options that can pass through without a web-server release;
- receive-only operation. Transmit controls are deliberately outside this
  abstraction and require a separate safety and authorization design.

The primary web UI, server WebSockets, admin bookmark/band paths, WebSDR, and
Kiwi compatibility layers consume the configured ranges. Some standalone
clients under `clients/` still carry their own legacy HF validation constants;
they should migrate to the receiver fields returned by `/api/description`
before being advertised for non-HF deployments.

## Decoder and monitoring priorities

The decoder registry allows additional audio decoders without extending a
central mode switch. Immediate monitoring targets by coverage are:

| Coverage | Priority targets |
| --- | --- |
| LF/HF | WSPR, FT8/FT4/FT2, JS8, CW/RBN, NAVTEX, weather fax, DRM, FreeDV |
| VHF air/marine | AM voice, ACARS/VDL2, AIS, NOAA APT |
| VHF/UHF land/mobile | NFM, APRS, paging, DMR/P25/NXDN metadata where lawful |
| 1090 MHz | ADS-B/Mode S |
| 433/868/915 MHz | ISM occupancy and operator-authorized telemetry |
| L/S band and above | satellite beacons, AERO/HRPT/GOES workflows, hardware permitting |

Wide-range hardware is not wide-instantaneous-bandwidth hardware. A monitor
scheduler must eventually model tuner count, current center frequency,
instantaneous bandwidth, retune cost, dwell time, and decoder priority before
multiple disjoint bands can be monitored honestly.
