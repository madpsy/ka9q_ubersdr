#!/usr/bin/env python3
"""
Debug script to capture and compare MSG messages (user_cb, mkr, load_dxcfg) 
between real KiwiSDR and UberSDR servers
"""

import asyncio
import websockets
import json
import sys
from datetime import datetime
from urllib.parse import unquote

async def send_keepalive_loop(websocket, stop_event, name):
    """Send keepalive messages every 5 seconds"""
    while not stop_event.is_set():
        try:
            await asyncio.sleep(5.0)
            if not stop_event.is_set():
                await websocket.send("SET keepalive")
        except Exception as e:
            break

async def connect_and_capture(url, name, password=""):
    """Connect to a KiwiSDR server and capture MSG messages"""
    print(f"\n{'='*80}")
    print(f"Connecting to {name}: {url}")
    print(f"{'='*80}\n")

    timestamp = str(int(datetime.now().timestamp() * 1000000000))

    # Open SND connection (audio)
    ws_snd_url = f"{url}/ws/kiwi/{timestamp}/SND"
    ws_wf_url = f"{url}/ws/kiwi/{timestamp}/W/F"

    captured_messages = {
        'load_dxcfg': None,
        'user_cb': None,
        'mkr': []
    }

    try:
        # Open SND connection first
        async with websockets.connect(ws_snd_url, max_size=10*1024*1024) as ws_snd:
            print(f"✓ Connected SND websocket")

            # Start keepalive
            stop_keepalive_snd = asyncio.Event()
            keepalive_task_snd = asyncio.create_task(send_keepalive_loop(ws_snd, stop_keepalive_snd, "SND"))

            try:
                # Send auth
                auth_cmd = f"SET auth t=kiwi p={password if password else '#'}"
                await ws_snd.send(auth_cmd)
                print(f"✓ Sent auth")

                # Send identification
                await ws_snd.send("SET ident_user=debug_script")
                await ws_snd.send("SET mod=usb low_cut=300 high_cut=2400 freq=14074.0")
                
                # Request user list
                await ws_snd.send("SET GET_USERS")
                print(f"✓ Sent GET_USERS")

                # Wait a bit for responses
                await asyncio.sleep(0.5)

                # Open W/F connection
                async with websockets.connect(ws_wf_url, max_size=10*1024*1024) as ws_wf:
                    print(f"✓ Connected W/F websocket")

                    stop_keepalive_wf = asyncio.Event()
                    keepalive_task_wf = asyncio.create_task(send_keepalive_loop(ws_wf, stop_keepalive_wf, "W/F"))

                    try:
                        # Send auth on W/F
                        await ws_wf.send(auth_cmd)
                        
                        # Send zoom to trigger MARKER request
                        await ws_wf.send("SET zoom=0 start=0")
                        print(f"✓ Sent zoom=0 (should trigger MARKER request)")
                        
                        # Request markers for a specific range
                        await ws_wf.send("SET MARKER db=0 min=7000 max=21500 zoom=0 width=1024")
                        print(f"✓ Sent MARKER request for 7-21.5 MHz")

                        # Collect messages for 5 seconds
                        msg_count = 0
                        start_time = asyncio.get_event_loop().time()
                        
                        while asyncio.get_event_loop().time() - start_time < 5.0 and msg_count < 100:
                            try:
                                message = await asyncio.wait_for(ws_wf.recv(), timeout=1.0)
                                msg_count += 1

                                if isinstance(message, bytes) and message.startswith(b'MSG '):
                                    msg_text = message[4:].decode('utf-8', errors='ignore')
                                    
                                    # Parse MSG format: key=value
                                    if '=' in msg_text:
                                        key, value = msg_text.split('=', 1)
                                        
                                        if key == 'load_dxcfg':
                                            print(f"\n✓ Received load_dxcfg ({len(value)} bytes)")
                                            captured_messages['load_dxcfg'] = value
                                            # Try to parse and pretty print
                                            try:
                                                decoded = unquote(value)
                                                parsed = json.loads(decoded)
                                                print(f"  - dx_type entries: {len(parsed.get('dx_type', []))}")
                                                print(f"  - band_svc entries: {len(parsed.get('band_svc', []))}")
                                                print(f"  - bands entries: {len(parsed.get('bands', []))}")
                                                # Show first dx_type
                                                if parsed.get('dx_type'):
                                                    print(f"  - First dx_type: {parsed['dx_type'][0]}")
                                                # Show first band_svc
                                                if parsed.get('band_svc'):
                                                    print(f"  - First band_svc: {parsed['band_svc'][0]}")
                                                # Show first band
                                                if parsed.get('bands'):
                                                    print(f"  - First band: {parsed['bands'][0]}")
                                            except Exception as e:
                                                print(f"  ✗ Failed to parse: {e}")
                                        
                                        elif key == 'user_cb':
                                            print(f"\n✓ Received user_cb ({len(value)} bytes)")
                                            captured_messages['user_cb'] = value
                                            # Try to parse
                                            try:
                                                parsed = json.loads(value)
                                                print(f"  - Users: {len(parsed)}")
                                                if parsed:
                                                    print(f"  - First user: {parsed[0]}")
                                            except Exception as e:
                                                print(f"  ✗ Failed to parse: {e}")
                                                print(f"  - Raw (first 200 chars): {value[:200]}")
                                        
                                        elif key == 'mkr':
                                            print(f"\n✓ Received mkr ({len(value)} bytes)")
                                            captured_messages['mkr'].append(value)
                                            # Try to parse
                                            try:
                                                parsed = json.loads(value)
                                                if len(parsed) > 0:
                                                    header = parsed[0]
                                                    print(f"  - Header: pe={header.get('pe')}, fe={header.get('fe')}")
                                                    print(f"  - Bookmarks: {len(parsed) - 1}")
                                                    if len(parsed) > 1:
                                                        print(f"  - First bookmark: {parsed[1]}")
                                                        if len(parsed) > 2:
                                                            print(f"  - Second bookmark: {parsed[2]}")
                                            except Exception as e:
                                                print(f"  ✗ Failed to parse: {e}")
                                                print(f"  - Raw (first 200 chars): {value[:200]}")
                                        
                                        elif key in ['wf_setup', 'wf_fft_size', 'zoom_max']:
                                            print(f"  {key}={value}")

                            except asyncio.TimeoutError:
                                continue

                        print(f"\n{'='*80}")
                        print(f"CAPTURE SUMMARY for {name}")
                        print(f"{'='*80}")
                        print(f"load_dxcfg: {'✓ Captured' if captured_messages['load_dxcfg'] else '✗ Not received'}")
                        print(f"user_cb: {'✓ Captured' if captured_messages['user_cb'] else '✗ Not received'}")
                        print(f"mkr: {len(captured_messages['mkr'])} message(s) captured")
                        
                        return captured_messages

                    finally:
                        stop_keepalive_wf.set()
                        await keepalive_task_wf

            finally:
                stop_keepalive_snd.set()
                await keepalive_task_snd

    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return None

async def main():
    """Main function to compare both servers"""

    if len(sys.argv) > 1 and sys.argv[1] == '--real-only':
        # Only test real KiwiSDR
        await connect_and_capture("ws://44.31.241.9:8073", "Real KiwiSDR")
    elif len(sys.argv) > 1 and sys.argv[1] == '--uber-only':
        # Only test UberSDR
        await connect_and_capture("ws://44.31.241.13:8073", "UberSDR")
    else:
        # Test both and compare
        print("\n" + "="*80)
        print("TESTING REAL KIWISDR")
        print("="*80)
        real_msgs = await connect_and_capture("ws://44.31.241.9:8073", "Real KiwiSDR")

        print("\n\n" + "="*80)
        print("TESTING UBERSDR")
        print("="*80)
        uber_msgs = await connect_and_capture("ws://44.31.241.13:8073", "UberSDR")

        # Compare
        print("\n\n" + "="*80)
        print("COMPARISON")
        print("="*80)
        
        if real_msgs and uber_msgs:
            # Compare load_dxcfg
            if real_msgs['load_dxcfg'] and uber_msgs['load_dxcfg']:
                print("\n--- load_dxcfg Comparison ---")
                try:
                    real_dxcfg = json.loads(unquote(real_msgs['load_dxcfg']))
                    uber_dxcfg = json.loads(unquote(uber_msgs['load_dxcfg']))
                    
                    print(f"Real KiwiSDR:")
                    print(f"  - dx_type: {len(real_dxcfg.get('dx_type', []))} entries")
                    print(f"  - band_svc: {len(real_dxcfg.get('band_svc', []))} entries")
                    print(f"  - bands: {len(real_dxcfg.get('bands', []))} entries")
                    
                    print(f"\nUberSDR:")
                    print(f"  - dx_type: {len(uber_dxcfg.get('dx_type', []))} entries")
                    print(f"  - band_svc: {len(uber_dxcfg.get('band_svc', []))} entries")
                    print(f"  - bands: {len(uber_dxcfg.get('bands', []))} entries")
                    
                    # Show sample dx_type
                    if real_dxcfg.get('dx_type'):
                        print(f"\nReal dx_type[0]: {real_dxcfg['dx_type'][0]}")
                    if uber_dxcfg.get('dx_type'):
                        print(f"Uber dx_type[0]: {uber_dxcfg['dx_type'][0]}")
                    
                except Exception as e:
                    print(f"Error comparing load_dxcfg: {e}")
            
            # Compare mkr
            if real_msgs['mkr'] and uber_msgs['mkr']:
                print("\n--- mkr Comparison ---")
                print(f"Real KiwiSDR: {len(real_msgs['mkr'])} mkr message(s)")
                print(f"UberSDR: {len(uber_msgs['mkr'])} mkr message(s)")
                
                # Compare first mkr message
                if real_msgs['mkr'] and uber_msgs['mkr']:
                    try:
                        real_mkr = json.loads(real_msgs['mkr'][0])
                        uber_mkr = json.loads(uber_msgs['mkr'][0])
                        
                        print(f"\nReal KiwiSDR first mkr:")
                        print(f"  - Header: {real_mkr[0]}")
                        if len(real_mkr) > 1:
                            print(f"  - First bookmark: {real_mkr[1]}")
                        
                        print(f"\nUberSDR first mkr:")
                        print(f"  - Header: {uber_mkr[0]}")
                        if len(uber_mkr) > 1:
                            print(f"  - First bookmark: {uber_mkr[1]}")
                    except Exception as e:
                        print(f"Error comparing mkr: {e}")
            
            # Compare user_cb
            if real_msgs['user_cb'] and uber_msgs['user_cb']:
                print("\n--- user_cb Comparison ---")
                try:
                    real_users = json.loads(real_msgs['user_cb'])
                    uber_users = json.loads(uber_msgs['user_cb'])
                    
                    print(f"Real KiwiSDR: {len(real_users)} user(s)")
                    print(f"UberSDR: {len(uber_users)} user(s)")
                    
                    if real_users:
                        print(f"\nReal first user: {real_users[0]}")
                    if uber_users:
                        print(f"Uber first user: {uber_users[0]}")
                except Exception as e:
                    print(f"Error comparing user_cb: {e}")
                    print(f"Real raw: {real_msgs['user_cb'][:200]}")
                    print(f"Uber raw: {uber_msgs['user_cb'][:200]}")

if __name__ == "__main__":
    print("KiwiSDR Message Capture Tool")
    print("Captures and compares user_cb, mkr, and load_dxcfg messages")
    print("Usage: python3 debug_kiwi_messages.py [--real-only|--uber-only]")
    asyncio.run(main())
