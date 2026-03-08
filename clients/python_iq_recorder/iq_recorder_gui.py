#!/usr/bin/env python3
"""
IQ Stream Recorder GUI
Multi-stream IQ recording application with graphical interface
"""

import sys
import os
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import threading
import asyncio
import time
import json
import requests
from pathlib import Path
from typing import List, Optional, Dict

# Add parent directory to path to import radio_client
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

try:
    from radio_client import RadioClient
    RADIO_CLIENT_AVAILABLE = True
except ImportError:
    RADIO_CLIENT_AVAILABLE = False
    print("Warning: radio_client not available. Please ensure it's in the python path.")

from iq_stream_config import StreamConfig, StreamStatus, IQMode
from iq_file_manager import IQFileManager
from iq_spectrum_display import IQSpectrumDisplay
from iq_recording_client import IQRecordingClient
from iq_scheduler import IQScheduler, ScheduleEntry
from iq_scheduler_gui import SchedulerManagerDialog
from config_manager import ConfigManager


class AddStreamDialog:
    """Dialog for adding a new IQ stream"""
    
    def __init__(self, parent, file_manager: IQFileManager, next_stream_id: int):
        self.result = None
        self.file_manager = file_manager
        self.next_stream_id = next_stream_id
        
        # Create dialog window
        self.dialog = tk.Toplevel(parent)
        self.dialog.title("Add IQ Stream")
        self.dialog.geometry("750x400")
        self.dialog.transient(parent)
        self.dialog.grab_set()
        
        # Center on parent
        self.dialog.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width() // 2) - (self.dialog.winfo_width() // 2)
        y = parent.winfo_y() + (parent.winfo_height() // 2) - (self.dialog.winfo_height() // 2)
        self.dialog.geometry(f"+{x}+{y}")
        
        self.create_widgets()
    
    def create_widgets(self):
        """Create dialog widgets"""
        # Main frame
        main_frame = ttk.Frame(self.dialog, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Frequency
        ttk.Label(main_frame, text="Frequency (MHz):").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.freq_var = tk.StringVar(value="14.100")
        freq_entry = ttk.Entry(main_frame, textvariable=self.freq_var, width=20)
        freq_entry.grid(row=0, column=1, sticky=(tk.W, tk.E), pady=5)
        
        # Update displays when frequency changes
        self.freq_var.trace_add('write', lambda *args: self.update_displays())
        
        # Common frequencies (band centers based on UK allocations)
        freq_frame = ttk.Frame(main_frame)
        freq_frame.grid(row=1, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=5)
        ttk.Label(freq_frame, text="Quick select:").pack(side=tk.LEFT)
        
        # Calculate band centers from start/end frequencies
        common_freqs = [
            ("160m", "1.905"),   # Center of 1.810-2.000 MHz
            ("80m", "3.650"),    # Center of 3.500-3.800 MHz
            ("60m", "5.333"),    # Center of 5.259-5.407 MHz
            ("40m", "7.100"),    # Center of 7.000-7.200 MHz
            ("30m", "10.125"),   # Center of 10.100-10.150 MHz
            ("20m", "14.175"),   # Center of 14.000-14.350 MHz
            ("17m", "18.118"),   # Center of 18.068-18.168 MHz
            ("15m", "21.225"),   # Center of 21.000-21.450 MHz
            ("12m", "24.940"),   # Center of 24.890-24.990 MHz
            ("10m", "28.850")    # Center of 28.000-29.700 MHz
        ]
        
        for label, freq in common_freqs:
            btn = ttk.Button(freq_frame, text=label, width=6,
                           command=lambda f=freq: self.freq_var.set(f))
            btn.pack(side=tk.LEFT, padx=2)
        
        # IQ Mode
        ttk.Label(main_frame, text="IQ Mode:").grid(row=2, column=0, sticky=tk.W, pady=5)
        self.mode_var = tk.StringVar(value="iq96")
        mode_frame = ttk.Frame(main_frame)
        mode_frame.grid(row=2, column=1, sticky=(tk.W, tk.E), pady=5)
        
        # Update example filename and frequency range when mode changes
        self.mode_var.trace_add('write', lambda *args: self.update_displays())
        
        for mode in IQMode:
            rb = ttk.Radiobutton(mode_frame, text=f"{mode.mode_name} ({mode.bandwidth})",
                               variable=self.mode_var, value=mode.mode_name)
            rb.pack(anchor=tk.W)
        
        # Frequency Range Display
        ttk.Label(main_frame, text="Frequency Range:").grid(row=3, column=0, sticky=tk.W, pady=5)
        self.freq_range_var = tk.StringVar()
        freq_range_label = ttk.Label(main_frame, textvariable=self.freq_range_var,
                                     font=('Arial', 9, 'bold'), foreground='#0066cc')
        freq_range_label.grid(row=3, column=1, sticky=tk.W, pady=5)
        
        # Filename template
        ttk.Label(main_frame, text="Filename Template:").grid(row=4, column=0, sticky=tk.W, pady=5)
        self.template_var = tk.StringVar(value="default")
        template_combo = ttk.Combobox(main_frame, textvariable=self.template_var,
                                     values=["default", "timestamp", "frequency", "simple", "detailed"],
                                     state="readonly", width=18)
        template_combo.grid(row=4, column=1, sticky=tk.W, pady=5)
        
        # Update example when template changes
        template_combo.bind('<<ComboboxSelected>>', lambda e: self.update_example_filename())
        
        # Example filename (read-only)
        ttk.Label(main_frame, text="Example Filename:").grid(row=5, column=0, sticky=tk.W, pady=5)
        self.example_var = tk.StringVar()
        example_entry = ttk.Entry(main_frame, textvariable=self.example_var, width=50, state='readonly')
        example_entry.grid(row=5, column=1, sticky=(tk.W, tk.E), pady=5)
        
        ttk.Label(main_frame, text="(Actual filename will include timestamp when recording starts)",
                 font=('Arial', 8, 'italic')).grid(row=6, column=1, sticky=tk.W, pady=(0, 10))
        
        # Recording enabled checkbox
        ttk.Label(main_frame, text="Recording:").grid(row=7, column=0, sticky=tk.W, pady=5)
        self.recording_enabled_var = tk.BooleanVar(value=True)
        recording_check = ttk.Checkbutton(main_frame, text="Enable recording to disk",
                                         variable=self.recording_enabled_var)
        recording_check.grid(row=7, column=1, sticky=tk.W, pady=5)
        
        ttk.Label(main_frame, text="(Uncheck to preview spectrum without recording)",
                 font=('Arial', 8, 'italic')).grid(row=8, column=1, sticky=tk.W, pady=(0, 10))
        
        # Buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=9, column=0, columnspan=2, pady=20)
        
        ttk.Button(button_frame, text="Add Stream", command=self.add_stream).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Cancel", command=self.dialog.destroy).pack(side=tk.LEFT, padx=5)
        
        # Generate initial displays
        self.update_displays()
    
    def update_displays(self):
        """Update frequency range and example filename based on current settings"""
        try:
            freq_mhz = float(self.freq_var.get())
            freq_hz = int(freq_mhz * 1_000_000)
            mode_str = self.mode_var.get()
            template = self.template_var.get()
            
            # Get IQ mode to calculate bandwidth
            mode = IQMode.from_string(mode_str)
            bandwidth_hz = mode.sample_rate / 2  # Nyquist: half the sample rate
            
            # Calculate start and end frequencies
            start_freq_hz = freq_hz - bandwidth_hz
            end_freq_hz = freq_hz + bandwidth_hz
            
            # Format frequency range display
            start_mhz = start_freq_hz / 1_000_000
            end_mhz = end_freq_hz / 1_000_000
            self.freq_range_var.set(f"{start_mhz:.6f} MHz - {end_mhz:.6f} MHz  (±{bandwidth_hz/1000:.0f} kHz)")
            
            # Update example filename
            filename = self.file_manager.generate_filename(
                freq_hz, mode_str, self.next_stream_id, template
            )
            self.example_var.set(filename)
        except ValueError:
            self.freq_range_var.set("(invalid frequency)")
            self.example_var.set("(invalid frequency)")
    
    def update_example_filename(self):
        """Update example filename - calls update_displays for compatibility"""
        self.update_displays()
    
    def add_stream(self):
        """Validate and add stream"""
        try:
            # Validate frequency
            freq_mhz = float(self.freq_var.get())
            if freq_mhz <= 0 or freq_mhz > 30000:
                messagebox.showerror("Invalid Frequency",
                                   "Frequency must be between 0 and 30000 MHz",
                                   parent=self.dialog)
                return
            
            freq_hz = int(freq_mhz * 1_000_000)
            
            # Validate mode
            mode = IQMode.from_string(self.mode_var.get())
            
            # Get template and recording enabled
            template = self.template_var.get()
            recording_enabled = self.recording_enabled_var.get()
            
            # Create result
            self.result = {
                'frequency': freq_hz,
                'iq_mode': mode,
                'filename_template': template,
                'recording_enabled': recording_enabled
            }
            
            self.dialog.destroy()
            
        except ValueError as e:
            messagebox.showerror("Invalid Input", str(e), parent=self.dialog)


class IQRecorderGUI:
    """Main GUI application for IQ stream recording"""
    
    def __init__(self, root):
        self.root = root
        self.root.title("UberSDR IQ Stream Recorder")
        
        # Initialize configuration manager with auto-save enabled
        self.config_manager = ConfigManager(auto_save=True)
        
        # Configuration variables (linked to config manager)
        self.host = tk.StringVar(value=self.config_manager.get_host())
        self.port = tk.IntVar(value=self.config_manager.get_port())
        self.recording_dir = tk.StringVar(value=self.config_manager.get_recording_dir())
        self.duration = tk.IntVar(value=self.config_manager.get_duration())
        
        # Set up traces to auto-save when values change
        self.host.trace_add('write', lambda *args: self._on_host_changed())
        self.port.trace_add('write', lambda *args: self._on_port_changed())
        self.recording_dir.trace_add('write', lambda *args: self._on_recording_dir_changed())
        self.duration.trace_add('write', lambda *args: self._on_duration_changed())
        
        # Stream management
        self.streams: List[StreamConfig] = []
        self.next_stream_id = 1
        self.file_manager = IQFileManager(self.recording_dir.get())
        
        # Spectrum windows and displays
        self.spectrum_windows: Dict[int, tk.Toplevel] = {}  # stream_id -> window
        self.spectrum_displays: Dict[int, IQSpectrumDisplay] = {}  # stream_id -> display
        
        # Scheduler
        self.scheduler = IQScheduler()
        self.scheduler.on_start_streams = self.handle_schedule_start
        self.scheduler.on_stop_streams = self.handle_schedule_stop
        
        # Update timer
        self.update_timer = None
        
        # Load saved streams and schedules
        self._load_saved_configuration()
        
        # Create UI
        self.create_widgets()
        self.create_menu()
        
        # Restore window geometry if saved
        saved_geometry = self.config_manager.get_window_geometry()
        if saved_geometry:
            try:
                self.root.geometry(saved_geometry)
            except:
                self.root.geometry("1000x600")
        else:
            self.root.geometry("1000x600")
        
        # Start update loop
        self.schedule_update()
        
        # Start scheduler
        self.scheduler.start()
        
        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)
    
    def create_menu(self):
        """Create menu bar"""
        menubar = tk.Menu(self.root)
        self.root.config(menu=menubar)
        
        # File menu
        file_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="File", menu=file_menu)
        file_menu.add_command(label="Set Recording Directory...", command=self.set_recording_directory)
        file_menu.add_separator()
        file_menu.add_command(label="Load Configuration...", command=self.load_configuration)
        file_menu.add_command(label="Save Configuration...", command=self.save_configuration)
        file_menu.add_separator()
        file_menu.add_command(label="Manage Schedules...", command=self.show_scheduler_dialog)
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.on_closing)
        
        # Help menu
        help_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="Help", menu=help_menu)
        help_menu.add_command(label="About", command=self.show_about)
    
    def create_widgets(self):
        """Create main UI widgets"""
        # Connection frame
        conn_frame = ttk.LabelFrame(self.root, text="Server Connection", padding="5")
        conn_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), padx=5, pady=5)
        
        ttk.Label(conn_frame, text="Host:").grid(row=0, column=0, sticky=tk.W, padx=5)
        ttk.Entry(conn_frame, textvariable=self.host, width=20).grid(row=0, column=1, padx=5)
        
        ttk.Label(conn_frame, text="Port:").grid(row=0, column=2, sticky=tk.W, padx=5)
        ttk.Entry(conn_frame, textvariable=self.port, width=10).grid(row=0, column=3, padx=5)
        
        ttk.Button(conn_frame, text="Test", command=self.test_connection).grid(row=0, column=4, padx=5)
        
        ttk.Label(conn_frame, text="Record To:").grid(row=0, column=5, sticky=tk.W, padx=5)
        ttk.Entry(conn_frame, textvariable=self.recording_dir, width=30).grid(row=0, column=6, padx=5)
        ttk.Button(conn_frame, text="Browse...", command=self.browse_directory).grid(row=0, column=7, padx=5)
        ttk.Button(conn_frame, text="Open", command=self.open_recording_directory).grid(row=0, column=8, padx=5)
        
        # Streams frame
        streams_frame = ttk.LabelFrame(self.root, text="IQ Streams", padding="5")
        streams_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), padx=5, pady=5)
        
        # Configure grid weights
        self.root.rowconfigure(1, weight=1)
        self.root.columnconfigure(0, weight=1)
        streams_frame.rowconfigure(0, weight=1)
        streams_frame.columnconfigure(0, weight=1)
        
        # Stream list (Treeview)
        columns = ('id', 'frequency', 'mode', 'file', 'recording', 'status', 'duration', 'size', 'spectrum')
        self.stream_tree = ttk.Treeview(streams_frame, columns=columns, show='headings', height=15)
        
        # Column headings
        self.stream_tree.heading('id', text='#')
        self.stream_tree.heading('frequency', text='Frequency')
        self.stream_tree.heading('mode', text='Mode')
        self.stream_tree.heading('file', text='Template/File')
        self.stream_tree.heading('recording', text='Recording')
        self.stream_tree.heading('status', text='Status')
        self.stream_tree.heading('duration', text='Duration')
        self.stream_tree.heading('size', text='Size')
        self.stream_tree.heading('spectrum', text='Spectrum')
        
        # Column widths
        self.stream_tree.column('id', width=40)
        self.stream_tree.column('frequency', width=120)
        self.stream_tree.column('mode', width=80)
        self.stream_tree.column('file', width=200)
        self.stream_tree.column('recording', width=80)
        self.stream_tree.column('status', width=100)
        self.stream_tree.column('duration', width=100)
        self.stream_tree.column('size', width=100)
        self.stream_tree.column('spectrum', width=80)

        # Configure row tags for colored backgrounds
        self.stream_tree.tag_configure('recording', background='#ffcccc')  # Light red
        self.stream_tree.tag_configure('monitoring', background='#ccffcc')  # Light green

        # Scrollbar
        scrollbar = ttk.Scrollbar(streams_frame, orient=tk.VERTICAL, command=self.stream_tree.yview)
        self.stream_tree.configure(yscrollcommand=scrollbar.set)

        self.stream_tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        
        # Context menu for stream list
        self.stream_menu = tk.Menu(self.root, tearoff=0)
        self.stream_menu.add_command(label="Start", command=self.start_selected_stream)
        self.stream_menu.add_command(label="Stop", command=self.stop_selected_stream)
        self.stream_menu.add_separator()
        self.stream_menu.add_command(label="Toggle Recording", command=self.toggle_recording_for_selected)
        self.stream_menu.add_separator()
        self.stream_menu.add_command(label="Toggle Spectrum", command=self.toggle_spectrum_for_selected)
        self.stream_menu.add_separator()
        self.stream_menu.add_command(label="Remove", command=self.remove_selected_stream)
        
        self.stream_tree.bind("<Button-3>", self.show_stream_menu)
        self.stream_tree.bind("<Button-1>", self.on_tree_click)
        self.stream_tree.bind("<Double-1>", self.on_tree_double_click)
        
        # Control buttons frame
        control_frame = ttk.Frame(self.root, padding="5")
        control_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), padx=5, pady=5)
        
        ttk.Button(control_frame, text="Add Stream", command=self.add_stream).pack(side=tk.LEFT, padx=5)
        ttk.Button(control_frame, text="Start All", command=self.start_all_streams).pack(side=tk.LEFT, padx=5)
        
        # Duration input
        ttk.Label(control_frame, text="Duration (s):").pack(side=tk.LEFT, padx=(10, 2))
        duration_spinbox = ttk.Spinbox(control_frame, from_=0, to=86400, textvariable=self.duration, width=8)
        duration_spinbox.pack(side=tk.LEFT, padx=2)
        ttk.Label(control_frame, text="(0 = no limit)").pack(side=tk.LEFT, padx=(2, 10))
        
        ttk.Button(control_frame, text="Stop All", command=self.stop_all_streams).pack(side=tk.LEFT, padx=5)
        ttk.Button(control_frame, text="Remove All", command=self.remove_all_streams).pack(side=tk.LEFT, padx=5)

        # Legend frame
        legend_frame = ttk.Frame(control_frame)
        legend_frame.pack(side=tk.LEFT, padx=20)

        # Recording legend
        recording_label = tk.Label(legend_frame, text=" Recording ", bg='#ffcccc', relief=tk.RIDGE, padx=5)
        recording_label.pack(side=tk.LEFT, padx=2)

        # Monitoring legend
        monitoring_label = tk.Label(legend_frame, text=" Monitoring ", bg='#ccffcc', relief=tk.RIDGE, padx=5)
        monitoring_label.pack(side=tk.LEFT, padx=2)

        # Schedules button on the right edge
        ttk.Button(control_frame, text="📅 Schedules", command=self.show_scheduler_dialog).pack(side=tk.RIGHT, padx=5)
        
        # Status bar
        self.status_var = tk.StringVar(value="Ready")
        status_bar = ttk.Label(self.root, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        status_bar.grid(row=3, column=0, sticky=(tk.W, tk.E), padx=5, pady=2)
    
    def _on_host_changed(self):
        """Handle host change - auto-save"""
        try:
            self.config_manager.set_host(self.host.get())
        except:
            pass  # Ignore errors during initialization
    
    def _on_port_changed(self):
        """Handle port change - auto-save"""
        try:
            self.config_manager.set_port(self.port.get())
        except:
            pass  # Ignore errors during initialization
    
    def _on_recording_dir_changed(self):
        """Handle recording directory change - auto-save"""
        try:
            self.config_manager.set_recording_dir(self.recording_dir.get())
        except:
            pass  # Ignore errors during initialization
    
    def _on_duration_changed(self):
        """Handle duration change - auto-save"""
        try:
            self.config_manager.set_duration(self.duration.get())
        except:
            pass  # Ignore errors during initialization
    
    def _load_saved_configuration(self):
        """Load saved streams and schedules from config manager"""
        # Load streams
        saved_streams = self.config_manager.get_streams()
        for stream_data in saved_streams:
            try:
                stream = StreamConfig.from_dict(stream_data)
                self.streams.append(stream)
                if stream.stream_id >= self.next_stream_id:
                    self.next_stream_id = stream.stream_id + 1
            except Exception as e:
                print(f"Error loading stream: {e}")
        
        # Load schedules
        saved_schedules = self.config_manager.get_schedules()
        for schedule_data in saved_schedules:
            try:
                schedule = ScheduleEntry.from_dict(schedule_data)
                self.scheduler.add_schedule(schedule)
            except Exception as e:
                print(f"Error loading schedule: {e}")
    
    def _save_streams_to_config(self):
        """Save current streams to config manager"""
        streams_data = [s.to_dict() for s in self.streams]
        self.config_manager.set_streams(streams_data)
    
    def _save_schedules_to_config(self):
        """Save current schedules to config manager"""
        schedules_data = [s.to_dict() for s in self.scheduler.schedules]
        self.config_manager.set_schedules(schedules_data)
    
    def test_connection(self):
        """Test connection to server and display /connection endpoint results"""
        host = self.host.get()
        port = self.port.get()
        
        if not host:
            messagebox.showerror("Error", "Please enter a host address")
            return
        
        # Run test in background thread to avoid blocking GUI
        thread = threading.Thread(target=self._test_connection_thread, args=(host, port), daemon=True)
        thread.start()
    
    def _test_connection_thread(self, host: str, port: int):
        """Background thread for connection test"""
        try:
            # Build URL
            url = f"http://{host}:{port}/connection"
            
            # Prepare request body (similar to radio_client.py)
            import uuid
            request_body = {
                "user_session_id": str(uuid.uuid4())  # Generate temporary session ID for test
            }
            
            # Make POST request with timeout
            response = requests.post(
                url,
                json=request_body,
                headers={
                    'Content-Type': 'application/json',
                    'User-Agent': 'UberSDR IQ Recorder (python)'
                },
                timeout=5
            )
            response.raise_for_status()
            
            # Parse JSON response
            data = response.json()
            
            # Schedule display in main thread
            self.root.after(0, lambda: self._show_connection_results(data, None))
            
        except requests.exceptions.Timeout:
            self.root.after(0, lambda: self._show_connection_results(None, "Connection timeout - server not responding"))
        except requests.exceptions.ConnectionError:
            error_msg = f"Connection failed - cannot reach {host}:{port}"
            self.root.after(0, lambda msg=error_msg: self._show_connection_results(None, msg))
        except requests.exceptions.HTTPError as e:
            error_msg = f"HTTP Error: {e}"
            self.root.after(0, lambda msg=error_msg: self._show_connection_results(None, msg))
        except json.JSONDecodeError:
            self.root.after(0, lambda: self._show_connection_results(None, "Invalid JSON response from server"))
        except Exception as e:
            error_msg = f"Error: {str(e)}"
            self.root.after(0, lambda msg=error_msg: self._show_connection_results(None, msg))
    
    def _show_connection_results(self, data: Optional[dict], error: Optional[str]):
        """Display connection test results in a dialog"""
        # Create dialog
        dialog = tk.Toplevel(self.root)
        dialog.title("Connection Test Results")
        dialog.geometry("650x500")
        dialog.transient(self.root)
        
        # Center on parent
        dialog.update_idletasks()
        x = self.root.winfo_x() + (self.root.winfo_width() // 2) - (dialog.winfo_width() // 2)
        y = self.root.winfo_y() + (self.root.winfo_height() // 2) - (dialog.winfo_height() // 2)
        dialog.geometry(f"+{x}+{y}")
        
        # Main frame
        main_frame = ttk.Frame(dialog, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        if error:
            # Show error
            ttk.Label(main_frame, text="Connection Test Failed",
                     font=('Arial', 12, 'bold'), foreground='red').pack(pady=10)
            
            error_frame = ttk.Frame(main_frame)
            error_frame.pack(fill=tk.BOTH, expand=True, pady=10)
            
            error_text = tk.Text(error_frame, wrap=tk.WORD, height=10, width=70)
            error_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
            
            scrollbar = ttk.Scrollbar(error_frame, orient=tk.VERTICAL, command=error_text.yview)
            scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
            error_text.configure(yscrollcommand=scrollbar.set)
            
            error_text.insert('1.0', error)
            error_text.configure(state='disabled')
        else:
            # Show success and data
            allowed = data.get('allowed', False)
            status_text = "Connection Allowed" if allowed else "Connection Denied"
            status_color = 'green' if allowed else 'red'
            
            ttk.Label(main_frame, text=status_text,
                     font=('Arial', 12, 'bold'), foreground=status_color).pack(pady=10)
            
            # Create formatted display frame
            info_frame = ttk.LabelFrame(main_frame, text="Connection Information", padding="10")
            info_frame.pack(fill=tk.BOTH, expand=True, pady=10)
            
            # Format session_timeout
            session_timeout = data.get('session_timeout', 0)
            if session_timeout == 0:
                session_timeout_str = "Unlimited"
            else:
                hours = session_timeout // 3600
                minutes = (session_timeout % 3600) // 60
                seconds = session_timeout % 60
                session_timeout_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
            
            # Format max_session_time
            max_session_time = data.get('max_session_time', 0)
            if max_session_time == 0:
                max_session_time_str = "Unlimited"
            else:
                hours = max_session_time // 3600
                minutes = (max_session_time % 3600) // 60
                seconds = max_session_time % 60
                max_session_time_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
            
            # Display key information
            info_text = tk.Text(info_frame, wrap=tk.WORD, height=12, width=70, font=('Courier', 10))
            info_text.pack(fill=tk.BOTH, expand=True)
            
            # Build formatted output
            output = []
            output.append(f"Client IP:           {data.get('client_ip', 'N/A')}")
            output.append(f"Connection Allowed:  {data.get('allowed', False)}")
            output.append(f"Session Timeout:     {session_timeout_str}")
            output.append(f"Max Session Time:    {max_session_time_str}")
            output.append(f"Bypassed:            {data.get('bypassed', False)}")
            output.append("")
            output.append("Allowed IQ Modes:")
            
            allowed_modes = data.get('allowed_iq_modes', [])
            if allowed_modes:
                for mode in allowed_modes:
                    output.append(f"  • {mode}")
            else:
                output.append("  (none)")
            
            info_text.insert('1.0', '\n'.join(output))
            info_text.configure(state='disabled')
        
        # Close button
        ttk.Button(main_frame, text="Close", command=dialog.destroy).pack(pady=10)
    
    def browse_directory(self):
        """Browse for recording directory"""
        directory = filedialog.askdirectory(
            title="Select Recording Directory",
            initialdir=self.recording_dir.get()
        )
        if directory:
            self.recording_dir.set(directory)
            self.file_manager.set_base_directory(directory)
            # Auto-save is triggered by the trace on recording_dir
    
    def open_recording_directory(self):
        """Open recording directory in native file explorer"""
        import subprocess
        import platform

        directory = self.recording_dir.get()

        # Check if directory exists
        if not os.path.exists(directory):
            messagebox.showerror("Directory Not Found",
                               f"Recording directory does not exist:\n{directory}")
            return

        try:
            system = platform.system()
            if system == "Windows":
                os.startfile(directory)
            elif system == "Darwin":  # macOS
                subprocess.Popen(["open", directory])
            else:  # Linux and other Unix-like systems
                subprocess.Popen(["xdg-open", directory])
        except Exception as e:
            messagebox.showerror("Error Opening Directory",
                               f"Failed to open directory:\n{str(e)}")

    def add_stream(self):
        """Add a new stream"""
        dialog = AddStreamDialog(self.root, self.file_manager, self.next_stream_id)
        self.root.wait_window(dialog.dialog)
        
        if dialog.result:
            stream = StreamConfig(
                stream_id=self.next_stream_id,
                frequency=dialog.result['frequency'],
                iq_mode=dialog.result['iq_mode'],
                filename_template=dialog.result['filename_template'],
                recording_enabled=dialog.result.get('recording_enabled', True)
            )
            
            self.streams.append(stream)
            self.next_stream_id += 1
            self.update_stream_list()
            self.update_status()
            
            # Auto-save streams configuration
            self._save_streams_to_config()
    
    def remove_selected_stream(self):
        """Remove selected stream"""
        selection = self.stream_tree.selection()
        if not selection:
            return
        
        item = selection[0]
        stream_id = int(self.stream_tree.item(item)['values'][0])
        
        # Find stream
        stream = next((s for s in self.streams if s.stream_id == stream_id), None)
        if not stream:
            return
        
        # Stop if recording
        if stream.status == StreamStatus.RECORDING:
            if not messagebox.askyesno("Stop Recording",
                                      "Stream is recording. Stop and remove?"):
                return
            self.stop_stream(stream)
        
        # Remove from list
        self.streams.remove(stream)
        self.update_stream_list()
        self.update_status()
        
        # Auto-save streams configuration
        self._save_streams_to_config()
    
    def remove_all_streams(self):
        """Remove all streams"""
        if not self.streams:
            return
        
        if not messagebox.askyesno("Remove All",
                                  "Remove all streams? Active recordings will be stopped."):
            return
        
        # Stop all recording streams
        for stream in self.streams:
            if stream.status == StreamStatus.RECORDING:
                self.stop_stream(stream)
        
        self.streams.clear()
        self.update_stream_list()
        self.update_status()
        
        # Auto-save streams configuration
        self._save_streams_to_config()
    
    def start_selected_stream(self):
        """Start selected stream"""
        selection = self.stream_tree.selection()
        if not selection:
            return
        
        item = selection[0]
        stream_id = int(self.stream_tree.item(item)['values'][0])
        
        stream = next((s for s in self.streams if s.stream_id == stream_id), None)
        if stream:
            self.start_stream(stream)
    
    def stop_selected_stream(self):
        """Stop selected stream"""
        selection = self.stream_tree.selection()
        if not selection:
            return
        
        item = selection[0]
        stream_id = int(self.stream_tree.item(item)['values'][0])
        
        stream = next((s for s in self.streams if s.stream_id == stream_id), None)
        if stream:
            self.stop_stream(stream)
    
    def start_stream(self, stream: StreamConfig):
        """Start recording a stream"""
        if not RADIO_CLIENT_AVAILABLE:
            messagebox.showerror("Error", "RadioClient not available. Check installation.")
            return
        
        if stream.status == StreamStatus.RECORDING:
            return
        
        # Generate actual filename from template (only if recording is enabled)
        if stream.recording_enabled:
            base_dir = self.recording_dir.get()
            filename = self.file_manager.generate_filename(
                stream.frequency,
                stream.iq_mode.mode_name,
                stream.stream_id,
                stream.filename_template
            )
            stream.output_file = os.path.join(base_dir, filename)
            
            # Create recording directory if needed
            os.makedirs(os.path.dirname(stream.output_file), exist_ok=True)
        else:
            stream.output_file = None
        
        stream.status = StreamStatus.CONNECTING
        stream.start_time = time.time()
        stream.stop_time = None
        stream.bytes_recorded = 0
        
        # Get duration from GUI (0 = no limit)
        duration_seconds = self.duration.get()
        duration = duration_seconds if duration_seconds > 0 else None
        
        # Start recording thread
        thread = threading.Thread(target=self.record_stream_thread, args=(stream, duration), daemon=True)
        stream.thread = thread
        thread.start()
        
        self.update_stream_list()
    
    def record_stream_thread(self, stream: StreamConfig, duration: int = None):
        """Thread function for recording a stream"""
        try:
            # Create new event loop for this thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            # Create IQ callback for spectrum display
            def iq_callback(i_samples, q_samples):
                if stream.stream_id in self.spectrum_displays:
                    self.spectrum_displays[stream.stream_id].add_iq_samples(i_samples, q_samples)
            
            # Create IQ recording client with spectrum callback
            # If recording is disabled, pass None for wav_file to skip writing
            # IMPORTANT: Must pass sample_rate explicitly for IQ modes to ensure WAV header is correct
            client = IQRecordingClient(
                host=self.host.get(),
                port=self.port.get(),
                frequency=stream.frequency,
                mode=stream.iq_mode.mode_name,
                output_mode='wav' if stream.recording_enabled else None,
                wav_file=stream.output_file if stream.recording_enabled else None,
                duration=duration,  # None = record until stopped, or specified seconds
                iq_callback=iq_callback
            )
            
            # Override sample rate with the correct IQ mode sample rate
            # RadioClient defaults to 12 kHz, but IQ modes have specific rates
            client.sample_rate = stream.iq_mode.sample_rate
            
            stream.client = client
            stream.status = StreamStatus.RECORDING
            
            # Run client
            loop.run_until_complete(client.run())
            
        except Exception as e:
            stream.status = StreamStatus.ERROR
            stream.error_message = str(e)
            print(f"Error recording stream {stream.stream_id}: {e}")
        finally:
            stream.status = StreamStatus.STOPPED
            stream.stop_time = time.time()
            stream.client = None
    
    def stop_stream(self, stream: StreamConfig):
        """Stop recording a stream"""
        if stream.status != StreamStatus.RECORDING:
            return
        
        stream.status = StreamStatus.STOPPING
        
        # Stop client
        if stream.client:
            stream.client.running = False
        
        self.update_stream_list()
    
    def start_all_streams(self):
        """Start all idle streams"""
        for stream in self.streams:
            if stream.status == StreamStatus.IDLE or stream.status == StreamStatus.STOPPED:
                self.start_stream(stream)
    
    def stop_all_streams(self):
        """Stop all recording streams"""
        for stream in self.streams:
            if stream.status == StreamStatus.RECORDING:
                self.stop_stream(stream)
    
    def on_tree_click(self, event):
        """Handle single-click on tree item"""
        # Check if clicked on spectrum column
        column = self.stream_tree.identify_column(event.x)
        if column == '#9':  # Spectrum column (0-indexed, so #9 is the 9th column)
            # Select the row first
            item = self.stream_tree.identify_row(event.y)
            if item:
                self.stream_tree.selection_set(item)
                self.toggle_spectrum_for_selected()
    
    def on_tree_double_click(self, event):
        """Handle double-click on tree item"""
        # Check if clicked on spectrum column
        column = self.stream_tree.identify_column(event.x)
        if column == '#9':  # Spectrum column - ignore double-click, single-click handles it
            return
        else:
            self.start_selected_stream()
    
    def toggle_recording_for_selected(self):
        """Toggle recording enabled for selected stream"""
        selection = self.stream_tree.selection()
        if not selection:
            return
        
        item = selection[0]
        stream_id = int(self.stream_tree.item(item)['values'][0])
        
        stream = next((s for s in self.streams if s.stream_id == stream_id), None)
        if stream:
            # Can't toggle while recording
            if stream.status == StreamStatus.RECORDING:
                messagebox.showinfo("Cannot Toggle",
                                  "Stop the stream before toggling recording.",
                                  parent=self.root)
                return
            
            # Toggle recording enabled
            stream.recording_enabled = not stream.recording_enabled
            self.update_stream_list()
            
            # Auto-save streams configuration
            self._save_streams_to_config()
    
    def toggle_spectrum_for_selected(self):
        """Toggle spectrum window for selected stream"""
        selection = self.stream_tree.selection()
        if not selection:
            return
        
        item = selection[0]
        stream_id = int(self.stream_tree.item(item)['values'][0])
        
        stream = next((s for s in self.streams if s.stream_id == stream_id), None)
        if stream:
            self.toggle_spectrum(stream)
    
    def toggle_spectrum(self, stream: StreamConfig):
        """Toggle spectrum window for a stream"""
        # Check if window already exists
        if stream.stream_id in self.spectrum_windows:
            # Close existing window
            try:
                if stream.stream_id in self.spectrum_displays:
                    self.spectrum_displays[stream.stream_id].stop()
                    del self.spectrum_displays[stream.stream_id]
                self.spectrum_windows[stream.stream_id].destroy()
            except:
                pass
            if stream.stream_id in self.spectrum_windows:
                del self.spectrum_windows[stream.stream_id]
        else:
            # Create new spectrum window
            if stream.status != StreamStatus.RECORDING:
                messagebox.showinfo("Stream Not Recording",
                                  "Start recording the stream first to view spectrum.")
                return
            
            # Create spectrum window (20% wider: 800 * 1.20 = 960)
            spectrum_window = tk.Toplevel(self.root)
            spectrum_window.title(f"Spectrum - {stream.frequency_mhz:.3f} MHz ({stream.iq_mode.mode_name.upper()})")
            spectrum_window.geometry("960x450")
            
            # Create spectrum display
            try:
                spectrum = IQSpectrumDisplay(
                    spectrum_window,
                    width=960,
                    height=400,
                    sample_rate=stream.iq_mode.sample_rate,
                    center_freq=stream.frequency
                )
                
                # Store references
                self.spectrum_windows[stream.stream_id] = spectrum_window
                self.spectrum_displays[stream.stream_id] = spectrum
                
                # Handle window close
                def on_close():
                    if stream.stream_id in self.spectrum_displays:
                        self.spectrum_displays[stream.stream_id].stop()
                        del self.spectrum_displays[stream.stream_id]
                    if stream.stream_id in self.spectrum_windows:
                        del self.spectrum_windows[stream.stream_id]
                    spectrum_window.destroy()
                
                spectrum_window.protocol("WM_DELETE_WINDOW", on_close)
                
            except Exception as e:
                messagebox.showerror("Error", f"Failed to create spectrum display: {e}")
                if stream.stream_id in self.spectrum_windows:
                    del self.spectrum_windows[stream.stream_id]
                if stream.stream_id in self.spectrum_displays:
                    del self.spectrum_displays[stream.stream_id]
    
    def show_stream_menu(self, event):
        """Show context menu for stream"""
        item = self.stream_tree.identify_row(event.y)
        if item:
            self.stream_tree.selection_set(item)
            self.stream_menu.tk_popup(event.x_root, event.y_root, 0)
    
    def update_stream_list(self):
        """Update stream list display"""
        # Save current selection
        selected_items = self.stream_tree.selection()
        selected_stream_ids = []
        for item in selected_items:
            try:
                stream_id = int(self.stream_tree.item(item)['values'][0])
                selected_stream_ids.append(stream_id)
            except (IndexError, ValueError):
                pass
        
        # Clear existing items
        for item in self.stream_tree.get_children():
            self.stream_tree.delete(item)
        
        # Add streams and restore selection
        for stream in self.streams:
            # Get file size if exists and recording
            try:
                if stream.output_file and os.path.exists(stream.output_file):
                    stream.bytes_recorded = os.path.getsize(stream.output_file)
            except Exception:
                pass
            
            # Spectrum button text - use symbols to make it more button-like
            spectrum_text = "🔲 Close" if stream.stream_id in self.spectrum_windows else "📊 Show"
            
            # Show template if not recording, filename if recording
            if stream.output_file and stream.status == StreamStatus.RECORDING:
                file_display = os.path.basename(stream.output_file)
            else:
                file_display = f"[{stream.filename_template}]"
            
            # Recording status
            recording_status = "✓ Yes" if stream.recording_enabled else "✗ No"
            
            # Status display - show "Monitoring" instead of "Recording" when recording is disabled
            if stream.status == StreamStatus.RECORDING and not stream.recording_enabled:
                status_display = "Monitoring"
            else:
                status_display = stream.status.value
            
            values = (
                stream.stream_id,
                f"{stream.frequency_mhz:.3f} MHz",
                stream.iq_mode.mode_name.upper(),
                file_display,
                recording_status,
                status_display,
                stream.format_duration(),
                stream.format_size(),
                spectrum_text
            )

            # Determine row tag based on status
            row_tags = ()
            if stream.status == StreamStatus.RECORDING:
                if stream.recording_enabled:
                    row_tags = ('recording',)  # Red background for recording
                else:
                    row_tags = ('monitoring',)  # Green background for monitoring

            item_id = self.stream_tree.insert('', tk.END, values=values, tags=row_tags)

            # Restore selection if this stream was selected
            if stream.stream_id in selected_stream_ids:
                self.stream_tree.selection_add(item_id)
    
    def update_status(self):
        """Update status bar"""
        active_count = sum(1 for s in self.streams if s.status == StreamStatus.RECORDING)
        total_count = len(self.streams)
        
        disk_space = self.file_manager.get_disk_space_summary()
        
        # Add scheduler status
        schedule_status = ""
        if self.scheduler.has_active_schedules():
            next_event = self.scheduler.get_next_event()
            if next_event:
                schedule, next_time, action = next_event
                from datetime import datetime
                time_until = next_time - datetime.now()
                hours = int(time_until.total_seconds() // 3600)
                minutes = int((time_until.total_seconds() % 3600) // 60)
                seconds = int(time_until.total_seconds() % 60)
                action_str = "starts" if action == "start" else "stops"
                schedule_status = f" | Next: {schedule.name} {action_str} in {hours}h {minutes}m {seconds}s"
        
        self.status_var.set(f"Streams: {active_count}/{total_count} recording | {disk_space}{schedule_status}")
    
    def schedule_update(self):
        """Schedule periodic UI update"""
        self.update_stream_list()
        self.update_status()
        self.update_timer = self.root.after(1000, self.schedule_update)
    
    def set_recording_directory(self):
        """Set recording directory"""
        self.browse_directory()
    
    def load_configuration(self):
        """Load configuration from file"""
        filename = filedialog.askopenfilename(
            title="Load Configuration",
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        
        if not filename:
            return
        
        try:
            # Import configuration from file
            if self.config_manager.import_from_file(filename):
                # Reload all settings from config manager
                self.host.set(self.config_manager.get_host())
                self.port.set(self.config_manager.get_port())
                self.recording_dir.set(self.config_manager.get_recording_dir())
                self.duration.set(self.config_manager.get_duration())
                self.file_manager.set_base_directory(self.recording_dir.get())
                
                # Reload streams
                self.streams.clear()
                self.next_stream_id = 1
                self._load_saved_configuration()
                
                # Clean up the config by re-saving streams (removes old host/port fields)
                self._save_streams_to_config()
                
                self.update_stream_list()
                self.update_status()
                
                messagebox.showinfo("Success", "Configuration loaded successfully")
            else:
                messagebox.showerror("Error", "Failed to load configuration")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to load configuration: {e}")
    
    def save_configuration(self):
        """Save configuration to file"""
        filename = filedialog.asksaveasfilename(
            title="Save Configuration",
            defaultextension=".json",
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        
        if not filename:
            return
        
        try:
            # Export current configuration to file
            if self.config_manager.export_to_file(filename):
                messagebox.showinfo("Success", "Configuration saved successfully")
            else:
                messagebox.showerror("Error", "Failed to save configuration")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save configuration: {e}")
    
    def show_about(self):
        """Show about dialog"""
        messagebox.showinfo(
            "About UberSDR IQ Stream Recorder",
            "UberSDR IQ Stream Recorder v1.0\n\n"
            "Multi-stream IQ recording application for ka9q_ubersdr\n\n"
            "Supports IQ48, IQ96, and IQ192 modes\n"
            "Record unlimited simultaneous streams\n\n"
            "© 2026"
        )
    
    def on_closing(self):
        """Handle window close"""
        # Check for active recordings (only count streams with recording enabled)
        active_streams = [s for s in self.streams if s.status == StreamStatus.RECORDING and s.recording_enabled]
        
        if active_streams:
            if not messagebox.askyesno("Active Recordings",
                                      f"{len(active_streams)} stream(s) are recording. Stop and exit?"):
                return
            
            # Stop all streams
            self.stop_all_streams()
            
            # Wait a bit for threads to finish
            time.sleep(1)
        
        # Save window geometry
        try:
            geometry = self.root.geometry()
            self.config_manager.set_window_geometry(geometry)
        except:
            pass
        
        # Final save of streams and schedules
        self._save_streams_to_config()
        self._save_schedules_to_config()
        
        # Cancel update timer
        if self.update_timer:
            self.root.after_cancel(self.update_timer)
        
        # Stop scheduler
        self.scheduler.stop()
        
        self.root.destroy()
    
    def show_scheduler_dialog(self):
        """Show scheduler management dialog"""
        dialog = SchedulerManagerDialog(self.root, self.scheduler, self.streams)
        self.root.wait_window(dialog.dialog)
        
        # Save schedules if changes were made
        if dialog.changes_made:
            self._save_schedules_to_config()
    
    def handle_schedule_start(self, schedule: ScheduleEntry):
        """Handle schedule start action (called from scheduler thread)"""
        # Use after() to execute in main thread
        self.root.after(0, lambda: self._execute_schedule_start(schedule))
    
    def handle_schedule_stop(self, schedule: ScheduleEntry):
        """Handle schedule stop action (called from scheduler thread)"""
        # Use after() to execute in main thread
        self.root.after(0, lambda: self._execute_schedule_stop(schedule))
    
    def _execute_schedule_start(self, schedule: ScheduleEntry):
        """Execute schedule start action (runs in main thread)"""
        executed_streams = []
        skipped_disabled = []
        skipped_running = []
        
        for stream_id in schedule.stream_ids:
            stream = next((s for s in self.streams if s.stream_id == stream_id), None)
            
            if not stream:
                continue
            
            # Check if recording is enabled
            if not stream.recording_enabled:
                skipped_disabled.append(stream_id)
                continue
            
            # Check if already recording
            if stream.status == StreamStatus.RECORDING:
                skipped_running.append(stream_id)
                continue
            
            # Start the stream
            self.start_stream(stream)
            executed_streams.append(stream_id)
        
        # Show notification
        if executed_streams or skipped_disabled:
            message_parts = []
            if executed_streams:
                message_parts.append(f"Started {len(executed_streams)} stream(s)")
            if skipped_disabled:
                message_parts.append(f"Skipped {len(skipped_disabled)} stream(s) (recording disabled)")
            if skipped_running:
                message_parts.append(f"Skipped {len(skipped_running)} stream(s) (already recording)")
            
            message = f"Schedule '{schedule.name}' executed:\n" + "\n".join(message_parts)
            print(message)  # Log to console
    
    def _execute_schedule_stop(self, schedule: ScheduleEntry):
        """Execute schedule stop action (runs in main thread)"""
        stopped_streams = []
        
        for stream_id in schedule.stream_ids:
            stream = next((s for s in self.streams if s.stream_id == stream_id), None)
            
            if not stream:
                continue
            
            # Stop if recording
            if stream.status == StreamStatus.RECORDING:
                self.stop_stream(stream)
                stopped_streams.append(stream_id)
        
        # Show notification
        if stopped_streams:
            message = f"Schedule '{schedule.name}' stopped {len(stopped_streams)} stream(s)"
            print(message)  # Log to console
    
    def start_streams_by_ids(self, stream_ids: List[int]):
        """Start streams by their IDs"""
        for stream_id in stream_ids:
            stream = next((s for s in self.streams if s.stream_id == stream_id), None)
            if stream and stream.recording_enabled:
                self.start_stream(stream)
    
    def stop_streams_by_ids(self, stream_ids: List[int]):
        """Stop streams by their IDs"""
        for stream_id in stream_ids:
            stream = next((s for s in self.streams if s.stream_id == stream_id), None)
            if stream:
                self.stop_stream(stream)


def main():
    """Main entry point"""
    if not RADIO_CLIENT_AVAILABLE:
        print("Error: radio_client module not found.")
        print("Please ensure radio_client.py is in the ../python directory")
        sys.exit(1)
    
    root = tk.Tk()
    app = IQRecorderGUI(root)
    root.mainloop()


if __name__ == '__main__':
    main()
