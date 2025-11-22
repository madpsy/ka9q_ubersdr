#!/usr/bin/env python3
"""
RBN Calibrate - Compare frequency differences between local Skimmer Server and RBN

This script connects to both a local Skimmer Server and the Reverse Beacon Network (RBN),
collects spots from both sources, and compares the reported frequencies for the same
callsigns at the same time to identify frequency calibration differences.
"""

import telnetlib
import argparse
import sys
import re
from datetime import datetime
from collections import defaultdict
import threading
import time
import statistics


# Amateur radio band definitions (frequency in kHz)
AMATEUR_BANDS = {
    '160m': (1800, 2000),
    '80m': (3500, 4000),
    '60m': (5250, 5450),
    '40m': (7000, 7300),
    '30m': (10100, 10150),
    '20m': (14000, 14350),
    '17m': (18068, 18168),
    '15m': (21000, 21450),
    '12m': (24890, 24990),
    '10m': (28000, 29700),
}


def get_band(frequency_khz):
    """
    Determine the amateur radio band for a given frequency
    
    Args:
        frequency_khz: Frequency in kHz
        
    Returns:
        str: Band name (e.g., '20m') or 'Unknown'
    """
    for band_name, (low, high) in AMATEUR_BANDS.items():
        if low <= frequency_khz <= high:
            return band_name
    return 'Unknown'


class SpotParser:
    """Parse DX spot lines from Skimmer/RBN telnet streams"""
    
    # DX de LZ7AA-#:    7028.2  RK3LC          CW    11 dB  35 WPM  CQ      0710Z
    # DX de MM3NDH-#:  14029.1  UX5VK          11 dB  19 WPM                0727Z
    SPOT_PATTERN = re.compile(
        r'^DX de\s+(\S+?)-#:\s+(\d+\.\d+)\s+(\S+)\s+(?:(\S+)\s+)?(-?\d+)\s+dB\s+(\d+)\s+WPM\s+(\S*)\s+(\d{4})Z'
    )
    
    @staticmethod
    def parse_spot(line):
        """
        Parse a spot line and return a dictionary with spot details
        
        Returns:
            dict or None: Spot details if valid, None otherwise
        """
        match = SpotParser.SPOT_PATTERN.match(line.strip())
        if not match:
            return None
        
        spotter, freq, callsign, mode, snr, wpm, spot_type, time_str = match.groups()
        
        return {
            'spotter': spotter,
            'frequency': float(freq),
            'callsign': callsign,
            'mode': mode if mode else 'CW',  # Default to CW if not specified
            'snr': int(snr),
            'wpm': int(wpm),
            'type': spot_type if spot_type else '',
            'time': time_str
        }


class TelnetConnection:
    """Manage a telnet connection to a Skimmer/RBN server"""
    
    def __init__(self, name, host, port, callsign):
        self.name = name
        self.host = host
        self.port = port
        self.callsign = callsign
        self.tn = None
        self.running = False
        self.spots = []
        self.thread = None
        
    def connect(self):
        """Connect to the telnet server and login"""
        try:
            print(f"[{self.name}] Connecting to {self.host}:{self.port}...")
            self.tn = telnetlib.Telnet(self.host, self.port, timeout=10)
            
            # Wait for login prompt - read until we see the colon at the end
            # RBN: "Please enter your call: "
            # Local: "Please enter your callsign:"
            prompt = self.tn.read_until(b":", timeout=5).decode('ascii', errors='ignore')
            print(f"[{self.name}] Prompt: {prompt.strip()}")
            
            # Send callsign
            self.tn.write(self.callsign.encode('ascii') + b'\n')
            
            # Read response after login
            # RBN: "Hello, MM3NDH! Connected."
            # Local: "MM3NDH de SKIMMER 2025-11-22 07:13Z CwSkimmer >"
            response = self.tn.read_until(b'\n', timeout=5).decode('ascii', errors='ignore')
            print(f"[{self.name}] Response: {response.strip()}")
            
            # For local server, there may be an additional prompt line
            if self.name == 'LOCAL' and '>' in response:
                # Prompt is on same line, we're good
                pass
            elif self.name == 'LOCAL':
                # Read the prompt line
                prompt_line = self.tn.read_until(b'>', timeout=2).decode('ascii', errors='ignore')
                print(f"[{self.name}] Prompt line: {prompt_line.strip()}")
            
            return True
        except Exception as e:
            print(f"[{self.name}] Connection failed: {e}", file=sys.stderr)
            return False
    
    def read_spots(self):
        """Read spots from the telnet connection in a loop"""
        self.running = True
        print(f"[{self.name}] Starting to read spots...")
        
        while self.running:
            try:
                line = self.tn.read_until(b'\n', timeout=1).decode('ascii', errors='ignore')
                if not line:
                    continue
                
                # Strip whitespace and skip empty lines
                line = line.strip()
                if not line:
                    continue
                
                spot = SpotParser.parse_spot(line)
                if spot:
                    spot['source'] = self.name
                    spot['timestamp'] = datetime.utcnow()
                    self.spots.append(spot)
                    print(f"[{self.name}] {spot['callsign']:10s} {spot['frequency']:8.1f} kHz  {spot['time']}")
                elif line.startswith('DX de'):
                    # Debug: show lines that start with DX de but don't parse
                    print(f"[{self.name}] DEBUG - Failed to parse: {line}")
                    
            except EOFError:
                print(f"[{self.name}] Connection closed by server", file=sys.stderr)
                break
            except Exception as e:
                if self.running:
                    print(f"[{self.name}] Error reading: {e}", file=sys.stderr)
                break
        
        print(f"[{self.name}] Stopped reading spots")
    
    def start(self):
        """Start reading spots in a background thread"""
        self.thread = threading.Thread(target=self.read_spots, daemon=True)
        self.thread.start()
    
    def stop(self):
        """Stop reading spots and close connection"""
        self.running = False
        if self.tn:
            try:
                self.tn.close()
            except:
                pass
        if self.thread:
            self.thread.join(timeout=2)


class FrequencyComparator:
    """Compare frequencies between local and RBN spots"""
    
    def __init__(self, local_spots, rbn_spots, time_window=60):
        """
        Initialize comparator
        
        Args:
            local_spots: List of spots from local server
            rbn_spots: List of spots from RBN
            time_window: Time window in seconds to consider spots as matching
        """
        self.local_spots = local_spots
        self.rbn_spots = rbn_spots
        self.time_window = time_window
        
    def find_matches(self):
        """
        Find matching spots between local and RBN
        
        Returns:
            list: List of tuples (local_spot, rbn_spot, freq_diff)
        """
        matches = []
        
        # Group RBN spots by callsign and time for faster lookup
        rbn_by_call_time = defaultdict(list)
        for spot in self.rbn_spots:
            key = (spot['callsign'], spot['time'])
            rbn_by_call_time[key].append(spot)
        
        # Find matching local spots
        for local_spot in self.local_spots:
            key = (local_spot['callsign'], local_spot['time'])
            
            if key in rbn_by_call_time:
                local_band = get_band(local_spot['frequency'])
                
                for rbn_spot in rbn_by_call_time[key]:
                    # Check if timestamps are within window
                    time_diff = abs((local_spot['timestamp'] - rbn_spot['timestamp']).total_seconds())
                    
                    if time_diff <= self.time_window:
                        # Verify both spots are on the same band
                        rbn_band = get_band(rbn_spot['frequency'])
                        
                        # Only use spots above 7 MHz for calibration (avoid propagation effects)
                        if (local_band == rbn_band and local_band != 'Unknown' and
                            local_spot['frequency'] >= 7000):
                            freq_diff = local_spot['frequency'] - rbn_spot['frequency']
                            matches.append((local_spot, rbn_spot, freq_diff))
        
        return matches
    
    def print_comparison(self):
        """Print comparison results"""
        matches = self.find_matches()
        
        if not matches:
            print("\nNo matching spots found between local and RBN")
            print("Note: Only spots above 7 MHz are used for calibration to avoid propagation effects.")
            return
        
        # Count unique remote spotters
        unique_spotters = set(rbn_spot['spotter'] for _, rbn_spot, _ in matches)
        if len(unique_spotters) < 5:
            print(f"\nInsufficient data: Only {len(unique_spotters)} unique remote spotters found.")
            print("At least 5 different remote spotters are required for valid comparison.")
            print(f"Unique spotters found: {', '.join(sorted(unique_spotters))}")
            print("Note: Only spots above 7 MHz are used for calibration to avoid propagation effects.")
            return
        
        print(f"\nNote: Using only spots above 7 MHz for calibration (avoiding 160m and 80m)")
        
        print(f"\n{'='*100}")
        print(f"FREQUENCY COMPARISON RESULTS ({len(matches)} matches)")
        print(f"{'='*100}")
        print(f"{'Callsign':<10} {'Band':<6} {'Time':<6} {'Local kHz':>10} {'RBN kHz':>10} {'Diff Hz':>10} {'Local SNR':>10} {'RBN SNR':>10}")
        print(f"{'-'*100}")
        
        total_diff = 0
        band_diffs = defaultdict(list)
        band_freqs = defaultdict(list)  # Store frequencies for PPM calculation
        callsign_band_diffs = defaultdict(lambda: defaultdict(list))
        callsign_band_freqs = defaultdict(lambda: defaultdict(list))
        
        for local_spot, rbn_spot, freq_diff in matches:
            freq_diff_hz = freq_diff * 1000  # Convert kHz to Hz
            total_diff += freq_diff_hz
            
            band = get_band(local_spot['frequency'])
            band_diffs[band].append(freq_diff_hz)
            band_freqs[band].append(local_spot['frequency'])
            callsign_band_diffs[local_spot['callsign']][band].append(freq_diff_hz)
            callsign_band_freqs[local_spot['callsign']][band].append(local_spot['frequency'])
            
            print(f"{local_spot['callsign']:<10} {band:<6} {local_spot['time']:<6} "
                  f"{local_spot['frequency']:>10.1f} {rbn_spot['frequency']:>10.1f} "
                  f"{freq_diff_hz:>+10.1f} {local_spot['snr']:>10d} {rbn_spot['snr']:>10d}")
        
        print(f"{'-'*100}")
        print(f"Total matches: {len(matches)} from {len(unique_spotters)} unique remote spotters")
        print(f"{'='*100}\n")
        
        # Per-band statistics
        if band_diffs:
            print(f"\n{'='*90}")
            print(f"PER-BAND STATISTICS")
            print(f"{'='*90}")
            print(f"{'Band':<10} {'Matches':>10} {'Avg Diff Hz':>15} {'Std Dev Hz':>15} {'PPM':>10} {'Adjustment':>15}")
            print(f"{'-'*90}")
            
            for band in sorted(band_diffs.keys(), key=lambda b: AMATEUR_BANDS.get(b, (0, 0))[0] if b != 'Unknown' else 999999):
                diffs = band_diffs[band]
                freqs = band_freqs[band]
                avg_diff = statistics.mean(diffs)
                std_dev = statistics.stdev(diffs) if len(diffs) > 1 else 0.0
                
                # Calculate PPM using average frequency
                avg_freq_khz = statistics.mean(freqs)
                avg_freq_hz = avg_freq_khz * 1000
                ppm = (avg_diff / avg_freq_hz) * 1e6
                adjustment = 1.0 + (ppm / 1e6)
                
                print(f"{band:<10} {len(diffs):>10} {avg_diff:>+15.1f} {std_dev:>15.1f} {ppm:>+10.1f} {adjustment:>15.12f}")
            
            print(f"{'='*90}\n")
        
        # Per-callsign per-band statistics
        if callsign_band_diffs:
            print(f"\n{'='*100}")
            print(f"PER-CALLSIGN PER-BAND STATISTICS")
            print(f"{'='*100}")
            print(f"{'Callsign':<12} {'Band':<10} {'Matches':>10} {'Avg Diff Hz':>15} {'Std Dev Hz':>15} {'PPM':>10} {'Adjustment':>15}")
            print(f"{'-'*100}")
            
            for callsign in sorted(callsign_band_diffs.keys()):
                for band in sorted(callsign_band_diffs[callsign].keys(),
                                 key=lambda b: AMATEUR_BANDS.get(b, (0, 0))[0] if b != 'Unknown' else 999999):
                    diffs = callsign_band_diffs[callsign][band]
                    freqs = callsign_band_freqs[callsign][band]
                    avg_diff = statistics.mean(diffs)
                    std_dev = statistics.stdev(diffs) if len(diffs) > 1 else 0.0
                    
                    # Calculate PPM using average frequency
                    avg_freq_khz = statistics.mean(freqs)
                    avg_freq_hz = avg_freq_khz * 1000
                    ppm = (avg_diff / avg_freq_hz) * 1e6
                    adjustment = 1.0 + (ppm / 1e6)
                    
                    print(f"{callsign:<12} {band:<10} {len(diffs):>10} {avg_diff:>+15.1f} {std_dev:>15.1f} {ppm:>+10.1f} {adjustment:>15.12f}")
            
            print(f"{'='*100}\n")
        
        # Overall statistics - moved to end for prominence
        avg_diff = total_diff / len(matches)
        
        # Calculate overall PPM using all frequencies
        all_freqs = [local_spot['frequency'] for local_spot, _, _ in matches]
        avg_freq_khz = statistics.mean(all_freqs)
        avg_freq_hz = avg_freq_khz * 1000
        overall_ppm = (avg_diff / avg_freq_hz) * 1e6
        overall_adjustment = 1.0 + (overall_ppm / 1e6)
        
        print(f"\n{'='*100}")
        print(f"OVERALL CALIBRATION SUMMARY")
        print(f"{'='*100}")
        print(f"Overall average frequency difference: {avg_diff:+.1f} Hz (Local - RBN)")
        print(f"Overall PPM: {overall_ppm:+.1f}")
        print(f"Overall adjustment factor: {overall_adjustment:.12f}")
        print(f"Total matches: {len(matches)} from {len(unique_spotters)} unique remote spotters")
        print(f"{'='*100}\n")
        
        # Add usage instructions at the end
        print("\n" + "="*80)
        print("HOW TO USE THIS DATA")
        print("="*80)
        print("\nTo use the data above to improve the accuracy of your skimmer, multiply")
        print("the current value of FreqCalibration in your skimmer software's settings")
        print("file with the suggested adjustment factor listed above.")
        print("\nCW Skimmer Server: %appdata%\\Afreet\\Products\\SkimSrv\\SkimSrv.ini")
        print("="*80 + "\n")


def main():
    parser = argparse.ArgumentParser(
        description='Compare frequency calibration between local Skimmer Server and RBN',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --local-host 192.168.9.74 --local-port 7300 --callsign MM3NDH
  %(prog)s --local-host 192.168.9.74 --local-port 7300 --callsign MM3NDH --duration 300
        """
    )
    
    parser.add_argument('--local-host', required=True,
                        help='Local Skimmer Server hostname or IP')
    parser.add_argument('--local-port', type=int, default=7300,
                        help='Local Skimmer Server port (default: 7300)')
    parser.add_argument('--callsign', required=True,
                        help='Your callsign for login')
    parser.add_argument('--duration', type=int, default=120,
                        help='Duration to collect spots in seconds (default: 120)')
    parser.add_argument('--time-window', type=int, default=60,
                        help='Time window for matching spots in seconds (default: 60)')
    
    args = parser.parse_args()
    
    # Create connections
    local = TelnetConnection('LOCAL', args.local_host, args.local_port, args.callsign)
    rbn = TelnetConnection('RBN', 'telnet.reversebeacon.net', 7000, args.callsign)
    
    # Connect to both servers
    if not local.connect():
        print("Failed to connect to local server", file=sys.stderr)
        return 1
    
    if not rbn.connect():
        print("Failed to connect to RBN", file=sys.stderr)
        local.stop()
        return 1
    
    # Start reading spots
    local.start()
    rbn.start()
    
    try:
        print(f"\nCollecting spots for {args.duration} seconds...")
        print("Press Ctrl+C to stop early\n")
        time.sleep(args.duration)
    except KeyboardInterrupt:
        print("\n\nStopping...")
    
    # Stop connections
    local.stop()
    rbn.stop()
    
    # Compare results
    print(f"\nCollected {len(local.spots)} local spots and {len(rbn.spots)} RBN spots")
    
    comparator = FrequencyComparator(local.spots, rbn.spots, args.time_window)
    comparator.print_comparison()
    
    return 0


if __name__ == '__main__':
    sys.exit(main())