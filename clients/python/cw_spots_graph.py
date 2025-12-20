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
from matplotlib.patches import Rectangle


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
        self.tooltip_annotation = None  # For hover tooltip
        self.tooltip_rect = None  # Background rectangle for tooltip
        self.last_hover_event = None  # Store last hover event to restore tooltip after redraw
        self.last_spot_time = None  # Track last filtered spot time
        self.freq_line = None  # Reference to current frequency line

        # Create window
        self.window = tk.Toplevel()
        self.window.title("CW Spots Graph")
        self.window.geometry("1000x600")
        self.window.configure(bg='#000000')  # Black background

        # Setup UI
        self._setup_ui()

        # Start periodic updates
        self.update_timer = None
        self.freq_update_timer = None
        self._schedule_update()
        self._schedule_freq_update()

        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self._on_closing)

    def _setup_ui(self):
        """Setup the user interface."""
        # Top frame for info with black background
        top_frame = tk.Frame(self.window, bg='#000000')
        top_frame.pack(fill=tk.X, padx=5, pady=5)

        # Dynamic status label (shows callsign info when dial frequency matches a spot)
        self.status_label = tk.Label(top_frame, text="",
                                     foreground="green", font=("TkDefaultFont", 10, "bold"),
                                     bg='#000000')
        self.status_label.pack(side=tk.LEFT, padx=5)

        # Last spot time indicator (top right, inline with spot count)
        self.last_spot_label = tk.Label(top_frame, text="",
                                        foreground="#888", bg='#000000',
                                        font=("TkDefaultFont", 9))
        self.last_spot_label.pack(side=tk.RIGHT, padx=10)

        # Spot count
        self.count_label = tk.Label(top_frame, text="0 spots",
                                    foreground="#aaa", bg='#000000')
        self.count_label.pack(side=tk.RIGHT, padx=10)

        # Graph frame with black background
        graph_frame = tk.Frame(self.window, bg='#000000')
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

        # Connect click and hover events
        self.canvas.mpl_connect('button_press_event', self._on_graph_click)
        self.canvas.mpl_connect('motion_notify_event', self._on_hover)

        # Initial draw
        self._draw_graph()

    def _schedule_update(self):
        """Schedule periodic status and time updates without full graph redraw."""
        if self.window.winfo_exists():
            # Update status label and last spot time every second
            self._update_status_label()
            self._update_last_spot_time_label()
            # Schedule next update in 1 second
            self.update_timer = self.window.after(1000, self._schedule_update)

    def _schedule_freq_update(self):
        """Schedule frequent frequency line updates (every 100ms for smooth tracking)."""
        if self.window.winfo_exists():
            # Update frequency line position
            self._update_frequency_line()
            # Schedule next update in 100ms
            self.freq_update_timer = self.window.after(100, self._schedule_freq_update)

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

        # Check if current mode is IQ - if so, don't allow tuning
        current_mode = self.parent_display.radio_gui.mode_var.get().upper()
        if current_mode.startswith('IQ'):
            print(f"Cannot tune from CW spots graph in IQ mode ({current_mode})")
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

    def _update_status_label(self):
        """Update status label with current dial frequency spot info."""
        if not self.parent_display or not self.parent_display.radio_gui:
            self.status_label.config(text="")
            return

        try:
            # Get current dial frequency from radio GUI
            current_freq_hz = self.parent_display.radio_gui.get_frequency_hz()
            current_freq_mhz = current_freq_hz / 1e6

            # Get filtered spots
            filtered_spots = self._get_filtered_spots_from_parent()

            # Find the most recent spot matching the current frequency (within 100 Hz tolerance)
            tolerance_hz = 100
            matching_spots = []

            for spot in filtered_spots:
                spot_freq_hz = spot['frequency']
                if abs(spot_freq_hz - current_freq_hz) <= tolerance_hz:
                    matching_spots.append(spot)

            if matching_spots:
                # Sort by time to get the latest spot
                matching_spots.sort(key=lambda s: s['time'], reverse=True)
                latest_spot = matching_spots[0]

                # Format status text
                callsign = latest_spot.get('dx_call', 'N/A')
                freq_mhz = latest_spot['frequency'] / 1e6
                snr = latest_spot.get('snr', 0)
                wpm = latest_spot.get('wpm', 'N/A')

                status_text = f"{callsign}  {freq_mhz:.3f} MHz  SNR {snr} dB  {wpm} WPM"

                # Set color based on SNR (matching graph color scheme)
                if snr > 26:
                    color = '#28a745'  # Green - excellent
                elif snr >= 13:
                    color = '#ffc107'  # Yellow - good
                elif snr >= 6:
                    color = '#ff8c00'  # Orange - fair
                else:
                    color = '#dc3545'  # Red - weak (0-5)

                self.status_label.config(text=status_text, foreground=color)
            else:
                # No matching spot
                self.status_label.config(text="")

        except (ValueError, AttributeError):
            self.status_label.config(text="")

    def _draw_graph(self):
        """Draw the frequency vs time graph using spots from parent display."""
        # Clear the plot and spot positions
        self.ax.clear()
        self.spot_positions = []
        # Reset tooltip references since ax.clear() removes all artists
        self.tooltip_annotation = None
        self.tooltip_rect = None
        self.freq_line = None  # Reset frequency line reference

        # Store whether we need to restore tooltip after redraw
        restore_tooltip = self.last_hover_event is not None

        # Get filtered spots from parent display
        if not self.parent_display:
            return

        # Use the parent's spots list and apply the same filters
        filtered_spots = self._get_filtered_spots_from_parent()

        # Update last spot time from filtered spots
        if filtered_spots:
            try:
                latest_spot = max(filtered_spots, key=lambda s: s.get('time', ''))
                # Truncate nanosecond precision to microseconds for Windows compatibility
                time_str = latest_spot['time'].replace('Z', '+00:00')
                if '.' in time_str and '+' in time_str:
                    parts = time_str.split('+')
                    time_part = parts[0]
                    tz_part = '+' + parts[1]
                    if '.' in time_part:
                        base, frac = time_part.rsplit('.', 1)
                        frac = frac[:6]  # Keep only 6 digits (microseconds)
                        time_str = f"{base}.{frac}{tz_part}"
                self.last_spot_time = datetime.fromisoformat(time_str).replace(tzinfo=None)
            except Exception:
                pass

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
                # Truncate nanosecond precision to microseconds for Windows compatibility
                time_str = spot['time'].replace('Z', '+00:00')
                if '.' in time_str and '+' in time_str:
                    parts = time_str.split('+')
                    time_part = parts[0]
                    tz_part = '+' + parts[1]
                    if '.' in time_part:
                        base, frac = time_part.rsplit('.', 1)
                        frac = frac[:6]  # Keep only 6 digits (microseconds)
                        time_str = f"{base}.{frac}{tz_part}"
                spot_time = datetime.fromisoformat(time_str)
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
            if snr > 26:
                colors.append('#28a745')  # Green - excellent
            elif snr >= 13:
                colors.append('#ffc107')  # Yellow - good
            elif snr >= 6:
                colors.append('#ff8c00')  # Orange - fair
            else:
                colors.append('#dc3545')  # Red - weak (0-5)

        # Store spot positions for click detection
        for i in range(len(times)):
            self.spot_positions.append({
                'time': times[i],
                'frequency': frequencies[i],
                'spot': filtered_spots[i]
            })

        # Plot spots
        scatter = self.ax.scatter(times, frequencies, c=colors, s=50, alpha=0.7, edgecolors='white', linewidths=0.5, picker=True)

        # Add callsign labels for all spots
        for i in range(len(times)):
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

        # Draw current frequency line if within range
        self._draw_frequency_line()

        # Redraw canvas
        self.canvas.draw()

        # Update status label and time after redraw
        self._update_status_label()
        self._update_last_spot_time_label()

        # Restore tooltip if mouse was hovering over a spot
        if restore_tooltip and self.last_hover_event is not None:
            self._on_hover(self.last_hover_event)

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
                    # Truncate nanosecond precision to microseconds for Windows compatibility
                    time_str = spot['time'].replace('Z', '+00:00')
                    if '.' in time_str and '+' in time_str:
                        parts = time_str.split('+')
                        time_part = parts[0]
                        tz_part = '+' + parts[1]
                        if '.' in time_part:
                            base, frac = time_part.rsplit('.', 1)
                            frac = frac[:6]  # Keep only 6 digits (microseconds)
                            time_str = f"{base}.{frac}{tz_part}"
                    spot_time = datetime.fromisoformat(time_str)
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

                # Source filter
                if self.parent_display.source_filter != "All":
                    comment = spot.get('comment', '')
                    is_tci = comment.startswith('TCI')
                    if self.parent_display.source_filter == "TCI" and not is_tci:
                        continue
                    elif self.parent_display.source_filter == "Server" and is_tci:
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

    def _update_last_spot_time_label(self):
        """Update the last spot time label at bottom right of window."""
        if self.last_spot_time is None:
            self.last_spot_label.config(text="")
            return

        try:
            now = datetime.utcnow()
            age_seconds = (now - self.last_spot_time).total_seconds()

            if age_seconds < 60:
                time_ago = f"{int(age_seconds)}s"
            elif age_seconds < 3600:
                minutes = int(age_seconds / 60)
                seconds = int(age_seconds % 60)
                time_ago = f"{minutes}m {seconds}s"
            else:
                hours = int(age_seconds / 3600)
                minutes = int((age_seconds % 3600) / 60)
                time_ago = f"{hours}h {minutes}m"

            self.last_spot_label.config(text=f"Last: {time_ago}")
        except Exception:
            self.last_spot_label.config(text="")

    def _on_hover(self, event):
        """Handle mouse hover to show tooltip with spot details."""
        # Store the event for tooltip restoration after redraw
        if event.inaxes == self.ax:
            self.last_hover_event = event
        else:
            self.last_hover_event = None

        if event.inaxes != self.ax:
            # Hide tooltip if mouse leaves the plot area
            if self.tooltip_annotation:
                self.tooltip_annotation.set_visible(False)
                if self.tooltip_rect:
                    self.tooltip_rect.set_visible(False)
                self.canvas.draw_idle()
            return

        # Find the closest spot to the hover position
        if not self.spot_positions:
            return

        hover_x = event.xdata
        hover_y = event.ydata

        if hover_x is None or hover_y is None:
            return

        # Convert hover_x from matplotlib date to timestamp
        from matplotlib.dates import num2date
        hover_time = num2date(hover_x).replace(tzinfo=None)

        # Find closest spot within a reasonable distance
        min_distance = float('inf')
        closest_spot = None
        closest_time = None
        closest_freq = None

        for spot_data in self.spot_positions:
            spot_time = spot_data['time']
            spot_freq = spot_data['frequency']

            # Calculate distance (normalize time and frequency to similar scales)
            time_diff = abs((hover_time - spot_time).total_seconds()) / 60.0  # minutes
            freq_diff = abs(hover_y - spot_freq)  # MHz

            # Weight time and frequency differences
            distance = (time_diff * 0.01) + (freq_diff * 10)

            if distance < min_distance:
                min_distance = distance
                closest_spot = spot_data['spot']
                closest_time = spot_time
                closest_freq = spot_freq

        # Show tooltip if we found a spot within reasonable distance
        if closest_spot and min_distance < 0.5:  # Threshold for hover detection
            self._show_tooltip(closest_spot, closest_time, closest_freq)
        else:
            # Hide tooltip if no spot is close enough
            self.last_hover_event = None
            if self.tooltip_annotation:
                self.tooltip_annotation.set_visible(False)
                if self.tooltip_rect:
                    self.tooltip_rect.set_visible(False)
                self.canvas.draw_idle()

    def _show_tooltip(self, spot, spot_time, spot_freq):
        """Display tooltip with spot details."""
        # Build tooltip text
        lines = []
        lines.append(f"Callsign: {spot.get('dx_call', 'N/A')}")
        lines.append(f"Band: {spot.get('band', 'N/A')}")
        lines.append(f"Country: {spot.get('country', 'N/A')}")
        lines.append(f"SNR: {spot.get('snr', 'N/A')} dB")
        lines.append(f"WPM: {spot.get('wpm', 'N/A')}")

        # Add distance if available and not None
        if 'distance_km' in spot and spot['distance_km'] is not None:
            lines.append(f"Distance: {spot['distance_km']:.0f} km")

        # Add bearing if available and not None
        if 'bearing' in spot and spot['bearing'] is not None:
            lines.append(f"Bearing: {spot['bearing']:.0f}°")

        # Add comment if it has a value
        comment = spot.get('comment', '').strip()
        if comment:
            lines.append(f"Comment: {comment}")

        tooltip_text = '\n'.join(lines)

        # Create or update tooltip annotation
        if self.tooltip_annotation is None:
            # Create new annotation with background
            self.tooltip_annotation = self.ax.annotate(
                tooltip_text,
                xy=(spot_time, spot_freq),
                xytext=(15, 15),
                textcoords='offset points',
                bbox=dict(boxstyle='round,pad=0.5', facecolor='#2a2a2a', edgecolor='#666', alpha=0.95),
                fontsize=9,
                color='#eee',
                weight='normal',
                zorder=1000
            )
        else:
            # Update existing annotation
            self.tooltip_annotation.set_text(tooltip_text)
            self.tooltip_annotation.xy = (spot_time, spot_freq)
            self.tooltip_annotation.set_visible(True)

        self.canvas.draw_idle()

    def _draw_frequency_line(self):
        """Draw a dashed white horizontal line at the current tuned frequency."""
        if not self.parent_display or not self.parent_display.radio_gui:
            return

        try:
            # Get current frequency in MHz
            current_freq_hz = self.parent_display.radio_gui.get_frequency_hz()
            current_freq_mhz = current_freq_hz / 1e6

            # Get current y-axis limits
            ylim = self.ax.get_ylim()

            # Only draw line if frequency is within the y-axis range
            if ylim[0] <= current_freq_mhz <= ylim[1]:
                # Draw dashed white horizontal line
                self.freq_line = self.ax.axhline(
                    y=current_freq_mhz,
                    color='white',
                    linestyle='--',
                    linewidth=1.5,
                    alpha=0.5,
                    zorder=5
                )
        except (ValueError, AttributeError):
            pass

    def _update_frequency_line(self):
        """Update the frequency line position without full redraw."""
        if not self.parent_display or not self.parent_display.radio_gui:
            return

        try:
            # Get current frequency in MHz
            current_freq_hz = self.parent_display.radio_gui.get_frequency_hz()
            current_freq_mhz = current_freq_hz / 1e6

            # Get current y-axis limits
            ylim = self.ax.get_ylim()

            # Check if frequency is within the y-axis range
            if ylim[0] <= current_freq_mhz <= ylim[1]:
                # If line exists, update its position
                if self.freq_line:
                    self.freq_line.set_ydata([current_freq_mhz, current_freq_mhz])
                    self.freq_line.set_visible(True)
                else:
                    # Create new line if it doesn't exist
                    self.freq_line = self.ax.axhline(
                        y=current_freq_mhz,
                        color='white',
                        linestyle='--',
                        linewidth=1.5,
                        alpha=0.5,
                        zorder=5
                    )
                self.canvas.draw_idle()
            else:
                # Hide line if frequency is out of range
                if self.freq_line:
                    self.freq_line.set_visible(False)
                    self.canvas.draw_idle()
        except (ValueError, AttributeError):
            pass

    def refresh(self):
        """Refresh the graph (called by parent when filters change)."""
        self._draw_graph()

    def _on_closing(self):
        """Handle window close event."""
        # Cancel update timers
        if self.update_timer:
            self.window.after_cancel(self.update_timer)
            self.update_timer = None
        if self.freq_update_timer:
            self.window.after_cancel(self.freq_update_timer)
            self.freq_update_timer = None

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