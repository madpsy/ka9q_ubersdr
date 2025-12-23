#!/usr/bin/env python3
"""
Script to locate the Opus DLL on your system.
Run this to find where opuslib installed the Opus library.
"""

import os
import sys
import site

print("Searching for Opus DLL...")
print()

# Method 1: Check if opuslib is installed
try:
    import opuslib
    opuslib_path = os.path.dirname(opuslib.__file__)
    print(f"✓ opuslib package found at: {opuslib_path}")
    print()
    
    # Search in opuslib directory
    print("Checking opuslib directory for DLL files:")
    for dll_name in ['opus.dll', 'libopus-0.dll', 'libopus.dll']:
        dll_path = os.path.join(opuslib_path, dll_name)
        if os.path.exists(dll_path):
            print(f"  ✓ FOUND: {dll_path}")
        else:
            print(f"  ✗ Not found: {dll_path}")
    print()
    
    # List all files in opuslib directory
    print("All files in opuslib directory:")
    try:
        for item in os.listdir(opuslib_path):
            item_path = os.path.join(opuslib_path, item)
            if os.path.isfile(item_path):
                size = os.path.getsize(item_path)
                print(f"  {item} ({size:,} bytes)")
    except Exception as e:
        print(f"  Error listing files: {e}")
    print()
    
except ImportError:
    print("✗ opuslib package not installed")
    print("  Install with: pip install opuslib")
    print()

# Method 2: Check site-packages
print("Checking site-packages directories:")
for site_dir in site.getsitepackages():
    print(f"  {site_dir}")
    opuslib_dir = os.path.join(site_dir, 'opuslib')
    if os.path.exists(opuslib_dir):
        print(f"    ✓ opuslib directory exists")
        for dll_name in ['opus.dll', 'libopus-0.dll', 'libopus.dll']:
            dll_path = os.path.join(opuslib_dir, dll_name)
            if os.path.exists(dll_path):
                print(f"    ✓ FOUND: {dll_name}")
    else:
        print(f"    ✗ opuslib directory not found")
print()

# Method 3: Try ctypes to find library
print("Trying ctypes.util.find_library:")
try:
    import ctypes.util
    opus_lib = ctypes.util.find_library('opus')
    if opus_lib:
        print(f"  ✓ FOUND: {opus_lib}")
    else:
        print(f"  ✗ Not found via ctypes")
except Exception as e:
    print(f"  Error: {e}")
print()

# Method 4: Check if opuslib actually works
print("Testing if opuslib can load the library:")
try:
    import opuslib
    test_decoder = opuslib.Decoder(48000, 2)
    del test_decoder
    print("  ✓ SUCCESS: opuslib can load the Opus library")
except ImportError:
    print("  ✗ opuslib not installed")
except Exception as e:
    print(f"  ✗ FAILED: {e}")
    print("  This is the error you're seeing in the frozen executable")
print()

print("=" * 70)
print("SUMMARY:")
print("=" * 70)
print()
print("If no DLL was found above, you need to:")
print("1. Download the Opus library DLL from: https://opus-codec.org/downloads/")
print("2. Or install it via: pip install --force-reinstall opuslib")
print("3. Or manually download opus.dll and place it in the opuslib package directory")
print()
print("If a DLL was found, copy its path and use it with PyInstaller:")
print("  pyinstaller radio_client.spec --add-binary \"path\\to\\opus.dll;.\"")
