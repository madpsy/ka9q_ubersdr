# PyInstaller hook for opuslib
# This ensures the Opus DLL is bundled with the frozen executable

from PyInstaller.utils.hooks import collect_dynamic_libs, get_package_paths
import os
import sys

# Collect all dynamic libraries from opuslib package
datas = []
binaries = collect_dynamic_libs('opuslib')

# If no binaries found via collect_dynamic_libs, try manual search
if not binaries and sys.platform == 'win32':
    try:
        import opuslib
        opuslib_path = os.path.dirname(opuslib.__file__)
        
        # Search for Opus DLL in opuslib directory
        for dll_name in ['opus.dll', 'libopus-0.dll', 'libopus.dll']:
            dll_path = os.path.join(opuslib_path, dll_name)
            if os.path.exists(dll_path):
                binaries.append((dll_path, '.'))
                print(f"hook-opuslib: Found {dll_name} at {dll_path}")
                break
    except Exception as e:
        print(f"hook-opuslib: Error searching for Opus DLL: {e}")
