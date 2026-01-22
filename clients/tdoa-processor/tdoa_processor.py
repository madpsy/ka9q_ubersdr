#!/usr/bin/env python3
"""
TDOA (Time Difference of Arrival) Processor for UberSDR IQ Recordings

This application processes synchronized IQ recordings from multiple UberSDR instances
to perform TDOA analysis for geolocation of radio transmitters.
"""

import numpy as np
import json
import wave
import os
import glob
from collections import defaultdict
from datetime import datetime
from scipy import signal
from scipy.optimize import least_squares
from dataclasses import dataclass
from typing import List, Tuple, Optional, Dict
import argparse


@dataclass
class ReceiverInfo:
    """Information about a receiver from metadata"""
    hostname: str
    latitude: float
    longitude: float
    altitude: float
    callsign: str
    location: str
    wav_file: str
    iq_data: Optional[np.ndarray] = None


@dataclass
class TDOAResult:
    """Result of TDOA calculation between two receivers"""
    receiver1: str
    receiver2: str
    tdoa_seconds: float
    tdoa_samples: int
    correlation_peak: float
    confidence: float
    snr_db_rx1: float = 0.0
    snr_db_rx2: float = 0.0


class TDOAProcessor:
    """Process IQ recordings to calculate TDOA for geolocation"""
    
    SPEED_OF_LIGHT = 299792458  # meters per second
    EARTH_RADIUS = 6371000  # meters
    
    def __init__(self, sample_rate: int = 48000):
        self.sample_rate = sample_rate
        self.receivers: List[ReceiverInfo] = []
        self.tdoa_results: List[TDOAResult] = []
        
    def load_recording(self, wav_file: str, json_file: str) -> ReceiverInfo:
        """Load a WAV file and its metadata"""
        print(f"Loading {wav_file}...")
        
        # Load metadata
        with open(json_file, 'r') as f:
            metadata = json.load(f)
        
        # Extract receiver info
        receiver = metadata.get('receiver', {})
        gps = receiver.get('gps', {})
        
        # Parse hostname from filename
        basename = os.path.basename(wav_file)
        hostname = basename.split('_')[0]
        
        receiver_info = ReceiverInfo(
            hostname=hostname,
            latitude=gps.get('lat', 0.0),
            longitude=gps.get('lon', 0.0),
            altitude=receiver.get('asl', 0),
            callsign=receiver.get('callsign', 'Unknown'),
            location=receiver.get('location', 'Unknown'),
            wav_file=wav_file
        )
        
        # Load IQ data from WAV file
        with wave.open(wav_file, 'rb') as wf:
            if wf.getnchannels() != 2:
                raise ValueError(f"Expected 2 channels (I/Q), got {wf.getnchannels()}")
            
            if wf.getsampwidth() != 2:
                raise ValueError(f"Expected 16-bit samples, got {wf.getsampwidth() * 8}-bit")
            
            # Read all frames
            frames = wf.readframes(wf.getnframes())
            
            # Convert to numpy array
            samples = np.frombuffer(frames, dtype=np.int16)
            
            # Reshape to I/Q pairs and convert to complex
            samples = samples.reshape(-1, 2)
            iq_data = samples[:, 0] + 1j * samples[:, 1]
            
            # Normalize
            iq_data = iq_data.astype(np.complex64) / 32768.0
            
            receiver_info.iq_data = iq_data
            
        print(f"  Loaded {len(iq_data)} samples from {receiver_info.callsign} ({receiver_info.location})")
        # Display longitude correctly (positive = East, negative = West)
        lon_dir = 'E' if receiver_info.longitude >= 0 else 'W'
        lon_abs = abs(receiver_info.longitude)
        print(f"  Position: {receiver_info.latitude:.4f}°N, {lon_abs:.4f}°{lon_dir}, {receiver_info.altitude}m ASL")
        
        self.receivers.append(receiver_info)
        return receiver_info
    
    def apply_bandpass_filter(self, iq_data: np.ndarray, center_offset_hz: float, bandwidth_hz: float) -> np.ndarray:
        """
        Apply bandpass filter to isolate signal of interest
        
        For IQ data, negative frequencies are valid (they represent the lower sideband).
        The valid frequency range is -Nyquist to +Nyquist.
        """
        nyquist = self.sample_rate / 2
        low_hz = center_offset_hz - bandwidth_hz / 2
        high_hz = center_offset_hz + bandwidth_hz / 2
        
        # For IQ data, valid range is -Nyquist to +Nyquist
        if low_hz < -nyquist:
            print(f"Warning: Filter extends below -Nyquist ({low_hz:.0f} Hz < {-nyquist:.0f} Hz), clamping")
            low_hz = -nyquist * 0.99
        
        if high_hz > nyquist:
            print(f"Warning: Filter extends above +Nyquist ({high_hz:.0f} Hz > {nyquist:.0f} Hz), clamping")
            high_hz = nyquist * 0.99
        
        if low_hz >= high_hz:
            print(f"Warning: Invalid filter range ({low_hz:.0f} >= {high_hz:.0f} Hz), using full bandwidth")
            return iq_data
        
        # Shift frequencies to baseband for filtering
        # We'll frequency-shift the signal, filter, then shift back
        shift_freq = -(low_hz + high_hz) / 2  # Center of our desired band
        filter_bw = high_hz - low_hz
        
        # Frequency shift to center the desired band at 0 Hz
        t = np.arange(len(iq_data)) / self.sample_rate
        shift_signal = iq_data * np.exp(-2j * np.pi * shift_freq * t)
        
        # Now apply lowpass filter with bandwidth/2
        cutoff = (filter_bw / 2) / nyquist
        cutoff = min(0.99, max(0.01, cutoff))
        
        # Create lowpass filter
        sos = signal.butter(6, cutoff, btype='low', output='sos')
        
        # Apply filter
        filtered = signal.sosfilt(sos, shift_signal)
        
        # Shift back to original frequency
        filtered = filtered * np.exp(2j * np.pi * shift_freq * t)
        
        return filtered
    
    def get_spectrum_data(self, center_offset_hz: float = 0, span_hz: float = 10000) -> List[Dict]:
        """
        Get power spectrum data around target frequency for all receivers
        Averages power over the entire recording length for better SNR
        
        Args:
            center_offset_hz: Center frequency offset in Hz
            span_hz: Frequency span to display in Hz
            
        Returns:
            List of spectrum data dictionaries for each receiver
        """
        spectrum_data = []
        
        for rx in self.receivers:
            # Use smaller FFT size for better averaging and signal visibility
            # 8192 points (8K) = ~5.86 Hz resolution at 48 kHz sample rate
            # For 10-second recording at 48 kHz (480k samples), this gives ~117 FFTs to average
            # More averaging = better SNR and clearer signal peaks
            fft_size = 8192
            
            # Calculate how many FFTs we can do with 50% overlap for better averaging
            hop_size = fft_size // 2
            num_ffts = (len(rx.iq_data) - fft_size) // hop_size + 1
            
            if num_ffts == 0:
                continue
            
            # Accumulate power spectrum across all FFTs
            accumulated_power = None
            fft_freq = None
            
            for i in range(num_ffts):
                start_idx = i * hop_size
                end_idx = start_idx + fft_size
                
                if end_idx > len(rx.iq_data):
                    break
                    
                data_chunk = rx.iq_data[start_idx:end_idx]
                
                # Apply Hanning window to reduce spectral leakage
                window = np.hanning(fft_size)
                windowed_data = data_chunk * window
                
                # Compute FFT
                fft_result = np.fft.fft(windowed_data)
                
                if fft_freq is None:
                    fft_freq = np.fft.fftfreq(fft_size, 1/self.sample_rate)
                    # Shift to center DC at 0
                    fft_freq = np.fft.fftshift(fft_freq)
                
                # Shift FFT result to center DC at 0
                fft_result = np.fft.fftshift(fft_result)
                
                # Calculate power spectrum (magnitude squared)
                power = np.abs(fft_result) ** 2
                
                if accumulated_power is None:
                    accumulated_power = power
                else:
                    accumulated_power += power
            
            # Average the accumulated power
            avg_power_spectrum = accumulated_power / num_ffts
            
            # Convert to dB (referenced to 1.0)
            power_spectrum_db = 10 * np.log10(avg_power_spectrum + 1e-20)
            
            # Find indices for our frequency range
            freq_start = center_offset_hz - span_hz / 2
            freq_end = center_offset_hz + span_hz / 2
            
            mask = (fft_freq >= freq_start) & (fft_freq <= freq_end)
            display_freqs = fft_freq[mask]
            display_power = power_spectrum_db[mask]
            
            if len(display_freqs) == 0:
                continue
            
            # Downsample for web display (max 500 points)
            if len(display_freqs) > 500:
                step = len(display_freqs) // 500
                display_freqs = display_freqs[::step]
                display_power = display_power[::step]
            
            # Find peak in the range
            peak_idx = np.argmax(display_power)
            peak_freq = display_freqs[peak_idx]
            peak_power = display_power[peak_idx]
            
            # Calculate average power (noise floor estimate)
            avg_power = np.mean(display_power)
            
            spectrum_data.append({
                'callsign': rx.callsign,
                'location': rx.location,
                'frequencies': display_freqs.tolist(),
                'power_db': display_power.tolist(),
                'peak_freq_hz': float(peak_freq),
                'peak_power_db': float(peak_power),
                'avg_power_db': float(avg_power),
                'snr_db': float(peak_power - avg_power),
                'num_averages': int(num_ffts)
            })
        
        return spectrum_data
    
    def plot_spectrum(self, center_offset_hz: float = 0, span_hz: float = 10000):
        """
        Display power spectrum around target frequency for all receivers (console output)
        
        Args:
            center_offset_hz: Center frequency offset in Hz
            span_hz: Frequency span to display in Hz
        """
        print("\n" + "="*80)
        print("SIGNAL SPECTRUM ANALYSIS")
        print("="*80)
        print(f"Center: {center_offset_hz:+.0f} Hz, Span: ±{span_hz/2:.0f} Hz")
        print()
        
        for rx in self.receivers:
            # Take a chunk of data for FFT (use first 100k samples)
            chunk_size = min(100000, len(rx.iq_data))
            data_chunk = rx.iq_data[:chunk_size]
            
            # Compute FFT
            fft_result = np.fft.fft(data_chunk)
            fft_freq = np.fft.fftfreq(len(data_chunk), 1/self.sample_rate)
            
            # Shift to center DC at 0
            fft_result = np.fft.fftshift(fft_result)
            fft_freq = np.fft.fftshift(fft_freq)
            
            # Calculate power spectrum in dB
            power_spectrum = 20 * np.log10(np.abs(fft_result) + 1e-10)
            
            # Find indices for our frequency range
            freq_start = center_offset_hz - span_hz / 2
            freq_end = center_offset_hz + span_hz / 2
            
            mask = (fft_freq >= freq_start) & (fft_freq <= freq_end)
            display_freqs = fft_freq[mask]
            display_power = power_spectrum[mask]
            
            if len(display_freqs) == 0:
                print(f"{rx.callsign}: No data in frequency range")
                continue
            
            # Find peak in the range
            peak_idx = np.argmax(display_power)
            peak_freq = display_freqs[peak_idx]
            peak_power = display_power[peak_idx]
            
            # Calculate average power
            avg_power = np.mean(display_power)
            
            # Create simple ASCII spectrum display
            print(f"{rx.callsign} ({rx.location}):")
            print(f"  Peak: {peak_freq:+7.1f} Hz at {peak_power:6.1f} dB")
            print(f"  Average: {avg_power:6.1f} dB")
            print(f"  SNR estimate: {peak_power - avg_power:5.1f} dB")
            
            # ASCII bar chart (simplified)
            # Normalize to 0-50 range for display
            normalized = display_power - np.min(display_power)
            normalized = normalized / (np.max(normalized) + 1e-10) * 50
            
            # Sample every Nth point to fit in 80 chars
            num_points = 60
            step = max(1, len(normalized) // num_points)
            sampled_power = normalized[::step]
            sampled_freqs = display_freqs[::step]
            
            print(f"  Spectrum:")
            # Print frequency scale
            print(f"    {freq_start:+7.0f} Hz" + " " * 35 + f"{freq_end:+7.0f} Hz")
            
            # Print bars
            for i in range(10, -1, -1):  # 10 rows
                line = "    "
                threshold = i * 5
                for val in sampled_power:
                    if val >= threshold:
                        line += "█"
                    elif val >= threshold - 2.5:
                        line += "▄"
                    else:
                        line += " "
                print(line)
            
            # Mark center frequency
            center_pos = len(sampled_power) // 2
            marker_line = "    " + " " * center_pos + "↑"
            print(marker_line)
            print(f"    {' ' * center_pos}{center_offset_hz:+.0f} Hz")
            print()
    
    def calculate_snr(self, signal: np.ndarray, center_offset_hz: float = 0, bandwidth_hz: float = 2500) -> float:
        """
        Calculate SNR of the signal in the specified bandwidth using FFT
        
        Uses the same method as get_spectrum_data() for consistency.
        
        Args:
            signal: Complex IQ signal (unfiltered)
            center_offset_hz: Center frequency offset in Hz
            bandwidth_hz: Bandwidth to analyze in Hz
            
        Returns:
            SNR in dB
        """
        # Use same FFT parameters as spectrum display
        fft_size = 8192
        hop_size = fft_size // 2
        num_ffts = (len(signal) - fft_size) // hop_size + 1
        
        if num_ffts == 0:
            return 0.0
        
        # Accumulate power spectrum
        accumulated_power = None
        
        for i in range(num_ffts):
            start_idx = i * hop_size
            end_idx = start_idx + fft_size
            
            if end_idx > len(signal):
                break
                
            data_chunk = signal[start_idx:end_idx]
            
            # Apply Hanning window
            window = np.hanning(fft_size)
            windowed_data = data_chunk * window
            
            # Compute FFT
            fft_result = np.fft.fft(windowed_data)
            fft_result = np.fft.fftshift(fft_result)
            
            # Calculate power spectrum
            power = np.abs(fft_result) ** 2
            
            if accumulated_power is None:
                accumulated_power = power
            else:
                accumulated_power += power
        
        # Average the accumulated power
        avg_power_spectrum = accumulated_power / num_ffts
        
        # Convert to dB
        power_spectrum_db = 10 * np.log10(avg_power_spectrum + 1e-20)
        
        # Get frequency bins
        fft_freq = np.fft.fftfreq(fft_size, 1/self.sample_rate)
        fft_freq = np.fft.fftshift(fft_freq)
        
        # Find indices for our frequency range
        freq_start = center_offset_hz - bandwidth_hz / 2
        freq_end = center_offset_hz + bandwidth_hz / 2
        
        mask = (fft_freq >= freq_start) & (fft_freq <= freq_end)
        
        if not np.any(mask):
            return 0.0
        
        # Get power in the signal band
        signal_power_db = power_spectrum_db[mask]
        
        # Peak power in signal band
        peak_power_db = np.max(signal_power_db)
        
        # Noise floor estimate from full spectrum (median)
        noise_floor_db = np.median(power_spectrum_db)
        
        # SNR
        snr_db = peak_power_db - noise_floor_db
        
        return float(snr_db)
    
    def cross_correlate(self, signal1: np.ndarray, signal2: np.ndarray,
                       max_lag_samples: int = 10000) -> Tuple[int, float, float]:
        """
        Cross-correlate two signals to find time delay
        
        For AM signals like WWV, correlating the envelope often works better than
        correlating the carrier directly.
        
        Returns:
            (lag_samples, correlation_peak, confidence)
        """
        # Use full signals for better correlation
        n = min(len(signal1), len(signal2))
        
        # For AM signals, use envelope detection
        # Calculate envelope as magnitude of complex signal
        env1 = np.abs(signal1)
        env2 = np.abs(signal2)
        
        # Remove DC component
        env1 = env1 - np.mean(env1)
        env2 = env2 - np.mean(env2)
        
        # Calculate signal power for normalization
        power1 = np.sqrt(np.mean(env1 ** 2))
        power2 = np.sqrt(np.mean(env2 ** 2))
        
        if power1 < 1e-10 or power2 < 1e-10:
            # Signals are too weak, return zero correlation
            return 0, 0.0, 0.0
        
        # Normalize envelopes
        env1 = env1 / power1
        env2 = env2 / power2
        
        # Compute cross-correlation using FFT
        # Use 'full' mode to get all possible lags
        correlation = signal.correlate(env1, env2, mode='full', method='fft')
        
        # Lag array: negative means signal2 is delayed, positive means signal1 is delayed
        lags = np.arange(-n + 1, n)
        
        # Limit search to reasonable range based on receiver separation
        center_idx = n - 1
        search_start = max(0, center_idx - max_lag_samples)
        search_end = min(len(correlation), center_idx + max_lag_samples + 1)
        
        # Find peak in search region
        search_region = correlation[search_start:search_end]
        peak_idx_in_region = np.argmax(search_region)
        peak_idx = search_start + peak_idx_in_region
        
        # Get lag in samples
        lag_samples = lags[peak_idx]
        
        # Calculate correlation peak value
        correlation_peak = correlation[peak_idx]
        
        # Calculate confidence as normalized correlation coefficient
        # For normalized signals, theoretical max is n
        confidence = correlation_peak / n
        
        return int(lag_samples), float(correlation_peak), float(confidence)
    
    def calculate_tdoa(self, center_offset_hz: float = 0, bandwidth_hz: float = 2500, show_spectrum: bool = True) -> List[TDOAResult]:
        """
        Calculate TDOA between all receiver pairs
        
        Args:
            center_offset_hz: Offset from center frequency to target signal (Hz)
            bandwidth_hz: Bandwidth of filter around target signal (Hz)
        """
        if len(self.receivers) < 2:
            raise ValueError("Need at least 2 receivers for TDOA")
        
        print(f"\nCalculating TDOA with filter: {center_offset_hz:+.0f} Hz ± {bandwidth_hz/2:.0f} Hz")
        
        # Show spectrum before filtering (only in console mode)
        if show_spectrum:
            self.plot_spectrum(center_offset_hz, bandwidth_hz * 2)
        
        # Apply bandpass filter to all signals if offset specified
        filtered_signals = []
        for receiver in self.receivers:
            if center_offset_hz != 0 or bandwidth_hz < 24000:
                filtered = self.apply_bandpass_filter(receiver.iq_data, center_offset_hz, bandwidth_hz)
                filtered_signals.append(filtered)
            else:
                filtered_signals.append(receiver.iq_data)
        
        # Calculate TDOA for all pairs
        self.tdoa_results = []
        for i in range(len(self.receivers)):
            for j in range(i + 1, len(self.receivers)):
                rx1 = self.receivers[i]
                rx2 = self.receivers[j]
                
                print(f"\nCross-correlating {rx1.callsign} <-> {rx2.callsign}...")
                
                # Calculate SNR on original (unfiltered) signals for better estimate
                # This matches what the spectrum display shows
                snr_rx1 = self.calculate_snr(rx1.iq_data, center_offset_hz, bandwidth_hz)
                snr_rx2 = self.calculate_snr(rx2.iq_data, center_offset_hz, bandwidth_hz)
                
                print(f"  Signal SNR: {rx1.callsign}={snr_rx1:.1f} dB, {rx2.callsign}={snr_rx2:.1f} dB")
                
                # Calculate maximum possible lag based on receiver separation
                rx1_rx2_dist = self.haversine_distance(rx1.latitude, rx1.longitude, rx2.latitude, rx2.longitude)
                max_tdoa_seconds = rx1_rx2_dist / self.SPEED_OF_LIGHT
                max_lag = int(max_tdoa_seconds * self.sample_rate * 1.1)  # Add 10% margin
                
                lag_samples, peak, confidence = self.cross_correlate(
                    filtered_signals[i],
                    filtered_signals[j],
                    max_lag_samples=max_lag
                )
                
                tdoa_seconds = lag_samples / self.sample_rate
                
                result = TDOAResult(
                    receiver1=rx1.callsign,
                    receiver2=rx2.callsign,
                    tdoa_seconds=tdoa_seconds,
                    tdoa_samples=lag_samples,
                    correlation_peak=peak,
                    confidence=confidence,
                    snr_db_rx1=snr_rx1,
                    snr_db_rx2=snr_rx2
                )
                
                self.tdoa_results.append(result)
                
                print(f"  TDOA: {tdoa_seconds*1e6:+.1f} μs ({lag_samples:+d} samples)")
                print(f"  Correlation peak: {peak:.2e}, Confidence: {confidence:.4f}")
                
                # Calculate distance difference
                distance_diff = tdoa_seconds * self.SPEED_OF_LIGHT
                print(f"  Distance difference: {distance_diff/1000:+.2f} km")
                
                # Sanity check: TDOA should not exceed light travel time between receivers
                rx1_rx2_dist = self.haversine_distance(rx1.latitude, rx1.longitude, rx2.latitude, rx2.longitude)
                max_tdoa = rx1_rx2_dist / self.SPEED_OF_LIGHT
                if abs(tdoa_seconds) > max_tdoa:
                    print(f"  WARNING: TDOA exceeds maximum possible ({max_tdoa*1e6:.1f} μs)")
                    print(f"           Receiver separation: {rx1_rx2_dist/1000:.1f} km")
        
        return self.tdoa_results
    
    def haversine_distance(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate distance between two points on Earth using Haversine formula"""
        lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
        
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        
        a = np.sin(dlat/2)**2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon/2)**2
        c = 2 * np.arcsin(np.sqrt(a))
        
        return self.EARTH_RADIUS * c
    
    def estimate_position(self) -> Optional[Tuple[float, float]]:
        """
        Estimate transmitter position using multilateration
        
        Returns:
            (latitude, longitude) or None if estimation fails
        """
        if len(self.tdoa_results) < 2:
            print("Need at least 2 TDOA measurements for position estimation")
            return None
        
        print("\n" + "="*60)
        print("POSITION ESTIMATION")
        print("="*60)
        
        # Use first receiver as reference
        ref_rx = self.receivers[0]
        lon_dir = 'E' if ref_rx.longitude >= 0 else 'W'
        lon_abs = abs(ref_rx.longitude)
        print(f"Reference receiver: {ref_rx.callsign} at {ref_rx.latitude:.4f}°N, {lon_abs:.4f}°{lon_dir}")
        
        # Initial guess: midpoint of all receivers
        avg_lat = np.mean([rx.latitude for rx in self.receivers])
        avg_lon = np.mean([rx.longitude for rx in self.receivers])
        
        print(f"Initial guess: {avg_lat:.4f}°N, {avg_lon:.4f}°E")
        
        def residuals(pos):
            """Calculate residuals for least squares optimization"""
            lat, lon = pos
            errors = []
            
            for result in self.tdoa_results:
                # Find receiver indices
                rx1_idx = next(i for i, rx in enumerate(self.receivers) if rx.callsign == result.receiver1)
                rx2_idx = next(i for i, rx in enumerate(self.receivers) if rx.callsign == result.receiver2)
                
                rx1 = self.receivers[rx1_idx]
                rx2 = self.receivers[rx2_idx]
                
                # Calculate distances from estimated position to each receiver
                d1 = self.haversine_distance(lat, lon, rx1.latitude, rx1.longitude)
                d2 = self.haversine_distance(lat, lon, rx2.latitude, rx2.longitude)
                
                # Expected distance difference
                expected_diff = d1 - d2
                
                # Measured distance difference from TDOA
                measured_diff = result.tdoa_seconds * self.SPEED_OF_LIGHT
                
                # Error weighted by confidence
                error = (expected_diff - measured_diff) * result.confidence
                errors.append(error)
            
            return errors
        
        # Check if TDOA measurements are valid before attempting position estimation
        invalid_count = 0
        for result in self.tdoa_results:
            rx1_idx = next(i for i, rx in enumerate(self.receivers) if rx.callsign == result.receiver1)
            rx2_idx = next(i for i, rx in enumerate(self.receivers) if rx.callsign == result.receiver2)
            rx1 = self.receivers[rx1_idx]
            rx2 = self.receivers[rx2_idx]
            
            rx1_rx2_dist = self.haversine_distance(rx1.latitude, rx1.longitude, rx2.latitude, rx2.longitude)
            max_tdoa = rx1_rx2_dist / self.SPEED_OF_LIGHT
            
            if abs(result.tdoa_seconds) > max_tdoa:
                invalid_count += 1
        
        if invalid_count == len(self.tdoa_results):
            print("\nAll TDOA measurements are invalid (exceed physical limits)")
            print("Position estimation skipped")
            print("\nThis usually indicates:")
            print("  - Recordings are not synchronized")
            print("  - No common signal present in all recordings")
            print("  - Wrong frequency or filter settings")
            print("  - Need to specify correct signal offset with --offset parameter")
            return None
        
        # Perform least squares optimization
        result = least_squares(residuals, [avg_lat, avg_lon], method='lm')
        
        if result.success:
            est_lat, est_lon = result.x
            
            # Validate position estimate
            if not (-90 <= est_lat <= 90 and -180 <= est_lon <= 180):
                print(f"Warning: Invalid position estimate: {est_lat}, {est_lon}")
                print("Position estimation failed - coordinates out of valid range")
                print("\nThis usually indicates:")
                print("  - Poor signal correlation (low confidence values)")
                print("  - Insufficient receiver separation")
                print("  - Signal not present in all recordings")
                print("  - Need narrower filter around target signal")
                return None
            
            # Check if position is suspiciously close to a receiver (< 10 km)
            min_dist = float('inf')
            closest_rx = None
            for rx in self.receivers:
                dist = self.haversine_distance(est_lat, est_lon, rx.latitude, rx.longitude)
                if dist < min_dist:
                    min_dist = dist
                    closest_rx = rx.callsign
            
            if min_dist < 10000:  # Less than 10 km
                print(f"\nWarning: Estimated position is suspiciously close to receiver {closest_rx} ({min_dist/1000:.1f} km)")
                print("This suggests the optimization converged to a receiver location due to poor TDOA data")
                print("Position estimate is likely invalid")
            
            lon_dir = 'E' if est_lon >= 0 else 'W'
            lon_abs = abs(est_lon)
            print(f"\nEstimated position: {est_lat:.4f}°N, {lon_abs:.4f}°{lon_dir}")
            
            # Calculate uncertainty (rough estimate from residuals)
            rms_error = np.sqrt(np.mean(np.array(result.fun)**2))
            uncertainty_m = rms_error
            print(f"Position uncertainty: ±{uncertainty_m/1000:.1f} km")
            
            # Show distances from each receiver
            print("\nDistances from receivers:")
            for rx in self.receivers:
                dist = self.haversine_distance(est_lat, est_lon, rx.latitude, rx.longitude)
                print(f"  {rx.callsign}: {dist/1000:.1f} km")
            
            return est_lat, est_lon, uncertainty_m
        else:
            print("Position estimation failed to converge")
            return None
    
    def print_summary(self):
        """Print summary of TDOA analysis"""
        print("\n" + "="*60)
        print("TDOA ANALYSIS SUMMARY")
        print("="*60)
        
        print(f"\nReceivers: {len(self.receivers)}")
        for i, rx in enumerate(self.receivers):
            lon_dir = 'E' if rx.longitude >= 0 else 'W'
            lon_abs = abs(rx.longitude)
            print(f"  {i+1}. {rx.callsign} ({rx.location})")
            print(f"     Position: {rx.latitude:.4f}°N, {lon_abs:.4f}°{lon_dir}")
            print(f"     Samples: {len(rx.iq_data)}")
        
        print(f"\nTDOA Measurements: {len(self.tdoa_results)}")
        for result in self.tdoa_results:
            print(f"  {result.receiver1} <-> {result.receiver2}:")
            print(f"    TDOA: {result.tdoa_seconds*1e6:+.1f} μs")
            print(f"    Confidence: {result.confidence:.4f}")


def scan_directory(directory: str) -> Dict[str, List[str]]:
    """
    Scan directory for WAV files and group by timestamp
    
    Returns:
        Dictionary mapping timestamp to list of WAV files
    """
    # Find all WAV files
    wav_pattern = os.path.join(directory, "*.wav")
    wav_files = glob.glob(wav_pattern)
    
    # Group by timestamp (format: hostname_frequency_timestamp.wav)
    recordings_by_time = defaultdict(list)
    
    for wav_file in wav_files:
        basename = os.path.basename(wav_file)
        parts = basename.split('_')
        
        if len(parts) >= 3:
            # Extract timestamp (everything after second underscore, before .wav)
            timestamp = '_'.join(parts[2:]).replace('.wav', '')
            recordings_by_time[timestamp].append(wav_file)
    
    return dict(recordings_by_time)


def display_recording_sessions(sessions: Dict[str, List[str]]) -> List[Tuple[str, List[str]]]:
    """
    Display available recording sessions and return sorted list
    
    Returns:
        List of (timestamp, wav_files) tuples sorted by timestamp
    """
    if not sessions:
        print("No recording sessions found!")
        return []
    
    # Sort by timestamp
    sorted_sessions = sorted(sessions.items(), key=lambda x: x[0], reverse=True)
    
    print("\n" + "="*80)
    print("AVAILABLE RECORDING SESSIONS")
    print("="*80)
    print(f"\nFound {len(sorted_sessions)} recording session(s):\n")
    
    for idx, (timestamp, wav_files) in enumerate(sorted_sessions, 1):
        # Parse timestamp for display
        try:
            # Handle format: 2026-01-21T15:47:37.908Z
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            time_str = dt.strftime('%Y-%m-%d %H:%M:%S UTC')
        except:
            time_str = timestamp
        
        # Extract frequency from first file
        first_file = os.path.basename(wav_files[0])
        parts = first_file.split('_')
        frequency = parts[1] if len(parts) >= 2 else "Unknown"
        freq_mhz = float(frequency) / 1e6 if frequency.isdigit() else 0
        
        # Get hostnames
        hostnames = []
        for wav_file in wav_files:
            basename = os.path.basename(wav_file)
            hostname = basename.split('_')[0]
            hostnames.append(hostname)
        
        print(f"  [{idx}] {time_str}")
        print(f"      Frequency: {freq_mhz:.3f} MHz")
        print(f"      Receivers: {len(wav_files)}")
        for hostname in hostnames:
            print(f"        - {hostname}")
        print()
    
    return sorted_sessions


def select_session(sessions: List[Tuple[str, List[str]]]) -> Optional[List[str]]:
    """
    Let user select a recording session
    
    Returns:
        List of WAV files for selected session, or None if cancelled
    """
    if not sessions:
        return None
    
    if len(sessions) == 1:
        print(f"Only one session available, selecting automatically...")
        return sessions[0][1]
    
    while True:
        try:
            choice = input(f"Select session [1-{len(sessions)}] or 'q' to quit: ").strip()
            
            if choice.lower() == 'q':
                return None
            
            idx = int(choice)
            if 1 <= idx <= len(sessions):
                return sessions[idx - 1][1]
            else:
                print(f"Please enter a number between 1 and {len(sessions)}")
        except ValueError:
            print("Invalid input. Please enter a number or 'q'")
        except KeyboardInterrupt:
            print("\nCancelled")
            return None


def main():
    parser = argparse.ArgumentParser(
        description='TDOA Processor for UberSDR IQ Recordings',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Scan directory and select session interactively
  %(prog)s /path/to/recordings
  
  # Process specific files with narrowband filter
  %(prog)s --files rx1.wav rx2.wav --offset 3000 --bandwidth 2500
  
  # Scan current directory
  %(prog)s .
        """
    )
    
    parser.add_argument('directory', nargs='?', default='.',
                       help='Directory containing WAV files (default: current directory)')
    parser.add_argument('--files', nargs='+', metavar='WAV',
                       help='Specific WAV files to process (skips directory scan)')
    parser.add_argument('--offset', type=float, default=0,
                       help='Frequency offset from center in Hz (default: 0)')
    parser.add_argument('--bandwidth', type=float, default=24000,
                       help='Filter bandwidth in Hz (default: 24000 = full bandwidth)')
    parser.add_argument('--no-position', action='store_true',
                       help='Skip position estimation')
    parser.add_argument('--auto', action='store_true',
                       help='Automatically select most recent session')
    
    args = parser.parse_args()
    
    # Determine which files to process
    if args.files:
        # Use explicitly specified files
        wav_files = args.files
        print(f"Processing {len(wav_files)} specified file(s)")
    else:
        # Scan directory and let user select
        print(f"Scanning directory: {args.directory}")
        sessions = scan_directory(args.directory)
        
        if not sessions:
            print("No WAV files found in directory")
            return 1
        
        sorted_sessions = display_recording_sessions(sessions)
        
        if args.auto:
            # Select most recent (first in sorted list)
            print("Auto-selecting most recent session...")
            wav_files = sorted_sessions[0][1]
        else:
            # Let user select
            wav_files = select_session(sorted_sessions)
            if wav_files is None:
                print("No session selected")
                return 0
        
        print(f"\nSelected {len(wav_files)} recording(s)")
    
    # Create processor
    processor = TDOAProcessor()
    
    # Load all recordings
    print("\n" + "="*80)
    print("LOADING RECORDINGS")
    print("="*80 + "\n")
    
    for wav_file in wav_files:
        # Find corresponding JSON file
        json_file = wav_file.replace('.wav', '.json')
        
        if not os.path.exists(json_file):
            print(f"Warning: Metadata file not found: {json_file}")
            print(f"Skipping {wav_file}")
            continue
        
        try:
            processor.load_recording(wav_file, json_file)
        except Exception as e:
            print(f"Error loading {wav_file}: {e}")
            continue
    
    if len(processor.receivers) < 2:
        print("\nError: Need at least 2 valid recordings for TDOA analysis")
        return 1
    
    # Calculate TDOA
    print("\n" + "="*80)
    print("TDOA CALCULATION")
    print("="*80)
    
    processor.calculate_tdoa(args.offset, args.bandwidth)
    
    # Estimate position
    if not args.no_position:
        processor.estimate_position()
    
    # Print summary
    processor.print_summary()
    
    return 0


if __name__ == '__main__':
    exit(main())
