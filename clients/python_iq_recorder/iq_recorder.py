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
    GUI mode:
        python iq_recorder.py

    CLI mode (headless with scheduled recordings):
        python iq_recorder.py --config /path/to/config.json

Features:
- Record unlimited simultaneous IQ streams
- Independent frequency and mode control per stream
- WAV file output with configurable naming
- Real-time status monitoring
- Configuration save/load
- Scheduled recordings (CLI mode)
"""

import sys
import os
import argparse
import warnings

# Suppress warnings before any imports that might trigger them
warnings.filterwarnings('ignore', message='Unable to find acceptable character detection dependency')
try:
    from requests.exceptions import RequestsDependencyWarning
    warnings.filterwarnings('ignore', category=RequestsDependencyWarning)
except ImportError:
    pass

# Add parent directory to path to import radio_client
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='IQ Stream Recorder for ka9q_ubersdr',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run GUI mode (default)
  python iq_recorder.py

  # Run CLI mode with scheduled recordings
  python iq_recorder.py --config /path/to/config.json
        """
    )
    parser.add_argument(
        '--config',
        type=str,
        metavar='FILE',
        help='JSON config file (enables CLI mode for scheduled recordings)'
    )

    args = parser.parse_args()

    if args.config:
        # CLI mode - run headless with config file
        from iq_recorder_cli import cli_main
        cli_main(args.config)
    else:
        # GUI mode
        from iq_recorder_gui import main
        main()
