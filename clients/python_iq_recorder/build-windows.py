#!/usr/bin/env python3
"""
Automated build script for IQ Stream Recorder (Windows).
This script:
1. Checks for required dependencies
2. Runs PyInstaller to build the executable
3. Reports the results
"""

import os
import sys
import subprocess
import shutil
import platform

def print_header(text):
    """Print a formatted header."""
    print()
    print("=" * 70)
    print(text)
    print("=" * 70)
    print()

def check_venv():
    """Check if running in a virtual environment."""
    print_header("Step 1: Checking Virtual Environment")
    
    # Check if we're in a venv
    in_venv = hasattr(sys, 'real_prefix') or (
        hasattr(sys, 'base_prefix') and sys.base_prefix != sys.prefix
    )
    
    if in_venv:
        print(f"✓ Running in virtual environment")
        print(f"  Python: {sys.executable}")
        print(f"  Version: {sys.version.split()[0]}")
    else:
        print("✗ Not running in a virtual environment")
        print()
        print("It's recommended to use a virtual environment for building.")
        print()
        print("To create and activate a virtual environment:")
        print("  python -m venv venv")
        print("  venv\\Scripts\\activate")
        print("  pip install -r requirements.txt")
        print()
        response = input("Continue anyway? (y/N): ").strip().lower()
        if response != 'y':
            return False
    
    print()
    return True

def check_environment():
    """Check the build environment."""
    print_header("Step 2: Checking Build Environment")
    
    # Check Python executable
    print(f"Platform: {platform.system()} {platform.release()}")
    print()
    
    # Check for icon file
    script_dir = os.path.dirname(os.path.abspath(__file__))
    icon_path = os.path.join(script_dir, 'ubersdr.ico')
    
    if os.path.exists(icon_path):
        print(f"✓ Found icon: {icon_path}")
    else:
        print(f"✗ Icon not found: {icon_path}")
        print("  (Build will continue without icon)")
    
    # Check for radio_client.py dependency
    parent_python_dir = os.path.join(script_dir, '..', 'python')
    radio_client_path = os.path.join(parent_python_dir, 'radio_client.py')
    
    if os.path.exists(radio_client_path):
        print(f"✓ Found radio_client.py: {radio_client_path}")
    else:
        print(f"✗ radio_client.py not found: {radio_client_path}")
        print("  ERROR: This is required for building!")
        return False
    
    print()
    return True

def check_pyinstaller():
    """Check if PyInstaller is installed."""
    try:
        result = subprocess.run(
            ['pyinstaller', '--version'],
            capture_output=True,
            text=True,
            check=True
        )
        version = result.stdout.strip()
        print(f"✓ PyInstaller version: {version}")
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("✗ PyInstaller not found")
        print()
        print("Installing PyInstaller...")
        try:
            subprocess.run(
                [sys.executable, '-m', 'pip', 'install', 'pyinstaller'],
                check=True
            )
            print("✓ PyInstaller installed successfully")
            return True
        except subprocess.CalledProcessError:
            print("✗ Failed to install PyInstaller")
            print("  Please install manually: pip install pyinstaller")
            return False

def clean_previous_builds():
    """Clean previous build artifacts."""
    print_header("Step 2: Cleaning Previous Builds")
    
    dirs_to_clean = ['build', 'dist']
    for dir_name in dirs_to_clean:
        if os.path.exists(dir_name):
            print(f"Removing {dir_name}/")
            shutil.rmtree(dir_name)
    
    print("✓ Cleanup complete")
    print()

def run_pyinstaller():
    """Run PyInstaller to build the executable."""
    print_header("Step 3: Building Executable with PyInstaller")
    
    if not os.path.exists('iq_recorder.spec'):
        print("✗ iq_recorder.spec not found")
        return False
    
    print("Running: pyinstaller iq_recorder.spec")
    print()
    
    try:
        # Use Python module execution to avoid PATH issues
        result = subprocess.run(
            [sys.executable, '-m', 'PyInstaller', 'iq_recorder.spec'],
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
        print("✗ Python executable not found")
        return False

def find_executable():
    """Find the built executable."""
    # Check dist directory
    dist_dir = 'dist'
    if not os.path.exists(dist_dir):
        return None
    
    # Look for iq_recorder.exe or iq_recorder directory
    exe_path = os.path.join(dist_dir, 'iq_recorder', 'iq_recorder.exe')
    if os.path.exists(exe_path):
        return exe_path
    
    # Try without .exe extension
    exe_path = os.path.join(dist_dir, 'iq_recorder', 'iq_recorder')
    if os.path.exists(exe_path):
        return exe_path
    
    return None

def main():
    """Main build process."""
    print_header("IQ Stream Recorder - Windows Build Script")
    
    # Change to script directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    print(f"Working directory: {script_dir}")
    
    # Step 1: Check virtual environment
    if not check_venv():
        print()
        print("✗ Build aborted - please use a virtual environment")
        return 1
    
    # Step 2: Check environment
    if not check_environment():
        print()
        print("✗ Build aborted due to missing dependencies")
        return 1
    
    # Check PyInstaller
    if not check_pyinstaller():
        print()
        print("✗ Build aborted - PyInstaller not available")
        return 1
    
    # Step 3: Clean previous builds
    clean_previous_builds()
    
    # Step 4: Run PyInstaller
    if not run_pyinstaller():
        print()
        print("✗ Build failed")
        return 1
    
    # Step 5: Report results
    print_header("Build Complete!")
    
    exe_path = find_executable()
    if exe_path:
        exe_size = os.path.getsize(exe_path)
        print(f"✓ Executable created: {exe_path}")
        print(f"  Size: {exe_size:,} bytes ({exe_size / 1024 / 1024:.1f} MB)")
        print()
        print("You can now run:")
        print(f"  {exe_path}")
        print()
        print("To create a distributable package:")
        print(f"  1. Navigate to: {os.path.join(script_dir, 'dist')}")
        print(f"  2. Zip the 'iq_recorder' folder")
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
