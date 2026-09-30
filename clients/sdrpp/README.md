# UberSDR source for SDR++

A native SDR++ source module that streams IQ from an UberSDR receiver. SDR++
then does its own spectrum, waterfall and demodulation, exactly as it would with
local hardware. For installing a release build, see [INSTALL.txt](INSTALL.txt).

## What it does

- **Receivers from anywhere.** The public directory (instances.ubersdr.org, with
  search), mDNS discovery of `_ubersdr._tcp` on the LAN, or a typed address
  (`https://host`, `host:port`, a pasted `/ws` URL).
- **The rates this session may use.** The directory's `public_iq_modes` is shown
  as a hint only. Connect asks the receiver's `/connection`, with the password,
  and offers exactly the `allowed_iq_modes` it grants, plus the 12 kHz `iq` mode
  every receiver serves. A password or an allow-listed IP can open more than the
  directory advertises.
- **Protocol v4** (`version=4`) via the same decoder as the SoapySDR driver
  (`../soapy_driver/pcm_v4.hpp`), with the reduced-depth `min_margin` quality
  setting, changeable live through `set_min_margin`.
- **TLS on every platform**, from a statically linked mbedTLS. Certificates are
  judged by the OS trust store on Windows (CryptoAPI) and macOS (SecTrust), and
  against the system CA bundle on Linux. It can be turned off per install for
  self-signed receivers.
- **Status**: throughput on the wire (kB/s and Mbit/s), lossless or reduced
  depth, access level, session and daily time limits, and the server's own
  error text when it refuses something.

Settings are kept per receiver (password, rate, quality) in
`ubersdr_source_config.json` in the SDR++ config directory.

## How it fits into SDR++

It is an ordinary SDR++ source module, built outside the SDR++ tree against
SDR++'s headers alone; nothing in SDR++ is changed. The core and VOLK are
already loaded by the SDR++ process that opens the module, so the module is
not linked against a copy of either. On Windows, where a DLL must name its
imports, the link uses import libraries generated from the DLLs in the SDR++
release (`tools/pe_imports.py`).

One binary per platform works in both upstream SDR++ and SDR++ Community
Edition. Their module-facing headers match except for one thing: CE inserts a
gain callback into `SourceManager::SourceHandler` before `ctx`. The module
registers a superset of the struct and fills it for whichever core it finds
itself in, recognising CE by the `SourceManager::setGain` it exports
(`src/sdrpp_compat.h`).

The SDR++ headers are pinned to an upstream commit in `CMakeLists.txt`; point
`SDRPP_SOURCE_DIR` at another checkout to build against that instead.

## Layout

| Path | |
|---|---|
| `src/main.cpp` | the module: SDR++ callbacks, menu, per-receiver settings |
| `src/iq_session.*` | one stream: `/connection`, WebSocket, v4 decode into the SDR++ stream, tune/margin/ping |
| `src/server_api.*` | `/connection`, `/api/description`, the public directory |
| `src/mdns.*` | mDNS browser (multicast on 5353, plus legacy unicast) |
| `src/websocket.*`, `src/http.*` | minimal RFC 6455 and HTTP/1.1 clients |
| `src/tls_conn.*`, `src/trust.cpp` | TCP and TLS, and the per-OS certificate decision |
| `src/sdrpp_compat.*` | the upstream/CE `SourceHandler` difference |
| `compat/volk/volk.h` | the three VOLK allocator declarations `dsp::stream` needs |
| `test/live_test.cpp` | everything below the menu, against a live receiver |
| `test/host_test.cpp` | loads the built module into a real SDR++ core, headless, and streams through its signal path |
| `docker/` | Linux (Ubuntu Focal) and Windows (clang-cl + xwin) build images |
| `tools/` | import checks against real SDR++ releases |

## Building

For a local build on Linux or macOS, for development:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

Release builds for every platform come from `./build.sh`, which also checks
each binary against the current upstream nightly and the pinned CE release:

```sh
./build.sh                      # Linux x86_64 + aarch64, Windows x64, macOS universal
./build.sh --only=linux,windows
./build.sh --test               # ...and run each in the real cores against a receiver
./build.sh --publish            # ...and upload the zips to the `latest` release (asks first)
```

- Linux builds in Docker on Ubuntu Focal (glibc 2.31), so it loads on
  Bullseye, Focal and everything newer. aarch64 runs under emulation.
- Windows builds in Docker with clang-cl against Microsoft's CRT and SDK, which
  xwin downloads. Building that image accepts Microsoft's license terms. The CRT
  is pinned older than the runtimes SDR++ ships.
- macOS builds over ssh on `$MAC_HOST` (default `macbook`) with a portable
  CMake, and is then signed with the Developer ID and notarised. A macOS zip
  without Apple's acceptance is not published.

### Tests

`--test` runs `host_test` in upstream's and CE's cores on each platform: Linux
natively, Windows under wine, macOS on the Mac with the dylib quarantined as a
browser would leave it. Set `UBERSDR_TEST_SERVER` and `UBERSDR_TEST_MODE` to
choose the receiver and rate.

Under wine, the tests force SDR++'s bundled MSVC runtime
(`WINEDLLOVERRIDES=msvcp140=n,b;...`). SDR++ is compiled with MSVC 14.40+, whose
`std::mutex` needs the runtime it ships, and wine's built-in `msvcp140` is older
and deadlocks in `ConfigManager::disableAutoSave`. Real Windows always uses the
bundled runtime.

To run the tests by hand on Linux:

```sh
cmake -S . -B build -DUBERSDR_TEST_CORE_LIB=/path/to/libsdrpp_core.so
cmake --build build
LD_LIBRARY_PATH=/path/to LIVE_DISCOVERY=1 build/live_test https://m9psy-1.instance.ubersdr.org iq192 6 10
LD_LIBRARY_PATH=/path/to build/host_test $PWD/build/ubersdr_source.so /tmp/root https://m9psy-1.instance.ubersdr.org iq96 5
```

## Not supported

- **Android.** The SDR++ APK bundles its modules, so an external one cannot be
  added to it.
- **32-bit Linux (armhf).** SDR++ does not publish armhf builds to check against.
