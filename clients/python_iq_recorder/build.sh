#!/bin/bash
# Build script for IQ Stream Recorder
# Creates a standalone executable using PyInstaller

set -e  # Exit on error

echo "=========================================="
echo "IQ Stream Recorder - Build Script"
echo "=========================================="
echo ""

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Error: Virtual environment not found!"
    echo "Please run: python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Check if PyInstaller is installed
if ! command -v pyinstaller &> /dev/null; then
    echo "PyInstaller not found. Installing..."
    pip install pyinstaller
fi

# Clean previous builds
echo ""
echo "Cleaning previous builds..."
rm -rf build dist

# Run PyInstaller
echo ""
echo "Building executable with PyInstaller..."
pyinstaller iq_recorder.spec

# Check if build was successful
if [ -f "dist/iq_recorder/iq_recorder" ]; then
    echo ""
    echo "=========================================="
    echo "Build successful!"
    echo "=========================================="
    echo ""
    echo "Executable location: dist/iq_recorder/iq_recorder"
    echo ""
    echo "To run the application:"
    echo "  ./dist/iq_recorder/iq_recorder"
    echo ""
    echo "To create a distributable package:"
    echo "  cd dist"
    echo "  tar -czf iq_recorder-linux-x64.tar.gz iq_recorder/"
    echo ""
else
    echo ""
    echo "=========================================="
    echo "Build failed!"
    echo "=========================================="
    echo ""
    echo "Please check the error messages above."
    exit 1
fi
