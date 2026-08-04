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
import WefaxExtension from './wefax/WefaxExtension.jsx';
import QrssExtension from './qrss/QrssExtension.jsx';
import FreeDVExtension from './freedv/FreeDVExtension.jsx';

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
];

export const EXTENSION_BY_ID = Object.fromEntries(EXTENSIONS.map((e) => [e.id, e]));

