#!/usr/bin/env python3
"""
Antenna Switch Daemon Emulator
==============================
Emulates the ant-switch-daemon xinetd TCP service (default port 65000).

Protocol (one command per TCP connection):
  s         → query state  → "Selected antennas: 1,3\n" or "Selected antennas: g\n"
  N         → exclusive select antenna N (1-8): grounds all, then selects N
  tN        → toggle antenna N on/off (mixing mode)
  g         → ground all antennas
  +N        → add antenna N without grounding others
  -N        → remove antenna N
  h         → help text (no output in daemon wrapper, but we print it for debugging)

Control commands produce NO output — the protocol has no ACK.
Only "s" produces a response line.

Usage:
  python3 ant_switch_emulator.py [--host HOST] [--port PORT] [--antennas N]

  Default: listen on 127.0.0.1:65000 with 8 antennas.
"""

import argparse
import re
import socket
import threading


def parse_args():
    p = argparse.ArgumentParser(description="Antenna switch daemon emulator")
    p.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    p.add_argument("--port", type=int, default=65000, help="TCP port (default: 65000)")
    p.add_argument("--antennas", type=int, default=8, help="Number of antennas (default: 8)")
    return p.parse_args()


class AntSwitchState:
    def __init__(self, num_antennas: int):
        self.num_antennas = num_antennas
        self.selected: set[int] = set()   # empty = grounded
        self.lock = threading.Lock()

    @property
    def grounded(self) -> bool:
        return len(self.selected) == 0

    def query_response(self) -> str:
        with self.lock:
            if self.grounded:
                return "Selected antennas: g\n"
            return "Selected antennas: {}\n".format(",".join(str(n) for n in sorted(self.selected)))

    def exclusive_select(self, n: int):
        with self.lock:
            self.selected = {n}
            print(f"  [state] exclusive select → antenna {n} active")

    def toggle(self, n: int):
        with self.lock:
            if n in self.selected:
                self.selected.discard(n)
                print(f"  [state] toggle → antenna {n} removed (now: {sorted(self.selected) or 'grounded'})")
            else:
                self.selected.add(n)
                print(f"  [state] toggle → antenna {n} added (now: {sorted(self.selected)})")

    def ground_all(self):
        with self.lock:
            self.selected.clear()
            print("  [state] ground all → all antennas grounded")

    def add_antenna(self, n: int):
        with self.lock:
            self.selected.add(n)
            print(f"  [state] add → antenna {n} added (now: {sorted(self.selected)})")

    def remove_antenna(self, n: int):
        with self.lock:
            self.selected.discard(n)
            print(f"  [state] remove → antenna {n} removed (now: {sorted(self.selected) or 'grounded'})")

    def status_str(self) -> str:
        with self.lock:
            if self.grounded:
                return "grounded"
            return "active: " + ", ".join(str(n) for n in sorted(self.selected))


def handle_client(conn: socket.socket, addr, state: AntSwitchState):
    try:
        conn.settimeout(5.0)
        raw = b""
        # Read until newline or up to 16 bytes
        while b"\n" not in raw and len(raw) < 16:
            chunk = conn.recv(16)
            if not chunk:
                break
            raw += chunk

        cmd = raw.decode("ascii", errors="replace").strip()
        if not cmd:
            return

        print(f"[{addr[0]}:{addr[1]}] cmd={repr(cmd)}")

        # Query state
        if cmd == "s":
            resp = state.query_response()
            conn.sendall(resp.encode("ascii"))
            print(f"  → {repr(resp.strip())}")
            return

        # Ground all
        if cmd == "g":
            state.ground_all()
            # No response
            return

        # Help
        if cmd == "h":
            # The real daemon wrapper produces no output for 'h' via TCP,
            # but we log it for debugging.
            print("  [help] commands: s, g, 1-8, t1-t8, +1-+8, -1--8")
            return

        # Exclusive select: "N" where N is 1-num_antennas
        m = re.fullmatch(r"([1-9][0-9]?)", cmd)
        if m:
            n = int(m.group(1))
            if 1 <= n <= state.num_antennas:
                state.exclusive_select(n)
            else:
                print(f"  [warn] antenna {n} out of range (1-{state.num_antennas}), ignored")
            return

        # Toggle: "tN"
        m = re.fullmatch(r"t([1-9][0-9]?)", cmd)
        if m:
            n = int(m.group(1))
            if 1 <= n <= state.num_antennas:
                state.toggle(n)
            else:
                print(f"  [warn] antenna {n} out of range (1-{state.num_antennas}), ignored")
            return

        # Add: "+N"
        m = re.fullmatch(r"\+([1-9][0-9]?)", cmd)
        if m:
            n = int(m.group(1))
            if 1 <= n <= state.num_antennas:
                state.add_antenna(n)
            else:
                print(f"  [warn] antenna {n} out of range (1-{state.num_antennas}), ignored")
            return

        # Remove: "-N"
        m = re.fullmatch(r"-([1-9][0-9]?)", cmd)
        if m:
            n = int(m.group(1))
            if 1 <= n <= state.num_antennas:
                state.remove_antenna(n)
            else:
                print(f"  [warn] antenna {n} out of range (1-{state.num_antennas}), ignored")
            return

        print(f"  [warn] unknown command {repr(cmd)}, ignored")

    except socket.timeout:
        print(f"[{addr[0]}:{addr[1]}] timeout reading command")
    except Exception as e:
        print(f"[{addr[0]}:{addr[1]}] error: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    args = parse_args()
    state = AntSwitchState(args.antennas)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(16)

    print(f"Antenna switch emulator listening on {args.host}:{args.port} ({args.antennas} antennas)")
    print(f"Initial state: grounded")
    print(f"Commands: s (query), g (ground), 1-{args.antennas} (exclusive), t1-t{args.antennas} (toggle), +N (add), -N (remove)")
    print()

    while True:
        try:
            conn, addr = srv.accept()
            t = threading.Thread(target=handle_client, args=(conn, addr, state), daemon=True)
            t.start()
        except KeyboardInterrupt:
            print("\nShutting down.")
            break
        except Exception as e:
            print(f"Accept error: {e}")

    srv.close()


if __name__ == "__main__":
    main()
