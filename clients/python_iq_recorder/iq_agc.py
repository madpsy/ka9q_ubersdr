#!/usr/bin/env python3
"""
Automatic Gain Control (AGC)
Simple but effective AGC for audio preview
"""

import numpy as np


class SimpleAGC:
    """Simple AGC with attack/decay and target level"""
    
    def __init__(self, target_level: float = 0.2, attack_time: float = 0.01,
                 decay_time: float = 0.5, sample_rate: int = 12000):
        """
        Initialize AGC
        
        Args:
            target_level: Target RMS level (0.0 to 1.0, default 0.2)
            attack_time: Attack time in seconds (default 0.01 = 10ms)
            decay_time: Decay time in seconds (default 0.5 = 500ms)
            sample_rate: Audio sample rate in Hz
        """
        self.target_level = target_level
        self.sample_rate = sample_rate
        
        # Calculate attack/decay coefficients
        # These determine how fast the gain changes
        self.attack_coef = 1.0 - np.exp(-1.0 / (attack_time * sample_rate))
        self.decay_coef = 1.0 - np.exp(-1.0 / (decay_time * sample_rate))
        
        # Current gain state
        self.current_gain = 1.0
        self.current_level = 0.0
        
        # Limits
        self.min_gain = 0.1   # Don't reduce gain below this
        self.max_gain = 100.0  # Don't increase gain above this
    
    def reset(self):
        """Reset AGC state"""
        self.current_gain = 1.0
        self.current_level = 0.0
    
    def process(self, audio: np.ndarray) -> np.ndarray:
        """
        Process audio through AGC
        
        Args:
            audio: Input audio samples (float32)
            
        Returns:
            AGC-processed audio samples
        """
        if len(audio) == 0:
            return audio
        
        # Calculate RMS level of input
        rms = np.sqrt(np.mean(audio ** 2))
        
        # Smooth the level measurement (attack/decay)
        if rms > self.current_level:
            # Attack: fast response to increasing levels
            self.current_level += self.attack_coef * (rms - self.current_level)
        else:
            # Decay: slow response to decreasing levels
            self.current_level += self.decay_coef * (rms - self.current_level)
        
        # Calculate desired gain
        if self.current_level > 1e-6:  # Avoid division by zero
            desired_gain = self.target_level / self.current_level
        else:
            desired_gain = self.max_gain
        
        # Limit gain
        desired_gain = np.clip(desired_gain, self.min_gain, self.max_gain)
        
        # Smooth gain changes (prevents clicks)
        if desired_gain > self.current_gain:
            # Increasing gain: use decay coefficient (slower)
            self.current_gain += self.decay_coef * (desired_gain - self.current_gain)
        else:
            # Decreasing gain: use attack coefficient (faster)
            self.current_gain += self.attack_coef * (desired_gain - self.current_gain)
        
        # Apply gain
        output = audio * self.current_gain
        
        # Hard clip to prevent values exceeding ±1.0 before soft limiting
        # This prevents the tanh from being driven too hard
        output = np.clip(output, -0.95, 0.95)
        
        # Soft limiting for smooth clipping (if it still occurs)
        # Using a gentler curve to avoid distortion
        output = np.tanh(output * 0.9) / 0.9
        
        return output
    
    def get_gain(self) -> float:
        """Get current gain value in dB"""
        return 20 * np.log10(self.current_gain) if self.current_gain > 0 else -100.0
    
    def get_level(self) -> float:
        """Get current input level"""
        return self.current_level
