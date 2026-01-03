#!/usr/bin/env python3
"""
Parse ka9q-radio status.h enum and generate Go constants
"""

import re
import sys

def parse_status_h(filepath):
    """Parse status.h and extract enum status_type values"""
    with open(filepath, 'r') as f:
        content = f.read()
    
    # Find the enum status_type block
    enum_match = re.search(r'enum status_type\s*{([^}]+)}', content, re.DOTALL)
    if not enum_match:
        print("ERROR: Could not find enum status_type", file=sys.stderr)
        return None
    
    enum_body = enum_match.group(1)
    
    # Parse enum entries
    entries = []
    current_value = 0
    
    for line in enum_body.split('\n'):
        # Remove comments
        line = re.sub(r'//.*$', '', line)
        line = re.sub(r'/\*.*?\*/', '', line)
        line = line.strip()
        
        if not line or line == ',':
            continue
        
        # Remove trailing comma
        line = line.rstrip(',')
        
        # Check for explicit value assignment
        if '=' in line:
            parts = line.split('=')
            name = parts[0].strip()
            value_str = parts[1].strip()
            try:
                current_value = int(value_str, 0)  # Support hex/octal/decimal
            except ValueError:
                print(f"WARNING: Could not parse value for {name}: {value_str}", file=sys.stderr)
                continue
            entries.append((name, current_value))
            current_value += 1
        else:
            # No explicit value, use current_value
            name = line.strip()
            if name:
                entries.append((name, current_value))
                current_value += 1
    
    return entries

def generate_go_constants(entries, tags_to_include):
    """Generate Go constant declarations for specified tags"""
    print("// Status tag numbers from ka9q-radio/src/status.h enum status_type")
    print("const (")
    
    for name, value in entries:
        if name in tags_to_include:
            # Convert C name to Go camelCase
            go_name = 'tag' + ''.join(word.capitalize() for word in name.split('_'))
            # Add comment with original C name
            print(f"\t{go_name:<20} = {value:<3} // {name}")
    
    print(")")

def main():
    status_h_path = '/home/nathan/repos/ka9q-radio/src/status.h'
    
    # Parse the enum
    entries = parse_status_h(status_h_path)
    if not entries:
        sys.exit(1)
    
    # Tags we need for radiod_status.go
    tags_needed = [
        'EOL',
        'COMMAND_TAG',
        'OUTPUT_SSRC',
        'LNA_GAIN',
        'MIXER_GAIN',
        'IF_GAIN',
        'IF_POWER',
        'RF_ATTEN',
        'RF_GAIN',
        'RF_AGC',
        'AD_OVER',
        'SAMPLES_SINCE_OVER',
    ]
    
    print("# Parsed enum values:")
    print("# " + "="*60)
    for name, value in entries:
        if name in tags_needed:
            print(f"# {name:<30} = {value}")
    print("# " + "="*60)
    print()
    
    # Generate Go constants
    generate_go_constants(entries, tags_needed)

if __name__ == '__main__':
    main()
