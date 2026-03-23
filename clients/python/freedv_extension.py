#!/usr/bin/env python3
"""
FreeDV/RADE Decoder Extension for Python Radio Client

Decodes FreeDV digital voice audio received from the server's audio extension
framework, plays it back via sounddevice, and shows the FreeDV Reporter
activity table (live band-filtered list of FreeDV stations).

Binary wire protocol (server -> client):
  Byte 0      : message type  (0x02 = Opus frame)
  Bytes 1-8   : timestamp nanoseconds (int64 big-endian)
  Bytes 9-12  : sample rate Hz (uint32 big-endian)
  Byte 13     : channels (uint8)
  Bytes 14+   : Opus packet data

Activity WebSocket messages (text JSON):
  subscribe_freedv_activity   -> sent to server to start receiving updates
  unsubscribe_freedv_activity -> sent to server to stop
  freedv_activity_snapshot    -> full list of users (users: [...])
  freedv_activity_update      -> incremental update (event, user, sid)
  subscription_status         -> server ack/reject for the subscription
"""

import json
import struct
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from typing import Optional, Dict, Any

try:
    import opuslib
    OPUS_AVAILABLE = True
except ImportError:
    OPUS_AVAILABLE = False

try:
    import sounddevice as sd
    import numpy as np
    SOUNDDEVICE_AVAILABLE = True
except ImportError:
    SOUNDDEVICE_AVAILABLE = False


# Band ranges (Hz) used for activity table filtering
BAND_RANGES = {
    '160m': {'min': 1_800_000,  'max': 2_000_000},
    '80m':  {'min': 3_500_000,  'max': 4_000_000},
    '60m':  {'min': 5_330_500,  'max': 5_403_500},
    '40m':  {'min': 7_000_000,  'max': 7_300_000},
    '30m':  {'min': 10_100_000, 'max': 10_150_000},
    '20m':  {'min': 14_000_000, 'max': 14_350_000},
    '17m':  {'min': 18_068_000, 'max': 18_168_000},
    '15m':  {'min': 21_000_000, 'max': 21_450_000},
    '12m':  {'min': 24_890_000, 'max': 24_990_000},
    '10m':  {'min': 28_000_000, 'max': 29_700_000},
    '6m':   {'min': 50_000_000, 'max': 54_000_000},
}

# Signal watchdog: clear indicator if no frames arrive within this many ms
SIGNAL_TIMEOUT_MS = 1000

class FreeDVExtension:
    """FreeDV/RADE decoder extension window."""

    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        self.parent = parent
        self.dxcluster_ws = dxcluster_ws
        self.radio_control = radio_control

        # Decoder state
        self.running = False
        self.original_ws_handler = None

        # Audio state
        self.opus_decoder: Optional[Any] = None
        self.opus_sample_rate: Optional[int] = None
        self.opus_channels: Optional[int] = None
        self.audio_lock = threading.Lock()
        self.sd_stream: Optional[Any] = None          # persistent sd.OutputStream
        self.sd_stream_rate: Optional[int] = None     # sample rate the stream was opened at
        self.sd_stream_channels: Optional[int] = None # channels the stream was opened with

        # Mute state — saved volume restored when decoder stops
        self._saved_volume: Optional[float] = None

        # Signal watchdog
        self.has_signal = False
        self.frame_count = 0
        self.signal_timeout_id: Optional[str] = None

        # Activity table state
        self.activity_subscribed = False
        self.activity_users: Dict[str, dict] = {}
        self.activity_render_pending = False

        # On-freq dot frequency poll (lightweight, always running while window is open)
        self._freq_poll_timer_id: Optional[str] = None
        self._last_poll_freq: Optional[int] = None

        # Build window
        self.window = tk.Toplevel(parent)
        self.window.title("FreeDV / RADE Decoder")
        self.window.geometry("900x560")
        self.window.minsize(700, 400)
        self.window.protocol("WM_DELETE_WINDOW", self.on_closing)

        self.create_widgets()

        # Install a text-only WS handler so activity messages are received
        # even before the audio decoder is started.
        self._install_text_handler()

        # Subscribe to FreeDV Reporter activity immediately
        self._subscribe_activity()

        # Start lightweight frequency poll so the on-freq ● dot updates in
        # real time as the user tunes (independent of the decoder state).
        self._start_freq_poll()

    # -------------------------------------------------------------------------
    # UI construction
    # -------------------------------------------------------------------------

    def create_widgets(self):
        """Build all Tkinter widgets."""
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)

        main = ttk.Frame(self.window, padding=8)
        main.grid(row=0, column=0, sticky='nsew')
        main.columnconfigure(0, weight=1)
        main.rowconfigure(2, weight=1)

        # Row 0: status bar
        status_frame = ttk.Frame(main)
        status_frame.grid(row=0, column=0, sticky='ew', pady=(0, 6))
        status_frame.columnconfigure(3, weight=1)

        ttk.Label(status_frame, text="Status:").grid(row=0, column=0, padx=(0, 4))
        self.status_label = ttk.Label(status_frame, text="Idle", foreground='gray')
        self.status_label.grid(row=0, column=1, sticky='w')

        self.freq_mode_label = ttk.Label(status_frame, text="", foreground='gray')
        self.freq_mode_label.grid(row=0, column=2, sticky='w', padx=(8, 0))

        ttk.Label(status_frame, text="Signal:").grid(row=0, column=3, padx=(16, 4))
        self.signal_label = ttk.Label(status_frame, text="●", foreground='gray')
        self.signal_label.grid(row=0, column=4, sticky='w')

        ttk.Label(status_frame, text="Frames:").grid(row=0, column=5, padx=(16, 4))
        self.frame_count_label = ttk.Label(status_frame, text="0")
        self.frame_count_label.grid(row=0, column=6, sticky='w')

        ttk.Label(status_frame, text="Audio:").grid(row=0, column=7, padx=(16, 4))
        self.audio_status_label = ttk.Label(status_frame, text="—", foreground='gray')
        self.audio_status_label.grid(row=0, column=8, sticky='w')

        # Row 1: controls
        ctrl_frame = ttk.Frame(main)
        ctrl_frame.grid(row=1, column=0, sticky='ew', pady=(0, 6))

        self.start_btn = ttk.Button(ctrl_frame, text="Start", command=self.toggle_decoder)
        self.start_btn.pack(side='left', padx=(0, 6))

        ttk.Separator(ctrl_frame, orient='vertical').pack(side='left', fill='y', padx=6)

        ttk.Label(ctrl_frame, text="Activity table — band:").pack(side='left', padx=(0, 4))
        self.band_label = ttk.Label(ctrl_frame, text="all bands", foreground='blue')
        self.band_label.pack(side='left')

        self.station_count_label = ttk.Label(ctrl_frame, text="", foreground='gray')
        self.station_count_label.pack(side='left', padx=(12, 0))

        # Error label (hidden until needed)
        self.error_label = ttk.Label(main, text="", foreground='red', wraplength=860)
        self.error_label.grid(row=1, column=0, sticky='ew')
        self.error_label.grid_remove()

        # Row 2: activity table
        table_frame = ttk.LabelFrame(main, text="FreeDV Reporter — Active Stations", padding=4)
        table_frame.grid(row=2, column=0, sticky='nsew', pady=(0, 4))
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)

        columns = ('callsign', 'country', 'dist', 'grid', 'freq', 'message', 'tx', 'last_rx')
        self.tree = ttk.Treeview(
            table_frame,
            columns=columns,
            show='headings',
            selectmode='browse',
        )

        col_cfg = [
            ('callsign', 'Callsign',   90, 'w'),
            ('country',  'Country',   120, 'w'),
            ('dist',     'Dist (km)',  70, 'e'),
            ('grid',     'Grid',       60, 'w'),
            ('freq',     'Freq (kHz)', 90, 'e'),
            ('message',  'Message',   200, 'w'),
            ('tx',       'TX',         40, 'center'),
            ('last_rx',  'Last RX',    90, 'w'),
        ]
        for col_id, heading, width, anchor in col_cfg:
            self.tree.heading(col_id, text=heading,
                              command=lambda c=col_id: self._sort_by_column(c))
            self.tree.column(col_id, width=width, anchor=anchor,
                             stretch=(col_id == 'message'))

        self.tree.tag_configure('transmitting', background='#c62828', foreground='#ffffff')
        self.tree.tag_configure('onfreq', foreground='#2e7d32')  # dark green for on-freq rows

        vsb = ttk.Scrollbar(table_frame, orient='vertical', command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.grid(row=0, column=0, sticky='nsew')
        vsb.grid(row=0, column=1, sticky='ns')

        self.tree.bind('<Double-1>', self._on_row_double_click)

        # Activity status overlay
        self.activity_status_label = ttk.Label(
            table_frame, text="Connecting to FreeDV Reporter...", foreground='gray'
        )
        self.activity_status_label.grid(row=0, column=0, sticky='')

        # Row 3: info bar
        info_frame = ttk.Frame(main)
        info_frame.grid(row=3, column=0, sticky='ew')

        if not OPUS_AVAILABLE:
            ttk.Label(
                info_frame,
                text="opuslib not installed — audio decode disabled (pip install opuslib)",
                foreground='orange',
            ).pack(side='left')
        if not SOUNDDEVICE_AVAILABLE:
            ttk.Label(
                info_frame,
                text="sounddevice/numpy not installed — audio playback disabled",
                foreground='orange',
            ).pack(side='left')

        ttk.Label(
            info_frame,
            text="Double-click a row to tune to that station's frequency.",
            foreground='gray',
        ).pack(side='right')

        self._sort_col = 'callsign'
        self._sort_reverse = False

    # -------------------------------------------------------------------------
    # Activity subscription
    # -------------------------------------------------------------------------

    def _subscribe_activity(self):
        """Send subscribe_freedv_activity to the server."""
        if self.activity_subscribed:
            return
        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            self._set_activity_status("Not connected to server")
            return
        try:
            self.dxcluster_ws.send_message({'type': 'subscribe_freedv_activity'})
            self.activity_subscribed = True
            self._set_activity_status("Connecting to FreeDV Reporter...")
            print("[FreeDV] Subscribed to FreeDV activity stream")
        except Exception as e:
            print(f"[FreeDV] Failed to subscribe to activity: {e}")
            self._set_activity_status(f"Subscription error: {e}")

    def _unsubscribe_activity(self):
        """Send unsubscribe_freedv_activity to the server."""
        if not self.activity_subscribed:
            return
        try:
            if self.dxcluster_ws and self.dxcluster_ws.is_connected():
                self.dxcluster_ws.send_message({'type': 'unsubscribe_freedv_activity'})
        except Exception as e:
            print(f"[FreeDV] Failed to unsubscribe from activity: {e}")
        self.activity_subscribed = False
        print("[FreeDV] Unsubscribed from FreeDV activity stream")

    # -------------------------------------------------------------------------
    # Activity message handlers
    # -------------------------------------------------------------------------

    def _handle_activity_snapshot(self, users: list):
        """Replace the full activity table with a fresh snapshot."""
        self.activity_users.clear()
        for u in users:
            sid = u.get('sid')
            if sid:
                self.activity_users[sid] = u
        self._set_activity_status('')
        self._schedule_render()

    def _handle_activity_update(self, event: str, user: Optional[dict], sid: Optional[str]):
        """Apply an incremental update to the activity table."""
        if event == 'new_connection':
            if user and user.get('sid'):
                self.activity_users[user['sid']] = user
        elif event == 'remove_connection':
            key = sid or (user and user.get('sid'))
            if key:
                self.activity_users.pop(key, None)
        elif event in ('freq_change', 'tx_report', 'rx_report', 'message_update'):
            if user and user.get('sid'):
                self.activity_users[user['sid']] = user
        elif event == 'disconnected':
            self.activity_users.clear()
            self._set_activity_status("FreeDV Reporter disconnected — reconnecting...")
        self._schedule_render()

    def _schedule_render(self):
        """Schedule a table render on the next Tk idle cycle (coalesced)."""
        if self.activity_render_pending:
            return
        self.activity_render_pending = True
        try:
            self.window.after_idle(self._render_activity_table)
        except Exception:
            pass

    # -------------------------------------------------------------------------
    # Band filtering
    # -------------------------------------------------------------------------

    def _current_band_range(self) -> Optional[dict]:
        """Return {min, max} Hz for the band the radio is tuned to, or None."""
        freq_hz = self._get_current_frequency()
        if not freq_hz:
            return None
        for rng in BAND_RANGES.values():
            if rng['min'] <= freq_hz <= rng['max']:
                return rng
        return None

    def _current_band_name(self) -> Optional[str]:
        """Return the name of the current band, or None."""
        freq_hz = self._get_current_frequency()
        if not freq_hz:
            return None
        for name, rng in BAND_RANGES.items():
            if rng['min'] <= freq_hz <= rng['max']:
                return name
        return None

    def _filtered_users(self) -> list:
        """Return users filtered to the current band (all if not in a known band)."""
        rng = self._current_band_range()
        users = list(self.activity_users.values())
        if not rng:
            return users
        return [u for u in users if rng['min'] <= (u.get('freq_hz') or 0) <= rng['max']]

    def _get_current_frequency(self) -> Optional[int]:
        """Get the current SDR frequency in Hz from radio_control."""
        if self.radio_control and hasattr(self.radio_control, 'get_frequency_hz'):
            try:
                return self.radio_control.get_frequency_hz()
            except Exception:
                pass
        return None

    # -------------------------------------------------------------------------
    # Activity table rendering
    # -------------------------------------------------------------------------

    def _render_activity_table(self):
        """Rebuild the Treeview rows from the current activity_users dict."""
        self.activity_render_pending = False

        try:
            if not self.window.winfo_exists():
                return
        except Exception:
            return

        band = self._current_band_name()
        self.band_label.config(text=band if band else 'all bands')

        users = self._filtered_users()

        col = self._sort_col
        rev = self._sort_reverse

        # Map Treeview column IDs to actual data field names
        _col_field = {
            'callsign': 'callsign',
            'country':  'country',
            'dist':     'distance_km',
            'grid':     'grid_square',
            'freq':     'freq_hz',
            'message':  'message',
            'tx':       'transmitting',
            'last_rx':  'last_rx_callsign',
        }

        def sort_key(u):
            tx = u.get('transmitting', False)
            field = _col_field.get(col, col)
            if col == 'freq':
                try:
                    val = float(u.get('freq_hz', 0) or 0)
                except (ValueError, TypeError):
                    val = 0.0
            elif col == 'dist':
                try:
                    val = float(u.get('distance_km', 0) or 0)
                except (ValueError, TypeError):
                    val = 0.0
            else:
                val = str(u.get(field, '') or '')
            return (not tx, val)

        users.sort(key=sort_key, reverse=rev)

        n = len(users)
        self.station_count_label.config(
            text=f"{n} station{'s' if n != 1 else ''}"
        )

        # Diff-based update: collect existing iids keyed by sid
        existing: Dict[str, str] = {}
        for iid in self.tree.get_children():
            tags = self.tree.item(iid, 'tags')
            sid = None
            for t in tags:
                if t.startswith('sid:'):
                    sid = t[4:]
                    break
            if sid:
                existing[sid] = iid

        wanted_sids = {u.get('sid') for u in users if u.get('sid')}

        # Remove rows no longer wanted
        for sid, iid in list(existing.items()):
            if sid not in wanted_sids:
                self.tree.delete(iid)
                del existing[sid]

        # Insert or update rows in sorted order
        for idx, u in enumerate(users):
            sid = u.get('sid', '')
            freq_hz = u.get('freq_hz') or 0
            dial_hz = self._get_current_frequency() or 0
            on_freq = bool(freq_hz and dial_hz and abs(freq_hz - dial_hz) <= 100)
            freq_khz = (f"{freq_hz / 1000:.3f} ●" if on_freq else f"{freq_hz / 1000:.3f}") if freq_hz else ''
            dist = u.get('distance_km')
            dist_str = f"{int(dist)}" if dist is not None else ''
            tx = 'TX' if u.get('transmitting') else ''
            # Last RX: show callsign of last station heard + SNR (matches JS)
            last_rx_call = u.get('last_rx_callsign', '') or ''
            last_rx_snr = u.get('last_rx_snr')
            if last_rx_call:
                last_rx = last_rx_call
                if last_rx_snr is not None:
                    try:
                        last_rx += f" {int(round(last_rx_snr))}dB"
                    except (TypeError, ValueError):
                        pass
            else:
                last_rx = ''

            values = (
                u.get('callsign', ''),
                u.get('country', ''),
                dist_str,
                u.get('grid_square', ''),   # server field is grid_square, not grid
                freq_khz,
                u.get('message', '') or '',
                tx,
                last_rx,
            )
            tags = [f'sid:{sid}']
            if u.get('transmitting'):
                tags.append('transmitting')
            if on_freq:
                tags.append('onfreq')

            if sid in existing:
                iid = existing[sid]
                self.tree.item(iid, values=values, tags=tags)
                self.tree.move(iid, '', idx)
            else:
                iid = self.tree.insert('', idx, values=values, tags=tags)
                existing[sid] = iid

        if users:
            self.activity_status_label.grid_remove()
        else:
            if not self.activity_status_label.winfo_ismapped():
                self.activity_status_label.grid()

    def _set_activity_status(self, msg: str):
        """Show or hide the activity status overlay label."""
        try:
            if not self.window.winfo_exists():
                return
        except Exception:
            return
        if msg:
            self.activity_status_label.config(text=msg)
            if not self.activity_status_label.winfo_ismapped():
                self.activity_status_label.grid()
        else:
            self.activity_status_label.grid_remove()

    def _sort_by_column(self, col: str):
        """Handle column header click to sort."""
        if self._sort_col == col:
            self._sort_reverse = not self._sort_reverse
        else:
            self._sort_col = col
            self._sort_reverse = False
        self._schedule_render()

    def _on_row_double_click(self, event):
        """Tune to the frequency of the double-clicked station."""
        sel = self.tree.selection()
        if not sel:
            return
        iid = sel[0]
        tags = self.tree.item(iid, 'tags')
        sid = None
        for t in tags:
            if t.startswith('sid:'):
                sid = t[4:]
                break
        if not sid:
            return
        user = self.activity_users.get(sid)
        if not user:
            return
        freq_hz = user.get('freq_hz')
        if not freq_hz:
            return
        if self.radio_control and hasattr(self.radio_control, 'set_frequency_hz'):
            try:
                self.radio_control.set_frequency_hz(int(freq_hz))
                print(f"[FreeDV] Tuned to {freq_hz} Hz ({user.get('callsign', '')})")
            except Exception as e:
                print(f"[FreeDV] Failed to tune: {e}")

    # -------------------------------------------------------------------------
    # Decoder start / stop
    # -------------------------------------------------------------------------

    def toggle_decoder(self):
        """Toggle the audio decoder on/off."""
        if self.running:
            self.stop_decoder()
        else:
            self.start_decoder()

    def start_decoder(self):
        """Attach to the FreeDV audio extension and start decoding."""
        if self.running:
            return

        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            messagebox.showerror("Error", "WebSocket not connected")
            return

        if not OPUS_AVAILABLE:
            messagebox.showerror(
                "Missing dependency",
                "opuslib is required for audio decoding.\n\nInstall with: pip install opuslib"
            )
            return

        if not SOUNDDEVICE_AVAILABLE:
            messagebox.showerror(
                "Missing dependency",
                "sounddevice and numpy are required for audio playback.\n\n"
                "Install with: pip install sounddevice numpy"
            )
            return

        try:
            attach_msg = {
                'type': 'audio_extension_attach',
                'extension_name': 'freedv',
                'params': {},
            }
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))

            self.setup_binary_handler()

            # Mute the main SDR audio so the raw digital signal isn't audible
            self._mute_sdr()

            self.running = True
            self.frame_count = 0
            self.has_signal = False
            self._update_signal_badge(False)
            self.frame_count_label.config(text='0')
            self.audio_status_label.config(text='Waiting...', foreground='gray')
            self.start_btn.config(text='Stop')
            self.status_label.config(text='Running', foreground='green')
            self.hide_error()

            print("[FreeDV] Decoder started")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to start FreeDV decoder: {e}")
            print(f"[FreeDV] Error starting decoder: {e}")

    def stop_decoder(self):
        """Detach from the FreeDV audio extension and stop decoding."""
        if not self.running:
            return

        try:
            detach_msg = {'type': 'audio_extension_detach'}
            if self.dxcluster_ws and hasattr(self.dxcluster_ws, 'ws'):
                self.dxcluster_ws.ws.send(json.dumps(detach_msg))
        except Exception as e:
            print(f"[FreeDV] Error sending detach: {e}")

        self.restore_binary_handler()
        self._cancel_signal_timeout()

        # Restore main SDR audio
        self._unmute_sdr()

        with self.audio_lock:
            self._destroy_opus_decoder()

        self.running = False
        self.has_signal = False
        self._update_signal_badge(False)
        self.start_btn.config(text='Start')
        self.status_label.config(text='Stopped', foreground='gray')
        self.audio_status_label.config(text='—', foreground='gray')

        print("[FreeDV] Decoder stopped")

    # -------------------------------------------------------------------------
    # WebSocket binary handler
    # -------------------------------------------------------------------------

    def _install_text_handler(self):
        """Install a text-only WS handler to receive activity messages before the
        decoder is started.  Saves the original handler so it can be fully
        restored on window close."""
        if not hasattr(self.dxcluster_ws, 'ws'):
            return
        if hasattr(self.dxcluster_ws.ws, 'on_message'):
            self.original_ws_handler = self.dxcluster_ws.ws.on_message

        def text_only_handler(ws, message):
            if isinstance(message, bytes):
                return  # ignore binary before decoder starts
            self._handle_text_message_raw(message)

        self.dxcluster_ws.ws.on_message = text_only_handler

    def setup_binary_handler(self):
        """Upgrade the WS handler to also capture binary Opus frames.
        original_ws_handler was already saved by _install_text_handler()."""

        def binary_handler(ws, message):
            if isinstance(message, bytes):
                self.handle_binary_message(message)
            else:
                self._handle_text_message_raw(message)

        if hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = binary_handler

    def restore_binary_handler(self):
        """Downgrade back to text-only handler after decoder stops so activity
        messages keep arriving while the window is still open."""
        if not hasattr(self.dxcluster_ws, 'ws'):
            return

        def text_only_handler(ws, message):
            if isinstance(message, bytes):
                return
            self._handle_text_message_raw(message)

        self.dxcluster_ws.ws.on_message = text_only_handler

    def _remove_text_handler(self):
        """Fully restore the original WS handler (called on window close)."""
        if self.original_ws_handler and hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = self.original_ws_handler
            self.original_ws_handler = None

    def _handle_text_message_raw(self, raw: str):
        """Parse a raw text WS message and dispatch or forward it."""
        try:
            msg = json.loads(raw)
        except Exception:
            if self.original_ws_handler:
                self.original_ws_handler(None, raw)
            return

        msg_type = msg.get('type', '')

        if msg_type == 'freedv_activity_snapshot':
            users = msg.get('users', [])
            self.window.after(0, lambda u=users: self._handle_activity_snapshot(u))
            return

        if msg_type == 'freedv_activity_update':
            event = msg.get('event', '')
            user = msg.get('user') or None
            sid = msg.get('sid') or None
            self.window.after(0, lambda e=event, u=user, s=sid: self._handle_activity_update(e, u, s))
            return

        if msg_type == 'subscription_status' and msg.get('stream') == 'freedv_activity':
            if not msg.get('enabled'):
                err = msg.get('error', 'FreeDV Reporter not available on this server')
                self.window.after(0, lambda m=err: self._set_activity_status(m))
            else:
                self.window.after(0, lambda: self._set_activity_status(''))
            return

        if msg_type == 'audio_extension_error':
            err = msg.get('error', 'Unknown server error')
            self.window.after(0, lambda m=err: self._handle_server_error(m))
            return

        if msg_type == 'audio_extension_attached':
            self.window.after(0, lambda: self.status_label.config(text='Running', foreground='green'))
            return

        # Not for us — forward to original handler
        if self.original_ws_handler:
            self.original_ws_handler(None, raw)

    def handle_binary_message(self, data: bytes):
        """
        Parse and play back a binary Opus frame from the server.

        Protocol:
          [0x02][timestamp:8 BE][sample_rate:4 BE][channels:1][opus_data...]
        """
        if len(data) < 14:
            return

        msg_type = data[0]
        if msg_type != 0x02:
            print(f"[FreeDV] Unknown binary message type: 0x{msg_type:02x}")
            return

        # Bytes 1-8: timestamp nanoseconds (not used for playback scheduling)
        sample_rate = struct.unpack('>I', data[9:13])[0]
        channels = data[13]
        opus_data = bytes(data[14:])

        if not opus_data:
            return

        # Signal detected — backend only sends frames when FreeDV has decoded audio
        if not self.has_signal:
            self.has_signal = True
            self.window.after(0, lambda: self._update_signal_badge(True))
            self.window.after(0, lambda: self.audio_status_label.config(
                text='Decoding', foreground='green'))

        self.frame_count += 1
        count = self.frame_count
        self.window.after(0, lambda c=count: self.frame_count_label.config(text=str(c)))

        # Re-arm signal watchdog
        self._arm_signal_timeout()

        # Decode and play in a background thread to avoid blocking the WS thread
        threading.Thread(
            target=self._decode_and_play,
            args=(opus_data, sample_rate, channels),
            daemon=True,
        ).start()

    # -------------------------------------------------------------------------
    # SDR audio mute / unmute
    # -------------------------------------------------------------------------

    def _mute_sdr(self):
        """Mute the main SDR audio stream by setting client volume to 0."""
        try:
            if self.radio_control and hasattr(self.radio_control, 'client') and self.radio_control.client:
                self._saved_volume = self.radio_control.client.volume
                self.radio_control.client.volume = 0.0
                print(f"[FreeDV] SDR audio muted (saved volume: {self._saved_volume})")
        except Exception as e:
            print(f"[FreeDV] Failed to mute SDR audio: {e}")

    def _unmute_sdr(self):
        """Restore the main SDR audio stream volume."""
        try:
            if (self.radio_control and hasattr(self.radio_control, 'client')
                    and self.radio_control.client and self._saved_volume is not None):
                self.radio_control.client.volume = self._saved_volume
                print(f"[FreeDV] SDR audio restored (volume: {self._saved_volume})")
        except Exception as e:
            print(f"[FreeDV] Failed to restore SDR audio: {e}")
        self._saved_volume = None

    def _get_device_index(self) -> Optional[int]:
        """Return the audio output device index selected in the main GUI, or None for default."""
        if self.radio_control and hasattr(self.radio_control, 'get_selected_device'):
            try:
                return self.radio_control.get_selected_device()
            except Exception:
                pass
        return None

    def _open_sd_stream(self, sample_rate: int, channels: int):
        """Open (or reopen) a persistent sounddevice OutputStream."""
        self._close_sd_stream()
        device_index = self._get_device_index()
        try:
            self.sd_stream = sd.OutputStream(
                samplerate=sample_rate,
                channels=channels,
                dtype='int16',
                device=device_index,
                blocksize=0,   # let sounddevice choose
            )
            self.sd_stream.start()
            self.sd_stream_rate = sample_rate
            self.sd_stream_channels = channels
            dev_str = f"device {device_index}" if device_index is not None else "default device"
            print(f"[FreeDV] Audio stream opened: {sample_rate} Hz, {channels} ch, {dev_str}")
        except Exception as e:
            print(f"[FreeDV] Failed to open audio stream: {e}")
            self.sd_stream = None
            self.sd_stream_rate = None
            self.sd_stream_channels = None

    def _close_sd_stream(self):
        """Stop and close the persistent sounddevice OutputStream."""
        if self.sd_stream is not None:
            try:
                self.sd_stream.stop()
                self.sd_stream.close()
            except Exception:
                pass
            self.sd_stream = None
            self.sd_stream_rate = None
            self.sd_stream_channels = None

    def _decode_and_play(self, opus_data: bytes, sample_rate: int, channels: int):
        """Decode an Opus frame and write it to the persistent audio stream (background thread)."""
        if not OPUS_AVAILABLE or not SOUNDDEVICE_AVAILABLE:
            return

        try:
            with self.audio_lock:
                # (Re-)create Opus decoder if parameters changed
                if (self.opus_decoder is None
                        or self.opus_sample_rate != sample_rate
                        or self.opus_channels != channels):
                    self._destroy_opus_decoder()
                    self.opus_decoder = opuslib.Decoder(sample_rate, channels)
                    self.opus_sample_rate = sample_rate
                    self.opus_channels = channels
                    print(f"[FreeDV] Opus decoder initialised: {sample_rate} Hz, {channels} ch")

                # Decode Opus -> PCM int16 (interleaved)
                pcm_bytes = self.opus_decoder.decode(opus_data, 5760)  # max frame size

                # (Re-)open audio stream if parameters changed
                if (self.sd_stream is None
                        or self.sd_stream_rate != sample_rate
                        or self.sd_stream_channels != channels):
                    self._open_sd_stream(sample_rate, channels)

                if self.sd_stream is None:
                    return

                # Write int16 numpy array directly — same pattern as radio_client.py
                pcm_array = np.frombuffer(pcm_bytes, dtype=np.int16)
                if channels > 1:
                    pcm_array = pcm_array.reshape(-1, channels)
                else:
                    pcm_array = pcm_array.reshape(-1, 1)

                self.sd_stream.write(pcm_array)

        except Exception as e:
            print(f"[FreeDV] Opus decode/play error: {e}")

    def _destroy_opus_decoder(self):
        """Free the Opus decoder and close the audio stream (call with audio_lock held)."""
        self._close_sd_stream()
        if self.opus_decoder is not None:
            try:
                del self.opus_decoder
            except Exception:
                pass
            self.opus_decoder = None
            self.opus_sample_rate = None
            self.opus_channels = None

    # -------------------------------------------------------------------------
    # Signal watchdog
    # -------------------------------------------------------------------------

    def _arm_signal_timeout(self):
        """(Re-)arm the signal-loss watchdog timer."""
        self._cancel_signal_timeout()
        try:
            self.signal_timeout_id = self.window.after(
                SIGNAL_TIMEOUT_MS, self._on_signal_timeout
            )
        except Exception:
            pass

    def _cancel_signal_timeout(self):
        """Cancel the signal-loss watchdog timer."""
        if self.signal_timeout_id is not None:
            try:
                self.window.after_cancel(self.signal_timeout_id)
            except Exception:
                pass
            self.signal_timeout_id = None

    def _on_signal_timeout(self):
        """Called when no Opus frames have arrived for SIGNAL_TIMEOUT_MS ms."""
        self.signal_timeout_id = None
        if self.has_signal:
            self.has_signal = False
            self._update_signal_badge(False)
            self.audio_status_label.config(text='Waiting...', foreground='gray')

    def _update_signal_badge(self, has_signal: bool):
        """Update the signal indicator label colour."""
        try:
            if not self.window.winfo_exists():
                return
        except Exception:
            return
        self.signal_label.config(foreground='green' if has_signal else 'gray')

    def _start_freq_poll(self):
        """Start the lightweight frequency poll for on-freq dot updates."""
        self._last_poll_freq = self._get_current_frequency()
        self._freq_poll_tick()

    def _stop_freq_poll(self):
        """Stop the lightweight frequency poll."""
        if self._freq_poll_timer_id is not None:
            try:
                self.window.after_cancel(self._freq_poll_timer_id)
            except Exception:
                pass
            self._freq_poll_timer_id = None

    def _freq_poll_tick(self):
        """Periodic callback: re-render table if frequency changed (for on-freq dot)."""
        try:
            if not self.window.winfo_exists():
                return
        except Exception:
            return
        current = self._get_current_frequency()
        if current != self._last_poll_freq:
            self._last_poll_freq = current
            self._schedule_render()
        self._update_freq_mode_label()
        self._freq_poll_timer_id = self.window.after(250, self._freq_poll_tick)

    def _update_freq_mode_label(self):
        """Update the frequency/mode label next to the status indicator."""
        try:
            freq_hz = self._get_current_frequency()
            mode = None
            if self.radio_control and hasattr(self.radio_control, 'get_mode'):
                try:
                    mode = self.radio_control.get_mode()
                except Exception:
                    pass

            if freq_hz:
                freq_str = f"{freq_hz / 1e6:.3f} MHz"
                mode_str = mode.upper() if mode else ""
                text = f"({freq_str}  {mode_str})" if mode_str else f"({freq_str})"
            else:
                text = ""

            self.freq_mode_label.config(text=text)
        except Exception:
            pass

    # -------------------------------------------------------------------------
    # Error display
    # -------------------------------------------------------------------------

    def _handle_server_error(self, message: str):
        """Display a server-side error and stop the decoder."""
        print(f"[FreeDV] Server error: {message}")
        self.show_error(message)
        if self.running:
            self.stop_decoder()

    def show_error(self, message: str):
        """Show the error label."""
        try:
            if not self.window.winfo_exists():
                return
        except Exception:
            return
        self.error_label.config(text=f"Error: {message}")
        self.error_label.grid()

    def hide_error(self):
        """Hide the error label."""
        try:
            if not self.window.winfo_exists():
                return
        except Exception:
            return
        self.error_label.grid_remove()

    # -------------------------------------------------------------------------
    # Cleanup
    # -------------------------------------------------------------------------

    def on_closing(self):
        """Handle window close: stop decoder, unsubscribe, clean up."""
        if self.running:
            self.stop_decoder()

        self._unsubscribe_activity()
        self._stop_freq_poll()
        self._cancel_signal_timeout()

        with self.audio_lock:
            self._destroy_opus_decoder()

        # Restore the original WS handler now that the window is gone
        self._remove_text_handler()

        try:
            self.window.destroy()
        except Exception:
            pass


def create_freedv_window(parent: tk.Tk, dxcluster_ws, radio_control) -> FreeDVExtension:
    """Factory function — creates and returns a FreeDVExtension instance."""
    return FreeDVExtension(parent, dxcluster_ws, radio_control)