#!/usr/bin/env bash
# Runs the v2 protocol tests. Needs only esbuild and node — no npm install.
#
# These cover the two binary wire formats (spectrum SPEC frames and the v2 Opus
# audio header), which are the parts of the client where a silent off-by-one
# produces plausible-looking garbage rather than an error.

set -euo pipefail
cd "$(dirname "$0")"

command -v esbuild >/dev/null || { echo "esbuild not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

mkdir -p .build
esbuild ../src/radio/spectrum-connection.js --bundle --format=cjs --platform=node \
    --outfile=.build/spectrum.cjs --log-level=warning
esbuild ../src/radio/audio-connection.js --bundle --format=cjs --platform=node \
    --outfile=.build/audio.cjs --log-level=warning
esbuild ../src/radio/constants.js --bundle --format=cjs --platform=node \
    --outfile=.build/constants.cjs --log-level=warning
esbuild ../src/lib/dsp.js --bundle --format=cjs --platform=node \
    --outfile=.build/dsp.cjs --log-level=warning
esbuild ../src/display/uiConfig.js --bundle --format=cjs --platform=node \
    --outfile=.build/uiconfig.cjs --log-level=warning
esbuild ../src/lib/format.js --bundle --format=cjs --platform=node \
    --outfile=.build/format.cjs --log-level=warning
esbuild ../src/lib/markers.js --bundle --format=cjs --platform=node \
    --outfile=.build/markers.cjs --log-level=warning
esbuild ../src/lib/audioBand.js --bundle --format=cjs --platform=node \
    --outfile=.build/audioband.cjs --log-level=warning
esbuild ../src/radio/audio-filters.js --bundle --format=cjs --platform=node \
    --outfile=.build/audiofilters.cjs --log-level=warning
esbuild ../src/lib/eqLevels.js --bundle --format=cjs --platform=node \
    --outfile=.build/eqlevels.cjs --log-level=warning
esbuild ../src/lib/mentions.js --bundle --format=cjs --platform=node \
    --outfile=.build/mentions.cjs --log-level=warning
esbuild ../src/lib/recorder.js --bundle --format=cjs --platform=node \
    --outfile=.build/recorder.cjs --log-level=warning
esbuild ../src/lib/zoom.js --bundle --format=cjs --platform=node \
    --outfile=.build/zoom.cjs --log-level=warning
esbuild ../src/lib/bands.js --bundle --format=cjs --platform=node \
    --outfile=.build/bands.cjs --log-level=warning
esbuild ../src/lib/vfos.js --bundle --format=cjs --platform=node \
    --outfile=.build/vfos.cjs --log-level=warning
esbuild ../src/lib/needle.js --bundle --format=cjs --platform=node \
    --outfile=.build/needle.cjs --log-level=warning
esbuild ../src/lib/listeners.js --bundle --format=cjs --platform=node \
    --outfile=.build/listeners.cjs --log-level=warning
esbuild ../src/radio/idle.js --bundle --format=cjs --platform=node \
    --outfile=.build/idle.cjs --log-level=warning
esbuild ../src/lib/myip.js --bundle --format=cjs --platform=node \
    --outfile=.build/myip.cjs --log-level=warning
esbuild ../src/lib/voiceActivity.js --bundle --format=cjs --platform=node \
    --outfile=.build/voice.cjs --log-level=warning
esbuild ../src/lib/spaceWeather.js --bundle --format=cjs --platform=node \
    --outfile=.build/spaceweather.cjs --log-level=warning
esbuild ../src/compat/legacyBridge.js --bundle --format=cjs --platform=node \
    --outfile=.build/compat.cjs --log-level=warning
esbuild ../src/lib/callsign.js --bundle --format=cjs --platform=node \
    --outfile=.build/callsign.cjs --log-level=warning
esbuild ../src/lib/spots.js --bundle --format=cjs --platform=node \
    --outfile=.build/spots.cjs --log-level=warning
esbuild ../src/controls/functions.js --bundle --format=cjs --platform=node \
    --outfile=.build/functions.cjs --log-level=warning
esbuild ../src/controls/mappings.js --bundle --format=cjs --platform=node \
    --outfile=.build/mappings.cjs --log-level=warning
esbuild ../src/controls/flexcontrol.js --bundle --format=cjs --platform=node \
    --outfile=.build/flexcontrol.cjs --log-level=warning
esbuild ../src/controls/webmidi.js --bundle --format=cjs --platform=node \
    --outfile=.build/webmidi.cjs --log-level=warning
esbuild ../src/controls/hardware.js --bundle --format=cjs --platform=node \
    --outfile=.build/hardware.cjs --log-level=warning
esbuild ../src/controls/radiosync.js --bundle --format=cjs --platform=node \
    --outfile=.build/radiosync.cjs --log-level=warning
esbuild ../src/radio/dxcluster-connection.js --bundle --format=cjs --platform=node \
    --outfile=.build/dxcluster.cjs --log-level=warning
esbuild ../src/extensions/protocol.js --bundle --format=cjs --platform=node \
    --outfile=.build/extprotocol.cjs --log-level=warning
esbuild ../src/extensions/frequencies.js --bundle --format=cjs --platform=node \
    --outfile=.build/extfreq.cjs --log-level=warning
esbuild ../src/extensions/ft8/messages.js --bundle --format=cjs --platform=node \
    --outfile=.build/ft8messages.cjs --log-level=warning
esbuild ../src/extensions/ft8/spectrum.js --bundle --format=cjs --platform=node \
    --outfile=.build/ft8spectrum.cjs --log-level=warning
esbuild ../src/extensions/teleprinter.js --bundle --format=cjs --platform=node \
    --outfile=.build/teleprinter.cjs --log-level=warning
esbuild ../src/extensions/toneSpectrum.js --bundle --format=cjs --platform=node \
    --outfile=.build/tonespectrum.cjs --log-level=warning
esbuild ../src/extensions/fsk/presets.js --bundle --format=cjs --platform=node \
    --outfile=.build/fskpresets.cjs --log-level=warning
esbuild ../src/extensions/navtex/messages.js --bundle --format=cjs --platform=node \
    --outfile=.build/navtex.cjs --log-level=warning
esbuild ../src/extensions/morse/frames.js --bundle --format=cjs --platform=node \
    --outfile=.build/morse.cjs --log-level=warning
esbuild ../src/extensions/wefax/image.js --bundle --format=cjs --platform=node \
    --outfile=.build/wefax.cjs --log-level=warning
esbuild ../src/lib/markerNav.js --bundle --format=cjs --platform=node \
    --outfile=.build/markernav.cjs --log-level=warning
esbuild ../src/lib/announce.js --bundle --format=cjs --platform=node \
    --outfile=.build/announce.cjs --log-level=warning
esbuild ../src/lib/shortcuts.js --bundle --format=cjs --platform=node \
    --outfile=.build/shortcuts.cjs --log-level=warning
esbuild ../src/lib/backup.js --bundle --format=cjs --platform=node \
    --outfile=.build/backup.cjs --log-level=warning
esbuild ../src/radio/media/metadata.js --bundle --format=cjs --platform=node \
    --outfile=.build/mediametadata.cjs --log-level=warning
esbuild ../src/radio/media/support.js --bundle --format=cjs --platform=node \
    --outfile=.build/mediasupport.cjs --log-level=warning
esbuild ../src/extensions/qrss/dsp.js --bundle --format=cjs --platform=node \
    --outfile=.build/qrssdsp.cjs --log-level=warning
esbuild ../src/extensions/freedv/reporter.js --bundle --format=cjs --platform=node \
    --outfile=.build/freedv.cjs --log-level=warning
esbuild ../src/extensions/sstv/frames.js --bundle --format=cjs --platform=node \
    --outfile=.build/sstv.cjs --log-level=warning
esbuild ../src/extensions/soundmodem/frames.js --bundle --format=cjs --platform=node \
    --outfile=.build/soundmodem.cjs --log-level=warning
esbuild ../src/extensions/soundmodem/ax25.js --bundle --format=cjs --platform=node \
    --outfile=.build/ax25.cjs --log-level=warning
esbuild ../src/extensions/soundmodem/waterfall.js --bundle --format=cjs --platform=node \
    --outfile=.build/smwaterfall.cjs --log-level=warning
esbuild ../src/lib/timeConstant.js --bundle --format=cjs --platform=node \
    --outfile=.build/timeconstant.cjs --log-level=warning
esbuild ../src/lib/waterfallRing.js --bundle --format=cjs --platform=node \
    --outfile=.build/waterfallring.cjs --log-level=warning
esbuild ../src/extensions/whisper/frames.js --bundle --format=cjs --platform=node \
    --outfile=.build/whisper.cjs --log-level=warning
esbuild ../src/extensions/whisper/speech.js --bundle --format=cjs --platform=node \
    --outfile=.build/whisperspeech.cjs --log-level=warning
esbuild ../src/extensions/whisper/languages.js --bundle --format=cjs --platform=node \
    --outfile=.build/whisperlang.cjs --log-level=warning

node unresolved.js
node protocol.test.js
node modes.test.js
node zoom.test.js
node vfos.test.js
node needle.test.js
node listeners.test.js
node idle.test.js
node myip.test.js
node voice.test.js
node spaceweather.test.js
node callsign.test.js
node compat.test.js
node recorder.test.js
node controls.test.js
node spots.test.js
node extensions.test.js
node fsk.test.js
node navtex.test.js
node morse.test.js
node wefax.test.js
node qrss.test.js
node freedv.test.js
node sstv.test.js
node soundmodem.test.js
node whisper.test.js
node waterfall.test.js
node timeconstant.test.js
node mediasession.test.js
node announce.test.js
node shortcuts.test.js
node backup.test.js
