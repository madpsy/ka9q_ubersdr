#!/usr/bin/env python3
"""
Verify squelch tag values from ka9q-radio status.h
This script parses the enum status_type to find the correct tag numbers
"""

import re
import sys

def parse_status_enum(status_h_path):
    """Parse the status.h file to extract enum values"""
    
    with open(status_h_path, 'r') as f:
        content = f.read()
    
    # Find the enum status_type definition
    enum_match = re.search(r'enum\s+status_type\s*\{([^}]+)\}', content, re.DOTALL)
    if not enum_match:
        print("ERROR: Could not find enum status_type in status.h")
        return None
    
    enum_content = enum_match.group(1)
    
    # Parse enum entries
    entries = {}
    current_value = 0
    
    for line in enum_content.split('\n'):
        line = line.strip()
        if not line or line.startswith('//') or line.startswith('/*'):
            continue
        
        # Remove trailing comma and comments
        line = re.sub(r'//.*$', '', line)
        line = re.sub(r'/\*.*?\*/', '', line)
        line = line.rstrip(',').strip()
        
        if not line:
            continue
        
        # Check if it has an explicit value
        if '=' in line:
            parts = line.split('=')
            name = parts[0].strip()
            value_str = parts[1].strip()
            
            # Handle hex values
            if value_str.startswith('0x'):
                current_value = int(value_str, 16)
            else:
                try:
                    current_value = int(value_str)
                except ValueError:
                    # Might be a reference to another enum value
                    print(f"Warning: Could not parse value for {name}: {value_str}")
                    continue
            
            entries[name] = current_value
            current_value += 1
        else:
            # No explicit value, use current_value
            name = line
            entries[name] = current_value
            current_value += 1
    
    return entries

def main():
    status_h_path = '../ka9q-radio/src/status.h'
    
    print("Parsing status.h to find squelch tag values...")
    print(f"File: {status_h_path}\n")
    
    entries = parse_status_enum(status_h_path)
    if not entries:
        sys.exit(1)
    
    # Find squelch-related entries
    squelch_entries = {k: v for k, v in entries.items() if 'SQUELCH' in k}
    
    print("Squelch-related enum values:")
    print("-" * 50)
    for name, value in sorted(squelch_entries.items(), key=lambda x: x[1]):
        print(f"{name:30s} = {value:3d} (0x{value:02x})")
    
    print("\n" + "=" * 50)
    print("VERIFICATION:")
    print("=" * 50)
    
    if 'SQUELCH_OPEN' in entries and 'SQUELCH_CLOSE' in entries:
        squelch_open = entries['SQUELCH_OPEN']
        squelch_close = entries['SQUELCH_CLOSE']
        
        print(f"\nSQUELCH_OPEN  = {squelch_open} (0x{squelch_open:02x})")
        print(f"SQUELCH_CLOSE = {squelch_close} (0x{squelch_close:02x})")
        
        print("\nCurrent values in radiod.go:")
        print("  SQUELCH_OPEN  = 0x53 (83)")
        print("  SQUELCH_CLOSE = 0x54 (84)")
        
        if squelch_open == 0x53 and squelch_close == 0x54:
            print("\n✅ Tag values are CORRECT!")
        else:
            print("\n❌ Tag values are WRONG!")
            print(f"\nShould be:")
            print(f"  SQUELCH_OPEN  = 0x{squelch_open:02x} ({squelch_open})")
            print(f"  SQUELCH_CLOSE = 0x{squelch_close:02x} ({squelch_close})")
    else:
        print("\n❌ Could not find SQUELCH_OPEN or SQUELCH_CLOSE in enum")
    
    # Also show some reference values we know are correct
    print("\n" + "=" * 50)
    print("REFERENCE VALUES (for verification):")
    print("=" * 50)
    if 'LOW_EDGE' in entries and 'HIGH_EDGE' in entries:
        print(f"LOW_EDGE  = {entries['LOW_EDGE']} (0x{entries['LOW_EDGE']:02x}) - should be 0x27 (39)")
        print(f"HIGH_EDGE = {entries['HIGH_EDGE']} (0x{entries['HIGH_EDGE']:02x}) - should be 0x28 (40)")

if __name__ == '__main__':
    main()