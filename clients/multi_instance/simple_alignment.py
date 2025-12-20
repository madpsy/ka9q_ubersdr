#!/usr/bin/env python3
"""
Simple Offset-Based Alignment System for Multi-Instance Client

This module provides a simplified alignment approach that uses pre-calculated
averaged timestamp offsets to align spectrum and audio data from multiple instances.

Unlike the complex buffering/interpolation system in timestamp_sync.py, this uses
fixed offsets derived from the 5-second averaged timestamp differences already
calculated in multi_spectrum_gui.py.
"""

import time
import threading
from typing import Dict, Optional, Tuple
import numpy as np


class SimpleAlignmentMetrics:
    """Simple metrics for monitoring alignment quality."""
    
    def __init__(self):
        self.offset_updates = 0
        self.last_update_time = 0.0
        self.active_offsets: Dict[int, float] = {}  # instance_id -> offset_ms
        
    def __str__(self) -> str:
        """String representation of metrics."""
        offset_count = len(self.active_offsets)
        if offset_count > 0:
            avg_offset = sum(abs(o) for o in self.active_offsets.values()) / offset_count
            return f"Active offsets: {offset_count}, Avg offset: {avg_offset:.1f}ms"
        return "No active offsets"


class SimpleSpectrumAligner:
    """
    Simple spectrum aligner using fixed timestamp offsets.
    
    This aligner doesn't buffer or interpolate data. Instead, it uses the
    averaged timestamp offsets calculated by the GUI to determine which
    instance's data is most current and should be displayed.
    
    Strategy:
    - Accept timestamp offset updates from the GUI
    - When displaying spectrum, use the offset to determine data freshness
    - No buffering, no interpolation - just offset-aware display
    """
    
    def __init__(self):
        self.offsets: Dict[int, float] = {}  # instance_id -> offset in milliseconds
        self.reference_instance: Optional[int] = None
        self.metrics = SimpleAlignmentMetrics()
        self.lock = threading.Lock()
        
    def update_offset(self, instance_id: int, offset_ms: float):
        """
        Update the timestamp offset for an instance.
        
        Args:
            instance_id: Instance identifier
            offset_ms: Offset in milliseconds (positive = ahead, negative = behind)
        """
        with self.lock:
            self.offsets[instance_id] = offset_ms
            self.metrics.active_offsets[instance_id] = offset_ms
            self.metrics.offset_updates += 1
            self.metrics.last_update_time = time.time()
            
            # Set reference instance (first one or the one with smallest absolute offset)
            if self.reference_instance is None:
                self.reference_instance = instance_id
            elif abs(offset_ms) < abs(self.offsets.get(self.reference_instance, float('inf'))):
                self.reference_instance = instance_id
    
    def get_aligned_timestamp(self, instance_id: int, raw_timestamp: float) -> float:
        """
        Get the aligned timestamp for an instance's data.
        
        Args:
            instance_id: Instance identifier
            raw_timestamp: Raw timestamp from the instance
            
        Returns:
            Aligned timestamp (adjusted by offset)
        """
        with self.lock:
            offset = self.offsets.get(instance_id, 0.0)
            # Subtract offset to align: if instance is ahead (+offset), subtract to bring back
            return raw_timestamp - offset
    
    def get_offset(self, instance_id: int) -> float:
        """
        Get the current offset for an instance.
        
        Args:
            instance_id: Instance identifier
            
        Returns:
            Offset in milliseconds (0.0 if not set)
        """
        with self.lock:
            return self.offsets.get(instance_id, 0.0)
    
    def clear_offset(self, instance_id: int):
        """
        Clear the offset for an instance.
        
        Args:
            instance_id: Instance identifier
        """
        with self.lock:
            if instance_id in self.offsets:
                del self.offsets[instance_id]
            if instance_id in self.metrics.active_offsets:
                del self.metrics.active_offsets[instance_id]
            
            # Update reference if needed
            if self.reference_instance == instance_id:
                if self.offsets:
                    self.reference_instance = min(self.offsets.keys(), 
                                                 key=lambda k: abs(self.offsets[k]))
                else:
                    self.reference_instance = None
    
    def get_metrics(self) -> SimpleAlignmentMetrics:
        """Get current alignment metrics."""
        with self.lock:
            return self.metrics


class SimpleAudioAligner:
    """
    Simple audio aligner using fixed timestamp offsets.
    
    This aligner applies time shifts to audio streams based on the averaged
    timestamp offsets. It's much simpler than the buffering/interpolation
    approach in timestamp_sync.py.
    
    Strategy:
    - Accept timestamp offset updates from the GUI
    - Apply sample delays/advances based on offsets
    - Use simple sample dropping/padding for alignment
    """
    
    def __init__(self, sample_rate: int = 12000):
        self.sample_rate = sample_rate
        self.offsets: Dict[int, float] = {}  # instance_id -> offset in milliseconds
        self.sample_offsets: Dict[int, int] = {}  # instance_id -> offset in samples
        self.delay_buffers: Dict[int, list] = {}  # instance_id -> ring buffer for delaying ahead instances
        self.reference_instance: Optional[int] = None
        self.metrics = SimpleAlignmentMetrics()
        self.lock = threading.Lock()
        self.last_overflow_log: Dict[int, float] = {}  # instance_id -> last log time
        
    def update_offset(self, instance_id: int, offset_ms: float):
        """
        Update the timestamp offset for an instance.
        
        Args:
            instance_id: Instance identifier
            offset_ms: Offset in milliseconds (positive = ahead, negative = behind)
        """
        with self.lock:
            old_offset = self.offsets.get(instance_id, 0.0)
            self.offsets[instance_id] = offset_ms
            # Convert to sample offset
            self.sample_offsets[instance_id] = int((offset_ms / 1000.0) * self.sample_rate)
            
            # Initialize delay buffer if needed
            if instance_id not in self.delay_buffers:
                self.delay_buffers[instance_id] = []
            
            self.metrics.active_offsets[instance_id] = offset_ms
            self.metrics.offset_updates += 1
            self.metrics.last_update_time = time.time()
            
            # Log offset changes (throttled)
            if abs(offset_ms - old_offset) > 5.0:  # Only log if change > 5ms
                print(f"[ALIGNMENT] Instance {instance_id}: Offset updated {old_offset:.1f}ms -> {offset_ms:.1f}ms (samples: {self.sample_offsets[instance_id]})")
            
            # Set reference instance (first one or the one with smallest absolute offset)
            if self.reference_instance is None:
                self.reference_instance = instance_id
            elif abs(offset_ms) < abs(self.offsets.get(self.reference_instance, float('inf'))):
                self.reference_instance = instance_id
    
    def apply_alignment(self, instance_id: int, audio_samples: np.ndarray) -> np.ndarray:
        """
        Apply alignment using a ring buffer delay for ahead instances.
        
        Handles dynamic offset changes including sign changes (ahead <-> behind).
        Uses gradual buffer adjustment to avoid audio glitches.
        
        Args:
            instance_id: Instance identifier
            audio_samples: Audio samples to align
            
        Returns:
            Aligned audio samples (delayed if instance is ahead)
        """
        with self.lock:
            target_offset_samples = self.sample_offsets.get(instance_id, 0)
            
            # Initialize delay buffer if it doesn't exist
            if instance_id not in self.delay_buffers:
                self.delay_buffers[instance_id] = []
            
            # Get delay buffer for this instance
            delay_buffer = self.delay_buffers[instance_id]
            
            if target_offset_samples == 0:
                # No offset - clear buffer and play immediately
                if delay_buffer:
                    delay_buffer.clear()
                return audio_samples
            
            if target_offset_samples > 0:
                # Instance is AHEAD - need to delay it
                # Add incoming samples to delay buffer
                delay_buffer.extend(audio_samples.tolist())
                
                # Prevent buffer overflow: limit to 2 seconds total
                max_buffer_size = self.sample_rate * 2  # 2 seconds absolute max
                
                # Handle buffer size adjustment
                if len(delay_buffer) > max_buffer_size:
                    # Emergency: buffer way too large, drop to target immediately
                    excess = len(delay_buffer) - target_offset_samples
                    del delay_buffer[:excess]
                    
                    current_time = time.time()
                    last_log = self.last_overflow_log.get(instance_id, 0)
                    if current_time - last_log > 5.0:
                        print(f"[ALIGNMENT] Instance {instance_id}: Emergency buffer trim - dropped {excess} samples "
                              f"(was {len(delay_buffer) + excess}, target {target_offset_samples})")
                        self.last_overflow_log[instance_id] = current_time
                
                elif len(delay_buffer) > target_offset_samples + (self.sample_rate // 2):
                    # Buffer is more than 500ms over target - gradually reduce
                    # Drop a small amount each cycle to smoothly converge
                    drop_amount = min(len(audio_samples) // 4, len(delay_buffer) - target_offset_samples)
                    if drop_amount > 0:
                        del delay_buffer[:drop_amount]
                        
                        current_time = time.time()
                        last_log = self.last_overflow_log.get(f"adjust_{instance_id}", 0)
                        if current_time - last_log > 5.0:
                            print(f"[ALIGNMENT] Instance {instance_id}: Gradually reducing buffer "
                                  f"(dropped {drop_amount}, now {len(delay_buffer)}, target {target_offset_samples})")
                            self.last_overflow_log[f"adjust_{instance_id}"] = current_time
                
                # Only output samples if we have enough buffered to maintain the delay
                if len(delay_buffer) >= target_offset_samples:
                    # Output the oldest samples (maintaining the delay)
                    output_count = min(len(audio_samples), len(delay_buffer) - target_offset_samples)
                    if output_count > 0:
                        output_samples = np.array(delay_buffer[:output_count], dtype=audio_samples.dtype)
                        del delay_buffer[:output_count]
                        # If we couldn't output all requested samples, pad with zeros
                        if output_count < len(audio_samples):
                            padding = np.zeros(len(audio_samples) - output_count, dtype=audio_samples.dtype)
                            return np.concatenate([output_samples, padding])
                        return output_samples
                    else:
                        # Buffer is exactly at target, return silence to maintain delay
                        return np.zeros(len(audio_samples), dtype=audio_samples.dtype)
                else:
                    # Still building up the delay buffer, return silence
                    current_time = time.time()
                    last_log = self.last_overflow_log.get(f"build_{instance_id}", 0)
                    if current_time - last_log > 2.0:
                        print(f"[ALIGNMENT] Instance {instance_id}: Building delay buffer "
                              f"({len(delay_buffer)}/{target_offset_samples} samples, {len(delay_buffer)/self.sample_rate*1000:.1f}ms/{target_offset_samples/self.sample_rate*1000:.1f}ms)")
                        self.last_overflow_log[f"build_{instance_id}"] = current_time
                    return np.zeros(len(audio_samples), dtype=audio_samples.dtype)
            else:
                # Instance is BEHIND (negative offset) - play immediately
                # Gradually drain any existing delay buffer to avoid glitches
                if delay_buffer:
                    # If there's still audio in the buffer, output it first before new audio
                    # This provides smooth transition when switching from ahead to behind
                    if len(delay_buffer) > 0:
                        output_count = min(len(audio_samples), len(delay_buffer))
                        output_samples = np.array(delay_buffer[:output_count], dtype=audio_samples.dtype)
                        del delay_buffer[:output_count]
                        
                        # If we output less than requested, fill the rest with new audio
                        if output_count < len(audio_samples):
                            remaining = audio_samples[:len(audio_samples) - output_count]
                            return np.concatenate([output_samples, remaining])
                        return output_samples
                
                # No buffer or buffer empty - play new audio immediately
                return audio_samples
    
    def get_sample_offset(self, instance_id: int) -> int:
        """
        Get the current sample offset for an instance.
        
        Args:
            instance_id: Instance identifier
            
        Returns:
            Offset in samples (0 if not set)
        """
        with self.lock:
            return self.sample_offsets.get(instance_id, 0)
    
    def clear_offset(self, instance_id: int):
        """
        Clear the offset for an instance and clean up all associated state.
        
        Args:
            instance_id: Instance identifier
        """
        with self.lock:
            if instance_id in self.offsets:
                del self.offsets[instance_id]
            if instance_id in self.sample_offsets:
                del self.sample_offsets[instance_id]
            if instance_id in self.delay_buffers:
                self.delay_buffers[instance_id].clear()  # Clear the delay buffer!
            if instance_id in self.metrics.active_offsets:
                del self.metrics.active_offsets[instance_id]
            
            # Clear log throttling state for this instance
            keys_to_remove = [k for k in list(self.last_overflow_log.keys())
                            if str(instance_id) in str(k)]
            for key in keys_to_remove:
                del self.last_overflow_log[key]
            
            # Update reference if needed
            if self.reference_instance == instance_id:
                if self.offsets:
                    self.reference_instance = min(self.offsets.keys(),
                                                 key=lambda k: abs(self.offsets[k]))
                else:
                    self.reference_instance = None
    
    def get_metrics(self) -> SimpleAlignmentMetrics:
        """Get current alignment metrics."""
        with self.lock:
            return self.metrics


# Convenience function to extract offset from GUI comparison data
def extract_offset_from_comparison(comparison_timestamp_history: dict, 
                                   instance_a_id: int, 
                                   instance_b_id: int) -> Optional[Tuple[float, float]]:
    """
    Extract averaged timestamp offset from GUI comparison history.
    
    Args:
        comparison_timestamp_history: The GUI's comparison_timestamp_history dict
        instance_a_id: First instance ID
        instance_b_id: Second instance ID
        
    Returns:
        Tuple of (offset_a_ms, offset_b_ms) relative to reference, or None if no data
        
    Note:
        The GUI stores differences as 'a_id:b_id' -> [(time, timestamp_diff_ms)]
        where timestamp_diff_ms = ts_a - ts_b
    """
    key = f"{instance_a_id}:{instance_b_id}"
    
    if key not in comparison_timestamp_history:
        return None
    
    history = comparison_timestamp_history[key]
    if len(history) < 3:  # Need at least 3 samples for stability
        return None
    
    # Calculate average offset over the history window
    avg_diff = sum(entry[1] for entry in history) / len(history)
    
    # Convert to offsets relative to a reference (use instance B as reference)
    # If avg_diff > 0, A is ahead of B
    # If avg_diff < 0, B is ahead of A
    offset_a = avg_diff  # A's offset relative to B
    offset_b = 0.0       # B is the reference
    
    return (offset_a, offset_b)