#!/usr/bin/env python3
"""
Diagnostic script to test multi-channel audio initialization
"""

import sys
import traceback

print("=" * 70)
print("Multi-Channel Audio Diagnostic Test")
print("=" * 70)

# Test 1: Check if files exist
print("\n1. Checking if required files exist...")
import os
files_to_check = [
    'iq_audio_channel.py',
    'iq_audio_mixer.py',
    'iq_spectrum_display.py'
]
for filename in files_to_check:
    exists = os.path.exists(filename)
    status = '✅' if exists else '❌'
    print(f"   {status} {filename}")

# Test 2: Try importing AudioChannel
print("\n2. Testing AudioChannel import...")
try:
    from iq_audio_channel import AudioChannel
    print("   ✅ AudioChannel imported successfully")
except Exception as e:
    print(f"   ❌ AudioChannel import failed:")
    print(f"      {e}")
    traceback.print_exc()
    sys.exit(1)

# Test 3: Try importing AudioChannelMixer
print("\n3. Testing AudioChannelMixer import...")
try:
    from iq_audio_mixer import AudioChannelMixer
    print("   ✅ AudioChannelMixer imported successfully")
except Exception as e:
    print(f"   ❌ AudioChannelMixer import failed:")
    print(f"      {e}")
    traceback.print_exc()
    sys.exit(1)

# Test 4: Try creating AudioChannelMixer instance
print("\n4. Testing AudioChannelMixer instantiation...")
try:
    mixer = AudioChannelMixer(
        sample_rate=48000,
        center_freq=14074000,
        audio_sample_rate=48000
    )
    print("   ✅ AudioChannelMixer created successfully")
except Exception as e:
    print(f"   ❌ AudioChannelMixer creation failed:")
    print(f"      {e}")
    traceback.print_exc()
    sys.exit(1)

# Test 5: Try adding a channel
print("\n5. Testing channel creation...")
try:
    channel = mixer.add_channel(name="Test Channel")
    if channel:
        print(f"   ✅ Channel created: {channel.name} (ID: {channel.channel_id})")
    else:
        print("   ❌ Channel creation returned None")
except Exception as e:
    print(f"   ❌ Channel creation failed:")
    print(f"      {e}")
    traceback.print_exc()
    sys.exit(1)

# Test 6: Check MULTI_CHANNEL_AVAILABLE flag
print("\n6. Checking MULTI_CHANNEL_AVAILABLE flag in iq_spectrum_display.py...")
try:
    with open('iq_spectrum_display.py', 'r') as f:
        content = f.read()
    
    import re
    match = re.search(r'MULTI_CHANNEL_AVAILABLE\s*=\s*(\w+)', content)
    if match:
        value = match.group(1)
        if value == 'True':
            print(f"   ✅ MULTI_CHANNEL_AVAILABLE = {value}")
        else:
            print(f"   ⚠️  MULTI_CHANNEL_AVAILABLE = {value} (should be True)")
    else:
        print("   ❌ MULTI_CHANNEL_AVAILABLE not found in file")
except Exception as e:
    print(f"   ❌ Error checking flag: {e}")

# Test 7: Check if tabbed UI code is present
print("\n7. Checking if tabbed UI code is integrated...")
try:
    with open('iq_spectrum_display.py', 'r') as f:
        content = f.read()
    
    checks = {
        'tab_bar_frame': 'tab_bar_frame = ttk.Frame' in content,
        'tab_buttons_frame': 'self.tab_buttons_frame' in content,
        'add_channel_button': 'self.add_channel_button' in content,
        '_create_channel_control_widgets': 'def _create_channel_control_widgets' in content,
        '_refresh_channel_tabs': 'def _refresh_channel_tabs' in content,
    }
    
    all_present = all(checks.values())
    for check_name, present in checks.items():
        status = '✅' if present else '❌'
        print(f"   {status} {check_name}")
    
    if all_present:
        print("\n   ✅ All tabbed UI components are present")
    else:
        print("\n   ❌ Some tabbed UI components are missing")
except Exception as e:
    print(f"   ❌ Error checking UI code: {e}")

# Test 8: Simulate what happens in __init__
print("\n8. Simulating IQSpectrumDisplay initialization...")
try:
    MULTI_CHANNEL_AVAILABLE = True
    
    if MULTI_CHANNEL_AVAILABLE:
        try:
            audio_mixer = AudioChannelMixer(
                sample_rate=48000,
                center_freq=14074000,
                audio_sample_rate=48000
            )
            default_channel = audio_mixer.add_channel(name="Channel 1")
            if default_channel:
                print(f"   ✅ Multi-channel audio initialized with default channel")
                print(f"      Channel ID: {default_channel.channel_id}")
                print(f"      Channel Name: {default_channel.name}")
                print(f"      Total channels: {audio_mixer.get_channel_count()}")
            else:
                print("   ❌ Default channel creation returned None")
        except Exception as e:
            print(f"   ❌ Initialization failed (this is why tabs don't show):")
            print(f"      {e}")
            traceback.print_exc()
            audio_mixer = None
    
    if audio_mixer is None:
        print("\n   ⚠️  audio_mixer is None - this causes fallback to legacy UI!")
        print("      This is why you don't see tabs!")
except Exception as e:
    print(f"   ❌ Simulation failed: {e}")
    traceback.print_exc()

print("\n" + "=" * 70)
print("Diagnostic test complete!")
print("=" * 70)
print("\nIf all tests pass, the multi-channel system should work.")
print("If you still don't see tabs, check the console output when running")
print("the application for error messages during initialization.")
print("=" * 70)
