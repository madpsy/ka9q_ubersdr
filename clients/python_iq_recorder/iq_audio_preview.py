#!/usr/bin/env python3
"""
IQ Audio Preview Controller
Manages audio preview with frequency shifting and demodulation
"""

import numpy as np
import threading
from typing import Optional
from collections import deque

from iq_demodulator import SSBDemodulator, CWDemodulator, FrequencyShifter
from iq_audio_output import AudioOutputManager
from iq_agc import SimpleAGC


class AudioPreviewController:
    """Controls audio preview with hover-based frequency selection"""
    
    def __init__(self, sample_rate: int, center_freq: int, audio_sample_rate: int = 48000):
        """
        Initialize audio preview controller
        
        Args:
            sample_rate: IQ sample rate in Hz
            center_freq: Center frequency of IQ stream in Hz
            audio_sample_rate: Output audio sample rate in Hz (default 48000)
        """
        self.sample_rate = sample_rate
        self.center_freq = center_freq
        self.audio_sample_rate = audio_sample_rate
        
        # Audio preview state
        self.enabled = False
        self.mode = 'USB'  # USB, LSB, CWU, CWL
        self.target_freq = center_freq  # Frequency to demodulate
        self.lock = threading.Lock()
        
        # Demodulators
        self.demod_usb = SSBDemodulator(sample_rate, audio_bandwidth=2700)
        self.demod_lsb = SSBDemodulator(sample_rate, audio_bandwidth=2700)
        self.demod_cwu = CWDemodulator(sample_rate, cw_pitch=600, bandwidth=500)
        self.demod_cwl = CWDemodulator(sample_rate, cw_pitch=600, bandwidth=500)
        
        # Frequency shifter
        self.freq_shifter = FrequencyShifter(sample_rate)
        
        # Audio output (stereo for channel control)
        self.audio_output = AudioOutputManager(
            sample_rate=audio_sample_rate,
            channels=2,
            buffer_size=1024
        )
        
        # Resampler (if needed)
        self.needs_resampling = (sample_rate != audio_sample_rate)
        if self.needs_resampling:
            try:
                import samplerate
                self.resampler = samplerate.Resampler('sinc_fastest', channels=1)
                self.resample_ratio = audio_sample_rate / sample_rate
                print(f"Audio resampling: {sample_rate} Hz -> {audio_sample_rate} Hz")
            except ImportError:
                print("Warning: samplerate not available, using decimation")
                self.resampler = None
                self.resample_ratio = audio_sample_rate / sample_rate
        else:
            self.resampler = None
            self.resample_ratio = 1.0
        
        # AGC (Automatic Gain Control)
        self.agc = SimpleAGC(
            target_level=0.3,      # Target 30% of full scale
            attack_time=0.01,      # 10ms attack
            decay_time=0.5,        # 500ms decay
            sample_rate=audio_sample_rate
        )
        self.agc_enabled = True  # AGC enabled by default
    
    def start(self) -> bool:
        """
        Start audio preview
        
        Returns:
            True if started successfully
        """
        if not self.audio_output.is_available():
            print("Error: Audio output not available")
            return False
        
        with self.lock:
            if self.enabled:
                return True
            
            # Start audio output
            if not self.audio_output.start():
                return False
            
            # Reset demodulators
            self.demod_usb.reset()
            self.demod_lsb.reset()
            self.demod_cwu.reset()
            self.demod_cwl.reset()
            self.freq_shifter.reset()
            self.agc.reset()
            
            self.enabled = True
            print(f"Audio preview started: {self.mode} @ {self.target_freq/1e6:.6f} MHz (AGC enabled)")
            return True
    
    def stop(self):
        """Stop audio preview"""
        with self.lock:
            if not self.enabled:
                return
            
            self.enabled = False
            self.audio_output.stop()
            print("Audio preview stopped")
    
    def set_mode(self, mode: str):
        """
        Set demodulation mode
        
        Args:
            mode: 'USB', 'LSB', 'CWU', or 'CWL'
        """
        with self.lock:
            if mode in ['USB', 'LSB', 'CWU', 'CWL']:
                self.mode = mode
                # Reset demodulators when mode changes
                self.demod_usb.reset()
                self.demod_lsb.reset()
                self.demod_cwu.reset()
                self.demod_cwl.reset()
                self.freq_shifter.reset()

    def set_bandwidth(self, bandwidth_hz: int):
        """
        Set demodulation bandwidth

        Args:
            bandwidth_hz: Bandwidth in Hz
        """
        with self.lock:
            # Update SSB demodulators
            self.demod_usb.set_bandwidth(bandwidth_hz)
            self.demod_lsb.set_bandwidth(bandwidth_hz)
            # Update CW demodulators
            self.demod_cwu.set_bandwidth(bandwidth_hz)
            self.demod_cwl.set_bandwidth(bandwidth_hz)
    
    def set_target_frequency(self, freq_hz: int):
        """
        Set target frequency to demodulate
        
        Args:
            freq_hz: Frequency in Hz
        """
        with self.lock:
            self.target_freq = freq_hz
    
    def set_volume(self, volume: float):
        """
        Set audio volume
        
        Args:
            volume: Volume level (0.0 to 1.0)
        """
        self.audio_output.set_volume(volume)
    
    def get_volume(self) -> float:
        """Get current volume"""
        return self.audio_output.get_volume()
    
    def process_iq_samples(self, iq_samples: np.ndarray):
        """
        Process IQ samples and output audio
        
        Args:
            iq_samples: Complex IQ samples centered at center_freq
        """
        with self.lock:
            if not self.enabled:
                return
            
            try:
                # Calculate frequency shift needed
                # IQ samples are centered at center_freq
                # We want to shift so target_freq is at DC (0 Hz)
                shift_hz = self.center_freq - self.target_freq
                
                # Shift frequency if needed
                if abs(shift_hz) > 10:  # Only shift if > 10 Hz difference
                    shifted_iq = self.freq_shifter.shift(iq_samples, shift_hz)
                else:
                    shifted_iq = iq_samples
                
                # Demodulate based on mode
                if self.mode == 'USB':
                    audio = self.demod_usb.demodulate_usb(shifted_iq)
                elif self.mode == 'LSB':
                    audio = self.demod_lsb.demodulate_lsb(shifted_iq)
                elif self.mode == 'CWU':
                    audio = self.demod_cwu.demodulate_cwu(shifted_iq)
                    # Apply CW gain boost (CW signals are typically much weaker)
                    audio = audio * 10.0
                elif self.mode == 'CWL':
                    audio = self.demod_cwl.demodulate_cwl(shifted_iq)
                    # Apply CW gain boost (CW signals are typically much weaker)
                    audio = audio * 10.0
                else:
                    audio = np.real(shifted_iq).astype(np.float32)
                
                # Resample if needed
                if self.needs_resampling and len(audio) > 0:
                    if self.resampler is not None:
                        # Use high-quality resampler
                        audio = self.resampler.process(audio, self.resample_ratio)
                    else:
                        # Simple decimation/interpolation
                        if self.resample_ratio < 1.0:
                            # Decimate
                            step = int(1.0 / self.resample_ratio)
                            audio = audio[::step]
                        # For upsampling, just use original (not ideal but simple)
                
                # Apply AGC if enabled
                if len(audio) > 0:
                    if self.agc_enabled:
                        audio = self.agc.process(audio)
                    else:
                        # Simple normalization without AGC
                        max_val = np.max(np.abs(audio))
                        if max_val > 0.9:
                            audio = audio / max_val * 0.9
                    
                    # Output audio
                    self.audio_output.write(audio)
                    
            except Exception as e:
                print(f"Error processing audio: {e}")
    
    def is_enabled(self) -> bool:
        """Check if audio preview is enabled"""
        return self.enabled
    
    def get_mode(self) -> str:
        """Get current demodulation mode"""
        return self.mode
    
    def get_target_frequency(self) -> int:
        """Get current target frequency"""
        return self.target_freq
    
    def get_stats(self) -> dict:
        """Get audio statistics"""
        stats = self.audio_output.get_stats()
        stats['mode'] = self.mode
        stats['target_freq'] = self.target_freq
        stats['enabled'] = self.enabled
        if self.agc_enabled:
            stats['agc_gain_db'] = self.agc.get_gain()
            stats['agc_level'] = self.agc.get_level()
        return stats
    
    def set_agc_enabled(self, enabled: bool):
        """Enable or disable AGC"""
        self.agc_enabled = enabled
        if enabled:
            self.agc.reset()
    
    def is_agc_enabled(self) -> bool:
        """Check if AGC is enabled"""
        return self.agc_enabled
    
    def set_channels(self, left_enabled: bool, right_enabled: bool):
        """
        Set which audio channels are enabled
        
        Args:
            left_enabled: Enable left channel
            right_enabled: Enable right channel
        """
        self.audio_output.set_channels(left_enabled, right_enabled)
