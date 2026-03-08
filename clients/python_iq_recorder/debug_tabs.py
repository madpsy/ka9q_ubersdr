#!/usr/bin/env python3
"""
Debug script to check why tabs aren't showing
Run this and send me the output
"""

print("=" * 70)
print("DEBUG: Checking Tab Integration")
print("=" * 70)

# Step 1: Check imports
print("\n1. Testing imports...")
try:
    from iq_audio_channel import AudioChannel
    print("   ✅ AudioChannel imported")
except Exception as e:
    print(f"   ❌ AudioChannel import failed: {e}")
    exit(1)

try:
    from iq_audio_mixer import AudioChannelMixer
    print("   ✅ AudioChannelMixer imported")
except Exception as e:
    print(f"   ❌ AudioChannelMixer import failed: {e}")
    exit(1)

try:
    from iq_spectrum_display import IQSpectrumDisplay, MULTI_CHANNEL_AVAILABLE
    print(f"   ✅ IQSpectrumDisplay imported")
    print(f"   ✅ MULTI_CHANNEL_AVAILABLE = {MULTI_CHANNEL_AVAILABLE}")
except Exception as e:
    print(f"   ❌ IQSpectrumDisplay import failed: {e}")
    exit(1)

# Step 2: Check if methods exist
print("\n2. Checking if new methods exist...")
import inspect

methods_to_check = [
    '_create_channel_control_widgets',
    '_create_legacy_audio_controls',
    '_refresh_channel_tabs',
    'on_add_channel_clicked'
]

for method_name in methods_to_check:
    if hasattr(IQSpectrumDisplay, method_name):
        print(f"   ✅ {method_name} exists")
    else:
        print(f"   ❌ {method_name} MISSING")

# Step 3: Check create_audio_controls source
print("\n3. Checking create_audio_controls() source...")
source = inspect.getsource(IQSpectrumDisplay.create_audio_controls)
if 'tab_bar_frame' in source:
    print("   ✅ tab_bar_frame found in create_audio_controls()")
else:
    print("   ❌ tab_bar_frame NOT found - using old code!")
    print("\n   First 300 chars of method:")
    print("   " + source[:300].replace('\n', '\n   '))

if 'DEBUG: create_audio_controls() called' in source:
    print("   ✅ Debug logging present")
else:
    print("   ⚠️  Debug logging not present")

# Step 4: Simulate initialization (without GUI)
print("\n4. Simulating initialization...")
print("   Creating AudioChannelMixer...")
try:
    mixer = AudioChannelMixer(
        sample_rate=48000,
        center_freq=14074000,
        audio_sample_rate=48000
    )
    print(f"   ✅ AudioChannelMixer created: {mixer}")
    
    channel = mixer.add_channel(name="Test Channel")
    if channel:
        print(f"   ✅ Channel created: {channel.name} (ID: {channel.channel_id})")
    else:
        print("   ❌ Channel creation returned None")
except Exception as e:
    print(f"   ❌ AudioChannelMixer creation failed: {e}")
    import traceback
    traceback.print_exc()

print("\n" + "=" * 70)
print("INSTRUCTIONS:")
print("=" * 70)
print("Now run your application and look for these debug messages:")
print("  - 'DEBUG: Attempting to initialize AudioChannelMixer...'")
print("  - 'DEBUG: create_audio_controls() called'")
print("  - 'DEBUG: MULTI_CHANNEL_AVAILABLE = ...'")
print("  - 'DEBUG: self.audio_mixer = ...'")
print("")
print("If you see '⚠️  Falling back to legacy single-channel UI',")
print("that's why you don't see tabs!")
print("")
print("Send me the console output from your application.")
print("=" * 70)
