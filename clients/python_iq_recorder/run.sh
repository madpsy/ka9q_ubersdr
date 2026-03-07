#!/bin/bash
# Quick start script for IQ Stream Recorder

cd "$(dirname "$0")"

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "Virtual environment not found. Creating..."
    python3 -m venv venv
    echo "Installing dependencies..."
    ./venv/bin/pip install -r requirements.txt
fi

# Run the application
./venv/bin/python iq_recorder.py
