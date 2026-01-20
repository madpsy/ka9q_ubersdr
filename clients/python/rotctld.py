#!/usr/bin/env python3
"""
rotctld - Hamlib-compatible rotator control daemon for ka9q_ubersdr

This server implements the Hamlib rotctld network protocol and translates
commands to the ka9q_ubersdr rotator API.

Protocol Reference:
- Based on Hamlib rotctld protocol version 1
- Commands are single characters or backslash-prefixed names
- Responses follow the format: data\nRPRT 0\n (0 = success, negative = error)
- Extended response protocol supported with '+' prefix
"""

import socket
import threading
import argparse
import sys
import requests
import logging
from typing import Optional, Tuple

# Hamlib error codes
RIG_OK = 0
RIG_EINVAL = -1  # Invalid parameter
RIG_ENAVAIL = -2  # Function not available
RIG_ENIMPL = -3  # Function not implemented
RIG_EIO = -5  # I/O error
RIG_ETIMEOUT = -6  # Timeout
RIG_EPROTO = -8  # Protocol error
RIG_EINTERNAL = -11  # Internal error
RIG_ECONF = -13  # Invalid configuration


class RotatorAPI:
    """Interface to ka9q_ubersdr rotator API."""

    def __init__(self, server_url: str, password: Optional[str] = None, position_callback: Optional[callable] = None):
        """Initialize rotator API interface.

        Args:
            server_url: Base URL of ka9q_ubersdr server (e.g., http://localhost:8073)
            password: Optional password for rotator control
            position_callback: Optional callback function that returns (azimuth, elevation) tuple
        """
        self.server_url = server_url.rstrip('/')
        self.password = password
        self.timeout = 5
        self.position_callback = position_callback

        # Cache for position data (used if no callback provided)
        self.cached_azimuth = 0.0
        self.cached_elevation = 0.0
        self.cache_lock = threading.Lock()

        # Rate limiting for API calls (1 per second)
        self.last_api_call = 0.0
        self.min_api_interval = 1.0  # seconds

    def get_position(self) -> Tuple[int, float, float]:
        """Get current rotator position from cache.

        Returns:
            Tuple of (error_code, azimuth, elevation)
        """
        try:
            # If we have a callback (from rotator window), use it
            if self.position_callback:
                az, el = self.position_callback()
                return RIG_OK, az, el

            # Otherwise return cached values
            with self.cache_lock:
                return RIG_OK, self.cached_azimuth, self.cached_elevation

        except Exception:
            return RIG_EINTERNAL, 0.0, 0.0

    def update_position(self, azimuth: float, elevation: float):
        """Update cached position (called by rotator window).

        Args:
            azimuth: Current azimuth
            elevation: Current elevation
        """
        with self.cache_lock:
            self.cached_azimuth = azimuth
            self.cached_elevation = elevation

    def set_position(self, azimuth: float, elevation: float) -> int:
        """Set rotator position with rate limiting (max 1 call per second).

        Args:
            azimuth: Target azimuth in degrees (0-359)
            elevation: Target elevation in degrees (ignored for az-only rotators)

        Returns:
            Error code (RIG_OK on success)
        """
        if not self.password:
            return RIG_ECONF

        # Rate limiting
        import time
        current_time = time.time()
        with self.cache_lock:
            time_since_last_call = current_time - self.last_api_call
            if time_since_last_call < self.min_api_interval:
                # Too soon, return OK but don't actually send
                return RIG_OK
            self.last_api_call = current_time

        try:
            url = f"{self.server_url}/api/rotctl/position"
            payload = {
                "password": self.password,
                "azimuth": int(azimuth)
            }

            response = requests.post(url, json=payload, timeout=self.timeout)

            if response.status_code == 401:
                return RIG_ECONF  # Invalid password
            elif response.status_code == 403:
                return RIG_ENAVAIL  # Read-only mode

            response.raise_for_status()
            return RIG_OK

        except requests.exceptions.Timeout:
            return RIG_ETIMEOUT
        except requests.exceptions.RequestException:
            return RIG_EIO
        except Exception:
            return RIG_EINTERNAL

    def stop(self) -> int:
        """Stop rotator movement with rate limiting (max 1 call per second).

        Returns:
            Error code (RIG_OK on success)
        """
        if not self.password:
            return RIG_ECONF

        # Rate limiting
        import time
        current_time = time.time()
        with self.cache_lock:
            time_since_last_call = current_time - self.last_api_call
            if time_since_last_call < self.min_api_interval:
                # Too soon, return OK but don't actually send
                return RIG_OK
            self.last_api_call = current_time

        try:
            url = f"{self.server_url}/api/rotctl/command"
            payload = {
                "password": self.password,
                "command": "stop"
            }

            response = requests.post(url, json=payload, timeout=self.timeout)

            if response.status_code == 401:
                return RIG_ECONF
            elif response.status_code == 403:
                return RIG_ENAVAIL

            response.raise_for_status()
            return RIG_OK

        except requests.exceptions.Timeout:
            return RIG_ETIMEOUT
        except requests.exceptions.RequestException:
            return RIG_EIO
        except Exception:
            return RIG_EINTERNAL

    def park(self) -> int:
        """Park the rotator with rate limiting (max 1 call per second).

        Returns:
            Error code (RIG_OK on success)
        """
        if not self.password:
            return RIG_ECONF

        # Rate limiting
        import time
        current_time = time.time()
        with self.cache_lock:
            time_since_last_call = current_time - self.last_api_call
            if time_since_last_call < self.min_api_interval:
                # Too soon, return OK but don't actually send
                return RIG_OK
            self.last_api_call = current_time

        try:
            url = f"{self.server_url}/api/rotctl/command"
            payload = {
                "password": self.password,
                "command": "park"
            }

            response = requests.post(url, json=payload, timeout=self.timeout)

            if response.status_code == 401:
                return RIG_ECONF
            elif response.status_code == 403:
                return RIG_ENAVAIL

            response.raise_for_status()
            return RIG_OK

        except requests.exceptions.Timeout:
            return RIG_ETIMEOUT
        except requests.exceptions.RequestException:
            return RIG_EIO
        except Exception:
            return RIG_EINTERNAL


class RotctldHandler:
    """Handler for rotctld protocol commands."""

    def __init__(self, rotator_api: RotatorAPI):
        """Initialize command handler.

        Args:
            rotator_api: RotatorAPI instance for communicating with rotator
        """
        self.api = rotator_api
        self.logger = logging.getLogger('rotctld.handler')

    def handle_command(self, cmd: str, args: list, ext_resp: bool = False, resp_sep: str = '\n') -> str:
        """Handle a rotctld command.

        Args:
            cmd: Command character or name
            args: List of command arguments
            ext_resp: Whether to use extended response format
            resp_sep: Response separator character

        Returns:
            Response string to send to client
        """
        self.logger.debug(f"Command: {cmd}, Args: {args}, ExtResp: {ext_resp}")

        # Map commands to handlers
        handlers = {
            'p': self.cmd_get_position,
            'P': self.cmd_set_position,
            'S': self.cmd_stop,
            'K': self.cmd_park,
            'get_pos': self.cmd_get_position,
            'set_pos': self.cmd_set_position,
            'stop': self.cmd_stop,
            'park': self.cmd_park,
            '_': self.cmd_get_info,
            'get_info': self.cmd_get_info,
            '\x8f': self.cmd_dump_state,
            'dump_state': self.cmd_dump_state,
        }

        handler = handlers.get(cmd)
        if not handler:
            return f"RPRT {RIG_ENIMPL}\n"

        try:
            return handler(args, ext_resp, resp_sep)
        except Exception as e:
            self.logger.error(f"Error handling command {cmd}: {e}")
            return f"RPRT {RIG_EINTERNAL}\n"

    def cmd_get_position(self, args: list, ext_resp: bool, resp_sep: str) -> str:
        """Handle 'p' - get position command."""
        ret, az, el = self.api.get_position()

        if ret != RIG_OK:
            return f"RPRT {ret}\n"

        response = f"{az:.2f}{resp_sep}{el:.2f}{resp_sep}"
        if not ext_resp:
            response += f"RPRT {ret}\n"
        return response

    def cmd_set_position(self, args: list, ext_resp: bool, resp_sep: str) -> str:
        """Handle 'P' - set position command."""
        if len(args) < 2:
            return f"RPRT {RIG_EINVAL}\n"

        try:
            azimuth = float(args[0])
            elevation = float(args[1])
        except ValueError:
            return f"RPRT {RIG_EINVAL}\n"

        ret = self.api.set_position(azimuth, elevation)
        return f"RPRT {ret}\n"

    def cmd_stop(self, args: list, ext_resp: bool, resp_sep: str) -> str:
        """Handle 'S' - stop command."""
        ret = self.api.stop()
        return f"RPRT {ret}\n"

    def cmd_park(self, args: list, ext_resp: bool, resp_sep: str) -> str:
        """Handle 'K' - park command."""
        ret = self.api.park()
        return f"RPRT {ret}\n"

    def cmd_get_info(self, args: list, ext_resp: bool, resp_sep: str) -> str:
        """Handle '_' - get info command."""
        info = "ka9q_ubersdr rotator"
        response = f"{info}{resp_sep}"
        if not ext_resp:
            response += f"RPRT {RIG_OK}\n"
        return response

    def cmd_dump_state(self, args: list, ext_resp: bool, resp_sep: str) -> str:
        """Handle dump_state command - returns rotator capabilities."""
        # Protocol version
        response = f"1{resp_sep}"
        # Rotator model (1 = dummy)
        response += f"1{resp_sep}"
        # Min/Max azimuth
        response += f"0{resp_sep}"
        response += f"360{resp_sep}"
        # Min/Max elevation
        response += f"0{resp_sep}"
        response += f"90{resp_sep}"
        # South zero
        response += f"0{resp_sep}"
        # Rotator type
        response += f"rot_type=Az{resp_sep}"
        response += f"done{resp_sep}"

        if not ext_resp:
            response += f"RPRT {RIG_OK}\n"
        return response


class RotctldServer:
    """Rotctld network server."""

    def __init__(self, host: str, port: int, rotator_api: RotatorAPI):
        """Initialize rotctld server.

        Args:
            host: Host address to bind to
            port: Port number to listen on
            rotator_api: RotatorAPI instance
        """
        self.host = host
        self.port = port
        self.api = rotator_api
        self.handler = RotctldHandler(rotator_api)
        self.logger = logging.getLogger('rotctld.server')
        self.running = False
        self.server_socket = None
        self.connected_clients = []  # List of connected client addresses
        self.clients_lock = threading.Lock()

    def start(self):
        """Start the server."""
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

        try:
            self.server_socket.bind((self.host, self.port))
            self.server_socket.listen(5)
            self.running = True
            self.logger.info(f"rotctld listening on {self.host}:{self.port}")

            while self.running:
                try:
                    self.server_socket.settimeout(1.0)  # Allow checking self.running periodically
                    client_socket, client_address = self.server_socket.accept()
                    self.logger.info(f"Connection from {client_address}")

                    # Add to connected clients list
                    client_id = f"{client_address[0]}:{client_address[1]}"
                    with self.clients_lock:
                        self.connected_clients.append(client_id)

                    # Handle client in a new thread
                    client_thread = threading.Thread(
                        target=self.handle_client,
                        args=(client_socket, client_address),
                        daemon=True
                    )
                    client_thread.start()

                except socket.timeout:
                    continue  # Check if still running
                except Exception as e:
                    if self.running:
                        self.logger.error(f"Error accepting connection: {e}")

        except Exception as e:
            self.logger.error(f"Server error: {e}")
            raise
        finally:
            self.running = False
            if self.server_socket:
                try:
                    self.server_socket.shutdown(socket.SHUT_RDWR)
                except:
                    pass
                self.server_socket.close()
                self.server_socket = None
            self.logger.info("Server stopped")

    def stop(self):
        """Stop the server."""
        self.running = False
        if self.server_socket:
            self.server_socket.close()

    def handle_client(self, client_socket: socket.socket, client_address: tuple):
        """Handle a client connection.

        Args:
            client_socket: Client socket
            client_address: Client address tuple
        """
        client_id = f"{client_address[0]}:{client_address[1]}"
        try:
            client_file = client_socket.makefile('rw', buffering=1)

            while self.running:
                try:
                    # Read command
                    line = client_file.readline()
                    if not line:
                        break

                    line = line.strip()
                    if not line:
                        continue

                    self.logger.debug(f"Received from {client_id}: {repr(line)}")

                    # Check for extended response protocol
                    ext_resp = False
                    resp_sep = '\n'

                    if line.startswith('+'):
                        ext_resp = True
                        line = line[1:]
                    elif len(line) > 1 and line[0] in '!@#$%^&*()_-=[]{}|;:,.<>?/~`':
                        # Custom separator
                        resp_sep = line[0]
                        ext_resp = True
                        line = line[1:]

                    # Parse command
                    if line.startswith('\\'):
                        # Long command name
                        parts = line[1:].split()
                        cmd = parts[0] if parts else ''
                        args = parts[1:] if len(parts) > 1 else []
                    elif line in ['q', 'Q']:
                        # Quit command
                        self.logger.info(f"Client {client_id} requested disconnect")
                        break
                    else:
                        # Single character command
                        cmd = line[0] if line else ''
                        args = line[1:].split() if len(line) > 1 else []

                    # Handle command
                    if ext_resp and cmd:
                        # Echo command name in extended response
                        cmd_name = cmd if len(cmd) > 1 else self.get_command_name(cmd)
                        response = f"{cmd_name}:"
                        for arg in args:
                            response += f" {arg}"
                        response += resp_sep
                        client_file.write(response)

                    response = self.handler.handle_command(cmd, args, ext_resp, resp_sep)
                    client_file.write(response)
                    client_file.flush()

                except Exception as e:
                    self.logger.error(f"Error handling client {client_id} command: {e}")
                    break

        except Exception as e:
            self.logger.error(f"Client {client_id} handler error: {e}")
        finally:
            # Remove from connected clients list
            with self.clients_lock:
                if client_id in self.connected_clients:
                    self.connected_clients.remove(client_id)

            self.logger.info(f"Disconnected: {client_id}")
            try:
                client_socket.close()
            except:
                pass

    def get_connected_clients(self):
        """Get list of currently connected client IDs.

        Returns:
            List of client ID strings (IP:port format)
        """
        with self.clients_lock:
            return self.connected_clients.copy()

    def get_command_name(self, cmd: str) -> str:
        """Get the long name for a single-character command.

        Args:
            cmd: Single character command

        Returns:
            Long command name
        """
        names = {
            'p': 'get_pos',
            'P': 'set_pos',
            'S': 'stop',
            'K': 'park',
            '_': 'get_info',
        }
        return names.get(cmd, cmd)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='rotctld - Hamlib-compatible rotator control daemon for ka9q_ubersdr'
    )
    parser.add_argument(
        '--host',
        default='127.0.0.1',
        help='Host address to bind to (default: 127.0.0.1)'
    )
    parser.add_argument(
        '--port', '-t',
        type=int,
        default=4533,
        help='Port to listen on (default: 4533)'
    )
    parser.add_argument(
        '--server-url',
        required=True,
        help='ka9q_ubersdr server URL (e.g., http://localhost:8073)'
    )
    parser.add_argument(
        '--password',
        help='Password for rotator control (optional)'
    )
    parser.add_argument(
        '--verbose', '-v',
        action='count',
        default=0,
        help='Increase verbosity (can be used multiple times)'
    )

    args = parser.parse_args()

    # Setup logging
    log_level = logging.WARNING
    if args.verbose == 1:
        log_level = logging.INFO
    elif args.verbose >= 2:
        log_level = logging.DEBUG

    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    logger = logging.getLogger('rotctld')
    logger.info(f"Starting rotctld server on {args.host}:{args.port}")
    logger.info(f"Connecting to ka9q_ubersdr at {args.server_url}")

    # Create rotator API interface
    rotator_api = RotatorAPI(args.server_url, args.password)

    # Create and start server
    server = RotctldServer(args.host, args.port, rotator_api)

    try:
        server.start()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.stop()
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
