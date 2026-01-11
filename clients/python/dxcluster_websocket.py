"""
Shared WebSocket manager for DX Cluster connections.
Handles both CW spots and digital spots with a single WebSocket connection.
"""

import json
import queue
import threading
import time
import websocket
from typing import Callable, Optional, Dict, Any


class DXClusterWebSocket:
    """Manages a shared WebSocket connection for DX cluster spots."""

    def __init__(self, base_url: str, user_session_id: str):
        """
        Initialize the WebSocket manager.

        Args:
            base_url: Base URL of the server (e.g., "ws://localhost:8073")
            user_session_id: User session ID for authentication
        """
        self.base_url = base_url
        self.user_session_id = user_session_id
        self.ws_url = f"{base_url}/ws/dxcluster?user_session_id={user_session_id}"

        self.ws: Optional[websocket.WebSocketApp] = None
        self.ws_thread: Optional[threading.Thread] = None
        self.running = False
        self.connected = False

        # Callbacks for different message types
        self.cw_spot_callbacks = []
        self.digital_spot_callbacks = []
        self.status_callbacks = []
        self.chat_callbacks = []  # Chat message callbacks

        # Lock for thread-safe callback management
        self.callback_lock = threading.Lock()

        # Track pending subscriptions (to send when connection opens)
        self._pending_subscriptions = set()

    def connect(self):
        """Start the WebSocket connection."""
        if self.running:
            return

        self.running = True
        self._create_websocket()

        self.ws_thread = threading.Thread(target=self._run_websocket, daemon=True)
        self.ws_thread.start()

    def _create_websocket(self):
        """Create a new WebSocket instance."""
        self.ws = websocket.WebSocketApp(
            self.ws_url,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close
        )

    def disconnect(self):
        """Stop the WebSocket connection."""
        self.running = False
        if self.ws:
            self.ws.close()
        if self.ws_thread:
            self.ws_thread.join(timeout=2.0)

    def _run_websocket(self):
        """Run the WebSocket connection with automatic reconnection."""
        while self.running:
            try:
                # Enable ping/pong handling to keep connection alive
                # ping_timeout: Maximum time to wait for pong response (10 seconds)
                # The server sends pings every 30 seconds, and we respond with pongs
                # This ensures the server updates our LastSeen timestamp for chat
                self.ws.run_forever(ping_timeout=10)
            except Exception as e:
                print(f"WebSocket error: {e}")

            if self.running:
                # Wait before reconnecting
                time.sleep(2.0)
                # Create a new WebSocket instance for reconnection
                self._create_websocket()

    def _on_open(self, ws):
        """Handle WebSocket connection opened."""
        self.connected = True
        print("DX Cluster WebSocket connected")
        self._notify_status(True)

        # Send any pending subscriptions that were queued before connection
        if hasattr(self, '_pending_subscriptions'):
            for sub_type in self._pending_subscriptions:
                self._send_subscription(sub_type, True)
            self._pending_subscriptions.clear()

    def _on_message(self, ws, message):
        """Handle incoming WebSocket message."""
        try:
            data = json.loads(message)
            msg_type = data.get('type')

            if msg_type == 'cw_spot':
                self._notify_cw_spot(data.get('data', {}))
            elif msg_type == 'digital_spot':
                self._notify_digital_spot(data.get('data', {}))
            elif msg_type == 'status':
                self.connected = data.get('connected', False)
                self._notify_status(self.connected)
            elif msg_type == 'spot' or msg_type == 'dx_spot':
                # DX cluster spots - ignore for now (not implemented in Python client)
                pass
            elif msg_type and msg_type.startswith('chat_'):
                # Chat messages
                self._notify_chat(data)

        except json.JSONDecodeError as e:
            print(f"Failed to decode WebSocket message: {e}")
        except Exception as e:
            print(f"Error processing WebSocket message: {e}")

    def _on_error(self, ws, error):
        """Handle WebSocket error."""
        print(f"WebSocket error: {error}")

    def _on_close(self, ws, close_status_code, close_msg):
        """Handle WebSocket connection closed."""
        self.connected = False
        print("DX Cluster WebSocket disconnected")
        self._notify_status(False)

    def _notify_cw_spot(self, spot_data: Dict[str, Any]):
        """Notify all CW spot callbacks."""
        with self.callback_lock:
            for callback in self.cw_spot_callbacks:
                try:
                    callback(spot_data)
                except Exception as e:
                    print(f"Error in CW spot callback: {e}")

    def _notify_digital_spot(self, spot_data: Dict[str, Any]):
        """Notify all digital spot callbacks."""
        with self.callback_lock:
            for callback in self.digital_spot_callbacks:
                try:
                    callback(spot_data)
                except Exception as e:
                    print(f"Error in digital spot callback: {e}")

    def _notify_status(self, connected: bool):
        """Notify all status callbacks."""
        with self.callback_lock:
            for callback in self.status_callbacks:
                try:
                    callback(connected)
                except Exception as e:
                    print(f"Error in status callback: {e}")

    def _notify_chat(self, message: Dict[str, Any]):
        """Notify all chat callbacks."""
        with self.callback_lock:
            for callback in self.chat_callbacks:
                try:
                    callback(message)
                except Exception as e:
                    print(f"Error in chat callback: {e}")

    def register_callback(self, callback_type: str, callback: Callable):
        """
        Register a callback for a specific message type.

        Args:
            callback_type: Type of callback ('chat', 'cw_spot', 'digital_spot', 'status')
            callback: Function to call when message is received
        """
        if callback_type == 'chat':
            with self.callback_lock:
                was_empty = len(self.cw_spot_callbacks) == 0 and len(self.digital_spot_callbacks) == 0 and len(self.chat_callbacks) == 0
                self.chat_callbacks.append(callback)
                should_connect = was_empty

            if should_connect:
                print("DX Cluster WebSocket: First callback registered, connecting...")
                self.connect()
        elif callback_type == 'cw_spot':
            self.on_cw_spot(callback)
        elif callback_type == 'digital_spot':
            self.on_digital_spot(callback)
        elif callback_type == 'status':
            self.on_status(callback)

    def unregister_callback(self, callback_type: str, callback: Callable = None):
        """
        Unregister a callback for a specific message type.
        Note: Does NOT auto-disconnect - connection stays alive for other subscriptions.

        Args:
            callback_type: Type of callback ('chat', 'cw_spot', 'digital_spot', 'status')
            callback: Function to remove (if None, removes all callbacks of this type)
        """
        if callback_type == 'chat':
            with self.callback_lock:
                if callback is None:
                    self.chat_callbacks.clear()
                elif callback in self.chat_callbacks:
                    self.chat_callbacks.remove(callback)
        elif callback_type == 'cw_spot' and callback:
            self.remove_cw_spot_callback(callback)
        elif callback_type == 'digital_spot' and callback:
            self.remove_digital_spot_callback(callback)
        elif callback_type == 'status' and callback:
            self.remove_status_callback(callback)

    def send_message(self, message: Dict[str, Any]):
        """
        Send a message through the WebSocket.

        Args:
            message: Dictionary to send as JSON
        """
        if self.ws and self.connected:
            try:
                self.ws.send(json.dumps(message))
            except Exception as e:
                print(f"Failed to send WebSocket message: {e}")
        else:
            print("WebSocket not connected, cannot send message")

    def on_cw_spot(self, callback: Callable[[Dict[str, Any]], None]):
        """
        Register a callback for CW spots.
        Auto-connects the websocket if this is the first callback.

        Args:
            callback: Function to call when a CW spot is received
        """
        with self.callback_lock:
            # Check if this is the first callback of any type (before adding)
            was_empty = (len(self.cw_spot_callbacks) == 0 and
                        len(self.digital_spot_callbacks) == 0 and
                        len(self.chat_callbacks) == 0)
            self.cw_spot_callbacks.append(callback)
            should_connect = was_empty

        # Connect outside the lock to avoid deadlock
        if should_connect:
            print("DX Cluster WebSocket: First callback registered, connecting...")
            self.connect()

    def on_digital_spot(self, callback: Callable[[Dict[str, Any]], None]):
        """
        Register a callback for digital spots.
        Auto-connects the websocket if this is the first callback.

        Args:
            callback: Function to call when a digital spot is received
        """
        with self.callback_lock:
            # Check if this is the first callback of any type (before adding)
            was_empty = (len(self.cw_spot_callbacks) == 0 and
                        len(self.digital_spot_callbacks) == 0 and
                        len(self.chat_callbacks) == 0)
            self.digital_spot_callbacks.append(callback)
            should_connect = was_empty

        # Connect outside the lock to avoid deadlock
        if should_connect:
            print("DX Cluster WebSocket: First callback registered, connecting...")
            self.connect()

    def on_status(self, callback: Callable[[bool], None]):
        """
        Register a callback for connection status changes.

        Args:
            callback: Function to call when connection status changes
        """
        with self.callback_lock:
            self.status_callbacks.append(callback)
            # Immediately notify new callback of current status
            try:
                callback(self.connected)
            except Exception as e:
                print(f"Error notifying new status callback: {e}")

    def remove_cw_spot_callback(self, callback: Callable[[Dict[str, Any]], None]):
        """
        Remove a CW spot callback.
        Note: Does NOT auto-disconnect anymore - connection stays alive for other subscriptions.
        """
        with self.callback_lock:
            if callback in self.cw_spot_callbacks:
                self.cw_spot_callbacks.remove(callback)

    def remove_digital_spot_callback(self, callback: Callable[[Dict[str, Any]], None]):
        """
        Remove a digital spot callback.
        Note: Does NOT auto-disconnect anymore - connection stays alive for other subscriptions.
        """
        with self.callback_lock:
            if callback in self.digital_spot_callbacks:
                self.digital_spot_callbacks.remove(callback)

    def remove_status_callback(self, callback: Callable[[bool], None]):
        """Remove a status callback."""
        with self.callback_lock:
            if callback in self.status_callbacks:
                self.status_callbacks.remove(callback)

    def is_connected(self) -> bool:
        """Check if WebSocket is connected."""
        return self.connected

    def _send_subscription(self, stream_type: str, subscribe: bool):
        """
        Send subscription/unsubscription message to server.

        Args:
            stream_type: Type of stream ('dx_spots', 'digital_spots', 'cw_spots', 'chat')
            subscribe: True to subscribe, False to unsubscribe
        """
        action = 'subscribe' if subscribe else 'unsubscribe'
        message = {'type': f'{action}_{stream_type}'}
        self.send_message(message)
        print(f"DX Cluster WebSocket: {'Subscribed to' if subscribe else 'Unsubscribed from'} {stream_type}")

    def subscribe_to_dx_spots(self):
        """Subscribe to DX cluster spots."""
        if self.connected:
            self._send_subscription('dx_spots', True)
        else:
            self._pending_subscriptions.add('dx_spots')

    def subscribe_to_digital_spots(self):
        """Subscribe to digital spots (FT8/FT4/WSPR)."""
        if self.connected:
            self._send_subscription('digital_spots', True)
        else:
            self._pending_subscriptions.add('digital_spots')

    def subscribe_to_cw_spots(self):
        """Subscribe to CW spots."""
        if self.connected:
            self._send_subscription('cw_spots', True)
        else:
            self._pending_subscriptions.add('cw_spots')

    def subscribe_to_chat(self):
        """Subscribe to chat messages."""
        if self.connected:
            self._send_subscription('chat', True)
        else:
            self._pending_subscriptions.add('chat')

    def unsubscribe_from_dx_spots(self):
        """Unsubscribe from DX cluster spots."""
        if self.connected:
            self._send_subscription('dx_spots', False)
        self._pending_subscriptions.discard('dx_spots')

    def unsubscribe_from_digital_spots(self):
        """Unsubscribe from digital spots."""
        if self.connected:
            self._send_subscription('digital_spots', False)
        self._pending_subscriptions.discard('digital_spots')

    def unsubscribe_from_cw_spots(self):
        """Unsubscribe from CW spots."""
        if self.connected:
            self._send_subscription('cw_spots', False)
        self._pending_subscriptions.discard('cw_spots')

    def unsubscribe_from_chat(self):
        """Unsubscribe from chat messages."""
        if self.connected:
            self._send_subscription('chat', False)
        self._pending_subscriptions.discard('chat')