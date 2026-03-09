#!/usr/bin/env python3
"""
IQ Recorder CLI Mode
Headless operation for scheduled recordings
"""

import sys
import os
import time
import signal
import logging
import asyncio
import threading
import warnings
import json
import uuid
import requests
from pathlib import Path
from typing import Dict, Tuple, Optional

# Suppress warnings before importing requests-dependent modules
warnings.filterwarnings('ignore', message='Unable to find acceptable character detection dependency')
warnings.filterwarnings('ignore', category=DeprecationWarning)

# Suppress the specific RequestsDependencyWarning
try:
    from requests.exceptions import RequestsDependencyWarning
    warnings.filterwarnings('ignore', category=RequestsDependencyWarning)
except ImportError:
    pass

try:
    import urllib3
    urllib3.disable_warnings()
except ImportError:
    pass

# Add parent directory to path to import radio_client
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))

try:
    from radio_client import RadioClient
    RADIO_CLIENT_AVAILABLE = True
except ImportError:
    RADIO_CLIENT_AVAILABLE = False
    print("Error: radio_client module not found.")
    print("Please ensure radio_client.py is in the ../python directory")
    sys.exit(1)

from config_manager import ConfigManager
from iq_scheduler import IQScheduler, ScheduleEntry
from iq_stream_config import StreamConfig, StreamStatus
from iq_file_manager import IQFileManager
from iq_recording_client import IQRecordingClient


def validate_cli_config(config_manager: ConfigManager) -> Tuple[bool, str]:
    """
    Validate config has enabled schedules with recording streams
    
    Args:
        config_manager: ConfigManager instance with loaded config
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    schedules = config_manager.get_schedules()
    streams = config_manager.get_streams()
    
    # Check if any schedules exist
    if not schedules:
        return False, "No schedules found in config"
    
    # Check if any schedules are enabled
    enabled_schedules = [s for s in schedules if s.get('enabled', True)]
    if not enabled_schedules:
        return False, "No enabled schedules found in config"
    
    # Check if any streams exist
    if not streams:
        return False, "No streams found in config"
    
    # Check if scheduled streams have recording enabled
    stream_map = {s['stream_id']: s for s in streams}
    has_recording = False
    
    for schedule in enabled_schedules:
        for stream_id in schedule.get('stream_ids', []):
            stream = stream_map.get(stream_id)
            if stream and stream.get('recording_enabled', True):
                has_recording = True
                break
        if has_recording:
            break
    
    if not has_recording:
        return False, "No scheduled streams have recording enabled"
    
    return True, "OK"


class CLIStreamManager:
    """Manages IQ recording streams in CLI mode"""
    
    def __init__(self, config_manager: ConfigManager):
        """
        Initialize stream manager
        
        Args:
            config_manager: ConfigManager instance with loaded config
        """
        self.config_manager = config_manager
        self.logger = logging.getLogger(__name__)
        
        # Initialize file manager
        recording_dir = config_manager.get_recording_dir()
        self.file_manager = IQFileManager(recording_dir)
        
        # Load streams from config
        self.streams: Dict[int, StreamConfig] = {}
        for stream_data in config_manager.get_streams():
            stream = StreamConfig.from_dict(stream_data)
            self.streams[stream.stream_id] = stream
        
        self.logger.info(f"Loaded {len(self.streams)} stream configurations")

    def _handle_stream_error(self, stream_id: int, error_type: str, error: Exception):
        """
        Handle stream I/O errors

        Args:
            stream_id: ID of stream with error
            error_type: Type of error (open, write, flush, close)
            error: Exception that occurred
        """
        self.logger.error(f"Stream {stream_id} I/O error ({error_type}): {error}")

        # Check if disk full
        if isinstance(error, OSError) and error.errno == 28:  # ENOSPC
            self.logger.critical("DISK FULL - Stopping all recordings")
            self.stop_all_streams()

    def start_stream(self, stream: StreamConfig):
        """
        Start recording a stream

        Args:
            stream: StreamConfig to start recording
        """
        if stream.status == StreamStatus.RECORDING:
            self.logger.warning(f"Stream {stream.stream_id} is already recording")
            return

        # Generate actual filename from template (only if recording is enabled)
        if stream.recording_enabled:
            base_dir = self.config_manager.get_recording_dir()
            filename = self.file_manager.generate_filename(
                stream.frequency,
                stream.iq_mode.mode_name,
                stream.stream_id,
                stream.filename_template
            )
            stream.output_file = os.path.join(base_dir, filename)

            # Create recording directory if needed
            os.makedirs(os.path.dirname(stream.output_file), exist_ok=True)

            # Check disk space before starting
            try:
                space_info = self.file_manager.get_disk_space()
                
                # Estimate space needed for 1 hour of recording (conservative)
                required_bytes = self.file_manager.estimate_recording_size(
                    stream.iq_mode.mode_name,
                    3600  # 1 hour
                )
                
                # Calculate data rate for logging
                data_rate_kbps = (required_bytes / 3600) / 1024  # KB/s

                self.logger.info(
                    f"Stream {stream.stream_id} disk space check: "
                    f"Mode={stream.iq_mode.mode_name}, "
                    f"Rate={data_rate_kbps:.1f} KB/s, "
                    f"Need={self.file_manager.format_bytes(required_bytes)} (1hr estimate), "
                    f"Available={self.file_manager.format_bytes(space_info['free'])}"
                )

                if not self.file_manager.check_disk_space_available(required_bytes):
                    self.logger.error(
                        f"Insufficient disk space for stream {stream.stream_id}: "
                        f"need {self.file_manager.format_bytes(required_bytes)}, "
                        f"only {self.file_manager.format_bytes(space_info['free'])} available"
                    )
                    return

            except Exception as e:
                self.logger.warning(f"Stream {stream.stream_id}: Disk space check failed: {e}")

            self.logger.info(f"Stream {stream.stream_id}: Recording to {stream.output_file}")
        else:
            stream.output_file = None
            self.logger.info(f"Stream {stream.stream_id}: Running without recording (monitoring only)")
        
        stream.status = StreamStatus.CONNECTING
        stream.start_time = time.time()
        stream.stop_time = None
        stream.bytes_recorded = 0
        
        # Start recording thread
        thread = threading.Thread(
            target=self.record_stream_thread,
            args=(stream,),
            daemon=True
        )
        stream.thread = thread
        thread.start()
        
        self.logger.info(f"Started stream {stream.stream_id}: {stream.frequency_mhz:.3f} MHz ({stream.iq_mode.mode_name})")
    
    def record_stream_thread(self, stream: StreamConfig):
        """
        Thread function for recording a stream

        Args:
            stream: StreamConfig to record
        """
        try:
            # Create new event loop for this thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            # Create error callback for this stream
            def error_callback(error_type: str, error: Exception):
                self._handle_stream_error(stream.stream_id, error_type, error)

            # Create IQ recording client
            # If recording is disabled, pass None for wav_file to skip writing
            client = IQRecordingClient(
                host=self.config_manager.get_host(),
                port=self.config_manager.get_port(),
                frequency=stream.frequency,
                mode=stream.iq_mode.mode_name,
                output_mode='wav' if stream.recording_enabled else None,
                wav_file=stream.output_file if stream.recording_enabled else None,
                duration=None,  # Record until stopped
                iq_callback=None,  # No spectrum display in CLI mode
                metadata_frequency=stream.frequency,
                metadata_mode=stream.iq_mode.mode_name,
                error_callback=error_callback
            )

            # Override sample rate with the correct IQ mode sample rate
            client.sample_rate = stream.iq_mode.sample_rate

            stream.client = client
            stream.status = StreamStatus.RECORDING

            self.logger.info(f"Stream {stream.stream_id} connected and recording")

            # Run client
            loop.run_until_complete(client.run())

        except OSError as e:
            stream.status = StreamStatus.ERROR
            stream.error_message = str(e)
            self.logger.error(f"I/O error recording stream {stream.stream_id}: {e}")
            # Check if disk full
            if e.errno == 28:  # ENOSPC
                self.logger.critical("DISK FULL - Stopping all recordings")
                self.stop_all_streams()
        except Exception as e:
            stream.status = StreamStatus.ERROR
            stream.error_message = str(e)
            self.logger.error(f"Error recording stream {stream.stream_id}: {e}")
        finally:
            stream.status = StreamStatus.STOPPED
            stream.stop_time = time.time()

            # Log recording statistics
            if stream.recording_enabled and stream.output_file:
                self.logger.info(
                    f"Stream {stream.stream_id} stopped: "
                    f"Duration={stream.format_duration()}, "
                    f"Size={stream.format_size()}"
                )
            else:
                self.logger.info(f"Stream {stream.stream_id} stopped")

            stream.client = None
    
    def stop_stream(self, stream: StreamConfig):
        """
        Stop recording a stream
        
        Args:
            stream: StreamConfig to stop
        """
        if stream.status != StreamStatus.RECORDING:
            self.logger.warning(f"Stream {stream.stream_id} is not recording")
            return
        
        self.logger.info(f"Stopping stream {stream.stream_id}")
        stream.status = StreamStatus.STOPPING
        
        # Stop client
        if stream.client:
            stream.client.running = False
    
    def start_streams_by_ids(self, stream_ids: list):
        """
        Start streams by their IDs
        
        Args:
            stream_ids: List of stream IDs to start
        """
        for stream_id in stream_ids:
            stream = self.streams.get(stream_id)
            if stream:
                if stream.recording_enabled:
                    self.start_stream(stream)
                else:
                    self.logger.warning(
                        f"Stream {stream_id} has recording disabled, skipping"
                    )
            else:
                self.logger.warning(f"Stream {stream_id} not found in configuration")
    
    def stop_streams_by_ids(self, stream_ids: list):
        """
        Stop streams by their IDs
        
        Args:
            stream_ids: List of stream IDs to stop
        """
        for stream_id in stream_ids:
            stream = self.streams.get(stream_id)
            if stream:
                self.stop_stream(stream)
            else:
                self.logger.warning(f"Stream {stream_id} not found in configuration")
    
    def stop_all_streams(self):
        """Stop all recording streams"""
        self.logger.info("Stopping all streams")
        for stream in self.streams.values():
            if stream.status == StreamStatus.RECORDING:
                self.stop_stream(stream)
        
        # Wait for all streams to stop (with timeout)
        timeout = 10  # seconds
        start_time = time.time()
        while time.time() - start_time < timeout:
            if all(s.status != StreamStatus.RECORDING for s in self.streams.values()):
                break
            time.sleep(0.1)
    
    def get_active_stream_count(self) -> int:
        """Get count of currently recording streams"""
        return sum(1 for s in self.streams.values() if s.status == StreamStatus.RECORDING)


def test_server_connection(host: str, port: int) -> Tuple[bool, str]:
    """
    Test connection to the server
    
    Args:
        host: Server hostname or IP
        port: Server port
        
    Returns:
        Tuple of (success, message)
    """
    try:
        # Build URL
        url = f"http://{host}:{port}/connection"
        
        # Prepare request body (similar to radio_client.py)
        request_body = {
            "user_session_id": str(uuid.uuid4())  # Generate temporary session ID for test
        }
        
        # Make POST request with timeout
        response = requests.post(
            url,
            json=request_body,
            headers={
                'Content-Type': 'application/json',
                'User-Agent': 'UberSDR IQ Recorder CLI (python)'
            },
            timeout=5
        )
        response.raise_for_status()
        
        # Parse JSON response
        data = response.json()
        
        # Check if connection is allowed
        allowed = data.get('allowed', False)
        if not allowed:
            reason = data.get('reason', 'Unknown reason')
            return False, f"Connection denied: {reason}"
        
        # Format session_timeout
        session_timeout = data.get('session_timeout', 0)
        if session_timeout == 0:
            timeout_str = "unlimited"
        else:
            hours = session_timeout // 3600
            minutes = (session_timeout % 3600) // 60
            seconds = session_timeout % 60
            timeout_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        
        # Format max_session_time
        max_session_time = data.get('max_session_time', 0)
        if max_session_time == 0:
            max_time_str = "unlimited"
        else:
            hours = max_session_time // 3600
            minutes = (max_session_time % 3600) // 60
            seconds = max_session_time % 60
            max_time_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        
        # Get allowed IQ modes
        allowed_modes = data.get('allowed_iq_modes', [])
        modes_str = ', '.join(allowed_modes) if allowed_modes else 'none'
        
        # Build detailed message
        client_ip = data.get('client_ip', 'N/A')
        bypassed = data.get('bypassed', False)
        
        msg = (f"Connected to {host}:{port} | "
               f"Client IP: {client_ip} | "
               f"Session timeout: {timeout_str} | "
               f"Max session time: {max_time_str} | "
               f"Bypassed: {bypassed} | "
               f"Allowed IQ modes: {modes_str}")
        
        return True, msg
        
    except requests.exceptions.Timeout:
        return False, f"Connection timeout - server at {host}:{port} not responding"
    except requests.exceptions.ConnectionError:
        return False, f"Connection failed - cannot reach {host}:{port}"
    except requests.exceptions.HTTPError as e:
        return False, f"HTTP Error: {e}"
    except json.JSONDecodeError:
        return False, "Invalid JSON response from server"
    except Exception as e:
        return False, f"Error: {str(e)}"


def cli_main(config_path: str):
    """
    Main entry point for CLI mode
    
    Args:
        config_path: Path to JSON configuration file
    """
    
    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler('iq_recorder.log'),
            logging.StreamHandler()
        ]
    )
    logger = logging.getLogger(__name__)
    
    logger.info("=" * 60)
    logger.info("IQ Recorder - CLI Mode")
    logger.info("=" * 60)
    logger.info(f"Config file: {config_path}")
    
    # Load config directly from file without using ConfigManager's auto-load
    # This ensures we ONLY use the specified config file, not the user's saved config
    try:
        with open(config_path, 'r') as f:
            config_data = json.load(f)
    except FileNotFoundError:
        logger.error(f"Config file not found: {config_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in config file: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Failed to load config from {config_path}: {e}")
        sys.exit(1)
    
    # Create ConfigManager with auto_save=False and populate it with our config
    # Temporarily suppress ConfigManager's logging during initialization
    config_logger = logging.getLogger('config_manager')
    original_level = config_logger.level
    config_logger.setLevel(logging.WARNING)
    
    config_manager = ConfigManager(auto_save=False)
    
    # Restore logging level
    config_logger.setLevel(original_level)
    
    # Replace config with our loaded data (not the user's auto-loaded config)
    config_manager._config = ConfigManager._get_default_config()
    config_manager._config.update(config_data)
    
    logger.info("Configuration loaded successfully")
    
    # Validate configuration
    valid, message = validate_cli_config(config_manager)
    if not valid:
        logger.error(f"Configuration validation failed: {message}")
        logger.error("No valid scheduled recordings configured. Exiting.")
        sys.exit(1)
    
    logger.info("Configuration validated successfully")
    
    # Test connection to server
    logger.info("Testing connection to server...")
    connection_ok, connection_msg = test_server_connection(
        config_manager.get_host(),
        config_manager.get_port()
    )
    
    if not connection_ok:
        logger.error(f"Connection test failed: {connection_msg}")
        logger.error("Cannot connect to server. Exiting.")
        sys.exit(1)
    
    logger.info(f"Connection test successful: {connection_msg}")
    
    # Initialize components
    stream_manager = CLIStreamManager(config_manager)
    scheduler = IQScheduler()
    
    # Load schedules
    schedule_count = 0
    for schedule_data in config_manager.get_schedules():
        schedule = ScheduleEntry.from_dict(schedule_data)
        scheduler.add_schedule(schedule)
        if schedule.enabled:
            schedule_count += 1
            logger.info(
                f"Loaded schedule: '{schedule.name}' "
                f"({schedule.start_time} - {schedule.stop_time})"
            )
    
    logger.info(f"Loaded {schedule_count} enabled schedule(s)")
    
    # Define scheduler callback functions
    def start_scheduled_streams(schedule: ScheduleEntry):
        """Start recording for scheduled streams"""
        logger.info(f"Schedule triggered: '{schedule.name}' (START)")
        stream_manager.start_streams_by_ids(schedule.stream_ids)
    
    def stop_scheduled_streams(schedule: ScheduleEntry):
        """Stop recording for scheduled streams"""
        logger.info(f"Schedule triggered: '{schedule.name}' (STOP)")
        stream_manager.stop_streams_by_ids(schedule.stream_ids)
    
    # Set scheduler callbacks
    scheduler.on_start_streams = start_scheduled_streams
    scheduler.on_stop_streams = stop_scheduled_streams
    
    # Setup signal handlers for graceful shutdown
    def signal_handler(signum, frame):
        logger.info("Received shutdown signal")
        scheduler.stop()
        stream_manager.stop_all_streams()
        logger.info("Shutdown complete")
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Start scheduler
    scheduler.start()
    logger.info("Scheduler started")
    
    # Display next scheduled event
    next_event = scheduler.get_next_event()
    if next_event:
        schedule, event_time, action = next_event
        logger.info(f"Next event: '{schedule.name}' ({action}) at {event_time}")
    
    logger.info("Running in CLI mode. Press Ctrl+C to stop.")
    logger.info("=" * 60)
    
    # Run until interrupted
    try:
        last_status_time = time.time()
        status_interval = 300  # Log status every 5 minutes
        
        while True:
            time.sleep(1)
            
            # Periodically log status
            current_time = time.time()
            if current_time - last_status_time >= status_interval:
                active_count = stream_manager.get_active_stream_count()
                logger.info(f"Status: {active_count} stream(s) recording")
                
                # Show next event
                next_event = scheduler.get_next_event()
                if next_event:
                    schedule, event_time, action = next_event
                    logger.info(f"Next event: '{schedule.name}' ({action}) at {event_time}")
                
                last_status_time = current_time
                
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
        scheduler.stop()
        stream_manager.stop_all_streams()
        logger.info("Shutdown complete")


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='IQ Recorder CLI Mode')
    parser.add_argument('--config', type=str, required=True,
                       help='Path to JSON configuration file')
    args = parser.parse_args()
    
    cli_main(args.config)
