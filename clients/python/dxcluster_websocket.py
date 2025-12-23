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
        
        # Lock for thread-safe callback management
        self.callback_lock = threading.Lock()
        
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
                self.ws.run_forever()
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
                    
    def on_cw_spot(self, callback: Callable[[Dict[str, Any]], None]):
        """
        Register a callback for CW spots.
        Auto-connects the websocket if this is the first callback.

        Args:
            callback: Function to call when a CW spot is received
        """
        with self.callback_lock:
            # Check if this is the first callback (before adding)
            was_empty = len(self.cw_spot_callbacks) == 0 and len(self.digital_spot_callbacks) == 0
            self.cw_spot_callbacks.append(callback)
            # Check if we now have callbacks (after adding)
            has_callbacks = len(self.cw_spot_callbacks) > 0 or len(self.digital_spot_callbacks) > 0
            should_connect = was_empty and has_callbacks

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
            # Check if this is the first callback (before adding)
            was_empty = len(self.cw_spot_callbacks) == 0 and len(self.digital_spot_callbacks) == 0
            self.digital_spot_callbacks.append(callback)
            # Check if we now have callbacks (after adding)
            has_callbacks = len(self.cw_spot_callbacks) > 0 or len(self.digital_spot_callbacks) > 0
            should_connect = was_empty and has_callbacks

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
        Auto-disconnects the websocket if this was the last callback.
        """
        with self.callback_lock:
            if callback in self.cw_spot_callbacks:
                self.cw_spot_callbacks.remove(callback)
            # Check if we have any callbacks remaining (after removal)
            should_disconnect = len(self.cw_spot_callbacks) == 0 and len(self.digital_spot_callbacks) == 0

        # Disconnect outside the lock to avoid deadlock
        if should_disconnect:
            print("DX Cluster WebSocket: No callbacks remaining, disconnecting...")
            self.disconnect()

    def remove_digital_spot_callback(self, callback: Callable[[Dict[str, Any]], None]):
        """
        Remove a digital spot callback.
        Auto-disconnects the websocket if this was the last callback.
        """
        with self.callback_lock:
            if callback in self.digital_spot_callbacks:
                self.digital_spot_callbacks.remove(callback)
            # Check if we have any callbacks remaining (after removal)
            should_disconnect = len(self.cw_spot_callbacks) == 0 and len(self.digital_spot_callbacks) == 0

        # Disconnect outside the lock to avoid deadlock
        if should_disconnect:
            print("DX Cluster WebSocket: No callbacks remaining, disconnecting...")
            self.disconnect()
                
    def remove_status_callback(self, callback: Callable[[bool], None]):
        """Remove a status callback."""
        with self.callback_lock:
            if callback in self.status_callbacks:
                self.status_callbacks.remove(callback)
                
    def is_connected(self) -> bool:
        """Check if WebSocket is connected."""
        return self.connected