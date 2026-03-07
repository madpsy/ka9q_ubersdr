#!/usr/bin/env python3
"""
IQ Demodulator Classes
Implements SSB and CW demodulation for amateur radio modes
"""

import numpy as np
from scipy import signal
from typing import Optional


class SSBDemodulator:
    """Single Sideband (USB/LSB) demodulator"""
    
    def __init__(self, sample_rate: int, audio_bandwidth: int = 2700, filter_order: int = 5):
        """
        Initialize SSB demodulator
        
        Args:
            sample_rate: IQ sample rate in Hz
            audio_bandwidth: Audio bandwidth in Hz (default 2700 for SSB)
            filter_order: Butterworth filter order (default 5)
        """
        self.sample_rate = sample_rate
        self.audio_bandwidth = audio_bandwidth
        self.filter_order = filter_order
        
        # Design lowpass filter for audio bandwidth
        nyquist = sample_rate / 2
        cutoff = min(audio_bandwidth / nyquist, 0.95)  # Ensure < 1.0
        
        try:
            self.filter_b, self.filter_a = signal.butter(
                filter_order, cutoff, btype='low'
            )
            # Initialize filter state for continuous processing
            self.filter_state = signal.lfilter_zi(self.filter_b, self.filter_a)
        except Exception as e:
            print(f"Warning: Filter design failed: {e}")
            # Fallback to no filtering
            self.filter_b = np.array([1.0])
            self.filter_a = np.array([1.0])
            self.filter_state = np.zeros(1)
    
    def reset(self):
        """Reset filter state"""
        self.filter_state = signal.lfilter_zi(self.filter_b, self.filter_a)
    
    def demodulate_usb(self, iq_samples: np.ndarray) -> np.ndarray:
        """
        Demodulate USB (Upper Sideband)
        
        Args:
            iq_samples: Complex IQ samples
            
        Returns:
            Demodulated audio samples (float32)
        """
        # USB: Take real part (I channel)
        # IQ samples are already at baseband (0 Hz = carrier)
        audio = np.real(iq_samples).astype(np.float32)
        
        # Lowpass filter to audio bandwidth
        if len(self.filter_b) > 1:
            audio_filtered, self.filter_state = signal.lfilter(
                self.filter_b, self.filter_a, audio, zi=self.filter_state
            )
        else:
            audio_filtered = audio
        
        return audio_filtered
    
    def demodulate_lsb(self, iq_samples: np.ndarray) -> np.ndarray:
        """
        Demodulate LSB (Lower Sideband)
        
        Args:
            iq_samples: Complex IQ samples
            
        Returns:
            Demodulated audio samples (float32)
        """
        # LSB: Take negative of real part (inverted I channel)
        audio = -np.real(iq_samples).astype(np.float32)
        
        # Lowpass filter
        if len(self.filter_b) > 1:
            audio_filtered, self.filter_state = signal.lfilter(
                self.filter_b, self.filter_a, audio, zi=self.filter_state
            )
        else:
            audio_filtered = audio
        
        return audio_filtered


class CWDemodulator:
    """CW (Morse Code) demodulator with audio tone generation"""
    
    def __init__(self, sample_rate: int, cw_pitch: int = 600, bandwidth: int = 500):
        """
        Initialize CW demodulator
        
        Args:
            sample_rate: IQ sample rate in Hz
            cw_pitch: Audio tone frequency in Hz (default 600)
            bandwidth: CW filter bandwidth in Hz (default 500)
        """
        self.sample_rate = sample_rate
        self.cw_pitch = cw_pitch
        self.bandwidth = bandwidth
        self.phase = 0.0  # Phase accumulator for tone generation
        
        # Design narrower bandpass filter for CW
        # Filter around DC (0 Hz) before adding tone
        nyquist = sample_rate / 2
        low_cutoff = max(50, bandwidth / 4) / nyquist  # Lower edge
        high_cutoff = min(bandwidth, nyquist * 0.95) / nyquist  # Upper edge
        
        try:
            self.filter_b, self.filter_a = signal.butter(
                4, high_cutoff, btype='low'
            )
            self.filter_state = signal.lfilter_zi(self.filter_b, self.filter_a)
        except Exception as e:
            print(f"Warning: CW filter design failed: {e}")
            self.filter_b = np.array([1.0])
            self.filter_a = np.array([1.0])
            self.filter_state = np.zeros(1)
    
    def reset(self):
        """Reset filter state and phase"""
        self.filter_state = signal.lfilter_zi(self.filter_b, self.filter_a)
        self.phase = 0.0
    
    def demodulate_cwu(self, iq_samples: np.ndarray) -> np.ndarray:
        """
        Demodulate CWU (CW Upper)
        
        For CW, we need to shift the signal by the BFO offset (cw_pitch)
        so that a CW carrier at DC (0 Hz) produces an audible tone.
        
        Args:
            iq_samples: Complex IQ samples (carrier should be at 0 Hz)
            
        Returns:
            Demodulated audio samples with CW tone (float32)
        """
        n_samples = len(iq_samples)
        
        # Generate BFO (Beat Frequency Oscillator) signal
        # This shifts the CW carrier to an audible frequency
        phase_increment = 2 * np.pi * self.cw_pitch / self.sample_rate
        phases = self.phase + phase_increment * np.arange(n_samples)
        
        # Create complex BFO signal (for proper frequency shift)
        bfo_signal = np.exp(1j * phases)
        
        # Update phase for continuity
        self.phase = (phases[-1] + phase_increment) % (2 * np.pi)
        
        # Mix IQ samples with BFO (frequency shift)
        shifted = iq_samples * bfo_signal
        
        # Take real part (this is the demodulated audio)
        audio = np.real(shifted).astype(np.float32)
        
        # Apply lowpass filter to remove high-frequency components
        if len(self.filter_b) > 1:
            audio_filtered, self.filter_state = signal.lfilter(
                self.filter_b, self.filter_a, audio, zi=self.filter_state
            )
        else:
            audio_filtered = audio
        
        return audio_filtered
    
    def demodulate_cwl(self, iq_samples: np.ndarray) -> np.ndarray:
        """
        Demodulate CWL (CW Lower)
        
        For CWL, we shift in the opposite direction (negative frequency)
        
        Args:
            iq_samples: Complex IQ samples (carrier should be at 0 Hz)
            
        Returns:
            Demodulated audio samples with CW tone (float32)
        """
        n_samples = len(iq_samples)
        
        # Generate BFO signal with negative frequency (for LSB)
        phase_increment = -2 * np.pi * self.cw_pitch / self.sample_rate
        phases = self.phase + phase_increment * np.arange(n_samples)
        
        # Create complex BFO signal
        bfo_signal = np.exp(1j * phases)
        
        # Update phase for continuity
        self.phase = (phases[-1] + phase_increment) % (2 * np.pi)
        
        # Mix IQ samples with BFO
        shifted = iq_samples * bfo_signal
        
        # Take real part
        audio = np.real(shifted).astype(np.float32)
        
        # Apply lowpass filter
        if len(self.filter_b) > 1:
            audio_filtered, self.filter_state = signal.lfilter(
                self.filter_b, self.filter_a, audio, zi=self.filter_state
            )
        else:
            audio_filtered = audio
        
        return audio_filtered


class FrequencyShifter:
    """Shifts IQ samples to a different center frequency"""
    
    def __init__(self, sample_rate: int):
        """
        Initialize frequency shifter
        
        Args:
            sample_rate: IQ sample rate in Hz
        """
        self.sample_rate = sample_rate
        self.phase = 0.0
    
    def reset(self):
        """Reset phase accumulator"""
        self.phase = 0.0
    
    def shift(self, iq_samples: np.ndarray, shift_hz: float) -> np.ndarray:
        """
        Shift IQ samples by specified frequency
        
        Args:
            iq_samples: Complex IQ samples
            shift_hz: Frequency shift in Hz (positive = shift up)
            
        Returns:
            Frequency-shifted IQ samples
        """
        if abs(shift_hz) < 1.0:
            return iq_samples  # No shift needed
        
        n_samples = len(iq_samples)
        
        # Generate complex exponential for frequency shift
        # e^(j*2*pi*f*t) shifts frequency up by f Hz
        phase_increment = 2 * np.pi * shift_hz / self.sample_rate
        phases = self.phase + phase_increment * np.arange(n_samples)
        shift_signal = np.exp(1j * phases)
        
        # Update phase for continuity
        self.phase = (phases[-1] + phase_increment) % (2 * np.pi)
        
        # Multiply to shift frequency
        shifted = iq_samples * shift_signal
        
        return shifted
