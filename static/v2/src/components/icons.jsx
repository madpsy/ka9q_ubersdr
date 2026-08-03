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
    Target: (p) => <Svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>,
    ZoomIn: (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M11 8v6M8 11h6" /></Svg>,
    ZoomOut: (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /></Svg>,
    Sun: (p) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>,
    Moon: (p) => <Svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></Svg>,
    Info: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>,
    External: (p) => <Svg {...p}><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>,
    Puzzle: (p) => <Svg {...p}><path d="M10 3h4v2.2a1.8 1.8 0 1 0 3.6 0V3H21v3.4h-2.2a1.8 1.8 0 1 0 0 3.6H21V21h-3.4v-2.2a1.8 1.8 0 1 0-3.6 0V21H3v-4h2.2a1.8 1.8 0 1 0 0-3.6H3V3z" /></Svg>,
    Chat: (p) => <Svg {...p}><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 1 1 21 12z" /><path d="M8.5 11h7M8.5 14h4" /></Svg>,
    Bookmark: (p) => <Svg {...p}><path d="M6 4h12v17l-6-4-6 4z" /></Svg>,
    Eye: (p) => <Svg {...p}><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></Svg>,
    Plus: (p) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
    Minus: (p) => <Svg {...p}><path d="M5 12h14" /></Svg>,
    Compass: (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></Svg>,
    Antenna: (p) => <Svg {...p}><path d="M12 4v16" /><path d="m5 20 7-9 7 9" /><path d="M8.4 6.4a5 5 0 0 1 7.2 0" /><path d="M6 3.6a9 9 0 0 1 12 0" /></Svg>,
    // Filled, unlike its neighbours: a record button is a solid dot everywhere
    // else, and an outline reads as "off".
    Record: (p) => <Svg {...p}><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" /></Svg>,
    Stop: (p) => <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></Svg>,
    Download: (p) => <Svg {...p}><path d="M12 3v11" /><path d="m7.5 10 4.5 4 4.5-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Svg>,
    Search: (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></Svg>,
    Mic: (p) => <Svg {...p}><rect x="9" y="3" width="6" height="10" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></Svg>,
    Trash: (p) => <Svg {...p}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M10 11v6M14 11v6" /></Svg>,
};

export default Icon;
