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
//   requires     optional (serverInfo) => bool; false hides the panel entirely
//   Component    the panel body

import React from '../react.js';
import Icon from '../components/icons.jsx';

import ReceiverPanel from './ReceiverPanel.jsx';
import BandsPanel from './BandsPanel.jsx';
import BookmarksPanel from './BookmarksPanel.jsx';
import AudioPanel from './AudioPanel.jsx';
import SignalPanel from './SignalPanel.jsx';
import DisplayPanel from './DisplayPanel.jsx';
import StatusPanel from './StatusPanel.jsx';
import LayoutPanel from './LayoutPanel.jsx';
import LogPanel from './LogPanel.jsx';
import QuickBandsPanel from './QuickBandsPanel.jsx';
import ChatPanel, { ChatBadge } from './ChatPanel.jsx';
import AddonsPanel, { addonList } from './AddonsPanel.jsx';
import RotatorPanel from './RotatorPanel.jsx';
import AntennaPanel from './AntennaPanel.jsx';

export const PANELS = [
    { id: 'receiver', title: 'Receiver', icon: <Icon.Radio />, dock: 'left', Component: ReceiverPanel },
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

    { id: 'bookmarks', title: 'Bookmarks', icon: <Icon.Bookmark />, dock: 'left', defaultOpen: false, Component: BookmarksPanel },
    { id: 'bands', title: 'Band plan', icon: <Icon.List />, dock: 'left', defaultOpen: false, Component: BandsPanel },

    { id: 'signal', title: 'Signal', icon: <Icon.Gauge />, dock: 'right', Component: SignalPanel },
    { id: 'audio', title: 'Audio', icon: <Icon.Volume />, dock: 'right', Component: AudioPanel },
    { id: 'display', title: 'Display', icon: <Icon.Waves />, dock: 'right', defaultOpen: false, Component: DisplayPanel },
    { id: 'status', title: 'Receiver info', icon: <Icon.Info />, dock: 'right', defaultOpen: false, Component: StatusPanel },
    { id: 'layout', title: 'Layout', icon: <Icon.Layers />, dock: 'right', defaultOpen: false, Component: LayoutPanel },

    { id: 'quickbands', title: 'Quick bands', icon: <Icon.Grid />, dock: 'bottom', Component: QuickBandsPanel },
    { id: 'chat', title: 'Chat', icon: <Icon.Chat />, dock: 'bottom', fill: true, Component: ChatPanel, Badge: ChatBadge },
    { id: 'log', title: 'Events', icon: <Icon.Sliders />, dock: 'bottom', defaultOpen: false, fill: true, Component: LogPanel },
];

export const PANEL_BY_ID = Object.fromEntries(PANELS.map((p) => [p.id, p]));
