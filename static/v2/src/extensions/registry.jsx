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
//   Component     the extension body

import React from '../react.js';
import Icon from '../components/icons.jsx';
import FT8Extension from './ft8/FT8Extension.jsx';

export const EXTENSIONS = [
    {
        id: 'ft8',
        title: 'FT8 Decoder',
        icon: <Icon.Waves />,
        summary: 'Weak-signal FT8 decodes with distance, bearing and country.',
        requiresAudio: true,
        float: { w: 880, h: 560 },
        Component: FT8Extension,
    },
];

export const EXTENSION_BY_ID = Object.fromEntries(EXTENSIONS.map((e) => [e.id, e]));

// v1 extensions that v2 ships as ordinary panels instead, and where they went.
//
// The operator enabled these in extensions.yaml, so they come back from
// `/api/extensions` and would otherwise be reported as missing from v2 — which
// is the opposite of true. They are not extensions here because none of them is
// a decoder you open and close: two are permanent readouts and three are
// hardware control surfaces that belong beside the other controls.
export const PORTED_AS_PANELS = {
    'dx-cluster': 'Spots',
    'digital-spots': 'Spots',
    'cw-spots': 'Spots',
    flexcontrol: 'Radio control',
    'midi-control': 'Radio control',
    'radio-sync': 'Radio control',
    stats: 'Receiver info',
};
