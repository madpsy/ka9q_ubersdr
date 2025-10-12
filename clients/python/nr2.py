"""
NR2 Spectral Subtraction Noise Reduction
Implements overlap-add spectral subtraction similar to Hermes-Lite2 NR2
Translated from JavaScript implementation in static/nr2.js
"""

import numpy as np
from scipy import signal
from scipy.fft import rfft, irfft


class NR2Processor:
    """
    Spectral subtraction noise reduction processor using overlap-add technique.
    
    This implements a noise reduction algorithm that:
    1. Learns a noise profile during initial frames
    2. Subtracts the learned noise spectrum from the signal
    3. Adaptively tracks changing noise conditions
    4. Uses overlap-add for smooth output without artifacts
    """
    
    def __init__(self, sample_rate=12000, fft_size=2048, overlap_factor=4):
        """
        Initialize the NR2 processor.
        
        Args:
            sample_rate: Audio sample rate in Hz
            fft_size: FFT size (must be power of 2)
            overlap_factor: Overlap factor for overlap-add (typically 2 or 4)
        """
        self.sample_rate = sample_rate
        self.fft_size = fft_size
        self.hop_size = fft_size // overlap_factor
        self.overlap_factor = overlap_factor
        
        # Windowing (Hann window for smooth overlap-add)
        # Use sym=False to match JavaScript implementation (uses size-1 in denominator)
        self.window = np.array([0.5 * (1 - np.cos(2 * np.pi * i / (fft_size - 1)))
                                for i in range(fft_size)], dtype=np.float32)
        
        # Buffers
        self.input_buffer = np.zeros(fft_size, dtype=np.float32)
        self.output_buffer = np.zeros(fft_size, dtype=np.float32)
        self.overlap_buffer = np.zeros(fft_size, dtype=np.float32)
        
        # Noise profile (magnitude spectrum)
        # rfft produces fft_size//2 + 1 bins for real input
        self.noise_profile = np.zeros(fft_size // 2 + 1, dtype=np.float32)
        self.noise_profile_count = 0
        self.learning_frames = 30  # ~0.5 seconds at 60fps
        self.is_learning = True
        
        # Adaptive noise tracking
        self.adaptive_noise_tracking = True  # Continuously adapt to changing noise
        self.noise_adapt_rate = 0.01  # How fast to adapt (1% per frame)
        self.signal_threshold = 2.0  # Only update noise when signal < threshold * noise
        
        # Parameters (can be updated via set_parameters)
        self.alpha = 2.0  # Over-subtraction factor
        self.beta = 0.01  # Spectral floor
        
        # Processing state
        self.enabled = False
        
    def set_parameters(self, strength, floor, adapt_rate=None):
        """
        Update noise reduction parameters.
        
        Args:
            strength: Noise reduction strength (0-100%)
            floor: Spectral floor to prevent musical noise (0-10%)
            adapt_rate: Adaptation rate for noise tracking (0.1-5.0%)
        """
        # Strength 0-100% maps to alpha 1.0-4.0
        self.alpha = 1.0 + (strength / 100.0) * 3.0
        
        # Floor 0-10% maps to beta 0.001-0.1
        self.beta = 0.001 + (floor / 100.0) * 0.099
        
        # Adapt rate 0.1-5.0% maps to 0.001-0.05
        if adapt_rate is not None:
            self.noise_adapt_rate = adapt_rate / 100.0
    
    def reset_learning(self):
        """Reset noise learning to re-learn the noise profile."""
        self.noise_profile.fill(0)
        self.noise_profile_count = 0
        self.is_learning = True
    
    def process(self, input_samples):
        """
        Process a buffer of audio samples with noise reduction.
        
        Args:
            input_samples: Input audio samples as numpy array (float32)
            
        Returns:
            Processed audio samples as numpy array (float32)
        """
        input_length = len(input_samples)
        output = np.zeros(input_length, dtype=np.float32)
        
        input_pos = 0
        output_pos = 0
        
        while input_pos < input_length:
            # Fill input buffer
            samples_to_buffer = min(self.hop_size, input_length - input_pos)
            
            # Shift existing samples
            self.input_buffer[:-samples_to_buffer] = self.input_buffer[samples_to_buffer:]
            
            # Add new samples
            self.input_buffer[-samples_to_buffer:] = input_samples[input_pos:input_pos + samples_to_buffer]
            
            # Process frame
            self._process_frame()
            
            # Output samples
            samples_to_output = min(self.hop_size, output.shape[0] - output_pos)
            output[output_pos:output_pos + samples_to_output] = self.output_buffer[:samples_to_output]
            
            # Shift output buffer
            self.output_buffer[:-self.hop_size] = self.output_buffer[self.hop_size:]
            self.output_buffer[-self.hop_size:] = 0
            
            input_pos += samples_to_buffer
            output_pos += samples_to_output
        
        return output
    
    def _process_frame(self):
        """Process one FFT frame with spectral subtraction."""
        # Apply window to input
        windowed = self.input_buffer * self.window
        
        # Forward FFT (real FFT for efficiency)
        # rfft returns fft_size//2 + 1 complex values
        spectrum = rfft(windowed)
        
        # Calculate magnitude spectrum
        magnitude = np.abs(spectrum)
        
        # Learn noise profile
        if self.is_learning and self.noise_profile_count < self.learning_frames:
            self.noise_profile += magnitude
            self.noise_profile_count += 1
            
            if self.noise_profile_count >= self.learning_frames:
                # Average the noise profile
                self.noise_profile /= self.learning_frames
                self.is_learning = False
                print('NR2: Noise profile learned', flush=True)
            
            # During learning, pass through with window (matches JS line 142)
            # Apply COLA normalization for proper reconstruction
            self.output_buffer += windowed / 1.5
            return
        
        # Apply spectral subtraction if enabled
        if self.enabled and not self.is_learning:
            # Adaptive noise tracking: update noise profile when signal is weak
            if self.adaptive_noise_tracking:
                # Only update noise estimate when current magnitude is close to noise floor
                weak_signal_mask = magnitude < (self.signal_threshold * self.noise_profile)
                
                # Exponential moving average: slowly track noise changes
                self.noise_profile[weak_signal_mask] = (
                    (1 - self.noise_adapt_rate) * self.noise_profile[weak_signal_mask] +
                    self.noise_adapt_rate * magnitude[weak_signal_mask]
                )
            
            # Spectral subtraction with over-subtraction
            clean_magnitude = magnitude - self.alpha * self.noise_profile
            
            # Apply spectral floor to prevent musical noise
            clean_magnitude = np.maximum(clean_magnitude, self.beta * magnitude)
            
            # Update spectrum with cleaned magnitude (preserve phase)
            # Avoid division by zero
            scale = np.zeros_like(magnitude)
            nonzero_mask = magnitude > 0
            scale[nonzero_mask] = clean_magnitude[nonzero_mask] / magnitude[nonzero_mask]
            
            # Apply scale to complex spectrum
            spectrum = spectrum * scale
        
        # Inverse FFT
        # irfft automatically handles the conjugate symmetry for negative frequencies
        # Explicitly specify n=fft_size to ensure correct output length
        output_frame = irfft(spectrum, n=self.fft_size).astype(np.float32)
        
        # Overlap-add with window (matches JS line 191)
        # CRITICAL: With 4x overlap and Hann window applied twice (before FFT and here),
        # we need to normalize by the COLA sum to avoid amplitude modulation artifacts
        # For Hann window with 4x overlap, the COLA sum is 1.5 when window is applied twice
        # So we divide by 1.5 to get unity gain
        self.output_buffer += (output_frame * self.window) / 1.5


def create_nr2_processor(sample_rate=12000, strength=40, floor=10.0, adapt_rate=1.0):
    """
    Create and configure an NR2 processor with default parameters.
    
    Args:
        sample_rate: Audio sample rate in Hz
        strength: Noise reduction strength (0-100%, default 40%)
        floor: Spectral floor (0-10%, default 10%)
        adapt_rate: Adaptation rate (0.1-5.0%, default 1.0%)
        
    Returns:
        Configured NR2Processor instance
    """
    processor = NR2Processor(sample_rate=sample_rate)
    processor.set_parameters(strength, floor, adapt_rate)
    processor.enabled = True
    return processor