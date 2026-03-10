#!/usr/bin/env python3
"""
rmnoise_denoise.py - RMNoise AI denoising protocol client library

Provides login, WebRTC signalling, and wire-protocol helpers for
integrating rmnoise.com denoising into the UberSDR radio client.

Protocol (reverse-engineered from audio-mixer-processor2.js):
  - Audio sent/received at 8 kHz int16 PCM
  - Each frame: 20-byte header + int16 PCM samples
  - Header: frameNumber (uint64 LE) + timestamp (uint64 LE) + audioScale (uint32 LE)
  - audioScale = floor(32767 / max_abs_value)  [normalization factor]
  - Frame size: 384 samples @ 8 kHz = 64 ms

This module is used exclusively by rmnoise_window.py (the UberSDR GUI bridge).
All sample-rate conversion is handled there; this module only deals with the
8 kHz wire protocol and WebRTC/WebSocket signalling.
"""

import asyncio
import json
import struct
import time
import logging

import numpy as np
import requests
import websockets
from aiortc import (RTCPeerConnection, RTCSessionDescription,
                    RTCIceCandidate, RTCConfiguration, RTCIceServer)

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(levelname)s %(name)s: %(message)s')
logger = logging.getLogger(__name__)

# ── Wire-protocol constants ────────────────────────────────────────────────────
SAMPLE_RATE_8K  = 8000
FRAME_SIZE_8K   = 384    # 64 ms at 8 kHz


# ── Wire-protocol helpers ──────────────────────────────────────────────────────

def pack_frame(frame_num: int, ts_ms: int, pcm8k: np.ndarray, scale: int) -> bytes:
    """Build 20-byte header + int16 PCM."""
    return struct.pack('<QQI', frame_num, ts_ms, scale) + pcm8k.tobytes()


def unpack_frame(data: bytes) -> tuple:
    """Parse server frame → (frame_num, timestamp, audio_scale, pcm8k ndarray)."""
    fn, ts, sc = struct.unpack_from('<QQI', data, 0)
    pcm = np.frombuffer(data, dtype=np.int16, offset=20)
    return fn, ts, sc, pcm


# ── WebRTC / WebSocket client ──────────────────────────────────────────────────

class RMNoiseClient:
    """Handles authentication, WebSocket signalling, and WebRTC data channel for rmnoise.com."""

    SERVERS = [
        "wss://s2.rmnoise.com:8766",
    ]

    def __init__(self, username: str, password: str,
                 filter_number: int = 1,
                 proxy_url: str = None):
        self.username         = username
        self.password         = password
        self.filter_number    = filter_number
        self.proxy_url        = proxy_url   # UberSDR server base URL (required for auth)
        self._session         = requests.Session()
        self.ws               = None
        self.pc               = None
        self.data_channel     = None
        self._dc_ready        = asyncio.Event()
        self.available_filters: list = []  # populated from ai_filters_list message

    # ── HTTP helpers ───────────────────────────────────────────────────────────
    # All auth goes through the UberSDR Go server proxy (/api/rmnoise/credentials).
    # A single POST {username, password} returns both the WebRTC token and TURN
    # credentials in one response — no server-side session state is kept.

    def _get_credentials(self) -> tuple[str, dict]:
        """POST {username, password} to the proxy and return (jwt_token, turn_dict).

        Returns:
            jwt_token : str  — WebRTC signalling token
            turn      : dict — {'urls': [...], 'username': ..., 'credential': ...}
        """
        if not self.proxy_url:
            raise RuntimeError("proxy_url is required — auth must go through the UberSDR server")
        logger.info(f"Authenticating as {self.username} via proxy {self.proxy_url}...")
        r = self._session.post(
            f"{self.proxy_url}/api/rmnoise/credentials",
            json={'username': self.username, 'password': self.password},
        )
        try:
            data = r.json()
        except Exception:
            raise RuntimeError(
                f"Proxy returned non-JSON response (HTTP {r.status_code}): {r.text[:200]}"
            )
        if r.status_code != 200 or not data.get('ok'):
            raise RuntimeError(
                f"Authentication failed (HTTP {r.status_code}): "
                f"{data.get('error', str(data))}"
            )

        webrtc = data.get('webrtc_token', {})
        turn   = data.get('turn_creds', {})

        if not webrtc.get('success') or not webrtc.get('token'):
            raise RuntimeError(
                f"Failed to get WebRTC token: {webrtc.get('error', str(webrtc))}"
            )
        if not turn.get('success'):
            raise RuntimeError(
                f"Failed to get TURN credentials: {turn.get('error', str(turn))}"
            )

        logger.info("Credentials received (WebRTC token + TURN)")
        turn_dict = {
            'urls':       turn.get('uris', []),
            'username':   turn.get('username'),
            'credential': turn.get('password'),
        }
        return webrtc['token'], turn_dict

    # ── Server selection ───────────────────────────────────────────────────────

    async def _measure(self, url: str, timeout: float = 3.0) -> float:
        """Probe a server with a ping/pong and return round-trip ms, or inf on failure.

        A hard *timeout* (default 3 s) covers the entire attempt — TCP connect,
        TLS handshake, send, and recv — so a hanging server never stalls the
        gather in _best_server.
        """
        async def _probe():
            t0 = time.time()
            async with websockets.connect(url, ssl=True) as ws:
                await ws.send(json.dumps({'type': 'ping', 'timestamp': t0}))
                msg = json.loads(await ws.recv())
                if msg.get('type') == 'pong':
                    return (time.time() - t0) * 1000
            return float('inf')

        try:
            return await asyncio.wait_for(_probe(), timeout=timeout)
        except Exception as e:
            logger.debug(f"{url} unreachable: {e}")
        return float('inf')

    async def _best_server(self) -> str:
        logger.info("Measuring server latencies...")
        lats = await asyncio.gather(*[self._measure(u) for u in self.SERVERS])
        avail = [(u, l) for u, l in zip(self.SERVERS, lats) if l != float('inf')]
        if not avail:
            raise RuntimeError("No available servers")
        avail.sort(key=lambda x: x[1])
        url, lat = avail[0]
        logger.info(f"Selected server: {url} ({lat:.0f} ms)")
        return url

    # ── WebSocket + WebRTC ─────────────────────────────────────────────────────

    async def _connect_ws(self, url: str, token: str):
        logger.info(f"Connecting to {url}...")
        self.ws = await websockets.connect(url)
        await self.ws.send(json.dumps({'type': 'auth', 'token': token}))
        msg = json.loads(await self.ws.recv())
        if msg.get('type') != 'auth_ok':
            raise RuntimeError(f"Auth failed: {msg}")
        logger.info("WebSocket authenticated")
        # Send filter selection immediately after auth (server defaults to 1 anyway,
        # but explicit selection ensures the right filter is active)
        await self.ws.send(json.dumps({
            'type': 'ai_filter_selection',
            'filterNumber': self.filter_number
        }))
        logger.info(f"Filter {self.filter_number} selected")

    async def _setup_webrtc(self, turn: dict):
        logger.info("Setting up WebRTC...")
        ice = [RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
        if turn:
            ice.append(RTCIceServer(urls=turn['urls'],
                                    username=turn['username'],
                                    credential=turn['credential']))
        self.pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice))
        self.data_channel = self.pc.createDataChannel(
            'audio', ordered=False, maxRetransmits=0)

        @self.data_channel.on("open")
        def _on_open():
            logger.info("Data channel opened")
            self._dc_ready.set()

        @self.pc.on("icecandidate")
        async def _on_ice(event):
            if event.candidate:
                await self.ws.send(json.dumps({
                    'type': 'ice-candidate',
                    'candidate': {
                        'candidate':     event.candidate.candidate,
                        'sdpMid':        event.candidate.sdpMid,
                        'sdpMLineIndex': event.candidate.sdpMLineIndex,
                    }
                }))

        offer = await self.pc.createOffer()
        await self.pc.setLocalDescription(offer)
        await self.ws.send(json.dumps({
            'type': 'offer',
            'offer': {'type': 'offer', 'sdp': self.pc.localDescription.sdp}
        }))
        logger.info("WebRTC offer sent")

    async def _handle_signaling(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                t   = msg.get('type')
                if t == 'answer':
                    ad = msg.get('answer', msg)
                    await self.pc.setRemoteDescription(
                        RTCSessionDescription(sdp=ad['sdp'], type='answer'))
                    logger.info("WebRTC answer received")
                elif t == 'ice-candidate':
                    c = msg['candidate']
                    await self.pc.addIceCandidate(RTCIceCandidate(
                        candidate=c['candidate'],
                        sdpMid=c.get('sdpMid'),
                        sdpMLineIndex=c.get('sdpMLineIndex')))
                elif t == 'ai_filters_list':
                    self.available_filters = msg.get('filters', [])
                    logger.info(f"Available AI filters ({len(self.available_filters)}):")
                    for f in self.available_filters:
                        marker = " ◄ active" if f['filterNumber'] == self.filter_number else ""
                        logger.info(f"  [{f['filterNumber']}] {f['filterDesc']}{marker}")
                elif t == 'entered_standby':
                    logger.warning(f"Server standby: {msg.get('reason')}")
                elif t == 'left_standby':
                    logger.info("Server left standby")
        except websockets.exceptions.ConnectionClosed:
            logger.info("WebSocket closed")

    # ── Public API ─────────────────────────────────────────────────────────────

    async def start(self):
        """Authenticate, connect, set up WebRTC, wait for data channel."""
        token, turn = self._get_credentials()
        url   = await self._best_server()
        await self._connect_ws(url, token)
        await self._setup_webrtc(turn)
        asyncio.create_task(self._handle_signaling())
        await asyncio.wait_for(self._dc_ready.wait(), timeout=15.0)
        logger.info("RMNoise client ready")

    async def stop(self):
        logger.info("Stopping RMNoise client...")
        if self.data_channel:
            self.data_channel.close()
        if self.pc:
            await self.pc.close()
        if self.ws:
            await self.ws.close()
        logger.info("RMNoise client stopped")

    def send(self, data: bytes):
        if self.data_channel and self.data_channel.readyState == "open":
            self.data_channel.send(data)
