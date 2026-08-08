// Inline SVG icon set — no icon font, no network request, themable via
// `currentColor`. Each icon is a 24×24 path drawn at 1.7px stroke weight.

import React from '../react.js';

function Svg({ children, size = 16, ...rest }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...rest}
        >
            {children}
        </svg>
    );
}

export const Icon = {
    Power: (p) => <Svg {...p}><path d="M12 3v9" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></Svg>,
    Chevron: (p) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>,
    ChevronUp: (p) => <Svg {...p}><path d="m6 15 6-6 6 6" /></Svg>,
    ChevronLeft: (p) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>,
    ChevronRight: (p) => <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>,
    Volume: (p) => <Svg {...p}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></Svg>,
    Mute: (p) => <Svg {...p}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="m17 9 4 6" /><path d="m21 9-4 6" /></Svg>,
    Radio: (p) => <Svg {...p}><circle cx="12" cy="12" r="2" /><path d="M7.8 16.2a6 6 0 0 1 0-8.4" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4" /><path d="M4.9 19.1a10 10 0 0 1 0-14.2" /><path d="M19.1 4.9a10 10 0 0 1 0 14.2" /></Svg>,
    Waves: (p) => <Svg {...p}><path d="M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0" /><path d="M2 18c2-3 4-3 6 0s4 3 6 0 4-3 6 0" /></Svg>,
    Sliders: (p) => <Svg {...p}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></Svg>,
    Gauge: (p) => <Svg {...p}><path d="M12 14 16 9" /><path d="M20.5 17a9 9 0 1 0-17 0" /><circle cx="12" cy="17" r="1.4" /></Svg>,
    Grid: (p) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Svg>,
    List: (p) => <Svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></Svg>,
    Layers: (p) => <Svg {...p}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 14 9 5 9-5" /></Svg>,
    Drag: (p) => <Svg {...p}><circle cx="9" cy="6" r="1.2" /><circle cx="15" cy="6" r="1.2" /><circle cx="9" cy="12" r="1.2" /><circle cx="15" cy="12" r="1.2" /><circle cx="9" cy="18" r="1.2" /><circle cx="15" cy="18" r="1.2" /></Svg>,
    Close: (p) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>,
    Reset: (p) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Svg>,
    // A quarter turn each way. Mirrored pairs, and RotateLeft is the same arc as Reset by
    // geometry rather than by intent — each is named for its job, so a button reads as what
    // it does rather than as whichever icon happened to look right.
    RotateLeft: (p) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Svg>,
    RotateRight: (p) => <Svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></Svg>,
    Target: (p) => <Svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>,
    Pointer: (p) => <Svg {...p}><path d="M5 3.5 18 11l-5.6 1.5L9.6 17.5z" /></Svg>,
    ZoomIn: (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M11 8v6M8 11h6" /></Svg>,
    ZoomOut: (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /></Svg>,
    Sun: (p) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>,
    Moon: (p) => <Svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></Svg>,
    Clock: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></Svg>,
    // A folded newspaper: a page with a masthead rule and two columns.
    News: (p) => <Svg {...p}><path d="M4 5h13a1 1 0 0 1 1 1v12a1 1 0 0 0 1 1 1 1 0 0 0 1-1V9h-3M4 5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h15M7 9h7M7 13h7M7 16h4" /></Svg>,
    // Terrestrial weather, as opposed to Sun, which is space weather's.
    Cloud: (p) => <Svg {...p}><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 11.2 3.9 3.9 0 0 0 6.5 19z" /></Svg>,
    // Three streamers, the long one trailing into a curl.
    Wind: (p) => <Svg {...p}><path d="M3 8h9.5a2.5 2.5 0 1 0-2.5-2.5M3 16h13a2.5 2.5 0 1 1-2.5 2.5M3 12h7" /></Svg>,
    Info: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>,
    External: (p) => <Svg {...p}><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>,
    // A die showing five: the one thing that reads as "a game" without being a
    // console pad, which on a receiver's panel would be claiming rather a lot.
    Dice: (p) => <Svg {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="3.5" /><circle cx="8.5" cy="8.5" r="1.15" fill="currentColor" stroke="none" /><circle cx="15.5" cy="8.5" r="1.15" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" /><circle cx="8.5" cy="15.5" r="1.15" fill="currentColor" stroke="none" /><circle cx="15.5" cy="15.5" r="1.15" fill="currentColor" stroke="none" /></Svg>,
    Puzzle: (p) => <Svg {...p}><path d="M10 3h4v2.2a1.8 1.8 0 1 0 3.6 0V3H21v3.4h-2.2a1.8 1.8 0 1 0 0 3.6H21V21h-3.4v-2.2a1.8 1.8 0 1 0-3.6 0V21H3v-4h2.2a1.8 1.8 0 1 0 0-3.6H3V3z" /></Svg>,
    Plug: (p) => <Svg {...p}><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" /><path d="M12 17v5" /></Svg>,
    Chat: (p) => <Svg {...p}><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 1 1 21 12z" /><path d="M8.5 11h7M8.5 14h4" /></Svg>,
    // A podium: three columns, the tallest in the middle. The Ranking panel's,
    // and it has to read at 13 px in a dock header — so it is the shape of a
    // leaderboard rather than a trophy, which at that size is a blob.
    Podium: (p) => <Svg {...p}><path d="M9 10h6v11H9z" /><path d="M3 14h6v7H3z" /><path d="M15 13h6v8h-6z" /><path d="M12 3l1.2 2.5 2.8.4-2 2 .5 2.8L12 9.4 9.5 10.7l.5-2.8-2-2 2.8-.4z" /></Svg>,
    // ── How the waterfall's history is drawn ──────────────────────────────
    //
    // Three glyphs rather than one highlighted button, for the same reason the
    // ViewSplit/ViewSpectrum/ViewWaterfall trio below exists: these are states
    // in a cycle, not an on/off, and one glyph could only say "waterfall" while
    // leaving which kind to the tooltip. Rows for the heat map, a receding
    // trapezoid for the surface, and the trapezoid over the rows for both —
    // which is also exactly how the pane is laid out in that mode.
    Wf2D: (p) => <Svg {...p}><path d="M4 6.5h16M4 10h16M4 13.5h16M4 17h16" /></Svg>,
    Wf3D: (p) => <Svg {...p}><path d="M8.5 5.5h7l4.5 13H4z" /><path d="M7 13.5h10M6 16h12" /></Svg>,
    WfBoth: (p) => <Svg {...p}><path d="M9.5 3.5h5l3.5 8H6z" /><path d="M4 14.5h16M4 17.5h16M4 20.5h16" /></Svg>,

    Users: (p) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16.5 5.5a3.2 3.2 0 0 1 0 6" /><path d="M18 14.6A6 6 0 0 1 21 20" /></Svg>,
    Bookmark: (p) => <Svg {...p}><path d="M6 4h12v17l-6-4-6 4z" /></Svg>,
    Eye: (p) => <Svg {...p}><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></Svg>,
    // The same eye with a line through it: a group kept but not in play.
    EyeOff: (p) => <Svg {...p}><path d="M2 12s3.5-6.5 10-6.5c1.6 0 3 .4 4.2 1" /><path d="M20.4 8.9A17 17 0 0 1 22 12s-3.5 6.5-10 6.5c-2.2 0-4-.6-5.4-1.4" /><path d="M3 3l18 18" /></Svg>,
    Plus: (p) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
    Minus: (p) => <Svg {...p}><path d="M5 12h14" /></Svg>,
    // Arrows into the corners / out of them: the minimal-view toggle.
    Collapse: (p) => <Svg {...p}><path d="M9 4v5H4" /><path d="M15 20v-5h5" /><path d="m3 21 6-6" /><path d="m21 3-6 6" /></Svg>,
    Expand: (p) => <Svg {...p}><path d="M4 9V4h5" /><path d="M20 15v5h-5" /><path d="m4 4 6 6" /><path d="m20 20-6-6" /></Svg>,
    Compass: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></Svg>,
    Antenna: (p) => <Svg {...p}><path d="M12 4v16" /><path d="m5 20 7-9 7 9" /><path d="M8.4 6.4a5 5 0 0 1 7.2 0" /><path d="M6 3.6a9 9 0 0 1 12 0" /></Svg>,
    // Filled, unlike its neighbours: a record button is a solid dot everywhere
    // else, and an outline reads as "off".
    Record: (p) => <Svg {...p}><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" /></Svg>,
    Stop: (p) => <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></Svg>,
    // Filled, like Record and Stop: these are transport glyphs and read as a
    // state rather than as an outline of one. Play is the *action* on the paused
    // spectrum's Resume button; Pause says what the display is doing.
    Play: (p) => <Svg {...p}><path d="M8.5 6.2 18 12l-9.5 5.8z" fill="currentColor" stroke="none" /></Svg>,
    Pause: (p) => <Svg {...p}><rect x="7.5" y="6.5" width="3.2" height="11" rx="1" fill="currentColor" stroke="none" /><rect x="13.3" y="6.5" width="3.2" height="11" rx="1" fill="currentColor" stroke="none" /></Svg>,
    Download: (p) => <Svg {...p}><path d="M12 3v11" /><path d="m7.5 10 4.5 4 4.5-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Svg>,
    Search: (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></Svg>,
    Mic: (p) => <Svg {...p}><rect x="9" y="3" width="6" height="10" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></Svg>,
    // A handset showing a play button: the lock-screen media card.
    LockScreen: (p) => <Svg {...p}><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="m10.6 9.3 4.4 2.7-4.4 2.7z" /></Svg>,
    Trash: (p) => <Svg {...p}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M10 11v6M14 11v6" /></Svg>,
    Upload: (p) => <Svg {...p}><path d="M12 14V3" /><path d="m7.5 7 4.5-4 4.5 4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Svg>,
    Copy: (p) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></Svg>,
    // Three nodes and the lines between them — the share glyph everywhere else,
    // so nobody has to be told what the button is.
    Share: (p) => <Svg {...p}><circle cx="18" cy="5" r="2.6" /><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="19" r="2.6" /><path d="m8.3 10.8 7.4-4.3" /><path d="m8.3 13.2 7.4 4.3" /></Svg>,
    Tick: (p) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7" /></Svg>,
    // A lidded box: settings put away somewhere they survive the browser.
    Archive: (p) => <Svg {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></Svg>,
    // Packets in flight: a burst of data between two stations.
    Packet: (p) => <Svg {...p}><rect x="2.5" y="9" width="6" height="6" rx="1" /><rect x="15.5" y="9" width="6" height="6" rx="1" /><path d="M9 12h2M13 12h2" /><path d="M5.5 6.5V4M18.5 6.5V4" /></Svg>,
    // A picture in a frame: what SSTV produces.
    Picture: (p) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="1.5" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="m4 17 4.5-4.5 3 3L15 11l5 5" /></Svg>,
    // A bell: notifications. Deliberately not the speaker Announce uses — that one
    // means "the receiver will say this out loud", and these are read.
    Bell: (p) => <Svg {...p}><path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10" /><path d="M10 18.5a2 2 0 0 0 4 0" /></Svg>,
    // A bolt: the lightning addon. Drawn as an outline rather than the solid glyph,
    // so it sits in a row of stroked icons rather than reading as a filled badge.
    Bolt: (p) => <Svg {...p}><path d="M13 2.5 4.5 13.5H10l-1 8 9.5-11.5H13z" /></Svg>,
    // A snail: QRSS is the slow one, and v1's extension used the same emoji.
    Snail: (p) => <Svg {...p}><circle cx="13" cy="13" r="5.5" /><path d="M13 13a2 2 0 0 1 2.6 3" /><path d="M7.5 18.5h9" /><path d="M7.5 18.5a3 3 0 0 1-1-5" /><path d="M5.5 12V8M8.5 12V9" /></Svg>,
    // A fax page: a sheet with a chart drawn on it.
    Fax: (p) => <Svg {...p}><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M7 8h10" /><path d="M7 16c2-4 3.5 2 5-1s2.5-2 5 1" /></Svg>,
    // An anchor: maritime traffic, which is what NAVTEX carries.
    // Two links of a chain, for following another listener's dial — v1 uses 🔗 for it.
    Link: (p) => <Svg {...p}><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></Svg>,
    Anchor: (p) => <Svg {...p}><circle cx="12" cy="5" r="2.2" /><path d="M12 7.2V21" /><path d="M8 11h8" /><path d="M4 15a8 8 0 0 0 16 0" /><path d="M4 15h2.5M20 15h-2.5" /></Svg>,
    // Captions: a screen with lines of subtitle across it — speech turned into
    // text. Not the microphone, which FreeDV has: that one means "voice", and
    // this extension's output is the words.
    Captions: (p) => <Svg {...p}><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M6 11h5M14 11h4M6 15h3M12 15h6" /></Svg>,
    // A teleprinter: paper coming out of a machine with lines of text on it.
    Teleprinter: (p) => <Svg {...p}><path d="M7 8V3h10v5" /><rect x="3" y="8" width="18" height="7" rx="1.5" /><path d="M7 15h10v6H7z" /><path d="M9.5 18h5" /></Svg>,
    // Morse: dot dash dot, the shape of the thing being decoded.
    Morse: (p) => <Svg {...p}><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><rect x="9" y="10.6" width="6" height="2.8" rx="1.4" fill="currentColor" stroke="none" /><circle cx="19.5" cy="12" r="1.4" fill="currentColor" stroke="none" /></Svg>,
    // A control-surface knob: a dial with an index mark and detent ticks.
    Knob: (p) => <Svg {...p}><circle cx="12" cy="12" r="6.5" /><path d="M12 5.5v3" /><path d="M12 2.6v1.2M19.6 7.5l-1 .6M19.6 16.5l-1-.6M12 21.4v-1.2M4.4 16.5l1-.6M4.4 7.5l1 .6" /></Svg>,
    // A mouse seen from above, for what its wheel does over the spectrum. Its
    // own glyph rather than a magnifier or a dial, both of which are already in
    // that toolbar meaning something else.
    Wheel: (p) => <Svg {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="5.5" /><path d="M12 6.5v3.5" /></Svg>,
    // Speech, for the announcements panel: a speaker with sound leaving it.
    // Distinct from Volume, which is the audio output level and already spoken
    // for by the Audio panel.
    // A keyboard: the outline, three key rows and a space bar.
    Keyboard: (p) => <Svg {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01" /><path d="M6 12.5h.01M9.5 12.5h.01M13 12.5h.01M16.5 12.5h.01" /><path d="M8 15.5h8" /></Svg>,
    Announce: (p) => <Svg {...p}><path d="M4 9v6h3.5L13 19V5L7.5 9z" /><path d="M16.5 9.5a4 4 0 0 1 0 5" /><path d="M19.5 6.5a8 8 0 0 1 0 11" /></Svg>,
    // A control pad: a panel carrying a wheel and two faders. Deliberately not
    // Knob or Sliders — the Multipad's whole claim is that it is all of them at
    // once, and it sits in the mobile tab bar next to panels using both.
    Pad: (p) => <Svg {...p}><rect x="2.5" y="3.5" width="19" height="17" rx="2.5" /><circle cx="7.5" cy="8.5" r="2.2" /><path d="M12 8.5h6M6 13.5h12M6 17h8" /></Svg>,
    // The three spectrum views, as one family: a trace is drawn as columns of
    // different heights, a waterfall as rows of broken texture, and the split is
    // literally the two of them stacked in the halves they occupy on screen.
    // Frameless on purpose — these are read at 13 px in the Multipad, where a
    // panel outline round each would close up into a smudge and the columns and
    // rows are what tells them apart anyway.
    ViewSpectrum: (p) => <Svg {...p}><path d="M3 20v-6M7.5 20V8M12 20V4M16.5 20v-9M21 20v-4" /></Svg>,
    ViewWaterfall: (p) => <Svg {...p}><path d="M3 6h4M9 6h6M17 6h4M3 12h6M11 12h3M16 12h5M3 18h3M8 18h7M17 18h4" /></Svg>,
    ViewSplit: (p) => <Svg {...p}><path d="M4 11V7.5M8 11V4M12 11V8M16 11V5.5M20 11V9" /><path d="M3 15.5h5M10 15.5h5M17 15.5h4M3 20h7M12 20h3M17 20h4" /></Svg>,
};

export default Icon;
