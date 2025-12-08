#!/usr/bin/env python3
"""
Real-Time Audio Alignment System

Implements lock-free, continuous audio alignment for multi-instance SDR streaming.
Based on the architecture documented in REALTIME_AUDIO_ALIGNMENT_ARCHITECTURE.md
"""

import time
import threading
from typing import Optional, Dict, Tuple, List
from dataclasses import dataclass, field
from collections import deque
import numpy as np


@dataclass
class RealtimeAlignmentMetrics:
    """Metrics for real-time alignment system."""
    
    # Latency
    end_to_end_latency_ms: float = 0.0
    alignment_latency_ms: float = 0.0
    
    # Quality
    alignment_success_rate: float = 1.0
    timestamp_jitter_ms: float = 0.0
    
    # Performance
    cpu_usage_percent: float = 0.0
    alignment_thread_fps: float = 0.0
    
    # Buffer health
    playback_buffer_utilization: float = 0.5
    ring_buffer_utilization: Dict[int, float] = field(default_factory=dict)
    underrun_count: int = 0
    
    # Clock drift
    clock_drift_rate: Dict[int, float] = field(default_factory=dict)
    
    def is_healthy(self) -> bool:
        """Check if system is operating normally."""
        return (
            self.alignment_success_rate > 0.90 and
            self.timestamp_jitter_ms < 100 and
            self.playback_buffer_utilization > 0.1 and
            self.cpu_usage_percent < 10
        )


class LockFreeRingBuffer:
    """
    Single-producer, single-consumer lock-free ring buffer.
    Uses atomic operations for thread-safe access without locks.
    
    This is safe because:
    - Only one thread writes (producer)
    - Only one thread reads (consumer)
    - Read and write positions are independent
    """
    
    def __init__(self, capacity: int):
        """
        Initialize ring buffer.
        
        Args:
            capacity: Maximum number of items to store
        """
        self.capacity = capacity
        self.buffer: List[Tuple[float, np.ndarray]] = [(0.0, np.array([]))] * capacity
        self.write_pos = 0  # Only modified by producer
        self.read_pos = 0   # Only modified by consumer
        
    def write(self, timestamp: float, data: np.ndarray) -> bool:
        """
        Producer writes data. Returns False if buffer full.
        
        Args:
            timestamp: Timestamp in milliseconds
            data: Audio samples as numpy array
            
        Returns:
            True if written successfully, False if buffer full
        """
        next_write = (self.write_pos + 1) % self.capacity
        if next_write == self.read_pos:
            return False  # Buffer full
        
        self.buffer[self.write_pos] = (timestamp, data.copy())
        self.write_pos = next_write  # Atomic update
        return True
    
    def read(self) -> Optional[Tuple[float, np.ndarray]]:
        """
        Consumer reads data. Returns None if buffer empty.
        
        Returns:
            (timestamp, data) tuple or None if empty
        """
        if self.read_pos == self.write_pos:
            return None  # Buffer empty
        
        data = self.buffer[self.read_pos]
        self.read_pos = (self.read_pos + 1) % self.capacity
        return data
    
    def peek(self, offset: int = 0) -> Optional[Tuple[float, np.ndarray]]:
        """
        Peek at data without removing it.
        
        Args:
            offset: Number of items ahead to peek (0 = next item)
            
        Returns:
            (timestamp, data) tuple or None if not available
        """
        if offset >= self.available():
            return None
        
        pos = (self.read_pos + offset) % self.capacity
        return self.buffer[pos]
    
    def available(self) -> int:
        """Number of items available to read."""
        if self.write_pos >= self.read_pos:
            return self.write_pos - self.read_pos
        return self.capacity - self.read_pos + self.write_pos
    
    def space_available(self) -> int:
        """Space available for writing."""
        return self.capacity - self.available() - 1
    
    def utilization(self) -> float:
        """Buffer utilization as percentage (0.0 to 1.0)."""
        return self.available() / self.capacity if self.capacity > 0 else 0.0
    
    def clear(self):
        """Clear all data from buffer."""
        self.read_pos = self.write_pos


class PlaybackBuffer:
    """
    Lock-free circular buffer for audio callback consumption.
    Optimized for low-latency, high-frequency access.
    
    Uses numpy arrays for efficient sample storage and retrieval.
    """
    
    def __init__(self, capacity_samples: int = 24000):  # 2 seconds @ 12kHz
        """
        Initialize playback buffer.
        
        Args:
            capacity_samples: Buffer capacity in samples
        """
        self.capacity = capacity_samples
        self.buffer = np.zeros(capacity_samples, dtype=np.int16)
        self.write_pos = 0
        self.read_pos = 0
        
    def write_samples(self, samples: np.ndarray) -> int:
        """
        Write samples to buffer. Returns number written.
        
        Args:
            samples: Audio samples to write
            
        Returns:
            Number of samples actually written
        """
        available_space = self._available_space()
        to_write = min(len(samples), available_space)
        
        if to_write == 0:
            return 0
        
        # Handle wrap-around
        end_pos = self.write_pos + to_write
        if end_pos <= self.capacity:
            self.buffer[self.write_pos:end_pos] = samples[:to_write]
        else:
            # Split write
            first_part = self.capacity - self.write_pos
            self.buffer[self.write_pos:] = samples[:first_part]
            self.buffer[:to_write - first_part] = samples[first_part:to_write]
        
        self.write_pos = (self.write_pos + to_write) % self.capacity
        return to_write
    
    def read_samples(self, num_samples: int) -> np.ndarray:
        """
        Read samples from buffer. Pads with zeros if insufficient data.
        
        Args:
            num_samples: Number of samples to read
            
        Returns:
            Array of samples (zero-padded if needed)
        """
        available = self._available_samples()
        to_read = min(num_samples, available)
        
        result = np.zeros(num_samples, dtype=np.int16)
        
        if to_read > 0:
            # Handle wrap-around
            end_pos = self.read_pos + to_read
            if end_pos <= self.capacity:
                result[:to_read] = self.buffer[self.read_pos:end_pos]
            else:
                # Split read
                first_part = self.capacity - self.read_pos
                result[:first_part] = self.buffer[self.read_pos:]
                result[first_part:to_read] = self.buffer[:to_read - first_part]
            
            self.read_pos = (self.read_pos + to_read) % self.capacity
        
        return result
    
    def _available_samples(self) -> int:
        """Number of samples available to read."""
        if self.write_pos >= self.read_pos:
            return self.write_pos - self.read_pos
        return self.capacity - self.read_pos + self.write_pos
    
    def _available_space(self) -> int:
        """Space available for writing."""
        return self.capacity - self._available_samples() - 1
    
    def utilization(self) -> float:
        """Buffer utilization percentage (0.0 to 1.0)."""
        return self._available_samples() / self.capacity if self.capacity > 0 else 0.0
    
    def clear(self):
        """Clear all data from buffer."""
        self.read_pos = self.write_pos
        self.buffer.fill(0)


class ClockDriftCompensator:
    """
    Detects and compensates for clock drift between instances.
    Reused from timestamp_sync.py with minor adaptations.
    """
    
    def __init__(self, calibration_interval_s: float = 60.0, history_size: int = 100):
        """
        Initialize clock drift compensator.
        
        Args:
            calibration_interval_s: Seconds between recalibrations
            history_size: Number of measurements to keep
        """
        self.calibration_interval = calibration_interval_s
        self.history_size = history_size
        
        self.offsets: Dict[int, float] = {}  # instance_id -> current offset (ms)
        self.offset_history: Dict[int, deque] = {}  # instance_id -> [(time, offset), ...]
        self.drift_rates: Dict[int, float] = {}  # instance_id -> drift rate (ms/second)
        self.reference_instance: Optional[int] = None
        self.last_calibration = time.time()
    
    def measure_offset(self, instance_id: int, server_timestamp: float):
        """
        Measure current offset between server and local time.
        
        Args:
            instance_id: Instance identifier
            server_timestamp: Timestamp from server (milliseconds)
        """
        local_timestamp = time.time() * 1000  # Convert to milliseconds
        offset = server_timestamp - local_timestamp
        
        # Initialize history if needed
        if instance_id not in self.offset_history:
            self.offset_history[instance_id] = deque(maxlen=self.history_size)
        
        # Store measurement
        self.offset_history[instance_id].append((time.time(), offset))
        
        # Update current offset (use median to filter outliers)
        recent_offsets = [o for _, o in list(self.offset_history[instance_id])[-10:]]
        if recent_offsets:
            self.offsets[instance_id] = float(np.median(recent_offsets))
        
        # Set reference instance (first one we see)
        if self.reference_instance is None:
            self.reference_instance = instance_id
    
    def calculate_drift_rate(self, instance_id: int) -> float:
        """
        Calculate drift rate for an instance.
        
        Returns:
            Drift rate in milliseconds per second
        """
        if instance_id not in self.offset_history:
            return 0.0
        
        history = list(self.offset_history[instance_id])
        if len(history) < 10:
            return 0.0
        
        # Linear regression on offset over time
        times = np.array([t for t, _ in history])
        offsets = np.array([o for _, o in history])
        
        # Normalize time to seconds since first measurement
        times = times - times[0]
        
        # Calculate slope (drift rate)
        if len(times) > 1:
            try:
                drift_rate = float(np.polyfit(times, offsets, 1)[0])
                self.drift_rates[instance_id] = drift_rate
                return drift_rate
            except:
                return 0.0
        
        return 0.0
    
    def normalize_timestamp(self, instance_id: int, timestamp: float) -> float:
        """
        Normalize timestamp to common reference.
        
        Args:
            instance_id: Instance identifier
            timestamp: Raw timestamp from server
        
        Returns:
            Normalized timestamp relative to reference instance
        """
        if instance_id not in self.offsets:
            return timestamp
        
        if self.reference_instance is None:
            return timestamp
        
        # Get offset relative to reference
        instance_offset = self.offsets.get(instance_id, 0)
        reference_offset = self.offsets.get(self.reference_instance, 0)
        
        # Apply correction
        correction = instance_offset - reference_offset
        normalized = timestamp - correction
        
        # Apply drift compensation if available
        if instance_id in self.drift_rates:
            elapsed = time.time() - self.last_calibration
            drift_correction = self.drift_rates[instance_id] * elapsed
            normalized -= drift_correction
        
        return normalized
    
    def recalibrate(self):
        """Recalibrate drift rates and offsets."""
        for instance_id in list(self.offsets.keys()):
            self.calculate_drift_rate(instance_id)
        self.last_calibration = time.time()
    
    def should_recalibrate(self) -> bool:
        """Check if recalibration is needed."""
        return (time.time() - self.last_calibration) >= self.calibration_interval


class ContinuousAlignmentThread(threading.Thread):
    """
    Background thread that continuously aligns audio samples.
    Runs independently of audio callback for smooth operation.
    """
    
    def __init__(self, sample_rate: int = 12000, target_buffer_ms: float = 150):
        """
        Initialize continuous alignment thread.
        
        Args:
            sample_rate: Audio sample rate in Hz
            target_buffer_ms: Target buffer size in milliseconds
        """
        super().__init__(daemon=True, name="AudioAlignmentThread")
        self.sample_rate = sample_rate
        self.target_buffer_ms = target_buffer_ms
        self.running = False
        
        # Input buffers (one per instance)
        self.input_buffers: Dict[int, LockFreeRingBuffer] = {}
        
        # Output buffer (aligned samples ready for playback)
        self.output_buffer = PlaybackBuffer(capacity_samples=sample_rate * 2)  # 2 seconds
        
        # Alignment state
        self.alignment_chunk_samples = int(sample_rate * 0.04)  # 40ms chunks
        self.alignment_tolerance_ms = 50.0
        
        # Clock drift compensation
        self.drift_compensator = ClockDriftCompensator()
        
        # Metrics
        self.metrics = RealtimeAlignmentMetrics()
        self.total_alignments = 0
        self.successful_alignments = 0
        self.last_alignment_time = 0
        self.alignment_times = deque(maxlen=100)
        
    def add_instance(self, instance_id: int, buffer_capacity: int = 200):
        """
        Add an instance to track.
        
        Args:
            instance_id: Instance identifier
            buffer_capacity: Ring buffer capacity
        """
        if instance_id not in self.input_buffers:
            self.input_buffers[instance_id] = LockFreeRingBuffer(capacity=buffer_capacity)
    
    def add_data(self, instance_id: int, timestamp: float, audio_data: np.ndarray):
        """
        Add timestamped audio data from an instance.
        
        Args:
            instance_id: Instance identifier
            timestamp: Timestamp in milliseconds
            audio_data: Audio samples as numpy array
        """
        # Ensure instance exists
        if instance_id not in self.input_buffers:
            self.add_instance(instance_id)
        
        # Measure clock offset
        self.drift_compensator.measure_offset(instance_id, timestamp)
        
        # Normalize timestamp
        normalized_ts = self.drift_compensator.normalize_timestamp(instance_id, timestamp)
        
        # Write to ring buffer (non-blocking)
        success = self.input_buffers[instance_id].write(normalized_ts, audio_data)
        
        if not success:
            # Buffer full - this shouldn't happen often
            pass
    
    def start(self):
        """Start the alignment thread."""
        self.running = True
        super().start()
    
    def stop(self):
        """Stop the alignment thread."""
        self.running = False
    
    def run(self):
        """Main alignment loop - runs continuously."""
        while self.running:
            try:
                start_time = time.time()
                
                # Calculate how much aligned audio we need
                available = self.output_buffer._available_samples()
                target_samples = int(self.sample_rate * self.target_buffer_ms / 1000)
                
                if available < target_samples:
                    # Need more aligned samples
                    self._align_next_chunk()
                else:
                    # Buffer is full enough, sleep briefly
                    time.sleep(0.001)  # 1ms sleep
                
                # Update metrics
                elapsed = time.time() - start_time
                self.alignment_times.append(elapsed)
                
                # Recalibrate clock drift if needed
                if self.drift_compensator.should_recalibrate():
                    self.drift_compensator.recalibrate()
                    
            except Exception as e:
                print(f"Alignment error: {e}")
                time.sleep(0.01)
    
    def _align_next_chunk(self):
        """Align the next chunk of samples."""
        self.total_alignments += 1
        
        # Determine target timestamp (current time - buffer delay)
        target_ts = time.time() * 1000 - 100  # 100ms behind real-time
        
        # Collect samples from all instances near target timestamp
        aligned_samples = {}
        timestamps_found = []
        
        for instance_id, ring_buffer in self.input_buffers.items():
            # Find samples closest to target timestamp
            sample = self._find_nearest_sample(ring_buffer, target_ts)
            if sample:
                ts, data = sample
                aligned_samples[instance_id] = data
                timestamps_found.append(ts)
        
        # If we have samples from all instances, write to output
        if len(aligned_samples) == len(self.input_buffers) and aligned_samples:
            # Mix/combine samples as needed
            mixed = self._mix_samples(aligned_samples)
            
            # Write to output buffer
            written = self.output_buffer.write_samples(mixed)
            
            if written > 0:
                self.successful_alignments += 1
                
                # Update jitter metric
                if len(timestamps_found) > 1:
                    jitter = float(np.std(timestamps_found))
                    alpha = 0.1
                    self.metrics.timestamp_jitter_ms = (
                        alpha * jitter + (1 - alpha) * self.metrics.timestamp_jitter_ms
                    )
        
        # Update success rate
        if self.total_alignments > 0:
            self.metrics.alignment_success_rate = (
                self.successful_alignments / self.total_alignments
            )
        
        # Update buffer utilization
        self.metrics.playback_buffer_utilization = self.output_buffer.utilization()
        for instance_id, buffer in self.input_buffers.items():
            self.metrics.ring_buffer_utilization[instance_id] = buffer.utilization()
        
        # Update alignment FPS
        if len(self.alignment_times) > 10:
            avg_time = sum(self.alignment_times) / len(self.alignment_times)
            self.metrics.alignment_thread_fps = 1.0 / avg_time if avg_time > 0 else 0
    
    def _find_nearest_sample(self, ring_buffer: LockFreeRingBuffer, 
                            target_ts: float) -> Optional[Tuple[float, np.ndarray]]:
        """
        Find sample closest to target timestamp.
        
        Args:
            ring_buffer: Ring buffer to search
            target_ts: Target timestamp
            
        Returns:
            (timestamp, data) tuple or None
        """
        best_match = None
        best_diff = float('inf')
        
        # Search through available samples
        for i in range(ring_buffer.available()):
            sample = ring_buffer.peek(i)
            if sample:
                ts, data = sample
                diff = abs(ts - target_ts)
                if diff < best_diff and diff < self.alignment_tolerance_ms:
                    best_diff = diff
                    best_match = sample
        
        return best_match
    
    def _mix_samples(self, aligned_samples: Dict[int, np.ndarray]) -> np.ndarray:
        """
        Mix aligned samples from multiple instances.
        
        Args:
            aligned_samples: Dict of {instance_id: samples}
            
        Returns:
            Mixed audio samples
        """
        if not aligned_samples:
            return np.zeros(self.alignment_chunk_samples, dtype=np.int16)
        
        # Extract audio data
        samples = list(aligned_samples.values())
        
        # Ensure all same length
        min_len = min(len(s) for s in samples)
        if min_len == 0:
            return np.zeros(self.alignment_chunk_samples, dtype=np.int16)
        
        samples = [s[:min_len] for s in samples]
        
        # Mix (average to prevent clipping)
        mixed = np.mean(samples, axis=0).astype(np.int16)
        
        # Pad to chunk size if needed
        if len(mixed) < self.alignment_chunk_samples:
            padded = np.zeros(self.alignment_chunk_samples, dtype=np.int16)
            padded[:len(mixed)] = mixed
            return padded
        
        return mixed[:self.alignment_chunk_samples]
    
    def get_metrics(self) -> RealtimeAlignmentMetrics:
        """Get current alignment metrics."""
        # Update clock drift rates
        for instance_id in self.input_buffers.keys():
            drift_rate = self.drift_compensator.drift_rates.get(instance_id, 0.0)
            self.metrics.clock_drift_rate[instance_id] = drift_rate
        
        return self.metrics