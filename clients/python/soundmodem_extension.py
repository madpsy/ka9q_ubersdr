#!/usr/bin/env python3
"""
Sound Modem Extension Window for Python Radio Client.

Replicates the JavaScript SoundModem extension:
  - 4-channel AX.25 packet radio decoder (KISS/AGW)
  - Binary wire protocol: 0x20 AX.25 frame, 0x21 error, 0x23 DCD, 0x24 monitor, 0x25 log
  - AX.25 frame decoding via ax25decode.py (port of ax25decode.js)
  - Scrolling FFT waterfall from audio_spectrum_display
  - Frame list with type/channel/callsign/text filtering
  - Monitor panel (decoded frame monitor text)
  - Process log panel (decoder process stderr)
  - DCD activity LEDs per channel
"""

import json
import os
import re
import socket
import struct
import threading
import time
import tkinter as tk
from datetime import datetime
from tkinter import messagebox, scrolledtext, ttk
from typing import Optional

try:
    import ax25decode
    AX25_AVAILABLE = True
except ImportError:
    AX25_AVAILABLE = False
    print('[SoundModem] ax25decode not available')

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False

try:
    from PIL import Image, ImageTk
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# ── Constants ─────────────────────────────────────────────────────────────────

# rx_shift (BPF bandwidth) per modem index — mirrors sm_main.c / main.js
RX_SHIFT = [
    200,   # 0  AFSK 300 bd
    1000,  # 1  AFSK 1200 bd (Bell 202)
    450,   # 2  AFSK 600 bd
    1805,  # 3  AFSK 2400 bd
    1200,  # 4  BPSK 1200 bd
    600,   # 5  BPSK 600 bd
    300,   # 6  BPSK 300 bd
    2400,  # 7  BPSK 2400 bd
    2400,  # 8  QPSK 4800 bd
    1800,  # 9  QPSK 3600 bd
    1200,  # 10 QPSK 2400 bd
    525,   # 11 BPSK FEC (175*3)
    1200,  # 12 DW QPSK V26A
    1600,  # 13 DW 8PSK V27
    1200,  # 14 DW QPSK V26B
    500,   # 15 ARDOP
]

# Modem names exactly as in template.html <option> text
MODEM_NAMES = [
    'AFSK AX.25 300bd',
    'AFSK AX.25 1200bd (Bell 202)',
    'AFSK AX.25 600bd',
    'AFSK AX.25 2400bd',
    'BPSK AX.25 1200bd',
    'BPSK AX.25 600bd',
    'BPSK AX.25 300bd',
    'BPSK AX.25 2400bd',
    'QPSK AX.25 4800bd',
    'QPSK AX.25 3600bd',
    'QPSK AX.25 2400bd',
    'BPSK FEC 4×100bd',
    'DW QPSK V26A 2400bd',
    'DW 8PSK V27 4800bd',
    'DW QPSK V26B 2400bd',
    'ARDOP Packet',
]

CH_COLORS  = ['#29B6F6', '#66BB6A', '#CE93D8', '#FFA726']
CH_NAMES   = ['A', 'B', 'C', 'D']

# Frame type → short label
TYPE_LABELS = {
    'aprs': 'APRS', 'ui': 'UI', 'i': 'I', 'rr': 'RR', 'rnr': 'RNR',
    'rej': 'REJ', 'srej': 'SREJ', 'sabm': 'SABM', 'sabme': 'SABME',
    'ua': 'UA', 'disc': 'DISC', 'dm': 'DM', 'frmr': 'FRMR',
    'xid': 'XID', 'test': 'TEST', 'netrom': 'NR', 'nodes': 'NODES',
    'ip': 'IP', 'arp': 'ARP', 's': 'S', 'u': 'U',
}

NETROM_TYPES = {'netrom', 'nodes', 'nodes-poll', 'l4-connect', 'l4-connect-ack',
                'l4-disc', 'l4-disc-ack', 'l4-info', 'l4-info-ack', 'l4-reset', 'l4-unknown'}
CONNECTED_TYPES = {'i', 'rr', 'rnr', 'rej', 'srej', 'sabm', 'sabme', 'ua', 'disc', 'dm', 'frmr', 'xid', 'test'}
CONTROL_TYPES   = {'rr', 'rnr', 'rej', 'srej'}

VALID_CALL_RE = re.compile(r'^[A-Z0-9]{1,6}(-\d{1,2})?$', re.IGNORECASE)

# Frequency presets — exactly as in template.html
FREQ_PRESETS = [
    ('— Tune to frequency —', 0, ''),
    ('7.049.45 MHz USB (UK Packet)', 7049450, 'usb'),
]

# Config persistence path
_CONFIG_PATH = os.path.join(os.path.expanduser('~'), '.ubersdr_soundmodem.json')
_CONFIG_VERSION = 2


# ── Waterfall colour map ──────────────────────────────────────────────────────

def _wf_color(v: int) -> tuple:
    """Map 0-255 FFT magnitude to (r, g, b) — black→blue→cyan→green→yellow→red."""
    if v < 64:
        r, g, b = 0, 0, v * 4
    elif v < 128:
        r, g, b = 0, (v - 64) * 4, 255
    elif v < 192:
        r, g, b = (v - 128) * 4, 255, 255 - (v - 128) * 4
    else:
        r, g, b = 255, 255 - (v - 192) * 4, 0
    return (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))


def _rgb(r: int, g: int, b: int) -> str:
    return f'#{r:02x}{g:02x}{b:02x}'


# ── Main extension class ──────────────────────────────────────────────────────

class SoundModemExtension:
    """AX.25 packet radio decoder extension window."""

    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        self.parent        = parent
        self.dxcluster_ws  = dxcluster_ws
        self.radio_control = radio_control

        # Runtime state
        self.running        = False
        self.frame_count    = 0
        self.copy_buffer    = []
        self.max_frames     = 25

        # Filter state
        self.filter_type     = 'all'
        self.filter_channel  = 'all'
        self.filter_callsign = ''
        self.filter_dest     = ''
        self.search_text     = ''
        self._seen_callsigns: set = set()
        self._seen_dests:     set = set()
        self._detached_iids: list = []   # track detached tree items for reattach

        # DCD state
        self._dcd_state  = [False, False, False, False]
        self._dcd_after  = [None,  None,  None,  None]

        # Last frame time
        self._last_frame_time: Optional[float] = None
        self._ago_after = None

        # Waterfall
        self._wf_photo      = None   # ImageTk reference (prevent GC)
        self._wf_pixels     = None   # numpy h×w×3 RGB array, None until first render
        self._wf_width      = 0
        self._wf_mouse_x    = None   # canvas X of current mouse position (None = not hovering)
        self._wf_height     = 120
        self._wf_max_freq   = 3300
        self._wf_sample_rate = 48000
        self._wf_last_ms    = 0
        self._wf_line_ms    = 50     # 20 lines/sec
        self._wf_channel_freqs = []  # [{freq, enabled, modem}]

        # Monitor / log windows (Toplevel, None when closed)
        self._monitor_win    = None
        self._monitor_text   = None
        self._monitor_lines  = 0
        self._monitor_max    = 300
        self._monitor_buffer = []   # (ch_label, direction, time_str, text) tuples

        self._log_win    = None
        self._log_text   = None
        self._log_lines  = 0
        self._log_max    = 500
        self._log_buffer = []       # (time_str, text) tuples

        # Panel visibility
        self._settings_open = True

        # Output mode: 'ax25' or 'kiss'
        self._output_mode = 'ax25'

        # KISS TCP server (active when output_mode='kiss')
        self._kiss_server_sock  = None   # listening socket
        self._kiss_server_thread = None  # accept-loop thread
        self._kiss_clients: list = []    # list of connected client sockets
        self._kiss_clients_lock = threading.Lock()
        self._kiss_port_var = tk.StringVar(value='8100')  # user-configurable port

        # WebSocket handler intercept
        self._orig_handler = None

        # Channel config (4 channels)
        self._ch_enabled  = [tk.BooleanVar() for _ in range(4)]
        self._ch_modem    = [tk.StringVar()  for _ in range(4)]
        self._ch_freq     = [tk.StringVar()  for _ in range(4)]
        self._ch_rcvr     = [tk.StringVar()  for _ in range(4)]
        self._ch_fx25     = [tk.StringVar()  for _ in range(4)]
        self._ch_il2p     = [tk.StringVar()  for _ in range(4)]
        self._dcd_thresh  = tk.StringVar()

        # Defaults exactly matching template.html
        # Ch A: enabled, modem=0 (AFSK 300bd), freq=850,  rcvr=0, fx25=1 (On), il2p=2 (IL2P+CRC)
        # Ch B: enabled, modem=6 (BPSK 300bd), freq=2150, rcvr=0, fx25=1 (On), il2p=2 (IL2P+CRC)
        # Ch C: disabled, modem=1, freq=1700, rcvr=0, fx25=1, il2p=0 (Off)
        # Ch D: disabled, modem=1, freq=1700, rcvr=0, fx25=1, il2p=0 (Off)
        defaults = [
            # enabled, modem (index: name),                    freq,   rcvr,       fx25,    il2p
            (True,  f'0: {MODEM_NAMES[0]}', '850',  '0 (off)', '1 On', '2 IL2P+CRC'),
            (True,  f'6: {MODEM_NAMES[6]}', '2150', '0 (off)', '1 On', '2 IL2P+CRC'),
            (False, f'1: {MODEM_NAMES[1]}', '1700', '0 (off)', '1 On', '0 Off'),
            (False, f'1: {MODEM_NAMES[1]}', '1700', '0 (off)', '1 On', '0 Off'),
        ]
        for i, (en, mo, fr, rc, fx, il) in enumerate(defaults):
            self._ch_enabled[i].set(en)
            self._ch_modem[i].set(mo)
            self._ch_freq[i].set(fr)
            self._ch_rcvr[i].set(rc)
            self._ch_fx25[i].set(fx)
            self._ch_il2p[i].set(il)
        self._dcd_thresh.set('20')

        # Build window
        self.window = tk.Toplevel(parent)
        self.window.title('📡 Sound Modem — AX.25 Packet Decoder')
        self.window.geometry('1100x820')
        self.window.protocol('WM_DELETE_WINDOW', self.on_closing)

        self._build_ui()
        self._load_config()
        self._read_channel_freqs_from_ui()
        self._update_kiss_overlay()   # apply saved output mode to overlay
        self._start_waterfall_loop()
        self._start_ago_loop()

    # ── UI construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        """Build the complete UI."""
        main = ttk.Frame(self.window, padding=6)
        main.grid(row=0, column=0, sticky='nsew')
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)
        main.columnconfigure(0, weight=1)

        row = 0

        # ── Toolbar ───────────────────────────────────────────────────────────
        tb = ttk.Frame(main)
        tb.grid(row=row, column=0, sticky='ew', pady=(0, 4))
        row += 1

        self._start_btn = tk.Button(tb, text='Start', width=8,
                                    bg='#388E3C', fg='white', relief='flat',
                                    command=self._toggle_decoder)
        self._start_btn.pack(side='left', padx=(0, 4))

        ttk.Button(tb, text='Clear', command=self._clear_output).pack(side='left', padx=(0, 4))
        ttk.Button(tb, text='Copy',  command=self._copy_output).pack(side='left', padx=(0, 4))

        self._settings_btn = ttk.Button(tb, text='Settings ▲', command=self._toggle_settings)
        self._settings_btn.pack(side='left', padx=(0, 4))

        self._monitor_btn = ttk.Button(tb, text='Monitor', command=self._toggle_monitor)
        self._monitor_btn.pack(side='left', padx=(0, 4))

        self._log_btn = ttk.Button(tb, text='Log', command=self._toggle_log)
        self._log_btn.pack(side='left', padx=(0, 4))

        # Frequency preset
        ttk.Label(tb, text='Tune:').pack(side='left', padx=(8, 2))
        self._freq_preset_var = tk.StringVar(value=FREQ_PRESETS[0][0])
        freq_cb = ttk.Combobox(tb, textvariable=self._freq_preset_var,
                               values=[p[0] for p in FREQ_PRESETS],
                               state='readonly', width=28)
        freq_cb.pack(side='left', padx=(0, 4))
        freq_cb.bind('<<ComboboxSelected>>', self._on_freq_preset)

        # Status
        self._status_var = tk.StringVar(value='Configure channels and press Start…')
        ttk.Label(tb, textvariable=self._status_var, foreground='gray').pack(side='left', padx=(8, 0))

        # ── DCD LEDs + stats row ──────────────────────────────────────────────
        dcd_frame = ttk.Frame(main)
        dcd_frame.grid(row=row, column=0, sticky='ew', pady=(0, 4))
        row += 1

        ttk.Label(dcd_frame, text='DCD:').pack(side='left', padx=(0, 6))
        self._dcd_labels = []
        for i in range(4):
            lbl = tk.Label(dcd_frame, text=f'● {CH_NAMES[i]}',
                           fg='#444444', font=('TkDefaultFont', 9, 'bold'))
            lbl.pack(side='left', padx=(0, 8))
            self._dcd_labels.append(lbl)

        # Frame count + last callsign (far right of DCD row)
        stats_frame = ttk.Frame(dcd_frame)
        stats_frame.pack(side='right')
        ttk.Label(stats_frame, text='Frames:').pack(side='left')
        self._count_var = tk.StringVar(value='0')
        ttk.Label(stats_frame, textvariable=self._count_var, width=6).pack(side='left')
        ttk.Label(stats_frame, text='Last:').pack(side='left', padx=(8, 2))
        self._last_call_var = tk.StringVar(value='---')
        ttk.Label(stats_frame, textvariable=self._last_call_var, width=10).pack(side='left')
        self._ago_var = tk.StringVar(value='')
        ttk.Label(stats_frame, textvariable=self._ago_var, foreground='gray').pack(side='left', padx=(2, 0))

        # ── Settings panel ────────────────────────────────────────────────────
        self._settings_frame = ttk.LabelFrame(main, text='Channel Configuration', padding=6)
        self._settings_frame.grid(row=row, column=0, sticky='ew', pady=(0, 4))
        row += 1
        self._build_settings_panel(self._settings_frame)

        # ── Filter bar ────────────────────────────────────────────────────────
        fbar = ttk.Frame(main)
        fbar.grid(row=row, column=0, sticky='ew', pady=(0, 4))
        row += 1
        self._build_filter_bar(fbar)

        # ── Waterfall ─────────────────────────────────────────────────────────
        wf_outer = ttk.LabelFrame(main, text='Waterfall (0–3300 Hz)', padding=2)
        wf_outer.grid(row=row, column=0, sticky='ew', pady=(0, 4))
        row += 1
        wf_outer.columnconfigure(0, weight=1)

        # Header canvas (frequency scale + channel markers)
        self._wf_hdr = tk.Canvas(wf_outer, height=20, bg='#1a1a1a', highlightthickness=0)
        self._wf_hdr.grid(row=0, column=0, sticky='ew')
        self._wf_hdr.bind('<Configure>', lambda e: self._draw_wf_header())

        # Scrolling waterfall canvas
        self._wf_canvas = tk.Canvas(wf_outer, height=self._wf_height,
                                    bg='black', highlightthickness=0)
        self._wf_canvas.grid(row=1, column=0, sticky='ew')
        self._wf_canvas.bind('<Configure>', self._on_wf_resize)
        self._wf_canvas.bind('<Motion>',   self._on_wf_mouse_move)
        self._wf_canvas.bind('<Leave>',    self._on_wf_mouse_leave)

        # ── Frame list ────────────────────────────────────────────────────────
        list_frame = ttk.LabelFrame(main, text='Decoded Frames', padding=2)
        list_frame.grid(row=row, column=0, sticky='nsew', pady=(0, 4))
        main.rowconfigure(row, weight=1)
        row += 1
        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)
        self._build_frame_list(list_frame)

        # (Monitor and Log are separate Toplevel windows — opened via toolbar buttons)

    def _build_settings_panel(self, parent):
        """Build the 4-channel configuration grid."""
        # Column headers
        headers = ['', 'Enabled', 'Modem', 'Freq (Hz)', 'Rcvr Pairs', 'FX.25', 'IL2P']
        for c, h in enumerate(headers):
            ttk.Label(parent, text=h, font=('TkDefaultFont', 8, 'bold')).grid(
                row=0, column=c, padx=4, pady=2, sticky='w')

        self._ch_param_frames = []
        self._ch_checkbuttons = []
        for i in range(4):
            color = CH_COLORS[i]
            lbl = tk.Label(parent, text=CH_NAMES[i], fg=color,
                           font=('TkDefaultFont', 10, 'bold'), width=2)
            lbl.grid(row=i + 1, column=0, padx=4, pady=2)

            cb = ttk.Checkbutton(parent, variable=self._ch_enabled[i],
                                 command=lambda idx=i: self._on_ch_enabled_change(idx))
            cb.grid(row=i + 1, column=1, padx=4)
            self._ch_checkbuttons.append(cb)

            modem_cb = ttk.Combobox(parent, textvariable=self._ch_modem[i],
                                    values=[f'{j}: {MODEM_NAMES[j]}' for j in range(len(MODEM_NAMES))],
                                    state='readonly', width=18)
            modem_cb.grid(row=i + 1, column=2, padx=4)
            modem_cb.bind('<<ComboboxSelected>>', lambda e, idx=i: self._on_ch_param_change(idx))

            freq_e = ttk.Entry(parent, textvariable=self._ch_freq[i], width=8)
            freq_e.grid(row=i + 1, column=3, padx=4)
            freq_e.bind('<FocusOut>', lambda e, idx=i: self._on_ch_param_change(idx))

            rcvr_cb = ttk.Combobox(parent, textvariable=self._ch_rcvr[i],
                                   values=['0 (off)', '1', '2', '4', '8'],
                                   state='readonly', width=8)
            rcvr_cb.grid(row=i + 1, column=4, padx=4)
            rcvr_cb.bind('<<ComboboxSelected>>', lambda e: self._save_config())

            fx25_cb = ttk.Combobox(parent, textvariable=self._ch_fx25[i],
                                   values=['0 Off', '1 On'],
                                   state='readonly', width=10)
            fx25_cb.grid(row=i + 1, column=5, padx=4)
            fx25_cb.bind('<<ComboboxSelected>>', lambda e: self._save_config())

            il2p_cb = ttk.Combobox(parent, textvariable=self._ch_il2p[i],
                                   values=['0 Off', '1 IL2P', '2 IL2P+CRC', '3 Both'],
                                   state='readonly', width=12)
            il2p_cb.grid(row=i + 1, column=6, padx=4)
            il2p_cb.bind('<<ComboboxSelected>>', lambda e: self._save_config())

            self._ch_param_frames.append((modem_cb, freq_e, rcvr_cb, fx25_cb, il2p_cb))

        # DCD threshold
        dcd_row = ttk.Frame(parent)
        dcd_row.grid(row=5, column=0, columnspan=7, sticky='w', pady=(4, 0))
        ttk.Label(dcd_row, text='DCD Threshold:').pack(side='left', padx=(0, 4))
        self._dcd_thresh_entry = ttk.Entry(dcd_row, textvariable=self._dcd_thresh, width=6)
        self._dcd_thresh_entry.pack(side='left')
        self._dcd_thresh_entry.bind('<FocusOut>', lambda e: self._save_config())
        self._dcd_thresh_entry.bind('<Return>',   lambda e: self._save_config())
        ttk.Label(dcd_row, text='(1–100)', foreground='gray').pack(side='left', padx=(4, 0))

        # Output mode + KISS TCP port
        mode_row = ttk.Frame(parent)
        mode_row.grid(row=6, column=0, columnspan=7, sticky='w', pady=(6, 0))
        ttk.Label(mode_row, text='Output Mode:').pack(side='left', padx=(0, 4))
        self._output_mode_var = tk.StringVar(value='ax25')
        self._mode_ax25_rb = ttk.Radiobutton(mode_row, text='AX.25 (decode frames)',
                                              variable=self._output_mode_var, value='ax25',
                                              command=self._on_output_mode_change)
        self._mode_ax25_rb.pack(side='left', padx=(0, 8))
        self._mode_kiss_rb = ttk.Radiobutton(mode_row, text='KISS TCP (forward raw frames)',
                                              variable=self._output_mode_var, value='kiss',
                                              command=self._on_output_mode_change)
        self._mode_kiss_rb.pack(side='left', padx=(0, 8))
        ttk.Label(mode_row, text='Port:').pack(side='left', padx=(0, 4))
        self._kiss_port_entry = ttk.Entry(mode_row, textvariable=self._kiss_port_var, width=6)
        self._kiss_port_entry.pack(side='left')
        self._kiss_status_var = tk.StringVar(value='')
        self._kiss_status_lbl = ttk.Label(mode_row, textvariable=self._kiss_status_var,
                                           foreground='gray')
        self._kiss_status_lbl.pack(side='left', padx=(8, 0))

        # Apply initial enabled state
        for i in range(4):
            self._on_ch_enabled_change(i)

    def _build_filter_bar(self, parent):
        """Build the filter controls row."""
        ttk.Label(parent, text='Type:').pack(side='left', padx=(0, 2))
        self._filter_type_var = tk.StringVar(value='all')
        type_cb = ttk.Combobox(parent, textvariable=self._filter_type_var,
                               values=['all', 'aprs', 'ui', 'connected', 'netrom', 'control', 'ip'],
                               state='readonly', width=10)
        type_cb.pack(side='left', padx=(0, 8))
        type_cb.bind('<<ComboboxSelected>>', lambda e: self._apply_filters())

        ttk.Label(parent, text='Ch:').pack(side='left', padx=(0, 2))
        self._filter_ch_var = tk.StringVar(value='all')
        ch_cb = ttk.Combobox(parent, textvariable=self._filter_ch_var,
                             values=['all', 'A', 'B', 'C', 'D'],
                             state='readonly', width=5)
        ch_cb.pack(side='left', padx=(0, 8))
        ch_cb.bind('<<ComboboxSelected>>', lambda e: self._apply_filters())

        ttk.Label(parent, text='Sender:').pack(side='left', padx=(0, 2))
        self._filter_call_var = tk.StringVar(value='')
        self._call_cb = ttk.Combobox(parent, textvariable=self._filter_call_var,
                                     values=[], state='readonly', width=12)
        self._call_cb.pack(side='left', padx=(0, 8))
        self._call_cb.bind('<<ComboboxSelected>>', lambda e: self._apply_filters())

        ttk.Label(parent, text='Dest:').pack(side='left', padx=(0, 2))
        self._filter_dest_var = tk.StringVar(value='')
        self._dest_cb = ttk.Combobox(parent, textvariable=self._filter_dest_var,
                                     values=[], state='readonly', width=12)
        self._dest_cb.pack(side='left', padx=(0, 8))
        self._dest_cb.bind('<<ComboboxSelected>>', lambda e: self._apply_filters())

        ttk.Label(parent, text='Search:').pack(side='left', padx=(0, 2))
        self._search_var = tk.StringVar()
        search_e = ttk.Entry(parent, textvariable=self._search_var, width=16)
        search_e.pack(side='left', padx=(0, 4))
        search_e.bind('<KeyRelease>', lambda e: self._apply_filters())

        ttk.Button(parent, text='✕', width=2,
                   command=self._clear_filters).pack(side='left')

        ttk.Label(parent, text='Max:').pack(side='left', padx=(8, 2))
        self._max_frames_var = tk.StringVar(value='25')
        max_cb = ttk.Combobox(parent, textvariable=self._max_frames_var,
                              values=['10', '25', '50', '100', '0 (unlimited)'],
                              state='readonly', width=12)
        max_cb.pack(side='left')
        max_cb.bind('<<ComboboxSelected>>', self._on_max_frames_change)

    def _build_frame_list(self, parent):
        """Build the decoded-frames Treeview."""
        cols = ('ch', 'time', 'path', 'type', 'payload')
        self._tree = ttk.Treeview(parent, columns=cols, show='headings', height=12)

        self._tree.heading('ch',      text='Ch')
        self._tree.heading('time',    text='Time')
        self._tree.heading('path',    text='Path')
        self._tree.heading('type',    text='Type')
        self._tree.heading('payload', text='Payload')

        self._tree.column('ch',      width=30,  stretch=False)
        self._tree.column('time',    width=70,  stretch=False)
        self._tree.column('path',    width=200, stretch=False)
        self._tree.column('type',    width=60,  stretch=False)
        self._tree.column('payload', width=600, stretch=True)

        vsb = ttk.Scrollbar(parent, orient='vertical',   command=self._tree.yview)
        hsb = ttk.Scrollbar(parent, orient='horizontal', command=self._tree.xview)
        self._tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)

        self._tree.grid(row=0, column=0, sticky='nsew')
        vsb.grid(row=0, column=1, sticky='ns')
        hsb.grid(row=1, column=0, sticky='ew')

        # Tag colours per channel
        for i in range(4):
            self._tree.tag_configure(f'ch{i}', foreground=CH_COLORS[i])
        self._tree.tag_configure('aprs',   background='#1a2a1a')
        self._tree.tag_configure('netrom', background='#1a1a2a')
        self._tree.tag_configure('ip',     background='#2a1a1a')

        # KISS mode overlay — shown instead of the frame list when output_mode='kiss'
        self._kiss_overlay_var = tk.StringVar(value='')
        self._kiss_overlay = tk.Label(
            parent,
            textvariable=self._kiss_overlay_var,
            bg='#1a1a1a', fg='#aaaaaa',
            font=('TkDefaultFont', 11),
            justify='center',
            wraplength=500,
        )
        # Hidden by default; shown via place() when KISS mode is active

    # ── Settings panel toggle ─────────────────────────────────────────────────

    def _toggle_settings(self):
        self._settings_open = not self._settings_open
        if self._settings_open:
            self._settings_frame.grid()
            self._settings_btn.config(text='Settings ▲')
            # Keep inputs disabled while running
            if self.running:
                self._set_config_inputs_enabled(False)
        else:
            self._settings_frame.grid_remove()
            self._settings_btn.config(text='Settings ▼')

    def _toggle_monitor(self):
        """Open or focus the Monitor window (separate Toplevel)."""
        if self._monitor_win and self._monitor_win.winfo_exists():
            self._monitor_win.lift()
            return
        win = tk.Toplevel(self.window)
        win.title('Sound Modem — Monitor')
        win.geometry('800x400')
        win.columnconfigure(0, weight=1)
        win.rowconfigure(0, weight=1)
        self._monitor_text = scrolledtext.ScrolledText(
            win, wrap='word', font=('Courier New', 9),
            bg='#0d0d0d', fg='#aaffaa', state='disabled')
        self._monitor_text.grid(row=0, column=0, sticky='nsew', padx=4, pady=4)
        self._monitor_win = win
        self._monitor_lines = 0
        # Replay buffered lines into the new window
        self._replay_monitor_buffer()
        def _on_close():
            self._monitor_win = None
            self._monitor_text = None
            self._monitor_lines = 0
            win.destroy()
        win.protocol('WM_DELETE_WINDOW', _on_close)

    def _toggle_log(self):
        """Open or focus the Process Log window (separate Toplevel)."""
        if self._log_win and self._log_win.winfo_exists():
            self._log_win.lift()
            return
        win = tk.Toplevel(self.window)
        win.title('Sound Modem — Process Log')
        win.geometry('800x400')
        win.columnconfigure(0, weight=1)
        win.rowconfigure(0, weight=1)
        self._log_text = scrolledtext.ScrolledText(
            win, wrap='word', font=('Courier New', 9),
            bg='#0d0d0d', fg='#aaaaff', state='disabled')
        self._log_text.grid(row=0, column=0, sticky='nsew', padx=4, pady=4)
        self._log_win = win
        self._log_lines = 0
        # Replay buffered lines into the new window
        self._replay_log_buffer()
        def _on_close():
            self._log_win = None
            self._log_text = None
            self._log_lines = 0
            win.destroy()
        win.protocol('WM_DELETE_WINDOW', _on_close)

    # ── Channel enable/disable ────────────────────────────────────────────────

    def _on_ch_enabled_change(self, idx: int):
        enabled = self._ch_enabled[idx].get()
        widgets = self._ch_param_frames[idx]
        state = 'readonly' if enabled else 'disabled'
        entry_state = 'normal' if enabled else 'disabled'
        for w in widgets:
            try:
                if isinstance(w, ttk.Entry):
                    w.config(state=entry_state)
                else:
                    w.config(state=state)
            except Exception:
                pass
        self._read_channel_freqs_from_ui()
        self._draw_wf_header()
        self._save_config()

    def _on_ch_param_change(self, idx: int):
        self._read_channel_freqs_from_ui()
        self._draw_wf_header()
        self._save_config()

    def _set_config_inputs_enabled(self, enabled: bool):
        state_ro = 'readonly' if enabled else 'disabled'
        state_n  = 'normal'   if enabled else 'disabled'
        # Channel param widgets (modem, freq, rcvr, fx25, il2p)
        for i in range(4):
            for w in self._ch_param_frames[i]:
                try:
                    if isinstance(w, ttk.Entry):
                        w.config(state=state_n)
                    else:
                        w.config(state=state_ro)
                except Exception:
                    pass
        # Channel enable checkbuttons
        for cb in getattr(self, '_ch_checkbuttons', []):
            try:
                cb.config(state=state_n)
            except Exception:
                pass
        # DCD threshold entry
        dcd_e = getattr(self, '_dcd_thresh_entry', None)
        if dcd_e:
            try:
                dcd_e.config(state=state_n)
            except Exception:
                pass
        # Output mode radio buttons and KISS port entry
        for w in (getattr(self, '_mode_ax25_rb', None),
                  getattr(self, '_mode_kiss_rb', None),
                  getattr(self, '_kiss_port_entry', None)):
            if w:
                try:
                    w.config(state=state_n)
                except Exception:
                    pass

    # ── Output mode + KISS TCP server ────────────────────────────────────────

    def _update_kiss_overlay(self):
        """Show or hide the KISS mode overlay over the frame list."""
        if not hasattr(self, '_kiss_overlay'):
            return
        if self._output_mode == 'kiss':
            port = self._kiss_port_var.get()
            self._kiss_overlay_var.set(
                f'📡 KISS TCP Mode\n\n'
                f'Connect your KISS-compatible client to:\n'
                f'0.0.0.0:{port}\n\n'
                f'Decoded frames are not shown in this mode.'
            )
            # Cover the Treeview using place geometry
            self._kiss_overlay.place(relx=0, rely=0, relwidth=1, relheight=1)
            self._tree.configure(selectmode='none')
        else:
            self._kiss_overlay.place_forget()
            self._tree.configure(selectmode='browse')

    def _on_output_mode_change(self):
        """Handle output mode radio button change."""
        mode = self._output_mode_var.get()
        self._output_mode = mode
        self._update_kiss_overlay()
        self._save_config()
        if self.running:
            # Send set_output_mode control message to backend (no restart needed)
            self._send_set_output_mode(mode)
            if mode == 'kiss':
                self._start_kiss_server()
            else:
                self._stop_kiss_server()

    def _send_set_output_mode(self, mode: str):
        """Send audio_extension_control set_output_mode to backend."""
        try:
            if self.dxcluster_ws and self.dxcluster_ws.ws:
                msg = {
                    'type': 'audio_extension_control',
                    'control_type': 'set_output_mode',
                    'output_mode': mode,
                }
                self.dxcluster_ws.ws.send(json.dumps(msg))
        except Exception as e:
            print(f'[SoundModem] set_output_mode error: {e}')

    def _start_kiss_server(self):
        """Start a TCP server that forwards 0x22 KISS frames to connected clients."""
        if self._kiss_server_sock:
            return  # Already running
        try:
            port = int(self._kiss_port_var.get())
        except ValueError:
            port = 8100
        try:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(('0.0.0.0', port))
            srv.listen(5)
            srv.settimeout(1.0)
            self._kiss_server_sock = srv
            self._kiss_server_thread = threading.Thread(
                target=self._kiss_accept_loop, daemon=True)
            self._kiss_server_thread.start()
            self.window.after(0, lambda p=port: self._kiss_status_var.set(
                f'Listening on 0.0.0.0:{p}'))
            self.window.after(0, self._update_kiss_overlay)
            print(f'[SoundModem] KISS TCP server started on port {port}')
        except Exception as e:
            self.window.after(0, lambda err=e: self._kiss_status_var.set(f'Error: {err}'))
            print(f'[SoundModem] KISS server start error: {e}')

    def _stop_kiss_server(self):
        """Stop the KISS TCP server and disconnect all clients."""
        srv = self._kiss_server_sock
        self._kiss_server_sock = None
        if srv:
            try:
                srv.close()
            except Exception:
                pass
        with self._kiss_clients_lock:
            for c in list(self._kiss_clients):
                try:
                    c.close()
                except Exception:
                    pass
            self._kiss_clients.clear()
        try:
            self._kiss_status_var.set('')
        except Exception:
            pass
        # Hide the overlay when server stops
        try:
            self._update_kiss_overlay()
        except Exception:
            pass
        print('[SoundModem] KISS TCP server stopped')

    def _kiss_accept_loop(self):
        """Background thread: accept KISS TCP client connections."""
        while self._kiss_server_sock:
            try:
                conn, addr = self._kiss_server_sock.accept()
                with self._kiss_clients_lock:
                    self._kiss_clients.append(conn)
                print(f'[SoundModem] KISS client connected: {addr}')
                self._update_kiss_client_count()
                # Monitor this client for disconnection in a separate thread
                t = threading.Thread(
                    target=self._kiss_client_monitor,
                    args=(conn, addr),
                    daemon=True)
                t.start()
            except socket.timeout:
                continue
            except Exception:
                break

    def _kiss_client_monitor(self, conn: socket.socket, addr):
        """Background thread: detect when a KISS client disconnects."""
        try:
            # recv with zero bytes returns b'' on clean close, raises on error
            while True:
                data = conn.recv(1)
                if not data:
                    break  # clean disconnect
        except Exception:
            pass
        # Remove from client list and update count
        with self._kiss_clients_lock:
            if conn in self._kiss_clients:
                self._kiss_clients.remove(conn)
        try:
            conn.close()
        except Exception:
            pass
        print(f'[SoundModem] KISS client disconnected: {addr}')
        self._update_kiss_client_count()

    def _update_kiss_client_count(self):
        """Update the KISS status label with current client count (thread-safe)."""
        with self._kiss_clients_lock:
            n = len(self._kiss_clients)
        port = self._kiss_port_var.get()
        try:
            self.window.after(0, lambda n=n, p=port: self._kiss_status_var.set(
                f'Listening on 0.0.0.0:{p} — {n} client(s) connected'))
        except Exception:
            pass

    def _forward_kiss_frame(self, kiss_frame: bytes):
        """Forward a raw KISS frame to all connected TCP clients."""
        had_dead = False
        with self._kiss_clients_lock:
            dead = []
            for c in list(self._kiss_clients):
                try:
                    c.sendall(kiss_frame)
                except Exception:
                    dead.append(c)
            for c in dead:
                self._kiss_clients.remove(c)
                try:
                    c.close()
                except Exception:
                    pass
            had_dead = bool(dead)
        if had_dead:
            self._update_kiss_client_count()

    # ── Config persistence ────────────────────────────────────────────────────

    def _save_config(self):
        try:
            cfg = {
                '_v':           _CONFIG_VERSION,
                'channels':     [],
                'dcd_threshold': self._dcd_thresh.get(),
                'output_mode':  getattr(self, '_output_mode_var', None) and self._output_mode_var.get() or 'ax25',
                'kiss_port':    self._kiss_port_var.get(),
            }
            for i in range(4):
                cfg['channels'].append({
                    'enabled':    self._ch_enabled[i].get(),
                    'modem':      self._ch_modem[i].get(),
                    'freq':       self._ch_freq[i].get(),
                    'rcvr_pairs': self._ch_rcvr[i].get(),
                    'fx25':       self._ch_fx25[i].get(),
                    'il2p':       self._ch_il2p[i].get(),
                })
            with open(_CONFIG_PATH, 'w') as f:
                json.dump(cfg, f)
        except Exception:
            pass

    def _load_config(self):
        try:
            if not os.path.exists(_CONFIG_PATH):
                return
            with open(_CONFIG_PATH) as f:
                cfg = json.load(f)
            if not cfg or not isinstance(cfg.get('channels'), list):
                return
            if (cfg.get('_v', 1)) < _CONFIG_VERSION:
                os.remove(_CONFIG_PATH)
                return
            for i, ch in enumerate(cfg['channels'][:4]):
                if 'enabled'    in ch: self._ch_enabled[i].set(bool(ch['enabled']))
                if 'modem'      in ch: self._ch_modem[i].set(str(ch['modem']))
                if 'freq'       in ch: self._ch_freq[i].set(str(ch['freq']))
                if 'rcvr_pairs' in ch: self._ch_rcvr[i].set(str(ch['rcvr_pairs']))
                if 'fx25'       in ch: self._ch_fx25[i].set(str(ch['fx25']))
                if 'il2p'       in ch: self._ch_il2p[i].set(str(ch['il2p']))
                self._on_ch_enabled_change(i)
            if 'dcd_threshold' in cfg:
                self._dcd_thresh.set(str(cfg['dcd_threshold']))
            if 'output_mode' in cfg and hasattr(self, '_output_mode_var'):
                mode = cfg['output_mode']
                if mode in ('ax25', 'kiss'):
                    self._output_mode_var.set(mode)
                    self._output_mode = mode
            if 'kiss_port' in cfg:
                self._kiss_port_var.set(str(cfg['kiss_port']))
        except Exception:
            pass

    # ── Collect params ────────────────────────────────────────────────────────

    def _collect_params(self) -> dict:
        channels = []
        for i in range(4):
            try:
                modem_val = self._ch_modem[i].get()
                modem = int(modem_val.split(':')[0]) if ':' in modem_val else int(modem_val)
            except ValueError:
                modem = 1
            try:
                freq = float(self._ch_freq[i].get())
            except ValueError:
                freq = 1700.0
            try:
                rcvr = int(self._ch_rcvr[i].get().split()[0])
            except (ValueError, IndexError):
                rcvr = 0
            try:
                fx25 = int(self._ch_fx25[i].get().split()[0])
            except (ValueError, IndexError):
                fx25 = 1
            try:
                il2p = int(self._ch_il2p[i].get().split()[0])
            except (ValueError, IndexError):
                il2p = 0
            channels.append({
                'enabled':    self._ch_enabled[i].get(),
                'modem':      modem,
                'freq':       freq,
                'rcvr_pairs': rcvr,
                'fx25':       fx25,
                'il2p':       il2p,
            })
        try:
            dcd = max(1, min(100, int(self._dcd_thresh.get())))
        except ValueError:
            dcd = 20
        return {'channels': channels, 'dcd_threshold': dcd}

    def _read_channel_freqs_from_ui(self):
        self._wf_channel_freqs = []
        for i in range(4):
            enabled = self._ch_enabled[i].get()
            try:
                modem_val = self._ch_modem[i].get()
                modem = int(modem_val.split(':')[0]) if ':' in modem_val else int(modem_val)
            except ValueError:
                modem = 1
            try:
                freq = float(self._ch_freq[i].get())
            except ValueError:
                freq = 1700.0
            self._wf_channel_freqs.append({'enabled': enabled, 'modem': modem, 'freq': freq})

    # ── Decoder start/stop ────────────────────────────────────────────────────

    def _toggle_decoder(self):
        if self.running:
            self._stop_decoder()
        else:
            self._start_decoder()

    def _start_decoder(self):
        if self.running:
            return
        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            messagebox.showerror('Error', 'WebSocket not connected')
            return
        params = self._collect_params()
        if not any(ch['enabled'] for ch in params['channels']):
            messagebox.showerror('Error', 'Enable at least one channel')
            return
        self._wf_channel_freqs = [
            {'freq': ch['freq'], 'enabled': ch['enabled'], 'modem': ch['modem']}
            for ch in params['channels']
        ]
        self._output_mode = self._output_mode_var.get()
        self._install_binary_handler()
        msg = {
            'type': 'audio_extension_attach',
            'extension_name': 'soundmodem',
            'params': {'output_mode': self._output_mode, **params}
        }
        try:
            self.dxcluster_ws.ws.send(json.dumps(msg))
        except Exception as e:
            messagebox.showerror('Error', f'Failed to send attach: {e}')
            self._restore_binary_handler()
            return
        self.running = True
        self._set_status('Connecting…', 'blue')
        self._start_btn.config(text='Stop', bg='#f44336')
        self._settings_open = False
        self._settings_frame.grid_remove()
        self._settings_btn.config(text='Settings ▼')
        self._set_config_inputs_enabled(False)
        # Start KISS TCP server if in KISS mode and update overlay
        if self._output_mode == 'kiss':
            self._start_kiss_server()
        self._update_kiss_overlay()

    def _stop_decoder(self):
        if not self.running:
            return
        try:
            if self.dxcluster_ws and self.dxcluster_ws.ws:
                self.dxcluster_ws.ws.send(json.dumps({'type': 'audio_extension_detach'}))
        except Exception:
            pass
        self._restore_binary_handler()
        self.running = False
        self._set_status('Stopped', 'gray')
        self._start_btn.config(text='Start', bg='#388E3C')
        self._set_config_inputs_enabled(True)
        for i in range(4):
            if self._dcd_after[i]:
                self.window.after_cancel(self._dcd_after[i])
                self._dcd_after[i] = None
            self._dcd_state[i] = False
            self._update_dcd_led(i, False)
        # Stop KISS TCP server if running
        self._stop_kiss_server()
        # Clear buffers for next session
        self._log_buffer.clear()
        self._monitor_buffer.clear()

    # ── WebSocket binary interception ─────────────────────────────────────────

    def _install_binary_handler(self):
        if not hasattr(self.dxcluster_ws, 'ws') or not self.dxcluster_ws.ws:
            return
        self._orig_handler = self.dxcluster_ws.ws.on_message
        ext = self

        def _handler(ws, message):
            if isinstance(message, bytes):
                # Schedule on Tkinter main thread (thread-safe)
                try:
                    if ext.window.winfo_exists():
                        ext.window.after(0, lambda m=message: ext._handle_binary(m))
                except Exception:
                    pass
            else:
                try:
                    data = json.loads(message)
                    if data.get('type') == 'audio_extension_attached':
                        try:
                            ext.window.after(0, lambda: ext._set_status('Running — listening for packets…', 'green'))
                        except Exception:
                            pass
                        return
                    if data.get('type') == 'audio_extension_control_ack':
                        # Mode switch confirmed — no action needed
                        return
                    if data.get('type') == 'audio_extension_error':
                        err = data.get('error', 'Unknown error')
                        try:
                            ext.window.after(0, lambda e=err: ext._handle_server_error(e))
                        except Exception:
                            pass
                        return
                except Exception:
                    pass
                if ext._orig_handler:
                    ext._orig_handler(ws, message)

        self.dxcluster_ws.ws.on_message = _handler

    def _restore_binary_handler(self):
        if self._orig_handler and hasattr(self.dxcluster_ws, 'ws') and self.dxcluster_ws.ws:
            self.dxcluster_ws.ws.on_message = self._orig_handler
        self._orig_handler = None

    # ── Binary message parsing ────────────────────────────────────────────────

    def _handle_binary(self, data: bytes):
        if len(data) < 1:
            return
        t = data[0]
        if   t == 0x20: self._handle_packet(data)
        elif t == 0x21: self._handle_binary_error(data)
        elif t == 0x22: self._handle_kiss_frame(data)
        elif t == 0x23: self._handle_dcd(data)
        elif t == 0x24: self._handle_monitor(data)
        elif t == 0x25: self._handle_log(data)

    def _handle_packet(self, data: bytes):
        if len(data) < 6:
            return
        kiss_port = data[1]
        frame_len = struct.unpack('>I', data[2:6])[0]
        if len(data) < 6 + frame_len:
            return
        ax25_bytes = data[6:6 + frame_len]
        if not AX25_AVAILABLE:
            return
        parsed = ax25decode.parse(ax25_bytes)
        if not parsed:
            return
        parsed['kiss_port'] = kiss_port
        self._display_frame(parsed)

    def _handle_kiss_frame(self, data: bytes):
        """0x22: [type:1][frame_len:4 BE][kiss_frame:N] — raw KISS frame with 0xC0 delimiters."""
        if len(data) < 5:
            return
        frame_len = struct.unpack('>I', data[1:5])[0]
        if len(data) < 5 + frame_len:
            return
        kiss_frame = data[5:5 + frame_len]
        # Count the frame (same counter as AX.25 mode)
        self.frame_count += 1
        self._count_var.set(str(self.frame_count))
        self._last_frame_time = time.time()
        # Forward to all connected KISS TCP clients
        self._forward_kiss_frame(kiss_frame)

    def _handle_binary_error(self, data: bytes):
        if len(data) < 5:
            return
        msg_len = struct.unpack('>I', data[1:5])[0]
        if len(data) < 5 + msg_len:
            return
        msg = data[5:5 + msg_len].decode('utf-8', errors='replace')
        self._handle_server_error(msg)

    def _handle_dcd(self, data: bytes):
        if len(data) < 3:
            return
        channel = data[1]
        dcd_on  = data[2] != 0
        if channel >= 4:
            return
        if dcd_on:
            self._dcd_state[channel] = True
            self._update_dcd_led(channel, True)
            if self._dcd_after[channel]:
                self.window.after_cancel(self._dcd_after[channel])
            self._dcd_after[channel] = self.window.after(500, lambda c=channel: self._dcd_auto_clear(c))
        else:
            if self._dcd_after[channel]:
                self.window.after_cancel(self._dcd_after[channel])
                self._dcd_after[channel] = None
            self._dcd_state[channel] = False
            self._update_dcd_led(channel, False)

    def _dcd_auto_clear(self, channel: int):
        self._dcd_after[channel] = None
        self._dcd_state[channel] = False
        self._update_dcd_led(channel, False)

    def _handle_monitor(self, data: bytes):
        if len(data) < 7:
            return
        channel  = data[1]
        is_tx    = data[2] != 0
        text_len = struct.unpack('>I', data[3:7])[0]
        if len(data) < 7 + text_len:
            return
        text = data[7:7 + text_len].decode('utf-8', errors='replace').strip()
        if text:
            self._append_monitor_line(channel, is_tx, text)

    def _handle_log(self, data: bytes):
        if len(data) < 5:
            return
        line_len = struct.unpack('>I', data[1:5])[0]
        if len(data) < 5 + line_len:
            return
        text = data[5:5 + line_len].decode('utf-8', errors='replace')
        self._append_log_line(text)

    def _handle_server_error(self, msg: str):
        print(f'[SoundModem] backend error: {msg}')
        self._set_status(f'Error: {msg}', 'red')
        self._restore_binary_handler()
        self.running = False
        self._start_btn.config(text='Start', bg='#388E3C')
        self._set_config_inputs_enabled(True)

    # ── DCD LED helpers ───────────────────────────────────────────────────────

    def _update_dcd_led(self, channel: int, on: bool):
        lbl = self._dcd_labels[channel]
        lbl.config(fg=CH_COLORS[channel] if on else '#444444')

    # ── Monitor panel ─────────────────────────────────────────────────────────

    def _append_monitor_line(self, channel: int, is_tx: bool, text: str):
        ch_label  = CH_NAMES[channel] if channel < 4 else str(channel)
        time_str  = datetime.now().strftime('%H:%M:%S')
        direction = 'TX' if is_tx else 'RX'
        # Always buffer (keep last _monitor_max entries)
        self._monitor_buffer.append((ch_label, direction, time_str, text))
        if len(self._monitor_buffer) > self._monitor_max:
            self._monitor_buffer = self._monitor_buffer[-self._monitor_max:]
        # Write to window if open
        if self._monitor_text:
            line = f'[{time_str}] {ch_label} {direction}: {text}\n'
            self._monitor_text.config(state='normal')
            self._monitor_text.insert('end', line)
            self._monitor_lines += 1
            while self._monitor_lines > self._monitor_max:
                self._monitor_text.delete('1.0', '2.0')
                self._monitor_lines -= 1
            self._monitor_text.see('end')
            self._monitor_text.config(state='disabled')

    def _replay_monitor_buffer(self):
        """Write all buffered monitor lines into the (newly opened) window."""
        if not self._monitor_text:
            return
        self._monitor_text.config(state='normal')
        for ch_label, direction, time_str, text in self._monitor_buffer:
            self._monitor_text.insert('end', f'[{time_str}] {ch_label} {direction}: {text}\n')
        self._monitor_lines = len(self._monitor_buffer)
        self._monitor_text.see('end')
        self._monitor_text.config(state='disabled')

    # ── Process log panel ─────────────────────────────────────────────────────

    def _append_log_line(self, text: str):
        time_str = datetime.now().strftime('%H:%M:%S')
        # Always buffer (keep last _log_max entries)
        self._log_buffer.append((time_str, text.rstrip()))
        if len(self._log_buffer) > self._log_max:
            self._log_buffer = self._log_buffer[-self._log_max:]
        # Write to window if open
        if self._log_text:
            line = f'[{time_str}] {text.rstrip()}\n'
            self._log_text.config(state='normal')
            self._log_text.insert('end', line)
            self._log_lines += 1
            while self._log_lines > self._log_max:
                self._log_text.delete('1.0', '2.0')
                self._log_lines -= 1
            self._log_text.see('end')
            self._log_text.config(state='disabled')

    def _replay_log_buffer(self):
        """Write all buffered log lines into the (newly opened) window."""
        if not self._log_text:
            return
        self._log_text.config(state='normal')
        for time_str, text in self._log_buffer:
            self._log_text.insert('end', f'[{time_str}] {text}\n')
        self._log_lines = len(self._log_buffer)
        self._log_text.see('end')
        self._log_text.config(state='disabled')

    # ── Frame display ─────────────────────────────────────────────────────────

    def _display_frame(self, parsed: dict):
        if not VALID_CALL_RE.match(parsed.get('from', '')):
            return
        if not VALID_CALL_RE.match(parsed.get('to', '')):
            return

        ft        = parsed.get('frame_type', '')
        kiss_port = parsed.get('kiss_port', 0)
        css_type  = 'netrom' if ft in NETROM_TYPES else ft

        # Type filter
        ftype = self._filter_type_var.get()
        if ftype == 'aprs'      and ft != 'aprs':              return
        if ftype == 'ui'        and ft not in ('ui', 'aprs'):  return
        if ftype == 'connected' and ft not in CONNECTED_TYPES: return
        if ftype == 'netrom'    and ft not in NETROM_TYPES:    return
        if ftype == 'control'   and ft not in CONTROL_TYPES:   return
        if ftype == 'ip'        and ft not in ('ip', 'arp'):   return

        # Channel filter — dropdown uses A/B/C/D letters
        fch = self._filter_ch_var.get()
        if fch != 'all':
            ch_letter = CH_NAMES[kiss_port] if kiss_port < len(CH_NAMES) else str(kiss_port)
            if ch_letter != fch:
                return

        self.frame_count += 1
        self._count_var.set(str(self.frame_count))

        src = parsed.get('from', '')
        dst = parsed.get('to', '')

        # Track callsigns for dropdowns
        strip_star = lambda c: c.rstrip('*')
        prev = len(self._seen_callsigns)
        self._seen_callsigns.add(strip_star(src))
        for d in parsed.get('digipeaters', []):
            bare = strip_star(d)
            if not re.match(r'^(WIDE|RELAY|TRACE|GATE|TCPIP|NOGATE|RFONLY)', bare, re.I):
                self._seen_callsigns.add(bare)
        if len(self._seen_callsigns) != prev:
            self._update_callsign_dropdown()

        prev_d = len(self._seen_dests)
        if dst:
            self._seen_dests.add(dst)
        if len(self._seen_dests) != prev_d:
            self._update_dest_dropdown()

        self._last_call_var.set(src)
        self._last_frame_time = time.time()

        digi_str   = (' via ' + ','.join(parsed.get('digipeaters', []))) if parsed.get('digipeaters') else ''
        path_str   = f'{src}→{dst}{digi_str}'
        time_str   = datetime.now().strftime('%H:%M:%S')
        type_label = TYPE_LABELS.get(css_type, css_type.upper())

        payload = parsed.get('info', '')
        if parsed.get('netrom') and parsed['netrom'].get('raw'):
            payload += ' ' + parsed['netrom']['raw']

        self.copy_buffer.append(f'[{time_str}] {path_str}: {payload}')

        # Callsign / dest / search filters
        fcall = self._filter_call_var.get()
        if fcall and src.lower() != fcall.lower():
            return
        fdest = self._filter_dest_var.get()
        if fdest and dst.lower() != fdest.lower():
            return
        search = self._search_var.get().strip().lower()
        if search and search not in f'{path_str} {payload}'.lower():
            return

        tags = [f'ch{kiss_port}']
        if css_type == 'aprs':          tags.append('aprs')
        elif css_type == 'netrom':      tags.append('netrom')
        elif css_type in ('ip', 'arp'): tags.append('ip')

        ch_label = CH_NAMES[kiss_port] if kiss_port < 4 else str(kiss_port)
        self._tree.insert('', 0,
            values=(ch_label, time_str, path_str, type_label, payload),
            tags=tags)

        # Trim to max_frames
        children = self._tree.get_children()
        if self.max_frames > 0 and len(children) > self.max_frames:
            for old in children[self.max_frames:]:
                self._tree.delete(old)

    # ── Filtering ─────────────────────────────────────────────────────────────

    def _apply_filters(self):
        ftype  = self._filter_type_var.get()
        fch    = self._filter_ch_var.get()
        fcall  = self._filter_call_var.get().lower()
        fdest  = self._filter_dest_var.get().lower()
        search = self._search_var.get().strip().lower()

        # First reattach all previously detached items so we can re-evaluate them
        for iid in list(self._detached_iids):
            try:
                self._tree.reattach(iid, '', 'end')
            except Exception:
                pass
        self._detached_iids.clear()

        # Now evaluate all attached items
        for iid in list(self._tree.get_children('')):
            vals = self._tree.item(iid, 'values')
            if not vals or len(vals) < 5:
                continue
            ch_label, t_str, path, type_lbl, payload = vals

            show = True

            # Channel filter — fch is a letter (A/B/C/D), ch_label is also a letter
            if fch != 'all' and ch_label != fch:
                show = False

            if show and ftype != 'all':
                tl = type_lbl.lower()
                if   ftype == 'aprs'      and tl != 'aprs':                                                    show = False
                elif ftype == 'ui'        and tl not in ('ui', 'aprs'):                                        show = False
                elif ftype == 'connected' and tl not in ('i','rr','rnr','rej','srej','sabm','sabme','ua','disc','dm','frmr','xid','test'): show = False
                elif ftype == 'netrom'    and tl not in ('nr', 'nodes'):                                       show = False
                elif ftype == 'control'   and tl not in ('rr','rnr','rej','srej'):                             show = False
                elif ftype == 'ip'        and tl not in ('ip', 'arp'):                                        show = False

            if show and fcall:
                from_call = path.split('→')[0].lower() if '→' in path else ''
                if from_call != fcall:
                    show = False

            if show and fdest:
                to_part = path.split('→')[1].split(' ')[0].lower() if '→' in path else ''
                if to_part != fdest:
                    show = False

            if show and search and search not in f'{path} {payload}'.lower():
                show = False

            if not show:
                self._tree.detach(iid)
                self._detached_iids.append(iid)

    def _clear_filters(self):
        self._filter_call_var.set('')
        self._filter_dest_var.set('')
        self._search_var.set('')
        for iid in list(self._detached_iids):
            try:
                self._tree.reattach(iid, '', 'end')
            except Exception:
                pass
        self._detached_iids.clear()

    def _update_callsign_dropdown(self):
        current = self._filter_call_var.get()
        values = [''] + sorted(self._seen_callsigns)
        self._call_cb.config(values=values)
        if current in values:
            self._filter_call_var.set(current)

    def _update_dest_dropdown(self):
        current = self._filter_dest_var.get()
        values = [''] + sorted(self._seen_dests)
        self._dest_cb.config(values=values)
        if current in values:
            self._filter_dest_var.set(current)

    def _on_max_frames_change(self, event=None):
        val = self._max_frames_var.get()
        try:
            self.max_frames = int(val.split()[0])
        except ValueError:
            self.max_frames = 25

    # ── Clear / copy ──────────────────────────────────────────────────────────

    def _clear_output(self):
        self.frame_count = 0
        self.copy_buffer = []
        self._count_var.set('0')
        self._last_call_var.set('---')
        self._ago_var.set('')
        self._last_frame_time = None
        # Delete all items (attached and detached)
        for iid in list(self._tree.get_children()):
            self._tree.delete(iid)
        for iid in list(self._detached_iids):
            try:
                self._tree.delete(iid)
            except Exception:
                pass
        self._detached_iids.clear()

    def _copy_output(self):
        if not self.copy_buffer:
            return
        text = '\n'.join(self.copy_buffer)
        self.window.clipboard_clear()
        self.window.clipboard_append(text)
        self._set_status('Copied to clipboard', 'green')
        self.window.after(2000, lambda: self._set_status(
            'Running — listening for packets…' if self.running else 'Stopped'))

    # ── Status ────────────────────────────────────────────────────────────────

    def _set_status(self, text: str, color: str = 'gray'):
        self._status_var.set(text)

    # ── Frequency preset ──────────────────────────────────────────────────────

    def _on_freq_preset(self, event=None):
        label = self._freq_preset_var.get()
        for name, freq, mode in FREQ_PRESETS:
            if name == label and freq > 0:
                self._tune_to_frequency(freq, mode)
                break

    def _tune_to_frequency(self, freq_hz: int, mode: str):
        try:
            rc = self.radio_control
            if not rc:
                return
            if hasattr(rc, 'set_frequency_hz'):
                rc.set_frequency_hz(freq_hz)
            # Use select_mode + apply_frequency(skip_auto_mode=True) to prevent
            # the main UI from overriding the mode back to LSB (same as FT8 extension)
            if hasattr(rc, 'select_mode'):
                rc.select_mode(mode or 'usb')
            elif hasattr(rc, 'set_mode'):
                rc.set_mode(mode or 'usb')
            if hasattr(rc, 'apply_frequency') and getattr(rc, 'connected', False):
                rc.apply_frequency(skip_auto_mode=True)
        except Exception as e:
            print(f'[SoundModem] tune error: {e}')

    # ── "Time ago" display ────────────────────────────────────────────────────

    def _format_ago(self, seconds: float) -> str:
        s = int(seconds)
        if s < 60:
            return f'{s}s ago'
        m, r = divmod(s, 60)
        if m < 60:
            return (f'{m}m{r}s ago' if r else f'{m}m ago')
        h, rm = divmod(m, 60)
        return (f'{h}h{rm}m ago' if rm else f'{h}h ago')

    def _start_ago_loop(self):
        self._update_ago()
        if self.window.winfo_exists():
            self.window.after(1000, self._start_ago_loop)

    def _update_ago(self):
        if self._last_frame_time:
            self._ago_var.set(self._format_ago(time.time() - self._last_frame_time))
        else:
            self._ago_var.set('')

    # ── Waterfall ─────────────────────────────────────────────────────────────

    def _on_wf_resize(self, event):
        w = event.width
        if w > 10 and w != self._wf_width:
            self._wf_width = w
            self._wf_pixels = None
            self._draw_wf_header()

    def _on_wf_mouse_move(self, event):
        self._wf_mouse_x = event.x

    def _on_wf_mouse_leave(self, event):
        self._wf_mouse_x = None

    def _draw_wf_header(self):
        if not hasattr(self, '_wf_hdr'):
            return
        canvas = self._wf_hdr
        w = canvas.winfo_width()
        h = canvas.winfo_height()
        if w <= 1:
            return
        canvas.delete('all')
        max_freq = self._wf_max_freq

        canvas.create_rectangle(0, 0, w, h, fill='#1a1a1a', outline='')

        # Major ticks every 500 Hz
        for f in range(0, max_freq + 1, 500):
            x = int((f / max_freq) * w)
            canvas.create_line(x, h - 6, x, h, fill='#cccccc')
            if 0 < f < max_freq:
                label = f'{f // 1000}k' if f >= 1000 else str(f)
                canvas.create_text(x, h - 8, text=label, fill='white',
                                   font=('Courier', 7), anchor='s')

        # Minor ticks every 100 Hz
        for f in range(100, max_freq, 100):
            if f % 500 == 0:
                continue
            x = int((f / max_freq) * w)
            canvas.create_line(x, h - 3, x, h, fill='#666666')

        # Channel markers
        for i, ch in enumerate(self._wf_channel_freqs):
            if not ch.get('enabled') or ch.get('freq', 0) <= 0:
                continue
            modem = ch.get('modem', 1)
            freq  = ch['freq']
            shift = (RX_SHIFT[modem] if modem < len(RX_SHIFT) else 1000) / 2
            x_ctr = int((freq / max_freq) * w)
            x_lo  = int(((freq - shift) / max_freq) * w)
            x_hi  = int(((freq + shift) / max_freq) * w)
            color = CH_COLORS[i]

            # Tkinter doesn't support alpha in hex colours — use stipple for transparency
            canvas.create_rectangle(x_lo, 0, x_hi, h, fill=color, outline='', stipple='gray25')
            canvas.create_line(x_ctr, 0, x_ctr, h, fill=color, width=2)
            bar_y = h // 2
            cap_h = int(h * 0.4)
            canvas.create_line(x_lo, bar_y - cap_h, x_lo, bar_y + cap_h, fill=color)
            canvas.create_line(x_hi, bar_y - cap_h, x_hi, bar_y + cap_h, fill=color)
            canvas.create_text(x_ctr + 3, 2, text=CH_NAMES[i], fill=color,
                               font=('Courier', 7, 'bold'), anchor='nw')

    def _start_waterfall_loop(self):
        if self.window.winfo_exists():
            self._update_waterfall()
            self.window.after(self._wf_line_ms, self._start_waterfall_loop)

    def _update_waterfall(self):
        """Pull spectrum data from audio_spectrum_display and draw one waterfall line."""
        if not NUMPY_AVAILABLE or not PIL_AVAILABLE:
            return
        try:
            rc = self.radio_control
            if not rc:
                return
            if not hasattr(rc, 'audio_spectrum_display'):
                return
            if not rc.audio_spectrum_display:
                return
            if rc.audio_spectrum_display.spectrum_data is None:
                return

            spectrum    = rc.audio_spectrum_display.spectrum_data
            sample_rate = getattr(rc.audio_spectrum_display, 'sample_rate', 48000)
            nyquist     = sample_rate / 2
            n_bins      = len(spectrum)

            canvas = self._wf_canvas
            w = canvas.winfo_width()
            h = canvas.winfo_height()
            if w <= 1 or h <= 1:
                return

            max_freq = self._wf_max_freq

            # Build one row of RGB pixels using numpy (fast)
            px_freqs  = np.linspace(0, max_freq, w, endpoint=False)
            bin_idxs  = np.clip((px_freqs / nyquist * n_bins).astype(int), 0, n_bins - 1)
            db_row    = np.array(spectrum)[bin_idxs].astype(float)
            db_row    = np.where(np.isfinite(db_row), db_row, -120.0)
            # Map dB to 0-255: -120 dB → 0, -20 dB → 255
            vals      = np.clip((db_row + 120) * 255 / 100, 0, 255).astype(np.uint8)

            # Vectorised colour map
            row_rgb = np.zeros((w, 3), dtype=np.uint8)
            m0 = vals < 64
            m1 = (vals >= 64)  & (vals < 128)
            m2 = (vals >= 128) & (vals < 192)
            m3 = vals >= 192
            # black → blue
            row_rgb[m0, 2] = vals[m0] * 4
            # blue → cyan
            row_rgb[m1, 1] = (vals[m1] - 64) * 4
            row_rgb[m1, 2] = 255
            # cyan → green → yellow
            row_rgb[m2, 0] = (vals[m2] - 128) * 4
            row_rgb[m2, 1] = 255
            row_rgb[m2, 2] = 255 - (vals[m2] - 128) * 4
            # yellow → red
            row_rgb[m3, 0] = 255
            row_rgb[m3, 1] = 255 - (vals[m3] - 192) * 4

            # Maintain scrolling pixel buffer (numpy array: h × w × 3)
            if (self._wf_pixels is None or
                    not isinstance(self._wf_pixels, np.ndarray) or
                    self._wf_pixels.shape[1] != w):
                self._wf_pixels = np.zeros((h, w, 3), dtype=np.uint8)

            # Scroll down by 1 row, insert new row at top
            self._wf_pixels[1:] = self._wf_pixels[:-1]
            self._wf_pixels[0]  = row_rgb

            # Render via PIL ImageTk (fast, same as AudioSpectrumDisplay)
            img_pil = Image.fromarray(self._wf_pixels, 'RGB')
            img_tk  = ImageTk.PhotoImage(img_pil)

            canvas.delete('all')
            canvas.create_image(0, 0, anchor='nw', image=img_tk)
            canvas._wf_img = img_tk   # prevent GC

            # Channel overlay lines on top
            for i, ch in enumerate(self._wf_channel_freqs):
                if not ch.get('enabled') or ch.get('freq', 0) <= 0:
                    continue
                freq  = ch['freq']
                modem = ch.get('modem', 1)
                shift = (RX_SHIFT[modem] if modem < len(RX_SHIFT) else 1000) / 2
                x_ctr = int((freq / max_freq) * w)
                x_lo  = int(((freq - shift) / max_freq) * w)
                x_hi  = int(((freq + shift) / max_freq) * w)
                color = CH_COLORS[i]
                canvas.create_line(x_lo,  0, x_lo,  h, fill=color, width=1)
                canvas.create_line(x_hi,  0, x_hi,  h, fill=color, width=1)
                canvas.create_line(x_ctr, 0, x_ctr, h, fill=color, width=2, dash=(6, 3))

            # ── Mouse crosshair + frequency tooltip ───────────────────────────
            mx = self._wf_mouse_x
            if mx is not None and 0 <= mx < w:
                # Audio frequency at cursor
                audio_hz = round((mx / w) * max_freq)

                # RF frequency = dial frequency + audio offset (USB convention)
                rf_label = ''
                try:
                    rc2 = self.radio_control
                    if rc2 and hasattr(rc2, 'get_frequency_hz'):
                        dial_hz = rc2.get_frequency_hz()
                        if dial_hz and dial_hz > 0:
                            rf_hz = dial_hz + audio_hz
                            if rf_hz >= 1_000_000:
                                rf_label = f' | {rf_hz / 1_000_000:.4f} MHz'
                            else:
                                rf_label = f' | {rf_hz / 1_000:.3f} kHz'
                except Exception:
                    pass

                label = f'{audio_hz} Hz{rf_label}'

                # Vertical dashed crosshair line
                canvas.create_line(mx, 0, mx, h,
                                   fill='white', width=1, dash=(3, 3))

                # Tooltip box (dark background, white text) — flip left near right edge
                font = ('Courier', 9, 'bold')
                pad_x, pad_y = 4, 3
                # Estimate text width (monospace: ~7px per char)
                text_w = len(label) * 7
                box_w  = text_w + pad_x * 2
                box_h  = 16
                bx = mx + 6 if mx + 6 + box_w <= w else mx - box_w - 6
                by = 4
                canvas.create_rectangle(bx, by, bx + box_w, by + box_h,
                                        fill='#000000', outline='', stipple='')
                canvas.create_text(bx + pad_x, by + pad_y,
                                   text=label, fill='white',
                                   font=font, anchor='nw')

        except Exception as e:
            import traceback
            print(f'[SoundModem] waterfall error: {e}\n{traceback.format_exc()}')

    # ── Window close ──────────────────────────────────────────────────────────

    def on_closing(self):
        if self.running:
            self._stop_decoder()
        # Close child windows
        for win in (self._monitor_win, self._log_win):
            try:
                if win and win.winfo_exists():
                    win.destroy()
            except Exception:
                pass
        self.window.destroy()


# ── Factory function ──────────────────────────────────────────────────────────

def create_soundmodem_window(parent: tk.Tk, dxcluster_ws, radio_control) -> SoundModemExtension:
    """Create and return a SoundModemExtension window."""
    return SoundModemExtension(parent, dxcluster_ws, radio_control)