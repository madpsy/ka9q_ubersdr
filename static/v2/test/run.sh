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
esbuild ../src/lib/palettes.js --bundle --format=cjs --platform=node \
    --outfile=.build/palettes.cjs --log-level=warning
esbuild ../src/lib/format.js --bundle --format=cjs --platform=node \
    --outfile=.build/format.cjs --log-level=warning
esbuild ../src/lib/spectrogram.js --bundle --format=cjs --platform=node \
    --outfile=.build/spectrogram.cjs --log-level=warning
esbuild ../src/lib/bandSpectrum.js --bundle --format=cjs --platform=node \
    --outfile=.build/bandspectrum.cjs --log-level=warning
esbuild ../src/lib/hoverTip.js --bundle --format=cjs --platform=node \
    --outfile=.build/hovertip.cjs --log-level=warning
esbuild ../src/lib/spectrumTrace.js --bundle --format=cjs --platform=node \
    --outfile=.build/spectrumtrace.cjs --log-level=warning
esbuild ../src/lib/spectrumStats.js --bundle --format=cjs --platform=node \
    --outfile=.build/spectrumstats.cjs --log-level=warning
esbuild ../src/lib/share.js --bundle --format=cjs --platform=node \
    --outfile=.build/share.cjs --log-level=warning
esbuild ../src/lib/uiColors.js --bundle --format=cjs --platform=node \
    --outfile=.build/uicolors.cjs --log-level=warning
esbuild ../src/lib/games/ttt.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-ttt.cjs --log-level=warning
esbuild ../src/lib/games/minesweeper.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-minesweeper.cjs --log-level=warning
esbuild ../src/lib/games/puzzle15.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-puzzle15.cjs --log-level=warning
esbuild ../src/lib/games/memory.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-memory.cjs --log-level=warning
esbuild ../src/lib/games/connect4.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-connect4.cjs --log-level=warning
esbuild ../src/lib/games/sudoku.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-sudoku.cjs --log-level=warning
esbuild ../src/lib/games/lightsout.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-lightsout.cjs --log-level=warning
esbuild ../src/lib/games/mastermind.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-mastermind.cjs --log-level=warning
esbuild ../src/lib/games/quiz.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-quiz.cjs --log-level=warning
esbuild ../src/lib/games/morse.js --bundle --format=cjs --platform=node \
    --outfile=.build/game-morse.cjs --log-level=warning
esbuild ../src/lib/markers.js --bundle --format=cjs --platform=node \
    --outfile=.build/markers.cjs --log-level=warning
esbuild ../src/lib/audioBand.js --bundle --format=cjs --platform=node \
    --outfile=.build/audioband.cjs --log-level=warning
esbuild ../src/lib/audioSinks.js --bundle --format=cjs --platform=node \
    --outfile=.build/audiosinks.cjs --log-level=warning
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
esbuild ../src/lib/markerNavSettings.js --bundle --format=cjs --platform=node \
    --outfile=.build/markernavsettings.cjs --log-level=warning
esbuild ../src/lib/operatorPhoto.js --bundle --format=cjs --platform=node \
    --outfile=.build/operatorphoto.cjs --log-level=warning
esbuild ../src/lib/bookmarkGroups.js --bundle --format=cjs --platform=node \
    --outfile=.build/bookmarkgroups.cjs --log-level=warning
esbuild ../src/lib/announce.js --bundle --format=cjs --platform=node \
    --outfile=.build/announce.cjs --log-level=warning
esbuild ../src/lib/shortcuts.js --bundle --format=cjs --platform=node \
    --outfile=.build/shortcuts.cjs --log-level=warning
esbuild ../src/lib/backup.js --bundle --format=cjs --platform=node \
    --outfile=.build/backup.cjs --log-level=warning
esbuild ../src/lib/radioSettings.js --bundle --format=cjs --platform=node \
    --outfile=.build/radiosettings.cjs --log-level=warning
esbuild ../src/lib/dxclusterTerminal.js --bundle --format=cjs --platform=node \
    --outfile=.build/dxterminal.cjs --log-level=warning
esbuild ../src/lib/sstv.js --bundle --format=cjs --platform=node \
    --outfile=.build/sstvaddon.cjs --log-level=warning
esbuild ../src/bridge/protocol.js --bundle --format=cjs --platform=node \
    --outfile=.build/bridgeprotocol.cjs --log-level=warning
esbuild ../src/bridge/host.js --bundle --format=cjs --platform=node \
    --outfile=.build/bridgehost.cjs --log-level=warning
esbuild ../src/bridge/client.js --bundle --format=cjs --platform=node \
    --outfile=.build/bridgeclient.cjs --log-level=warning
esbuild ../src/bridge/commands.js --bundle --format=cjs --platform=node \
    --outfile=.build/bridgecommands.cjs --log-level=warning
esbuild ../src/bridge/snapshots.js --bundle --format=cjs --platform=node \
    --outfile=.build/bridgesnapshots.cjs --log-level=warning
esbuild ../src/radio/media/metadata.js --bundle --format=cjs --platform=node \
    --outfile=.build/mediametadata.cjs --log-level=warning
esbuild ../src/radio/media/support.js --bundle --format=cjs --platform=node \
    --outfile=.build/mediasupport.cjs --log-level=warning
esbuild ../src/radio/media/lookup.js --bundle --format=cjs --platform=node \
    --outfile=.build/medialookup.cjs --log-level=warning
esbuild ../src/lib/roomFor.js --bundle --format=cjs --platform=node \
    --outfile=.build/roomfor.cjs --log-level=warning
esbuild ../src/lib/edgeHit.js --bundle --format=cjs --platform=node \
    --outfile=.build/edgehit.cjs --log-level=warning
esbuild ../src/lib/haptics.js --bundle --format=cjs --platform=node \
    --outfile=.build/haptics.cjs --log-level=warning
esbuild ../src/lib/appHeight.js --bundle --format=cjs --platform=node \
    --outfile=.build/appheight.cjs --log-level=warning
esbuild ../src/lib/barrel.js --bundle --format=cjs --platform=node \
    --outfile=.build/barrel.cjs --log-level=warning
esbuild ../src/lib/sheetGesture.js --bundle --format=cjs --platform=node \
    --outfile=.build/sheetgesture.cjs --log-level=warning
esbuild ../src/lib/visibilityPause.js --bundle --format=cjs --platform=node \
    --outfile=.build/visibilitypause.cjs --log-level=warning
esbuild ../src/lib/bandConditions.js --bundle --format=cjs --platform=node \
    --outfile=.build/bandconditions.cjs --log-level=warning
esbuild dispatch.entry.js --bundle --format=cjs --platform=node \
    --outfile=.build/dispatch.cjs --log-level=warning
esbuild layout.entry.js --bundle --format=cjs --platform=node \
    --outfile=.build/layout.cjs --log-level=warning
esbuild ../src/lib/weather.js --bundle --format=cjs --platform=node \
    --outfile=.build/weather.cjs --log-level=warning
esbuild ../src/lib/audioWaterfall.js --bundle --format=cjs --platform=node \
    --outfile=.build/audiowaterfall.cjs --log-level=warning
esbuild ../src/lib/news.js --bundle --format=cjs --platform=node \
    --outfile=.build/news.cjs --log-level=warning
esbuild ../src/lib/clocks.js --bundle --format=cjs --platform=node \
    --outfile=.build/clocks.cjs --log-level=warning
esbuild ../src/lib/topFreq.js --bundle --format=cjs --platform=node \
    --outfile=.build/topfreq.cjs --log-level=warning
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
node radiosettings.test.js
node format.test.js
node dxterminal.test.js
node sstvaddon.test.js
node games.test.js
node uicolors.test.js
node share.test.js
node spectrumstats.test.js
node audiosinks.test.js
node markernav.test.js
node markernavsettings.test.js
node medialookup.test.js
node roomfor.test.js
node edgehit.test.js
node haptics.test.js
node appheight.test.js
node barrel.test.js
node sheetgesture.test.js
node visibilitypause.test.js
node bandconditions.test.js
node dispatch.test.js
node layout.test.js
node weather.test.js
node radiosync.test.js
node audiowaterfall.test.js
node news.test.js
node clocks.test.js
node topfreq.test.js
node operatorphoto.test.js
node bookmarkgroups.test.js
node bridge.test.js
node bridgecommands.test.js
node bridgeclient.test.js
node spectrogram.test.js
node bandspectrum.test.js
node spectrumtrace.test.js
node hookorder.test.js
