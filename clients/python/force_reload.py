#!/usr/bin/env python3
"""
Force reload of public_instances_display module
Run this before starting radio_gui.py to ensure fresh module load
"""
import sys
import os

# Remove any cached imports
if 'public_instances_display' in sys.modules:
    del sys.modules['public_instances_display']

# Remove .pyc files
import pathlib
current_dir = pathlib.Path(__file__).parent

for pyc_file in current_dir.glob('**/*.pyc'):
    try:
        pyc_file.unlink()
        print(f"Removed: {pyc_file}")
    except Exception as e:
        print(f"Could not remove {pyc_file}: {e}")

for pycache_dir in current_dir.glob('**/__pycache__'):
    try:
        import shutil
        shutil.rmtree(pycache_dir)
        print(f"Removed directory: {pycache_dir}")
    except Exception as e:
        print(f"Could not remove {pycache_dir}: {e}")

print("\nCache cleared. Now start radio_gui.py")
print("If the filter still doesn't appear, run radio_gui.py with: python -B radio_gui.py")
