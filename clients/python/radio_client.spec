# -*- mode: python ; coding: utf-8 -*-

import os

# Bundle opus.dll into the frozen executable so opuslib can find it at
# runtime via sys._MEIPASS (see the PyInstaller frozen-path handling in
# radio_client.py). Without this, opuslib's ctypes.util.find_library('opus')
# has nothing on PATH to find and Opus decoding silently disables itself.
opus_binaries = [('opus.dll', '.')] if os.path.exists('opus.dll') else []

a = Analysis(
    ['radio_client.py'],
    pathex=[],
    binaries=opus_binaries,
    datas=[],
    hiddenimports=['PIL._tkinter_finder'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='radio_client',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['ubersdr.ico'],
)
