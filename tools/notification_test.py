#!/usr/bin/env python3
"""
UberSDR Notification Test Tool
================================
Interactive wizard that walks you through testing the UberSDR notification
system via the admin API.

Steps:
  1. Ask for the UberSDR server URL and admin password.
  2. Ask which channel type to test (telegram / named channel).
  3. For Telegram ad-hoc mode:
       a. Ask for the bot token.
       b. Call /admin/notifications/telegram-updates to discover chat IDs.
       c. Let the user pick a chat (or enter one manually).
       d. Optionally customise the message.
       e. Call /admin/notifications/test and show the result.
  4. For a named channel (already in notifications.yaml):
       a. Call /admin/notifications/health to list configured channels.
       b. Let the user pick one.
       c. Optionally customise the message.
       d. Call /admin/notifications/test and show the result.

Requirements: Python 3.7+, no third-party packages needed.

Usage:
  python3 tools/notification_test.py
  python3 tools/notification_test.py --url http://localhost:8073 --password secret
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


# ── ANSI colours (disabled on Windows or when not a TTY) ─────────────────────

def _supports_colour() -> bool:
    import os
    return sys.stdout.isatty() and os.name != "nt"


_COLOUR = _supports_colour()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOUR else text


def green(t: str) -> str:  return _c("32", t)
def red(t: str) -> str:    return _c("31", t)
def yellow(t: str) -> str: return _c("33", t)
def bold(t: str) -> str:   return _c("1",  t)
def dim(t: str) -> str:    return _c("2",  t)


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _request(url: str, password: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Make a GET (body=None) or POST (body=dict) request to the admin API.
    Returns the parsed JSON response dict.
    Raises urllib.error.HTTPError / urllib.error.URLError on network errors.
    """
    data = json.dumps(body).encode() if body is not None else None
    method = "POST" if data is not None else "GET"
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Password": password,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        # Try to parse the error body as JSON for a nicer message
        try:
            return json.loads(e.read().decode())
        except Exception:
            raise


# ── Prompt helpers ────────────────────────────────────────────────────────────

def prompt(msg: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        val = input(f"{bold(msg)}{dim(suffix)}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)
    return val if val else default


def prompt_choice(options: list, label: str = "choice") -> int:
    """Print a numbered list and return the 0-based index of the chosen item."""
    for i, opt in enumerate(options, 1):
        print(f"  {dim(str(i))}. {opt}")
    while True:
        raw = prompt(f"Enter {label} number")
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return int(raw) - 1
        print(red(f"  Please enter a number between 1 and {len(options)}."))


def print_json(obj: Dict[str, Any]) -> None:
    print(json.dumps(obj, indent=2, default=str))


# ── Main wizard ───────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="UberSDR notification test wizard")
    p.add_argument("--url", default="", help="UberSDR base URL (e.g. http://localhost:8073)")
    p.add_argument("--password", default="", help="Admin password")
    return p.parse_args()


def step_server(args: argparse.Namespace):
    print()
    print(bold("═══ UberSDR Notification Test Wizard ═══"))
    print()

    url = args.url or prompt("UberSDR server URL", "http://localhost:8073")
    url = url.rstrip("/")
    password = args.password or prompt("Admin password")
    return url, password


def step_verify_server(url: str, password: str) -> Dict[str, Any]:
    print()
    print(dim("  Checking server health…"))
    try:
        health = _request(f"{url}/admin/notifications/health", password)
    except urllib.error.URLError as e:
        print(red(f"  ✗ Cannot reach server: {e}"))
        sys.exit(1)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print(red("  ✗ Authentication failed — check your admin password."))
        else:
            print(red(f"  ✗ HTTP {e.code} from server."))
        sys.exit(1)

    enabled = health.get("enabled", False)
    channels = health.get("channels", [])
    rules = health.get("total_rules", 0)
    enabled_rules = health.get("enabled_rules", 0)

    status = green("enabled") if enabled else yellow("disabled")
    print(f"  Notification manager: {status}")
    print(f"  Channels configured:  {len(channels)}")
    print(f"  Rules:                {enabled_rules}/{rules} enabled")
    return health


def step_choose_mode(health: Dict[str, Any]) -> str:
    print()
    print(bold("How would you like to test?"))
    channels = health.get("channels", [])
    options = ["Telegram — ad-hoc (enter bot token + discover chat ID)"]
    if channels:
        options.append(f"Named channel — use a channel already in notifications.yaml ({len(channels)} available)")
    idx = prompt_choice(options, "mode")
    return "adhoc" if idx == 0 else "named"


# ── Ad-hoc Telegram flow ──────────────────────────────────────────────────────

def flow_adhoc_telegram(url: str, password: str) -> None:
    print()
    bot_token = prompt("Telegram bot token")
    if not bot_token:
        print(red("  Bot token is required."))
        sys.exit(1)

    # Discover chats
    print()
    print(dim("  Calling /admin/notifications/telegram-updates…"))
    try:
        result = _request(
            f"{url}/admin/notifications/telegram-updates",
            password,
            {"bot_token": bot_token},
        )
    except urllib.error.URLError as e:
        print(red(f"  ✗ Request failed: {e}"))
        sys.exit(1)

    if not result.get("ok"):
        print(red(f"  ✗ {result.get('error', 'Unknown error')}"))
        sys.exit(1)

    bot_username = result.get("bot_username", "")
    chats = result.get("chats", [])
    hint = result.get("hint", "")

    print(f"  Bot: {green('@' + bot_username) if bot_username else dim('unknown')}")

    chat_id: str
    if not chats:
        print(yellow(f"  ⚠  {hint}"))
        print()
        chat_id = prompt("Enter chat ID manually (e.g. 123456789 or -100123456789)")
        if not chat_id:
            print(red("  Chat ID is required."))
            sys.exit(1)
    else:
        print()
        print(bold("Discovered chats:"))

        def _chat_label(c: Dict[str, Any]) -> str:
            parts = [str(c["id"]), f"({c.get('type', '?')})"]
            if c.get("title"):
                parts.append(c["title"])
            elif c.get("first_name"):
                name = c["first_name"]
                if c.get("last_name"):
                    name += " " + c["last_name"]
                parts.append(name)
            if c.get("username"):
                parts.append(f"@{c['username']}")
            return "  ".join(parts)

        labels = [_chat_label(c) for c in chats]
        labels.append("Enter chat ID manually")
        idx = prompt_choice(labels, "chat")

        if idx == len(chats):
            chat_id = prompt("Chat ID")
        else:
            chat_id = str(chats[idx]["id"])

    # Optional custom message
    print()
    default_msg = "🔔 UberSDR notification test — this channel is working correctly."
    custom = prompt("Custom message (leave blank for default)")
    message = custom if custom else default_msg

    # Send test
    print()
    print(dim("  Sending test message…"))
    try:
        resp = _request(
            f"{url}/admin/notifications/test",
            password,
            {
                "type": "telegram",
                "bot_token": bot_token,
                "chat_id": chat_id,
                "message": message,
            },
        )
    except urllib.error.URLError as e:
        print(red(f"  ✗ Request failed: {e}"))
        sys.exit(1)

    _print_test_result(resp)


# ── Named channel flow ────────────────────────────────────────────────────────

def flow_named_channel(url: str, password: str, health: Dict[str, Any]) -> None:
    channels = health.get("channels", [])
    if not channels:
        print(red("  No channels configured in notifications.yaml."))
        sys.exit(1)

    print()
    print(bold("Available channels:"))

    def _ch_label(c: Dict[str, Any]) -> str:
        return f"{c.get('name', '?')}  ({c.get('type', '?')})"

    labels = [_ch_label(c) for c in channels]
    idx = prompt_choice(labels, "channel")
    channel_name = channels[idx].get("name", "")

    # Optional custom message
    print()
    default_msg = "🔔 UberSDR notification test — this channel is working correctly."
    custom = prompt("Custom message (leave blank for default)")
    message = custom if custom else default_msg

    # Send test
    print()
    print(dim("  Sending test message…"))
    try:
        resp = _request(
            f"{url}/admin/notifications/test",
            password,
            {
                "channel": channel_name,
                "message": message,
            },
        )
    except urllib.error.URLError as e:
        print(red(f"  ✗ Request failed: {e}"))
        sys.exit(1)

    _print_test_result(resp)


# ── Result display ────────────────────────────────────────────────────────────

def _print_test_result(resp: Dict[str, Any]) -> None:
    print()
    if resp.get("ok"):
        print(green("  ✓ Message sent successfully!"))
        print(f"  Channel:     {resp.get('channel', '?')}")
        print(f"  Type:        {resp.get('type', '?')}")
        print(f"  Duration:    {resp.get('duration_ms', '?')} ms")
        print(f"  Message:     {resp.get('message_sent', '')}")
    else:
        print(red("  ✗ Send failed."))
        print(f"  Error: {resp.get('error', 'unknown error')}")
        print()
        print(dim("  Full response:"))
        print_json(resp)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()
    url, password = step_server(args)
    health = step_verify_server(url, password)
    mode = step_choose_mode(health)

    if mode == "adhoc":
        flow_adhoc_telegram(url, password)
    else:
        flow_named_channel(url, password, health)

    print()


if __name__ == "__main__":
    main()
