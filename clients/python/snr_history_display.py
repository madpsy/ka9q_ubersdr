#!/usr/bin/env python3
"""
SNR History Display Window for ka9q_ubersdr
Shows 10 seconds of SNR history using selected signal data source
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from collections import deque
import time
from datetime import datetime
import csv

try:
    import matplotlib
    matplotlib.use('TkAgg')
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    from matplotlib.figure import Figure
    MATPLOTLIB_AVAILABLE = True
except ImportError:
    MATPLOTLIB_AVAILABLE = False


class SNRHistoryDisplay:
    """Display for SNR history over time."""

    def __init__(self, parent, parent_gui):
        """Initialize SNR history display.
        
        Args:
            parent: Parent tkinter window
            parent_gui: Reference to main RadioGUI instance
        """
        self.parent = parent
        self.parent_gui = parent_gui
        
        # History length in seconds (default 10)
        self.history_length = 10
        
        # Data storage (history_length seconds at 10 Hz)
        self.max_samples = self.history_length * 10
        self.timestamps = deque(maxlen=self.max_samples)
        self.snr_values = deque(maxlen=self.max_samples)
        self.baseband_values = deque(maxlen=self.max_samples)
        self.noise_values = deque(maxlen=self.max_samples)
        
        # Create matplotlib figure
        if MATPLOTLIB_AVAILABLE:
            self.fig = Figure(figsize=(8, 4), dpi=100)
            self.ax = self.fig.add_subplot(111)
            self.ax.set_xlabel('Time (seconds ago)')
            self.ax.set_ylabel('SNR (dB)', color='blue')
            self.ax.set_title(f'SNR History ({self.history_length} seconds)')
            self.ax.grid(True, alpha=0.3)
            self.ax.set_xlim(self.history_length, 0)  # history_length seconds ago to now
            self.ax.set_ylim(-10, 40)  # Typical SNR range
            self.ax.tick_params(axis='y', labelcolor='blue')
            
            # Create SNR line plot (left axis)
            self.snr_line, = self.ax.plot([], [], 'b-', linewidth=2, label='SNR')
            
            # Create second Y-axis for dBFS values
            self.ax2 = self.ax.twinx()
            self.ax2.set_ylabel('Power (dBFS)', color='black')
            self.ax2.set_ylim(-120, 0)  # Typical dBFS range
            self.ax2.tick_params(axis='y', labelcolor='black')
            
            # Create baseband and noise line plots (right axis)
            self.baseband_line, = self.ax2.plot([], [], 'g-', linewidth=1.5, alpha=0.7, label='Baseband Power')
            self.noise_line, = self.ax2.plot([], [], 'r-', linewidth=1.5, alpha=0.7, label='Noise Density')
            
            # Add legends
            lines1, labels1 = self.ax.get_legend_handles_labels()
            lines2, labels2 = self.ax2.get_legend_handles_labels()
            self.ax.legend(lines1 + lines2, labels1 + labels2, loc='upper left')
            
            # Create canvas
            self.canvas = FigureCanvasTkAgg(self.fig, master=parent)
            self.canvas.draw()
            self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
            
            # Create annotation for hover tooltip
            self.annot = self.ax.annotate("", xy=(0,0), xytext=(20,20),
                                         textcoords="offset points",
                                         bbox=dict(boxstyle="round", fc="yellow", alpha=0.9),
                                         arrowprops=dict(arrowstyle="->"))
            self.annot.set_visible(False)
            
            # Connect mouse motion event
            self.canvas.mpl_connect("motion_notify_event", self.on_hover)
        else:
            # Fallback to text display if matplotlib not available
            label = tk.Label(parent, text="Matplotlib not available.\nInstall matplotlib to view SNR history graph.",
                           font=('TkDefaultFont', 12))
            label.pack(pady=20)
        
        # Info label showing current data source
        self.info_frame = ttk.Frame(parent)
        self.info_frame.pack(fill=tk.X, padx=10, pady=5)
        
        self.source_label = ttk.Label(self.info_frame, text="Data Source: Audio Stream")
        self.source_label.pack(side=tk.LEFT, padx=5)
        
        self.current_snr_label = ttk.Label(self.info_frame, text="Current SNR: -- dB")
        self.current_snr_label.pack(side=tk.LEFT, padx=20)
        
        # Plot visibility checkboxes
        self.show_snr_var = tk.BooleanVar(value=True)
        self.show_raw_var = tk.BooleanVar(value=True)
        
        snr_check = ttk.Checkbutton(self.info_frame, text="SNR", variable=self.show_snr_var,
                                   command=self.update_plot_visibility)
        snr_check.pack(side=tk.LEFT, padx=5)
        
        power_check = ttk.Checkbutton(self.info_frame, text="Power", variable=self.show_raw_var,
                                     command=self.update_plot_visibility)
        power_check.pack(side=tk.LEFT, padx=5)
        
        # History length selector and Save CSV button (bottom right)
        # Pack from right to left: seconds label, dropdown, Save button
        ttk.Label(self.info_frame, text="seconds").pack(side=tk.RIGHT)
        self.history_var = tk.StringVar(value="10")
        history_combo = ttk.Combobox(self.info_frame, textvariable=self.history_var,
                                     values=["5", "10", "30", "60", "120", "300", "600"],
                                     state='readonly', width=8)
        history_combo.pack(side=tk.RIGHT, padx=5)
        history_combo.bind('<<ComboboxSelected>>', self.on_history_length_changed)
        
        # Save CSV button
        save_btn = ttk.Button(self.info_frame, text="Save CSV", command=self.save_to_csv)
        save_btn.pack(side=tk.RIGHT, padx=(0, 20))
        
        # Start update loop
        self.update_display()
    
    def on_history_length_changed(self, event=None):
        """Handle history length dropdown change."""
        try:
            new_length = int(self.history_var.get())
            self.history_length = new_length
            self.max_samples = new_length * 10  # 10 Hz sampling rate
            
            # Update deque max length (this will truncate if new length is shorter)
            self.timestamps = deque(self.timestamps, maxlen=self.max_samples)
            self.snr_values = deque(self.snr_values, maxlen=self.max_samples)
            self.baseband_values = deque(self.baseband_values, maxlen=self.max_samples)
            self.noise_values = deque(self.noise_values, maxlen=self.max_samples)
            
            # Update plot title and X-axis
            if MATPLOTLIB_AVAILABLE:
                self.ax.set_title(f'SNR History ({self.history_length} seconds)')
                self.ax.set_xlim(self.history_length, 0)
                self.canvas.draw_idle()
        except ValueError:
            pass  # Ignore invalid values
    
    def update_plot_visibility(self):
        """Update visibility of plot lines based on checkbox states."""
        if not MATPLOTLIB_AVAILABLE:
            return
        
        # Update line visibility
        show_snr = self.show_snr_var.get()
        show_raw = self.show_raw_var.get()
        
        self.snr_line.set_visible(show_snr)
        self.baseband_line.set_visible(show_raw)
        self.noise_line.set_visible(show_raw)
        
        # Update legend to only show visible lines
        lines = []
        labels = []
        if show_snr:
            lines.append(self.snr_line)
            labels.append('SNR')
        if show_raw:
            lines.append(self.baseband_line)
            labels.append('Baseband Power')
            lines.append(self.noise_line)
            labels.append('Noise Density')
        
        if lines:
            self.ax.legend(lines, labels, loc='upper left')
        else:
            self.ax.legend([], [])
        
        # Redraw canvas
        self.canvas.draw_idle()
    
    def on_hover(self, event):
        """Handle mouse hover to show tooltip with values."""
        if not MATPLOTLIB_AVAILABLE or event.inaxes not in [self.ax, self.ax2]:
            if self.annot.get_visible():
                self.annot.set_visible(False)
                self.canvas.draw_idle()
            return
        
        # Check if we have data
        if len(self.timestamps) == 0:
            return
        
        # Get mouse position in data coordinates
        x_mouse = event.xdata
        if x_mouse is None:
            return
        
        # Convert time_ago back to index
        # x_mouse is seconds ago, we need to find closest data point
        latest_time = self.timestamps[-1]
        time_ago_list = [(latest_time - t) for t in self.timestamps]
        
        # Find closest point
        closest_idx = None
        min_dist = float('inf')
        for i, t_ago in enumerate(time_ago_list):
            dist = abs(t_ago - x_mouse)
            if dist < min_dist:
                min_dist = dist
                closest_idx = i
        
        # Only show tooltip if mouse is reasonably close to a data point
        if closest_idx is not None and min_dist < (self.history_length * 0.05):  # Within 5% of history length
            # Get values at this index
            snr_val = self.snr_values[closest_idx]
            baseband_val = self.baseband_values[closest_idx]
            noise_val = self.noise_values[closest_idx]
            timestamp = self.timestamps[closest_idx]
            time_ago = time_ago_list[closest_idx]
            
            # Format tooltip text
            from datetime import datetime
            utc_time = datetime.utcfromtimestamp(timestamp).strftime('%H:%M:%S')
            
            tooltip_lines = [f"Time: {utc_time} UTC ({time_ago:.1f}s ago)"]
            
            if self.show_snr_var.get():
                tooltip_lines.append(f"SNR: {snr_val:.2f} dB")
            
            if self.show_raw_var.get() and baseband_val is not None and noise_val is not None:
                tooltip_lines.append(f"Baseband: {baseband_val:.2f} dBFS")
                tooltip_lines.append(f"Noise: {noise_val:.2f} dBFS")
            
            tooltip_text = "\n".join(tooltip_lines)
            
            # Update annotation
            self.annot.xy = (time_ago, snr_val)
            self.annot.set_text(tooltip_text)
            self.annot.set_visible(True)
            self.canvas.draw_idle()
        else:
            if self.annot.get_visible():
                self.annot.set_visible(False)
                self.canvas.draw_idle()
    
    def save_to_csv(self):
        """Save SNR history data to CSV file."""
        if len(self.timestamps) == 0:
            messagebox.showinfo("No Data", "No SNR data to save.")
            return
        
        # Ask user for filename
        default_filename = f"snr_history_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        filename = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
            initialfile=default_filename
        )
        
        if not filename:
            return  # User cancelled
        
        try:
            with open(filename, 'w', newline='') as csvfile:
                writer = csv.writer(csvfile)
                
                # Write header
                writer.writerow(['UTC Timestamp', 'Unix Timestamp', 'SNR (dB)', 'Baseband Power (dBFS)', 'Noise Density (dBFS)', 'Data Source'])
                
                # Get data source
                source = "Audio Stream" if self.parent_gui.signal_data_source.get() == "audio" else "Spectrum FFT"
                
                # Write data rows
                for timestamp, snr, baseband, noise in zip(self.timestamps, self.snr_values, self.baseband_values, self.noise_values):
                    utc_time = datetime.utcfromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
                    writer.writerow([utc_time, f"{timestamp:.3f}", f"{snr:.2f}", f"{baseband:.2f}", f"{noise:.2f}", source])
            
            messagebox.showinfo("Success", f"SNR data saved to:\n{filename}")
        
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save CSV file:\n{e}")
    
    def get_current_snr(self):
        """Get current SNR value based on selected data source.
        
        Returns:
            SNR value in dB, or None if not available
        """
        if not self.parent_gui.client or not self.parent_gui.connected:
            return None
        
        # Check which data source is selected
        use_audio_stream = self.parent_gui.signal_data_source.get() == "audio"
        
        if use_audio_stream:
            # Use audio stream data (version 2 protocol)
            baseband_power = getattr(self.parent_gui.client, 'baseband_power', -999.0)
            noise_density = getattr(self.parent_gui.client, 'noise_density', -999.0)
            
            if baseband_power > -999 and noise_density > -999:
                return baseband_power - noise_density
            else:
                return None
        else:
            # Use spectrum FFT data
            if hasattr(self.parent_gui, 'waterfall_spectrum') and self.parent_gui.waterfall_spectrum:
                try:
                    bw_low = int(self.parent_gui.bw_low_var.get())
                    bw_high = int(self.parent_gui.bw_high_var.get())
                    peak_db, floor_db, snr_db = self.parent_gui.waterfall_spectrum.get_bandwidth_signal(bw_low, bw_high)
                    return snr_db
                except (ValueError, AttributeError):
                    return None
            return None
    
    def update_display(self):
        """Update the SNR history display."""
        if not MATPLOTLIB_AVAILABLE:
            # Schedule next update
            self.parent.after(100, self.update_display)
            return
        
        # Get current SNR and signal quality values
        snr = self.get_current_snr()
        current_time = time.time()
        
        # Get baseband and noise values (only available from audio stream)
        baseband_power = -999.0
        noise_density = -999.0
        if self.parent_gui.client and self.parent_gui.connected:
            baseband_power = getattr(self.parent_gui.client, 'baseband_power', -999.0)
            noise_density = getattr(self.parent_gui.client, 'noise_density', -999.0)
        
        # Add to history if valid
        if snr is not None:
            self.timestamps.append(current_time)
            self.snr_values.append(snr)
            self.baseband_values.append(baseband_power if baseband_power > -999 else None)
            self.noise_values.append(noise_density if noise_density > -999 else None)
            
            # Update current SNR label
            self.current_snr_label.config(text=f"Current SNR: {snr:.1f} dB")
        else:
            self.current_snr_label.config(text="Current SNR: -- dB")
        
        # Update data source label
        source = "Audio Stream" if self.parent_gui.signal_data_source.get() == "audio" else "Spectrum FFT"
        self.source_label.config(text=f"Data Source: {source}")
        
        # Update plot if we have data
        if len(self.timestamps) > 0:
            # Convert timestamps to seconds ago
            latest_time = self.timestamps[-1]
            time_ago = [(latest_time - t) for t in self.timestamps]
            
            # Update SNR line data (left axis)
            self.snr_line.set_data(time_ago, list(self.snr_values))
            
            # Update baseband and noise line data (right axis)
            # Filter out None values for plotting
            baseband_filtered = [b if b is not None else float('nan') for b in self.baseband_values]
            noise_filtered = [n if n is not None else float('nan') for n in self.noise_values]
            self.baseband_line.set_data(time_ago, baseband_filtered)
            self.noise_line.set_data(time_ago, noise_filtered)
            
            # Auto-scale SNR Y axis based on data
            if len(self.snr_values) > 0:
                min_snr = min(self.snr_values)
                max_snr = max(self.snr_values)
                margin = (max_snr - min_snr) * 0.1 + 5  # 10% margin + 5 dB
                self.ax.set_ylim(min_snr - margin, max_snr + margin)
            
            # Auto-scale dBFS Y axis if we have baseband/noise data
            valid_dbfs = [v for v in baseband_filtered + noise_filtered if v is not None and not (isinstance(v, float) and v != v)]
            if len(valid_dbfs) > 0:
                min_dbfs = min(valid_dbfs)
                max_dbfs = max(valid_dbfs)
                margin = (max_dbfs - min_dbfs) * 0.1 + 5
                self.ax2.set_ylim(min_dbfs - margin, max_dbfs + margin)
            
            # Redraw canvas
            self.canvas.draw_idle()
        
        # Schedule next update (100ms = 10 Hz)
        self.parent.after(100, self.update_display)


def create_snr_history_window(parent_gui):
    """Create a standalone SNR history window.
    
    Args:
        parent_gui: Reference to main RadioGUI instance
    
    Returns:
        Tuple of (window, display) or (None, None) if matplotlib not available
    """
    if not MATPLOTLIB_AVAILABLE:
        from tkinter import messagebox
        messagebox.showerror("Error", "Matplotlib is required for SNR History.\n\nInstall with: pip install matplotlib")
        return None, None
    
    window = tk.Toplevel(parent_gui.root)
    window.title("SNR History")
    window.geometry("800x500")
    
    # Create display
    display = SNRHistoryDisplay(window, parent_gui)
    
    # Handle window close
    def on_closing():
        window.destroy()
        parent_gui.snr_history_window = None
        parent_gui.snr_history_display = None
        parent_gui.log_status("SNR history window closed")
    
    window.protocol("WM_DELETE_WINDOW", on_closing)
    
    return window, display
