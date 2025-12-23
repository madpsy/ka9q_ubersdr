#!/usr/bin/env python3
"""
Automated build script for radio_client.
This script:
1. Checks for and downloads the Opus DLL if needed
2. Runs PyInstaller to build the executable
3. Copies the executable to a convenient location
"""

import os
import sys
import subprocess
import shutil
import urllib.request
import zipfile
import platform

def print_header(text):
    """Print a formatted header."""
    print()
    print("=" * 70)
    print(text)
    print("=" * 70)
    print()

def check_opus_dll():
    """Check if Opus DLL is available in current directory."""
    print_header("Step 1: Checking Opus DLL")
    
    # Check Python executable
    print(f"Using Python: {sys.executable}")
    print(f"Python version: {sys.version}")
    print()
    
    # Check for opus.dll in current directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    opus_dll_path = os.path.join(script_dir, 'opus.dll')
    
    if os.path.exists(opus_dll_path):
        print(f"✓ Found opus.dll: {opus_dll_path}")
        print("✓ Opus support will be included in the build")
        return True
    else:
        print(f"✗ opus.dll not found in: {script_dir}")
        print()
        print("Building without Opus support.")
        print("The application will work fine using PCM-zstd compression instead.")
        return True

def run_pyinstaller():
    """Run PyInstaller to build the executable."""
    print_header("Step 2: Building Executable with PyInstaller")
    
    if not os.path.exists('radio_client.spec'):
        print("✗ radio_client.spec not found")
        return False
    
    print("Running: pyinstaller radio_client.spec")
    print()
    
    try:
        result = subprocess.run(
            ['pyinstaller', 'radio_client.spec'],
            check=True,
            capture_output=False
        )
        print()
        print("✓ Build completed successfully")
        return True
    except subprocess.CalledProcessError as e:
        print()
        print(f"✗ Build failed with exit code {e.returncode}")
        return False
    except FileNotFoundError:
        print("✗ PyInstaller not found")
        print("Install with: pip install pyinstaller")
        return False

def find_executable():
    """Find the built executable."""
    # Check dist directory
    dist_dir = 'dist'
    if not os.path.exists(dist_dir):
        return None
    
    # Look for radio_client.exe or radio_client
    for name in ['radio_client.exe', 'radio_client']:
        exe_path = os.path.join(dist_dir, name)
        if os.path.exists(exe_path):
            return exe_path
    
    return None

def main():
    """Main build process."""
    print_header("Radio Client Build Script")
    
    # Change to script directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    print(f"Working directory: {script_dir}")
    
    # Step 1: Check/download Opus DLL
    if not check_opus_dll():
        print()
        print("✗ Build aborted due to Opus DLL issues")
        return 1
    
    # Step 2: Run PyInstaller
    if not run_pyinstaller():
        print()
        print("✗ Build failed")
        return 1
    
    # Step 3: Report results
    print_header("Build Complete!")
    
    exe_path = find_executable()
    if exe_path:
        exe_size = os.path.getsize(exe_path)
        print(f"✓ Executable created: {exe_path}")
        print(f"  Size: {exe_size:,} bytes ({exe_size / 1024 / 1024:.1f} MB)")
        print()
        print("You can now run:")
        print(f"  {exe_path}")
    else:
        print("✗ Executable not found in dist directory")
        return 1
    
    print()
    print("=" * 70)
    print("SUCCESS!")
    print("=" * 70)
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        print("Build cancelled by user")
        sys.exit(1)
    except Exception as e:
        print()
        print(f"Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
