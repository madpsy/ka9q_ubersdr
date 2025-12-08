#!/usr/bin/env python3
"""
Timestamp-Based Synchronization System for Multi-Instance Client

This module provides timestamp-based alignment for audio and spectrum data
from multiple SDR instances, compensating for network latency variations.
"""

import bisect
import time
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple, Any
import numpy as np


@dataclass
class SyncQualityMetrics:
    """Metrics for monitoring synchronization quality."""
    timestamp_jitter_ms: float = 0.0
    alignment_success_rate: float = 1.0
    interpolation_rate: float = 0.0
    buffer_utilization: float = 0.0
    clock_drift_rate: float = 0.0
    stale_data_events: int = 0
    total_alignments: int = 0
    successful_alignments: int = 0
    
    def is_healthy(self) -> bool:
        """Check if sync quality is acceptable."""
        return (
            self.timestamp_jitter_ms < 100 and
            self.alignment_success_rate > 0.90 and
            abs(self.clock_drift_rate) < 10
        )
    
    def __str__(self) -> str:
        """String representation of metrics."""
        return (
            f"Sync Quality: jitter={self.timestamp_jitter_ms:.1f}ms, "
            f"success={self.alignment_success_rate:.1%}, "
            f"drift={self.clock_drift_rate:.2f}ms/s"
        )


class TimestampBuffer:
    """
    Circular buffer storing timestamped data with efficient lookup.
    
    Features:
    - Fixed-size circular buffer
    - O(log n) timestamp lookup using binary search
    - Automatic old data eviction
    - Thread-safe operations
    """
    
    def __init__(self, max_size: int = 100, max_age_ms: float = 2000):
        """
        Initialize timestamp buffer.
        
        Args:
            max_size: Maximum number of entries to store
            max_age_ms: Maximum age of data in milliseconds
        """
        self.max_size = max_size
        self.max_age_ms = max_age_ms
        self.buffer: List[Tuple[float, Any]] = []  # [(timestamp, data), ...]
        self.lock = threading.Lock()
    
    def add(self, timestamp: float, data: Any):
        """
        Add timestamped data to buffer.
        
        Args:
            timestamp: Timestamp in milliseconds
            data: Data to store
        """
        with self.lock:
            # Insert in sorted order (manual binary search for Python < 3.10 compatibility)
            entry = (timestamp, data)
            idx = bisect.bisect_left([t for t, _ in self.buffer], timestamp)
            self.buffer.insert(idx, entry)
            
            # Limit buffer size
            if len(self.buffer) > self.max_size:
                self.buffer.pop(0)
            
            # Remove old data
            cutoff_time = timestamp - self.max_age_ms
            while self.buffer and self.buffer[0][0] < cutoff_time:
                self.buffer.pop(0)
    
    def find_nearest(self, target_timestamp: float, tolerance_ms: float = float('inf')) -> Optional[Tuple[float, Any]]:
        """
        Find data with timestamp closest to target within tolerance.
        
        Args:
            target_timestamp: Target timestamp in milliseconds
            tolerance_ms: Maximum acceptable time difference
        
        Returns:
            (timestamp, data) tuple or None if no match within tolerance
        """
        with self.lock:
            if not self.buffer:
                return None
            
            # Binary search for insertion point (Python < 3.10 compatible)
            timestamps = [t for t, _ in self.buffer]
            idx = bisect.bisect_left(timestamps, target_timestamp)
            
            # Check neighbors
            candidates = []
            if idx > 0:
                candidates.append(self.buffer[idx - 1])
            if idx < len(self.buffer):
                candidates.append(self.buffer[idx])
            
            if not candidates:
                return None
            
            # Find closest
            closest = min(candidates, key=lambda x: abs(x[0] - target_timestamp))
            
            # Check tolerance
            if abs(closest[0] - target_timestamp) <= tolerance_ms:
                return closest
            
            return None
    
    def find_range(self, start_ts: float, end_ts: float) -> List[Tuple[float, Any]]:
        """
        Find all data within timestamp range.
        
        Args:
            start_ts: Start timestamp in milliseconds
            end_ts: End timestamp in milliseconds
        
        Returns:
            List of (timestamp, data) tuples
        """
        with self.lock:
            timestamps = [t for t, _ in self.buffer]
            start_idx = bisect.bisect_left(timestamps, start_ts)
            end_idx = bisect.bisect_right(timestamps, end_ts)
            return self.buffer[start_idx:end_idx]
    
    def get_latest(self) -> Optional[Tuple[float, Any]]:
        """Get most recent data."""
        with self.lock:
            return self.buffer[-1] if self.buffer else None
    
    def clear(self):
        """Clear all data from buffer."""
        with self.lock:
            self.buffer.clear()
    
    def size(self) -> int:
        """Get current buffer size."""
        with self.lock:
            return len(self.buffer)
    
    def utilization(self) -> float:
        """Get buffer utilization as percentage."""
        with self.lock:
            return len(self.buffer) / self.max_size if self.max_size > 0 else 0.0


class ClockDriftCompensator:
    """
    Detects and compensates for clock drift between instances.
    
    Continuously measures timestamp differences and applies corrections
    to normalize all timestamps to a common reference.
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
        self.lock = threading.Lock()
    
    def measure_offset(self, instance_id: int, server_timestamp: float):
        """
        Measure current offset between server and local time.
        
        Args:
            instance_id: Instance identifier
            server_timestamp: Timestamp from server (milliseconds)
        """
        with self.lock:
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
        with self.lock:
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
        with self.lock:
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
        with self.lock:
            for instance_id in list(self.offsets.keys()):
                self.calculate_drift_rate(instance_id)
            self.last_calibration = time.time()
    
    def should_recalibrate(self) -> bool:
        """Check if recalibration is needed."""
        return (time.time() - self.last_calibration) >= self.calibration_interval


class AudioAligner:
    """
    Aligns audio samples from multiple instances for synchronized playback.
    
    Strategy:
    - Buffer audio with timestamps
    - Find matching timestamps within tolerance window
    - Interpolate or use nearest-neighbor for missing data
    - Output aligned stereo samples
    """
    
    def __init__(self, buffer_size_ms: float = 150, alignment_tolerance_ms: float = 50,
                 interpolation_enabled: bool = True):
        """
        Initialize audio aligner.
        
        Args:
            buffer_size_ms: Buffer size in milliseconds
            alignment_tolerance_ms: Maximum acceptable jitter
            interpolation_enabled: Enable sample interpolation
        """
        self.buffer_size_ms = buffer_size_ms
        self.alignment_tolerance_ms = alignment_tolerance_ms
        self.interpolation_enabled = interpolation_enabled
        
        self.buffers: Dict[int, TimestampBuffer] = {}
        self.drift_compensator = ClockDriftCompensator()
        self.metrics = SyncQualityMetrics()
        self.cached_metrics = SyncQualityMetrics()  # Cache for when lock is busy
        self.lock = threading.Lock()
    
    def add_data(self, instance_id: int, timestamp: float, audio_data: np.ndarray):
        """
        Add timestamped audio data.
        
        Args:
            instance_id: Instance identifier
            timestamp: Timestamp in milliseconds
            audio_data: Audio samples as numpy array
        """
        # Use timeout to prevent deadlock
        if not self.lock.acquire(blocking=False):
            return  # Skip if lock is busy
        
        try:
            # Initialize buffer if needed
            if instance_id not in self.buffers:
                max_entries = int(self.buffer_size_ms / 10)  # Assume ~10ms per frame
                self.buffers[instance_id] = TimestampBuffer(
                    max_size=max_entries,
                    max_age_ms=self.buffer_size_ms * 2
                )
            
            # Measure clock offset
            self.drift_compensator.measure_offset(instance_id, timestamp)
            
            # Normalize timestamp
            normalized_ts = self.drift_compensator.normalize_timestamp(instance_id, timestamp)
            
            # Add to buffer
            self.buffers[instance_id].add(normalized_ts, audio_data)
            
            # Recalibrate if needed
            if self.drift_compensator.should_recalibrate():
                self.drift_compensator.recalibrate()
        finally:
            self.lock.release()
    
    def get_aligned_samples(self, target_timestamp: float, num_samples: int,
                           instance_ids: List[int]) -> Optional[Dict[int, np.ndarray]]:
        """
        Get aligned audio samples from multiple instances.
        
        Args:
            target_timestamp: Target timestamp in milliseconds
            num_samples: Number of samples needed
            instance_ids: List of instance IDs to align
        
        Returns:
            Dict of {instance_id: audio_samples} or None if insufficient data
        """
        # Use non-blocking lock to prevent deadlock
        if not self.lock.acquire(blocking=False):
            return None
        
        try:
            self.metrics.total_alignments += 1
            aligned = {}
            timestamps_found = []
            
            # Try to find matching data for each instance
            for instance_id in instance_ids:
                if instance_id not in self.buffers:
                    continue
                
                match = self.buffers[instance_id].find_nearest(
                    target_timestamp,
                    self.alignment_tolerance_ms
                )
                
                if match:
                    ts, data = match
                    aligned[instance_id] = self._ensure_length(data, num_samples)
                    timestamps_found.append(ts)
            
            # Update metrics
            if len(aligned) == len(instance_ids):
                self.metrics.successful_alignments += 1
                
                # Calculate jitter
                if len(timestamps_found) > 1:
                    jitter = float(np.std(timestamps_found))
                    # Exponential moving average
                    alpha = 0.1
                    self.metrics.timestamp_jitter_ms = (
                        alpha * jitter + (1 - alpha) * self.metrics.timestamp_jitter_ms
                    )
            
            # Update success rate
            if self.metrics.total_alignments > 0:
                self.metrics.alignment_success_rate = (
                    self.metrics.successful_alignments / self.metrics.total_alignments
                )
            
            # Update buffer utilization
            if self.buffers:
                avg_util = sum(b.utilization() for b in self.buffers.values()) / len(self.buffers)
                self.metrics.buffer_utilization = avg_util
            
            return aligned if aligned else None
        finally:
            self.lock.release()
    
    def _ensure_length(self, data: np.ndarray, target_length: int) -> np.ndarray:
        """Ensure data has target length by padding or truncating."""
        if len(data) == target_length:
            return data
        elif len(data) > target_length:
            return data[:target_length]
        else:
            # Pad with zeros
            padded = np.zeros(target_length, dtype=data.dtype)
            padded[:len(data)] = data
            return padded
    
    def get_metrics(self) -> SyncQualityMetrics:
        """Get current synchronization metrics."""
        # Use non-blocking lock to prevent deadlock
        if not self.lock.acquire(blocking=False):
            return self.cached_metrics  # Return cached metrics if busy
        
        try:
            # Update drift rate
            if self.drift_compensator.reference_instance is not None:
                ref_id = self.drift_compensator.reference_instance
                self.metrics.clock_drift_rate = self.drift_compensator.drift_rates.get(ref_id, 0.0)
            
            # Cache the metrics before returning
            self.cached_metrics = SyncQualityMetrics(
                timestamp_jitter_ms=self.metrics.timestamp_jitter_ms,
                alignment_success_rate=self.metrics.alignment_success_rate,
                interpolation_rate=self.metrics.interpolation_rate,
                buffer_utilization=self.metrics.buffer_utilization,
                clock_drift_rate=self.metrics.clock_drift_rate,
                stale_data_events=self.metrics.stale_data_events,
                total_alignments=self.metrics.total_alignments,
                successful_alignments=self.metrics.successful_alignments
            )
            
            return self.cached_metrics
        finally:
            self.lock.release()


class SpectrumAligner:
    """
    Aligns spectrum data from multiple instances for comparison.
    
    Strategy:
    - Buffer spectrum frames with timestamps
    - Match frames within tolerance window
    - Support both exact matching and interpolation
    - Provide aligned data for comparison metrics
    """
    
    def __init__(self, buffer_size: int = 20, alignment_tolerance_ms: float = 100,
                 interpolation_method: str = 'linear'):
        """
        Initialize spectrum aligner.
        
        Args:
            buffer_size: Number of frames to buffer
            alignment_tolerance_ms: Maximum acceptable jitter
            interpolation_method: 'linear' or 'nearest'
        """
        self.buffer_size = buffer_size
        self.alignment_tolerance_ms = alignment_tolerance_ms
        self.interpolation_method = interpolation_method
        
        self.buffers: Dict[int, TimestampBuffer] = {}
        self.drift_compensator = ClockDriftCompensator()
        self.metrics = SyncQualityMetrics()
        self.cached_metrics = SyncQualityMetrics()  # Cache for when lock is busy
        self.lock = threading.Lock()
    
    def add_data(self, instance_id: int, timestamp: float, spectrum_data: np.ndarray):
        """
        Add timestamped spectrum data.
        
        Args:
            instance_id: Instance identifier
            timestamp: Timestamp in milliseconds
            spectrum_data: Spectrum bins as numpy array
        """
        # Use timeout to prevent deadlock
        if not self.lock.acquire(blocking=False):
            return  # Skip if lock is busy
        
        try:
            # Initialize buffer if needed
            if instance_id not in self.buffers:
                self.buffers[instance_id] = TimestampBuffer(
                    max_size=self.buffer_size,
                    max_age_ms=self.alignment_tolerance_ms * 20  # Keep 20x tolerance window
                )
            
            # Measure clock offset
            self.drift_compensator.measure_offset(instance_id, timestamp)
            
            # Normalize timestamp
            normalized_ts = self.drift_compensator.normalize_timestamp(instance_id, timestamp)
            
            # Add to buffer
            self.buffers[instance_id].add(normalized_ts, spectrum_data)
            
            # Recalibrate if needed
            if self.drift_compensator.should_recalibrate():
                self.drift_compensator.recalibrate()
        finally:
            self.lock.release()
    
    def get_aligned_spectra(self, target_timestamp: float,
                           instance_ids: List[int]) -> Optional[Dict[int, np.ndarray]]:
        """
        Get aligned spectrum data from multiple instances.
        
        Args:
            target_timestamp: Target timestamp in milliseconds
            instance_ids: List of instance IDs to align
        
        Returns:
            Dict of {instance_id: spectrum_data} or None if insufficient data
        """
        # Use non-blocking lock to prevent deadlock
        if not self.lock.acquire(blocking=False):
            return None
        
        try:
            self.metrics.total_alignments += 1
            aligned = {}
            timestamps_found = []
            
            # Try to find matching data for each instance
            for instance_id in instance_ids:
                if instance_id not in self.buffers:
                    continue
                
                if self.interpolation_method == 'linear':
                    result = self._interpolate_spectrum(instance_id, target_timestamp)
                else:
                    match = self.buffers[instance_id].find_nearest(
                        target_timestamp,
                        self.alignment_tolerance_ms
                    )
                    result = match
                
                if result:
                    ts, data = result
                    aligned[instance_id] = data
                    timestamps_found.append(ts)
            
            # Update metrics
            if len(aligned) == len(instance_ids):
                self.metrics.successful_alignments += 1
                
                # Calculate jitter
                if len(timestamps_found) > 1:
                    jitter = float(np.std(timestamps_found))
                    alpha = 0.1
                    self.metrics.timestamp_jitter_ms = (
                        alpha * jitter + (1 - alpha) * self.metrics.timestamp_jitter_ms
                    )
            
            # Update success rate
            if self.metrics.total_alignments > 0:
                self.metrics.alignment_success_rate = (
                    self.metrics.successful_alignments / self.metrics.total_alignments
                )
            
            # Update buffer utilization
            if self.buffers:
                avg_util = sum(b.utilization() for b in self.buffers.values()) / len(self.buffers)
                self.metrics.buffer_utilization = avg_util
            
            return aligned if aligned else None
        finally:
            self.lock.release()
    
    def _interpolate_spectrum(self, instance_id: int, target_timestamp: float) -> Optional[Tuple[float, np.ndarray]]:
        """
        Interpolate spectrum data between two timestamps.
        
        Args:
            instance_id: Instance identifier
            target_timestamp: Target timestamp
        
        Returns:
            (timestamp, interpolated_data) or None
        """
        if instance_id not in self.buffers:
            return None
        
        buffer = self.buffers[instance_id]
        
        # Find timestamps before and after target
        all_data = buffer.find_range(
            target_timestamp - self.alignment_tolerance_ms,
            target_timestamp + self.alignment_tolerance_ms
        )
        
        if not all_data:
            return None
        
        # Find closest before and after
        before = None
        after = None
        
        for ts, data in all_data:
            if ts <= target_timestamp:
                if before is None or ts > before[0]:
                    before = (ts, data)
            if ts >= target_timestamp:
                if after is None or ts < after[0]:
                    after = (ts, data)
        
        # If we have both, interpolate
        if before and after and before[0] != after[0]:
            ts_before, data_before = before
            ts_after, data_after = after
            
            # Calculate interpolation ratio
            ratio = (target_timestamp - ts_before) / (ts_after - ts_before)
            
            # Linear interpolation
            interpolated = data_before * (1 - ratio) + data_after * ratio
            
            self.metrics.interpolation_rate = (
                0.1 + 0.9 * self.metrics.interpolation_rate
            )
            
            return (target_timestamp, interpolated)
        
        # Fall back to nearest
        if before:
            return before
        if after:
            return after
        
        return None
    
    def get_metrics(self) -> SyncQualityMetrics:
        """Get current synchronization metrics."""
        # Use non-blocking lock to prevent deadlock
        if not self.lock.acquire(blocking=False):
            return self.cached_metrics  # Return cached metrics if busy
        
        try:
            # Update drift rate
            if self.drift_compensator.reference_instance is not None:
                ref_id = self.drift_compensator.reference_instance
                self.metrics.clock_drift_rate = self.drift_compensator.drift_rates.get(ref_id, 0.0)
            
            # Cache the metrics before returning
            self.cached_metrics = SyncQualityMetrics(
                timestamp_jitter_ms=self.metrics.timestamp_jitter_ms,
                alignment_success_rate=self.metrics.alignment_success_rate,
                interpolation_rate=self.metrics.interpolation_rate,
                buffer_utilization=self.metrics.buffer_utilization,
                clock_drift_rate=self.metrics.clock_drift_rate,
                stale_data_events=self.metrics.stale_data_events,
                total_alignments=self.metrics.total_alignments,
                successful_alignments=self.metrics.successful_alignments
            )
            
            return self.cached_metrics
        finally:
            self.lock.release()