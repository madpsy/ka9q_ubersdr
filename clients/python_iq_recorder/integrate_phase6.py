#!/usr/bin/env python3
"""
Script to integrate Phase 6 multi-channel tabbed UI methods into iq_spectrum_display.py
This appends all the new methods to the end of the IQSpectrumDisplay class.
"""

import sys

# All the new methods to add
NEW_METHODS = '''
    # ========================================================================
    # Phase 6: Multi-Channel Tabbed UI Methods
    # ========================================================================

    def _create_channel_control_widgets(self):
        """Create the control widgets for the active channel panel"""
        panel = self.channel_control_panel

        # Row 1: Name, Active checkbox, Device selector, Output routing, Start/Stop
        row1 = ttk.Frame(panel)
        row1.pack(side=tk.TOP, fill=tk.X, pady=2)

        # Channel name
        ttk.Label(row1, text="Name:").pack(side=tk.LEFT, padx=(5, 2))
        self.channel_name_var = tk.StringVar()
        self.channel_name_entry = ttk.Entry(row1, textvariable=self.channel_name_var, width=15)
        self.channel_name_entry.pack(side=tk.LEFT, padx=2)
        self.channel_name_entry.bind('<Return>', self.on_channel_name_changed)
        self.channel_name_entry.bind('<FocusOut>', self.on_channel_name_changed)

        # Active checkbox
        self.channel_active_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            row1, text="Active (responds to hover)",
            variable=self.channel_active_var,
            command=self.on_channel_active_changed
        ).pack(side=tk.LEFT, padx=10)

        # Audio device
        ttk.Label(row1, text="Device:").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_device_var = tk.StringVar()
        self.channel_device_combo = ttk.Combobox(
            row1, textvariable=self.channel_device_var,
            state="readonly", width=25
        )
        self.channel_device_combo.pack(side=tk.LEFT, padx=2)
        self.channel_device_combo.bind('<<ComboboxSelected>>', self.on_channel_device_changed)
        self.populate_audio_devices()

        # L/R output
        output_frame = ttk.Frame(row1)
        output_frame.pack(side=tk.LEFT, padx=10)
        self.channel_left_var = tk.BooleanVar(value=True)
        self.channel_right_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(output_frame, text="L", variable=self.channel_left_var,
                        command=self.on_channel_output_changed).pack(side=tk.LEFT)
        ttk.Checkbutton(output_frame, text="R", variable=self.channel_right_var,
                        command=self.on_channel_output_changed).pack(side=tk.LEFT)

        # Start/Stop button
        self.channel_audio_button_text = tk.StringVar(value="▶ Start")
        self.channel_audio_button = ttk.Button(
            row1, textvariable=self.channel_audio_button_text,
            command=self.on_channel_start_stop, width=10
        )
        self.channel_audio_button.pack(side=tk.LEFT, padx=5)

        # Row 2: Mode, Bandwidth, Volume, Frequency, Lock, AGC
        row2 = ttk.Frame(panel)
        row2.pack(side=tk.TOP, fill=tk.X, pady=2)

        # Mode
        ttk.Label(row2, text="Mode:").pack(side=tk.LEFT, padx=(5, 2))
        default_mode = "LSB" if self.center_freq < 10_000_000 else "USB"
        self.channel_mode_var = tk.StringVar(value=default_mode)
        self.channel_mode_combo = ttk.Combobox(
            row2, textvariable=self.channel_mode_var,
            values=["USB", "LSB", "CWU", "CWL"],
            state="readonly", width=6
        )
        self.channel_mode_combo.pack(side=tk.LEFT, padx=2)
        self.channel_mode_combo.bind('<<ComboboxSelected>>', self.on_channel_mode_changed)

        # Bandwidth
        ttk.Label(row2, text="BW:").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_bandwidth_var = tk.IntVar(value=2700)
        self.channel_bandwidth_scale = ttk.Scale(
            row2, from_=200, to=6000, orient=tk.HORIZONTAL,
            variable=self.channel_bandwidth_var,
            command=self.on_channel_bandwidth_changed, length=120
        )
        self.channel_bandwidth_scale.pack(side=tk.LEFT, padx=2)
        self.channel_bandwidth_label = ttk.Label(row2, text="2700 Hz")
        self.channel_bandwidth_label.pack(side=tk.LEFT, padx=2)

        # Volume
        ttk.Label(row2, text="Vol:").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_volume_var = tk.DoubleVar(value=0.5)
        self.channel_volume_scale = ttk.Scale(
            row2, from_=0.0, to=1.0, orient=tk.HORIZONTAL,
            variable=self.channel_volume_var,
            command=self.on_channel_volume_changed, length=100
        )
        self.channel_volume_scale.pack(side=tk.LEFT, padx=2)
        self.channel_volume_label = ttk.Label(row2, text="50%")
        self.channel_volume_label.pack(side=tk.LEFT, padx=2)

        # Frequency
        ttk.Label(row2, text="Freq (MHz):").pack(side=tk.LEFT, padx=(10, 2))
        self.channel_freq_var = tk.StringVar(value=f"{self.center_freq/1e6:.6f}")
        self.channel_freq_entry = ttk.Entry(
            row2, textvariable=self.channel_freq_var,
            width=12, justify=tk.RIGHT
        )
        self.channel_freq_entry.pack(side=tk.LEFT, padx=2)
        self.channel_freq_entry.bind('<Return>', self.on_channel_freq_changed)
        self.channel_freq_entry.bind('<FocusOut>', self.on_channel_freq_changed)

        # Lock
        self.channel_lock_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(row2, text="🔒", variable=self.channel_lock_var,
                        command=self.on_channel_lock_changed, width=3).pack(side=tk.LEFT, padx=2)

        # AGC
        self.channel_agc_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(row2, text="AGC", variable=self.channel_agc_var,
                        command=self.on_channel_agc_changed).pack(side=tk.LEFT, padx=5)

    def _create_legacy_audio_controls(self):
        """Create legacy single-channel audio controls (fallback)"""
        # This preserves the original single-channel UI for backward compatibility
        control_frame = ttk.Frame(self.control_container)
        control_frame.pack(side=tk.TOP, fill=tk.X)

        # Audio device selector
        ttk.Label(control_frame, text="Audio Device:").pack(side=tk.LEFT, padx=(5, 2))
        self.audio_device_var = tk.StringVar()
        self.audio_device_combo = ttk.Combobox(
            control_frame,
            textvariable=self.audio_device_var,
            state="readonly",
            width=33
        )
        self.audio_device_combo.pack(side=tk.LEFT, padx=2)
        self.populate_audio_devices()

        # Channel selection frame
        channel_frame = tk.Frame(control_frame, pady=0)
        channel_frame.pack(side=tk.LEFT, padx=(10, 2))

        self.left_channel_var = tk.BooleanVar(value=True)
        self.right_channel_var = tk.BooleanVar(value=True)

        tk.Checkbutton(
            channel_frame,
            text="Left",
            variable=self.left_channel_var,
            command=self.on_channel_changed,
            pady=0
        ).pack(anchor=tk.W, pady=0)

        tk.Checkbutton(
            channel_frame,
            text="Right",
            variable=self.right_channel_var,
            command=self.on_channel_changed,
            pady=0
        ).pack(anchor=tk.W, pady=0)

        # Start/Stop button
        self.audio_button_text = tk.StringVar(value="▶ Start Audio")
        self.audio_button = ttk.Button(
            control_frame,
            textvariable=self.audio_button_text,
            command=self.toggle_audio_preview,
            width=14
        )
        self.audio_button.pack(side=tk.LEFT, padx=5)

        # Mode selector
        default_mode = "LSB" if self.center_freq < 10_000_000 else "USB"
        self.audio_mode_var = tk.StringVar(value=default_mode)

        mode_combo = ttk.Combobox(
            control_frame,
            textvariable=self.audio_mode_var,
            values=["USB", "LSB", "CWU", "CWL"],
            state="readonly",
            width=6
        )
        mode_combo.pack(side=tk.LEFT, padx=2)
        mode_combo.bind('<<ComboboxSelected>>', self.on_mode_changed)

        # Bandwidth slider
        ttk.Label(control_frame, text="BW:").pack(side=tk.LEFT, padx=(10, 2))
        self.bandwidth_var = tk.IntVar(value=2700)
        self.bandwidth_scale = ttk.Scale(
            control_frame,
            from_=200,
            to=6000,
            orient=tk.HORIZONTAL,
            variable=self.bandwidth_var,
            command=self.on_bandwidth_changed,
            length=120
        )
        self.bandwidth_scale.pack(side=tk.LEFT, padx=2)

        self.bandwidth_label = ttk.Label(control_frame, text="2700 Hz")
        self.bandwidth_label.pack(side=tk.LEFT, padx=2)

        # AGC checkbox
        self.agc_enabled_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            control_frame,
            text="AGC",
            variable=self.agc_enabled_var,
            command=self.on_agc_changed
        ).pack(side=tk.LEFT, padx=5)

        # Volume control
        ttk.Label(control_frame, text="Volume:").pack(side=tk.LEFT, padx=(10, 2))
        self.volume_var = tk.DoubleVar(value=0.5)
        volume_scale = ttk.Scale(
            control_frame,
            from_=0.0,
            to=1.0,
            orient=tk.HORIZONTAL,
            variable=self.volume_var,
            command=self.on_volume_changed,
            length=100
        )
        volume_scale.pack(side=tk.LEFT, padx=2)

        self.volume_label = ttk.Label(control_frame, text="50%")
        self.volume_label.pack(side=tk.LEFT, padx=2)

        # Frequency input/display
        freq_frame = ttk.Frame(control_frame)
        freq_frame.pack(side=tk.RIGHT, padx=5)

        ttk.Label(freq_frame, text="Freq (MHz):").pack(side=tk.LEFT, padx=(0, 2))

        self.freq_entry_var = tk.StringVar(value=f"{self.center_freq/1e6:.6f}")
        self.freq_entry = ttk.Entry(
            freq_frame,
            textvariable=self.freq_entry_var,
            width=12,
            justify=tk.RIGHT
        )
        self.freq_entry.pack(side=tk.LEFT, padx=2)
        self.freq_entry.bind('<Return>', self.on_freq_entry_submit)
        self.freq_entry.bind('<FocusOut>', self.on_freq_entry_submit)

        # Lock checkbox
        self.freq_lock_var = tk.BooleanVar(value=False)
        self.freq_lock_check = ttk.Checkbutton(
            freq_frame,
            variable=self.freq_lock_var,
            command=self.on_freq_lock_changed
        )
        self.freq_lock_check.pack(side=tk.LEFT, padx=(2, 0))

    def _refresh_channel_tabs(self):
        """Refresh the channel tab buttons"""
        for widget in self.tab_buttons_frame.winfo_children():
            widget.destroy()
        self.channel_tab_buttons.clear()

        if not self.audio_mixer:
            return

        for channel in self.audio_mixer.channels:
            self._create_channel_tab(channel)

        # Update add button state
        if self.audio_mixer.get_channel_count() >= MAX_CHANNELS:
            self.add_channel_button.config(state='disabled')
        else:
            self.add_channel_button.config(state='normal')

    def _create_channel_tab(self, channel):
        """Create a tab button for a channel"""
        tab_frame = ttk.Frame(self.tab_buttons_frame)
        tab_frame.pack(side=tk.LEFT, padx=1)

        is_active = (channel.channel_id == self.active_channel_id)
        btn_text = f"● {channel.name}"

        tab_button = tk.Button(
            tab_frame, text=btn_text, fg=channel.color,
            relief=tk.SUNKEN if is_active else tk.RAISED,
            bd=2 if is_active else 1, padx=8, pady=4,
            command=lambda cid=channel.channel_id: self.on_tab_clicked(cid)
        )
        tab_button.pack(side=tk.LEFT)

        close_button = tk.Button(
            tab_frame, text="×", fg="red", relief=tk.FLAT,
            padx=4, pady=4,
            command=lambda cid=channel.channel_id: self.on_tab_close_clicked(cid)
        )
        close_button.pack(side=tk.LEFT)

        self.channel_tab_buttons[channel.channel_id] = {
            'frame': tab_frame, 'button': tab_button, 'close': close_button
        }

    def _update_channel_controls(self):
        """Update the channel control panel to show active channel settings"""
        active_channel = self.get_active_channel()

        if not active_channel:
            self._disable_channel_controls()
            return

        self._enable_channel_controls()

        # Update all control values
        self.channel_name_var.set(active_channel.name)
        self.channel_active_var.set(active_channel.channel_id == self.active_channel_id)
        self.channel_left_var.set(active_channel.left_enabled)
        self.channel_right_var.set(active_channel.right_enabled)
        self.channel_mode_var.set(active_channel.mode)
        self.channel_bandwidth_var.set(active_channel.bandwidth)
        self.channel_bandwidth_label.config(text=f"{active_channel.bandwidth} Hz")
        self.channel_volume_var.set(active_channel.volume)
        self.channel_volume_label.config(text=f"{int(active_channel.volume * 100)}%")
        self.channel_freq_var.set(f"{active_channel.frequency/1e6:.6f}")
        self.channel_lock_var.set(active_channel.locked)
        self.channel_agc_var.set(active_channel.agc_enabled)

        # Update button text
        if active_channel.is_active():
            self.channel_audio_button_text.set("⏹ Stop")
        else:
            self.channel_audio_button_text.set("▶ Start")

    def _enable_channel_controls(self):
        """Enable all channel control widgets"""
        if hasattr(self, 'channel_name_entry'):
            self.channel_name_entry.config(state='normal')
            self.channel_device_combo.config(state='readonly')
            self.channel_audio_button.config(state='normal')
            self.channel_mode_combo.config(state='readonly')
            self.channel_bandwidth_scale.config(state='normal')
            self.channel_volume_scale.config(state='normal')
            self.channel_freq_entry.config(state='normal')

    def _disable_channel_controls(self):
        """Disable all channel control widgets"""
        if hasattr(self, 'channel_name_entry'):
            self.channel_name_entry.config(state='disabled')
            self.channel_device_combo.config(state='disabled')
            self.channel_audio_button.config(state='disabled')
            self.channel_mode_combo.config(state='disabled')
            self.channel_bandwidth_scale.config(state='disabled')
            self.channel_volume_scale.config(state='disabled')
            self.channel_freq_entry.config(state='disabled')

    def on_tab_clicked(self, channel_id: int):
        """Handle tab button click"""
        self.set_active_channel(channel_id)
        self._refresh_channel_tabs()
        self._update_channel_controls()
        self.redraw_all_markers()

    def on_tab_close_clicked(self, channel_id: int):
        """Handle tab close button click"""
        channel = self.get_channel(channel_id)
        if not channel:
            return

        result = messagebox.askyesno("Remove Channel", f"Remove channel '{channel.name}'?")
        if result:
            self.remove_channel(channel_id)
            self._refresh_channel_tabs()
            self._update_channel_controls()
            self.redraw_all_markers()
            self.save_channel_configuration()

    def on_add_channel_clicked(self):
        """Handle add channel button click"""
        if not self.audio_mixer:
            return

        if self.audio_mixer.get_channel_count() >= MAX_CHANNELS:
            messagebox.showwarning("Maximum Channels", f"Maximum of {MAX_CHANNELS} channels reached.")
            return

        new_channel = self.add_channel()
        if new_channel:
            self.set_active_channel(new_channel.channel_id)
            self._refresh_channel_tabs()
            self._update_channel_controls()
            self.save_channel_configuration()

    def on_channel_name_changed(self, event=None):
        """Handle channel name change"""
        active_channel = self.get_active_channel()
        if active_channel:
            new_name = self.channel_name_var.get().strip()
            if new_name:
                active_channel.set_name(new_name)
                self._refresh_channel_tabs()
                self.save_channel_configuration()

    def on_channel_active_changed(self):
        """Handle active checkbox change"""
        pass

    def on_channel_device_changed(self, event=None):
        """Handle audio device change"""
        active_channel = self.get_active_channel()
        if active_channel:
            device_index = self.get_selected_audio_device_index()
            active_channel.device_index = device_index
            if active_channel.is_active():
                active_channel.stop()
                active_channel.start()
            self.save_channel_configuration()

    def on_channel_output_changed(self):
        """Handle L/R output routing change"""
        active_channel = self.get_active_channel()
        if active_channel:
            left = self.channel_left_var.get()
            right = self.channel_right_var.get()
            active_channel.set_output_routing(left, right)
            self.save_channel_configuration()

    def on_channel_start_stop(self):
        """Handle start/stop button click"""
        active_channel = self.get_active_channel()
        if not active_channel:
            return

        if active_channel.is_active():
            active_channel.stop()
            self.channel_audio_button_text.set("▶ Start")
        else:
            if active_channel.start():
                self.channel_audio_button_text.set("⏹ Stop")
            else:
                messagebox.showerror("Audio Error", f"Failed to start audio for channel '{active_channel.name}'")

        self.redraw_all_markers()
        self.save_channel_configuration()

    def on_channel_mode_changed(self, event=None):
        """Handle mode change"""
        active_channel = self.get_active_channel()
        if active_channel:
            mode = self.channel_mode_var.get()
            active_channel.set_mode(mode)

            # Adjust bandwidth range for CW modes
            if mode in ['CWU', 'CWL']:
                self.channel_bandwidth_scale.config(from_=200, to=1000)
                if active_channel.bandwidth > 1000:
                    active_channel.set_bandwidth(500)
                    self.channel_bandwidth_var.set(500)
            else:
                self.channel_bandwidth_scale.config(from_=1000, to=6000)
                if active_channel.bandwidth < 1000:
                    active_channel.set_bandwidth(2700)
                    self.channel_bandwidth_var.set(2700)

            self.redraw_all_markers()
            self.save_channel_configuration()

    def on_channel_bandwidth_changed(self, value):
        """Handle bandwidth slider change"""
        active_channel = self.get_active_channel()
        if active_channel:
            bandwidth = int(float(value))
            active_channel.set_bandwidth(bandwidth)
            self.channel_bandwidth_label.config(text=f"{bandwidth} Hz")
            self.redraw_all_markers()
            if hasattr(self, '_bandwidth_save_timer'):
                self.parent.after_cancel(self._bandwidth_save_timer)
            self._bandwidth_save_timer = self.parent.after(1000, self.save_channel_configuration)

    def on_channel_volume_changed(self, value):
        """Handle volume slider change"""
        active_channel = self.get_active_channel()
        if active_channel:
            volume = float(value)
            active_channel.set_volume(volume)
            self.channel_volume_label.config(text=f"{int(volume * 100)}%")
            if hasattr(self, '_volume_save_timer'):
                self.parent.after_cancel(self._volume_save_timer)
            self._volume_save_timer = self.parent.after(1000, self.save_channel_configuration)

    def on_channel_freq_changed(self, event=None):
        """Handle frequency entry change"""
        active_channel = self.get_active_channel()
        if not active_channel:
            return

        try:
            freq_mhz = float(self.channel_freq_var.get())
            freq_hz = int(freq_mhz * 1e6)

            freq_min = self.center_freq - self.sample_rate / 2
            freq_max = self.center_freq + self.sample_rate / 2

            if freq_hz < freq_min or freq_hz > freq_max:
                messagebox.showwarning(
                    "Frequency Out of Range",
                    f"Frequency must be between {freq_min/1e6:.6f} and {freq_max/1e6:.6f} MHz"
                )
                self.channel_freq_var.set(f"{active_channel.frequency/1e6:.6f}")
                return

            active_channel.set_frequency(freq_hz)
            self.redraw_all_markers()
            self.save_channel_configuration()

        except ValueError:
            messagebox.showwarning("Invalid Frequency", "Please enter a valid frequency in MHz")
            self.channel_freq_var.set(f"{active_channel.frequency/1e6:.6f}")

    def on_channel_lock_changed(self):
        """Handle lock checkbox change"""
        active_channel = self.get_active_channel()
        if active_channel:
            locked = self.channel_lock_var.get()
            active_channel.set_locked(locked)
            self.redraw_all_markers()
            self.save_channel_configuration()

    def on_channel_agc_changed(self):
        """Handle AGC checkbox change"""
        active_channel = self.get_active_channel()
        if active_channel:
            agc_enabled = self.channel_agc_var.get()
            active_channel.set_agc_enabled(agc_enabled)
            self.save_channel_configuration()

    def get_channel_config_path(self):
        """Get path to channel configuration file"""
        return Path.home() / '.iq_recorder_channels.json'

    def save_channel_configuration(self):
        """Save channel configuration to file"""
        if not self.audio_mixer:
            return

        try:
            config = {
                'version': '1.0',
                'channels': [ch.to_dict() for ch in self.audio_mixer.channels],
                'active_channel_id': self.active_channel_id,
                'master_volume': self.audio_mixer.master_volume,
                'auto_gain': self.audio_mixer.auto_gain
            }

            config_path = self.get_channel_config_path()
            with open(config_path, 'w') as f:
                json.dump(config, f, indent=2)

            print(f"Saved channel configuration to {config_path}")

        except Exception as e:
            print(f"Error saving channel configuration: {e}")

    def load_channel_configuration(self):
        """Load channel configuration from file"""
        if not self.audio_mixer:
            return

        config_path = self.get_channel_config_path()

        if not config_path.exists():
            print("No saved channel configuration found")
            return

        try:
            with open(config_path, 'r') as f:
                config = json.load(f)

            if config.get('version') != '1.0':
                print(f"Unsupported configuration version: {config.get('version')}")
                return

            # Clear existing channels
            self.audio_mixer.clear_all_channels()

            # Restore channels
            for ch_data in config.get('channels', []):
                channel = AudioChannel.from_dict(
                    ch_data, self.sample_rate, self.center_freq, 48000
                )
                self.audio_mixer.channels.append(channel)

                if channel.channel_id >= self.audio_mixer.next_channel_id:
                    self.audio_mixer.next_channel_id = channel.channel_id + 1

            # Restore active channel
            self.active_channel_id = config.get('active_channel_id')

            # Restore mixer settings
            self.audio_mixer.master_volume = config.get('master_volume', 1.0)
            self.audio_mixer.auto_gain = config.get('auto_gain', True)

            print(f"Loaded {len(self.audio_mixer.channels)} channels from configuration")

            # Refresh UI
            if hasattr(self, '_refresh_channel_tabs'):
                self._refresh_channel_tabs()
                self._update_channel_controls()

        except Exception as e:
            print(f"Error loading channel configuration: {e}")

    def get_selected_audio_device_index(self):
        """Get the device index for the selected audio device"""
        if not hasattr(self, 'audio_devices') or not self.audio_devices:
            return None

        # Try channel-specific device combo first
        if hasattr(self, 'channel_device_combo'):
            selected_name = self.channel_device_var.get()
        elif hasattr(self, 'audio_device_combo'):
            selected_name = self.audio_device_var.get()
        else:
            return None

        for idx, name in self.audio_devices:
            if name == selected_name:
                return idx

        return None
'''

def main():
    filename = 'iq_spectrum_display.py'

    print(f"Reading {filename}...")
    with open(filename, 'r') as f:
        content = f.read()

    # Check if methods already added
    if '_create_channel_control_widgets' in content:
        print("Phase 6 methods already integrated!")
        return

    print(f"Appending Phase 6 methods to {filename}...")
    with open(filename, 'a') as f:
        f.write(NEW_METHODS)

    print("✅ Phase 6 methods successfully integrated!")
    print(f"Added ~650 lines of code")
    print("\nNext steps:")
    print("1. Test the application")
    print("2. Verify tabbed UI appears")
    print("3. Test multi-channel functionality")

if __name__ == '__main__':
    main()
