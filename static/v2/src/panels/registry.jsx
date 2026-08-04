// The panel registry.
//
// This is the extension point: add an entry and the panel appears in its dock,
// in the layout manager, and in the mobile sheets — no other file changes. The
// stored layout reconciles against this list on load, so shipping a new panel
// does not disturb a user's arrangement.
//
//   id           stable key; also the localStorage key for open/hidden state
//   title        header text
//   icon         element rendered in the header and the mobile tab bar
//   dock         'left' | 'right' | 'bottom' — where it lands by default
//   defaultOpen  false to ship collapsed
//   defaultHidden true to ship hidden (still listed in the layout manager)
//   fill         true if the body should stretch to the dock height
//   Badge        optional component rendered in the header, for unread counts
//   minimal      true when the panel has a minimal view. The header then shows
//                a toggle, and Component is called with `minimal` — the panel
//                itself decides what survives. That is all it takes to give any
//                panel one: set the flag, then honour the prop.
//                    export default function FooPanel({ minimal }) { … }
//                The choice is remembered per panel and applies wherever the
//                panel is drawn, docked or floating.
//   requires     optional (serverInfo, env) => bool; false hides the panel
//                entirely — see usePanelApplies() at the foot of this file
//   Component    the panel body

import React, { useCallback } from '../react.js';
import Icon from '../components/icons.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { useExtensions } from '../extensions/ExtensionsContext.jsx';

import ReceiverPanel from './ReceiverPanel.jsx';
import BandsPanel from './BandsPanel.jsx';
import BookmarksPanel from './BookmarksPanel.jsx';
import LocalBookmarksPanel from './LocalBookmarksPanel.jsx';
import AudioPanel from './AudioPanel.jsx';
import AudioFiltersPanel from './AudioFiltersPanel.jsx';
import SignalPanel from './SignalPanel.jsx';
import DisplayPanel from './DisplayPanel.jsx';
import StatusPanel from './StatusPanel.jsx';
import LayoutPanel from './LayoutPanel.jsx';
import ScopePanel from './ScopePanel.jsx';
import LogPanel from './LogPanel.jsx';
import QuickBandsPanel from './QuickBandsPanel.jsx';
import ChatPanel, { ChatBadge } from './ChatPanel.jsx';
import AddonsPanel, { addonList } from './AddonsPanel.jsx';
import RotatorPanel from './RotatorPanel.jsx';
import AntennaPanel from './AntennaPanel.jsx';
import RecorderPanel from './RecorderPanel.jsx';
import VoiceActivityPanel from './VoiceActivityPanel.jsx';
import CallsignPanel from './CallsignPanel.jsx';
import RadioControlPanel from './RadioControlPanel.jsx';
import SpotsPanel, { spotTabs } from './SpotsPanel.jsx';
import ExtensionsPanel from './ExtensionsPanel.jsx';

export const PANELS = [
    // Minimal: the dial and the mode buttons — what you tune with. The filter,
    // the passband readout and AGC are settings you reach for occasionally.
    { id: 'receiver', title: 'Receiver', icon: <Icon.Radio />, dock: 'left', minimal: true, Component: ReceiverPanel },
    // DX, digital and CW spots. One tab per feed the instance actually has, and
    // the panel is absent entirely when it has none — no empty slot explaining
    // that this receiver publishes no spots.
    {
        id: 'spots',
        title: 'Spots',
        icon: <Icon.Target />,
        dock: 'left',
        // As with the callsign panel: `fill` only bites in the bottom dock, so
        // it stays declared for anyone who drags it there. The table is wide,
        // and a side dock is not, so this is a panel people will often float.
        fill: true,
        // Minimal: the spots, without the filter row. Once the filters are set
        // they are set, and in a side dock they cost more height than the list.
        minimal: true,
        Component: SpotsPanel,
        requires: (serverInfo) => spotTabs(serverInfo).length > 0,
    },
    {
        id: 'callsign',
        title: 'Callsign lookup',
        icon: <Icon.Search />,
        dock: 'left',
        // `fill` only takes effect in the bottom dock, so it stays declared: it
        // says what this panel should do if someone moves it there. In a side
        // dock the result pane's own max-height caps it instead.
        fill: true,
        // Minimal: the result on its own. Most lookups start from a click on a
        // spot or an activity row, not from typing, so the box is optional.
        minimal: true,
        Component: CallsignPanel,
        // The lookup provider is configured per instance; without it every
        // request would 503, so the panel is absent rather than broken.
        requires: (serverInfo) => !!(serverInfo && serverInfo.lookup_service),
    },
    {
        id: 'addons',
        title: 'Addons',
        icon: <Icon.Puzzle />,
        dock: 'left',
        Component: AddonsPanel,
        // Nothing to show on a receiver with no addons, so the panel does not
        // appear at all rather than occupying a slot to say so.
        requires: (serverInfo) => addonList(serverInfo).length > 0,
    },
    // Rotator and antenna switch are independent options — an instance may run
    // either, both or neither, so each panel gates on its own flag and is
    // absent entirely (not just empty) when the operator has not enabled it.
    {
        id: 'rotator',
        title: 'Rotator',
        icon: <Icon.Compass />,
        dock: 'left',
        defaultOpen: false,
        Component: RotatorPanel,
        requires: (serverInfo) => !!(serverInfo && serverInfo.rotator && serverInfo.rotator.enabled),
    },
    {
        id: 'antenna',
        title: 'Antenna switch',
        icon: <Icon.Antenna />,
        dock: 'left',
        defaultOpen: false,
        Component: AntennaPanel,
        requires: (serverInfo) => !!(serverInfo && serverInfo.ant_switch && serverInfo.ant_switch.enabled),
    },

    // Minimal: status, clock and buttons. The format is chosen once.
    {
        id: 'recorder',
        title: 'Recorder',
        icon: <Icon.Record />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: RecorderPanel,
    },

    // Hardware control surfaces and CAT sync. Collapsed by default: it does
    // nothing until someone attaches a device, and its Hamlib download only
    // starts when Radio Sync is chosen inside it.
    {
        id: 'radiocontrol',
        title: 'Radio control',
        icon: <Icon.Knob />,
        dock: 'left',
        defaultOpen: false,
        // Minimal: the rig's frequency, mode and TX state, and only under Radio
        // Sync — the mapped surfaces have no readout to keep.
        minimal: true,
        Component: RadioControlPanel,
    },

    { id: 'bookmarks', title: 'Bookmarks', icon: <Icon.Bookmark />, dock: 'left', defaultOpen: false, Component: BookmarksPanel },
    { id: 'localbookmarks', title: 'Local bookmarks', icon: <Icon.Bookmark />, dock: 'left', defaultOpen: false, Component: LocalBookmarksPanel },
    { id: 'bands', title: 'Band plan', icon: <Icon.List />, dock: 'left', defaultOpen: false, Component: BandsPanel },

    // Minimal: the two bar meters. The numeric readouts and the SNR trace are
    // the same information at a resolution you only want when you are studying
    // a signal rather than glancing at it.
    { id: 'signal', title: 'Signal', icon: <Icon.Gauge />, dock: 'right', minimal: true, Component: SignalPanel },
    // Minimal: squelch and noise reduction. Volume, channel and buffer are set
    // once a session; these two are worked at while you listen.
    { id: 'audio', title: 'Audio', icon: <Icon.Volume />, dock: 'right', minimal: true, Component: AudioPanel },
    { id: 'filters', title: 'Audio filters', icon: <Icon.Sliders />, dock: 'right', defaultOpen: false, Component: AudioFiltersPanel },
    // Minimal: the traces alone. Timebase, contrast and resolution are set once
    // and then watched, and in a side dock they cost more height than the views.
    {
        id: 'scope',
        title: 'Audio scope',
        icon: <Icon.Waves />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: ScopePanel,
    },
    { id: 'display', title: 'Display', icon: <Icon.Sliders />, dock: 'right', defaultOpen: false, Component: DisplayPanel },
    { id: 'status', title: 'Receiver info', icon: <Icon.Info />, dock: 'right', defaultOpen: false, Component: StatusPanel },
    { id: 'layout', title: 'Layout', icon: <Icon.Layers />, dock: 'right', defaultOpen: false, Component: LayoutPanel },

    // Minimal: the amateur bands only, without the operator's quick-tune row.
    {
        id: 'quickbands',
        title: 'Quick bands',
        icon: <Icon.Grid />,
        dock: 'bottom',
        minimal: true,
        Component: QuickBandsPanel,
    },
    // The launcher for the extensions, not the extensions themselves: an open
    // extension is a window of its own (extensions/ExtensionWindow.jsx) and
    // never joins the dock layout.
    {
        id: 'extensions',
        title: 'Extensions',
        icon: <Icon.Plug />,
        dock: 'bottom',
        Component: ExtensionsPanel,
        // Present only when this receiver enables at least one extension v2 can
        // actually render. A receiver with none — or one whose extensions are
        // all still to be written for v2 — gets no panel rather than a list of
        // things that cannot be opened. `enabled` is false until
        // /api/extensions answers, so the panel appears with the reply instead
        // of flashing up empty first.
        requires: (serverInfo, env) => env.extensions.list.some((e) => e.enabled),
    },
    {
        id: 'voice',
        title: 'Voice activity',
        icon: <Icon.Mic />,
        dock: 'bottom',
        fill: true,
        // Minimal: the detections alone, without the scope switch, the count
        // and the button to the full page.
        minimal: true,
        Component: VoiceActivityPanel,
        // The detector runs off the noise floor monitor, so an instance
        // without it has nothing to show and the panel is absent rather than
        // permanently empty — the same gate v1's service applies before it
        // starts polling.
        requires: (serverInfo) => !!(serverInfo && serverInfo.noise_floor),
    },
    // Minimal: the conversation, without the user list beside it.
    {
        id: 'chat',
        title: 'Chat',
        icon: <Icon.Chat />,
        dock: 'bottom',
        fill: true,
        minimal: true,
        Component: ChatPanel,
        Badge: ChatBadge,
    },
    // Off by default: a diagnostic, not something to occupy a slot in the dock
    // until someone goes looking for it in the layout manager.
    {
        id: 'log',
        title: 'Events',
        icon: <Icon.Sliders />,
        dock: 'bottom',
        defaultOpen: false,
        defaultHidden: true,
        fill: true,
        Component: LogPanel,
    },
];

export const PANEL_BY_ID = Object.fromEntries(PANELS.map((p) => [p.id, p]));

/**
 * A predicate for "does this panel apply to the receiver we are connected to".
 *
 * Every place that lists panels — both docks, the mobile tab bar and the layout
 * manager — has to agree, or a panel could be hidden in one and offered in
 * another. So the gate lives here rather than being spelled out three times.
 *
 * `requires` gets `/api/description` first, because that is what nearly every
 * gate asks about, and an environment object second for the ones that need
 * something else: the Extensions panel depends on `/api/extensions`, a separate
 * endpoint that answers separately.
 */
export function usePanelApplies() {
    const { serverInfo } = useRadio();
    const extensions = useExtensions();
    return useCallback(
        (p) => !p.requires || p.requires(serverInfo, { extensions }),
        [serverInfo, extensions],
    );
}
