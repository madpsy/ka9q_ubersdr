#!/usr/bin/env python3
"""
IQ Recording Scheduler GUI
GUI components for managing recording schedules
"""

import tkinter as tk
from tkinter import ttk, messagebox
from typing import List, Optional, Callable
from datetime import datetime

from iq_scheduler import ScheduleEntry, IQScheduler
from iq_stream_config import StreamConfig


class TimePicker(ttk.Frame):
    """Custom time picker widget with hour/minute/second spinboxes"""
    
    def __init__(self, parent, initial_time="00:00:00", **kwargs):
        super().__init__(parent, **kwargs)
        
        # Parse initial time
        time_parts = initial_time.split(':')
        hour = time_parts[0]
        minute = time_parts[1]
        second = time_parts[2] if len(time_parts) > 2 else "00"
        
        # Hour spinbox (00-23)
        self.hour_var = tk.StringVar(value=hour)
        self.hour_spin = ttk.Spinbox(self, from_=0, to=23, width=3,
                                     textvariable=self.hour_var,
                                     format="%02.0f", wrap=True)
        self.hour_spin.pack(side=tk.LEFT, padx=2)
        
        ttk.Label(self, text=":").pack(side=tk.LEFT)
        
        # Minute spinbox (00-59)
        self.minute_var = tk.StringVar(value=minute)
        self.minute_spin = ttk.Spinbox(self, from_=0, to=59, width=3,
                                       textvariable=self.minute_var,
                                       format="%02.0f", wrap=True)
        self.minute_spin.pack(side=tk.LEFT, padx=2)
        
        ttk.Label(self, text=":").pack(side=tk.LEFT)
        
        # Second spinbox (00-59)
        self.second_var = tk.StringVar(value=second)
        self.second_spin = ttk.Spinbox(self, from_=0, to=59, width=3,
                                       textvariable=self.second_var,
                                       format="%02.0f", wrap=True)
        self.second_spin.pack(side=tk.LEFT, padx=2)
        
        # Callback for changes
        self.on_change: Optional[Callable] = None
        self.hour_var.trace_add('write', lambda *args: self._trigger_callback())
        self.minute_var.trace_add('write', lambda *args: self._trigger_callback())
        self.second_var.trace_add('write', lambda *args: self._trigger_callback())
    
    def _trigger_callback(self):
        """Trigger change callback if set"""
        if self.on_change:
            self.on_change()
    
    def get_time(self) -> str:
        """Get time as HH:MM:SS string"""
        try:
            hour = int(self.hour_var.get())
            minute = int(self.minute_var.get())
            second = int(self.second_var.get())
            return f"{hour:02d}:{minute:02d}:{second:02d}"
        except ValueError:
            return "00:00:00"
    
    def set_time(self, time_str: str):
        """Set time from HH:MM:SS string"""
        try:
            time_parts = time_str.split(':')
            hour = time_parts[0]
            minute = time_parts[1]
            second = time_parts[2] if len(time_parts) > 2 else "00"
            self.hour_var.set(f"{int(hour):02d}")
            self.minute_var.set(f"{int(minute):02d}")
            self.second_var.set(f"{int(second):02d}")
        except (ValueError, AttributeError, IndexError):
            self.hour_var.set("00")
            self.minute_var.set("00")
            self.second_var.set("00")


class DayOfWeekSelector(ttk.Frame):
    """Widget for selecting days of week"""
    
    def __init__(self, parent, **kwargs):
        super().__init__(parent, **kwargs)
        
        self.day_vars = {}
        days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 
                'Friday', 'Saturday', 'Sunday']
        
        # Create checkboxes in a grid
        for i, day in enumerate(days):
            var = tk.BooleanVar(value=True)
            self.day_vars[i] = var
            cb = ttk.Checkbutton(self, text=day, variable=var)
            cb.grid(row=i//4, column=i%4, sticky=tk.W, padx=5, pady=2)
        
        # Quick select buttons
        btn_frame = ttk.Frame(self)
        btn_frame.grid(row=2, column=0, columnspan=4, pady=5)
        
        ttk.Button(btn_frame, text="All Days", 
                  command=self.select_all).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="Weekdays", 
                  command=self.select_weekdays).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="Weekend", 
                  command=self.select_weekend).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="Clear", 
                  command=self.clear_all).pack(side=tk.LEFT, padx=2)
    
    def get_selected_days(self) -> List[int]:
        """Get list of selected day indices (0=Monday, 6=Sunday)"""
        return [day for day, var in self.day_vars.items() if var.get()]
    
    def set_selected_days(self, days: List[int]):
        """Set which days are selected"""
        for i, var in self.day_vars.items():
            var.set(i in days)
    
    def select_all(self):
        """Select all days"""
        for var in self.day_vars.values():
            var.set(True)
    
    def select_weekdays(self):
        """Select Monday-Friday"""
        for i, var in self.day_vars.items():
            var.set(i < 5)
    
    def select_weekend(self):
        """Select Saturday-Sunday"""
        for i, var in self.day_vars.items():
            var.set(i >= 5)
    
    def clear_all(self):
        """Clear all selections"""
        for var in self.day_vars.values():
            var.set(False)


class StreamSelector(ttk.Frame):
    """Widget for selecting which streams to control"""
    
    def __init__(self, parent, streams: List[StreamConfig], 
                 selected_stream_ids: List[int] = None, **kwargs):
        super().__init__(parent, **kwargs)
        
        self.streams = streams
        self.stream_vars = {}
        
        # Create scrollable frame
        canvas = tk.Canvas(self, height=150)
        scrollbar = ttk.Scrollbar(self, orient="vertical", command=canvas.yview)
        self.scrollable_frame = ttk.Frame(canvas)
        
        self.scrollable_frame.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        
        canvas.create_window((0, 0), window=self.scrollable_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        
        # Add checkboxes for each stream
        self.create_stream_list(selected_stream_ids or [])
        
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Quick select buttons
        btn_frame = ttk.Frame(self)
        btn_frame.pack(fill=tk.X, pady=5)
        
        ttk.Button(btn_frame, text="All Streams", 
                  command=self.select_all).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="None", 
                  command=self.clear_all).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_frame, text="Recording Only", 
                  command=self.select_recording_only).pack(side=tk.LEFT, padx=2)
    
    def create_stream_list(self, selected_ids: List[int]):
        """Create checkbox list of streams"""
        # Clear existing
        for widget in self.scrollable_frame.winfo_children():
            widget.destroy()
        
        self.stream_vars.clear()
        
        for stream in self.streams:
            var = tk.BooleanVar(value=stream.stream_id in selected_ids)
            self.stream_vars[stream.stream_id] = var
            
            # Build display text
            text = (f"Stream {stream.stream_id}: "
                   f"{stream.frequency_mhz:.3f} MHz "
                   f"({stream.iq_mode.mode_name.upper()})")
            
            # Add recording status indicator
            if stream.recording_enabled:
                text += " ✓ Recording"
            else:
                text += " ✗ Monitoring only"
            
            cb = ttk.Checkbutton(self.scrollable_frame, text=text, variable=var)
            cb.pack(anchor=tk.W, padx=5, pady=2)
            
            # Disable if recording not enabled
            if not stream.recording_enabled:
                cb.state(['disabled'])
    
    def get_selected_streams(self) -> List[int]:
        """Get list of selected stream IDs"""
        return [sid for sid, var in self.stream_vars.items() if var.get()]
    
    def set_selected_streams(self, stream_ids: List[int]):
        """Set which streams are selected"""
        for sid, var in self.stream_vars.items():
            var.set(sid in stream_ids)
    
    def select_all(self):
        """Select all streams with recording enabled"""
        for stream in self.streams:
            if stream.stream_id in self.stream_vars and stream.recording_enabled:
                self.stream_vars[stream.stream_id].set(True)
    
    def clear_all(self):
        """Clear all selections"""
        for var in self.stream_vars.values():
            var.set(False)
    
    def select_recording_only(self):
        """Select only streams with recording enabled"""
        for stream in self.streams:
            if stream.stream_id in self.stream_vars:
                self.stream_vars[stream.stream_id].set(stream.recording_enabled)


class ScheduleDialog:
    """Dialog for adding or editing a schedule"""
    
    def __init__(self, parent, streams: List[StreamConfig], 
                 schedule: Optional[ScheduleEntry] = None):
        self.parent = parent
        self.streams = streams
        self.schedule = schedule
        self.result = None
        
        # Create dialog
        self.dialog = tk.Toplevel(parent)
        title = "Edit Schedule" if schedule else "Add Schedule"
        self.dialog.title(title)
        self.dialog.geometry("750x800")  # Increased to show all content comfortably
        self.dialog.transient(parent)
        self.dialog.grab_set()
        
        # Center on parent
        self.dialog.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width() // 2) - (self.dialog.winfo_width() // 2)
        y = parent.winfo_y() + (parent.winfo_height() // 2) - (self.dialog.winfo_height() // 2)
        self.dialog.geometry(f"+{x}+{y}")
        
        self.create_widgets()
        
        # Pre-fill if editing
        if schedule:
            self.load_schedule_data(schedule)
        
        # Update preview
        self.update_preview()
    
    def create_widgets(self):
        """Create dialog widgets"""
        main_frame = ttk.Frame(self.dialog, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        row = 0
        
        # Schedule Name
        ttk.Label(main_frame, text="Schedule Name:").grid(row=row, column=0, sticky=tk.W, pady=5)
        self.name_var = tk.StringVar(value="New Schedule")
        ttk.Entry(main_frame, textvariable=self.name_var, width=50).grid(
            row=row, column=1, sticky=(tk.W, tk.E), pady=5)
        row += 1
        
        # Timing and Days of Week in same row (2 columns)
        timing_frame = ttk.LabelFrame(main_frame, text="Timing", padding="10")
        timing_frame.grid(row=row, column=0, sticky=(tk.W, tk.E, tk.N), pady=10, padx=(0, 5))
        
        ttk.Label(timing_frame, text="Start Time:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.start_time_picker = TimePicker(timing_frame, initial_time="00:00:00")
        self.start_time_picker.grid(row=0, column=1, sticky=tk.W, pady=5)
        self.start_time_picker.on_change = self.update_preview
        
        ttk.Label(timing_frame, text="Stop Time:").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.stop_time_picker = TimePicker(timing_frame, initial_time="23:59:59")
        self.stop_time_picker.grid(row=1, column=1, sticky=tk.W, pady=5)
        self.stop_time_picker.on_change = self.update_preview
        
        ttk.Label(timing_frame, text="Duration:").grid(row=2, column=0, sticky=tk.W, pady=5)
        self.duration_var = tk.StringVar(value="23h 59m 59s")
        ttk.Label(timing_frame, textvariable=self.duration_var).grid(
            row=2, column=1, sticky=tk.W, pady=5)
        
        # Days of Week frame (same row, column 1)
        days_frame = ttk.LabelFrame(main_frame, text="Days of Week", padding="10")
        days_frame.grid(row=row, column=1, sticky=(tk.W, tk.E, tk.N), pady=10, padx=(5, 0))
        row += 1
        
        self.day_selector = DayOfWeekSelector(days_frame)
        self.day_selector.pack(fill=tk.BOTH, expand=True)
        
        # Streams to Control frame
        streams_frame = ttk.LabelFrame(main_frame, text="Streams to Control", padding="10")
        streams_frame.grid(row=row, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=10)
        row += 1
        
        self.stream_selector = StreamSelector(streams_frame, self.streams)
        self.stream_selector.pack(fill=tk.BOTH, expand=True)
        
        # Actions and Options in same row (2 columns)
        actions_frame = ttk.LabelFrame(main_frame, text="Actions", padding="10")
        actions_frame.grid(row=row, column=0, sticky=(tk.W, tk.E, tk.N), pady=10, padx=(0, 5))
        
        ttk.Label(actions_frame, text="At start time:").grid(row=0, column=0, sticky=tk.W, pady=2)
        self.start_action_var = tk.StringVar(value="start_selected")
        ttk.Radiobutton(actions_frame, text="Start selected streams",
                       variable=self.start_action_var,
                       value="start_selected").grid(row=0, column=1, sticky=tk.W, pady=2)
        ttk.Radiobutton(actions_frame, text="Start all streams",
                       variable=self.start_action_var,
                       value="start_all").grid(row=1, column=1, sticky=tk.W, pady=2)
        
        ttk.Label(actions_frame, text="At stop time:").grid(row=2, column=0, sticky=tk.W, pady=2)
        self.stop_action_var = tk.StringVar(value="stop_selected")
        ttk.Radiobutton(actions_frame, text="Stop selected streams",
                       variable=self.stop_action_var,
                       value="stop_selected").grid(row=2, column=1, sticky=tk.W, pady=2)
        ttk.Radiobutton(actions_frame, text="Do nothing",
                       variable=self.stop_action_var,
                       value="none").grid(row=3, column=1, sticky=tk.W, pady=2)
        
        # Options frame (same row, column 1)
        options_frame = ttk.LabelFrame(main_frame, text="Options", padding="10")
        options_frame.grid(row=row, column=1, sticky=(tk.W, tk.E, tk.N), pady=10, padx=(5, 0))
        row += 1
        
        self.enabled_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(options_frame, text="Enabled",
                       variable=self.enabled_var).pack(anchor=tk.W)
        
        # Preview frame
        preview_frame = ttk.LabelFrame(main_frame, text="Preview", padding="10")
        preview_frame.grid(row=row, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=10)
        row += 1
        
        self.preview_text = tk.Text(preview_frame, height=4, width=70, wrap=tk.WORD)
        self.preview_text.pack(fill=tk.BOTH, expand=True)
        self.preview_text.config(state=tk.DISABLED)
        
        # Buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=row, column=0, columnspan=2, pady=10)
        
        ttk.Button(button_frame, text="Save Schedule", 
                  command=self.save_schedule).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Cancel", 
                  command=self.dialog.destroy).pack(side=tk.LEFT, padx=5)
    
    def load_schedule_data(self, schedule: ScheduleEntry):
        """Load existing schedule data into form"""
        self.name_var.set(schedule.name)
        self.start_time_picker.set_time(schedule.start_time)
        self.stop_time_picker.set_time(schedule.stop_time)
        self.day_selector.set_selected_days(schedule.days_of_week)
        self.stream_selector.set_selected_streams(schedule.stream_ids)
        self.enabled_var.set(schedule.enabled)
        self.start_action_var.set(schedule.start_action)
        self.stop_action_var.set(schedule.stop_action)
    
    def update_preview(self):
        """Update preview text"""
        try:
            start_time = self.start_time_picker.get_time()
            stop_time = self.stop_time_picker.get_time()
            
            # Calculate duration
            start_dt = datetime.strptime(start_time, "%H:%M:%S")
            stop_dt = datetime.strptime(stop_time, "%H:%M:%S")
            
            if stop_dt < start_dt:
                # Crosses midnight
                duration = (stop_dt - start_dt).total_seconds() + 86400
            else:
                duration = (stop_dt - start_dt).total_seconds()
            
            hours = int(duration // 3600)
            minutes = int((duration % 3600) // 60)
            seconds = int(duration % 60)
            self.duration_var.set(f"{hours}h {minutes}m {seconds}s")
            
            # Build preview text
            selected_streams = self.stream_selector.get_selected_streams()
            recording_streams = [s for s in self.streams 
                               if s.stream_id in selected_streams and s.recording_enabled]
            monitoring_streams = [s for s in self.streams 
                                if s.stream_id in selected_streams and not s.recording_enabled]
            
            preview_lines = []
            
            if recording_streams:
                stream_names = ", ".join([f"Stream {s.stream_id}" for s in recording_streams])
                preview_lines.append(f"✓ Will record: {stream_names}")
            else:
                preview_lines.append("⚠️ No streams will record (all have recording disabled)")
            
            if monitoring_streams:
                stream_names = ", ".join([f"Stream {s.stream_id}" for s in monitoring_streams])
                preview_lines.append(f"ℹ️ Will skip (monitoring only): {stream_names}")
            
            days = self.day_selector.get_selected_days()
            if days:
                day_names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                days_str = ", ".join([day_names[d] for d in sorted(days)])
                preview_lines.append(f"Days: {days_str}")
            
            preview_lines.append(f"Duration: {hours}h {minutes}m {seconds}s")
            
            # Update preview text
            self.preview_text.config(state=tk.NORMAL)
            self.preview_text.delete(1.0, tk.END)
            self.preview_text.insert(1.0, "\n".join(preview_lines))
            self.preview_text.config(state=tk.DISABLED)
            
        except Exception as e:
            pass
    
    def save_schedule(self):
        """Validate and save schedule"""
        # Get values
        name = self.name_var.get().strip()
        start_time = self.start_time_picker.get_time()
        stop_time = self.stop_time_picker.get_time()
        days_of_week = self.day_selector.get_selected_days()
        stream_ids = self.stream_selector.get_selected_streams()
        enabled = self.enabled_var.get()
        start_action = self.start_action_var.get()
        stop_action = self.stop_action_var.get()
        
        # Validate
        if not name:
            messagebox.showerror("Invalid Input", "Schedule name cannot be empty", 
                               parent=self.dialog)
            return
        
        if not days_of_week:
            messagebox.showerror("Invalid Input", "At least one day must be selected", 
                               parent=self.dialog)
            return
        
        if not stream_ids:
            messagebox.showerror("Invalid Input", "At least one stream must be selected", 
                               parent=self.dialog)
            return
        
        # Check if any selected streams have recording enabled
        recording_enabled_count = sum(1 for s in self.streams 
                                     if s.stream_id in stream_ids and s.recording_enabled)
        
        if recording_enabled_count == 0:
            response = messagebox.askyesno(
                "No Recording Streams",
                "None of the selected streams have recording enabled.\n"
                "This schedule will not record anything.\n\n"
                "Continue anyway?",
                icon='warning',
                parent=self.dialog
            )
            if not response:
                return
        
        # Create result
        schedule_id = self.schedule.schedule_id if self.schedule else 0
        
        self.result = ScheduleEntry(
            schedule_id=schedule_id,
            name=name,
            start_time=start_time,
            stop_time=stop_time,
            days_of_week=days_of_week,
            stream_ids=stream_ids,
            enabled=enabled,
            start_action=start_action,
            stop_action=stop_action
        )
        
        self.dialog.destroy()


class SchedulerManagerDialog:
    """Main dialog for managing schedules"""
    
    def __init__(self, parent, scheduler: IQScheduler, streams: List[StreamConfig]):
        self.parent = parent
        self.scheduler = scheduler
        self.streams = streams
        self.changes_made = False
        
        # Create dialog
        self.dialog = tk.Toplevel(parent)
        self.dialog.title("Schedule Manager")
        self.dialog.geometry("900x500")
        self.dialog.transient(parent)
        self.dialog.grab_set()
        
        # Center on parent
        self.dialog.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width() // 2) - (self.dialog.winfo_width() // 2)
        y = parent.winfo_y() + (parent.winfo_height() // 2) - (self.dialog.winfo_height() // 2)
        self.dialog.geometry(f"+{x}+{y}")
        
        self.create_widgets()
        self.update_schedule_list()
    
    def create_widgets(self):
        """Create dialog widgets"""
        main_frame = ttk.Frame(self.dialog, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        self.dialog.rowconfigure(0, weight=1)
        self.dialog.columnconfigure(0, weight=1)
        main_frame.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)
        
        # Schedule list
        columns = ('id', 'name', 'start', 'stop', 'days', 'streams', 'enabled')
        self.schedule_tree = ttk.Treeview(main_frame, columns=columns, 
                                         show='headings', height=15)
        
        self.schedule_tree.heading('id', text='#')
        self.schedule_tree.heading('name', text='Name')
        self.schedule_tree.heading('start', text='Start')
        self.schedule_tree.heading('stop', text='Stop')
        self.schedule_tree.heading('days', text='Days')
        self.schedule_tree.heading('streams', text='Streams')
        self.schedule_tree.heading('enabled', text='Enabled')
        
        self.schedule_tree.column('id', width=40)
        self.schedule_tree.column('name', width=200)
        self.schedule_tree.column('start', width=80)
        self.schedule_tree.column('stop', width=80)
        self.schedule_tree.column('days', width=100)
        self.schedule_tree.column('streams', width=150)
        self.schedule_tree.column('enabled', width=80)
        
        scrollbar = ttk.Scrollbar(main_frame, orient=tk.VERTICAL, 
                                 command=self.schedule_tree.yview)
        self.schedule_tree.configure(yscrollcommand=scrollbar.set)
        
        self.schedule_tree.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        
        # Bind double-click to edit
        self.schedule_tree.bind("<Double-1>", lambda e: self.edit_schedule())
        
        # Buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=1, column=0, columnspan=2, pady=10)
        
        ttk.Button(button_frame, text="Add Schedule", 
                  command=self.add_schedule).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Edit", 
                  command=self.edit_schedule).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Duplicate", 
                  command=self.duplicate_schedule).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Remove", 
                  command=self.remove_schedule).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Enable/Disable", 
                  command=self.toggle_enabled).pack(side=tk.LEFT, padx=5)
        
        # Status
        self.status_var = tk.StringVar(value="")
        status_label = ttk.Label(main_frame, textvariable=self.status_var)
        status_label.grid(row=2, column=0, columnspan=2, sticky=tk.W, pady=5)
        
        # Close button
        ttk.Button(main_frame, text="Close", 
                  command=self.dialog.destroy).grid(row=3, column=0, columnspan=2, pady=5)
        
        self.update_status()
    
    def update_schedule_list(self):
        """Update schedule list display"""
        # Clear existing
        for item in self.schedule_tree.get_children():
            self.schedule_tree.delete(item)
        
        # Add schedules
        for schedule in self.scheduler.schedules:
            # Format days
            if len(schedule.days_of_week) == 7:
                days_str = "All"
            elif set(schedule.days_of_week) == {5, 6}:
                days_str = "S-S"
            elif set(schedule.days_of_week) == {0, 1, 2, 3, 4}:
                days_str = "M-F"
            else:
                day_names = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
                days_str = ",".join([day_names[d] for d in sorted(schedule.days_of_week)])
            
            # Format streams with recording status
            recording_count = sum(1 for s in self.streams 
                                if s.stream_id in schedule.stream_ids and s.recording_enabled)
            total_count = len(schedule.stream_ids)
            
            if recording_count == 0:
                streams_str = f"⚠️ {total_count} (none)"
            elif recording_count < total_count:
                streams_str = f"{recording_count}/{total_count}"
            else:
                streams_str = str(total_count)
            
            values = (
                schedule.schedule_id,
                schedule.name,
                schedule.start_time,
                schedule.stop_time,
                days_str,
                streams_str,
                "✓" if schedule.enabled else "✗"
            )
            
            self.schedule_tree.insert('', tk.END, values=values)
        
        self.update_status()
    
    def update_status(self):
        """Update status message"""
        next_event = self.scheduler.get_next_event()
        if next_event:
            schedule, next_time, action = next_event
            time_until = next_time - datetime.now()
            hours = int(time_until.total_seconds() // 3600)
            minutes = int((time_until.total_seconds() % 3600) // 60)
            seconds = int(time_until.total_seconds() % 60)
            
            action_str = "starts" if action == "start" else "stops"
            self.status_var.set(
                f"Next scheduled event: {schedule.name} {action_str} in {hours}h {minutes}m {seconds}s"
            )
        else:
            self.status_var.set("No scheduled events")
    
    def add_schedule(self):
        """Add a new schedule"""
        dialog = ScheduleDialog(self.dialog, self.streams)
        self.dialog.wait_window(dialog.dialog)
        
        if dialog.result:
            # Assign new ID
            dialog.result.schedule_id = self.scheduler.get_next_schedule_id()
            
            # Validate
            valid, message = self.scheduler.validate_schedule(dialog.result)
            if not valid:
                messagebox.showerror("Invalid Schedule", message, parent=self.dialog)
                return
            
            # Add to scheduler
            self.scheduler.add_schedule(dialog.result)
            self.changes_made = True
            self.update_schedule_list()
    
    def edit_schedule(self):
        """Edit selected schedule"""
        selection = self.schedule_tree.selection()
        if not selection:
            messagebox.showinfo("No Selection", "Please select a schedule to edit",
                              parent=self.dialog)
            return
        
        item = selection[0]
        schedule_id = int(self.schedule_tree.item(item)['values'][0])
        schedule = self.scheduler.get_schedule_by_id(schedule_id)
        
        if not schedule:
            return
        
        dialog = ScheduleDialog(self.dialog, self.streams, schedule)
        self.dialog.wait_window(dialog.dialog)
        
        if dialog.result:
            # Keep the same ID
            dialog.result.schedule_id = schedule_id
            
            # Validate
            valid, message = self.scheduler.validate_schedule(dialog.result)
            if not valid:
                messagebox.showerror("Invalid Schedule", message, parent=self.dialog)
                return
            
            # Update scheduler
            self.scheduler.update_schedule(dialog.result)
            self.changes_made = True
            self.update_schedule_list()
    
    def duplicate_schedule(self):
        """Duplicate selected schedule"""
        selection = self.schedule_tree.selection()
        if not selection:
            messagebox.showinfo("No Selection", "Please select a schedule to duplicate",
                              parent=self.dialog)
            return
        
        item = selection[0]
        schedule_id = int(self.schedule_tree.item(item)['values'][0])
        schedule = self.scheduler.get_schedule_by_id(schedule_id)
        
        if not schedule:
            return
        
        # Create copy with new ID and name
        new_schedule = ScheduleEntry(
            schedule_id=self.scheduler.get_next_schedule_id(),
            name=f"{schedule.name} (Copy)",
            start_time=schedule.start_time,
            stop_time=schedule.stop_time,
            days_of_week=schedule.days_of_week.copy(),
            stream_ids=schedule.stream_ids.copy(),
            enabled=False,  # Start disabled for safety
            start_action=schedule.start_action,
            stop_action=schedule.stop_action
        )
        
        self.scheduler.add_schedule(new_schedule)
        self.changes_made = True
        self.update_schedule_list()
    
    def remove_schedule(self):
        """Remove selected schedule"""
        selection = self.schedule_tree.selection()
        if not selection:
            messagebox.showinfo("No Selection", "Please select a schedule to remove",
                              parent=self.dialog)
            return
        
        item = selection[0]
        schedule_id = int(self.schedule_tree.item(item)['values'][0])
        schedule = self.scheduler.get_schedule_by_id(schedule_id)
        
        if not schedule:
            return
        
        response = messagebox.askyesno(
            "Confirm Removal",
            f"Remove schedule '{schedule.name}'?",
            parent=self.dialog
        )
        
        if response:
            self.scheduler.remove_schedule(schedule_id)
            self.changes_made = True
            self.update_schedule_list()
    
    def toggle_enabled(self):
        """Toggle enabled state of selected schedule"""
        selection = self.schedule_tree.selection()
        if not selection:
            messagebox.showinfo("No Selection", "Please select a schedule",
                              parent=self.dialog)
            return
        
        item = selection[0]
        schedule_id = int(self.schedule_tree.item(item)['values'][0])
        schedule = self.scheduler.get_schedule_by_id(schedule_id)
        
        if schedule:
            schedule.enabled = not schedule.enabled
            self.changes_made = True
            self.update_schedule_list()