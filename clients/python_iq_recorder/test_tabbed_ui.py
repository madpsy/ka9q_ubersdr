#!/usr/bin/env python3
"""
Simple test to verify the tabbed UI is working
Run this to see the multi-channel tabbed interface
"""

import tkinter as tk
from tkinter import ttk
import sys

# Import the spectrum display
from iq_spectrum_display import IQSpectrumDisplay

def main():
    print("=" * 70)
    print("Multi-Channel Tabbed UI Test")
    print("=" * 70)
    print("\nThis will open a window showing the IQ Spectrum Display")
    print("with the multi-channel tabbed interface.")
    print("\nYou should see:")
    print("  - A tab bar at the bottom with 'Channel 1' tab")
    print("  - An '+ Add Channel' button on the right")
    print("  - Channel controls below the tabs")
    print("=" * 70)
    
    # Create main window
    root = tk.Tk()
    root.title("Multi-Channel Tabbed UI Test")
    root.geometry("960x500")
    
    # Create info label
    info_frame = ttk.Frame(root)
    info_frame.pack(side=tk.TOP, fill=tk.X, padx=10, pady=5)
    
    info_label = ttk.Label(
        info_frame,
        text="✅ Multi-Channel Tabbed UI Test - Look for tabs at the bottom!",
        font=("Arial", 12, "bold"),
        foreground="green"
    )
    info_label.pack()
    
    instructions = ttk.Label(
        info_frame,
        text="Click '+ Add Channel' to add more channels. Click tab 'X' to remove channels.",
        font=("Arial", 9)
    )
    instructions.pack()
    
    # Create spectrum display
    try:
        spectrum = IQSpectrumDisplay(
            root,
            width=960,
            height=400,
            sample_rate=48000,
            center_freq=14074000  # 20m FT8
        )
        
        print("\n✅ IQSpectrumDisplay created successfully!")
        print(f"   Audio mixer: {spectrum.audio_mixer}")
        
        if spectrum.audio_mixer:
            print(f"   Channel count: {spectrum.audio_mixer.get_channel_count()}")
            print(f"   Active channel ID: {spectrum.active_channel_id}")
            print("\n✅ Multi-channel mode is ACTIVE!")
            print("   You should see tabs at the bottom of the window.")
        else:
            print("\n⚠️  Audio mixer is None - using legacy single-channel mode")
            print("   This means tabs won't be visible.")
        
    except Exception as e:
        print(f"\n❌ Error creating spectrum display: {e}")
        import traceback
        traceback.print_exc()
        return
    
    print("\n" + "=" * 70)
    print("Window is now open. Check for tabs at the bottom!")
    print("Close the window to exit.")
    print("=" * 70)
    
    # Run the GUI
    root.mainloop()

if __name__ == "__main__":
    main()
