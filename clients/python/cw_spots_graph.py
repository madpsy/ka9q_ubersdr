"""
CW Spots Graph Window for ka9q UberSDR Python Client.
Shows frequency vs time graph of CW spots over the last 10 minutes.
"""

import tkinter as tk
from tkinter import ttk
from datetime import datetime, timedelta
from typing import Optional, Callable
import matplotlib
matplotlib.use('TkAgg')
from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import matplotlib.dates as mdates


class CWSpotsGraphWindow:
    """Graph window for CW spots showing frequency vs time."""
    
    def __init__(self, parent_display, on_close: Optional[Callable] = None):
        """
        Initialize the CW spots graph window.
        
        Args:
            parent_display: Reference to parent CWSpotsDisplay to get filtered spots
            on_close: Optional callback when window is closed
        """
        self.parent_display = parent_display
        self.on_close_callback = on_close
        self.spot_positions = []  # Store spot positions for click detection
        
        # Create window
        self.window = tk.Toplevel()
        self.window.title("CW Spots Graph")
        self.window.geometry("1000x600")
        
        # Setup UI
        self._setup_ui()
        
        # Start periodic updates (every 1 second to stay in sync with table)
        self.update_timer = None
        self._schedule_update()
        
        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self._on_closing)
        
    def _setup_ui(self):
        """Setup the user interface."""
        # Top frame for info
        top_frame = ttk.Frame(self.window)
        top_frame.pack(fill=tk.X, padx=5, pady=5)
        
        # Info label
        info_label = ttk.Label(top_frame, text="Graph shows spots from main window filters",
                              foreground="gray")
        info_label.pack(side=tk.LEFT, padx=5)
        
        # Spot count
        self.count_label = ttk.Label(top_frame, text="0 spots")
        self.count_label.pack(side=tk.RIGHT, padx=10)
        
        # Graph frame
        graph_frame = ttk.Frame(self.window)
        graph_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        
        # Create matplotlib figure
        self.figure = Figure(figsize=(10, 6), facecolor='#1a1a1a')
        self.ax = self.figure.add_subplot(111, facecolor='#1a1a1a')
        
        # Style the plot
        self.ax.tick_params(colors='#aaa', which='both')
        self.ax.spines['bottom'].set_color('#444')
        self.ax.spines['top'].set_color('#444')
        self.ax.spines['left'].set_color('#444')
        self.ax.spines['right'].set_color('#444')
        self.ax.xaxis.label.set_color('#888')
        self.ax.yaxis.label.set_color('#888')
        self.ax.title.set_color('#aaa')
        
        # Create canvas
        self.canvas = FigureCanvasTkAgg(self.figure, master=graph_frame)
        self.canvas.draw()
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
        
        # Connect click event
        self.canvas.mpl_connect('button_press_event', self._on_graph_click)
        
        # Initial draw
        self._draw_graph()
        
    def _schedule_update(self):
        """Schedule periodic graph update."""
        if self.window.winfo_exists():
            self._draw_graph()
            # Update every second to stay in sync with table
            self.update_timer = self.window.after(1000, self._schedule_update)
        
    def _on_graph_click(self, event):
        """Handle click on graph to tune radio."""
        if event.inaxes != self.ax:
            return
        
        # Find the closest spot to the click
        if not self.spot_positions:
            return
        
        click_x = event.xdata
        click_y = event.ydata
        
        if click_x is None or click_y is None:
            return
        
        # Convert click_x from matplotlib date to timestamp
        from matplotlib.dates import num2date
        click_time = num2date(click_x).replace(tzinfo=None)
        
        # Find closest spot
        min_distance = float('inf')
        closest_spot = None
        
        for spot_data in self.spot_positions:
            spot_time = spot_data['time']
            spot_freq = spot_data['frequency']
            
            # Calculate distance (normalize time and frequency to similar scales)
            time_diff = abs((click_time - spot_time).total_seconds()) / 60.0  # minutes
            freq_diff = abs(click_y - spot_freq)  # MHz
            
            # Weight time and frequency differences
            distance = (time_diff * 0.01) + (freq_diff * 10)
            
            if distance < min_distance:
                min_distance = distance
                closest_spot = spot_data['spot']
        
        # If we found a spot within reasonable distance, tune to it
        if closest_spot and min_distance < 1.0:  # Threshold for "close enough"
            self._tune_to_spot(closest_spot)
    
    def _tune_to_spot(self, spot):
        """Tune radio to the spot frequency."""
        if not self.parent_display or not self.parent_display.radio_gui:
            return
        
        freq_hz = spot['frequency']
        
        # Determine mode based on frequency (CWU >= 10 MHz, CWL < 10 MHz)
        if freq_hz < 10000000:
            mode = 'CWL'
        else:
            mode = 'CWU'
        
        # Set frequency display
        self.parent_display.radio_gui.set_frequency_hz(freq_hz)
        
        # Set mode if not locked
        if not self.parent_display.radio_gui.mode_lock_var.get():
            self.parent_display.radio_gui.mode_var.set(mode)
            self.parent_display.radio_gui.on_mode_changed()
        
        # Apply changes if connected
        if self.parent_display.radio_gui.connected:
            self.parent_display.radio_gui.apply_frequency()
        
        print(f"Tuned to {spot['dx_call']} at {freq_hz/1e6:.6f} MHz ({mode})")
    
    def _draw_graph(self):
        """Draw the frequency vs time graph using spots from parent display."""
        # Clear the plot and spot positions
        self.ax.clear()
        self.spot_positions = []
        
        # Get filtered spots from parent display
        if not self.parent_display:
            return
        
        # Use the parent's spots list and apply the same filters
        filtered_spots = self._get_filtered_spots_from_parent()
        
        # Update count
        self.count_label.config(text=f"{len(filtered_spots)} spots")
        
        if len(filtered_spots) == 0:
            self.ax.text(0.5, 0.5, 'No spots in the last 10 minutes',
                        horizontalalignment='center',
                        verticalalignment='center',
                        transform=self.ax.transAxes,
                        color='#666',
                        fontsize=14)
            self.ax.set_xlabel('Time (UTC)', color='#888')
            self.ax.set_ylabel('Frequency (MHz)', color='#888')
            self.canvas.draw()
            return
        
        # Prepare data for plotting
        times = []
        frequencies = []
        callsigns = []
        snrs = []
        
        for spot in filtered_spots:
            try:
                spot_time = datetime.fromisoformat(spot['time'].replace('Z', '+00:00'))
                spot_time = spot_time.replace(tzinfo=None)
                times.append(spot_time)
                frequencies.append(spot['frequency'] / 1e6)  # Convert to MHz
                callsigns.append(spot['dx_call'])
                snrs.append(spot.get('snr', 0))
            except Exception:
                continue
        
        if len(times) == 0:
            self.canvas.draw()
            return
        
        # Color mapping based on SNR
        colors = []
        for snr in snrs:
            if snr >= 15:
                colors.append('#28a745')  # Green - strong
            elif snr >= 5:
                colors.append('#ffc107')  # Yellow - good
            elif snr >= -5:
                colors.append('#ff8c00')  # Orange - weak
            else:
                colors.append('#dc3545')  # Red - very weak
        
        # Store spot positions for click detection
        for i in range(len(times)):
            self.spot_positions.append({
                'time': times[i],
                'frequency': frequencies[i],
                'spot': filtered_spots[i]
            })
        
        # Plot spots
        scatter = self.ax.scatter(times, frequencies, c=colors, s=50, alpha=0.7, edgecolors='white', linewidths=0.5, picker=True)
        
        # Add callsign labels for recent spots (to avoid clutter, only show last 20)
        recent_count = min(20, len(times))
        for i in range(recent_count):
            self.ax.annotate(callsigns[i],
                           (times[i], frequencies[i]),
                           xytext=(5, 5),
                           textcoords='offset points',
                           fontsize=8,
                           color=colors[i],
                           weight='bold',
                           alpha=0.9)
        
        # Format x-axis (time)
        self.ax.xaxis.set_major_formatter(mdates.DateFormatter('%H:%M:%S', tz=None))
        self.ax.xaxis.set_major_locator(mdates.AutoDateLocator())
        self.figure.autofmt_xdate()
        
        # Labels
        self.ax.set_xlabel('Time (UTC)', color='#888', fontsize=12)
        self.ax.set_ylabel('Frequency (MHz)', color='#888', fontsize=12)
        
        # Get filter description from parent
        filter_desc = self._get_filter_description()
        self.ax.set_title(f'CW Spots{filter_desc}', color='#aaa', fontsize=14)
        
        # Grid
        self.ax.grid(True, alpha=0.2, color='#444')
        
        # Style ticks
        self.ax.tick_params(colors='#aaa', which='both')
        
        # Redraw canvas
        self.canvas.draw()
    
    def _get_filtered_spots_from_parent(self):
        """Get filtered spots from parent display using same filter logic."""
        if not self.parent_display:
            return []
        
        now = datetime.utcnow()
        max_age_ms = self.parent_display.age_filter * 60 * 1000 if self.parent_display.age_filter is not None else None
        min_snr = self.parent_display.snr_filter
        min_wpm = self.parent_display.wpm_filter
        callsign_upper = self.parent_display.callsign_filter.upper()
        
        filtered_spots = []
        for spot in self.parent_display.spots:
            try:
                # Age filter
                if max_age_ms is not None:
                    spot_time = datetime.fromisoformat(spot['time'].replace('Z', '+00:00'))
                    spot_time = spot_time.replace(tzinfo=None)
                    age_ms = (now - spot_time).total_seconds() * 1000
                    if age_ms > max_age_ms:
                        continue
                
                # Band filter
                if self.parent_display.band_filter != "all" and spot.get('band') != self.parent_display.band_filter:
                    continue
                
                # SNR filter
                if min_snr is not None and spot.get('snr', -999) < min_snr:
                    continue
                
                # WPM filter
                if min_wpm is not None and spot.get('wpm', 0) < min_wpm:
                    continue
                
                # Callsign filter
                if callsign_upper:
                    callsign = spot.get('dx_call', '').upper()
                    country = spot.get('country', '').upper()
                    if callsign_upper not in callsign and callsign_upper not in country:
                        continue
                
                # Country filter
                if self.parent_display.country_filter != "all" and spot.get('country', '') != self.parent_display.country_filter:
                    continue
                
                filtered_spots.append(spot)
            except Exception:
                continue
        
        return filtered_spots
    
    def _get_filter_description(self):
        """Get a description of active filters from parent."""
        if not self.parent_display:
            return ""
        
        parts = []
        
        if self.parent_display.band_filter != "all":
            parts.append(self.parent_display.band_filter)
        
        if self.parent_display.age_filter is not None:
            parts.append(f"{self.parent_display.age_filter}min")
        
        if self.parent_display.snr_filter is not None:
            parts.append(f"SNR≥{self.parent_display.snr_filter}")
        
        if self.parent_display.wpm_filter is not None:
            parts.append(f"WPM≥{self.parent_display.wpm_filter}")
        
        if self.parent_display.country_filter != "all":
            parts.append(self.parent_display.country_filter)
        
        if self.parent_display.callsign_filter:
            parts.append(f"'{self.parent_display.callsign_filter}'")
        
        if parts:
            return " - " + ", ".join(parts)
        return ""
    
    def refresh(self):
        """Refresh the graph (called by parent when filters change)."""
        self._draw_graph()
        
    def _on_closing(self):
        """Handle window close event."""
        # Cancel update timer
        if self.update_timer:
            self.window.after_cancel(self.update_timer)
            self.update_timer = None
        
        # Call close callback if provided
        if self.on_close_callback:
            self.on_close_callback()
        
        # Destroy window
        self.window.destroy()


def create_cw_spots_graph_window(parent_display, on_close=None):
    """
    Create and return a CW spots graph window.
    
    Args:
        parent_display: Reference to parent CWSpotsDisplay to get filtered spots
        on_close: Optional callback when window is closed
    
    Returns:
        CWSpotsGraphWindow instance
    """
    return CWSpotsGraphWindow(parent_display, on_close)