#!/usr/bin/env python3
"""
websdr-org-register.py — websdr.org registration bridge + reverse proxy
========================================================================
Runs on the Docker HOST to avoid Docker NAT conntrack issues.

Two jobs:
  1. Persistent TCP to websdr.ewi.utwente.nl:80, sends registration
     pings every ~60 s.
  2. Listens on LISTEN_PORT and reverse-proxies ALL incoming TCP
     connections to UberSDR on BACKEND_PORT (localhost).
     Special handling for /~~orgstatus: the proxy intercepts these
     requests and responds directly using the raw WebSDR protocol
     (proper HTTP for the first request, raw text for cache-hit
     follow-ups on the same keep-alive connection).

Usage:
  python3 websdr-org-register.py <PUBLIC_HOST> <LISTEN_PORT> <BACKEND_PORT>
  python3 websdr-org-register.py 44.31.241.12 8901 8902

  LISTEN_PORT  = port advertised to websdr.org (this script binds to it)
  BACKEND_PORT = Docker-mapped port for UberSDR (e.g. 8902 → container 8901)

Stopping: Ctrl+C or SIGTERM
"""

import re
import signal
import socket
import sys
import threading
import time
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import URLError

# ─── Configuration ───────────────────────────────────────────────────────────
PUBLIC_HOST   = sys.argv[1] if len(sys.argv) > 1 else "44.31.241.12"
LISTEN_PORT   = int(sys.argv[2]) if len(sys.argv) > 2 else 8901
NOVA_PORT     = int(sys.argv[3]) if len(sys.argv) > 3 else 8902

ORG_SERVER    = "websdr.ewi.utwente.nl"
ORG_PORT      = 80
PING_INTERVAL = 60   # seconds
RECONNECT_DLY = 30
TIMEOUT       = 15

# Server version string — must match a known WebSDR release for websdr.org
# to accept the registration.
SERVER_VERSION = "WebSDR/20140718.1506-64"

# ─── Reverse DNS cache ───────────────────────────────────────────────────────
_rdns_cache = {}   # ip → hostname (or "" if no PTR)
_rdns_lock = threading.Lock()


def _do_rdns(ip, result):
    """Worker for threaded rDNS lookup."""
    try:
        hostname, _, _ = socket.gethostbyaddr(ip)
        result.append(hostname)
    except Exception:
        pass


def rdns_lookup(ip):
    """Reverse DNS lookup with 1-second timeout and caching.
    Uses a separate thread so we never touch the global socket timeout."""
    with _rdns_lock:
        if ip in _rdns_cache:
            return _rdns_cache[ip]

    result = []
    t = threading.Thread(target=_do_rdns, args=(ip, result), daemon=True)
    t.start()
    t.join(timeout=1.0)
    hostname = result[0] if result else ""

    with _rdns_lock:
        _rdns_cache[ip] = hostname
    return hostname


def ip_label(ip):
    """Return 'ip (hostname)' if rDNS resolves, otherwise just 'ip'."""
    hostname = rdns_lookup(ip)
    return f"{ip} ({hostname})" if hostname else ip


# ─── Helpers ──────────────────────────────────────────────────────────────────
def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# ─── orgstatus fetcher ───────────────────────────────────────────────────────
# Fetches the /~~orgstatus response from the Go backend and caches it.
# The proxy serves this data directly to websdr.org using the raw WebSDR
# protocol instead of proxying the connection through.

_orgstatus_lock = threading.Lock()
_orgstatus_body = ""        # cached full orgstatus body text
_orgstatus_serial = "0"     # cached Config: serial from the body
_orgstatus_cookie = ""      # cached Set-Cookie value from backend
_orgstatus_last = 0.0       # timestamp of last successful fetch
_ORGSTATUS_TTL = 10         # seconds — refetch if older than this


def _fetch_orgstatus_from_backend():
    """Fetch /~~orgstatus from the Go backend via HTTP and cache the result."""
    global _orgstatus_body, _orgstatus_serial, _orgstatus_cookie, _orgstatus_last
    try:
        url = f"http://127.0.0.1:{NOVA_PORT}/~~orgstatus?config=0&token=0"
        req = Request(url)
        req.add_header("Host", f"{PUBLIC_HOST}:{LISTEN_PORT}")
        with urlopen(req, timeout=5) as resp:
            body = resp.read().decode(errors="replace")
            cookie = resp.getheader("Set-Cookie", "")
            # Extract the Config: serial from the body
            m = re.search(r"^Config:\s*(\S+)", body, re.MULTILINE)
            serial = m.group(1) if m else "0"
            with _orgstatus_lock:
                _orgstatus_body = body
                _orgstatus_serial = serial
                _orgstatus_cookie = cookie
                _orgstatus_last = time.time()
            return True
    except Exception as e:
        log(f"[ORGSTATUS] Failed to fetch from backend: {e}")
        return False


def get_orgstatus():
    """Return (body, serial, cookie) — fetches from backend if cache is stale."""
    with _orgstatus_lock:
        if time.time() - _orgstatus_last < _ORGSTATUS_TTL and _orgstatus_body:
            return _orgstatus_body, _orgstatus_serial, _orgstatus_cookie
    _fetch_orgstatus_from_backend()
    with _orgstatus_lock:
        return _orgstatus_body, _orgstatus_serial, _orgstatus_cookie


def get_users_line():
    """Return just the 'Users: N' line from the cached orgstatus body."""
    body, _, _ = get_orgstatus()
    for line in body.splitlines():
        if line.startswith("Users:"):
            return line + "\n"
    return "Users: 0\n"


# ─── /~~orgstatus handler (direct, not proxied) ─────────────────────────────
def handle_orgstatus(conn, addr, first_req_line):
    """Handle /~~orgstatus requests directly using the raw WebSDR protocol.
    Supports HTTP keep-alive: first request gets full HTTP response,
    subsequent cache-hit requests get just the raw body text (no HTTP headers),
    matching the real WebSDR binary's behavior.

    first_req_line is the already-parsed first request line (e.g.
    'GET /~~orgstatus?config=0&token=0 HTTP/1.1') from handle_client."""
    try:
        conn.settimeout(60)
        client_ip = addr[0]
        if client_ip.startswith("::ffff:"):
            client_ip = client_ip[7:]

        # ── First request (already read by handle_client) ────────────────
        req_cfg = None
        m = re.search(r"[?&]config=(-?\d+)", first_req_line)
        if m:
            req_cfg = m.group(1)

        body, serial, cookie = get_orgstatus()

        cache_hit = (req_cfg is not None and req_cfg == serial)
        resp_body = get_users_line() if cache_hit else body
        resp_body_bytes = resp_body.encode()

        header = (
            f"HTTP/1.1 200 OK\r\n"
            f"Server: {SERVER_VERSION}\r\n"
            f"Content-Length: {len(resp_body_bytes)}\r\n"
            f"Content-Type: text/plain\r\n"
            f"Cache-control: no-cache\r\n"
        )
        if cookie:
            header += f"Set-Cookie: {cookie}\r\n"
        header += "\r\n"

        conn.sendall(header.encode() + resp_body_bytes)
        log(f"[ORGSTATUS] {ip_label(client_ip)} → {first_req_line} (HTTP, {len(resp_body_bytes)} bytes)")

        # ── Subsequent requests on the same keep-alive connection ────────
        data = b""
        while True:
            # Read until we have a complete HTTP request.
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    return  # client closed
                data += chunk

            req_raw, data = data.split(b"\r\n\r\n", 1)
            req = req_raw.decode(errors="replace")
            first_line = req.split("\r\n")[0] if req else ""

            # Parse config= parameter from the request.
            req_cfg = None
            m = re.search(r"[?&]config=(-?\d+)", req)
            if m:
                req_cfg = m.group(1)

            body, serial, cookie = get_orgstatus()

            # Subsequent requests: send just the raw body text with NO HTTP
            # headers.  This matches the real WebSDR binary's behavior as
            # seen in the pcap trace.
            cache_hit = (req_cfg is not None and req_cfg == serial)
            resp_body = get_users_line() if cache_hit else body

            conn.sendall(resp_body.encode())
            log(f"[ORGSTATUS] {ip_label(client_ip)} → {first_line} (raw, {len(resp_body)} bytes)")

    except Exception as e:
        if "timed out" not in str(e):
            log(f"[ORGSTATUS] Error handling {addr}: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─── TCP relay helper ────────────────────────────────────────────────────────
def relay(src, dst, label="", log_first=False):
    """Copy bytes from src to dst until EOF or error.
    If log_first=True, log the first line of the first chunk (for response status)."""
    total = 0
    try:
        while True:
            data = src.recv(4096)
            if not data:
                break
            total += len(data)
            if log_first and total == len(data):
                # First chunk — log the HTTP status line
                first_line = data.split(b"\r\n", 1)[0].decode(errors="replace")
                log(f"[PROXY] {label} response: {first_line} ({len(data)} bytes)")
            dst.sendall(data)
    except Exception as e:
        if total == 0 and label:
            log(f"[PROXY] {label} relay error (0 bytes transferred): {e}")
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass
    if label:
        log(f"[PROXY] {label} relay done ({total} bytes)")


# ─── TCP proxy: forward ALL connections to UberSDR ───────────────────────────
def handle_client(conn, addr):
    """Read HTTP headers, inject X-Forwarded-For, then proxy to UberSDR.
    /~~orgstatus requests are intercepted and handled directly."""
    backend = None
    try:
        conn.settimeout(60)
        client_ip = addr[0]
        # Strip IPv6-mapped IPv4 prefix for cleaner headers
        if client_ip.startswith("::ffff:"):
            client_ip = client_ip[7:]

        # Read until we have the full HTTP header block.
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk

        header_end = buf.index(b"\r\n\r\n")
        headers_raw = buf[:header_end]

        # Extract request line for routing.
        first_line = headers_raw.split(b"\r\n", 1)[0].decode(errors="replace")

        # Intercept /~~orgstatus — handle directly instead of proxying.
        if "GET /~~orgstatus" in first_line:
            handle_orgstatus(conn, addr, first_line)
            return

        remainder = buf[header_end + 4:]  # body data already read

        # Inject missing headers required by Go's http.Server.
        header_lines = headers_raw.split(b"\r\n")

        # Ensure Host header exists (websdr.org's callback omits it).
        has_host = any(line.lower().startswith(b"host:") for line in header_lines)
        if not has_host:
            header_lines.append(b"Host: " + PUBLIC_HOST.encode() + b":" + str(LISTEN_PORT).encode())

        # Inject X-Forwarded-For header (append to existing if present).
        xff_found = False
        for i, line in enumerate(header_lines):
            if line.lower().startswith(b"x-forwarded-for:"):
                header_lines[i] = line + b", " + client_ip.encode()
                xff_found = True
                break
        if not xff_found:
            header_lines.append(b"X-Forwarded-For: " + client_ip.encode())

        modified_headers = b"\r\n".join(header_lines) + b"\r\n\r\n"

        # Connect to backend and forward the modified request.
        backend = socket.create_connection(("127.0.0.1", NOVA_PORT), timeout=10)
        log(f"[PROXY] {ip_label(client_ip)} → localhost:{NOVA_PORT}  {first_line}")

        backend.sendall(modified_headers + remainder)

        # Clear timeouts for the relay phase — WebSocket connections can be
        # idle for long periods and must not be killed by socket timeouts.
        conn.settimeout(None)
        backend.settimeout(None)

        # Relay both directions for the rest of the connection.
        label = f"{client_ip}"
        t1 = threading.Thread(target=relay, args=(conn, backend, f"{label} client→backend"), daemon=True)
        t2 = threading.Thread(target=relay, args=(backend, conn, f"{label} backend→client", True), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

    except Exception as e:
        log(f"[PROXY] Error proxying {addr}: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
        if backend:
            try:
                backend.close()
            except Exception:
                pass


def http_server():
    # Try IPv6 dual-stack first, fall back to IPv4.
    try:
        srv = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        srv.bind(("::", LISTEN_PORT))
    except OSError:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("", LISTEN_PORT))

    srv.listen(32)
    log(f"[PROXY] Listening on :{LISTEN_PORT} → all requests proxied to localhost:{NOVA_PORT}")
    log(f"[PROXY] /~~orgstatus requests handled directly (not proxied)")
    while True:
        try:
            conn, addr = srv.accept()
            t = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
            t.start()
        except Exception as e:
            log(f"[HTTP] accept error: {e}")
            time.sleep(1)


# ─── Persistente registratie → websdr.org ─────────────────────────────────────
def org_register_loop():
    req = (
        f"GET /~~websdrorg?host={PUBLIC_HOST}&port={LISTEN_PORT} HTTP/1.1\r\n"
        f"Host: {ORG_SERVER}\r\n\r\n"
    ).encode()

    sock = None
    attempt = 0

    while True:
        if sock is None:
            try:
                sock = socket.create_connection((ORG_SERVER, ORG_PORT), timeout=TIMEOUT)
                log(f"[ORG] Connected to {ORG_SERVER}:{ORG_PORT}")
            except Exception as e:
                log(f"[ORG] Connection failed: {e} — retrying in {RECONNECT_DLY}s")
                time.sleep(RECONNECT_DLY)
                continue

        try:
            sock.sendall(req)
            attempt += 1

            sock.settimeout(5)
            try:
                resp = sock.recv(256)
                if not resp:
                    raise ConnectionResetError("server closed connection")
                resp_str = resp.decode(errors="replace").split("\r\n")[0]
                log(f"[ORG] #{attempt} registration OK — {resp_str}")
            except socket.timeout:
                log(f"[ORG] #{attempt} ping sent (no immediate response — normal)")
            sock.settimeout(TIMEOUT)

        except Exception as e:
            log(f"[ORG] #{attempt} error: {e} — reconnecting...")
            try:
                sock.close()
            except Exception:
                pass
            sock = None
            time.sleep(RECONNECT_DLY)
            continue

        time.sleep(PING_INTERVAL)


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    log("=" * 60)
    log(f"  websdr.org registration bridge + reverse proxy")
    log(f"  Public: {PUBLIC_HOST}:{LISTEN_PORT}")
    log(f"  Backend: localhost:{NOVA_PORT} (UberSDR via Docker)")
    log(f"  All connections on :{LISTEN_PORT} proxied to :{NOVA_PORT}")
    log(f"  /~~orgstatus handled directly (raw WebSDR protocol)")
    log("=" * 60)

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    # Pre-fetch orgstatus from backend so it's ready for the first callback
    log("[ORGSTATUS] Pre-fetching orgstatus from backend...")

    # Start proxy server in background thread
    t = threading.Thread(target=http_server, daemon=True)
    t.start()

    # Wait for proxy to be ready before first registration
    time.sleep(2)

    # Fetch initial orgstatus
    if _fetch_orgstatus_from_backend():
        log(f"[ORGSTATUS] Pre-fetch OK (serial={_orgstatus_serial})")
    else:
        log("[ORGSTATUS] Pre-fetch failed — will retry on first callback")

    try:
        org_register_loop()
    except KeyboardInterrupt:
        log("Stopped.")


if __name__ == "__main__":
    main()
