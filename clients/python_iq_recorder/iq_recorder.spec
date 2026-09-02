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
# radio_client imports this for protocol version 4; it is pure Python with no
# dependencies of its own. Bundled by name because radio_client.py is carried as
# a data file rather than analysed as source, so its imports are not traced.
pcm_v4_path = os.path.join(parent_python_dir, 'pcm_v4.py')

# Verify the paths exist
for _required in (radio_client_path, pcm_v4_path):
    if not os.path.exists(_required):
        raise FileNotFoundError(f"{os.path.basename(_required)} not found at: {_required}")

block_cipher = None

a = Analysis(
    ['iq_recorder.py'],
    pathex=[
        SPECPATH,
        parent_python_dir,  # Add parent python directory to search path
    ],
    binaries=[],
    datas=[
        # Include radio_client.py and its version 4 decoder from clients/python
        (radio_client_path, '.'),
        (pcm_v4_path, '.'),
        
        # Include README and documentation
        ('README.md', '.'),
        ('INSTALL.md', '.'),
    ],
    hiddenimports=[
        # Core dependencies from parent directory
        'radio_client',
        'pcm_v4',
        
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
        'requests.adapters',
        'requests.auth',
        'requests.cookies',
        'requests.exceptions',
        'requests.models',
        'requests.sessions',
        'requests.structures',
        'requests.utils',
        'urllib3',
        'urllib3.util',
        'urllib3.util.retry',
        'certifi',
        'charset_normalizer',
        'idna',
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
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='iq_recorder',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # Set to False for GUI app (no console window)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='ubersdr.ico',
)
