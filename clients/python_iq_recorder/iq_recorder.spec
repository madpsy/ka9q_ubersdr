# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for UberSDR IQ Stream Recorder

Usage:
    pyinstaller iq_recorder.spec

This will create a standalone executable in the dist/ directory.
"""

import sys
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Get the path to the parent python directory (clients/python)
# SPECPATH is clients/python_iq_recorder, so we go up one level to clients, then into python
parent_python_dir = os.path.abspath(os.path.join(SPECPATH, '..', 'python'))
radio_client_path = os.path.join(parent_python_dir, 'radio_client.py')

# Verify the path exists
if not os.path.exists(radio_client_path):
    raise FileNotFoundError(f"radio_client.py not found at: {radio_client_path}")

block_cipher = None

a = Analysis(
    ['iq_recorder.py'],
    pathex=[
        SPECPATH,
        parent_python_dir,  # Add parent python directory to search path
    ],
    binaries=[],
    datas=[
        # Include radio_client.py from parent directory
        (radio_client_path, '.'),
        
        # Include README and documentation
        ('README.md', '.'),
        ('INSTALL.md', '.'),
    ],
    hiddenimports=[
        # Core dependencies from parent directory
        'radio_client',
        
        # Standard library modules that might not be auto-detected
        'asyncio',
        'websockets',
        'aiohttp',
        'numpy',
        'tkinter',
        'tkinter.ttk',
        'tkinter.filedialog',
        'tkinter.messagebox',
        
        # Optional audio libraries
        'opuslib',
        'zstandard',
        'scipy',
        'sounddevice',
        'pyaudio',
        'samplerate',
        
        # Other potential dependencies
        'requests',
        'json',
        'pathlib',
        'threading',
        'queue',
        'collections',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude unnecessary modules to reduce size
        'matplotlib',
        'pandas',
        'PIL',
        'PyQt5',
        'PyQt6',
        'PySide2',
        'PySide6',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='iq_recorder',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # Set to False for GUI app (no console window)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='ubersdr.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='iq_recorder',
)
