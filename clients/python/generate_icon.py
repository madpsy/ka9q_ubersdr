#!/usr/bin/env python3
"""
Generate ubersdr.ico from ubersdr.png with proper transparency support.

This script creates a multi-resolution ICO file with alpha channel transparency
that will display correctly on Windows desktop.

Usage:
    python generate_icon.py
"""

import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow library is required.")
    print("Install it with: pip install Pillow")
    sys.exit(1)


def generate_icon():
    """Generate ubersdr.ico from ubersdr.png with transparency."""
    
    # Get the directory where this script is located
    script_dir = Path(__file__).parent
    
    # Define input and output paths
    png_path = script_dir / "ubersdr.png"
    ico_path = script_dir / "ubersdr.ico"
    
    # Check if source PNG exists
    if not png_path.exists():
        print(f"Error: Source file not found: {png_path}")
        print("Please ensure ubersdr.png exists in the same directory as this script.")
        sys.exit(1)
    
    print(f"Loading PNG from: {png_path}")
    
    try:
        # Load the PNG image
        img = Image.open(png_path)
        
        # Display current image info
        print(f"  Original size: {img.size}")
        print(f"  Original mode: {img.mode}")
        
        # Convert to RGBA if not already (ensures alpha channel)
        if img.mode != 'RGBA':
            print(f"  Converting from {img.mode} to RGBA...")
            img = img.convert('RGBA')
        
        # Define icon sizes (Windows standard sizes)
        sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
        
        print(f"\nGenerating ICO with sizes: {', '.join(f'{w}x{h}' for w, h in sizes)}")
        
        # Save as ICO with multiple resolutions
        img.save(
            ico_path,
            format='ICO',
            sizes=sizes
        )
        
        print(f"\n✓ Successfully created: {ico_path}")
        
        # Verify the generated ICO
        print("\nVerifying generated ICO file...")
        ico = Image.open(ico_path)
        print(f"  ICO mode: {ico.mode}")
        print(f"  ICO size: {ico.size}")
        
        if ico.mode == 'RGBA':
            print("  ✓ Alpha channel present - transparency supported!")
        else:
            print(f"  ⚠ Warning: ICO mode is {ico.mode}, expected RGBA")
        
        return True
        
    except Exception as e:
        print(f"\n✗ Error generating icon: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    print("=" * 60)
    print("UberSDR Icon Generator")
    print("=" * 60)
    print()
    
    success = generate_icon()
    
    print()
    print("=" * 60)
    
    if success:
        print("Icon generation completed successfully!")
        print("\nThe generated ubersdr.ico file has:")
        print("  • Multiple resolutions (256x256 down to 16x16)")
        print("  • Alpha channel transparency (RGBA)")
        print("  • Proper ICO format for Windows")
        sys.exit(0)
    else:
        print("Icon generation failed. Please check the errors above.")
        sys.exit(1)