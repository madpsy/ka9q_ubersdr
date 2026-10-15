# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for radio_client, the UberSDR command-line and Tk client.

    ./build.sh               Linux, and Windows under wine (see build.sh)
    pyinstaller radio_client.spec     by hand, on the OS you are building for

build.sh is how the release binaries are made. This file is also what
build-windows.py runs, for anyone building the .exe on Windows themselves.
"""

import os
import sys

# The version 4 payload codec in C, compiled by build.sh (gcc for the .so,
# MinGW for the .dll). pcm_v4.py looks for it in sys._MEIPASS first, so it goes
# in the bundle root. Without it the client falls back to the pure Python
# decoder, which works but cannot keep up with the wide IQ modes -- so
# build.sh refuses to build without it, while a hand build only warns here.
native = 'pcm_v4_native.dll' if sys.platform == 'win32' else 'pcm_v4_native.so'
binaries = []
if os.path.exists(os.path.join(SPECPATH, native)):
    binaries.append((os.path.join(SPECPATH, native), '.'))
else:
    print(f"radio_client.spec: WARNING: {native} not found -- the build will use the slow pure Python decoder")

# opus.dll, Windows only. opuslib finds the library with
# ctypes.util.find_library('opus'), which on Windows searches PATH, so
# PyInstaller only bundled it when it happened to be on PATH at build time.
# Listed explicitly instead; radio_client.py adds sys._MEIPASS to PATH and the
# DLL search path before importing opuslib. On Linux the system libopus is
# used, as the source run does.
if sys.platform == 'win32':
    opus_dll = os.path.join(SPECPATH, 'opus.dll')
    if os.path.exists(opus_dll):
        binaries.append((opus_dll, '.'))
    else:
        print("radio_client.spec: WARNING: opus.dll not found -- Opus decoding will be disabled")

a = Analysis(
    ['radio_client.py'],
    pathex=[SPECPATH],
    binaries=binaries,
    datas=[],
    hiddenimports=[
        # PIL's Tk bridge, imported by name from C, so never traced.
        'PIL._tkinter_finder',
        # The optional audio and DSP modules. radio_client imports each in a
        # try/except, which PyInstaller does follow, but naming them makes a
        # missing one a line in the warning report build.sh reads, rather
        # than a quiet "not available" at runtime.
        'opuslib',
        'samplerate',
        'sounddevice',
        'pyaudio',
        'scipy.signal',
        # Newer scipy moved its vendored array_api_compat from scipy._lib to
        # scipy._external, and PyInstaller's scipy hook names only the old
        # path. Without this every scipy import fails in the frozen app.
        # Harmless (a not-found warning) on a scipy with the old layout.
        'scipy._external.array_api_compat.numpy.fft',
    ],
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
