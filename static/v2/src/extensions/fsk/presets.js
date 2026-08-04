// FSK/RTTY: the named parameter sets, and where to point the receiver.
//
// The decoder itself is in ../teleprinter.js, shared with NAVTEX. What is here
// is the part that is about amateur and utility radioteletype specifically:
// which combinations of shift, rate, framing and encoding are worth a name, and
// which frequencies are worth a menu entry.

// The combinations that are worth a name, as v1 listed them. Each is a complete
// set of the six parameters, so choosing one never leaves a setting behind from
// the last.
export const PRESETS = [
    {
        id: 'ham',
        label: 'Ham RTTY — 170 Hz, 45.45 baud',
        config: {
            center_frequency: 1000, shift: 170, baud_rate: 45.45,
            framing: '5N1.5', encoding: 'ITA2', inverted: false,
        },
    },
    {
        id: 'weather',
        label: 'Weather RTTY — 450 Hz, 50 baud',
        config: {
            center_frequency: 1000, shift: 450, baud_rate: 50,
            framing: '5N1.5', encoding: 'ITA2', inverted: true,
        },
    },
    {
        id: 'navtex',
        label: 'NAVTEX — 170 Hz, 100 baud',
        config: {
            center_frequency: 500, shift: 170, baud_rate: 100,
            framing: '4/7', encoding: 'CCIR476', inverted: false,
        },
    },
    {
        id: 'sitor-b',
        label: 'SITOR-B — 170 Hz, 100 baud',
        config: {
            center_frequency: 1000, shift: 170, baud_rate: 100,
            framing: '4/7', encoding: 'CCIR476', inverted: false,
        },
    },
];

// Amateur RTTY is what this is opened for; v1 defaulted to NAVTEX because the
// backend decoder was written for it first.
export const DEFAULT_PRESET = 'ham';

export const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

export function presetConfig(id) {
    const p = PRESET_BY_ID[id] || PRESET_BY_ID[DEFAULT_PRESET];
    return { ...p.config };
}

/**
 * Which preset these settings are, or 'custom'.
 *
 * Derived rather than remembered, so editing a field moves the menu to Custom
 * and setting the fields back by hand moves it back — there is no second copy
 * of the state to disagree with the controls.
 */
export function presetOf(config) {
    const hit = PRESETS.find((p) => Object.keys(p.config)
        .every((k) => p.config[k] === config[k]));
    return hit ? hit.id : 'custom';
}

// Frequencies worth a menu entry. These are the frequencies of the *signal*, so
// tuning one sets the dial low enough to put it at the configured audio centre,
// and matching one back means adding that centre to the dial again.
export const FSK_FREQUENCIES = [
    {
        group: 'Amateur RTTY',
        options: [
            { hz: 3590000, label: '3.590 MHz (80m)' },
            { hz: 7040000, label: '7.040 MHz (40m)' },
            { hz: 10140000, label: '10.140 MHz (30m)' },
            { hz: 14080000, label: '14.080 MHz (20m)' },
            { hz: 18100000, label: '18.100 MHz (17m)' },
            { hz: 21080000, label: '21.080 MHz (15m)' },
            { hz: 24920000, label: '24.920 MHz (12m)' },
            { hz: 28080000, label: '28.080 MHz (10m)' },
        ],
    },
    {
        // 50 baud, 450 Hz shift — the Weather RTTY preset.
        group: 'Weather RTTY — DWD Pinneberg',
        options: [
            { hz: 147300, label: '147.3 kHz' },
            { hz: 4583000, label: '4.583 MHz' },
            { hz: 7646000, label: '7.646 MHz' },
            { hz: 10100800, label: '10.1008 MHz' },
        ],
    },
];
