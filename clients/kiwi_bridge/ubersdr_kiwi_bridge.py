#!/usr/bin/env python3
"""
UberSDR to KiwiSDR Protocol Bridge

This bridge allows KiwiSDR clients (like kiwirecorder.py) to connect to UberSDR
by translating between the KiwiSDR WebSocket protocol and UberSDR's protocol.

Usage:
    python3 ubersdr_kiwi_bridge.py --ubersdr-host localhost --ubersdr-port 8080 \
                                    --listen-port 8073

Then connect kiwirecorder.py to localhost:8073 as if it were a KiwiSDR.
"""

import asyncio
import websockets
import json
import struct
import logging
import argparse
import time
import uuid
from typing import Dict, Optional, Tuple
import numpy as np

# IMA ADPCM encoder (inverse of decoder in kiwi/client.py)
stepSizeTable = (
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34,
    37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
    157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
    544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
    1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
    4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767)

indexAdjustTable = [
    -1, -1, -1, -1,  # +0 - +3, decrease the step size
     2, 4, 6, 8,     # +4 - +7, increase the step size
    -1, -1, -1, -1,  # -0 - -3, decrease the step size
     2, 4, 6, 8      # -4 - -7, increase the step size
]

def clamp(x, xmin, xmax):
    if x < xmin:
        return xmin
    if x > xmax:
        return xmax
    return x

class ImaAdpcmEncoder:
    def __init__(self):
        self.index = 0
        self.prev = 0
    
    def _encode_sample(self, sample):
        """Encode a single 16-bit PCM sample to 4-bit ADPCM"""
        step = stepSizeTable[self.index]
        diff = sample - self.prev
        
        code = 0
        if diff < 0:
            code = 8
            diff = -diff
        
        if diff >= step:
            code |= 4
            diff -= step
        if diff >= step // 2:
            code |= 2
            diff -= step // 2
        if diff >= step // 4:
            code |= 1
        
        # Update state using the same logic as decoder
        difference = step >> 3
        if code & 1:
            difference += step >> 2
        if code & 2:
            difference += step >> 1
        if code & 4:
            difference += step
        if code & 8:
            difference = -difference
        
        self.prev = clamp(self.prev + difference, -32768, 32767)
        self.index = clamp(self.index + indexAdjustTable[code], 0, len(stepSizeTable) - 1)
        
        return code
    
    def encode(self, samples):
        """Encode array of 16-bit PCM samples to ADPCM bytes"""
        output = bytearray()
        for i in range(0, len(samples), 2):
            sample0 = samples[i]
            sample1 = samples[i + 1] if i + 1 < len(samples) else samples[i]
            
            code0 = self._encode_sample(sample0)
            code1 = self._encode_sample(sample1)
            
            # Pack two 4-bit codes into one byte
            output.append((code1 << 4) | code0)
        
        return bytes(output)


class UberSDRSession:
    """Manages a single UberSDR WebSocket session"""
    
    def __init__(self, ubersdr_host: str, ubersdr_port: int, session_type: str, password: str = ""):
        self.ubersdr_host = ubersdr_host
        self.ubersdr_port = ubersdr_port
        self.session_type = session_type  # "audio" or "spectrum"
        self.password = password  # Optional bypass password
        self.ws = None
        self.session_id = None
        self.user_session_id = str(uuid.uuid4())
        self.frequency = 10000000  # 10 MHz default (for audio)
        self.mode = "am"
        self.sample_rate = 12000
        self.running = False
        # Determine if we should use HTTPS/WSS based on port
        self.use_tls = ubersdr_port == 443
        # Spectrum-specific parameters
        self.bin_count = 1024
        self.bin_bandwidth = 29296.875  # Default for 0-30 MHz
        self.center_freq = 15000000  # 15 MHz center
        
    async def connect(self):
        """Connect to UberSDR and establish session"""
        # Determine protocol based on port
        http_proto = "https" if self.use_tls else "http"
        ws_proto = "wss" if self.use_tls else "ws"
        
        # First, check connection availability
        connection_url = f"{http_proto}://{self.ubersdr_host}:{self.ubersdr_port}/connection"
        
        import aiohttp
        import ssl
        
        # Create SSL context that doesn't verify certificates (for self-signed certs)
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        connector = aiohttp.TCPConnector(ssl=ssl_context if self.use_tls else None)
        
        # Set User-Agent header
        headers = {
            "User-Agent": "UberSDR Kiwi Bridge/1.0"
        }
        
        async with aiohttp.ClientSession(connector=connector, headers=headers) as session:
            post_data = {"user_session_id": self.user_session_id}
            if self.password:
                post_data["password"] = self.password
            
            async with session.post(connection_url, json=post_data) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    logging.error(f"Connection check failed: status={resp.status}, body={text}")
                    raise Exception(f"Connection check failed: HTTP {resp.status}")
                
                data = await resp.json()
                logging.info(f"Connection check response: {data}")
                
                # Check if connection is allowed
                if not data.get("allowed", False):
                    reason = data.get("reason", "Connection not allowed by server")
                    raise Exception(f"Connection rejected: {reason}")
                
                self.sample_rate = data.get("sampleRate", 12000)
        
        # Build WebSocket URL based on session type
        if self.session_type == "spectrum":
            # Spectrum WebSocket endpoint
            ws_url = (f"{ws_proto}://{self.ubersdr_host}:{self.ubersdr_port}/ws/user-spectrum?"
                      f"user_session_id={self.user_session_id}")
            if self.password:
                ws_url += f"&password={self.password}"
        else:
            # Audio WebSocket endpoint
            ws_url = (f"{ws_proto}://{self.ubersdr_host}:{self.ubersdr_port}/ws?"
                      f"user_session_id={self.user_session_id}&"
                      f"frequency={self.frequency}&"
                      f"mode={self.mode}")
            if self.password:
                ws_url += f"&password={self.password}"
        
        # Set User-Agent header for WebSocket
        additional_headers = {
            "User-Agent": "UberSDR Kiwi Bridge/1.0"
        }
        
        # Connect with SSL context for wss://
        if self.use_tls:
            self.ws = await websockets.connect(ws_url, ssl=ssl_context, additional_headers=additional_headers)
        else:
            self.ws = await websockets.connect(ws_url, additional_headers=additional_headers)
        
        # Wait for status/config message from UberSDR
        response = await self.ws.recv()
        
        # Spectrum endpoint may send compressed data
        if isinstance(response, bytes):
            # Decompress gzip data
            import gzip
            response = gzip.decompress(response).decode('utf-8')
        
        data = json.loads(response)
        
        if self.session_type == "spectrum":
            # Spectrum session expects "config" message
            if data.get("type") == "config":
                self.session_id = data.get("sessionId")
                self.center_freq = data.get("centerFreq", 15000000)
                self.bin_count = data.get("binCount", 1024)
                self.bin_bandwidth = data.get("binBandwidth", 29296.875)
                logging.info(f"UberSDR spectrum session created: {self.session_id}, bins: {self.bin_count}, bw: {self.bin_bandwidth:.1f} Hz")
            else:
                raise Exception(f"Unexpected response from UberSDR spectrum: {data}")
        else:
            # Audio session expects "status" message
            if data.get("type") == "status":
                self.session_id = data.get("sessionId")
                self.sample_rate = data.get("sampleRate", 12000)
                logging.info(f"UberSDR audio session created: {self.session_id}, sample_rate: {self.sample_rate}")
            else:
                raise Exception(f"Unexpected response from UberSDR audio: {data}")
        
        self.running = True
    
    async def set_frequency(self, freq_hz: int):
        """Set frequency in Hz"""
        self.frequency = freq_hz
        if self.ws:
            await self.ws.send(json.dumps({
                "type": "tune",
                "frequency": freq_hz
            }))
    
    async def set_mode(self, mode: str, low_cut: int = None, high_cut: int = None):
        """Set demodulation mode"""
        self.mode = mode
        if self.ws:
            msg = {
                "type": "tune",
                "mode": mode
            }
            if low_cut is not None and high_cut is not None:
                msg["bandwidthLow"] = low_cut
                msg["bandwidthHigh"] = high_cut
            await self.ws.send(json.dumps(msg))
    
    async def receive_data(self):
        """Receive audio or spectrum data from UberSDR"""
        if not self.ws:
            return None, None, None
        
        try:
            message = await asyncio.wait_for(self.ws.recv(), timeout=5.0)
            
            # Handle compressed spectrum data
            if isinstance(message, bytes):
                import gzip
                message = gzip.decompress(message).decode('utf-8')
            
            data = json.loads(message)
            msg_type = data.get("type")
            logging.debug(f"Received message type: {msg_type}")
            
            if msg_type == "audio":
                # UberSDR sends base64-encoded audio data
                import base64
                audio_format = data.get("audioFormat", "pcm")
                audio_data = base64.b64decode(data.get("data", ""))
                logging.debug(f"Received audio: format={audio_format}, size={len(audio_data)} bytes")
                return "audio", audio_data, audio_format
            
            elif msg_type == "spectrum":
                # UberSDR sends spectrum as float32 array
                spectrum_data = data.get("data", [])
                logging.debug(f"Received spectrum: {len(spectrum_data)} bins")
                return "spectrum", spectrum_data, None
            
            elif msg_type == "status" or msg_type == "config":
                # Status/config update - ignore
                logging.debug(f"Received {msg_type} update")
                return None, None, None
            
            elif msg_type == "pong":
                # Pong response - ignore
                return None, None, None
            
            else:
                logging.warning(f"Unexpected message type: {msg_type}")
                return None, None, None
            
        except asyncio.TimeoutError:
            logging.debug("Receive timeout (no data)")
            return None, None, None
        except websockets.exceptions.ConnectionClosed:
            logging.info("UberSDR connection closed")
            self.running = False
            return None, None, None
        except Exception as e:
            logging.error(f"Error receiving data: {e}", exc_info=True)
            return None, None, None
    
    async def receive_audio(self):
        """Receive audio data from UberSDR (backward compatibility)"""
        msg_type, data, format_info = await self.receive_data()
        if msg_type == "audio":
            return data, format_info
        return None, None
    
    async def set_spectrum_params(self, frequency: int = None, bin_bandwidth: float = None):
        """Update spectrum parameters (zoom/pan)"""
        if self.ws and self.session_type == "spectrum":
            msg = {"type": "zoom"}  # or "pan" - both work
            if frequency is not None:
                msg["frequency"] = frequency
            if bin_bandwidth is not None:
                msg["binBandwidth"] = bin_bandwidth
            await self.ws.send(json.dumps(msg))
    
    async def close(self):
        """Close the session"""
        self.running = False
        if self.ws:
            await self.ws.close()


class KiwiProtocolHandler:
    """Handles KiwiSDR protocol translation"""
    
    def __init__(self, ubersdr_host: str, ubersdr_port: int):
        self.ubersdr_host = ubersdr_host
        self.ubersdr_port = ubersdr_port
        self.ubersdr_session: Optional[UberSDRSession] = None
        self.kiwi_ws = None
        self.connection_type = None  # "SND" or "W/F"
        self.sequence = 0
        self.compression = True
        self.encoder = ImaAdpcmEncoder()
        self.password = ""  # Will be extracted from SET auth command
        
    async def handle_kiwi_client(self, websocket, path):
        """Handle incoming KiwiSDR client connection"""
        self.kiwi_ws = websocket
        
        # Parse connection path: /<timestamp>/<type> or /<timestamp>/<type>?camp
        parts = path.strip('/').split('/')
        if len(parts) < 2:
            logging.error(f"Invalid path: {path}")
            await websocket.close()
            return
        
        timestamp = parts[0]
        self.connection_type = parts[1]  # "SND" or "W/F"
        
        logging.info(f"KiwiSDR client connected: type={self.connection_type}, path={path}")
        
        try:
            # Create UberSDR session (password will be set after auth command)
            session_type = "audio" if self.connection_type == "SND" else "spectrum"
            self.ubersdr_session = UberSDRSession(
                self.ubersdr_host,
                self.ubersdr_port,
                session_type,
                self.password
            )
            await self.ubersdr_session.connect()
            
            # Send initial MSG responses to Kiwi client
            # IMPORTANT: version messages MUST come first (before wf_setup)
            await self.send_kiwi_msg("version_maj", "1")
            await self.send_kiwi_msg("version_min", "550")
            await self.send_kiwi_msg("bandwidth", "30000000")  # 30 MHz
            
            # Type-specific messages
            if self.connection_type == "SND":
                # Audio connection messages
                await self.send_kiwi_msg("sample_rate", str(self.ubersdr_session.sample_rate))
                await self.send_kiwi_msg("audio_rate", str(self.ubersdr_session.sample_rate))
            else:
                # Waterfall connection messages (wf_setup triggers initialization)
                await self.send_kiwi_msg("wf_setup", "")
            
            # Start message handling tasks
            receive_task = asyncio.create_task(self.handle_kiwi_messages())
            stream_task = asyncio.create_task(self.stream_to_kiwi())
            
            # Wait for either task to complete
            done, pending = await asyncio.wait(
                [receive_task, stream_task],
                return_when=asyncio.FIRST_COMPLETED
            )
            
            # Cancel remaining tasks
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        
        except Exception as e:
            logging.error(f"Error handling Kiwi client: {e}", exc_info=True)
        
        finally:
            if self.ubersdr_session:
                await self.ubersdr_session.close()
            logging.info("KiwiSDR client disconnected")
    
    async def send_kiwi_msg(self, name: str, value: str):
        """Send MSG message to Kiwi client"""
        # KiwiSDR protocol: MSG messages are sent as binary with "MSG" tag + space + params
        if value:
            msg = f"MSG {name}={value}"
        else:
            msg = f"MSG {name}"
        
        # Send as binary message (3-byte tag + 1 skip byte + message)
        packet = b'MSG\x00' + msg[4:].encode('utf-8')  # Skip "MSG " prefix, add it as tag
        await self.kiwi_ws.send(packet)
        logging.debug(f"Sent to Kiwi: {msg}")
    
    async def handle_kiwi_messages(self):
        """Handle incoming messages from Kiwi client"""
        try:
            async for message in self.kiwi_ws:
                if isinstance(message, bytes):
                    # Binary message - should be text commands
                    message = message.decode('utf-8', errors='ignore')
                
                # Parse SET commands
                if message.startswith('SET '):
                    await self.handle_set_command(message[4:])
        
        except websockets.exceptions.ConnectionClosed:
            logging.info("Kiwi client connection closed")
        except Exception as e:
            logging.error(f"Error handling Kiwi messages: {e}", exc_info=True)
    
    async def handle_set_command(self, command: str):
        """Handle SET command from Kiwi client"""
        # Parse space-separated key=value pairs
        params = {}
        for part in command.split():
            if '=' in part:
                key, value = part.split('=', 1)
                params[key] = value
        
        logging.debug(f"SET command: {params}")
        
        # Handle different SET commands
        if 'auth' in params or 't' in params:
            # SET auth t=kiwi p=<password>
            # Extract password if provided
            password = params.get('p', '')
            if password and password != '#':  # '#' is used as placeholder
                self.password = password
                logging.info(f"Password received from Kiwi client (length: {len(password)})")
                # Note: Password is extracted but session is already connected
                # For future enhancement: could reconnect with password
        
        elif 'mod' in params:
            # SET mod=am low_cut=100 high_cut=2800 freq=10.000
            mode = params.get('mod', 'am')
            low_cut = int(params.get('low_cut', 100)) if 'low_cut' in params else None
            high_cut = int(params.get('high_cut', 2800)) if 'high_cut' in params else None
            freq_khz = float(params.get('freq', 10.0)) if 'freq' in params else None
            
            # Send combined tune message to UberSDR
            if self.ubersdr_session.ws:
                msg = {"type": "tune"}
                if freq_khz is not None:
                    msg["frequency"] = int(freq_khz * 1000)
                if mode:
                    msg["mode"] = mode
                if low_cut is not None and high_cut is not None:
                    msg["bandwidthLow"] = low_cut
                    msg["bandwidthHigh"] = high_cut
                await self.ubersdr_session.ws.send(json.dumps(msg))
        
        elif 'zoom' in params:
            # SET zoom=8 cf=14200 (waterfall zoom/pan)
            # For spectrum, we need to calculate bin_bandwidth from zoom level
            # KiwiSDR zoom levels: 0=30MHz, 1=15MHz, 2=7.5MHz, etc. (divide by 2 each level)
            zoom = int(params.get('zoom', 0))
            cf_khz = float(params.get('cf', 15000)) if 'cf' in params else None
            
            # Calculate bin_bandwidth from zoom level
            # Full bandwidth = 30 MHz, 1024 bins
            # bin_bw = (30000 kHz / 2^zoom) / 1024 bins
            full_span_khz = 30000
            span_khz = full_span_khz / (2 ** zoom)
            bin_bandwidth = (span_khz * 1000) / 1024  # Convert to Hz
            
            if self.ubersdr_session.session_type == "spectrum":
                freq_hz = int(cf_khz * 1000) if cf_khz else None
                await self.ubersdr_session.set_spectrum_params(freq_hz, bin_bandwidth)
                logging.info(f"Waterfall zoom: level={zoom}, cf={cf_khz} kHz, bin_bw={bin_bandwidth:.1f} Hz")
        
        elif 'compression' in params or 'wf_comp' in params:
            # SET compression=1 or SET wf_comp=1
            self.compression = params.get('compression', params.get('wf_comp', '0')) == '1'
            logging.info(f"Compression: {self.compression}")
        
        elif 'maxdb' in params or 'mindb' in params:
            # SET maxdb=-10 mindb=-110 (waterfall color scale)
            # Just acknowledge - we don't need to do anything
            pass
        
        elif 'wf_speed' in params or 'speed' in params:
            # SET wf_speed=4 (waterfall update rate)
            # Just acknowledge - UberSDR sends at its own rate
            pass
        
        elif 'interp' in params or 'wf_interp' in params:
            # SET interp=13 (waterfall interpolation)
            # Just acknowledge - not applicable to UberSDR
            pass
        
        elif 'ident_user' in params:
            # SET ident_user=kiwirecorder.py
            # Just acknowledge - user identification
            pass
        
        elif 'agc' in params:
            # SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50
            # UberSDR doesn't support AGC control yet, just acknowledge
            pass
        
        elif 'keepalive' in command:
            # Send ping to UberSDR
            if self.ubersdr_session.ws:
                await self.ubersdr_session.ws.send(json.dumps({"type": "ping"}))
        
        else:
            # Unknown SET command - just log and ignore
            logging.debug(f"Ignoring unknown SET command: {command}")
    
    async def stream_to_kiwi(self):
        """Stream audio/spectrum data to Kiwi client"""
        try:
            if self.connection_type == "SND":
                await self.stream_audio()
            else:
                await self.stream_waterfall()
        except websockets.exceptions.ConnectionClosed:
            logging.info("Kiwi client connection closed during streaming")
        except Exception as e:
            logging.error(f"Error in stream_to_kiwi: {e}", exc_info=True)
    
    async def stream_audio(self):
        """Stream audio data in Kiwi SND format"""
        logging.info("Starting audio stream")
        
        packet_count = 0
        
        try:
            while self.ubersdr_session.running:
                # Receive audio from UberSDR
                audio_data, audio_format = await self.ubersdr_session.receive_audio()
                
                if audio_data is None:
                    continue
                
                # If UberSDR sent Opus, we can't use it - skip this packet
                # (Would need Opus decoder, but KiwiSDR expects PCM)
                if audio_format == "opus":
                    logging.warning("Received Opus audio from UberSDR, but KiwiSDR expects PCM. Skipping packet.")
                    continue
                
                # UberSDR sends audio as BIG-ENDIAN int16 (see minimal-radio.js:330-341)
                # Convert to numpy array with big-endian dtype
                samples = np.frombuffer(audio_data, dtype='>i2')  # >i2 = big-endian int16
                
                packet_count += 1
                if packet_count % 1000 == 0:
                    logging.info(f"Streamed {packet_count} audio packets: {len(samples)} samples, min={samples.min()}, max={samples.max()}, mean={samples.mean():.1f}")
                
                # Encode to ADPCM if compression enabled
                if self.compression:
                    # ADPCM encoder expects native-endian int16
                    # Convert big-endian samples to native (little) endian for processing
                    samples_native = samples.astype(np.int16)
                    encoded_data = self.encoder.encode(samples_native)
                    flags = 0x10  # Compressed flag
                else:
                    # KiwiSDR expects big-endian for uncompressed audio
                    # UberSDR already sends big-endian, so just use it directly
                    encoded_data = audio_data
                    flags = 0x00
                
                # Calculate RSSI (S-meter) - use dummy value for now
                rssi_db = -50.0  # -50 dBm
                smeter = int((rssi_db + 127) * 10)
                
                # Build SND packet: [flags:1][seq:4][smeter:2][data]
                # smeter is big-endian (>H), sequence is little-endian (<I)
                packet = struct.pack('<BI', flags, self.sequence) + struct.pack('>H', smeter) + encoded_data
                
                # Send to Kiwi client with "SND" tag
                await self.kiwi_ws.send(b'SND' + packet)
                
                self.sequence += 1
        
        except websockets.exceptions.ConnectionClosed:
            logging.info("Kiwi client disconnected during audio streaming")
        except Exception as e:
            logging.error(f"Error in stream_audio: {e}", exc_info=True)
    
    async def stream_waterfall(self):
        """Stream waterfall data in Kiwi W/F format"""
        logging.info("Starting waterfall stream")
        
        packet_count = 0
        wf_sequence = 0
        
        try:
            while self.ubersdr_session.running:
                # Receive spectrum data from UberSDR
                msg_type, spectrum_data, _ = await self.ubersdr_session.receive_data()
                
                if msg_type != "spectrum" or spectrum_data is None:
                    continue
                
                packet_count += 1
                if packet_count % 100 == 0:
                    logging.info(f"Streamed {packet_count} waterfall packets: {len(spectrum_data)} bins")
                
                # Convert spectrum data (float32 dBm values) to KiwiSDR waterfall format
                # KiwiSDR expects 8-bit values: 0-255 representing -200 to 0 dBm
                # Formula: byte_value = clamp(int(dBm + 255), 0, 255)
                wf_data = bytearray()
                for db_value in spectrum_data:
                    # Clamp to -200..0 dBm range and convert to 0..255
                    byte_val = int(db_value + 255)
                    byte_val = max(0, min(255, byte_val))
                    wf_data.append(byte_val)
                
                # Build W/F packet: [x_bin:4][flags_zoom:4][seq:4][data]
                # x_bin and flags_zoom are not used by kiwirecorder in raw mode, set to 0
                x_bin = 0
                flags_zoom = 0
                
                packet = struct.pack('<III', x_bin, flags_zoom, wf_sequence) + bytes(wf_data)
                
                # Send to Kiwi client with "W/F" tag (note: W/F has a skip byte after tag)
                await self.kiwi_ws.send(b'W/F\x00' + packet)
                
                wf_sequence += 1
        
        except websockets.exceptions.ConnectionClosed:
            logging.info("Kiwi client disconnected during waterfall streaming")
        except Exception as e:
            logging.error(f"Error in stream_waterfall: {e}", exc_info=True)


class KiwiSDRBridge:
    """Main bridge server"""
    
    def __init__(self, ubersdr_host: str, ubersdr_port: int, listen_port: int):
        self.ubersdr_host = ubersdr_host
        self.ubersdr_port = ubersdr_port
        self.listen_port = listen_port
        self.sessions: Dict[str, KiwiProtocolHandler] = {}
    
    async def handle_connection(self, connection):
        """Handle new WebSocket connection"""
        # Extract websocket and path from connection object (websockets 15.x API)
        websocket = connection
        path = connection.request.path
        
        handler = KiwiProtocolHandler(self.ubersdr_host, self.ubersdr_port)
        
        # Store session
        session_id = str(uuid.uuid4())
        self.sessions[session_id] = handler
        
        try:
            await handler.handle_kiwi_client(websocket, path)
        finally:
            # Clean up session
            if session_id in self.sessions:
                del self.sessions[session_id]
    
    async def start(self):
        """Start the bridge server"""
        logging.info(f"Starting KiwiSDR bridge on port {self.listen_port}")
        logging.info(f"Forwarding to UberSDR at {self.ubersdr_host}:{self.ubersdr_port}")
        
        async with websockets.serve(self.handle_connection, "0.0.0.0", self.listen_port):
            logging.info(f"Bridge listening on ws://0.0.0.0:{self.listen_port}")
            logging.info("Connect kiwirecorder.py to this port as if it were a KiwiSDR")
            await asyncio.Future()  # Run forever


def main():
    parser = argparse.ArgumentParser(
        description="UberSDR to KiwiSDR Protocol Bridge",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Bridge to local UberSDR
  python3 ubersdr_kiwi_bridge.py --ubersdr-host localhost --ubersdr-port 8080 --listen-port 8073
  
  # Then use kiwirecorder.py:
  python3 kiwirecorder.py -s localhost -p 8073 -f 10000 -m am
        """
    )
    
    parser.add_argument('--ubersdr-host', default='localhost',
                        help='UberSDR host (default: localhost)')
    parser.add_argument('--ubersdr-port', type=int, default=8080,
                        help='UberSDR port (default: 8080)')
    parser.add_argument('--listen-port', type=int, default=8073,
                        help='Port to listen on for KiwiSDR clients (default: 8073)')
    parser.add_argument('--debug', action='store_true',
                        help='Enable debug logging')
    
    args = parser.parse_args()
    
    # Setup logging
    log_level = logging.DEBUG if args.debug else logging.INFO
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Create and start bridge
    bridge = KiwiSDRBridge(args.ubersdr_host, args.ubersdr_port, args.listen_port)
    
    try:
        asyncio.run(bridge.start())
    except KeyboardInterrupt:
        logging.info("Bridge stopped by user")


if __name__ == '__main__':
    main()
