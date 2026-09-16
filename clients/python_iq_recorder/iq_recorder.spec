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
# Both radio_client and iq_recorder_gui import this at the top level, so a build
# without it produces an exe that dies on startup with ModuleNotFoundError
# rather than failing here. Also pure Python, typing only.
tuning_range_path = os.path.join(parent_python_dir, 'tuning_range.py')

# Verify the paths exist. This is the check that catches a staged build -- see
# build.sh's Windows path -- that copied only some of clients/python across.
for _required in (radio_client_path, pcm_v4_path, tuning_range_path):
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
        (tuning_range_path, '.'),
        
        # Include README and documentation
        ('README.md', '.'),
        ('INSTALL.md', '.'),
    ],
    hiddenimports=[
        # Core dependencies from parent directory
        'radio_client',
        'pcm_v4',
        'tuning_range',
        
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
        # Newer scipy moved its vendored array_api_compat from scipy._lib to
        # scipy._external, and PyInstaller's scipy hook still names only the old
        # path. Without this every scipy import fails in the frozen app. Harmless
        # (a not-found warning) on a scipy that has the old layout.
        'scipy._external.array_api_compat.numpy.fft',
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
