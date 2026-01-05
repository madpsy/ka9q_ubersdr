#!/usr/bin/env python3
"""
Debug script to compare KiwiSDR waterfall packets between real and UberSDR servers
"""

import asyncio
import websockets
import struct
import sys
from datetime import datetime

async def connect_and_debug(url, name):
    """Connect to a KiwiSDR server and analyze waterfall packets"""
    print(f"\n{'='*60}")
    print(f"Connecting to {name}: {url}")
    print(f"{'='*60}\n")
    
    timestamp = str(int(datetime.now().timestamp() * 1000000000))
    ws_url = f"{url}/ws/kiwi/{timestamp}/W/F"
    
    try:
        async with websockets.connect(ws_url, max_size=10*1024*1024) as websocket:
            print(f"✓ Connected to {name}")
            
            # Send auth
            await websocket.send("SET auth t=kiwi p=#")
            print("✓ Sent auth")
            
            # Wait for init messages
            msg_count = 0
            wf_setup_received = False
            
            while msg_count < 30:
                try:
                    message = await asyncio.wait_for(websocket.recv(), timeout=3.0)
                    msg_count += 1
                    
                    if isinstance(message, bytes):
                        if message.startswith(b'MSG '):
                            msg_text = message[4:].decode('utf-8', errors='ignore')
                            # Only print first 100 chars to avoid clutter
                            display_text = msg_text[:100] if len(msg_text) > 100 else msg_text
                            print(f"  MSG #{msg_count}: {display_text}")
                            if 'wf_setup' in msg_text:
                                wf_setup_received = True
                                print("  ✓✓✓ wf_setup received ✓✓✓")
                        elif message.startswith(b'W/F'):
                            print(f"\n✓ Received W/F packet (message #{msg_count})")
                            analyze_wf_packet(message, name)
                            # Don't break, continue to get more packets
                    else:
                        print(f"  Text message #{msg_count}: {message[:100]}")
                        
                except asyncio.TimeoutError:
                    print(f"  Timeout after {msg_count} messages")
                    break
            
            if not wf_setup_received:
                print(f"✗ Never received wf_setup message")
                return
            
            # Send zoom command to trigger waterfall
            await websocket.send("SET zoom=0 start=0")
            print("\n✓ Sent zoom command")
            
            # Wait for waterfall packets
            wf_packet_count = 0
            while wf_packet_count < 5:
                try:
                    message = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                    
                    if isinstance(message, bytes) and message.startswith(b'W/F'):
                        wf_packet_count += 1
                        print(f"\n{'='*60}")
                        print(f"W/F Packet #{wf_packet_count} from {name}")
                        print(f"{'='*60}")
                        analyze_wf_packet(message, name)
                        
                except asyncio.TimeoutError:
                    print(f"\n✗ Timeout waiting for W/F packet {wf_packet_count+1}")
                    break
                    
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
