#!/usr/bin/env python3
"""
Debug script to compare KiwiSDR waterfall packets between real and UberSDR servers
"""

import asyncio
import websockets
import struct
import sys
from datetime import datetime

async def send_keepalive_loop(websocket, stop_event, name):
    """Send keepalive messages every 5 seconds (matching real KiwiSDR client)"""
    while not stop_event.is_set():
        try:
            await asyncio.sleep(5.0)
            if not stop_event.is_set():
                await websocket.send("SET keepalive")
                # print(f"  [keepalive sent on {name}]")
        except Exception as e:
            break

async def read_snd_messages(ws_snd, stop_event):
    """Read and discard messages from SND connection to keep it alive"""
    try:
        while not stop_event.is_set():
            message = await asyncio.wait_for(ws_snd.recv(), timeout=1.0)
            # Just discard SND messages, we only care about W/F
    except asyncio.TimeoutError:
        pass
    except Exception as e:
        pass

async def connect_and_debug(url, name, password=""):
    """Connect to a KiwiSDR server and analyze waterfall packets"""
    print(f"\n{'='*60}")
    print(f"Connecting to {name}: {url}")
    print(f"{'='*60}\n")

    timestamp = str(int(datetime.now().timestamp() * 1000000000))

    # Real KiwiSDR client opens TWO WebSocket connections:
    # 1. SND (audio) connection first
    # 2. W/F (waterfall) connection after auth succeeds
    ws_snd_url = f"{url}/ws/kiwi/{timestamp}/SND"
    ws_wf_url = f"{url}/ws/kiwi/{timestamp}/W/F"

    try:
        # Open SND connection first (like real client)
        async with websockets.connect(ws_snd_url, max_size=10*1024*1024) as ws_snd:
            print(f"✓ Connected SND websocket to {name}")

            # Start keepalive loop for SND connection
            stop_keepalive_snd = asyncio.Event()
            keepalive_task_snd = asyncio.create_task(send_keepalive_loop(ws_snd, stop_keepalive_snd, "SND"))

            # Start task to read SND messages (keeps connection alive)
            stop_snd_reader = asyncio.Event()
            snd_reader_task = asyncio.create_task(read_snd_messages(ws_snd, stop_snd_reader))

            try:
                # Send auth on SND connection
                auth_cmd = f"SET auth t=kiwi p={password if password else '#'}"
                await ws_snd.send(auth_cmd)
                print(f"✓ Sent auth on SND (password={'yes' if password else 'no'})")

                await ws_snd.send("SERVER DE CLIENT debug_kiwi_waterfall.py SND")
                print(f"✓ Sent SERVER DE CLIENT on SND")

                # Send required identification messages (server waits for these)
                await ws_snd.send("SET ident_user=debug_script")
                print(f"✓ Sent ident_user")

                await ws_snd.send("SET require_id=0")
                print(f"✓ Sent require_id=0")

                await ws_snd.send("SET need_status=1")
                print(f"✓ Sent need_status=1")

                # Set frequency and mode (required for server to show active connection)
                await ws_snd.send("SET mod=am low_cut=-4000 high_cut=4000 freq=7100.0")
                print(f"✓ Sent frequency and mode")

                # Wait for auth response
                await asyncio.sleep(0.5)

                # Now open W/F connection (like real client does after auth)
                async with websockets.connect(ws_wf_url, max_size=10*1024*1024) as ws_wf:
                    print(f"✓ Connected W/F websocket to {name}")

                    # Start keepalive loop for W/F connection
                    stop_keepalive_wf = asyncio.Event()
                    keepalive_task_wf = asyncio.create_task(send_keepalive_loop(ws_wf, stop_keepalive_wf, "W/F"))

                    try:
                        # Send auth on W/F connection too
                        await ws_wf.send(auth_cmd)
                        print(f"✓ Sent auth on W/F")

                        await ws_wf.send("SERVER DE CLIENT debug_kiwi_waterfall.py W/F")
                        print(f"✓ Sent SERVER DE CLIENT on W/F")

                        await ws_wf.send("SET send_dB=1")
                        print(f"✓ Sent send_dB=1")

                        await ws_wf.send("SET zoom=0 start=0")
                        print(f"✓ Sent zoom=0 start=0")

                        await ws_wf.send("SET maxdb=0 mindb=-100")
                        print(f"✓ Sent maxdb/mindb")

                        # Send wf_speed (required by real KiwiSDR)
                        await ws_wf.send("SET wf_speed=1")
                        print(f"✓ Sent wf_speed")

                        print(f"✓ Keepalive loops running (every 5s)")

                        # Wait for init messages and look for W/F packets
                        msg_count = 0
                        wf_setup_received = False
                        wf_packets_during_init = 0

                        while msg_count < 50:
                            try:
                                message = await asyncio.wait_for(ws_wf.recv(), timeout=5.0)
                                msg_count += 1

                                if isinstance(message, bytes):
                                    # Print first 20 bytes of ALL binary messages to debug
                                    first_bytes = message[:min(20, len(message))]
                                    print(f"  Binary #{msg_count} (len={len(message)}): {first_bytes}")

                                    if message.startswith(b'MSG '):
                                        msg_text = message[4:].decode('utf-8', errors='ignore')
                                        # Only print first 100 chars to avoid clutter
                                        display_text = msg_text[:100] if len(msg_text) > 100 else msg_text
                                        print(f"    -> MSG: {display_text}")
                                        # Look for wf_setup or wf_fft_size as indicators that waterfall is ready
                                        if 'wf_setup' in msg_text or 'wf_fft_size' in msg_text:
                                            wf_setup_received = True
                                            print("    -> ✓✓✓ waterfall init received ✓✓✓")
                                    elif message.startswith(b'W/F'):
                                        wf_packets_during_init += 1
                                        print(f"    -> ✓ W/F packet during init!")
                                        analyze_wf_packet(message, name)
                                    elif message.startswith(b'SND'):
                                        print(f"    -> SND packet (audio, ignoring)")
                                    else:
                                        print(f"    -> Unknown binary type")
                                else:
                                    print(f"  Text message #{msg_count}: {message[:100]}")

                            except asyncio.TimeoutError:
                                print(f"  Timeout after {msg_count} messages")
                                break

                        if wf_packets_during_init > 0:
                            print(f"\n✓ Received {wf_packets_during_init} W/F packets during init - waterfall is working!")
                            return

                        if not wf_setup_received:
                            print(f"✗ Never received waterfall init message")
                            return

                        # The waterfall stream should start automatically after wf_setup
                        print("\n✓ Waiting for automatic waterfall stream...")

                        # Wait for waterfall packets
                        wf_packet_count = 0
                        zoom_sent = False
                        while wf_packet_count < 5:
                            try:
                                message = await asyncio.wait_for(ws_wf.recv(), timeout=10.0)

                                if isinstance(message, bytes) and message.startswith(b'W/F'):
                                    wf_packet_count += 1
                                    print(f"\n{'='*60}")
                                    print(f"W/F Packet #{wf_packet_count} from {name}")
                                    print(f"{'='*60}")
                                    analyze_wf_packet(message, name)
                                elif isinstance(message, bytes) and message.startswith(b'MSG '):
                                    # Still receiving MSG packets, maybe need to send zoom
                                    if not zoom_sent:
                                        print(f"\n✓ Still getting MSG packets, sending zoom command...")
                                        await ws_wf.send("SET zoom=0 start=0")
                                        zoom_sent = True

                            except asyncio.TimeoutError:
                                if not zoom_sent:
                                    print(f"\n✗ Timeout, trying zoom command...")
                                    await ws_wf.send("SET zoom=0 start=0")
                                    zoom_sent = True
                                    continue
                                print(f"\n✗ Timeout waiting for W/F packet {wf_packet_count+1}")
                                break

                    finally:
                        # Stop W/F keepalive loop
                        stop_keepalive_wf.set()
                        await keepalive_task_wf

            finally:
                # Stop SND tasks
                stop_snd_reader.set()
                stop_keepalive_snd.set()
                await snd_reader_task
                await keepalive_task_snd

    except Exception as e:
        print(f"\n✗ Error connecting to {name}: {e}")
        import traceback
        traceback.print_exc()

def analyze_wf_packet(packet, server_name):
    """Analyze a W/F packet structure"""

    # W/F packet structure:
    # Bytes 0-3: "W/F\x00" tag
    # Bytes 4-7: x_bin (uint32 little-endian)
    # Bytes 8-11: flags_zoom (uint32 little-endian)
    # Bytes 12-15: sequence (uint32 little-endian)
    # Bytes 16+: waterfall data

    if len(packet) < 16:
        print(f"  ✗ Packet too short: {len(packet)} bytes")
        return

    # Check tag
    tag = packet[0:4]
    print(f"  Tag: {tag} (expected: b'W/F\\x00')")

    # Parse header
    x_bin = struct.unpack('<I', packet[4:8])[0]
    flags_zoom = struct.unpack('<I', packet[8:12])[0]
    sequence = struct.unpack('<I', packet[12:16])[0]

    zoom = flags_zoom & 0xFFFF
    flags = (flags_zoom >> 16) & 0xFFFF
    compressed = (flags & 1) != 0

    print(f"  x_bin: {x_bin}")
    print(f"  zoom: {zoom}")
    print(f"  flags: 0x{flags:04X} (compressed={compressed})")
    print(f"  sequence: {sequence}")

    # Analyze data
    data = packet[16:]
    print(f"  Data length: {len(data)} bytes")

    if len(data) > 0:
        # Show first 20 bytes
        first_bytes = data[:min(20, len(data))]
        print(f"  First {len(first_bytes)} bytes: {list(first_bytes)}")

        # Statistics
        data_list = list(data)
        print(f"  Min value: {min(data_list)}")
        print(f"  Max value: {max(data_list)}")
        print(f"  Mean value: {sum(data_list)/len(data_list):.1f}")

        # Check if all zeros (would appear black)
        if all(b == 0 for b in data):
            print(f"  ✗ WARNING: All data bytes are 0 (waterfall will be black!)")
        elif all(b == 255 for b in data):
            print(f"  ✗ WARNING: All data bytes are 255 (waterfall will be white!)")
        else:
            non_zero = sum(1 for b in data if b != 0)
            print(f"  ✓ Data has variation: {non_zero}/{len(data)} non-zero bytes")

async def main():
    """Main function to compare both servers"""

    if len(sys.argv) > 1 and sys.argv[1] == '--real-only':
        # Only test real KiwiSDR
        await connect_and_debug("ws://44.31.241.9:8073", "Real KiwiSDR")
    elif len(sys.argv) > 1 and sys.argv[1] == '--uber-only':
        # Only test UberSDR
        await connect_and_debug("ws://44.31.241.13:8073", "UberSDR")
    else:
        # Test both
        print("\n" + "="*60)
        print("TESTING REAL KIWISDR")
        print("="*60)
        await connect_and_debug("ws://44.31.241.9:8073", "Real KiwiSDR")

        print("\n\n" + "="*60)
        print("TESTING UBERSDR")
        print("="*60)
        await connect_and_debug("ws://44.31.241.13:8073", "UberSDR")

        print("\n\n" + "="*60)
        print("COMPARISON COMPLETE")
        print("="*60)
        print("\nCompare the packet structures above to identify differences.")

if __name__ == "__main__":
    print("KiwiSDR Waterfall Debug Tool")
    print("Usage: python3 debug_kiwi_waterfall.py [--real-only|--uber-only]")
    asyncio.run(main())
