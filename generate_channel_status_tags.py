#!/usr/bin/env python3
"""
Extract status tag enums from ka9q-radio status.h and verify against radiod_status.go
Generates Go constants for audio channel status tags
"""

import re
import sys
from pathlib import Path

def parse_status_h(filepath):
    """Parse status.h and extract enum status_type values"""
    with open(filepath, 'r') as f:
        content = f.read()
    
    # Find the enum status_type block
    enum_match = re.search(r'enum status_type\s*\{([^}]+)\}', content, re.DOTALL)
    if not enum_match:
        print("ERROR: Could not find enum status_type in status.h")
        sys.exit(1)
    
    enum_content = enum_match.group(1)
    
    # Parse enum entries
    tags = {}
    current_value = 0
    
    for line in enum_content.split('\n'):
        line = line.strip()
        if not line or line.startswith('//'):
            continue
        
        # Remove trailing comma and comments
        line = re.sub(r',?\s*//.*$', '', line)
        line = line.rstrip(',').strip()
        
        if not line:
            continue
        
        # Check if explicit value is assigned
        if '=' in line:
            name, value = line.split('=', 1)
            name = name.strip()
            value = value.strip()
            try:
                current_value = int(value)
            except ValueError:
                print(f"WARNING: Could not parse value for {name}: {value}")
                continue
        else:
            name = line
        
        tags[name] = current_value
        current_value += 1
    
    return tags

def parse_radiod_status_go(filepath):
    """Parse radiod_status.go and extract existing tag constants"""
    with open(filepath, 'r') as f:
        content = f.read()
    
    # Find tag constants
    existing_tags = {}
    
    # Match lines like: tagInputSamprate = 10 // INPUT_SAMPRATE
    pattern = r'tag(\w+)\s*=\s*(\d+)\s*(?://\s*(\w+))?'
    
    for match in re.finditer(pattern, content):
        go_name = match.group(1)
        value = int(match.group(2))
        c_name = match.group(3) if match.group(3) else None
        existing_tags[go_name] = {'value': value, 'c_name': c_name}
    
    return existing_tags

def verify_existing_tags(status_h_tags, go_tags):
    """Verify that existing Go tags match status.h"""
    print("=" * 80)
    print("VERIFICATION: Checking existing tags in radiod_status.go")
    print("=" * 80)
    
    all_match = True
    
    for go_name, go_data in go_tags.items():
        c_name = go_data['c_name']
        go_value = go_data['value']
        
        if c_name and c_name in status_h_tags:
            h_value = status_h_tags[c_name]
            if h_value == go_value:
                print(f"✓ tag{go_name} = {go_value} matches {c_name}")
            else:
                print(f"✗ tag{go_name} = {go_value} MISMATCH! {c_name} should be {h_value}")
                all_match = False
        else:
            print(f"? tag{go_name} = {go_value} (no C name or not found in status.h)")
    
    print()
    if all_match:
        print("✓ All existing tags verified successfully!")
    else:
        print("✗ Some tags have mismatches!")
    print()
    
    return all_match

def categorize_tags(tags):
    """Categorize tags into frontend vs channel tags"""
    # Frontend-only tags (already in radiod_status.go)
    frontend_tags = {
        'INPUT_SAMPRATE', 'INPUT_SAMPLES', 'LNA_GAIN', 'MIXER_GAIN', 'IF_GAIN',
        'IF_POWER', 'RF_ATTEN', 'RF_GAIN', 'RF_AGC', 'AD_OVER', 'SAMPLES_SINCE_OVER',
        'DESCRIPTION', 'STATUS_DEST_SOCKET', 'FIRST_LO_FREQUENCY',
        'FILTER_BLOCKSIZE', 'FILTER_FIR_LENGTH', 'FE_LOW_EDGE', 'FE_HIGH_EDGE',
        'FE_ISREAL', 'AD_BITS_PER_SAMPLE', 'RF_LEVEL_CAL', 'GAINSTEP',
        'DC_I_OFFSET', 'DC_Q_OFFSET', 'IQ_IMBALANCE', 'IQ_PHASE', 'DIRECT_CONVERSION',
        'CALIBRATE', 'CONVERTER_OFFSET'
    }
    
    # Tags that apply to audio channels
    channel_tags = {}
    
    for name, value in tags.items():
        if name.startswith('UNUSED') or name == 'EOL':
            continue
        if name not in frontend_tags:
            channel_tags[name] = value
    
    return channel_tags

def to_go_const_name(c_name):
    """Convert C enum name to Go constant name"""
    # Convert UPPER_CASE to CamelCase
    parts = c_name.split('_')
    camel = ''.join(word.capitalize() for word in parts)
    return f"tag{camel}"

def generate_go_constants(channel_tags):
    """Generate Go constant definitions for channel tags"""
    print("=" * 80)
    print("GENERATED GO CONSTANTS FOR AUDIO CHANNEL STATUS")
    print("=" * 80)
    print()
    print("// Audio channel status tag numbers from ka9q-radio/src/status.h")
    print("// These tags are used for per-channel audio status updates")
    print("const (")
    
    # Sort by value
    sorted_tags = sorted(channel_tags.items(), key=lambda x: x[1])
    
    for name, value in sorted_tags:
        go_name = to_go_const_name(name)
        print(f"\t{go_name:30s} = {value:3d}  // {name}")
    
    print(")")
    print()

def main():
    # Paths
    status_h_path = Path("/home/nathan/repos/ka9q-radio/src/status.h")
    radiod_status_go_path = Path("radiod_status.go")
    
    if not status_h_path.exists():
        print(f"ERROR: {status_h_path} not found")
        sys.exit(1)
    
    if not radiod_status_go_path.exists():
        print(f"ERROR: {radiod_status_go_path} not found")
        sys.exit(1)
    
    # Parse files
    print("Parsing status.h...")
    status_h_tags = parse_status_h(status_h_path)
    print(f"Found {len(status_h_tags)} tags in status.h")
    print()
    
    print("Parsing radiod_status.go...")
    go_tags = parse_radiod_status_go(radiod_status_go_path)
    print(f"Found {len(go_tags)} existing tags in radiod_status.go")
    print()
    
    # Verify existing tags
    verify_existing_tags(status_h_tags, go_tags)
    
    # Categorize and generate channel tags
    channel_tags = categorize_tags(status_h_tags)
    print(f"Found {len(channel_tags)} audio channel tags (excluding frontend-only tags)")
    print()
    
    generate_go_constants(channel_tags)
    
    # Summary
    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"Total tags in status.h:        {len(status_h_tags)}")
    print(f"Existing tags in Go:           {len(go_tags)}")
    print(f"New channel tags to add:       {len(channel_tags)}")
    print()
    print("Copy the generated constants above and add them to radiod_status.go")
    print("after the existing frontend tag constants.")

if __name__ == '__main__':
    main()
