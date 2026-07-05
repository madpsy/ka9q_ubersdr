#!/usr/bin/env python3
"""
flash.py — Galactic Unicorn firmware flasher for UberSDR

Automates the complete setup of a Pimoroni Galactic Unicorn (or Stellar/Cosmic
Unicorn) display device:

  1. (Optional) Download the latest Pimoroni MicroPython UF2 firmware
  2. (Optional) Flash the UF2 to the Pico W in BOOTSEL mode
  3. Copy firmware files (main.py, display_engine.py, config.py) via mpremote
  4. Interactively configure Wi-Fi credentials in config.py

Usage:
    python3 flash.py [options]

Options:
    --port PORT         Serial port (e.g. /dev/ttyACM0, COM3). Auto-detected if omitted.
    --model MODEL       Display model: galactic (default), stellar, cosmic
    --ssid SSID         Wi-Fi network name (prompted if omitted)
    --password PASS     Wi-Fi password (prompted if omitted)
    --brightness FLOAT  Default brightness 0.0–1.0 (default: 0.5)
    --no-flash          Skip UF2 flashing (only copy Python files)
    --no-download       Skip UF2 download (use existing file in firmware/)
    --uf2 PATH          Path to a local UF2 file to flash (skips download)
    --firmware-dir DIR  Directory containing the firmware .py files
                        (default: same directory as this script / firmware/)
    --dry-run           Show what would be done without doing it

Requirements:
    pip install mpremote requests
    (mpremote is the official MicroPython file transfer tool)

Pimoroni MicroPython firmware is downloaded from:
    https://github.com/pimoroni/pimoroni-pico/releases
"""

import argparse
import getpass
import glob
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import json

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FIRMWARE_DIR = os.path.join(SCRIPT_DIR, "firmware")

# GitHub API URL for latest Pimoroni MicroPython release
PIMORONI_RELEASES_API = "https://api.github.com/repos/pimoroni/pimoroni-pico/releases/latest"

# UF2 filename pattern — all Unicorn boards (Galactic, Stellar, Cosmic) run on
# the Pico W, so they all use the same picow Pimoroni MicroPython firmware.
# The model selection only affects which MicroPython modules are available at
# runtime (galactic_unicorn, stellar_unicorn, cosmic_unicorn from Pimoroni).
UF2_PATTERN = r"^picow-v[\d.]+-pimoroni-micropython\.uf2$"
# Keep per-model dict for API compatibility but all point to the same pattern
UF2_PATTERNS = {
    "galactic": UF2_PATTERN,
    "stellar":  UF2_PATTERN,
    "cosmic":   UF2_PATTERN,
}

# RPI-RP2 drive name (BOOTSEL mode mount point)
BOOTSEL_DRIVE_NAMES = ["RPI-RP2", "RPI-RP2 "]

# Files to copy to the Pico W (in order).
# config.py is NOT in this list — it is generated from credentials at flash time
# and written to a temp file, never persisted in the repo.
FIRMWARE_FILES = ["display_engine.py", "main.py"]

# ---------------------------------------------------------------------------
# Colour output helpers
# ---------------------------------------------------------------------------

def _supports_colour():
    return sys.stdout.isatty() and platform.system() != "Windows"

_USE_COLOUR = _supports_colour()

def _c(text, code):
    return f"\033[{code}m{text}\033[0m" if _USE_COLOUR else text

def ok(msg):    print(_c("✓ " + msg, "32"))
def info(msg):  print(_c("→ " + msg, "36"))
def warn(msg):  print(_c("⚠ " + msg, "33"))
def err(msg):   print(_c("✗ " + msg, "31"), file=sys.stderr)
def step(msg):  print(_c("\n● " + msg, "1;34"))

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

def check_dependencies():
    """Check that required tools are available."""
    missing = []

    # mpremote
    if shutil.which("mpremote") is None:
        missing.append("mpremote  →  pip install mpremote")

    if missing:
        err("Missing required tools:")
        for m in missing:
            err("  " + m)
        sys.exit(1)

    ok("mpremote found")

# ---------------------------------------------------------------------------
# Serial port detection
# ---------------------------------------------------------------------------

def find_pico_port():
    """Auto-detect the Pico W serial port."""
    candidates = []

    if platform.system() == "Windows":
        # Try COM ports — look for ones with "Pico" or "MicroPython" in description
        try:
            import serial.tools.list_ports
            for port in serial.tools.list_ports.comports():
                desc = (port.description or "").lower()
                if "pico" in desc or "micropython" in desc or "rp2" in desc.lower():
                    candidates.append(port.device)
            if not candidates:
                # Fall back to all COM ports
                candidates = [p.device for p in serial.tools.list_ports.comports()]
        except ImportError:
            warn("pyserial not installed — cannot auto-detect port. Install with: pip install pyserial")
    else:
        # Linux / macOS
        patterns = [
            "/dev/ttyACM*",   # Linux (Pico W)
            "/dev/ttyUSB*",   # Linux (USB-serial adapters)
            "/dev/cu.usbmodem*",  # macOS
            "/dev/tty.usbmodem*", # macOS
        ]
        for pattern in patterns:
            candidates.extend(sorted(glob.glob(pattern)))

    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    # Multiple candidates — ask user
    print("\nMultiple serial ports found:")
    for i, p in enumerate(candidates):
        print(f"  [{i}] {p}")
    while True:
        choice = input("Select port number: ").strip()
        if choice.isdigit() and 0 <= int(choice) < len(candidates):
            return candidates[int(choice)]
        print("Invalid choice.")

# ---------------------------------------------------------------------------
# BOOTSEL drive detection
# ---------------------------------------------------------------------------

def find_bootsel_drive():
    """Find the RPI-RP2 drive mounted in BOOTSEL mode."""
    if platform.system() == "Windows":
        # Check drive letters
        import string
        for letter in string.ascii_uppercase:
            drive = letter + ":\\"
            if os.path.exists(drive):
                label_file = os.path.join(drive, "INFO_UF2.TXT")
                if os.path.exists(label_file):
                    try:
                        with open(label_file) as f:
                            content = f.read()
                        if "RPI-RP2" in content or "Raspberry Pi" in content:
                            return drive
                    except Exception:
                        pass
    elif platform.system() == "Darwin":
        # macOS — check /Volumes/
        for name in BOOTSEL_DRIVE_NAMES:
            path = f"/Volumes/{name}"
            if os.path.exists(path):
                return path
    else:
        # Linux — check /media/ and /mnt/
        for base in ["/media", "/run/media"]:
            if not os.path.exists(base):
                continue
            # /media/<user>/RPI-RP2 or /run/media/<user>/RPI-RP2
            for user_dir in os.listdir(base):
                for name in BOOTSEL_DRIVE_NAMES:
                    path = os.path.join(base, user_dir, name.strip())
                    if os.path.exists(path):
                        return path
        # Also check /mnt/
        for name in BOOTSEL_DRIVE_NAMES:
            path = f"/mnt/{name.strip()}"
            if os.path.exists(path):
                return path

    return None

# ---------------------------------------------------------------------------
# UF2 download
# ---------------------------------------------------------------------------

def get_latest_uf2_url(model):
    """Fetch the download URL for the latest Pimoroni UF2 for the given model."""
    info(f"Fetching latest Pimoroni MicroPython release info…")
    try:
        req = urllib.request.Request(
            PIMORONI_RELEASES_API,
            headers={"User-Agent": "UberSDR-flasher/1.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        err(f"Failed to fetch release info: {e}")
        return None, None

    tag = data.get("tag_name", "unknown")
    assets = data.get("assets", [])
    pattern = re.compile(UF2_PATTERNS[model], re.IGNORECASE)

    for asset in assets:
        name = asset.get("name", "")
        if pattern.search(name):
            url = asset.get("browser_download_url")
            ok(f"Found UF2: {name} ({tag})")
            return url, name

    err(f"No UF2 found for model '{model}' in release {tag}")
    err(f"Available assets: {[a['name'] for a in assets]}")
    return None, None


def download_uf2(url, dest_path):
    """Download a UF2 file with a progress indicator."""
    info(f"Downloading {os.path.basename(dest_path)}…")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "UberSDR-flasher/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 65536
            with open(dest_path, "wb") as f:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded * 100 // total
                        bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                        print(f"\r  [{bar}] {pct}% ({downloaded // 1024} KB)", end="", flush=True)
        print()
        ok(f"Downloaded to {dest_path}")
        return True
    except Exception as e:
        print()
        err(f"Download failed: {e}")
        return False

# ---------------------------------------------------------------------------
# UF2 flashing
# ---------------------------------------------------------------------------

def flash_uf2(uf2_path, dry_run=False):
    """Copy the UF2 file to the BOOTSEL drive."""
    step("Flashing UF2 firmware")

    print("\nTo enter BOOTSEL mode:")
    print("  1. Hold the BOOTSEL button on the Pico W")
    print("  2. While holding BOOTSEL, plug in the USB cable")
    print("  3. Release BOOTSEL — the Pico W appears as a USB drive (RPI-RP2)")
    print()

    # Wait for the drive to appear
    drive = None
    print("Waiting for RPI-RP2 drive", end="", flush=True)
    for _ in range(30):  # Wait up to 30 seconds
        drive = find_bootsel_drive()
        if drive:
            break
        print(".", end="", flush=True)
        time.sleep(1)
    print()

    if not drive:
        err("RPI-RP2 drive not found after 30 seconds.")
        err("Make sure the Pico W is in BOOTSEL mode (hold BOOTSEL while plugging in USB).")
        return False

    ok(f"Found RPI-RP2 drive at: {drive}")

    dest = os.path.join(drive, os.path.basename(uf2_path))
    info(f"Copying {uf2_path} → {dest}")

    if dry_run:
        ok("[dry-run] Would copy UF2 to drive")
        return True

    try:
        shutil.copy2(uf2_path, dest)
    except Exception as e:
        err(f"Failed to copy UF2: {e}")
        return False

    ok("UF2 copied — Pico W will reboot automatically")
    info("Waiting for Pico W to reboot and appear as serial port…")
    time.sleep(5)
    return True

# ---------------------------------------------------------------------------
# config.py generation
# ---------------------------------------------------------------------------

def generate_config(ssid, password, brightness, model, idle_text=""):
    """Generate a config.py with the given settings."""
    return f'''# Galactic Unicorn Display Firmware — Configuration
# Generated by flash.py

# ---------------------------------------------------------------------------
# Wi-Fi credentials
# ---------------------------------------------------------------------------
WIFI_SSID = {json.dumps(ssid)}
WIFI_PASSWORD = {json.dumps(password)}

# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
HTTP_PORT = 80
HTTP_HOST = "0.0.0.0"

# ---------------------------------------------------------------------------
# Display defaults
# ---------------------------------------------------------------------------
DEFAULT_BRIGHTNESS = {brightness:.2f}
QUEUE_MAX_SIZE = 16

# ---------------------------------------------------------------------------
# Startup splash screen
# ---------------------------------------------------------------------------
SPLASH_TEXT = "UberSDR"
SPLASH_COLOR = "rainbow"
SPLASH_SIZE = {"3" if model == "galactic" else "2"}

# ---------------------------------------------------------------------------
# Idle display (shown when queue is empty)
# Set IDLE_TEXT = "" to disable
# ---------------------------------------------------------------------------
IDLE_TEXT = {json.dumps(idle_text)}
IDLE_COLOR = "amber"
IDLE_SIZE = 1
IDLE_EFFECT = "static"
IDLE_ALIGN = "center"

# ---------------------------------------------------------------------------
# Hardware button behaviour
# ---------------------------------------------------------------------------
BRIGHTNESS_STEP = 0.1
BRIGHTNESS_MIN = 0.05
BRIGHTNESS_MAX = 1.0

# ---------------------------------------------------------------------------
# Network timeouts
# ---------------------------------------------------------------------------
WIFI_CONNECT_TIMEOUT = 20
HTTP_READ_TIMEOUT = 5
'''

# ---------------------------------------------------------------------------
# mpremote file copy
# ---------------------------------------------------------------------------

def mpremote_copy(port, local_path, remote_name, dry_run=False):
    """Copy a local file to the Pico W using mpremote."""
    cmd = ["mpremote"]
    if port:
        cmd += ["connect", port]
    cmd += ["cp", local_path, f":{remote_name}"]

    info(f"  {os.path.basename(local_path)} → :{remote_name}")

    if dry_run:
        ok(f"  [dry-run] Would run: {' '.join(cmd)}")
        return True

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err(f"  mpremote error: {result.stderr.strip() or result.stdout.strip()}")
        return False
    return True


def mpremote_reset(port, dry_run=False):
    """Soft-reset the Pico W."""
    cmd = ["mpremote"]
    if port:
        cmd += ["connect", port]
    cmd += ["reset"]

    info("Resetting Pico W…")
    if dry_run:
        ok("[dry-run] Would reset")
        return True

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    return result.returncode == 0


def mpremote_ls(port):
    """List files on the Pico W to verify copy succeeded."""
    cmd = ["mpremote"]
    if port:
        cmd += ["connect", port]
    cmd += ["ls"]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    return result.stdout.strip()

# ---------------------------------------------------------------------------
# Interactive prompts
# ---------------------------------------------------------------------------

def prompt_wifi():
    """Interactively prompt for Wi-Fi credentials."""
    print()
    print("Wi-Fi Configuration")
    print("─" * 40)
    ssid = input("  Wi-Fi network name (SSID): ").strip()
    if not ssid:
        err("SSID cannot be empty")
        sys.exit(1)
    password = getpass.getpass("  Wi-Fi password: ")
    return ssid, password


def prompt_confirm(question, default=True):
    """Ask a yes/no question."""
    suffix = " [Y/n] " if default else " [y/N] "
    answer = input(question + suffix).strip().lower()
    if not answer:
        return default
    return answer in ("y", "yes")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Flash UberSDR Galactic Unicorn firmware to a Pico W",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument("--port", help="Serial port (auto-detected if omitted)")
    parser.add_argument("--model", choices=["galactic", "stellar", "cosmic"],
                        default="galactic",
                        help="Display model (default: galactic)")
    parser.add_argument("--ssid", help="Wi-Fi SSID")
    parser.add_argument("--password", help="Wi-Fi password")
    parser.add_argument("--brightness", type=float, default=0.5,
                        help="Default brightness 0.0–1.0 (default: 0.5)")
    parser.add_argument("--idle-text", default="",
                        help="Text to show when display is idle (default: blank)")
    parser.add_argument("--no-flash", action="store_true",
                        help="Skip UF2 flashing (only copy Python files)")
    parser.add_argument("--no-download", action="store_true",
                        help="Skip UF2 download (use existing file in firmware/)")
    parser.add_argument("--uf2", help="Path to a local UF2 file to flash")
    parser.add_argument("--firmware-dir", default=FIRMWARE_DIR,
                        help=f"Directory containing firmware .py files (default: {FIRMWARE_DIR})")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be done without doing it")
    args = parser.parse_args()

    print()
    print("╔══════════════════════════════════════════════════════╗")
    print("║   UberSDR — Galactic Unicorn Firmware Flasher        ║")
    print("╚══════════════════════════════════════════════════════╝")
    print()

    model_labels = {
        "galactic": "Galactic Unicorn (53×11)",
        "stellar":  "Stellar Unicorn (16×16)",
        "cosmic":   "Cosmic Unicorn (32×32)",
    }
    info(f"Target model: {model_labels[args.model]}")
    if args.dry_run:
        warn("DRY RUN — no changes will be made")

    # ── Step 1: Check dependencies ──────────────────────────────────────────
    step("Checking dependencies")
    check_dependencies()

    # ── Step 2: Wi-Fi credentials ────────────────────────────────────────────
    step("Wi-Fi configuration")
    ssid = args.ssid
    password = args.password
    if not ssid or not password:
        ssid, password = prompt_wifi()
    else:
        ok(f"Using SSID: {ssid}")

    # ── Step 3: UF2 firmware ─────────────────────────────────────────────────
    uf2_path = args.uf2
    if not args.no_flash:
        step("Pimoroni MicroPython firmware")

        if uf2_path:
            if not os.path.exists(uf2_path):
                err(f"UF2 file not found: {uf2_path}")
                sys.exit(1)
            ok(f"Using local UF2: {uf2_path}")
        else:
            # Look for existing UF2 in firmware dir
            existing = glob.glob(os.path.join(args.firmware_dir, "*.uf2"))
            if existing and args.no_download:
                uf2_path = existing[0]
                ok(f"Using existing UF2: {uf2_path}")
            elif existing and not args.no_download:
                ok(f"Found existing UF2: {os.path.basename(existing[0])}")
                if prompt_confirm("Re-download latest version?", default=False):
                    uf2_path = None
                else:
                    uf2_path = existing[0]

            if not uf2_path:
                # Download latest
                url, filename = get_latest_uf2_url(args.model)
                if not url:
                    err("Could not determine UF2 download URL.")
                    err("Download manually from: https://github.com/pimoroni/pimoroni-pico/releases")
                    err("Then re-run with: --uf2 /path/to/firmware.uf2")
                    sys.exit(1)

                uf2_path = os.path.join(args.firmware_dir, filename)
                if not args.dry_run:
                    os.makedirs(args.firmware_dir, exist_ok=True)
                    if not download_uf2(url, uf2_path):
                        sys.exit(1)
                else:
                    ok(f"[dry-run] Would download to {uf2_path}")

        # Flash the UF2
        if not flash_uf2(uf2_path, dry_run=args.dry_run):
            err("UF2 flashing failed.")
            err("You can flash manually by copying the UF2 file to the RPI-RP2 drive.")
            sys.exit(1)

        # Wait for Pico W to reboot into MicroPython
        info("Waiting for Pico W to boot into MicroPython…")
        if not args.dry_run:
            time.sleep(8)
    else:
        info("Skipping UF2 flash (--no-flash)")

    # ── Step 4: Detect serial port ───────────────────────────────────────────
    step("Detecting serial port")
    port = args.port
    if not port:
        # After a UF2 flash the Pico W takes several seconds to enumerate as a
        # serial port. Retry for up to 15 seconds before asking the user.
        info("Scanning for Pico W serial port", )
        for attempt in range(15):
            port = find_pico_port()
            if port:
                break
            print(".", end="", flush=True)
            if not args.dry_run:
                time.sleep(1)
        print()

        if port:
            ok(f"Found Pico W at: {port}")
        else:
            warn("Could not auto-detect serial port.")
            print()
            print("  Plug in the Pico W via USB (not in BOOTSEL mode this time).")
            print("  Common ports:")
            print("    Linux:  /dev/ttyACM0  or  /dev/ttyACM1")
            print("    macOS:  /dev/cu.usbmodem*")
            print("    Windows: COM3  (check Device Manager)")
            print()
            port = input("  Enter serial port: ").strip() or None
            if not port:
                err("No serial port specified.")
                sys.exit(1)
    else:
        ok(f"Using port: {port}")

    # ── Step 5: Generate config.py ───────────────────────────────────────────
    step("Generating config.py")
    config_content = generate_config(
        ssid=ssid,
        password=password,
        brightness=args.brightness,
        model=args.model,
        idle_text=args.idle_text,
    )

    # Write to a temp file for transfer
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False,
                                     prefix="gu_config_") as tmp:
        tmp.write(config_content)
        tmp_config_path = tmp.name

    ok(f"config.py generated (SSID: {ssid}, brightness: {args.brightness})")

    # ── Step 6: Copy firmware files ──────────────────────────────────────────
    step("Copying firmware files to Pico W")

    firmware_dir = args.firmware_dir
    if not os.path.isdir(firmware_dir):
        err(f"Firmware directory not found: {firmware_dir}")
        err("Make sure you're running flash.py from the clients/galactic_unicorn/ directory")
        err("or pass --firmware-dir /path/to/firmware/")
        sys.exit(1)

    # Build the ordered list of (local_path, remote_name) pairs to copy.
    # config.py is copied from the temp file — it is NEVER read from the repo.
    files_to_copy = []
    for filename in FIRMWARE_FILES:
        local_path = os.path.join(firmware_dir, filename)
        if not os.path.exists(local_path):
            err(f"Firmware file not found: {local_path}")
            err(f"Expected: {local_path}")
            os.unlink(tmp_config_path)
            sys.exit(1)
        files_to_copy.append((local_path, filename))

    # config.py goes last so the device boots correctly even if interrupted
    files_to_copy.append((tmp_config_path, "config.py"))

    # Retry loop — mpremote can fail on first attempt after reboot
    max_retries = 3
    for attempt in range(1, max_retries + 1):
        success = True

        for local_path, remote_name in files_to_copy:
            if not mpremote_copy(port, local_path, remote_name, dry_run=args.dry_run):
                success = False
                if attempt < max_retries:
                    warn(f"Copy failed (attempt {attempt}/{max_retries}), retrying in 3s…")
                    time.sleep(3)
                break

        if success:
            break
    else:
        err("Failed to copy firmware files after multiple attempts.")
        err("Try running manually:")
        err(f"  mpremote connect {port or 'auto'} cp firmware/display_engine.py :display_engine.py")
        err(f"  mpremote connect {port or 'auto'} cp firmware/main.py :main.py")
        err(f"  mpremote connect {port or 'auto'} cp /tmp/gu_config_XXXXX.py :config.py")
        os.unlink(tmp_config_path)
        sys.exit(1)

    # Clean up temp config
    os.unlink(tmp_config_path)

    # ── Step 7: Verify ───────────────────────────────────────────────────────
    step("Verifying files on device")
    if not args.dry_run:
        listing = mpremote_ls(port)
        if listing:
            ok("Files on device:")
            for line in listing.splitlines():
                print(f"  {line}")
        else:
            warn("Could not list files (device may still be booting)")

    # ── Step 8: Reset ────────────────────────────────────────────────────────
    step("Resetting Pico W")
    mpremote_reset(port, dry_run=args.dry_run)

    # ── Done ─────────────────────────────────────────────────────────────────
    print()
    print("╔══════════════════════════════════════════════════════╗")
    print("║   ✓  Firmware installed successfully!                ║")
    print("╚══════════════════════════════════════════════════════╝")
    print()
    ok(f"Model:      {model_labels[args.model]}")
    ok(f"Wi-Fi:      {ssid}")
    ok(f"Brightness: {args.brightness}")
    print()
    info("The display will show 'UberSDR' while connecting to Wi-Fi,")
    info("then briefly show its IP address.")
    info("Add that IP to your notifications.yaml:")
    print()
    print("  channels:")
    print("    shack_display:")
    print("      type: galactic_unicorn")
    print(f"      galactic_unicorn_model: {args.model}")
    print("      galactic_unicorn_url: http://<IP-shown-on-display>")
    print("      galactic_unicorn_color: amber")
    print("      galactic_unicorn_effect: auto")
    print("      galactic_unicorn_duration: 10.0")
    print()


if __name__ == "__main__":
    main()
