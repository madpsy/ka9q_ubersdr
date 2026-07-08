"""
DX Cluster Terminal Window for ka9q_ubersdr Python Client

Double-click any DX spot line to tune the radio to that frequency.
Mode is determined by:
  - If the comment contains "WPM" → CWL (< 10 MHz) or CWU (≥ 10 MHz)
  - Otherwise                     → LSB (< 10 MHz) or USB (≥ 10 MHz)

Provides a Tkinter terminal window that connects to the DX Cluster addon's
WebSocket terminal endpoint at /addon/dxcluster/api/terminal.

The protocol is plain text over WebSocket — identical to the web UI's
terminal.js modal:
  - On open: wait for a line containing "callsign", then send CALLSIGN\r\n
  - Receive: append text to scrollback (max 2000 lines)
  - Send: user types a command, press Enter → send line + "\r\n"
  - Disconnect: send "bye\r\n" then close the WebSocket

Optional local telnet listener (default port 7300):
  - Listens on 0.0.0.0:<port> when enabled
  - Each telnet client receives all WebSocket output (same as the GUI output)
  - Each telnet client can send commands (forwarded to the WebSocket)
  - Stopped automatically when the window closes or WebSocket disconnects
"""

import re
import socket
import socketserver
import threading
import tkinter as tk
from tkinter import ttk
import sys

try:
    import websocket  # websocket-client
    WEBSOCKET_AVAILABLE = True
except ImportError:
    WEBSOCKET_AVAILABLE = False

SCROLLBACK_LIMIT = 2000  # max lines kept in the output widget


class DXClusterTerminalWindow:
    """
    Tkinter Toplevel window providing a DX Cluster telnet terminal over WebSocket.

    Mirrors the web UI terminal modal (index.html / terminal.js):
      - Login row: callsign entry + Connect button (shown when disconnected)
      - Output area: scrolled text, 2000-line scrollback
      - Input row: prompt + entry + Send button (shown when connected)
      - Header: title, status label, Disconnect button, Close button

    Also provides an optional local telnet listener that bridges external
    telnet clients to the same WebSocket session.
    """

    def __init__(self, parent: tk.Tk, ws_url: str, radio_gui=None):
        """
        Args:
            parent:    Parent Tk window.
            ws_url:    Full WebSocket URL, e.g.
                       ws://host:port/addon/dxcluster/api/terminal
            radio_gui: Optional reference to RadioGUI for double-click tuning
                       and settings persistence.
        """
        self.parent = parent
        self.ws_url = ws_url
        self.radio_gui = radio_gui

        self._ws = None               # websocket.WebSocketApp instance
        self._ws_thread = None        # background thread running ws.run_forever()
        self._connected = False
        self._callsign_sent = False
        self._pending_callsign = ''

        # Local telnet listener state
        self._telnet_server = None        # socketserver.TCPServer instance
        self._telnet_server_thread = None # daemon thread running serve_forever()
        self._telnet_clients = set()      # set of active _TelnetClientHandler instances
        self._telnet_clients_lock = threading.Lock()

        # Load persisted settings before building the window
        saved_callsign, saved_autoconnect = self._load_settings()

        self._build_window(saved_callsign, saved_autoconnect)

        # Auto-connect if both callsign and auto-connect flag are set
        if saved_autoconnect and saved_callsign:
            self.window.after(200, self._connect)

    # ── Settings persistence ───────────────────────────────────────────────

    def _load_settings(self):
        """Return (callsign, autoconnect) from radio_gui's saved settings."""
        if not self.radio_gui:
            return '', False
        callsign = getattr(self.radio_gui, '_dxcluster_callsign', '') or ''
        autoconnect = getattr(self.radio_gui, '_dxcluster_autoconnect', False)
        return callsign, bool(autoconnect)

    def _save_settings(self):
        """Persist current callsign and auto-connect flag to radio_gui's settings file."""
        if not self.radio_gui:
            return
        self.radio_gui._dxcluster_callsign = self._callsign_var.get().strip().upper()
        self.radio_gui._dxcluster_autoconnect = self._autoconnect_var.get()
        # Piggyback on the existing save mechanism
        try:
            self.radio_gui.save_servers()
        except Exception:
            pass

    # ── Window construction ────────────────────────────────────────────────

    def _build_window(self, saved_callsign: str = '', saved_autoconnect: bool = False):
        self.window = tk.Toplevel(self.parent)
        self.window.title("📡 DX Cluster Terminal")
        self.window.geometry("800x580")
        self.window.minsize(600, 420)
        self.window.protocol("WM_DELETE_WINDOW", self._on_close)

        # ── Header row ────────────────────────────────────────────────────
        hdr = ttk.Frame(self.window, padding=(8, 6))
        hdr.pack(side=tk.TOP, fill=tk.X)

        ttk.Label(hdr, text="🖥 Web Terminal", font=('TkDefaultFont', 10, 'bold')).pack(side=tk.LEFT)

        self._status_var = tk.StringVar(value="Not connected")
        self._status_lbl = ttk.Label(hdr, textvariable=self._status_var, foreground='gray')
        self._status_lbl.pack(side=tk.LEFT, padx=(12, 0))

        self._disconnect_btn = ttk.Button(hdr, text="Disconnect", command=self._disconnect)
        self._disconnect_btn.pack(side=tk.RIGHT, padx=(5, 0))
        self._disconnect_btn.pack_forget()  # hidden until connected

        ttk.Button(hdr, text="✕", width=3, command=self._on_close).pack(side=tk.RIGHT)

        # Auto-connect checkbox — saved to settings
        self._autoconnect_var = tk.BooleanVar(value=saved_autoconnect)
        ttk.Checkbutton(
            hdr, text="Auto-connect",
            variable=self._autoconnect_var,
            command=self._save_settings,
        ).pack(side=tk.RIGHT, padx=(0, 8))

        ttk.Separator(self.window, orient=tk.HORIZONTAL).pack(side=tk.TOP, fill=tk.X)

        # ── Local telnet listener row ──────────────────────────────────────
        telnet_row = ttk.Frame(self.window, padding=(8, 4))
        telnet_row.pack(side=tk.TOP, fill=tk.X)

        self._telnet_enabled_var = tk.BooleanVar(value=False)
        self._telnet_check = ttk.Checkbutton(
            telnet_row, text="Telnet",
            variable=self._telnet_enabled_var,
            command=self._on_telnet_toggle
        )
        self._telnet_check.pack(side=tk.LEFT)

        ttk.Label(telnet_row, text="Port:").pack(side=tk.LEFT, padx=(10, 4))
        self._telnet_port_var = tk.StringVar(value="7300")
        self._telnet_port_entry = ttk.Entry(
            telnet_row, textvariable=self._telnet_port_var, width=6
        )
        self._telnet_port_entry.pack(side=tk.LEFT)

        self._telnet_status_var = tk.StringVar(value="")
        self._telnet_status_lbl = ttk.Label(
            telnet_row, textvariable=self._telnet_status_var, foreground='gray'
        )
        self._telnet_status_lbl.pack(side=tk.LEFT, padx=(10, 0))

        ttk.Separator(self.window, orient=tk.HORIZONTAL).pack(side=tk.TOP, fill=tk.X)

        # ── Login row (shown when disconnected) — packed at BOTTOM ────────
        self._login_frame = ttk.Frame(self.window, padding=(8, 6))
        self._login_frame.pack(side=tk.BOTTOM, fill=tk.X)

        ttk.Label(self._login_frame, text="Callsign:").pack(side=tk.LEFT)

        self._callsign_var = tk.StringVar(value=saved_callsign)
        self._callsign_entry = ttk.Entry(
            self._login_frame, textvariable=self._callsign_var,
            width=12, font=('TkFixedFont', 10)
        )
        self._callsign_entry.pack(side=tk.LEFT, padx=(6, 6))
        self._callsign_entry.bind('<Return>', lambda _e: self._connect())

        # Force uppercase as the user types
        def _force_upper(*_):
            v = self._callsign_var.get()
            upper = v.upper()
            if v != upper:
                self._callsign_var.set(upper)
        self._callsign_var.trace_add('write', _force_upper)

        self._connect_btn = ttk.Button(self._login_frame, text="Connect", command=self._connect)
        self._connect_btn.pack(side=tk.LEFT)

        # ── Input row (shown when connected) — packed at BOTTOM ───────────
        self._input_frame = ttk.Frame(self.window, padding=(8, 6))
        # Not packed yet — shown on connect (replaces login_frame at bottom)

        ttk.Label(self._input_frame, text=">", font=('TkFixedFont', 10)).pack(side=tk.LEFT)

        self._input_var = tk.StringVar()
        self._input_entry = ttk.Entry(
            self._input_frame, textvariable=self._input_var,
            font=('TkFixedFont', 10)
        )
        self._input_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(6, 6))
        self._input_entry.bind('<Return>', lambda _e: self._send_input())
        self._input_entry.bind('<Escape>', lambda _e: self._on_close())

        ttk.Button(self._input_frame, text="Send", command=self._send_input).pack(side=tk.LEFT)

        # ── Terminal output — fills remaining space in the middle ──────────
        out_frame = ttk.Frame(self.window)
        out_frame.pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=8, pady=(4, 4))

        self._output = tk.Text(
            out_frame,
            state='disabled',
            wrap=tk.WORD,
            bg='#0d0d0d',
            fg='#e0e0e0',
            insertbackground='white',
            font=('TkFixedFont', 9),
            relief=tk.FLAT,
            borderwidth=0,
        )
        scrollbar = ttk.Scrollbar(out_frame, orient=tk.VERTICAL, command=self._output.yview)
        self._output.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self._output.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Tag for clickable DX spot lines
        self._output.tag_configure('dx_spot', foreground='#7ec8e3')
        # Change cursor to hand2 when hovering over a spot line
        self._output.tag_bind('dx_spot', '<Enter>',
                              lambda _e: self._output.config(cursor='hand2'))
        self._output.tag_bind('dx_spot', '<Leave>',
                              lambda _e: self._output.config(cursor=''))
        # Bind double-click directly on the widget — tag_bind for Double-Button-1
        # is unreliable in Tkinter because the first Button-1 of the double-click
        # fires first and can move the insertion cursor away from the tag before
        # the double fires.
        self._output.bind('<Double-Button-1>', self._on_output_double_click)

        # Focus callsign entry on open
        self._callsign_entry.focus_set()

    # ── UI state helpers ───────────────────────────────────────────────────

    def _set_connected(self, state: bool):
        """Switch UI between login (disconnected) and input (connected) states."""
        self._connected = state
        if state:
            self._login_frame.pack_forget()
            self._input_frame.pack(side=tk.BOTTOM, fill=tk.X)
            self._disconnect_btn.pack(side=tk.RIGHT, padx=(5, 0))
            self._connect_btn.config(state='disabled')
            self._input_entry.focus_set()
        else:
            self._input_frame.pack_forget()
            self._login_frame.pack(side=tk.BOTTOM, fill=tk.X)
            self._disconnect_btn.pack_forget()
            self._connect_btn.config(state='normal')
            self._callsign_entry.focus_set()
            # Stop telnet listener when WebSocket disconnects
            self._stop_telnet_server()

    def _set_status(self, msg: str, colour: str = 'gray'):
        self._status_var.set(msg)
        self._status_lbl.configure(foreground=colour)

    def _append_output(self, text: str):
        """Append text to the terminal output, enforcing the 2000-line scrollback.

        Lines that look like DX spots are tagged 'dx_spot' so they can be
        double-clicked to tune the radio.
        """
        self._output.config(state='normal')

        # Normalise line endings: \r\n → \n, lone \r → \n
        normalised = text.replace('\r\n', '\n').replace('\r', '\n')

        # Check each line for DX spot pattern and tag accordingly
        for line in normalised.splitlines(keepends=True):
            start_idx = self._output.index(tk.END)
            self._output.insert(tk.END, line)
            if self._parse_spot_line(line.rstrip('\n')) is not None:
                end_idx = self._output.index(tk.END)
                self._output.tag_add('dx_spot', start_idx, end_idx)

        # Trim to SCROLLBACK_LIMIT lines
        line_count = int(self._output.index('end-1c').split('.')[0])
        if line_count > SCROLLBACK_LIMIT:
            excess = line_count - SCROLLBACK_LIMIT
            self._output.delete('1.0', f'{excess + 1}.0')

        self._output.see(tk.END)
        self._output.config(state='disabled')

    # ── Spot parsing & tuning ──────────────────────────────────────────────

    @staticmethod
    def _parse_spot_line(line: str):
        """Parse a DX cluster spot line and return (freq_hz, mode) or None.

        Expected format:
            DX de <spotter>:  <freq_khz>  <dx_call>  <comment>  <time>Z

        Mode rules:
          - 'WPM' in comment → CWL (< 10 MHz) or CWU (≥ 10 MHz)
          - otherwise        → LSB (< 10 MHz) or USB (≥ 10 MHz)
        """
        m = re.match(r'^DX de \S+\s+([\d.]+)\s+(\S+)\s*(.*)', line)
        if not m:
            return None
        try:
            freq_khz = float(m.group(1))
        except ValueError:
            return None
        freq_hz = int(freq_khz * 1000)
        comment = m.group(3)
        is_cw = 'WPM' in comment
        if is_cw:
            mode = 'CWL' if freq_hz < 10_000_000 else 'CWU'
        else:
            mode = 'LSB' if freq_hz < 10_000_000 else 'USB'
        return freq_hz, mode

    def _on_output_double_click(self, event):
        """Double-click handler: parse the spot line under the cursor and tune.

        Always returns 'break' to suppress Tkinter's default word-selection
        behaviour on double-click.
        """
        # Suppress default word-selection on every double-click in the terminal
        self._output.tag_remove('sel', '1.0', tk.END)

        if not self.radio_gui:
            return 'break'

        # Identify the line index under the pointer
        idx = self._output.index(f'@{event.x},{event.y}')
        line_num = idx.split('.')[0]
        line_text = self._output.get(f'{line_num}.0', f'{line_num}.end').strip()

        result = self._parse_spot_line(line_text)
        if result is None:
            return 'break'

        freq_hz, mode = result

        # Don't tune if current mode is IQ
        current_mode = self.radio_gui.mode_var.get().upper()
        if current_mode.startswith('IQ'):
            return 'break'

        # Apply frequency
        self.radio_gui.set_frequency_hz(freq_hz)

        # Apply mode if not locked
        if not self.radio_gui.mode_lock_var.get():
            self.radio_gui.mode_var.set(mode)
            self.radio_gui.on_mode_changed()

        # Send tune message if connected
        if self.radio_gui.connected:
            self.radio_gui.apply_frequency()

        return 'break'

    # ── WebSocket connection ───────────────────────────────────────────────

    def _connect(self):
        if not WEBSOCKET_AVAILABLE:
            self._set_status("websocket-client not installed", 'red')
            return

        callsign = self._callsign_var.get().strip().upper()
        if not callsign:
            self._set_status("Enter your callsign first", 'red')
            self._callsign_entry.focus_set()
            return

        # Persist callsign (and auto-connect flag) to settings
        self._save_settings()

        self._pending_callsign = callsign
        self._callsign_sent = False
        self._set_status("Connecting…", 'orange')
        self._connect_btn.config(state='disabled')

        # Clear output on new connection
        self._output.config(state='normal')
        self._output.delete('1.0', tk.END)
        self._output.config(state='disabled')

        self._ws = websocket.WebSocketApp(
            self.ws_url,
            on_open=self._on_ws_open,
            on_message=self._on_ws_message,
            on_close=self._on_ws_close,
            on_error=self._on_ws_error,
        )

        self._ws_thread = threading.Thread(
            target=self._ws.run_forever,
            kwargs={'ping_interval': 30, 'ping_timeout': 10},
            daemon=True,
        )
        self._ws_thread.start()

    def _disconnect(self):
        """User-initiated disconnect: send bye then close."""
        if self._ws:
            try:
                self._ws.send('bye\r\n')
            except Exception:
                pass
            try:
                self._ws.close()
            except Exception:
                pass
        self._ws = None
        # UI update happens in _on_ws_close

    # ── Send ───────────────────────────────────────────────────────────────

    def _send_to_ws(self, line: str):
        """Send a line to the WebSocket (used by both GUI input and telnet clients)."""
        if not self._ws:
            return
        try:
            self._ws.send(line + '\r\n')
        except Exception as e:
            self._append_output(f'[send error: {e}]\n')

    def _send_input(self):
        if not self._connected or not self._ws:
            return
        line = self._input_var.get()
        # Echo locally (same as terminal.js)
        self._append_output(f'> {line}\n')
        self._send_to_ws(line)
        self._input_var.set('')

    # ── WebSocket callbacks (run in WS thread — schedule UI via after()) ───

    def _on_ws_open(self, ws):
        self.window.after(0, lambda: self._set_status("Connected", 'green'))
        self.window.after(0, lambda: self._set_connected(True))

    def _on_ws_message(self, ws, message: str):
        # Auto-respond to callsign prompt (same logic as terminal.js:111)
        if not self._callsign_sent and 'callsign' in message.lower():
            self._callsign_sent = True
            try:
                ws.send(self._pending_callsign + '\r\n')
            except Exception:
                pass

        # Broadcast to all connected telnet clients
        self._broadcast_to_telnet(message)

        # Schedule UI append on main thread
        text = message
        self.window.after(0, lambda t=text: self._append_output(t))

    def _on_ws_close(self, ws, close_status_code, close_msg):
        self._ws = None
        self._callsign_sent = False

        def _ui_update():
            self._set_connected(False)
            if close_status_code and close_status_code != 1000:
                self._set_status(f"Connection lost (code {close_status_code})", 'red')
            else:
                self._set_status("Disconnected", 'gray')

        try:
            self.window.after(0, _ui_update)
        except Exception:
            pass  # window may have been destroyed

    def _on_ws_error(self, ws, error):
        print(f"[DXClusterTerminal] WebSocket error: {error}", file=sys.stderr)
        try:
            self.window.after(0, lambda: self._set_status("WebSocket error", 'red'))
        except Exception:
            pass

    # ── Local telnet listener ──────────────────────────────────────────────

    def _on_telnet_toggle(self):
        """Called when the Local Telnet Listener checkbox is toggled."""
        if self._telnet_enabled_var.get():
            self._start_telnet_server()
        else:
            self._stop_telnet_server()

    def _start_telnet_server(self):
        """Start the local TCP telnet listener."""
        port_str = self._telnet_port_var.get().strip()
        try:
            port = int(port_str)
            if not (1 <= port <= 65535):
                raise ValueError("out of range")
        except ValueError:
            self._telnet_status_var.set("Invalid port")
            self._telnet_status_lbl.configure(foreground='red')
            self._telnet_enabled_var.set(False)
            return

        # Build a handler that has a reference back to this window
        terminal_window = self

        def _update_client_count():
            """Update the telnet status label with current client count (call from any thread)."""
            with terminal_window._telnet_clients_lock:
                n = len(terminal_window._telnet_clients)
            label = f"Listening on 0.0.0.0:{port}  —  {n} client{'s' if n != 1 else ''} connected"
            try:
                terminal_window.window.after(
                    0,
                    lambda lbl=label: terminal_window._telnet_status_var.set(lbl)
                )
            except Exception:
                pass

        class _Handler(socketserver.BaseRequestHandler):
            def setup(self):
                self.request.settimeout(1.0)
                with terminal_window._telnet_clients_lock:
                    terminal_window._telnet_clients.add(self)
                _update_client_count()

            def handle(self):
                buf = b''
                while True:
                    # Check if WebSocket is still alive
                    if not terminal_window._connected:
                        try:
                            self.request.sendall(b'\r\n[DX Cluster WebSocket not connected]\r\n')
                        except Exception:
                            pass
                        break
                    try:
                        chunk = self.request.recv(256)
                    except socket.timeout:
                        continue
                    except Exception:
                        break
                    if not chunk:
                        break
                    buf += chunk
                    # Process complete lines
                    while b'\n' in buf or b'\r' in buf:
                        for sep in (b'\r\n', b'\n', b'\r'):
                            idx = buf.find(sep)
                            if idx != -1:
                                line_bytes = buf[:idx]
                                buf = buf[idx + len(sep):]
                                line = line_bytes.decode('utf-8', errors='replace').strip()
                                if line:
                                    # Echo back to this client
                                    try:
                                        self.request.sendall(f'> {line}\r\n'.encode('utf-8'))
                                    except Exception:
                                        pass
                                    # Forward to WebSocket
                                    terminal_window._send_to_ws(line)
                                    # Also echo in the GUI output
                                    terminal_window.window.after(
                                        0,
                                        lambda l=line: terminal_window._append_output(f'[telnet] > {l}\n')
                                    )
                                break

            def finish(self):
                with terminal_window._telnet_clients_lock:
                    terminal_window._telnet_clients.discard(self)
                _update_client_count()

        class _Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        try:
            self._telnet_server = _Server(('0.0.0.0', port), _Handler)
        except OSError as e:
            self._telnet_status_var.set(f"Error: {e}")
            self._telnet_status_lbl.configure(foreground='red')
            self._telnet_enabled_var.set(False)
            return

        self._telnet_server_thread = threading.Thread(
            target=self._telnet_server.serve_forever,
            daemon=True,
        )
        self._telnet_server_thread.start()

        self._telnet_port_entry.config(state='disabled')
        self._telnet_status_var.set(f"Listening on 0.0.0.0:{port}")
        self._telnet_status_lbl.configure(foreground='green')
        print(f"[DXClusterTerminal] Local telnet listener started on 0.0.0.0:{port}", file=sys.stderr)

    def _stop_telnet_server(self):
        """Stop the local TCP telnet listener and disconnect all clients."""
        if self._telnet_server:
            # Disconnect all active clients by closing their sockets
            with self._telnet_clients_lock:
                for handler in list(self._telnet_clients):
                    try:
                        handler.request.shutdown(socket.SHUT_RDWR)
                        handler.request.close()
                    except Exception:
                        pass
                self._telnet_clients.clear()

            self._telnet_server.shutdown()
            self._telnet_server = None
            self._telnet_server_thread = None
            print("[DXClusterTerminal] Local telnet listener stopped", file=sys.stderr)

        try:
            self._telnet_port_entry.config(state='normal')
            self._telnet_enabled_var.set(False)
            self._telnet_status_var.set("")
        except Exception:
            pass  # window may be closing

    def _broadcast_to_telnet(self, text: str):
        """Send text to all connected telnet clients."""
        data = text.encode('utf-8', errors='replace')
        with self._telnet_clients_lock:
            for handler in list(self._telnet_clients):
                try:
                    handler.request.sendall(data)
                except Exception:
                    pass

    # ── Window close ───────────────────────────────────────────────────────

    def _on_close(self):
        """Called when the window X button is clicked."""
        self._stop_telnet_server()
        self._disconnect()
        try:
            self.window.destroy()
        except Exception:
            pass

    def is_open(self) -> bool:
        """Return True if the window still exists."""
        try:
            return self.window.winfo_exists()
        except Exception:
            return False

    def lift(self):
        """Bring the window to the front."""
        try:
            self.window.lift()
            self.window.focus_force()
        except Exception:
            pass
