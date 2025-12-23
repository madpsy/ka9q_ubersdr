#!/usr/bin/env python3
"""
Download and install the Opus DLL for Windows.
This script downloads the official Opus DLL and places it where opuslib can find it.
"""

import os
import sys
import urllib.request
import zipfile
import shutil

def download_opus_dll():
    """Download and extract the Opus DLL for Windows."""
    
    if sys.platform != 'win32':
        print("This script is only needed on Windows")
        return False
    
    print("Downloading Opus DLL for Windows...")
    print()
    
    # Determine architecture
    import platform
    is_64bit = platform.machine().endswith('64')
    
    if is_64bit:
        # Download 64-bit version
        url = "https://github.com/xiph/opus/releases/download/v1.5.2/opus-tools-1.5.2-win64.zip"
        dll_name = "opus.dll"
        print("Detected 64-bit Python")
    else:
        # Download 32-bit version
        url = "https://github.com/xiph/opus/releases/download/v1.5.2/opus-tools-1.5.2-win32.zip"
        dll_name = "opus.dll"
        print("Detected 32-bit Python")
    
    print(f"Downloading from: {url}")
    
    # Download to temp file
    zip_path = "opus-tools.zip"
    try:
        urllib.request.urlretrieve(url, zip_path)
        print(f"✓ Downloaded to {zip_path}")
    except Exception as e:
        print(f"✗ Download failed: {e}")
        print()
        print("Manual download instructions:")
        print("1. Download opus.dll from: https://opus-codec.org/downloads/")
        print("2. Or from: https://github.com/xiph/opus/releases")
        print("3. Place opus.dll in the same directory as radio_client.exe")
        return False
    
    # Extract DLL
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            # List contents
            print()
            print("Archive contents:")
            for name in zip_ref.namelist():
                if name.endswith('.dll'):
                    print(f"  {name}")
            
            # Extract opus.dll if found
            dll_found = False
            for name in zip_ref.namelist():
                if 'opus.dll' in name.lower():
                    print()
                    print(f"Extracting {name}...")
                    zip_ref.extract(name, '.')
                    
                    # Move to current directory
                    extracted_path = name
                    if os.path.exists(extracted_path):
                        shutil.move(extracted_path, 'opus.dll')
                        print(f"✓ Extracted to opus.dll")
                        dll_found = True
                        break
            
            if not dll_found:
                print("✗ opus.dll not found in archive")
                return False
                
    except Exception as e:
        print(f"✗ Extraction failed: {e}")
        return False
    finally:
        # Clean up
        if os.path.exists(zip_path):
            os.remove(zip_path)
    
    # Try to find opuslib installation directory
    try:
        import opuslib
        opuslib_path = os.path.dirname(opuslib.__file__)
        
        # Copy DLL to opuslib directory
        dest_path = os.path.join(opuslib_path, 'opus.dll')
        shutil.copy('opus.dll', dest_path)
        print(f"✓ Copied to opuslib directory: {dest_path}")
        print()
        print("SUCCESS! Opus DLL installed.")
        print("You can now rebuild with PyInstaller.")
        return True
        
    except ImportError:
        print()
        print("✓ opus.dll downloaded to current directory")
        print()
        print("opuslib not installed. Install it with:")
        print("  pip install opuslib")
        print()
        print("Then run this script again to copy the DLL to the right location.")
        return False

if __name__ == '__main__':
    print("=" * 70)
    print("Opus DLL Installer for Windows")
    print("=" * 70)
    print()
    
    success = download_opus_dll()
    
    if success:
        print()
        print("Next steps:")
        print("1. Rebuild your executable: pyinstaller radio_client.spec")
        print("2. The Opus DLL will be automatically included")
    else:
        print()
        print("Alternative: Download opus.dll manually and place it:")
        print("1. In the same directory as radio_client.exe (after building)")
        print("2. Or in your opuslib package directory before building")
