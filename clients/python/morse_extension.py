#!/usr/bin/env python3
"""
CW (Morse) Decoder Extension Window for Python Radio Client.

Mirrors the JavaScript frontend extension at static/extensions/morse/main.js.

Binary wire protocol (backend → frontend):

  0x10  Decode event
        [type:1=0x10][confidence:1][cost:4 f32 BE][pitch:4 f32 BE][speed:4 f32 BE]
        [text_len:4 uint32 BE][text: UTF-8]
        confidence byte: 0=high  1=medium  2=low  3=poor

  0x11  Stats event (pitch/speed update, no text)
        [type:1=0x11][pitch:4 f32 BE][speed:4 f32 BE]

  0x12  Error event (subprocess crash or binary not found)
        [type:1=0x12][msg_len:4 uint32 BE][msg: UTF-8]

JSON messages from the backend that are also handled:
  audio_extension_attached  — server confirmed attach
  audio_extension_error     — server-side error before binary data starts
"""

import json
import struct
import tkinter as tk
from datetime import datetime
from tkinter import filedialog, messagebox, scrolledtext, ttk
from typing import Optional


# Confidence byte → human-readable label
# Colours match styles.css exactly:
#   .morse-conf-value[data-conf="high"]   { color: #00ff88; }
#   .morse-conf-value[data-conf="medium"] { color: #e0e040; }
#   .morse-conf-value[data-conf="low"]    { color: #ff9020; }
#   .morse-conf-value[data-conf="poor"]   { color: #ff4444; }
_CONF_LABEL = {0: 'High', 1: 'Medium', 2: 'Low', 3: 'Poor'}
_CONF_COLOUR = {
    'High':   '#00ff88',
    'Medium': '#e0e040',
    'Low':    '#ff9020',
    'Poor':   '#ff4444',
}

# Text tag colours for the output widget (match .conf-* CSS classes)
_CONF_TAG_COLOUR = {
    'high':   '#00ff88',
    'medium': '#e0e040',
    'low':    '#ff9020',
    'poor':   '#ff4444',
    'error':  '#ff4444',
}

# Minimum-quality filter ranks (same logic as the JS frontend)
# Dropdown options: All | Low+ | Medium+ | High  (values: all | low | medium | high)
_QUALITY_RANK = {'all': 0, 'low': 1, 'medium': 2, 'high': 3}
_CONF_RANK    = {'poor': 0, 'low': 1, 'medium': 2, 'high': 3}

# CW frequency presets (label, frequency_hz, mode)
_CW_PRESETS = [
    # 160 m
    ('1.810 MHz CWL (160m)',  1810000, 'cwl'),
    ('1.836 MHz CWL (160m)',  1836000, 'cwl'),
    # 80 m
    ('3.500 MHz CWL (80m)',   3500000, 'cwl'),
    ('3.560 MHz CWL (80m)',   3560000, 'cwl'),
    # 40 m
    ('7.000 MHz CWL (40m)',   7000000, 'cwl'),
    ('7.030 MHz CWL (40m)',   7030000, 'cwl'),
    # 30 m
    ('10.106 MHz CWU (30m)', 10106000, 'cwu'),
    ('10.116 MHz CWU (30m)', 10116000, 'cwu'),
    # 20 m
    ('14.000 MHz CWU (20m)', 14000000, 'cwu'),
    ('14.025 MHz CWU (20m)', 14025000, 'cwu'),
    # 17 m
    ('18.068 MHz CWU (17m)', 18068000, 'cwu'),
    # 15 m
    ('21.000 MHz CWU (15m)', 21000000, 'cwu'),
    ('21.025 MHz CWU (15m)', 21025000, 'cwu'),
    # 12 m
    ('24.892 MHz CWU (12m)', 24892000, 'cwu'),
    # 10 m
    ('28.000 MHz CWU (10m)', 28000000, 'cwu'),
    ('28.050 MHz CWU (10m)', 28050000, 'cwu'),
]


class MorseExtension:
    """CW (Morse) decoder extension window."""

    def __init__(self, parent: tk.Tk, dxcluster_ws, radio_control):
        """
        Initialise the CW decoder extension window.

        Args:
            parent:        Parent Tk window.
            dxcluster_ws:  DXClusterWebSocket instance (shared connection).
            radio_control: RadioGUI instance used for frequency / mode tuning.
        """
        self.parent = parent
        self.dxcluster_ws = dxcluster_ws
        self.radio_control = radio_control

        # Runtime state
        self.running: bool = False
        self.text_buffer: str = ''
        self.char_count: int = 0
        self.auto_scroll: bool = True
        self.min_quality: str = 'all'   # filter: all | low | medium | high

        # Current stats (updated by 0x10 / 0x11 frames)
        self.last_pitch: Optional[float] = None
        self.last_speed: Optional[float] = None
        self.last_conf:  Optional[str]   = None

        # WebSocket handler interception
        self.original_ws_handler = None

        # Build window
        self.window = tk.Toplevel(parent)
        self.window.title('📻 CW Decoder')
        self.window.geometry('900x680')
        self.window.protocol('WM_DELETE_WINDOW', self._on_closing)

        self._create_widgets()

    # ── Widget construction ───────────────────────────────────────────────────

    def _create_widgets(self):
        """Build the full UI."""
        main = ttk.Frame(self.window, padding=10)
        main.grid(row=0, column=0, sticky='nsew')
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)

        # ── Quick-tune row ────────────────────────────────────────────────────
        tune_frame = ttk.LabelFrame(main, text='Quick Tune', padding=8)
        tune_frame.grid(row=0, column=0, sticky='ew', pady=(0, 8))
        tune_frame.columnconfigure(1, weight=1)

        ttk.Label(tune_frame, text='Preset:').grid(row=0, column=0, sticky='w', padx=(0, 6))
        self._preset_var = tk.StringVar()
        preset_values = ['-- Select preset --'] + [p[0] for p in _CW_PRESETS]
        self._preset_combo = ttk.Combobox(tune_frame, textvariable=self._preset_var,
                                          values=preset_values, state='readonly', width=40)
        self._preset_combo.current(0)
        self._preset_combo.grid(row=0, column=1, sticky='ew', padx=(0, 8))
        self._preset_combo.bind('<<ComboboxSelected>>', lambda _e: self._tune_preset())

        ttk.Button(tune_frame, text='Tune', command=self._tune_preset).grid(row=0, column=2)

        # ── Status / control row ──────────────────────────────────────────────
        ctrl_frame = ttk.Frame(main)
        ctrl_frame.grid(row=1, column=0, sticky='ew', pady=(0, 8))

        # Status badge
        self._status_label = ttk.Label(ctrl_frame, text='Stopped',
                                       background='gray', foreground='white',
                                       padding=(6, 2), relief='raised')
        self._status_label.pack(side='left', padx=(0, 10))

        # Stats: pitch / speed / quality
        stats_frame = ttk.Frame(ctrl_frame)
        stats_frame.pack(side='left', padx=(0, 20))

        ttk.Label(stats_frame, text='Pitch:').grid(row=0, column=0, sticky='w')
        self._pitch_label = ttk.Label(stats_frame, text='---', width=6, anchor='e')
        self._pitch_label.grid(row=0, column=1, sticky='w', padx=(2, 10))
        ttk.Label(stats_frame, text='Hz').grid(row=0, column=2, sticky='w', padx=(0, 16))

        ttk.Label(stats_frame, text='Speed:').grid(row=0, column=3, sticky='w')
        self._speed_label = ttk.Label(stats_frame, text='---', width=6, anchor='e')
        self._speed_label.grid(row=0, column=4, sticky='w', padx=(2, 10))
        ttk.Label(stats_frame, text='WPM').grid(row=0, column=5, sticky='w', padx=(0, 16))

        ttk.Label(stats_frame, text='Quality:').grid(row=0, column=6, sticky='w')
        self._conf_label = ttk.Label(stats_frame, text='---', width=8, anchor='w')
        self._conf_label.grid(row=0, column=7, sticky='w', padx=(2, 0))

        # Char count
        self._char_count_label = ttk.Label(ctrl_frame, text='Chars: 0')
        self._char_count_label.pack(side='left', padx=(0, 20))

        # Buttons (right-aligned)
        btn_frame = ttk.Frame(ctrl_frame)
        btn_frame.pack(side='right')

        self._start_btn = ttk.Button(btn_frame, text='Start', command=self._start_decoder)
        self._start_btn.pack(side='left', padx=(0, 4))

        self._stop_btn = ttk.Button(btn_frame, text='Stop', command=self._stop_decoder,
                                    state='disabled')
        self._stop_btn.pack(side='left')

        # ── Options row ───────────────────────────────────────────────────────
        opt_frame = ttk.LabelFrame(main, text='Options', padding=8)
        opt_frame.grid(row=2, column=0, sticky='ew', pady=(0, 8))
        opt_frame.columnconfigure(5, weight=1)  # spacer column pushes buttons right

        ttk.Label(opt_frame, text='Min quality:').grid(row=0, column=0, sticky='w', padx=(0, 6))
        # Labels match template.html <select id="morse-min-quality"> options exactly:
        #   All | Low+ | Medium+ | High   (internal values: all | low | medium | high)
        self._quality_var = tk.StringVar(value='All')
        self._quality_display_to_value = {
            'All':     'all',
            'Low+':    'low',
            'Medium+': 'medium',
            'High':    'high',
        }
        quality_combo = ttk.Combobox(opt_frame, textvariable=self._quality_var,
                                     values=['All', 'Low+', 'Medium+', 'High'],
                                     state='readonly', width=10)
        quality_combo.grid(row=0, column=1, sticky='w', padx=(0, 20))
        quality_combo.bind('<<ComboboxSelected>>', lambda _e: self._on_quality_changed())

        self._auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(opt_frame, text='Auto-scroll',
                        variable=self._auto_scroll_var).grid(row=0, column=2, sticky='w', padx=(0, 20))

        ttk.Label(opt_frame, text='Font size:').grid(row=0, column=3, sticky='w', padx=(0, 6))
        self._font_size_var = tk.StringVar(value='11')
        font_combo = ttk.Combobox(opt_frame, textvariable=self._font_size_var,
                                  values=['9', '10', '11', '12', '14', '16'],
                                  state='readonly', width=5)
        font_combo.grid(row=0, column=4, sticky='w')
        font_combo.bind('<<ComboboxSelected>>', lambda _e: self._on_font_size_changed())

        # Clear / Copy / Save buttons on the far right of the Options row
        ttk.Button(opt_frame, text='Clear', command=self._clear_output).grid(
            row=0, column=6, sticky='e', padx=(0, 4))
        ttk.Button(opt_frame, text='Copy',  command=self._copy_output).grid(
            row=0, column=7, sticky='e', padx=(0, 4))
        ttk.Button(opt_frame, text='Save',  command=self._save_text).grid(
            row=0, column=8, sticky='e')

        # ── Text output ───────────────────────────────────────────────────────
        out_frame = ttk.LabelFrame(main, text='Decoded Text', padding=5)
        out_frame.grid(row=3, column=0, sticky='nsew', pady=(0, 8))
        main.rowconfigure(3, weight=1)
        main.columnconfigure(0, weight=1)

        self._output = scrolledtext.ScrolledText(
            out_frame, wrap='word',
            font=('Courier New', 11),
            bg='#1a1a1a', fg='#e0e0e0',   # matches .morse-output-area background / color
            insertbackground='white',
            height=20,
        )
        self._output.pack(fill='both', expand=True)

        # Configure confidence colour tags — exact hex values from styles.css:
        #   .conf-high   { color: #00ff88; }
        #   .conf-medium { color: #e0e040; }
        #   .conf-low    { color: #ff9020; }
        #   .conf-poor   { color: #ff4444; opacity: 0.7; }
        for conf_key, colour in _CONF_TAG_COLOUR.items():
            font_opts = {}
            if conf_key == 'error':
                font_opts = {'font': ('Courier New', 11, 'bold')}
            self._output.tag_configure(f'conf-{conf_key}', foreground=colour, **font_opts)

        # ── Help text ─────────────────────────────────────────────────────────
        help_frame = ttk.LabelFrame(main, text='Help', padding=8)
        help_frame.grid(row=4, column=0, sticky='ew')

        help_text = (
            'CW Decoder — powered by ggmorse (cw-decoder subprocess). '
            'Tune to a CW frequency in USB/CWU or LSB/CWL mode, then click Start. '
            'The decoder auto-detects pitch (400–700 Hz) and speed. '
            'Use "Min quality" to filter out poor-confidence decodes. '
            'Text colour: green = high, yellow = medium, orange = low, red = poor.'
        )
        ttk.Label(help_frame, text=help_text, wraplength=860, justify='left').pack()

    # ── Decoder lifecycle ─────────────────────────────────────────────────────

    def _start_decoder(self):
        """Attach to the morse audio extension and start decoding."""
        if self.running:
            return

        if not self.dxcluster_ws or not self.dxcluster_ws.is_connected():
            messagebox.showerror('Error', 'WebSocket not connected.\n'
                                          'Please connect to the server first.')
            return

        try:
            # Install binary handler BEFORE sending attach so we don't miss the
            # audio_extension_attached confirmation.
            self._install_binary_handler()

            attach_msg = {
                'type': 'audio_extension_attach',
                'extension_name': 'morse',
                'params': {},
            }
            self.dxcluster_ws.ws.send(json.dumps(attach_msg))

            self.running = True
            self._set_status('Connecting…', 'blue')
            self._start_btn.config(state='disabled')
            self._stop_btn.config(state='normal')
            print('[Morse] decoder started')

        except Exception as exc:
            self._restore_binary_handler()
            messagebox.showerror('Error', f'Failed to start decoder: {exc}')
            print(f'[Morse] start error: {exc}')

    def _stop_decoder(self):
        """Detach from the morse audio extension."""
        if not self.running:
            return

        try:
            if self.dxcluster_ws and hasattr(self.dxcluster_ws, 'ws'):
                self.dxcluster_ws.ws.send(json.dumps({'type': 'audio_extension_detach'}))
        except Exception as exc:
            print(f'[Morse] detach send error: {exc}')

        self._restore_binary_handler()
        self.running = False
        self._set_status('Stopped', 'gray')
        self._clear_stats()
        self._start_btn.config(state='normal')
        self._stop_btn.config(state='disabled')
        print('[Morse] decoder stopped')

    # ── WebSocket binary interception ─────────────────────────────────────────

    def _install_binary_handler(self):
        """Replace the WebSocket on_message handler to intercept binary frames."""
        if not hasattr(self.dxcluster_ws, 'ws'):
            return

        # Save original handler only once
        if self.original_ws_handler is None:
            self.original_ws_handler = getattr(self.dxcluster_ws.ws, 'on_message', None)

        def _handler(ws, message):
            if isinstance(message, bytes):
                # Schedule on the Tk main thread to avoid cross-thread widget updates
                self.window.after(0, lambda: self._handle_binary(message))
            else:
                # Text (JSON) — check for audio extension messages we care about
                try:
                    msg = json.loads(message)
                    mtype = msg.get('type', '')
                    if mtype == 'audio_extension_attached':
                        self.window.after(0, lambda: self._set_status('Running — listening for CW…', 'green'))
                        return
                    if mtype == 'audio_extension_error':
                        err = msg.get('error', 'Unknown server error')
                        self.window.after(0, lambda e=err: self._handle_server_error(e))
                        return
                except (json.JSONDecodeError, Exception):
                    pass
                # Pass everything else to the original handler
                if self.original_ws_handler:
                    self.original_ws_handler(ws, message)

        self.dxcluster_ws.ws.on_message = _handler

    def _restore_binary_handler(self):
        """Restore the original WebSocket on_message handler."""
        if self.original_ws_handler is not None and hasattr(self.dxcluster_ws, 'ws'):
            self.dxcluster_ws.ws.on_message = self.original_ws_handler
        self.original_ws_handler = None

    # ── Binary message parsing ────────────────────────────────────────────────

    def _handle_binary(self, data: bytes):
        """Dispatch a binary frame by its type byte."""
        if len(data) < 1:
            return

        msg_type = data[0]

        if msg_type == 0x10:
            self._handle_decode(data)
        elif msg_type == 0x11:
            self._handle_stats(data)
        elif msg_type == 0x12:
            self._handle_binary_error(data)
        else:
            print(f'[Morse] unknown binary message type: 0x{msg_type:02x}')

    def _handle_decode(self, data: bytes):
        """
        0x10 decode event:
        [type:1][confidence:1][cost:4 f32 BE][pitch:4 f32 BE][speed:4 f32 BE]
        [text_len:4 uint32 BE][text: UTF-8]
        """
        if len(data) < 18:
            return

        conf_byte = data[1]
        cost,  = struct.unpack('>f', data[2:6])
        pitch, = struct.unpack('>f', data[6:10])
        speed, = struct.unpack('>f', data[10:14])
        text_len, = struct.unpack('>I', data[14:18])

        if len(data) < 18 + text_len:
            return

        text = data[18:18 + text_len].decode('utf-8', errors='replace')

        conf_name  = _CONF_LABEL.get(conf_byte, 'Poor')   # e.g. 'High'
        conf_lower = conf_name.lower()                     # e.g. 'high'

        self._update_stats(pitch, speed, conf_name)
        self._append_text(text, conf_lower)

    def _handle_stats(self, data: bytes):
        """
        0x11 stats event (pitch/speed update, no text):
        [type:1][pitch:4 f32 BE][speed:4 f32 BE]
        """
        if len(data) < 9:
            return

        pitch, = struct.unpack('>f', data[1:5])
        speed, = struct.unpack('>f', data[5:9])
        self._update_stats(pitch, speed, conf=None)

    def _handle_binary_error(self, data: bytes):
        """
        0x12 error event (subprocess crash / binary not found):
        [type:1][msg_len:4 uint32 BE][msg: UTF-8]
        """
        if len(data) < 5:
            return

        msg_len, = struct.unpack('>I', data[1:5])
        if len(data) < 5 + msg_len:
            return

        msg = data[5:5 + msg_len].decode('utf-8', errors='replace')
        self._handle_server_error(msg)

    def _handle_server_error(self, msg: str):
        """Common handler for both binary 0x12 and JSON audio_extension_error."""
        print(f'[Morse] backend error: {msg}')
        self._set_status(f'Error: {msg}', 'red')
        self._append_text(f'\n[ERROR] {msg}\n', 'error')

        # Subprocess is gone — clean up
        self._restore_binary_handler()
        self.running = False
        self._clear_stats()
        self._start_btn.config(state='normal')
        self._stop_btn.config(state='disabled')

    # ── UI helpers ────────────────────────────────────────────────────────────

    def _append_text(self, text: str, conf: str):
        """Append decoded text to the output widget with confidence colouring.

        conf is lowercase: 'high' | 'medium' | 'low' | 'poor' | 'error'
        self.min_quality is the internal value: 'all' | 'low' | 'medium' | 'high'
        """
        # Quality filter — use self.min_quality (internal value) not the display label
        min_rank = _QUALITY_RANK.get(self.min_quality, 0)
        if conf != 'error' and _CONF_RANK.get(conf, 0) < min_rank:
            return

        tag = f'conf-{conf}'
        self._output.insert('end', text, tag)
        self.text_buffer += text
        self.char_count += len(text)
        self._char_count_label.config(text=f'Chars: {self.char_count}')

        if self._auto_scroll_var.get():
            self._output.see('end')

    def _update_stats(self, pitch: float, speed: float, conf: Optional[str]):
        """Update the pitch / speed / quality stat labels."""
        self.last_pitch = pitch
        self.last_speed = speed

        self._pitch_label.config(text=f'{pitch:.0f}')
        self._speed_label.config(text=f'{speed:.1f}')

        # Only update quality when a real confidence value is provided.
        # Stats-only events (0x11) pass conf=None and must not clear the last
        # decode's quality indicator.
        # conf is the display label e.g. 'High' — look up colour by that key.
        if conf is not None:
            self.last_conf = conf
            colour = _CONF_COLOUR.get(conf, '#ffffff')
            self._conf_label.config(text=conf, foreground=colour)

    def _clear_stats(self):
        """Reset all stat labels to '---'."""
        self._pitch_label.config(text='---')
        self._speed_label.config(text='---')
        self._conf_label.config(text='---', foreground='')
        self.last_pitch = None
        self.last_speed = None
        self.last_conf  = None

    def _set_status(self, text: str, colour: str = 'gray'):
        """Update the status badge."""
        bg_map = {
            'green': '#28a745',
            'blue':  '#007bff',
            'red':   '#dc3545',
            'gray':  '#6c757d',
        }
        bg = bg_map.get(colour, colour)
        self._status_label.config(text=text, background=bg)

    def _clear_output(self):
        """Clear the text output area."""
        self._output.delete('1.0', 'end')
        self.text_buffer = ''
        self.char_count = 0
        self._char_count_label.config(text='Chars: 0')

    def _copy_output(self):
        """Copy decoded text to the clipboard."""
        if not self.text_buffer:
            return
        self.window.clipboard_clear()
        self.window.clipboard_append(self.text_buffer)
        self._set_status('Copied to clipboard', 'blue')
        self.window.after(2000, lambda: self._set_status(
            'Running — listening for CW…' if self.running else 'Stopped',
            'green' if self.running else 'gray'
        ))

    def _save_text(self):
        """Save decoded text to a file."""
        if not self.text_buffer:
            messagebox.showinfo('Info', 'No text to save.')
            return

        ts = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
        filename = filedialog.asksaveasfilename(
            defaultextension='.txt',
            initialfile=f'cw_decode_{ts}.txt',
            filetypes=[('Text files', '*.txt'), ('All files', '*.*')],
        )
        if filename:
            try:
                with open(filename, 'w', encoding='utf-8') as fh:
                    fh.write(self.text_buffer)
                messagebox.showinfo('Saved', f'Text saved to:\n{filename}')
            except Exception as exc:
                messagebox.showerror('Error', f'Failed to save: {exc}')

    def _on_quality_changed(self):
        """Handle min-quality combobox change.

        The combobox shows display labels ('All', 'Low+', 'Medium+', 'High').
        Translate to the internal value ('all', 'low', 'medium', 'high') used
        by the filter rank lookup.
        """
        display = self._quality_var.get()
        self.min_quality = self._quality_display_to_value.get(display, 'all')

    def _on_font_size_changed(self):
        """Handle font-size combobox change."""
        try:
            size = int(self._font_size_var.get())
            self._output.config(font=('Courier New', size))
        except ValueError:
            pass

    # ── Quick-tune ────────────────────────────────────────────────────────────

    def _tune_preset(self):
        """Tune the radio to the selected CW preset."""
        selected = self._preset_var.get()
        if not selected or selected.startswith('--'):
            return

        # Find matching preset
        for label, freq_hz, mode in _CW_PRESETS:
            if label == selected:
                self._tune_to(freq_hz, mode)
                return

    def _tune_to(self, freq_hz: int, mode: str):
        """Tune the radio to freq_hz in the given mode."""
        if not self.radio_control:
            print(f'[Morse] no radio_control — would tune to {freq_hz} Hz {mode}')
            return

        try:
            # Check we're not in IQ mode
            current_mode = self.radio_control.mode_var.get().upper()
            if current_mode.startswith('IQ'):
                print(f'[Morse] cannot tune in IQ mode ({current_mode})')
                return

            self.radio_control.set_frequency_hz(freq_hz)

            if not self.radio_control.mode_lock_var.get():
                self.radio_control.mode_var.set(mode.upper())
                self.radio_control.on_mode_changed()

            if self.radio_control.connected:
                self.radio_control.apply_frequency()

            print(f'[Morse] tuned to {freq_hz / 1e6:.4f} MHz {mode.upper()}')

        except Exception as exc:
            print(f'[Morse] tune error: {exc}')

    # ── Window lifecycle ──────────────────────────────────────────────────────

    def _on_closing(self):
        """Handle window close — stop decoder cleanly first."""
        if self.running:
            self._stop_decoder()
        self.window.destroy()


# ── Factory function ──────────────────────────────────────────────────────────

def create_morse_window(parent: tk.Tk, dxcluster_ws, radio_control) -> MorseExtension:
    """
    Create and return a CW decoder extension window.

    Args:
        parent:        Parent Tk window.
        dxcluster_ws:  Shared DXClusterWebSocket instance.
        radio_control: RadioGUI instance for frequency / mode control.

    Returns:
        MorseExtension instance (window is already visible).
    """
    return MorseExtension(parent, dxcluster_ws, radio_control)
