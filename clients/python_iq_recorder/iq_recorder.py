#!/usr/bin/env python3
"""
IQ Stream Recorder
Multi-stream IQ recording application for ka9q_ubersdr

This application allows you to record multiple IQ streams simultaneously
from a ka9q_ubersdr instance to WAV files.

Supported IQ modes:
- IQ48: 48 kHz sample rate (±24 kHz bandwidth)
- IQ96: 96 kHz sample rate (±48 kHz bandwidth)
- IQ192: 192 kHz sample rate (±96 kHz bandwidth)

Usage:
    python iq_recorder.py

Features:
- Record unlimited simultaneous IQ streams
- Independent frequency and mode control per stream
- WAV file output with configurable naming
- Real-time status monitoring
- Configuration save/load
"""

import sys
import os

# Add parent directory to path to import radio_client
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

from iq_recorder_gui import main

if __name__ == '__main__':
    main()
