// The extensions v2 knows how to render.
//
// This is the extension point, in the same spirit as panels/registry.jsx: add
// an entry and the extension appears in the Extensions panel, opens in its own
// window, and needs no other file changed.
//
// It is deliberately a *static* list rather than something built from the
// server's reply. v1 ships extensions as HTML templates plus a script that the
// server inlines and evals; v2 renders React components that are compiled into
// the bundle, so the set of extensions this build can draw is known here and
// nowhere else. What the server contributes is which of them the operator has
// turned on — `/api/extensions` reports the enabled slugs from extensions.yaml,
// and ExtensionsContext crosses the two lists.
//
//   id            the slug the server and the v1 extension both use; it is
//                 also the `extension_name` sent in an attach
//   title         window title and list entry
//   icon          element rendered beside the title
//   summary       one line, shown under the title in the list
//   requiresAudio true when it needs the receiver running (a server-side
//                 decoder does; a browser-only one such as QRSS would not)
//   needsIQ       true when the extension decodes the raw quadrature stream
//                 rather than demodulated audio. Every other extension is the
//                 opposite way round and is unusable in IQ, which is why IQ
//                 closes and disables them — see ExtensionsContext. One of
//                 these stays available in IQ, and switches the receiver into
//                 it when it starts.
//   float         initial window size
//   minimal       true when the extension has a minimal view. The window and
//                 the mobile sheet then show a toggle, and Component is called
//                 with `minimal` — the extension itself decides what survives.
//                 Exactly the panels' `minimal`, down to the prop name; see
//                 panels/registry.jsx. The choice is remembered per extension.
//   Component     the extension body

import React from '../react.js';
import Icon from '../components/icons.jsx';
import FT8Extension from './ft8/FT8Extension.jsx';
import FSKExtension from './fsk/FSKExtension.jsx';
import NavtexExtension from './navtex/NavtexExtension.jsx';
import OliviaExtension from './olivia/OliviaExtension.jsx';
import MorseExtension from './morse/MorseExtension.jsx';
import WefaxExtension from './wefax/WefaxExtension.jsx';
import QrssExtension from './qrss/QrssExtension.jsx';
import FreeDVExtension from './freedv/FreeDVExtension.jsx';
import DRMExtension from './drm/DRMExtension.jsx';
import SstvExtension from './sstv/SstvExtension.jsx';
import SoundModemExtension from './soundmodem/SoundModemExtension.jsx';
import WhisperExtension from './whisper/WhisperExtension.jsx';

export const EXTENSIONS = [
    {
        id: 'ft8',
        title: 'FT8 Decoder',
        icon: <Icon.Waves />,
        summary: 'Weak-signal FT8 decodes with distance, bearing and country.',
        requiresAudio: true,
        float: { w: 880, h: 560 },
        minimal: true,
        Component: FT8Extension,
    },
    {
        id: 'fsk',
        title: 'FSK / RTTY Decoder',
        icon: <Icon.Teleprinter />,
        summary: 'Live teleprinter copy — RTTY, weather, SITOR-B and NAVTEX.',
        requiresAudio: true,
        float: { w: 760, h: 560 },
        minimal: true,
        Component: FSKExtension,
    },
    {
        id: 'navtex',
        title: 'NAVTEX Decoder',
        icon: <Icon.Anchor />,
        summary: 'Maritime safety broadcasts, framed into numbered messages.',
        requiresAudio: true,
        float: { w: 760, h: 580 },
        minimal: true,
        Component: NavtexExtension,
    },
    {
        id: 'olivia',
        title: 'Olivia Decoder',
        icon: <Icon.Keyboard />,
        summary: 'Weak-signal MFSK keyboard-to-keyboard, readable under the noise.',
        requiresAudio: true,
        // Narrower than FSK's: the settings are three controls rather than a
        // six-field grid, and the output is one column of text.
        float: { w: 720, h: 560 },
        minimal: true,
        Component: OliviaExtension,
    },
    {
        // v1 calls the slug `morse` and the extension "CW Decoder". Both are
        // kept: the slug is what the server enables and the attach carries, and
        // CW is what anyone tuning one calls it.
        id: 'morse',
        title: 'CW Decoder',
        icon: <Icon.Morse />,
        summary: 'Morse copy, with the tone and the sending speed found for you.',
        requiresAudio: true,
        // Narrower than the teleprinter decoders: the output is one column of
        // text with no wide lines in it, and no settings grid to lay out.
        float: { w: 700, h: 520 },
        minimal: true,
        Component: MorseExtension,
    },
    {
        id: 'wefax',
        title: 'WEFAX Decoder',
        icon: <Icon.Fax />,
        summary: 'Weather charts drawn line by line from HF radiofax.',
        requiresAudio: true,
        // Wider and taller than the others: the output is a page, not a list.
        float: { w: 820, h: 640 },
        minimal: true,
        Component: WefaxExtension,
    },
    {
        id: 'qrss',
        title: 'QRSS Grabber',
        icon: <Icon.Snail />,
        // The one extension with no server side: it reads the audio this
        // browser is already playing. `requiresAudio` still holds — it needs
        // the receiver running — it just does not need an attach.
        summary: 'Very-slow-CW waterfall for reading beacons under the noise.',
        requiresAudio: true,
        float: { w: 880, h: 620 },
        minimal: true,
        Component: QrssExtension,
    },
    {
        id: 'freedv',
        title: 'FreeDV Decoder',
        icon: <Icon.Mic />,
        summary: 'Digital voice — decodes RADE and plays it over the receiver.',
        requiresAudio: true,
        float: { w: 820, h: 520 },
        minimal: true,
        Component: FreeDVExtension,
    },
    {
        id: 'drm',
        title: 'DRM Decoder',
        icon: <Icon.Radio />,
        summary: 'Digital Radio Mondiale — shortwave broadcast audio, with the station name.',
        requiresAudio: true,
        // The one extension that wants IQ. A DRM channel is 10 kHz of OFDM and
        // no demodulated mode preserves it, so this must stay usable in a mode
        // that closes every other extension.
        needsIQ: true,
        // Shorter than FreeDV's: there is no activity list to hold, just the
        // station identity, a text message line and two rows of meters.
        float: { w: 760, h: 420 },
        minimal: true,
        Component: DRMExtension,
    },
    {
        id: 'sstv',
        title: 'SSTV Decoder',
        icon: <Icon.Picture />,
        summary: 'Slow-scan television pictures, mode detected from the VIS code.',
        requiresAudio: true,
        float: { w: 780, h: 640 },
        minimal: true,
        Component: SstvExtension,
    },
    {
        id: 'soundmodem',
        title: 'Sound Modem',
        icon: <Icon.Packet />,
        summary: 'AX.25 packet — up to four modem channels, decoded frame by frame.',
        requiresAudio: true,
        // The widest of them: a frame is a path, a type and a payload on one
        // line, and wrapping that reads far worse than scrolling for it.
        float: { w: 940, h: 620 },
        minimal: true,
        Component: SoundModemExtension,
    },
    {
        // The slug is `whisper` — the directory name the server enables in
        // extensions.yaml and the name the attach carries — but nothing in the
        // UI says so: v1's manifest called it Speech-to-Text, which is what it
        // does, and "Whisper" names the model rather than the feature.
        id: 'whisper',
        title: 'Speech-to-Text',
        icon: <Icon.Captions />,
        summary: 'Live transcription of speech, read aloud and summarised on request.',
        requiresAudio: true,
        // Text, but wide: a transcript line is a sentence, and wrapping every
        // one of them across a narrow window is much harder to read than a page.
        float: { w: 860, h: 600 },
        minimal: true,
        Component: WhisperExtension,
    },
];

export const EXTENSION_BY_ID = Object.fromEntries(EXTENSIONS.map((e) => [e.id, e]));

