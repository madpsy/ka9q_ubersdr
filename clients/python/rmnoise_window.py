#!/usr/bin/env python3
"""
rmnoise_window.py - RMNoise configuration and status window for the radio client.

Provides a Tkinter window for:
  - Username / password entry (saved to config)
  - AI filter (model) selection
  - Real-time jitter buffer depth and latency statistics
  - Enable / disable toggle that feeds audio through rmnoise_denoise.RMNoiseClient
"""

import asyncio
import queue
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox
from typing import Optional, Callable
from math import gcd
import numpy as np

try:
    from scipy.signal import resample_poly as _scipy_resample_poly
    _SCIPY_RESAMPLE = True
except ImportError:
    _SCIPY_RESAMPLE = False

# ── Optional dependency check ──────────────────────────────────────────────────
# We use RMNoiseClient for WebRTC signalling, and pack_frame/unpack_frame for
# the 8 kHz wire protocol.  All resampling (input_sample_rate ↔ 8 kHz) is done
# here directly — we do NOT use rmnoise_denoise's downsample/upsample helpers
# (those assume 48 kHz input which is not what the radio client provides).
try:
    from rmnoise_denoise import (
        RMNoiseClient,
        pack_frame, unpack_frame,
    )
    RMNOISE_AVAILABLE = True
except ImportError:
    RMNOISE_AVAILABLE = False


# ── RMNoise audio bridge ───────────────────────────────────────────────────────

def _resample_direct(arr: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """
    Resample a 1-D float32 array directly from from_rate to to_rate using
    scipy resample_poly (polyphase, anti-aliased).  Falls back to nearest-
    neighbour if scipy is unavailable.
    """
    if from_rate == to_rate:
        return arr
    g = gcd(from_rate, to_rate)
    up, down = to_rate // g, from_rate // g
    if _SCIPY_RESAMPLE:
        return _scipy_resample_poly(arr.astype(np.float64), up, down).astype(np.float32)
    # Nearest-neighbour fallback
    n_out = max(1, int(round(len(arr) * to_rate / from_rate)))
    indices = np.round(np.linspace(0, len(arr) - 1, n_out)).astype(np.int32)
    return arr[indices].astype(np.float32)


class RMNoiseBridge:
    """
    Runs the RMNoise WebRTC client in a background asyncio thread.

    Usage:
        bridge = RMNoiseBridge(username, password, filter_number=1,
                               input_sample_rate=12000)
        bridge.start()                          # blocks until data channel open
        denoised = bridge.process(pcm_float32)  # mono float32 at input_sample_rate
        bridge.stop()

    All resampling is done directly between input_sample_rate and 8 kHz
    (the RMNoise wire rate) — no intermediate 48 kHz step.
    """

    _RM_RATE = 8000   # RMNoise protocol sample rate
    _FRAME_8K = 384   # 64 ms at 8 kHz (matches FRAME_SIZE_8K in rmnoise_denoise.py)

    def __init__(self, username: str, password: str, filter_number: int = 1,
                 stats_callback: Optional[Callable] = None,
                 input_sample_rate: int = 12000):
        self.username = username
        self.password = password
        self.stats_callback = stats_callback  # called with (jitter_depth, latency_ms)
        self.input_sample_rate = input_sample_rate

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._client: Optional[object] = None  # RMNoiseClient
        self._filter_number: int = filter_number  # set before property setter is used
        self._jbuf: Optional[object] = None    # JitterBuffer (stores 8 kHz float32 frames)
        self._send_q: queue.Queue = queue.Queue(maxsize=16)
        self._frame_num: int = 0
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._error: Optional[str] = None

        # Latency tracking
        self._send_times: dict = {}   # frame_num -> send_time
        self._last_latency_ms: float = 0.0
        self._last_stats_update: float = 0.0

        # Accumulation buffer: collect input-rate samples until we have enough
        # to fill one 8 kHz frame (FRAME_8K samples after downsampling).
        self._accum: np.ndarray = np.zeros(0, dtype=np.float32)
        # Number of input-rate samples that correspond to one 8 kHz frame:
        #   e.g. 12000 Hz → 384 * 12000/8000 = 576 samples
        #        24000 Hz → 384 * 24000/8000 = 1152 samples
        # Use round() not // to avoid systematic 1-sample drift that causes
        # the trim/pad on the send path to introduce a discontinuity every frame.
        self._accum_target = round(self._FRAME_8K * input_sample_rate / self._RM_RATE)

        # Output accumulation: denoised 8 kHz samples waiting to be resampled back
        self._out_accum_8k: np.ndarray = np.zeros(0, dtype=np.float32)

    # ── Public API ─────────────────────────────────────────────────────────────

    def start(self, timeout: float = 20.0) -> bool:
        """Start the bridge. Returns True if data channel opened within timeout."""
        if not RMNOISE_AVAILABLE:
            self._error = "rmnoise_denoise module not available (missing dependencies)"
            return False

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True,
                                        name="RMNoiseBridge")
        self._thread.start()
        ok = self._ready.wait(timeout=timeout)
        if not ok:
            self._error = "Timed out waiting for RMNoise data channel"
            self._stop.set()
        return ok

    def stop(self):
        """Stop the bridge cleanly."""
        self._stop.set()
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._async_stop(), self._loop)
        if self._thread:
            self._thread.join(timeout=5)

    def process(self, audio_float: np.ndarray) -> np.ndarray:
        """
        Feed a mono float32 frame at *input_sample_rate* into the bridge and
        return the denoised frame at the same rate.

        Pipeline (all resampling is direct, no intermediate 48 kHz step):
          input_sample_rate → 8 kHz  (resample, then send to RMNoise)
          8 kHz             → input_sample_rate  (resample received frames back)

        If the bridge is not ready or the jitter buffer has no data yet,
        the original audio is returned unchanged.
        """
        if not self._ready.is_set() or self._client is None:
            return audio_float

        n_in = len(audio_float)

        # ── Send path: accumulate → resample to 8 kHz → send ─────────────────
        self._accum = np.concatenate((self._accum, audio_float))

        while len(self._accum) >= self._accum_target:
            chunk_in = self._accum[:self._accum_target]
            self._accum = self._accum[self._accum_target:]

            try:
                # Resample directly from input_sample_rate to 8 kHz
                pcm8k_f32 = _resample_direct(chunk_in, self.input_sample_rate, self._RM_RATE)
                # Trim/pad to exactly FRAME_8K samples
                if len(pcm8k_f32) > self._FRAME_8K:
                    pcm8k_f32 = pcm8k_f32[:self._FRAME_8K]
                elif len(pcm8k_f32) < self._FRAME_8K:
                    pcm8k_f32 = np.pad(pcm8k_f32, (0, self._FRAME_8K - len(pcm8k_f32)))

                max_abs = float(np.max(np.abs(pcm8k_f32)))
                scale = min(int(32767.0 / max_abs), 4294967295) if max_abs > 1e-9 else 1
                pcm8k_i16 = np.clip(pcm8k_f32 * scale, -32768, 32767).astype(np.int16)

                ts_ms = int(time.time() * 1000)
                frame = pack_frame(self._frame_num, ts_ms, pcm8k_i16, scale)

                self._send_times[self._frame_num] = time.time()
                if len(self._send_times) > 300:
                    del self._send_times[min(self._send_times)]

                if self._loop and self._loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        self._async_send(frame), self._loop)

                self._frame_num += 1
            except Exception as e:
                print(f"[RMNoise] Send error: {e}")

        # ── Receive path: drain 8 kHz queue → resample to input_sample_rate ──
        # Drain all available 8 kHz frames into our output accumulator
        if self._jbuf:
            while True:
                try:
                    frame_8k = self._jbuf.get_nowait()
                    self._out_accum_8k = np.concatenate((self._out_accum_8k, frame_8k))
                except queue.Empty:
                    break

        # How many 8 kHz samples do we need to cover n_in input samples?
        n_8k_needed = int(np.ceil(n_in * self._RM_RATE / self.input_sample_rate))

        if len(self._out_accum_8k) >= n_8k_needed:
            chunk_8k = self._out_accum_8k[:n_8k_needed]
            self._out_accum_8k = self._out_accum_8k[n_8k_needed:]

            # Resample from 8 kHz back to input_sample_rate
            out = _resample_direct(chunk_8k, self._RM_RATE, self.input_sample_rate)

            # Trim or zero-pad to exactly n_in samples
            if len(out) >= n_in:
                return out[:n_in].astype(np.float32)
            else:
                result = np.zeros(n_in, dtype=np.float32)
                result[:len(out)] = out
                return result

        # Not enough denoised data yet – return silence to avoid abrupt
        # switches between denoised and original audio (which cause clicks).
        return np.zeros(n_in, dtype=np.float32)

    def update_sample_rate(self, new_rate: int):
        """
        Called when the server changes its sample rate (e.g. FM 12k→24k).
        Flushes the accumulation buffers and recalculates the frame target so
        the next process() call uses the correct resampling ratio.
        """
        if new_rate == self.input_sample_rate:
            return
        self.input_sample_rate = new_rate
        # Recalculate how many input-rate samples equal one 8 kHz frame
        self._accum_target = round(self._FRAME_8K * new_rate / self._RM_RATE)
        # Flush stale data from both accumulation buffers
        self._accum = np.zeros(0, dtype=np.float32)
        self._out_accum_8k = np.zeros(0, dtype=np.float32)

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    @property
    def error(self) -> Optional[str]:
        return self._error

    @property
    def jitter_depth(self) -> int:
        return self._jbuf.qsize() if self._jbuf else 0

    @property
    def latency_ms(self) -> float:
        return self._last_latency_ms

    @property
    def filter_number(self) -> int:
        return self._filter_number

    @filter_number.setter
    def filter_number(self, value: int):
        self._filter_number = value
        # If already connected, send filter selection
        if self._client and self._loop and self._loop.is_running():
            import json
            asyncio.run_coroutine_threadsafe(
                self._client.ws.send(json.dumps({
                    'type': 'ai_filter_selection',
                    'filterNumber': value
                })),
                self._loop
            )

    @property
    def available_filters(self) -> list:
        if self._client:
            return getattr(self._client, 'available_filters', [])
        return []

    # ── Internal asyncio methods ───────────────────────────────────────────────

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._async_main())
        except Exception as e:
            self._error = str(e)
        finally:
            self._loop.close()

    async def _async_main(self):
        # Use a simple queue of 8 kHz float32 arrays instead of JitterBuffer.
        # JitterBuffer is designed for 48 kHz playback; we handle resampling
        # ourselves in process() so we only need raw 8 kHz frames here.
        self._jbuf = queue.Queue(maxsize=256)
        self._client = RMNoiseClient(
            self.username, self.password,
            filter_number=self._filter_number
        )

        try:
            await self._client.start()
        except Exception as e:
            self._error = f"RMNoise connection failed: {e}"
            return

        # Wire server audio → 8 kHz queue
        @self._client.data_channel.on("message")
        def _on_server(data):
            try:
                fn, _ts, sc, pcm8k = unpack_frame(data)
                # Undo the audioScale normalisation → float32 in [-1, 1]
                s = float(sc) if sc > 0 else 32767.0
                pcm8k_f32 = pcm8k.astype(np.float32) / s

                # Measure latency
                if fn in self._send_times:
                    lat = (time.time() - self._send_times.pop(fn)) * 1000
                    self._last_latency_ms = lat

                if self._jbuf.full():
                    try:
                        self._jbuf.get_nowait()  # drop oldest to make room
                    except queue.Empty:
                        pass
                try:
                    self._jbuf.put_nowait(pcm8k_f32)
                except queue.Full:
                    pass

                # Emit stats every 500 ms
                now = time.time()
                if self.stats_callback and now - self._last_stats_update >= 0.5:
                    self._last_stats_update = now
                    self.stats_callback(self._jbuf.qsize(), self._last_latency_ms)
            except Exception as e:
                print(f"[RMNoise] Server audio error: {e}")

        self._ready.set()

        # Keep running until stop requested
        while not self._stop.is_set():
            await asyncio.sleep(0.1)

        await self._client.stop()

    async def _async_send(self, frame: bytes):
        if self._client:
            self._client.send(frame)

    async def _async_stop(self):
        self._stop.set()


# ── Tkinter window ─────────────────────────────────────────────────────────────

class RMNoiseWindow:
    """
    Configuration and status window for RMNoise denoising.

    Parameters
    ----------
    parent : tk.Tk or tk.Toplevel
        Parent window.
    config : dict
        Shared config dict (read/write).  Keys used:
          'rmnoise_username', 'rmnoise_password', 'rmnoise_filter'
    on_enable_change : callable(enabled: bool, bridge: RMNoiseBridge | None)
        Called when the user enables/disables RM denoising.
    on_save : callable()
        Called when credentials/settings are saved so the parent can
        persist them to disk.
    """

    def __init__(self, parent, config: dict,
                 on_enable_change: Optional[Callable] = None,
                 on_save: Optional[Callable] = None,
                 input_sample_rate: int = 12000):
        self.parent = parent
        self.config = config
        self.on_enable_change = on_enable_change
        self.on_save = on_save
        self.input_sample_rate = input_sample_rate  # current server sample rate

        self.bridge: Optional[RMNoiseBridge] = None
        self._stats_update_job = None

        self.window = tk.Toplevel(parent)
        self.window.title("RMNoise Denoising")
        self.window.geometry("600x520")
        self.window.resizable(True, False)
        self.window.protocol("WM_DELETE_WINDOW", self._on_close)

        self._build_ui()
        self._load_config()

        # Start stats polling
        self._poll_stats()

    # ── UI construction ────────────────────────────────────────────────────────

    def _build_ui(self):
        pad = {"padx": 10, "pady": 5}

        # ── Credentials frame ──────────────────────────────────────────────────
        cred_frame = ttk.LabelFrame(self.window, text="Credentials (rmnoise.com)", padding=10)
        cred_frame.pack(fill=tk.X, padx=10, pady=(10, 5))

        ttk.Label(cred_frame, text="Username:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.username_var = tk.StringVar()
        ttk.Entry(cred_frame, textvariable=self.username_var, width=30).grid(
            row=0, column=1, sticky=tk.W, padx=(0, 10))

        ttk.Label(cred_frame, text="Password:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))
        self.password_var = tk.StringVar()
        ttk.Entry(cred_frame, textvariable=self.password_var, show="•", width=30).grid(
            row=1, column=1, sticky=tk.W, padx=(0, 10), pady=(5, 0))

        self.save_btn = ttk.Button(cred_frame, text="Save Credentials",
                                   command=self._save_credentials)
        self.save_btn.grid(row=0, column=2, rowspan=2, padx=(10, 0), sticky=tk.NS)

        # Registration note with clickable link
        reg_frame = ttk.Frame(cred_frame)
        reg_frame.grid(row=2, column=0, columnspan=3, sticky=tk.W, pady=(8, 0))
        ttk.Label(reg_frame, text="An account is required — ",
                  foreground='gray').pack(side=tk.LEFT)
        link = ttk.Label(reg_frame, text="Register",
                         foreground='#0066cc', cursor='hand2')
        link.pack(side=tk.LEFT)
        link.bind("<Button-1>", lambda e: self._open_registration_url())

        # ── Filter / model frame ───────────────────────────────────────────────
        filter_frame = ttk.LabelFrame(self.window, text="AI Filter (Model)", padding=10)
        filter_frame.pack(fill=tk.X, padx=10, pady=5)

        ttk.Label(filter_frame, text="Filter:").pack(side=tk.LEFT, padx=(0, 5))
        self.filter_var = tk.IntVar(value=self.config.get('rmnoise_filter', 1))
        # Use a separate StringVar for the combobox display so that setting a
        # description string never corrupts the integer filter_var.
        self._filter_display_var = tk.StringVar(value="(connect to load filters)")
        # Initially empty — populated with real names once connected
        self.filter_combo = ttk.Combobox(filter_frame, textvariable=self._filter_display_var,
                                         values=[],
                                         state='readonly', width=40)
        self.filter_combo.pack(side=tk.LEFT, padx=(0, 10), fill=tk.X, expand=True)
        self.filter_combo.bind('<<ComboboxSelected>>', self._on_filter_changed)
        # _filter_map: maps display string → filter number
        self._filter_map: dict = {}

        # ── Enable / status frame ──────────────────────────────────────────────
        enable_frame = ttk.LabelFrame(self.window, text="Enable", padding=10)
        enable_frame.pack(fill=tk.X, padx=10, pady=5)

        self.enabled_var = tk.BooleanVar(value=False)
        self.enable_check = ttk.Checkbutton(enable_frame, text="Enable RMNoise Denoising",
                                            variable=self.enabled_var,
                                            command=self._on_enable_toggled)
        self.enable_check.pack(side=tk.LEFT, padx=(0, 20))

        if not RMNOISE_AVAILABLE:
            self.enable_check.config(state='disabled')
            ttk.Label(enable_frame,
                      text="⚠ rmnoise_denoise dependencies not installed",
                      foreground='red').pack(side=tk.LEFT)

        self.status_label = ttk.Label(enable_frame, text="Disconnected", foreground='gray')
        self.status_label.pack(side=tk.LEFT)

        # ── Statistics frame ───────────────────────────────────────────────────
        stats_frame = ttk.LabelFrame(self.window, text="Statistics", padding=10)
        stats_frame.pack(fill=tk.X, padx=10, pady=5)

        # Jitter depth
        ttk.Label(stats_frame, text="Jitter Buffer:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.jitter_var = tk.StringVar(value="-- frames")
        ttk.Label(stats_frame, textvariable=self.jitter_var, width=12).grid(
            row=0, column=1, sticky=tk.W)

        # Latency
        ttk.Label(stats_frame, text="Round-trip Latency:").grid(
            row=0, column=2, sticky=tk.W, padx=(20, 5))
        self.latency_var = tk.StringVar(value="-- ms")
        ttk.Label(stats_frame, textvariable=self.latency_var, width=10).grid(
            row=0, column=3, sticky=tk.W)

        # Jitter bar
        ttk.Label(stats_frame, text="Jitter:").grid(row=1, column=0, sticky=tk.W, padx=(0, 5), pady=(5, 0))
        bar_frame = ttk.Frame(stats_frame, relief=tk.SUNKEN, borderwidth=1)
        bar_frame.grid(row=1, column=1, columnspan=3, sticky=(tk.W, tk.E), pady=(5, 0))
        self.jitter_canvas = tk.Canvas(bar_frame, width=300, height=16,
                                       bg='#2c3e50', highlightthickness=0)
        self.jitter_canvas.pack()
        self.jitter_bar = self.jitter_canvas.create_rectangle(
            0, 0, 0, 16, fill='#28a745', outline='')

        # ── Log frame ─────────────────────────────────────────────────────────
        log_frame = ttk.LabelFrame(self.window, text="Log", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(5, 10))

        self.log_text = tk.Text(log_frame, height=6, state='disabled',
                                wrap=tk.WORD, bg='#f0f0f0', font=('TkFixedFont', 9))
        self.log_text.pack(fill=tk.BOTH, expand=True)
        sb = ttk.Scrollbar(log_frame, orient=tk.VERTICAL, command=self.log_text.yview)
        sb.pack(side=tk.RIGHT, fill=tk.Y)
        self.log_text['yscrollcommand'] = sb.set

    # ── Config helpers ─────────────────────────────────────────────────────────

    def _load_config(self):
        self.username_var.set(self.config.get('rmnoise_username', ''))
        self.password_var.set(self.config.get('rmnoise_password', ''))
        self.filter_var.set(self.config.get('rmnoise_filter', 1))

    def _open_registration_url(self):
        """Open the RMNoise registration page in the default browser."""
        import webbrowser
        webbrowser.open("https://ournetplace.com/rm-noise/")

    def _save_credentials(self):
        username = self.username_var.get().strip()
        password = self.password_var.get().strip()
        if not username or not password:
            messagebox.showerror("Error", "Username and password are required",
                                 parent=self.window)
            return
        self.config['rmnoise_username'] = username
        self.config['rmnoise_password'] = password
        self.config['rmnoise_filter'] = self.filter_var.get()
        if self.on_save:
            self.on_save()
        self._log("Credentials saved.")
        messagebox.showinfo("Saved", "Credentials saved to config.", parent=self.window)

    # ── Filter change ──────────────────────────────────────────────────────────

    def _on_filter_changed(self, event=None):
        # Labels are now just the filter description; look up the number via _filter_map.
        raw = self._filter_display_var.get()
        if raw not in self._filter_map:
            return  # Not yet populated (e.g. placeholder text selected)
        new_filter = self._filter_map[raw]
        self.filter_var.set(new_filter)
        self.config['rmnoise_filter'] = new_filter
        if self.bridge and self.bridge.ready:
            self.bridge.filter_number = new_filter
            self._log(f"Filter changed to: {raw}")
        if self.on_save:
            self.on_save()

    # ── Enable / disable ──────────────────────────────────────────────────────

    def _on_enable_toggled(self):
        if self.enabled_var.get():
            self._start_bridge()
        else:
            self._stop_bridge()

    def _start_bridge(self):
        username = self.config.get('rmnoise_username', '').strip()
        password = self.config.get('rmnoise_password', '').strip()

        if not username or not password:
            messagebox.showerror(
                "Credentials Required",
                "Please enter and save your rmnoise.com username and password first.",
                parent=self.window)
            self.enabled_var.set(False)
            return

        if not RMNOISE_AVAILABLE:
            messagebox.showerror(
                "Dependencies Missing",
                "rmnoise_denoise dependencies are not installed.\n\n"
                "Install with:\n  pip install aiortc websockets scipy",
                parent=self.window)
            self.enabled_var.set(False)
            return

        self._set_status("Connecting…", 'orange')
        self._log(f"Connecting to RMNoise as '{username}' (filter {self.filter_var.get()})…")
        self.enable_check.config(state='disabled')

        def _connect():
            bridge = RMNoiseBridge(
                username, password,
                filter_number=self.filter_var.get(),
                stats_callback=self._on_stats,
                input_sample_rate=self.input_sample_rate
            )
            ok = bridge.start(timeout=20.0)
            # Schedule UI update on main thread
            self.window.after(0, lambda: self._on_bridge_started(bridge, ok))

        threading.Thread(target=_connect, daemon=True, name="RMNoise-Connect").start()

    def _on_bridge_started(self, bridge: 'RMNoiseBridge', ok: bool):
        self.enable_check.config(state='normal')
        if ok:
            self.bridge = bridge
            self._set_status("Connected ✓", 'green')
            self._log("RMNoise data channel open – denoising active.")
            # Populate filter descriptions
            self._update_filter_list()
            if self.on_enable_change:
                self.on_enable_change(True, self.bridge)
        else:
            err = bridge.error or "Unknown error"
            self._set_status("Failed", 'red')
            self._log(f"Connection failed: {err}")
            self.enabled_var.set(False)
            messagebox.showerror("RMNoise Error", f"Failed to connect:\n{err}",
                                 parent=self.window)
            if self.on_enable_change:
                self.on_enable_change(False, None)

    def _stop_bridge(self):
        if self.bridge:
            self._log("Stopping RMNoise bridge…")
            b = self.bridge
            self.bridge = None
            threading.Thread(target=b.stop, daemon=True).start()
        self._set_status("Disconnected", 'gray')
        self._reset_stats()
        if self.on_enable_change:
            self.on_enable_change(False, None)

    # ── Filter list ────────────────────────────────────────────────────────────

    def _update_filter_list(self):
        if not self.bridge:
            return
        filters = self.bridge.available_filters
        if filters:
            # Use only the description as the display label (no number prefix)
            self._filter_map = {}
            display_values = []
            for f in filters:
                label = f.get('filterDesc', f"Filter {f['filterNumber']}")
                display_values.append(label)
                self._filter_map[label] = f['filterNumber']

            # Auto-size the combobox to fit the longest entry
            max_len = max(len(s) for s in display_values) if display_values else 40
            self.filter_combo.config(values=display_values, width=max_len + 2)

            # Select the entry matching the currently saved filter number
            current = self.filter_var.get()
            for label, num in self._filter_map.items():
                if num == current:
                    self._filter_display_var.set(label)
                    break
            else:
                # Fall back to first entry
                if display_values:
                    self._filter_display_var.set(display_values[0])
                    self.filter_var.set(self._filter_map[display_values[0]])
        else:
            # Retry after 2 seconds (filters arrive asynchronously)
            self.window.after(2000, self._update_filter_list)

    # ── Statistics ─────────────────────────────────────────────────────────────

    def _on_stats(self, jitter_depth: int, latency_ms: float):
        """Called from bridge thread – schedule UI update on main thread."""
        self.window.after(0, lambda: self._update_stats_ui(jitter_depth, latency_ms))

    def _update_stats_ui(self, jitter_depth: int, latency_ms: float):
        self.jitter_var.set(f"{jitter_depth} frames")
        self.latency_var.set(f"{latency_ms:.0f} ms")

        # Update jitter bar (max 20 frames = full bar)
        max_frames = 20
        ratio = min(jitter_depth / max_frames, 1.0)
        bar_width = int(300 * ratio)
        color = '#28a745' if jitter_depth <= 6 else ('#ffc107' if jitter_depth <= 12 else '#dc3545')
        self.jitter_canvas.coords(self.jitter_bar, 0, 0, bar_width, 16)
        self.jitter_canvas.itemconfig(self.jitter_bar, fill=color)

    def _reset_stats(self):
        self.jitter_var.set("-- frames")
        self.latency_var.set("-- ms")
        self.jitter_canvas.coords(self.jitter_bar, 0, 0, 0, 16)

    def _poll_stats(self):
        """Periodic poll to keep stats fresh even if callback is slow."""
        if self.bridge and self.bridge.ready:
            self._update_stats_ui(self.bridge.jitter_depth, self.bridge.latency_ms)
        if self.window.winfo_exists():
            self._stats_update_job = self.window.after(500, self._poll_stats)

    # ── Logging ────────────────────────────────────────────────────────────────

    def _log(self, message: str):
        import time as _time
        ts = _time.strftime("%H:%M:%S")
        self.log_text.config(state='normal')
        self.log_text.insert(tk.END, f"[{ts}] {message}\n")
        self.log_text.see(tk.END)
        self.log_text.config(state='disabled')

    def _set_status(self, text: str, color: str):
        self.status_label.config(text=text, foreground=color)

    # ── Window close ──────────────────────────────────────────────────────────

    def _on_close(self):
        """Hide the window instead of destroying it (bridge keeps running)."""
        self.window.withdraw()

    def show(self):
        """Bring the window to front (re-show if hidden)."""
        self.window.deiconify()
        self.window.lift()

    def destroy(self):
        """Fully destroy the window and stop the bridge."""
        if self._stats_update_job:
            try:
                self.window.after_cancel(self._stats_update_job)
            except Exception:
                pass
        if self.bridge:
            b = self.bridge
            self.bridge = None
            threading.Thread(target=b.stop, daemon=True).start()
        try:
            self.window.destroy()
        except Exception:
            pass

    @property
    def is_enabled(self) -> bool:
        return self.enabled_var.get()

    def set_enabled(self, value: bool):
        """Programmatically set the enabled state (e.g. when IQ mode is selected)."""
        if value == self.enabled_var.get():
            return
        self.enabled_var.set(value)
        if value:
            self._start_bridge()
        else:
            self._stop_bridge()

    def set_enable_state(self, state: str):
        """Enable or disable the checkbox widget ('normal' or 'disabled')."""
        self.enable_check.config(state=state)
