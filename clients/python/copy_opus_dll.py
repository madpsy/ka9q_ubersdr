#!/usr/bin/env python3
"""
Copy opus.dll from vcpkg installation to opuslib directory.
Run this after installing opus via vcpkg.
"""

import os
import sys
import shutil
import platform

def main():
    print("=" * 70)
    print("Copy Opus DLL from vcpkg to opuslib")
    print("=" * 70)
    print()
    
    # Find opuslib directory
    try:
        import opuslib
        opuslib_path = os.path.dirname(opuslib.__file__)
        print(f"✓ opuslib directory: {opuslib_path}")
    except ImportError:
        print("✗ opuslib not installed")
        print("Install with: pip install opuslib")
        return 1
    except Exception as e:
        print(f"✗ Cannot import opuslib: {e}")
        opuslib_path = None
    
    # Determine architecture
    is_64bit = platform.machine().endswith('64')
    triplet = "x64-windows" if is_64bit else "x86-windows"
    print(f"✓ Architecture: {triplet}")
    print()
    
    # Find vcpkg installation
    vcpkg_roots = [
        "C:\\vcpkg",
        os.path.expanduser("~/vcpkg"),
        "C:\\src\\vcpkg",
        os.path.join(os.getcwd(), "vcpkg")
    ]
    
    dll_path = None
    for vcpkg_root in vcpkg_roots:
        if os.path.exists(vcpkg_root):
            print(f"Checking: {vcpkg_root}")
            
            # Check installed directory
            installed_dir = os.path.join(vcpkg_root, "installed", triplet, "bin")
            if os.path.exists(installed_dir):
                print(f"  Found bin directory: {installed_dir}")
                
                # List DLLs
                try:
                    dlls = [f for f in os.listdir(installed_dir) if f.lower().endswith('.dll')]
                    if dlls:
                        print(f"  DLLs found: {', '.join(dlls)}")
                except:
                    pass
                
                # Look for opus DLL
                for dll_name in ['opus.dll', 'libopus.dll', 'libopus-0.dll']:
                    test_path = os.path.join(installed_dir, dll_name)
                    if os.path.exists(test_path):
                        dll_path = test_path
                        print(f"  ✓ Found: {dll_name}")
                        break
            
            if dll_path:
                break
    
    if not dll_path:
        print()
        print("✗ Could not find opus.dll in vcpkg installation")
        print()
        print("Searched in:")
        for root in vcpkg_roots:
            print(f"  {root}\\installed\\{triplet}\\bin")
        print()
        print("Make sure you ran: vcpkg install opus")
        return 1
    
    print()
    print(f"Source: {dll_path}")
    
    if not opuslib_path:
        print()
        print("Cannot copy - opuslib directory not found")
        return 1
    
    dest_path = os.path.join(opuslib_path, 'opus.dll')
    print(f"Destination: {dest_path}")
    print()
    
    # Copy the DLL
    try:
        shutil.copy(dll_path, dest_path)
        print("✓ DLL copied successfully!")
    except Exception as e:
        print(f"✗ Copy failed: {e}")
        return 1
    
    # Test if it works
    print()
    print("Testing Opus DLL...")
    try:
        import importlib
        importlib.reload(opuslib)
        test_decoder = opuslib.Decoder(48000, 2)
        del test_decoder
        print("✓ Opus DLL is working correctly!")
        print()
        print("=" * 70)
        print("SUCCESS! You can now run: python build.py")
        print("=" * 70)
        return 0
    except Exception as e:
        print(f"✗ Opus DLL test failed: {e}")
        print()
        print("The DLL was copied but doesn't work.")
        print("You may need to install Visual C++ Redistributable.")
        return 1

if __name__ == '__main__':
    sys.exit(main())
