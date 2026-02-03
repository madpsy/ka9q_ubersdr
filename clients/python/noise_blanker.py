"""
Noise Blanker - Frequency-domain impulse noise suppression
Removes transient wideband noise (e.g., power line noise, ignition noise, electric fences)
Uses FFT to detect broadband clicks and distinguish from narrowband speech
"""

import numpy as np
import sys
import time


class NoiseBlanker:
    """
    Frequency-domain noise blanker for removing impulse noise.
    
    Uses FFT-based spectral analysis to detect broadband clicks and distinguish
    them from narrowband speech peaks. Uses a Hann window to smoothly mute 
    detected pulses without creating wideband artifacts from discontinuities.
    """
    
    def __init__(self, sample_rate=12000):
        """Initialize noise blanker.
        
        Args:
            sample_rate: Audio sample rate in Hz
        """
        self.sample_rate = sample_rate
        
        # Parameters
        self.threshold = 10.0          # 10x average = ~20dB above noise floor
        self.blank_duration = 0.003    # 3ms blanking duration
        self.blank_samples = int(sample_rate * self.blank_duration)
        self.avg_window = int(sample_rate * 0.020)  # 20ms averaging window
        
        # FFT parameters for broadband detection
        self.fft_size = 128  # Small FFT for quick spectral analysis
        self.fft_buffer = np.zeros(self.fft_size, dtype=np.float32)
        self.fft_buffer_pos = 0
        self.spectral_flatness_threshold = 0.3  # 0-1, higher = more broadband required
        
        # Create a Hann-like window for smooth blanking
        # At detection (window_pos=0): maximum attenuation (multiply by ~0.0)
        # At end (window_pos=blank_samples-1): no attenuation (multiply by 1.0)
        # This creates a smooth fade-out of the blanking effect
        
        self.window = np.zeros(self.blank_samples, dtype=np.float32)
        
        # Use a Hann window shape: starts at 0.0, ends at 1.0
        # This gives maximum attenuation at the start (when pulse detected)
        # and smoothly releases back to normal
        for i in range(self.blank_samples):
            # Hann window from 0 to 1: 0.5 * (1 - cos(pi * i / N))
            # But we want 0 at start, 1 at end, so use: 0.5 * (1 - cos(pi * (i+1) / N))
            t = (i + 1) / self.blank_samples  # 0 to 1
            self.window[i] = 0.5 * (1.0 - np.cos(np.pi * t))
        
        
        # State
        self.avg_level = 0.0001
        self.blank_counter = 0
        self.enabled = False
        
        # History buffer for running average
        self.history = np.zeros(self.avg_window, dtype=np.float32)
        self.history_pos = 0
        self.history_sum = 0.0
        
        # Warmup period
        self.warmup_samples = self.avg_window * 2
        self.warmup_counter = 0
        
        # Statistics
        self.pulses_detected = 0
        self.false_positives_rejected = 0
        self.last_log_time = 0
        self.log_interval = 2.0  # Log every 2 seconds max
    
    def calculate_spectral_flatness(self, spectrum):
        """Calculate spectral flatness (geometric mean / arithmetic mean).
        
        Returns 0-1, where 1 = perfectly flat (broadband), 0 = single tone
        
        Args:
            spectrum: Magnitude spectrum (positive frequencies)
            
        Returns:
            Spectral flatness value between 0 and 1
        """
        epsilon = 1e-10  # Avoid log(0)
        
        # Add epsilon to avoid zeros
        spectrum_safe = spectrum + epsilon
        
        # Geometric mean: exp(mean(log(x)))
        geometric_mean = np.exp(np.mean(np.log(spectrum_safe)))
        
        # Arithmetic mean
        arithmetic_mean = np.mean(spectrum_safe)
        
        if arithmetic_mean < epsilon:
            return 0.0
        
        return geometric_mean / arithmetic_mean
    
    def is_broadband_click(self):
        """Check if current signal is broadband (impulse noise characteristic).
        
        Returns:
            True if signal is broadband, False if narrowband
        """
        # Apply Hann window to FFT buffer
        hann_window = np.hanning(self.fft_size)
        windowed = self.fft_buffer * hann_window
        
        # Compute FFT (only need positive frequencies)
        fft_result = np.fft.rfft(windowed)
        spectrum = np.abs(fft_result)
        
        # Calculate spectral flatness
        flatness = self.calculate_spectral_flatness(spectrum)
        
        # Broadband clicks have high spectral flatness
        return flatness > self.spectral_flatness_threshold
    
    def set_parameters(self, threshold=None, avg_window_ms=None, spectral_flatness_threshold=None):
        """Update noise blanker parameters.
        
        Args:
            threshold: Detection threshold (multiplier of average level)
            avg_window_ms: Averaging window in milliseconds
            spectral_flatness_threshold: Threshold for broadband detection (0-1)
        """
        if threshold is not None:
            self.threshold = float(threshold)
        
        if avg_window_ms is not None:
            new_window = int(self.sample_rate * avg_window_ms / 1000.0)
            if new_window != self.avg_window:
                self.avg_window = new_window
                self.history = np.zeros(self.avg_window, dtype=np.float32)
                self.history_pos = 0
                self.history_sum = 0.0
                self.warmup_samples = self.avg_window * 2
                self.warmup_counter = 0
        
        if spectral_flatness_threshold is not None:
            self.spectral_flatness_threshold = float(spectral_flatness_threshold)
    
    def process(self, input_samples):
        """Process audio samples with noise blanking.
        
        Args:
            input_samples: Input audio samples (numpy array)
        
        Returns:
            Processed audio samples (numpy array)
        """
        if not self.enabled:
            return input_samples
        
        output = input_samples.copy()
        
        for i in range(len(input_samples)):
            sample = input_samples[i]
            abs_sample = abs(sample)
            
            # Update FFT buffer
            self.fft_buffer[self.fft_buffer_pos] = sample
            self.fft_buffer_pos = (self.fft_buffer_pos + 1) % self.fft_size
            
            # Update running average
            self.history_sum -= self.history[self.history_pos]
            self.history[self.history_pos] = abs_sample
            self.history_sum += abs_sample
            self.history_pos = (self.history_pos + 1) % self.avg_window
            self.avg_level = max(self.history_sum / self.avg_window, 0.0001)
            
            # Skip detection during warmup
            if self.warmup_counter < self.warmup_samples:
                self.warmup_counter += 1
                continue
            
            # Detect pulse - first check amplitude
            if abs_sample > self.avg_level * self.threshold:
                # Then check if it's broadband (impulse noise) or narrowband (speech)
                if self.is_broadband_click():
                    if self.blank_counter == 0:
                        self.pulses_detected += 1
                        # Log detection (rate-limited)
                        current_time = time.time()
                        if current_time - self.last_log_time > self.log_interval:
                            print(f"[NB] Broadband pulse detected! Sample={abs_sample:.6f}, Avg={self.avg_level:.6f}, "
                                  f"Threshold={self.avg_level * self.threshold:.6f}, Ratio={abs_sample/self.avg_level:.1f}x",
                                  file=sys.stderr)
                            self.last_log_time = current_time
                    # Start blanking from the MIDDLE of the window (maximum attenuation)
                    # so the detected pulse itself gets blanked
                    self.blank_counter = self.blank_samples
                else:
                    # Narrowband peak (likely speech) - don't blank
                    if self.blank_counter == 0:
                        self.false_positives_rejected += 1
                        current_time = time.time()
                        if current_time - self.last_log_time > self.log_interval:
                            print(f"[NB] Narrowband peak rejected (speech?) Sample={abs_sample:.6f}, "
                                  f"Ratio={abs_sample/self.avg_level:.1f}x",
                                  file=sys.stderr)
                            self.last_log_time = current_time
            
            # Apply windowed blanking
            if self.blank_counter > 0:
                # Calculate position in window (counts down from blank_samples to 1)
                # We want to apply maximum attenuation NOW (at detection), so we need
                # to map blank_counter to the middle of the window
                # When blank_counter = blank_samples (just detected), use middle of window
                # When blank_counter = 1 (end), use end of window
                window_pos = self.blank_samples - self.blank_counter
                
                # Apply window (attenuates in middle, preserves edges)
                attenuation = self.window[window_pos]
                output[i] = sample * attenuation
                
                self.blank_counter -= 1
            else:
                output[i] = sample
        
        return output
    
    def reset(self):
        """Reset noise blanker state."""
        self.history.fill(0)
        self.history_pos = 0
        self.history_sum = 0.0
        self.avg_level = 0.0001
        self.blank_counter = 0
        self.warmup_counter = 0
        self.pulses_detected = 0
        self.false_positives_rejected = 0
        self.last_log_time = 0
        self.fft_buffer.fill(0)
        self.fft_buffer_pos = 0
    
    def get_stats(self):
        """Get statistics about noise blanker operation."""
        return {
            'pulses_detected': self.pulses_detected,
            'false_positives_rejected': self.false_positives_rejected,
            'avg_level': self.avg_level,
            'threshold_level': self.avg_level * self.threshold,
            'blanking': self.blank_counter > 0,
            'spectral_flatness_threshold': self.spectral_flatness_threshold
        }


def create_noise_blanker(sample_rate=12000, threshold=10.0, avg_window_ms=20, spectral_flatness_threshold=0.3):
    """Create and configure a noise blanker.
    
    Args:
        sample_rate: Audio sample rate in Hz
        threshold: Detection threshold (multiplier of average level)
        avg_window_ms: Averaging window in milliseconds
        spectral_flatness_threshold: Threshold for broadband detection (0-1)
    
    Returns:
        Configured NoiseBlanker instance
    """
    nb = NoiseBlanker(sample_rate)
    nb.set_parameters(threshold=threshold, avg_window_ms=avg_window_ms, 
                     spectral_flatness_threshold=spectral_flatness_threshold)
    nb.enabled = True
    return nb
