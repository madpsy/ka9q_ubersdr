"""
server_dsp_window.py — Server-Side DSP parameter configuration dialog.

The main window shows only a compact row:
  [✓ Enable Server NR] [Filter ▾] [Config…] [status label]

This module provides the modal "Config…" dialog that renders dynamic
parameter controls from the server's ParamInfo descriptors.
"""

import tkinter as tk
from tkinter import ttk
import threading
from typing import Optional, Dict, List, Any


# ---------------------------------------------------------------------------
# Data classes (plain dicts from JSON, typed here for clarity)
# ---------------------------------------------------------------------------

class DSPParamInfo:
    """Mirrors the server's ParamInfo protobuf / JSON descriptor."""
    __slots__ = ('name', 'type', 'default', 'min', 'max', 'description', 'runtime_safe')

    def __init__(self, d: dict):
        self.name: str         = d.get('name', '')
        self.type: str         = d.get('type', 'float').lower()
        self.default: str      = d.get('default', d.get('default_val', ''))
        self.min: str          = d.get('min', d.get('min_val', ''))
        self.max: str          = d.get('max', d.get('max_val', ''))
        self.description: str  = d.get('description', '')
        self.runtime_safe: bool = bool(d.get('runtime_safe', True))


class DSPFilterInfo:
    """Mirrors the server's FilterInfo protobuf / JSON descriptor."""
    __slots__ = ('name', 'description', 'params')

    def __init__(self, d: dict):
        self.name: str              = d.get('name', '')
        self.description: str       = d.get('description', '')
        self.params: List[DSPParamInfo] = [DSPParamInfo(p) for p in d.get('params', [])]


# ---------------------------------------------------------------------------
# Helper: compute a sensible slider step
# ---------------------------------------------------------------------------

def _compute_step(min_v: float, max_v: float) -> float:
    r = max_v - min_v
    if r <= 1:    return 0.01
    if r <= 10:   return 0.1
    if r <= 100:  return 1.0
    return max(1.0, round(10 ** (len(str(int(r))) - 2)))


def _fmt_name(name: str) -> str:
    return name.replace('-', ' ').replace('_', ' ').title()


def _fmt_value(v: float, param: DSPParamInfo) -> str:
    if param.type == 'int':
        return str(int(round(v)))
    r = 0.0
    try:
        r = float(param.max) - float(param.min)
    except (ValueError, TypeError):
        pass
    if r <= 1:    return f"{v:.3f}"
    if r <= 10:   return f"{v:.2f}"
    return f"{v:.1f}"


# ---------------------------------------------------------------------------
# Modal parameter configuration dialog
# ---------------------------------------------------------------------------

class ServerDSPConfigDialog:
    """
    Modal dialog showing all runtime-safe parameters for the selected filter.
    Changes are sent live (debounced 150 ms) via send_params_callback.
    """

    def __init__(self, parent: tk.Widget,
                 filter_info: DSPFilterInfo,
                 current_params: Dict[str, str],
                 send_params_callback,
                 enabled: bool):
        self._cb = send_params_callback
        self._filter = filter_info
        self._param_vars: Dict[str, Any] = {}   # name → tk variable
        self._debounce_ids: Dict[str, str] = {}  # name → after id
        self._enabled = enabled

        self.top = tk.Toplevel(parent)
        self.top.title(f"Server NR — {filter_info.name.upper()} Parameters")
        self.top.resizable(False, False)
        self.top.grab_set()  # modal

        self._build(current_params)

        # Centre over parent
        self.top.update_idletasks()
        px = parent.winfo_rootx() + parent.winfo_width() // 2 - self.top.winfo_width() // 2
        py = parent.winfo_rooty() + parent.winfo_height() // 2 - self.top.winfo_height() // 2
        self.top.geometry(f"+{px}+{py}")

    # ------------------------------------------------------------------
    def _build(self, current_params: Dict[str, str]):
        outer = ttk.Frame(self.top, padding=10)
        outer.pack(fill=tk.BOTH, expand=True)

        runtime_params = [p for p in self._filter.params if p.runtime_safe]

        if not runtime_params:
            ttk.Label(outer, text="This filter has no adjustable parameters.",
                      foreground='gray').pack(pady=10)
        else:
            if self._filter.description:
                ttk.Label(outer, text=self._filter.description,
                          wraplength=380, foreground='gray').pack(anchor=tk.W, pady=(0, 8))

            grid = ttk.Frame(outer)
            grid.pack(fill=tk.BOTH, expand=True)

            for row_idx, param in enumerate(runtime_params):
                self._add_param_row(grid, row_idx, param, current_params)

        # Close button
        ttk.Separator(outer, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=(10, 6))
        ttk.Button(outer, text="Close", command=self.top.destroy).pack(anchor=tk.E)

    # ------------------------------------------------------------------
    def _add_param_row(self, grid: ttk.Frame, row: int,
                       param: DSPParamInfo, current_params: Dict[str, str]):
        label_text = _fmt_name(param.name)

        # Determine initial value
        raw = current_params.get(param.name, param.default)

        ptype = param.type

        if ptype == 'bool':
            var = tk.BooleanVar(value=(raw in ('true', 'True', '1', True)))
            self._param_vars[param.name] = var

            cb = ttk.Checkbutton(grid, text=label_text, variable=var,
                                 command=lambda n=param.name, v=var: self._on_bool_change(n, v))
            cb.grid(row=row, column=0, columnspan=3, sticky=tk.W, padx=(0, 8), pady=2)
            if param.description:
                ttk.Label(grid, text=param.description, foreground='gray',
                          font=('TkDefaultFont', 8)).grid(
                    row=row, column=3, sticky=tk.W, padx=(4, 0), pady=2)

        elif param.min != '' and param.max != '':
            # Slider
            try:
                min_v = float(param.min)
                max_v = float(param.max)
                cur_v = float(raw) if raw else float(param.default or min_v)
            except (ValueError, TypeError):
                min_v, max_v, cur_v = 0.0, 100.0, 50.0

            var = tk.DoubleVar(value=cur_v)
            self._param_vars[param.name] = var

            ttk.Label(grid, text=label_text, width=16, anchor=tk.W).grid(
                row=row, column=0, sticky=tk.W, padx=(0, 6), pady=2)

            val_label = ttk.Label(grid, text=_fmt_value(cur_v, param), width=8, anchor=tk.E)
            val_label.grid(row=row, column=2, sticky=tk.E, padx=(4, 6), pady=2)

            step = _compute_step(min_v, max_v)
            slider = ttk.Scale(grid, from_=min_v, to=max_v, orient=tk.HORIZONTAL,
                               variable=var, length=200)
            slider.grid(row=row, column=1, sticky=tk.EW, pady=2)

            def _on_slide(val, n=param.name, p=param, lbl=val_label, v=var):
                fv = float(val)
                # Snap to step
                step_local = _compute_step(
                    float(p.min) if p.min else 0,
                    float(p.max) if p.max else 100)
                snapped = round(fv / step_local) * step_local
                lbl.config(text=_fmt_value(snapped, p))
                self._debounce_send(n, str(snapped))

            slider.config(command=_on_slide)

            if param.description:
                ttk.Label(grid, text=param.description, foreground='gray',
                          font=('TkDefaultFont', 8)).grid(
                    row=row, column=3, sticky=tk.W, padx=(4, 0), pady=2)

        else:
            # Text entry
            var = tk.StringVar(value=raw or param.default or '')
            self._param_vars[param.name] = var

            ttk.Label(grid, text=label_text, width=16, anchor=tk.W).grid(
                row=row, column=0, sticky=tk.W, padx=(0, 6), pady=2)

            entry = ttk.Entry(grid, textvariable=var, width=14)
            entry.grid(row=row, column=1, sticky=tk.W, pady=2)
            entry.bind('<Return>', lambda e, n=param.name, v=var:
                       self._debounce_send(n, v.get()))
            entry.bind('<FocusOut>', lambda e, n=param.name, v=var:
                       self._debounce_send(n, v.get()))

            if param.description:
                ttk.Label(grid, text=param.description, foreground='gray',
                          font=('TkDefaultFont', 8)).grid(
                    row=row, column=3, sticky=tk.W, padx=(4, 0), pady=2)

    # ------------------------------------------------------------------
    def _on_bool_change(self, name: str, var: tk.BooleanVar):
        self._debounce_send(name, 'true' if var.get() else 'false')

    def _debounce_send(self, name: str, value: str):
        """Cancel any pending send for this param and schedule a new one."""
        if name in self._debounce_ids:
            try:
                self.top.after_cancel(self._debounce_ids[name])
            except Exception:
                pass
        self._debounce_ids[name] = self.top.after(
            150, lambda: self._fire_send(name, value))

    def _fire_send(self, name: str, value: str):
        self._debounce_ids.pop(name, None)
        if self._enabled and self._cb:
            try:
                self._cb({name: value})
            except Exception:
                pass

    def get_current_params(self) -> Dict[str, str]:
        """Return current UI values as string dict."""
        result = {}
        for name, var in self._param_vars.items():
            if isinstance(var, tk.BooleanVar):
                result[name] = 'true' if var.get() else 'false'
            else:
                result[name] = str(var.get())
        return result
