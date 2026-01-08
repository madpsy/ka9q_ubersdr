#!/usr/bin/env python3
"""
Chat Display Window for UberSDR Python Client
Provides a chat interface similar to the web UI
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import json
import threading
import time
from datetime import datetime
from typing import Optional, Callable, Dict, List
import re
import webbrowser


class ChatDisplay:
    """Chat display window for UberSDR"""

    def __init__(self, parent, websocket_manager, radio_gui, on_close: Optional[Callable] = None):
        """
        Initialize chat display

        Args:
            parent: Parent tkinter window
            websocket_manager: DXClusterWebSocket manager instance
            radio_gui: Reference to RadioGUI instance for frequency/mode updates
            on_close: Callback when window is closed
        """
        self.parent = parent
        self.ws_manager = websocket_manager
        self.radio_gui = radio_gui
        self.on_close_callback = on_close
        self.username = None
        self.saved_username = None  # For auto-rejoin
        self.is_auto_rejoining = False  # Track if we're auto-rejoining
        self.pending_message = None  # Store message that failed during auto-rejoin
        self.muted_users = set()
        self.active_users = []
        self.synced_username = None
        self.is_syncing = False
        self.listbox_to_user = {}  # Map listbox index to user data
        self.emoji_popup = None  # Emoji picker popup window

        # @ mention autocomplete
        self.mention_matches = []  # List of matching usernames
        self.mention_index = 0  # Current selection index
        self.mention_listbox = None  # Suggestion listbox widget

        # Debouncing for radio status updates (100ms like JavaScript frontend)
        self.debounce_timer = None
        self.debounce_delay_ms = 100

        # Create window
        self.window = tk.Toplevel(parent)
        self.window.title("Chat")
        self.window.geometry("700x600")

        # Handle window close
        self.window.protocol("WM_DELETE_WINDOW", self.close)

        # Create UI
        self.create_widgets()

        # Register WebSocket callback for chat messages
        self.ws_manager.register_callback('chat', self.handle_chat_message)

        # Request active users after a short delay to ensure WebSocket is ready
        # This allows users to see who's online even before joining
        self.window.after(500, self.request_active_users)

# Add this helper function at the class level (after __init__)
    def _get_emoji_font(self):
        """Get appropriate emoji font for the current platform"""
        import platform
        system = platform.system()

        if system == 'Windows':
            return ('Segoe UI Emoji', 16)
        elif system == 'Darwin':  # macOS
            return ('Apple Color Emoji', 16)
        else:  # Linux and others
            # Try common Linux emoji fonts
            import tkinter.font as tkfont
            available_fonts = tkfont.families()

            # Preferred fonts in order
            for font in ['Noto Color Emoji', 'Symbola', 'DejaVu Sans']:
                if font in available_fonts:
                    return (font, 16)

            # Fallback to default
            return ('TkDefaultFont', 16)

    def create_widgets(self):
        """Create the chat UI widgets"""
        # Main container
        main_frame = ttk.Frame(self.window, padding="5")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        self.window.columnconfigure(0, weight=1)
        self.window.rowconfigure(0, weight=1)

        # Split into left (messages) and right (users) panels
        # Left panel - messages area
        left_frame = ttk.Frame(main_frame)
        left_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), padx=(0, 5))
        main_frame.columnconfigure(0, weight=2)
        main_frame.rowconfigure(0, weight=1)

        # Messages display
        messages_label = ttk.Label(left_frame, text="Messages")
        messages_label.grid(row=0, column=0, sticky=tk.W, pady=(0, 5))

        self.messages_text = scrolledtext.ScrolledText(
            left_frame,
            wrap=tk.CHAR,
            width=50,
            height=25,
            state='disabled',
            bg='#1a1a1a',
            fg='#ddd',
            font=('TkDefaultFont', 9)
        )
        self.messages_text.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        left_frame.columnconfigure(0, weight=1)
        left_frame.rowconfigure(1, weight=1)

        # Configure text tags for styling
        self.messages_text.tag_config('username', foreground='#4a9eff', font=('TkDefaultFont', 9, 'bold'))
        self.messages_text.tag_config('username_clickable', foreground='#4a9eff', font=('TkDefaultFont', 9, 'bold'), underline=1)
        self.messages_text.tag_config('own_username', foreground='#ff9f40', font=('TkDefaultFont', 9, 'bold'))
        self.messages_text.tag_config('timestamp', foreground='#666', font=('TkDefaultFont', 8))
        self.messages_text.tag_config('system', foreground='#999', font=('TkDefaultFont', 9, 'italic'))
        self.messages_text.tag_config('error', foreground='#ff6b6b', font=('TkDefaultFont', 9, 'bold'))
        self.messages_text.tag_config('mention', background='#ffc107', foreground='#000')
        self.messages_text.tag_config('link', foreground='#4a9eff', underline=1)

        # Bind click events for clickable usernames
        self.messages_text.tag_bind('username_clickable', '<Button-1>', self.on_username_click)
        self.messages_text.tag_bind('username_clickable', '<Enter>', self.on_username_enter)
        self.messages_text.tag_bind('username_clickable', '<Leave>', self.on_username_leave)

        # Tooltip for chat usernames
        self.chat_username_tooltip = None
        self.chat_tooltip_after_id = None

        # Username input area (shown when not logged in)
        self.username_frame = ttk.Frame(left_frame)
        self.username_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(5, 0))

        ttk.Label(self.username_frame, text="Username:").grid(row=0, column=0, sticky=tk.W, padx=(0, 5))
        self.username_var = tk.StringVar()
        self.username_entry = ttk.Entry(self.username_frame, textvariable=self.username_var, width=20)
        self.username_entry.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(0, 5))
        self.username_entry.bind('<Return>', lambda e: self.join_chat())

        self.join_btn = ttk.Button(self.username_frame, text="Join", command=self.join_chat)
        self.join_btn.grid(row=0, column=2)

        self.username_frame.columnconfigure(1, weight=1)

        # Message input area (shown when logged in)
        self.message_frame = ttk.Frame(left_frame)
        self.message_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(5, 0))
        self.message_frame.grid_remove()  # Hidden initially

        self.message_var = tk.StringVar()
        self.message_entry = ttk.Entry(self.message_frame, textvariable=self.message_var)
        self.message_entry.grid(row=0, column=0, sticky=(tk.W, tk.E), padx=(0, 5))
        self.message_entry.bind('<Return>', lambda e: self.send_message())
        self.message_entry.bind('<KeyRelease>', self.on_message_key_release)
        self.message_entry.bind('<Tab>', self.on_message_tab)
        self.message_entry.bind('<Up>', self.on_message_up)
        self.message_entry.bind('<Down>', self.on_message_down)
        self.message_entry.bind('<Escape>', self.on_message_escape)

        # Emoji button
        self.emoji_btn = ttk.Button(self.message_frame, text="😊", width=3, command=self.toggle_emoji_picker)
        self.emoji_btn.grid(row=0, column=1, padx=(0, 5))

        self.send_btn = ttk.Button(self.message_frame, text="Send", command=self.send_message)
        self.send_btn.grid(row=0, column=2)

        self.message_frame.columnconfigure(0, weight=1)

        # Right panel - users list
        right_frame = ttk.Frame(main_frame)
        right_frame.grid(row=0, column=1, sticky=(tk.W, tk.E, tk.N, tk.S))
        main_frame.columnconfigure(1, weight=1)

        users_label = ttk.Label(right_frame, text="Users (0)")
        users_label.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=(0, 5))
        self.users_label = users_label

        # Users listbox with scrollbar
        users_list_frame = ttk.Frame(right_frame)
        users_list_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        right_frame.columnconfigure(0, weight=1)
        right_frame.rowconfigure(1, weight=1)

        scrollbar = ttk.Scrollbar(users_list_frame, orient=tk.VERTICAL)
        self.users_listbox = tk.Listbox(
            users_list_frame,
            yscrollcommand=scrollbar.set,
            bg='#1a1a1a',
            fg='#aaa',
            font=('TkDefaultFont', 9),
            selectmode=tk.SINGLE
        )
        scrollbar.config(command=self.users_listbox.yview)

        self.users_listbox.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        scrollbar.grid(row=0, column=1, sticky=(tk.N, tk.S))
        users_list_frame.columnconfigure(0, weight=1)
        users_list_frame.rowconfigure(0, weight=1)

        # Bind double-click to tune to user
        self.users_listbox.bind('<Double-Button-1>', self.on_user_double_click)
        # Bind right-click to show context menu
        self.users_listbox.bind('<Button-3>', self.on_user_right_click)
        # Bind mouse motion to show tooltip
        self.users_listbox.bind('<Motion>', self.on_user_hover)
        self.users_listbox.bind('<Leave>', self.hide_user_tooltip)

        # Create tooltip label (initially hidden)
        self.user_tooltip = None
        self.tooltip_after_id = None

        # Buttons frame
        buttons_frame = ttk.Frame(right_frame)
        buttons_frame.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=(5, 0))

        # Sync button
        self.sync_btn = ttk.Button(buttons_frame, text="Sync", command=self.toggle_sync_selected, width=8)
        self.sync_btn.grid(row=0, column=0, sticky=(tk.W, tk.E), padx=(0, 5))
        self.sync_btn.state(['disabled'])  # Disabled until user selected

        # Leave button
        self.leave_btn = ttk.Button(buttons_frame, text="Leave", command=self.leave_chat, width=8)
        self.leave_btn.grid(row=0, column=1, sticky=(tk.W, tk.E))
        self.leave_btn.grid_remove()  # Hidden initially

        buttons_frame.columnconfigure(0, weight=1)
        buttons_frame.columnconfigure(1, weight=1)

        # Bind listbox selection to enable/disable sync button
        self.users_listbox.bind('<<ListboxSelect>>', self.on_user_selected)

        # Add system message
        self.add_system_message("Welcome to UberSDR Chat! Enter a username to join.")

    def on_user_selected(self, event=None):
        """Handle user selection in listbox"""
        selection = self.users_listbox.curselection()
        if selection and self.username:
            index = selection[0]
            # Use mapping to get actual user
            user = self.listbox_to_user.get(index)
            if user:
                # Don't allow syncing with ourselves
                if user.get('username') == self.username:
                    self.sync_btn.state(['disabled'])
                else:
                    self.sync_btn.state(['!disabled'])
                    # Update button text based on sync state
                    if self.synced_username == user.get('username'):
                        self.sync_btn.config(text="Unsync")
                    else:
                        self.sync_btn.config(text="Sync")
            else:
                self.sync_btn.state(['disabled'])
        else:
            self.sync_btn.state(['disabled'])

    def toggle_sync_selected(self):
        """Toggle sync with the selected user"""
        selection = self.users_listbox.curselection()
        if not selection:
            return

        index = selection[0]
        user = self.listbox_to_user.get(index)
        if not user:
            return

        username = user.get('username')

        if username == self.username:
            return

        self.toggle_sync(username)

    def on_user_right_click(self, event):
        """Handle right-click on user to show context menu"""
        # Select the item under cursor
        index = self.users_listbox.nearest(event.y)
        self.users_listbox.selection_clear(0, tk.END)
        self.users_listbox.selection_set(index)
        self.users_listbox.activate(index)

        # Use mapping to get actual user
        user = self.listbox_to_user.get(index)
        if not user:
            return

        username = user.get('username')

        # Don't show menu for ourselves
        if username == self.username:
            return

        # Create context menu
        menu = tk.Menu(self.window, tearoff=0)
        menu.add_command(label=f"Tune to {username}", command=lambda: self.tune_to_user(username))

        if self.synced_username == username:
            menu.add_command(label=f"Stop syncing with {username}", command=lambda: self.toggle_sync(username))
        else:
            menu.add_command(label=f"Sync with {username}", command=lambda: self.toggle_sync(username))

        menu.add_separator()
        if username in self.muted_users:
            menu.add_command(label=f"Unmute {username}", command=lambda: self.toggle_mute(username))
        else:
            menu.add_command(label=f"Mute {username}", command=lambda: self.toggle_mute(username))

        # Post menu and bind to close on focus out
        menu.post(event.x_root, event.y_root)

        # Close menu when clicking elsewhere
        def close_menu(e=None):
            menu.unpost()

        # Bind to window click to close menu
        self.window.bind('<Button-1>', close_menu, add='+')
        menu.bind('<FocusOut>', close_menu)

        # Unbind after menu is closed
        def cleanup():
            try:
                self.window.unbind('<Button-1>', close_menu)
            except:
                pass

        menu.bind('<Unmap>', lambda e: cleanup())

    def on_username_click(self, event):
        """Handle click on username in message to tune to that user"""
        # Get the tag range at click position
        index = self.messages_text.index(f"@{event.x},{event.y}")
        tag_ranges = self.messages_text.tag_ranges('username_clickable')

        # Find which username was clicked
        for i in range(0, len(tag_ranges), 2):
            start, end = tag_ranges[i], tag_ranges[i+1]
            if self.messages_text.compare(start, '<=', index) and self.messages_text.compare(index, '<', end):
                # Get the username text
                username_text = self.messages_text.get(start, end)
                # Remove the colon
                username = username_text.rstrip(':').strip()
                self.tune_to_user(username)
                break

    def on_username_enter(self, event):
        """Handle mouse entering a username in chat"""
        # Change cursor
        self.messages_text.config(cursor='hand2')

        # Cancel any pending tooltip
        if self.chat_tooltip_after_id:
            self.window.after_cancel(self.chat_tooltip_after_id)
            self.chat_tooltip_after_id = None

        # Get the username at cursor position
        index = self.messages_text.index(f"@{event.x},{event.y}")
        tag_ranges = self.messages_text.tag_ranges('username_clickable')

        # Find which username is under cursor
        for i in range(0, len(tag_ranges), 2):
            start, end = tag_ranges[i], tag_ranges[i+1]
            if self.messages_text.compare(start, '<=', index) and self.messages_text.compare(index, '<', end):
                # Get the username text
                username_text = self.messages_text.get(start, end)
                username = username_text.rstrip(':').strip()

                # Schedule tooltip after 500ms
                self.chat_tooltip_after_id = self.window.after(
                    500,
                    lambda: self.show_chat_username_tooltip(event, username)
                )
                break

    def on_username_leave(self, event):
        """Handle mouse leaving a username in chat"""
        # Reset cursor
        self.messages_text.config(cursor='')

        # Hide tooltip
        self.hide_chat_username_tooltip()

    def show_chat_username_tooltip(self, event, username):
        """Show tooltip for username in chat"""
        self.chat_tooltip_after_id = None

        # Find user in active users
        user = next((u for u in self.active_users if u.get('username') == username), None)

        if not user:
            return

        freq = user.get('frequency')
        mode = user.get('mode', '').upper()

        if freq and mode:
            freq_mhz = freq / 1e6
            tooltip_text = f"Click to tune to {freq_mhz:.3f} MHz ({mode})"
        else:
            tooltip_text = f"Click to tune to {username}"

        # Create tooltip
        if self.chat_username_tooltip:
            self.chat_username_tooltip.destroy()

        self.chat_username_tooltip = tk.Toplevel(self.window)
        self.chat_username_tooltip.wm_overrideredirect(True)
        self.chat_username_tooltip.wm_geometry(f"+{event.x_root + 10}+{event.y_root + 10}")

        label = tk.Label(
            self.chat_username_tooltip,
            text=tooltip_text,
            background='#2a2a2a',
            foreground='#ddd',
            relief=tk.SOLID,
            borderwidth=1,
            font=('TkDefaultFont', 9),
            padx=8,
            pady=6
        )
        label.pack()

    def hide_chat_username_tooltip(self):
        """Hide chat username tooltip"""
        # Cancel any pending tooltip
        if self.chat_tooltip_after_id:
            self.window.after_cancel(self.chat_tooltip_after_id)
            self.chat_tooltip_after_id = None

        # Destroy existing tooltip
        if self.chat_username_tooltip:
            self.chat_username_tooltip.destroy()
            self.chat_username_tooltip = None

    def _on_chat_username_enter(self, event, username):
        """Handle mouse entering a username in chat (called from tag binding)"""
        # Change cursor
        self.messages_text.config(cursor='hand2')

        # Cancel any pending tooltip
        if self.chat_tooltip_after_id:
            self.window.after_cancel(self.chat_tooltip_after_id)
            self.chat_tooltip_after_id = None

        # Schedule tooltip after 500ms
        self.chat_tooltip_after_id = self.window.after(
            500,
            lambda: self.show_chat_username_tooltip(event, username)
        )

    def _on_chat_username_leave(self, event):
        """Handle mouse leaving a username in chat (called from tag binding)"""
        # Reset cursor
        self.messages_text.config(cursor='')

        # Hide tooltip
        self.hide_chat_username_tooltip()

    def join_chat(self):
        """Join the chat with the entered username"""
        username = self.username_var.get().strip()

        # Validate username
        if not username:
            messagebox.showerror("Error", "Please enter a username")
            return

        if len(username) < 1 or len(username) > 15:
            messagebox.showerror("Error", "Username must be 1-15 characters")
            return

        # Allow alphanumeric plus hyphens, underscores, forward slashes (not at start/end)
        # Pattern: alphanumeric at start and end, any allowed chars in middle, OR single alphanumeric
        if not re.match(r'^[A-Za-z0-9]([A-Za-z0-9\-_/]*[A-Za-z0-9])?$', username):
            messagebox.showerror("Error", "Username must contain only letters, numbers, hyphens, underscores, and forward slashes.\nSpecial characters cannot be at the start or end.")
            return

        # Check if username is already taken (case-insensitive)
        if any(u.get('username', '').lower() == username.lower() for u in self.active_users):
            messagebox.showerror("Error", f"Username '{username}' is already taken. Please choose a different username.")
            return

        # Send join message via WebSocket
        try:
            self.ws_manager.send_message({
                'type': 'chat_set_username',
                'username': username
            })
            self.username = username
            self.saved_username = username  # Save for auto-rejoin

            # Switch UI to message input
            self.username_frame.grid_remove()
            self.message_frame.grid()
            self.leave_btn.grid()

            self.add_system_message(f"You joined as {username}")

            # Focus message input
            self.message_entry.focus()

            # Send initial frequency/mode/bandwidth
            self.send_radio_status()

            # Request active users
            self.request_active_users()

        except Exception as e:
            messagebox.showerror("Error", f"Failed to join chat: {e}")

    def leave_chat(self):
        """Leave the chat and close the window"""
        if not messagebox.askyesno("Leave Chat", "Are you sure you want to leave the chat?"):
            return

        try:
            self.ws_manager.send_message({
                'type': 'chat_leave'
            })

            self.username = None
            self.synced_username = None

            # Close the chat window
            self.close()

        except Exception as e:
            messagebox.showerror("Error", f"Failed to leave chat: {e}")

    def send_message(self):
        """Send a chat message"""
        if not self.username:
            return

        message = self.message_var.get().strip()
        if not message:
            return

        if len(message) > 250:
            messagebox.showerror("Error", "Message must be 250 characters or less")
            return

        try:
            self.ws_manager.send_message({
                'type': 'chat_message',
                'message': message
            })

            # Clear input
            self.message_var.set('')

        except Exception as e:
            self.add_error_message(f"Failed to send message: {e}")

    def send_radio_status(self):
        """Send current frequency/mode/bandwidth/CAT/TX status to chat"""
        if not self.username or not self.radio_gui:
            return

        try:
            # Get current radio settings from radio_gui
            freq_hz = self.radio_gui.get_frequency_hz()
            mode = self.radio_gui.mode_var.get().lower()
            bw_low = int(self.radio_gui.bw_low_var.get())
            bw_high = int(self.radio_gui.bw_high_var.get())

            # Get zoom bandwidth from spectrum display
            zoom_bw = 0
            if self.radio_gui.spectrum and hasattr(self.radio_gui.spectrum, 'bin_bandwidth'):
                zoom_bw = self.radio_gui.spectrum.bin_bandwidth

            # Get CAT control status (true if any radio control is connected)
            cat_enabled = False
            if hasattr(self.radio_gui, 'radio_control_connected'):
                cat_enabled = self.radio_gui.radio_control_connected
            if hasattr(self.radio_gui, 'radio_control') and self.radio_gui.radio_control:
                cat_enabled = True

            # Debug logging
            print(f"DEBUG send_radio_status: cat_enabled={cat_enabled}, has_radio_control={hasattr(self.radio_gui, 'radio_control')}, radio_control={self.radio_gui.radio_control if hasattr(self.radio_gui, 'radio_control') else None}")

            # Get TX status from radio control (PTT state)
            tx_status = False
            if cat_enabled and hasattr(self.radio_gui, 'radio_control') and self.radio_gui.radio_control:
                # Check if radio control has PTT status
                if hasattr(self.radio_gui.radio_control, 'get_ptt'):
                    try:
                        tx_status = self.radio_gui.radio_control.get_ptt()
                    except:
                        pass
                # For rigctl, check cached PTT value
                elif hasattr(self.radio_gui.radio_control, '_cached_ptt'):
                    tx_status = self.radio_gui.radio_control._cached_ptt

            # Send to server
            self.ws_manager.send_message({
                'type': 'chat_set_frequency_mode',
                'frequency': freq_hz,
                'mode': mode,
                'bw_high': bw_high,
                'bw_low': bw_low,
                'zoom_bw': zoom_bw,
                'cat': cat_enabled,
                'tx': tx_status
            })

        except Exception as e:
            print(f"Failed to send radio status: {e}")

    def request_active_users(self):
        """Request the list of active users"""
        try:
            self.ws_manager.send_message({
                'type': 'chat_request_users'
            })
        except Exception as e:
            print(f"Failed to request active users: {e}")

    def handle_chat_message(self, msg: dict):
        """Handle incoming chat messages from WebSocket"""
        msg_type = msg.get('type', '')

        if msg_type == 'chat_message':
            data = msg.get('data', {})
            username = data.get('username', 'Unknown')
            message = data.get('message', '')
            timestamp = data.get('timestamp', '')

            # Check if user is muted
            if username not in self.muted_users:
                # Check if this mentions us
                is_mention = self.username and f'@{self.username.lower()}' in message.lower()
                self.add_chat_message(username, message, timestamp, is_mention)

        elif msg_type == 'chat_user_joined':
            data = msg.get('data', {})
            username = data.get('username', 'Unknown')
            if username == self.username:
                # Confirmation of our join
                if self.is_auto_rejoining:
                    # Auto-rejoin succeeded
                    print(f"[Chat] Auto-rejoin successful as: {username}")
                    self.is_auto_rejoining = False

                    # Send any pending message that failed before rejoin
                    if self.pending_message:
                        print(f"[Chat] Sending pending message after auto-rejoin: {self.pending_message}")
                        message_to_send = self.pending_message
                        self.pending_message = None  # Clear before sending to avoid loops

                        # Send after a short delay to ensure join is fully processed
                        def send_pending():
                            try:
                                self.ws_manager.send_message({
                                    'type': 'chat_message',
                                    'message': message_to_send
                                })
                                # Clear the input field
                                self.message_var.set('')
                            except Exception as e:
                                print(f"[Chat] Failed to send pending message: {e}")
                                self.add_error_message(f"Failed to send message: {e}")

                        self.window.after(100, send_pending)
            else:
                self.add_system_message(f"{username} joined")
                self.request_active_users()

        elif msg_type == 'chat_user_left':
            data = msg.get('data', {})
            username = data.get('username', 'Unknown')
            self.add_system_message(f"{username} left")
            # If we were synced with this user, stop syncing
            if self.synced_username == username:
                self.synced_username = None
                self.add_system_message(f"Stopped syncing (user left)")
            self.request_active_users()

        elif msg_type == 'chat_active_users':
            data = msg.get('data', {})
            self.update_active_users(data)

        elif msg_type == 'chat_user_update':
            data = msg.get('data', {})
            self.update_single_user(data)

        elif msg_type == 'chat_error':
            error = msg.get('error', 'Unknown error')

            # If server says username not set but we have a saved username, auto-rejoin
            if error == 'username not set' and self.saved_username:
                print(f"[Chat] Server lost our session, automatically re-joining as: {self.saved_username}")

                # Store any pending message from the input field
                current_message = self.message_var.get().strip()
                if current_message:
                    self.pending_message = current_message
                    print(f"[Chat] Stored pending message for retry after rejoin: {self.pending_message}")

                self.is_auto_rejoining = True

                # Send rejoin request
                try:
                    self.ws_manager.send_message({
                        'type': 'chat_set_username',
                        'username': self.saved_username
                    })
                    self.username = self.saved_username

                    # Request users after a short delay
                    self.window.after(200, self.request_active_users)
                except Exception as e:
                    print(f"[Chat] Auto-rejoin failed: {e}")
                    self.is_auto_rejoining = False
                    self.saved_username = None
                    self.add_error_message(f"Auto-rejoin failed: {e}")

                return  # Don't show error to user, we're handling it automatically

            self.add_error_message(error)

    def add_chat_message(self, username: str, message: str, timestamp: str, is_mention: bool = False):
        """Add a chat message to the display"""
        self.messages_text.config(state='normal')

        # Parse timestamp
        try:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            time_str = dt.strftime('%H:%M')
        except:
            time_str = ''

        # Build the entire line first, then insert it
        # This prevents wrapping issues where long messages start on a new line

        # Add timestamp
        if time_str:
            self.messages_text.insert(tk.END, f"[{time_str}] ", 'timestamp')

        # Add username (clickable if not our own message)
        is_own = username == self.username
        if is_own:
            self.messages_text.insert(tk.END, f"{username}: ", 'own_username')
        else:
            # Make username clickable to tune - use unique tag for this specific username instance
            unique_tag = f'username_clickable_{id(username)}_{time_str}'
            self.messages_text.insert(tk.END, f"{username}: ", ('username_clickable', unique_tag))

            # Bind events to this specific tag instance
            self.messages_text.tag_bind(unique_tag, '<Button-1>',
                lambda e, u=username: self.tune_to_user(u))
            self.messages_text.tag_bind(unique_tag, '<Enter>',
                lambda e, u=username: self._on_chat_username_enter(e, u))
            self.messages_text.tag_bind(unique_tag, '<Leave>',
                lambda e: self._on_chat_username_leave(e))

        # Add message on the same line (highlight mentions and linkify URLs)
        if is_mention and self.username:
            # Split message and highlight mentions, then linkify URLs
            parts = re.split(f'(@{re.escape(self.username)})', message, flags=re.IGNORECASE)
            for part in parts:
                if part.lower() == f'@{self.username.lower()}':
                    self.messages_text.insert(tk.END, part, 'mention')
                else:
                    # Linkify URLs in this part
                    self._insert_text_with_links(part)
        else:
            # Linkify URLs in the entire message
            self._insert_text_with_links(message)

        # Add newline at the end of the complete message
        self.messages_text.insert(tk.END, '\n')

        self.messages_text.config(state='disabled')
        self.messages_text.see(tk.END)

    def _insert_text_with_links(self, text: str):
        """Insert text with URLs converted to clickable links"""
        # Match URLs starting with http:// or https://
        url_pattern = r'(https?://[^\s]+)'
        parts = re.split(url_pattern, text)

        for part in parts:
            if re.match(url_pattern, part):
                # This is a URL - make it clickable
                # Create a unique tag for this link
                link_tag = f'link_{id(part)}_{time.time()}'
                self.messages_text.insert(tk.END, part, ('link', link_tag))

                # Bind click event to open URL
                self.messages_text.tag_bind(link_tag, '<Button-1>',
                    lambda e, url=part: self._open_url(url))
                # Change cursor on hover
                self.messages_text.tag_bind(link_tag, '<Enter>',
                    lambda e: self.messages_text.config(cursor='hand2'))
                self.messages_text.tag_bind(link_tag, '<Leave>',
                    lambda e: self.messages_text.config(cursor=''))
            else:
                # Regular text
                self.messages_text.insert(tk.END, part)

    def _open_url(self, url: str):
        """Open URL in default web browser"""
        try:
            webbrowser.open(url)
        except Exception as e:
            print(f"Failed to open URL {url}: {e}")

    def add_system_message(self, message: str):
        """Add a system message to the display"""
        self.messages_text.config(state='normal')
        self.messages_text.insert(tk.END, f"{message}\n", 'system')
        self.messages_text.config(state='disabled')
        self.messages_text.see(tk.END)

    def add_error_message(self, message: str):
        """Add an error message to the display"""
        self.messages_text.config(state='normal')
        self.messages_text.insert(tk.END, f"Error: {message}\n", 'error')
        self.messages_text.config(state='disabled')
        self.messages_text.see(tk.END)

    def update_active_users(self, data: dict):
        """Update the active users list"""
        users = data.get('users', [])
        count = data.get('count', 0)

        self.active_users = users
        self.users_label.config(text=f"Users ({count})")

        # Update listbox
        self.users_listbox.delete(0, tk.END)
        self.listbox_to_user.clear()

        if count == 0:
            if self.username:
                self.users_listbox.insert(tk.END, "No other users")
            else:
                self.users_listbox.insert(tk.END, "Join to see users")
            return

        # Sort users: synced first, then alphabetically
        sorted_users = sorted(users, key=lambda u: (
            u['username'] != self.synced_username,
            u['username'].lower()
        ))

        for listbox_index, user in enumerate(sorted_users):
            username = user.get('username', 'Unknown')
            freq = user.get('frequency')
            mode = user.get('mode', '').upper()
            cat = user.get('cat', False)
            tx = user.get('tx', False)

            # Store mapping from listbox index to user data
            self.listbox_to_user[listbox_index] = user

            # Format display
            display = username

            # Add CAT control indicator (after username, before frequency)
            if cat:
                display += " 🔧"

            # Add TX status indicator (after CAT, before frequency)
            if tx:
                display += " 📡"

            # Add frequency and mode
            if freq:
                freq_mhz = freq / 1e6
                display += f" - {freq_mhz:.3f} MHz"
            if mode:
                display += f" {mode}"

            # Mark synced user
            if username == self.synced_username:
                display = f"🔗 {display}"

            # Mark own user
            if username == self.username:
                display = f"★ {display}"

            self.users_listbox.insert(tk.END, display)

    def update_single_user(self, data: dict):
        """Update a single user's information"""
        username = data.get('username')
        if not username:
            return

        # Update in active_users list
        for i, user in enumerate(self.active_users):
            if user.get('username') == username:
                self.active_users[i].update(data)
                break

        # Refresh display
        self.update_active_users({
            'users': self.active_users,
            'count': len(self.active_users)
        })

        # If this is the user we're synced with, update our radio
        if self.synced_username == username and not self.is_syncing:
            user = self.active_users[i] if i < len(self.active_users) else None
            if user:
                self.sync_to_user(user)

    def toggle_sync(self, username: str):
        """Toggle sync with a user"""
        if self.synced_username == username:
            # Unsync
            self.synced_username = None
            self.add_system_message(f"Stopped syncing with {username}")
        else:
            # Sync with this user
            self.synced_username = username
            self.add_system_message(f"Now syncing with {username}")

            # Immediately sync to their current settings if available
            user = next((u for u in self.active_users if u.get('username') == username), None)
            if user:
                self.sync_to_user(user)

        # Refresh the user list to update display
        self.update_active_users({
            'users': self.active_users,
            'count': len(self.active_users)
        })

        # Update sync button text
        self.on_user_selected()

    def sync_to_user(self, user: dict):
        """Sync our radio to a user's settings"""
        if not user.get('frequency') or not user.get('mode'):
            return

        # Set syncing flag to prevent update loops
        # This flag is only set during the actual sync operation
        self.is_syncing = True

        try:
            freq = user.get('frequency')
            mode = user.get('mode', 'usb').upper()
            bw_low = user.get('bw_low', 50)
            bw_high = user.get('bw_high', 2700)
            zoom_bw = user.get('zoom_bw', 0)

            # Update radio GUI
            self.radio_gui.set_frequency_hz(freq)

            # Set mode if not locked
            if not self.radio_gui.mode_lock_var.get():
                self.radio_gui.mode_var.set(mode)
                self.radio_gui.on_mode_changed()

            # Set bandwidth
            self.radio_gui.bw_low_var.set(bw_low)
            self.radio_gui.bw_high_var.set(bw_high)
            self.radio_gui.bw_low_label.config(text=f"{bw_low} Hz")
            self.radio_gui.bw_high_label.config(text=f"{bw_high} Hz")

            # Update client bandwidth values
            if self.radio_gui.client:
                self.radio_gui.client.bandwidth_low = bw_low
                self.radio_gui.client.bandwidth_high = bw_high

            # Update spectrum displays
            if self.radio_gui.spectrum:
                self.radio_gui.spectrum.update_bandwidth(bw_low, bw_high, mode.lower())
            if self.radio_gui.waterfall_display:
                self.radio_gui.waterfall_display.update_bandwidth(bw_low, bw_high, mode.lower())
            if self.radio_gui.audio_spectrum_display:
                self.radio_gui.audio_spectrum_display.update_bandwidth(bw_low, bw_high, mode.lower())

            # Apply zoom bandwidth if provided and spectrum is connected
            if zoom_bw > 0 and self.radio_gui.spectrum:
                spectrum = self.radio_gui.spectrum
                if spectrum.connected and spectrum.bin_count > 0:
                    # Calculate total bandwidth from bin bandwidth
                    new_total_bandwidth = zoom_bw * spectrum.bin_count
                    # Send zoom command via the spectrum's event loop
                    import asyncio
                    if spectrum.event_loop and spectrum.event_loop.is_running():
                        asyncio.run_coroutine_threadsafe(
                            spectrum._send_zoom_command(freq, new_total_bandwidth),
                            spectrum.event_loop
                        )
                        print(f"Applied synced zoom: {new_total_bandwidth/1000:.1f} KHz ({zoom_bw:.2f} Hz/bin)")

            # Apply changes if connected (skip auto mode to preserve synced mode)
            if self.radio_gui.connected:
                self.radio_gui.apply_frequency(skip_auto_mode=True)

        finally:
            # Clear syncing flag after a SHORT delay (200ms instead of 500ms)
            # This prevents loops from incoming sync updates, but allows user changes to be sent
            def clear_sync_and_notify():
                self.is_syncing = False
                # Send our updated position to chat after sync completes
                self.send_radio_status()
            self.window.after(200, clear_sync_and_notify)

    def tune_to_user(self, username: str):
        """Tune to a user's frequency"""
        user = next((u for u in self.active_users if u.get('username') == username), None)
        if not user:
            return

        freq = user.get('frequency')
        mode = user.get('mode')

        if freq and mode:
            self.sync_to_user(user)
            self.add_system_message(f"Tuned to {username}'s frequency")
        else:
            messagebox.showinfo("Info", f"{username} has no frequency/mode set")

    def toggle_mute(self, username: str):
        """Toggle mute for a user"""
        if username in self.muted_users:
            self.muted_users.remove(username)
            self.add_system_message(f"Unmuted {username}")
        else:
            self.muted_users.add(username)
            self.add_system_message(f"Muted {username}")

        # Refresh display
        self.update_active_users({
            'users': self.active_users,
            'count': len(self.active_users)
        })

    def on_user_double_click(self, event):
        """Handle double-click on user to tune to their frequency"""
        selection = self.users_listbox.curselection()
        if not selection:
            return

        index = selection[0]
        user = self.listbox_to_user.get(index)
        if not user:
            return

        username = user.get('username')

        # Don't tune to ourselves
        if username == self.username:
            return

        self.tune_to_user(username)

    def on_radio_changed(self):
        """Called when radio settings change in the main GUI - debounced"""
        if self.username and not self.is_syncing:
            # Debounce the send (100ms delay like JavaScript frontend)
            if self.debounce_timer:
                self.window.after_cancel(self.debounce_timer)

            self.debounce_timer = self.window.after(self.debounce_delay_ms, self._send_radio_status_debounced)

    def _send_radio_status_debounced(self):
        """Internal method called after debounce delay"""
        self.debounce_timer = None
        if self.username and not self.is_syncing:
            self.send_radio_status()

    def toggle_emoji_picker(self):
        """Toggle emoji picker popup"""
        if self.emoji_popup and self.emoji_popup.winfo_exists():
            self.emoji_popup.destroy()
            self.emoji_popup = None
        else:
            self.show_emoji_picker()

    def show_emoji_picker(self):
        """Show emoji picker popup with common emojis (same as web UI)"""
        # Same emojis as web UI
        emojis = [
            '😊', '😂', '🤣', '😍', '😎', '🤔', '👍', '👎',
            '❤️', '🎉', '🔥', '⭐', '✨', '💯', '🚀', '🎯',
            '👋', '🙏', '💪', '🤝', '👏', '🎵', '📻', '📡',
            '🌟', '💡', '⚡', '🌈', '☀️', '🌙', '⚙️', '🔧'
        ]

        # Create popup window
        self.emoji_popup = tk.Toplevel(self.window)
        self.emoji_popup.title("Select Emoji")
        self.emoji_popup.transient(self.window)
        self.emoji_popup.resizable(False, False)

        # Position near emoji button
        x = self.emoji_btn.winfo_rootx()
        y = self.emoji_btn.winfo_rooty() - 200  # Above the button
        self.emoji_popup.geometry(f"+{x}+{y}")

        # Create grid of emoji buttons (8 columns)
        frame = ttk.Frame(self.emoji_popup, padding="5")
        frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        for i, emoji in enumerate(emojis):
            row = i // 8
            col = i % 8
            btn = tk.Button(
                frame,
                text=emoji,
                font=self._get_emoji_font(),
                width=2,
                height=1,
                command=lambda e=emoji: self.insert_emoji(e),
                relief=tk.FLAT,
                bg='#2a2a2a',
                fg='white',
                activebackground='#4a9eff',
                cursor='hand2'
            )
            btn.grid(row=row, column=col, padx=2, pady=2)

        # Close on focus out
        self.emoji_popup.bind('<FocusOut>', lambda e: self.close_emoji_picker())

        # Close on Escape
        self.emoji_popup.bind('<Escape>', lambda e: self.close_emoji_picker())

    def insert_emoji(self, emoji: str):
        """Insert emoji at cursor position in message entry"""
        # Get current cursor position
        cursor_pos = self.message_entry.index(tk.INSERT)

        # Insert emoji at cursor
        self.message_entry.insert(cursor_pos, emoji)

        # Focus back to message entry
        self.message_entry.focus()

        # Close picker
        self.close_emoji_picker()

    def close_emoji_picker(self):
        """Close emoji picker popup"""
        if self.emoji_popup and self.emoji_popup.winfo_exists():
            self.emoji_popup.destroy()
            self.emoji_popup = None

    def on_message_key_release(self, event):
        """Handle key release in message entry to update @ mention suggestions"""
        # Ignore special keys
        if event.keysym in ['Up', 'Down', 'Left', 'Right', 'Tab', 'Escape', 'Return']:
            return

        self.update_mention_suggestions()

    def on_message_tab(self, event):
        """Handle Tab key for @ mention completion"""
        if self.mention_matches:
            self.complete_mention()
            return 'break'  # Prevent default Tab behavior
        return None

    def on_message_up(self, event):
        """Handle Up arrow to navigate mention suggestions"""
        if self.mention_matches and self.mention_listbox:
            self.mention_index = max(0, self.mention_index - 1)
            self.mention_listbox.selection_clear(0, tk.END)
            self.mention_listbox.selection_set(self.mention_index)
            self.mention_listbox.see(self.mention_index)
            return 'break'  # Prevent cursor movement
        return None

    def on_message_down(self, event):
        """Handle Down arrow to navigate mention suggestions"""
        if self.mention_matches and self.mention_listbox:
            self.mention_index = min(len(self.mention_matches) - 1, self.mention_index + 1)
            self.mention_listbox.selection_clear(0, tk.END)
            self.mention_listbox.selection_set(self.mention_index)
            self.mention_listbox.see(self.mention_index)
            return 'break'  # Prevent cursor movement
        return None

    def on_message_escape(self, event):
        """Handle Escape key to hide mention suggestions"""
        if self.mention_matches:
            self.hide_mention_suggestions()
            return 'break'
        return None

    def update_mention_suggestions(self):
        """Update @ mention suggestions based on current input"""
        text = self.message_var.get()
        cursor_pos = self.message_entry.index(tk.INSERT)

        # Find @ mention before cursor
        text_before_cursor = text[:cursor_pos]

        # Match @ followed by word characters
        import re
        match = re.search(r'@(\w*)$', text_before_cursor)

        if not match:
            self.hide_mention_suggestions()
            return

        partial_username = match.group(1).lower()

        # Find matching usernames from active users
        self.mention_matches = [
            user['username'] for user in self.active_users
            if user['username'].lower().startswith(partial_username) and user['username'] != self.username
        ]
        self.mention_matches.sort()

        if not self.mention_matches:
            self.hide_mention_suggestions()
            return

        # Reset index if needed
        if self.mention_index >= len(self.mention_matches):
            self.mention_index = 0

        self.show_mention_suggestions()

    def show_mention_suggestions(self):
        """Show @ mention suggestions listbox"""
        if not self.mention_listbox:
            # Create listbox below message entry
            self.mention_listbox = tk.Listbox(
                self.message_frame,
                height=min(5, len(self.mention_matches)),
                bg='#2a2a2a',
                fg='white',
                selectbackground='#4a9eff',
                selectforeground='white',
                font=('TkDefaultFont', 9),
                relief=tk.SOLID,
                borderwidth=1
            )
            self.mention_listbox.grid(row=1, column=0, columnspan=3, sticky=(tk.W, tk.E), pady=(2, 0))

            # Bind click to complete mention
            self.mention_listbox.bind('<Button-1>', lambda e: self.on_mention_click())

        # Update listbox content
        self.mention_listbox.delete(0, tk.END)
        for username in self.mention_matches:
            self.mention_listbox.insert(tk.END, username)

        # Select current index
        if self.mention_matches:
            self.mention_listbox.selection_set(self.mention_index)
            self.mention_listbox.see(self.mention_index)

        # Update height
        self.mention_listbox.config(height=min(5, len(self.mention_matches)))

    def hide_mention_suggestions(self):
        """Hide @ mention suggestions listbox"""
        if self.mention_listbox:
            self.mention_listbox.grid_remove()
        self.mention_matches = []
        self.mention_index = 0

    def on_mention_click(self):
        """Handle click on mention suggestion"""
        if self.mention_listbox:
            selection = self.mention_listbox.curselection()
            if selection:
                self.mention_index = selection[0]
                self.complete_mention()

    def complete_mention(self):
        """Complete the @ mention with selected username"""
        if not self.mention_matches or self.mention_index >= len(self.mention_matches):
            return

        text = self.message_var.get()
        cursor_pos = self.message_entry.index(tk.INSERT)

        # Find @ mention before cursor
        text_before_cursor = text[:cursor_pos]
        import re
        match = re.search(r'@(\w*)$', text_before_cursor)

        if not match:
            return

        at_position = match.start()
        completed_username = self.mention_matches[self.mention_index]
        text_after_cursor = text[cursor_pos:]

        # Build new text with completed username
        new_text = text[:at_position] + '@' + completed_username + ' ' + text_after_cursor

        # Update entry
        self.message_var.set(new_text)

        # Set cursor after completed username and space
        new_cursor_pos = at_position + len(completed_username) + 2  # +2 for @ and space
        self.message_entry.icursor(new_cursor_pos)

        # Hide suggestions
        self.hide_mention_suggestions()

        # Focus back to entry
        self.message_entry.focus()

    def on_user_hover(self, event):
        """Show tooltip when hovering over a user in the list"""
        # Cancel any pending tooltip
        if self.tooltip_after_id:
            self.window.after_cancel(self.tooltip_after_id)
            self.tooltip_after_id = None

        # Get the index of the item under the mouse
        index = self.users_listbox.nearest(event.y)
        if index < 0:
            self.hide_user_tooltip()
            return

        # Get user data
        user = self.listbox_to_user.get(index)
        if not user:
            self.hide_user_tooltip()
            return

        # Schedule tooltip to appear after 500ms
        self.tooltip_after_id = self.window.after(500, lambda: self.show_user_tooltip(event, user))

    def show_user_tooltip(self, event, user):
        """Display tooltip with user information"""
        self.tooltip_after_id = None

        # Build tooltip text
        username = user.get('username', 'Unknown')
        freq = user.get('frequency')
        mode = user.get('mode', '').upper()
        cat = user.get('cat', False)
        tx = user.get('tx', False)

        tooltip_lines = [username]

        if freq:
            freq_mhz = freq / 1e6
            tooltip_lines.append(f"Frequency: {freq_mhz:.6f} MHz")

        if mode:
            tooltip_lines.append(f"Mode: {mode}")

        # Add icon explanations
        if cat:
            tooltip_lines.append("🔧 CAT Control: Enabled")

        if tx:
            tooltip_lines.append("📡 TX Status: Transmitting")

        if username == self.synced_username:
            tooltip_lines.append("🔗 Synced")

        if username == self.username:
            tooltip_lines.append("★ You")

        tooltip_text = '\n'.join(tooltip_lines)

        # Create or update tooltip
        if self.user_tooltip:
            self.user_tooltip.destroy()

        self.user_tooltip = tk.Toplevel(self.window)
        self.user_tooltip.wm_overrideredirect(True)
        self.user_tooltip.wm_geometry(f"+{event.x_root + 10}+{event.y_root + 10}")

        label = tk.Label(
            self.user_tooltip,
            text=tooltip_text,
            background='#2a2a2a',
            foreground='#ddd',
            relief=tk.SOLID,
            borderwidth=1,
            font=('TkDefaultFont', 9),
            justify=tk.LEFT,
            padx=8,
            pady=6
        )
        label.pack()

    def hide_user_tooltip(self, event=None):
        """Hide the user tooltip"""
        # Cancel any pending tooltip
        if self.tooltip_after_id:
            self.window.after_cancel(self.tooltip_after_id)
            self.tooltip_after_id = None

        # Destroy existing tooltip
        if self.user_tooltip:
            self.user_tooltip.destroy()
            self.user_tooltip = None

    def close(self):
        """Close the chat window"""
        # Hide tooltips if showing
        self.hide_user_tooltip()
        self.hide_chat_username_tooltip()

        # Unregister callback
        self.ws_manager.unregister_callback('chat')

        # Leave chat if joined
        if self.username:
            try:
                self.ws_manager.send_message({
                    'type': 'chat_leave'
                })
            except:
                pass

        # Call close callback
        if self.on_close_callback:
            self.on_close_callback()

        # Destroy window
        self.window.destroy()


def create_chat_window(parent, websocket_manager, radio_gui, on_close: Optional[Callable] = None):
    """
    Create a chat window

    Args:
        parent: Parent tkinter window
        websocket_manager: DXClusterWebSocket manager instance
        radio_gui: Reference to RadioGUI instance
        on_close: Callback when window is closed

    Returns:
        ChatDisplay instance
    """
    return ChatDisplay(parent, websocket_manager, radio_gui, on_close)
