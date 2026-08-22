// How the panels are grouped on a phone.
//
// A dock is a column you scroll and read; a phone's tab bar is a row of thumb
// targets, and fifty of them is not a row, it is a corridor. The panel you
// wanted was three swipes along it, and the swipe itself was the problem: a
// horizontal scroller under a sheet is one gesture away from the sheet's own,
// and you could not see what you were scrolling towards.
//
// So the row holds seven things instead of fifty, and six of them are groups
// that open a list. Two taps to a panel instead of a scroll and a tap — and the
// first tap is aimed at a fixed target that does not move, which is the part a
// scroller could never offer.
//
// ── The grouping ────────────────────────────────────────────────────────────
//
// By the question being asked, not by what the panel is made of. "Where am I
// pointed", "what is out there", "what is it saying", "how does it sound" are
// the four an operator actually alternates between; the last two are the things
// around the radio and the things you set once and forget.
//
// Multipad is not in a group. It is the panel a phone opens on and the one most
// sessions never leave — a group in front of it would put a tap between the
// operator and the dial, which is the one place that cannot afford one. Far
// left, where a thumb lands without aiming.
//
// The ids are the registry's. Anything the registry has that is not named here
// is a bug rather than a default — see UNGROUPED below, which is what says so.

import React from '../react.js';
import Icon from '../components/icons.jsx';

// The panel that stands alone, and where.
export const SOLO = 'multipad';

export const GROUPS = [
    {
        id: 'tune',
        title: 'Tune',
        icon: <Icon.Knob />,
        // Where the receiver is pointed, in frequency and in space. The rotator
        // and the antenna switch are here rather than with the rig control for
        // that reason: aiming at a signal is the same job as tuning to it, and
        // the operator reaching for one has usually just reached for the other.
        // The IF spectrum is next to the Receiver panel here as it is in the
        // dock: it is the picture of where the dial is sitting inside a signal,
        // which is the same question the dial itself answers and not the "what
        // is out there" that Activity's pictures answer.
        panels: [
            'receiver', 'ifspectrum', 'markernav', 'quickbands', 'bands',
            'bookmarks', 'localbookmarks', 'topfreq',
            'doppler', 'rotator', 'antenna',
        ],
    },
    {
        id: 'activity',
        title: 'Activity',
        icon: <Icon.Target />,
        // What is out there, and how well it is getting here. Space weather
        // belongs with the spots rather than with the weather: it answers "why
        // can I hear this", which is the same question the rest of the group is
        // asking.
        // Band measurements are here rather than under Tune with the band keys:
        // the keys are a way of getting somewhere, and this is a reading of what
        // is there — the same question the spots and the space weather are
        // asking, which is "where should I be listening".
        panels: [
            'spots', 'dxcluster', 'voice', 'callsign',
            'bandspectrum', 'spectrogram', 'bandstats', 'spaceweather', 'lightning',
        ],
    },
    {
        id: 'decode',
        title: 'Decode',
        icon: <Icon.Teleprinter />,
        // Everything that turns a signal into content. The Extensions launcher
        // leads it because most of what is in here is reached through it.
        panels: [
            'extensions', 'sstv', 'navtex', 'wefax',
            'packet', 'hfdl', 'voiceskimmer', 'addons',
        ],
    },
    {
        id: 'audio',
        title: 'Audio',
        icon: <Icon.Volume />,
        // The sound and what shapes it. Signal is here rather than under Tune
        // because it carries the squelch, which is an audio gate — see
        // SignalPanel.
        panels: [
            'audio', 'noise', 'filters', 'signal', 'scope',
            'recorder', 'mediasession', 'announcements',
        ],
    },
    {
        id: 'shack',
        title: 'Shack',
        icon: <Icon.Users />,
        // The things around the radio rather than the radio. Chat leads it: it
        // is the one panel in here somebody is waiting on an answer from, and
        // the only one that badges.
        panels: [
            'chat', 'listeners', 'status', 'news',
            'weather', 'clocks', 'ranking', 'games',
        ],
    },
    {
        id: 'setup',
        title: 'Setup',
        icon: <Icon.Sliders />,
        // Set once and left. Radio control and SDR control are wiring — a rig on
        // a serial port, a MIDI surface — done on the day and never during a
        // session, which is what puts them here rather than with the operating
        // panels.
        panels: [
            'display', 'layout', 'notifications', 'backup',
            'shortcuts', 'log', 'radiocontrol', 'sdrcontrol',
        ],
    },
];

// Every id the groups name, the solo panel included.
const NAMED = new Set([SOLO, ...GROUPS.flatMap((g) => g.panels)]);

// The group ids a panel may claim for itself.
//
// A custom panel is not in any list above — it is not in this build at all — so
// it says where it belongs in its manifest and carries the answer on its
// registry entry. `SOLO` is not a group and cannot be claimed: the panel a phone
// opens on is this interface's decision, not a manifest's.
const GROUP_IDS = new Set(GROUPS.map((g) => g.id));

/** Panels that named this group themselves. */
function claiming(panels, id) {
    return panels.filter((p) => p.group === id);
}

/**
 * Registry panels that no group claims.
 *
 * A panel added to the registry and not to a group would simply vanish from
 * every phone, silently — the kind of omission that is found months later by
 * somebody who used to use it. So they are collected rather than dropped, and
 * the shell puts them at the end of the last group. See MobileShell.
 *
 * That is now a working fallback rather than the sign of a mistake it used to
 * be: a custom panel whose manifest names no group, or names one this build does
 * not have, lands here and stays reachable. A *built-in* panel missing from the
 * lists above is still a bug.
 */
export function ungrouped(panels) {
    return panels.filter((p) => !NAMED.has(p.id) && !(p.group && GROUP_IDS.has(p.group)));
}

/**
 * The groups as this receiver can actually show them: registry order within a
 * group, nothing that does not apply to this server or has been hidden, and no
 * group left empty.
 *
 * @param panels  the panels already filtered to what may be shown.
 */
export function groupsFor(panels) {
    const by = new Map(panels.map((p) => [p.id, p]));
    const spare = ungrouped(panels);
    return GROUPS.map((g, i) => {
        // The group's own list first, in the order it declares, then anything
        // that asked to be here — which is a custom panel, and belongs after the
        // panels this build ships rather than among them.
        const mine = g.panels.map((id) => by.get(id)).filter(Boolean).concat(claiming(panels, g.id));
        // Anything unclaimed rides with the last group rather than being lost.
        const all = i === GROUPS.length - 1 ? mine.concat(spare) : mine;
        return { ...g, items: all };
    }).filter((g) => g.items.length > 0);
}
