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
//   weight       share of the bottom dock's width, 1 being an equal share. Only
//                the starting point: dragging a splitter stores a weight of the
//                operator's own, which then wins.
//   Badge        optional component rendered in the header, for unread counts
//   minimal      true when the panel has a minimal view. The header then shows
//                a toggle, and Component is called with `minimal` — the panel
//                itself decides what survives. That is all it takes to give any
//                panel one: set the flag, then honour the prop.
//                    export default function FooPanel({ minimal }) { … }
//                The choice is remembered per panel and applies wherever the
//                panel is drawn, docked or floating.
//   mobile       first-run defaults for a phone, where the same answer does not
//                suit both machines: { hidden, open }. `hidden` overrides
//                defaultHidden the first time a layout is built; `open` says
//                this panel's sheet is the one showing when the app opens.
//                Both are defaults and never preferences — once someone has
//                hidden or closed the panel their layout says so and this is
//                not consulted again. There is deliberately no minimal
//                override: every panel starts cut down on a phone.
//   touch        first-run defaults for a machine that has a touchscreen but is
//                not a handset — a convertible laptop, a tablet in a dock, a
//                touch monitor in a shack: { hidden, minimal, float }. Same
//                status as `mobile`: defaults for a layout being built, never
//                consulted again once one is stored. `float` opens the panel as
//                a window instead of putting it in a dock, and takes
//                { w, h, anchor }, the anchor being resolved against the
//                floating layer once it has measured — see FloatingLayer.
//   requires     optional (serverInfo, env) => bool; false hides the panel
//                entirely — see usePanelApplies() at the foot of this file
//   Component    the panel body

import React, { useCallback } from '../react.js';
import Icon from '../components/icons.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { useExtensions } from '../extensions/ExtensionsContext.jsx';

import MultipadPanel from './MultipadPanel.jsx';
import ReceiverPanel from './ReceiverPanel.jsx';
import MarkerNavPanel from './MarkerNavPanel.jsx';
import BandsPanel from './BandsPanel.jsx';
import BookmarksPanel from './BookmarksPanel.jsx';
import LocalBookmarksPanel from './LocalBookmarksPanel.jsx';
import AudioPanel from './AudioPanel.jsx';
import AudioFiltersPanel from './AudioFiltersPanel.jsx';
import MediaSessionPanel from './MediaSessionPanel.jsx';
import SignalPanel from './SignalPanel.jsx';
import AnnouncementsPanel from './AnnouncementsPanel.jsx';
import ShortcutsPanel from './ShortcutsPanel.jsx';
import DisplayPanel from './DisplayPanel.jsx';
import StatusPanel from './StatusPanel.jsx';
import ListenersPanel from './ListenersPanel.jsx';
import LayoutPanel from './LayoutPanel.jsx';
import NotificationsPanel from './NotificationsPanel.jsx';
import GamesPanel from './GamesPanel.jsx';
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
import SDRControlPanel from './SDRControlPanel.jsx';
import SpotsPanel, { spotTabs } from './SpotsPanel.jsx';
import SpaceWeatherPanel from './SpaceWeatherPanel.jsx';
import RankingPanel from './RankingPanel.jsx';
import { rankingAvailable } from '../lib/ranking.js';
import ExtensionsPanel from './ExtensionsPanel.jsx';
import BackupPanel from './BackupPanel.jsx';
import DXClusterPanel, { dxClusterAvailable } from './DXClusterPanel.jsx';
import WeatherPanel from './WeatherPanel.jsx';
import NewsPanel from './NewsPanel.jsx';
import ClocksPanel from './ClocksPanel.jsx';
import TopFreqPanel from './TopFreqPanel.jsx';
import SSTVPanel, { sstvAvailable } from './SSTVPanel.jsx';
import LightningPanel, { lightningAvailable } from './LightningPanel.jsx';
import PacketPanel, { packetAvailable } from './PacketPanel.jsx';
import DopplerPanel, { dopplerAvailable } from './DopplerPanel.jsx';
import NavtexPanel, { navtexAvailable } from './NavtexPanel.jsx';
import WefaxPanel, { wefaxAvailable } from './WefaxPanel.jsx';
import VoiceSkimmerPanel, { voiceSkimmerAvailable } from './VoiceSkimmerPanel.jsx';
import HFDLPanel, { hfdlAvailable } from './HFDLPanel.jsx';
import SpectrogramPanel, { spectrogramEnabled } from './SpectrogramPanel.jsx';
import BandSpectrumPanel from './BandSpectrumPanel.jsx';

/**
 * Whether the host allows a chat panel at all.
 *
 * Declared by the host through `window.ubersdrDesktop.chat`, never sniffed, and
 * read the same way as the other host answers (see radio/media/support.js and
 * components/StartOverlay.jsx). Absent is yes: a page in a browser, the desktop
 * client and the Android client all carry on exactly as before, and only a host
 * that says `false` loses the panel.
 */
function chatAllowed() {
    try {
        return !(typeof window !== 'undefined' && window.ubersdrDesktop
            && window.ubersdrDesktop.chat === false);
    } catch (e) {
        return true;
    }
}

export const PANELS = [
    // First, and first is the point: on a phone this is the panel that opens
    // with the app, because it is the one that covers the whole of listening —
    // frequency, mode, zoom, filter width and squelch, in the height the dial
    // alone takes in the Receiver panel. Everything else on a handset is
    // something you go and get; this is already there.
    //
    // Hidden on a mouse-only desktop, where there is room for the real panels
    // and the pad would only be a smaller copy of them.
    //
    // Present on a *touchscreen* desktop, though, because there the argument
    // that put it on a phone applies again and the screen size never did: a
    // barrel exists because a fingertip cannot hit a 16 px arrow, and a
    // convertible laptop folded flat or a touch monitor in a shack has exactly
    // the same fingertip. Floating rather than docked, minimal, in the bottom
    // left — the pad is a thing you reach for with a hand that is already off
    // the keyboard, so it wants to be near the near edge and out of the way of
    // the spectrum, not occupying a column of the left dock. The size is the two
    // barrels and the frequency readout with nothing to scroll.
    //
    // Minimal: the two barrels and the squelch — the controls that exist here
    // because they have no good small form anywhere else, plus the one setting
    // on this panel that is adjusted while listening rather than beforehand.
    // Like every panel it opens cut down on a phone; the mode buttons, the width
    // and the view are one tap on the header away.
    {
        id: 'multipad',
        title: 'Multipad',
        icon: <Icon.Pad />,
        dock: 'left',
        defaultHidden: true,
        minimal: true,
        mobile: { hidden: false, open: true },
        touch: {
            hidden: false,
            minimal: true,
            // Wide enough for the head row whole: a ten-digit readout at 27 px
            // plus the step and mode pickers beside it. The height is that row,
            // the two barrels *and the squelch*, with nothing to scroll — the
            // squelch is part of the minimal view (see above) and the 188 this
            // used to be was measured without it, so the one control here that
            // is adjusted while listening was the one cut off.
            float: { w: 390, h: 213, anchor: 'bottom-left' },
        },
        Component: MultipadPanel,
    },
    // Minimal: the dial, the mode buttons and the filter width — what you tune
    // with. The filter shift, the passband readout and AGC are settings you
    // reach for occasionally.
    { id: 'receiver', title: 'Receiver', icon: <Icon.Radio />, dock: 'left', minimal: true, Component: ReceiverPanel },
    // Directly under the Receiver, because it is about where the dial is: what
    // is on this frequency, and what is either side of it.
    // Minimal: the three markers and who is on this one, without the picker.
    {
        id: 'markernav',
        title: 'Markers',
        icon: <Icon.Pointer />,
        dock: 'left',
        minimal: true,
        Component: MarkerNavPanel,
    },
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
        // Minimal: the spots, without the filter row, the UTC column or the CW
        // tab's Graph button. Once the filters are set they are set, and in a
        // side dock they cost more height than the list; the time is what Age
        // beside it already tells you, and the graph opens a second window,
        // which is not what a compact list is for.
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
    // Under Callsign lookup, and for the same reason it is there: both are
    // things you glance at while listening rather than controls you work.
    // Minimal: the picture and how long ago it arrived.
    {
        id: 'sstv',
        title: 'SSTV',
        icon: <Icon.Picture />,
        dock: 'left',
        minimal: true,
        Component: SSTVPanel,
        // The addon decodes the pictures; without it there is nothing to show
        // and every request would 404.
        requires: (serverInfo) => sstvAvailable(serverInfo),
    },
    // What the VLF sferic addon is hearing. Beside SSTV because it is the same kind
    // of panel — an addon's headline, glanced at while listening to something else,
    // with its own page a click away for the detail.
    //
    // Minimal: the four figures and the minute of activity, without the list of
    // strikes or the link out. "Is it striking, and how hard", from across the room.
    {
        id: 'lightning',
        title: 'Lightning',
        icon: <Icon.Bolt />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: LightningPanel,
        // The addon detects the strikes; without it there is no stream to open and
        // every request would 404.
        requires: (serverInfo) => lightningAvailable(serverInfo),
    },
    // The AX.25 frames the packet addon is decoding. Beside the other two addon
    // panels, and the same bargain: the headline here, the whole application a click
    // away. Not the audio preview it also serves — a receiver that plays a second
    // stream over the one you are listening to has misjudged what a dock is for.
    //
    // Minimal: the frames alone. A decoded frame says what it is by being one.
    {
        id: 'packet',
        title: 'Packet',
        icon: <Icon.Packet />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: PacketPanel,
        requires: (serverInfo) => packetAvailable(serverInfo),
    },
    // What the ionosphere is doing to the standard time stations, from the doppler
    // addon. With the other addon panels, and the same bargain: the state of things
    // here, the curves and the CSV on the addon's own page.
    //
    // Minimal: the stations alone, without the summary above them — which is a summary
    // of those rows, and so the first thing to go when there is no room.
    {
        id: 'doppler',
        title: 'Doppler',
        icon: <Icon.Waves />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: DopplerPanel,
        requires: (serverInfo) => dopplerAvailable(serverInfo),
    },
    // The last maritime safety broadcast on each NAVTEX frequency, from the addon that
    // watches both of them. With the other addon panels.
    //
    // Minimal: the message without the picker, which turns the panel into whichever
    // frequency was last chosen, pinned to the dock.
    {
        id: 'navtex',
        title: 'NAVTEX',
        icon: <Icon.Anchor />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: NavtexPanel,
        requires: (serverInfo) => navtexAvailable(serverInfo),
    },
    // The last weather fax page each frequency produced, from the WEFAX addon. Next to
    // NAVTEX because they are the same panel doing the same job for the same kind of
    // broadcast — one long thing at a time, of which a dock column shows the top.
    //
    // Minimal: the page without the picker, which pins one frequency's latest chart to
    // the dock. The modal still opens from there.
    {
        id: 'wefax',
        title: 'Weather fax',
        icon: <Icon.Fax />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: WefaxPanel,
        requires: (serverInfo) => wefaxAvailable(serverInfo),
    },
    // Callsigns the voice skimmer addon has heard spoken on SSB: what it confirmed,
    // and what it was sure enough of to spot. With the other addon panels.
    //
    // Minimal: the two columns without the counts or the link, which is the panel.
    {
        id: 'voiceskimmer',
        title: 'Voice skimmer',
        icon: <Icon.Mic />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: VoiceSkimmerPanel,
        requires: (serverInfo) => voiceSkimmerAvailable(serverInfo),
    },
    // Aeroplanes heard on shortwave, from the HFDL addon: a world map with the traffic
    // on it, and a modal with the same map several times the size and the aircraft
    // beside it. Everything else the addon knows — per-frequency statistics, the
    // network, propagation, the message feed — stays on its own dashboard, which both
    // the panel and the modal link to.
    //
    // Minimal: the map alone, which is most of why the panel exists.
    {
        id: 'hfdl',
        title: 'HFDL',
        icon: <Icon.Waves />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: HFDLPanel,
        requires: (serverInfo) => hfdlAvailable(serverInfo),
    },
    // The last 24 hours of wherever the dial is, as a picture. Next to SSTV
    // because it belongs to the same kind of panel: something you glance at
    // while listening, not something you work.
    //
    // The panel follows the dial — the band you are in if the server records
    // it, otherwise the wideband HF view — and only asks the server for
    // anything while it is open, because Section unmounts a closed panel's
    // body. The full-resolution image is a click away in a modal, with the
    // frequency and time scales; the panel itself shows the thumbnail, which
    // is tens of kB against the full image's megabytes.
    //
    // Minimal: the picture alone.
    // The band the dial is in, at the resolution the receiver records it — the
    // per-band card from band_activity.html, for one band. Next to the
    // spectrogram because the two are the same kind of thing: a picture of the
    // band that is not the main waterfall.
    //
    // Collapsed by default, and collapsed means disconnected: the panel holds an
    // EventSource while it is mounted, and Section only mounts an open one.
    //
    // Minimal: the chart alone, without the range controls.
    {
        id: 'bandspectrum',
        title: 'Band Spectrum',
        icon: <Icon.ViewSpectrum />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: BandSpectrumPanel,
        // The per-band FFTs are the noise floor monitor's; without it there is
        // no stream to subscribe to.
        requires: (serverInfo) => !!(serverInfo && serverInfo.noise_floor),
    },
    {
        id: 'spectrogram',
        title: 'Spectrogram',
        icon: <Icon.ViewWaterfall />,
        dock: 'left',
        // Ships collapsed, and collapsed means silent: Section mounts a panel's
        // body only while its section is open, so a closed one has no image
        // request and no timer. A 24-hour picture is something you go and look
        // at, not something worth a request a minute from every session that
        // never opens it.
        defaultOpen: false,
        minimal: true,
        Component: SpectrogramPanel,
        // Nothing is recorded, so nothing to show.
        requires: (serverInfo) => spectrogramEnabled(serverInfo),
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
        // Minimal: where the beam is pointing, the dial to swing it, and Stop.
        minimal: true,
        Component: RotatorPanel,
        requires: (serverInfo) => !!(serverInfo && serverInfo.rotator && serverInfo.rotator.enabled),
    },
    {
        id: 'antenna',
        title: 'Antenna switch',
        icon: <Icon.Antenna />,
        dock: 'left',
        defaultOpen: false,
        // Minimal: the antenna buttons and what is live, without the history.
        minimal: true,
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

    // CAT sync with a transceiver. Collapsed by default, and deliberately so:
    // opening it is what starts the 14 MB Hamlib download, since that is the
    // point at which someone has asked for CAT.
    {
        id: 'radiocontrol',
        title: 'Radio control',
        icon: <Icon.Radio />,
        dock: 'left',
        defaultOpen: false,
        // Minimal: the rig's frequency, mode and TX state — the readout is the
        // part worth keeping in view once the link is set up.
        minimal: true,
        Component: RadioControlPanel,
    },

    // The mapped hardware surfaces — a FlexControl dial or a MIDI surface.
    // Independent of Radio control above: either may drive the receiver while a
    // rig is synced. Collapsed by default; it does nothing until someone
    // attaches a device.
    {
        id: 'sdrcontrol',
        title: 'SDR control',
        icon: <Icon.Knob />,
        dock: 'left',
        defaultOpen: false,
        // Minimal: the connection line — is the dial still attached, and the
        // button to attach or drop it. The mapping table and the learn flow are
        // setup, done once.
        minimal: true,
        Component: SDRControlPanel,
    },

    // Minimal, for both bookmark lists: the search box and what it finds. A list of a few
    // hundred is for browsing, which is what the full view is; cut down they answer "where
    // is the one called X", and until something is typed they are two rows tall. The local
    // one also drops everything that *writes* — Current, Import, Export, the edit and
    // delete beside a row — because saving is done once and tuning to what was saved is
    // done every day.
    {
        id: 'bookmarks',
        title: 'Bookmarks',
        icon: <Icon.Bookmark />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: BookmarksPanel,
    },
    {
        id: 'localbookmarks',
        title: 'Local bookmarks',
        icon: <Icon.Bookmark />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: LocalBookmarksPanel,
    },
    // A leaderboard of where the dial actually spends its time, under the two
    // bookmark lists because it is the third of the same kind: one you curate,
    // one you save locally, and one that curates itself.
    // Minimal: the top five, without Show more, what is being timed now, or Clear.
    {
        id: 'topfreq',
        title: 'Most used',
        icon: <Icon.Gauge />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: TopFreqPanel,
    },
    // Minimal: the search box and its matches, without the page that opens on the band the
    // receiver is in — the dial and the marker bar are both already saying that, and this
    // is the view you shrank to get the space back.
    {
        id: 'bands',
        title: 'Band plan',
        icon: <Icon.List />,
        dock: 'left',
        defaultOpen: false,
        minimal: true,
        Component: BandsPanel,
    },

    // Minimal: the two bar meters and the squelch. The numeric readouts and the
    // SNR trace are the same information at a resolution you only want when you
    // are studying a signal rather than glancing at it; the squelch stays
    // because it is a threshold on the SNR the meter is drawing, and it is the
    // one control here you touch while listening.
    { id: 'signal', title: 'Signal', icon: <Icon.Gauge />, dock: 'right', minimal: true, Component: SignalPanel },
    // Directly under Signal: the band you are on and how it is doing are read
    // together, and the chips are a row of buttons rather than a wide table —
    // they fit a dock column better than they fit the bottom rail.
    // Minimal: the amateur bands only, without the operator's quick-tune row.
    {
        id: 'quickbands',
        title: 'Quick bands',
        icon: <Icon.Grid />,
        dock: 'right',
        minimal: true,
        Component: QuickBandsPanel,
    },
    // Under Quick bands, for the same reason Quick bands sits under Signal:
    // the band buttons say how each band is doing right now and this says why,
    // and both are read as one answer to "where should I be listening".
    // Collapsed by default — the top bar already carries the summary, and its
    // click opens this — but the header is right there under the bands.
    // Minimal: the grade, the four indices and the storm scales, without the
    // band table and the forecast.
    {
        id: 'spaceweather',
        title: 'Space weather',
        icon: <Icon.Sun />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: SpaceWeatherPanel,
        // The monitor is optional and off by default; without it every request
        // to /api/spaceweather fails, so the panel is absent rather than
        // permanently empty. Same gate the top bar's summary uses.
        requires: (serverInfo) => !!(serverInfo && serverInfo.space_weather),
    },
    // How this receiver is doing against every other one, on the networks it
    // reports into. Under space weather because they are the same kind of
    // question asked at two scales — that one is how the ionosphere is behaving,
    // this one is what this station managed to hear through it.
    //
    // Collapsed by default: it is a thing you look at now and then rather than
    // while tuning, and it updates four times an hour.
    //
    // Absent on a receiver that reports to none of the three, via `rank_sources`
    // in the description — a field added for this, because nothing already there
    // could tell whether WSPR ranking was on. See rankingAvailable, and
    // BuildRankSources in stats_rank_summary.go.
    //
    // The panel still has its own empty state, and that is not redundant: this
    // gate says whether the networks are *configured*, and the panel says whether
    // they have produced a standing for this callsign yet. A receiver that is set
    // up to report but has not appeared in a table keeps the panel and is told so.
    //
    // Minimal: the headline rows without the per-band detail or the footnotes.
    {
        id: 'ranking',
        title: 'Ranking',
        icon: <Icon.Podium />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: RankingPanel,
        requires: (serverInfo) => rankingAvailable(serverInfo),
    },
    // Under space weather, and the pairing is the point: one says what the
    // ionosphere is doing and the other what the sky is. Both end up in the
    // noise floor.
    //
    // No `requires`: /api/description does not say whether a weather source is
    // configured, so the panel asks the endpoint and says what it was told.
    // Minimal is the glance — conditions, temperature, wind.
    {
        id: 'weather',
        title: 'Weather',
        icon: <Icon.Cloud />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: WeatherPanel,
    },
    // Headlines from ARRL or RSGB. No `requires`: the feeds are on the public
    // internet rather than on this receiver, so nothing about the instance
    // decides whether the panel can work — see lib/news.js for the relay it
    // depends on and what happens when that is down.
    // Minimal: the headlines, without the source picker or the pager.
    {
        id: 'news',
        title: 'News',
        icon: <Icon.News />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: NewsPanel,
    },
    // Which cities are shown is the operator's; see lib/clocks.js. Nothing here
    // touches the receiver, so there is no `requires`.
    // Minimal: the faces, without the city picker.
    {
        id: 'clocks',
        title: 'World clocks',
        icon: <Icon.Clock />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: ClocksPanel,
    },
    // Minimal: noise reduction. Volume, channel and buffer are set once a
    // session; that one is worked at while you listen. Squelch is in Signal,
    // next to the SNR meter it thresholds.
    { id: 'audio', title: 'Audio', icon: <Icon.Volume />, dock: 'right', minimal: true, Component: AudioPanel },
    { id: 'filters', title: 'Audio filters', icon: <Icon.Sliders />, dock: 'right', defaultOpen: false, Component: AudioFiltersPanel },
    // Spoken frequency and mode, for operating without watching the screen.
    // Ships collapsed and switched off: a receiver that starts talking on its
    // own is one somebody has to work out how to silence.
    // Minimal: the switch and what is being announced. The voice and the speed
    // are chosen once.
    // Keyboard shortcuts. The keys live in lib/shortcuts.js; what they *do* is
    // the same function catalogue the SDR control panel maps a MIDI surface to,
    // so a function added there appears here with no change to either panel.
    // Minimal: the switch and the list, without adding or resetting.
    {
        id: 'shortcuts',
        title: 'Shortcuts',
        icon: <Icon.Keyboard />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        // Off a phone's tab bar to begin with: a handset has no keys to press,
        // so this is a panel of bindings that cannot be used taking a slot in a
        // row where every slot is one somebody could. Hidden rather than absent
        // — a phone on a keyboard case is a real thing, and the Layout panel
        // brings it back for anyone who has one.
        mobile: { hidden: true },
        Component: ShortcutsPanel,
    },
    {
        id: 'announcements',
        title: 'Announcements',
        icon: <Icon.Announce />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: AnnouncementsPanel,
    },
    // OS media controls — lock screen, Control Centre, notification shade, media
    // keys. Ships collapsed because it is a per-device preference rather than
    // part of operating the receiver, and absent entirely on a browser with no
    // Media Session API, where the panel could only say so.
    // Minimal: the switch and the card the OS is showing, without the ⏮/⏭ setup.
    {
        id: 'mediasession',
        title: 'Media controls',
        icon: <Icon.LockScreen />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: MediaSessionPanel,
        requires: () => typeof navigator !== 'undefined' && 'mediaSession' in navigator,
    },
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
    // Who else is on the receiver, and the map popup that shows where they are.
    // Minimal: the list without the count and the map button.
    {
        id: 'listeners',
        title: 'Listeners',
        icon: <Icon.Users />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: ListenersPanel,
    },
    // Minimal: the link block — sockets, throughput and the spectrum view.
    // The receiver's identity is read once and then known.
    {
        id: 'status',
        title: 'Receiver info',
        icon: <Icon.Info />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: StatusPanel,
    },
    // Ten games, one at a time — the widget of the same name, native. On the
    // right dock with the other things you are not operating the receiver with,
    // and closed by default: it is for the hours between signals, not the
    // signals. See GamesPanel for what the port kept and what it threw away.
    //
    // Minimal: the game and its picker, without the rules button — you must still
    // be able to change game from a minimised panel. See GamesPanel.
    {
        id: 'games',
        title: 'Mini Games',
        icon: <Icon.Dice />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: GamesPanel,
    },
    { id: 'layout', title: 'Layout', icon: <Icon.Layers />, dock: 'right', defaultOpen: false, Component: LayoutPanel },
    // What the receiver has told you lately, and how much it is allowed to interrupt.
    // Closed by default: the toasts are the feature and they need no panel open to
    // appear — this is where you come to read one you missed or to turn them down.
    //
    // Minimal: the list alone. The settings are set once and left.
    {
        id: 'notifications',
        title: 'Notifications',
        icon: <Icon.Bell />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: NotificationsPanel,
    },
    // Beside Layout, because it is the same kind of housekeeping and because
    // the arrangement built there is one of the things worth keeping.
    // Minimal: export, import and the merge/replace choice, without the
    // per-section switches — most backups are all of it.
    {
        id: 'backup',
        title: 'Backup',
        icon: <Icon.Archive />,
        dock: 'right',
        defaultOpen: false,
        minimal: true,
        Component: BackupPanel,
    },

    // The cluster the dxcluster addon runs, as a terminal — the widget of the
    // same name, native.
    //
    // Left, open, and deliberately not usable there: the panel needs eighty columns and
    // a side dock has a third of that, so in one it shows two buttons that move it to
    // the bottom dock or float it, and connects to nothing. The bottom dock is where it
    // belongs and the wrong place to start — it is the busiest dock by default, and a
    // receiver that opens with a terminal across the bottom has led with the wrong
    // thing. See the note at the top of DXClusterPanel.
    //
    // The login survives the panel: it lives in lib/dxclusterSession.js, so collapsing
    // the dock it is in — or peeking at that dock, or dragging the panel elsewhere —
    // keeps the cluster and the transcript. Only Disconnect, a side dock or a reload
    // ends it.
    //
    // Minimal: the transcript and the command line, without the quick commands.
    {
        id: 'dxcluster',
        title: 'DX cluster',
        icon: <Icon.Packet />,
        dock: 'left',
        fill: true,
        minimal: true,
        Component: DXClusterPanel,
        // Present only where the addon is: without it every request 404s and
        // the panel could only say so.
        requires: (serverInfo) => dxClusterAvailable(serverInfo),
    },

    // The launcher for the extensions, not the extensions themselves: an open
    // extension is a window of its own (extensions/ExtensionWindow.jsx) and
    // never joins the dock layout.
    {
        id: 'extensions',
        title: 'Extensions',
        icon: <Icon.Plug />,
        dock: 'bottom',
        // A launcher: a list of a few names needs half the width its neighbours
        // do, and the room is better spent on chat or the spot tables.
        weight: 0.5,
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
        // Two short lines per detection, so it reads fine at half width.
        weight: 0.5,
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
    // Like the cluster terminal, this one needs more width than a side dock has, and in
    // one it shows two buttons that move it to the bottom dock or float it rather than
    // rendering a room nobody can read. See components/DockTooNarrow.jsx.
    {
        id: 'chat',
        title: 'Chat',
        icon: <Icon.Chat />,
        dock: 'bottom',
        fill: true,
        minimal: true,
        Component: ChatPanel,
        Badge: ChatBadge,
        // Two ways there is no chat here, and neither should leave a panel in
        // the dock explaining itself.
        //
        // The receiver may not run one: `chat_enabled` is the server's own
        // answer (see chat/ChatContext.jsx), and a panel that occupies a slot
        // to say "Chat is not enabled on this receiver" is a panel offering a
        // feature the receiver does not have. Every other optional panel —
        // Doppler, NAVTEX, WEFAX — is simply absent instead, and this is now
        // the same.
        //
        // Or a host may say there is to be no chat at all, and one does: the
        // chat belongs to whichever receiver you are on, and Apple's Guideline
        // 1.2 requires an app carrying user-generated content to offer
        // moderation, reporting and blocking for it — none of which this client
        // can provide on somebody else's receiver. So the iOS client declares
        // `chat: false`. Absent means yes, so browser, desktop and Android are
        // unchanged.
        requires: (serverInfo) => chatAllowed() && !!(serverInfo && serverInfo.chat_enabled),
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
