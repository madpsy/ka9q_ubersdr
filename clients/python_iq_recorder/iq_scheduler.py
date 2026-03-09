#!/usr/bin/env python3
"""
IQ Recording Scheduler
Manages scheduled recording events for automated recording
"""

import time
import threading
from datetime import datetime, timedelta
from typing import List, Optional, Callable, Tuple
from enum import Enum
import logging


class ScheduleAction(Enum):
    """Actions that can be performed by a schedule"""
    START_SELECTED = "start_selected"
    STOP_SELECTED = "stop_selected"
    START_ALL = "start_all"
    STOP_ALL = "stop_all"


class ScheduleEntry:
    """Represents a scheduled recording event"""
    
    def __init__(self, schedule_id: int, name: str, start_time: str,
                 stop_time: str, days_of_week: List[int], 
                 stream_ids: List[int], enabled: bool = True,
                 start_action: str = "start_selected",
                 stop_action: str = "stop_selected"):
        """
        Initialize a schedule entry
        
        Args:
            schedule_id: Unique identifier for this schedule
            name: Descriptive name for the schedule
            start_time: Start time in HH:MM format (24-hour)
            stop_time: Stop time in HH:MM format (24-hour)
            days_of_week: List of day indices (0=Monday, 6=Sunday)
            stream_ids: List of stream IDs to control
            enabled: Whether this schedule is active
            start_action: Action to perform at start time
            stop_action: Action to perform at stop time
        """
        self.schedule_id = schedule_id
        self.name = name
        self.start_time = start_time
        self.stop_time = stop_time
        self.days_of_week = days_of_week
        self.stream_ids = stream_ids
        self.enabled = enabled
        self.start_action = start_action
        self.stop_action = stop_action
        
        # Runtime state
        self.last_start_trigger = None
        self.last_stop_trigger = None
    
    def to_dict(self) -> dict:
        """Convert to dictionary for serialization"""
        return {
            'schedule_id': self.schedule_id,
            'name': self.name,
            'start_time': self.start_time,
            'stop_time': self.stop_time,
            'days_of_week': self.days_of_week,
            'stream_ids': self.stream_ids,
            'enabled': self.enabled,
            'start_action': self.start_action,
            'stop_action': self.stop_action
        }
    
    @classmethod
    def from_dict(cls, data: dict):
        """Create from dictionary"""
        return cls(
            schedule_id=data['schedule_id'],
            name=data['name'],
            start_time=data['start_time'],
            stop_time=data['stop_time'],
            days_of_week=data['days_of_week'],
            stream_ids=data['stream_ids'],
            enabled=data.get('enabled', True),
            start_action=data.get('start_action', 'start_selected'),
            stop_action=data.get('stop_action', 'stop_selected')
        )

    def get_duration_seconds(self) -> Optional[int]:
        """
        Calculate duration in seconds between start_time and stop_time.

        Returns:
            Duration in seconds, or None if times are invalid
        """
        try:
            # Support both HH:MM and HH:MM:SS formats
            start_format = "%H:%M:%S" if self.start_time.count(':') == 2 else "%H:%M"
            stop_format = "%H:%M:%S" if self.stop_time.count(':') == 2 else "%H:%M"

            start_time = datetime.strptime(self.start_time, start_format).time()
            stop_time = datetime.strptime(self.stop_time, stop_format).time()

            # Convert to datetime for calculation (use arbitrary date)
            today = datetime.now().date()
            start_dt = datetime.combine(today, start_time)
            stop_dt = datetime.combine(today, stop_time)

            # Handle case where stop time is next day (e.g., 23:00 to 01:00)
            if stop_dt <= start_dt:
                stop_dt += timedelta(days=1)

            duration = (stop_dt - start_dt).total_seconds()
            return int(duration)

        except Exception:
            return None

    def get_next_start_time(self) -> Optional[datetime]:
        """Calculate next start time for this schedule"""
        if not self.enabled or not self.days_of_week:
            return None
        
        now = datetime.now()
        # Support both HH:MM and HH:MM:SS formats
        time_format = "%H:%M:%S" if self.start_time.count(':') == 2 else "%H:%M"
        start_time = datetime.strptime(self.start_time, time_format).time()
        
        # Try today first
        next_time = datetime.combine(now.date(), start_time)
        
        # If time has passed today, start from tomorrow
        if next_time <= now:
            next_time += timedelta(days=1)
        
        # Find next valid day of week
        max_days = 7
        while next_time.weekday() not in self.days_of_week and max_days > 0:
            next_time += timedelta(days=1)
            max_days -= 1
        
        if max_days == 0:
            return None
        
        return next_time
    
    def get_next_stop_time(self) -> Optional[datetime]:
        """Calculate next stop time for this schedule"""
        if not self.enabled or not self.days_of_week:
            return None
        
        now = datetime.now()
        # Support both HH:MM and HH:MM:SS formats
        time_format = "%H:%M:%S" if self.stop_time.count(':') == 2 else "%H:%M"
        stop_time = datetime.strptime(self.stop_time, time_format).time()
        
        # Try today first
        next_time = datetime.combine(now.date(), stop_time)
        
        # If time has passed today, start from tomorrow
        if next_time <= now:
            next_time += timedelta(days=1)
        
        # Find next valid day of week
        max_days = 7
        while next_time.weekday() not in self.days_of_week and max_days > 0:
            next_time += timedelta(days=1)
            max_days -= 1
        
        if max_days == 0:
            return None
        
        return next_time
    
    def should_trigger_start(self, now: datetime) -> bool:
        """Check if start action should trigger now"""
        if not self.enabled or now.weekday() not in self.days_of_week:
            return False
        
        # Support both HH:MM and HH:MM:SS formats
        time_format = "%H:%M:%S" if self.start_time.count(':') == 2 else "%H:%M"
        start_time = datetime.strptime(self.start_time, time_format).time()
        current_time = now.time()
        
        # Check if we're within the trigger window (current second for HH:MM:SS, current minute for HH:MM)
        if time_format == "%H:%M:%S":
            # Exact second match
            if (current_time.hour == start_time.hour and
                current_time.minute == start_time.minute and
                current_time.second == start_time.second):
                # Check if we haven't triggered in the last 5 seconds
                if (self.last_start_trigger is None or
                    (now - self.last_start_trigger).total_seconds() > 5):
                    return True
        else:
            # Minute match (backward compatibility)
            if (current_time.hour == start_time.hour and
                current_time.minute == start_time.minute):
                # Check if we haven't triggered in the last 2 minutes
                if (self.last_start_trigger is None or
                    (now - self.last_start_trigger).total_seconds() > 120):
                    return True
        
        return False
    
    def should_trigger_stop(self, now: datetime) -> bool:
        """Check if stop action should trigger now"""
        if not self.enabled or now.weekday() not in self.days_of_week:
            return False
        
        # Support both HH:MM and HH:MM:SS formats
        time_format = "%H:%M:%S" if self.stop_time.count(':') == 2 else "%H:%M"
        stop_time = datetime.strptime(self.stop_time, time_format).time()
        current_time = now.time()
        
        # Check if we're within the trigger window (current second for HH:MM:SS, current minute for HH:MM)
        if time_format == "%H:%M:%S":
            # Exact second match
            if (current_time.hour == stop_time.hour and
                current_time.minute == stop_time.minute and
                current_time.second == stop_time.second):
                # Check if we haven't triggered in the last 5 seconds
                if (self.last_stop_trigger is None or
                    (now - self.last_stop_trigger).total_seconds() > 5):
                    return True
        else:
            # Minute match (backward compatibility)
            if (current_time.hour == stop_time.hour and
                current_time.minute == stop_time.minute):
                # Check if we haven't triggered in the last 2 minutes
                if (self.last_stop_trigger is None or
                    (now - self.last_stop_trigger).total_seconds() > 120):
                    return True
        
        return False
    
    def __repr__(self):
        return (f"ScheduleEntry(id={self.schedule_id}, name='{self.name}', "
                f"start={self.start_time}, stop={self.stop_time}, "
                f"enabled={self.enabled})")


class IQScheduler:
    """Manages scheduled recording events"""
    
    def __init__(self):
        self.schedules: List[ScheduleEntry] = []
        self.running = False
        self.check_interval = 1  # Check every second for precise timing
        self.thread: Optional[threading.Thread] = None
        
        # Callbacks
        self.on_start_streams: Optional[Callable] = None
        self.on_stop_streams: Optional[Callable] = None
        
        # Logging
        self.logger = logging.getLogger(__name__)
    
    def add_schedule(self, schedule: ScheduleEntry):
        """Add a new schedule"""
        # Check for duplicate ID
        if any(s.schedule_id == schedule.schedule_id for s in self.schedules):
            raise ValueError(f"Schedule ID {schedule.schedule_id} already exists")
        
        self.schedules.append(schedule)
        self.logger.info(f"Added schedule: {schedule.name}")
    
    def remove_schedule(self, schedule_id: int) -> bool:
        """Remove a schedule by ID"""
        original_count = len(self.schedules)
        self.schedules = [s for s in self.schedules if s.schedule_id != schedule_id]
        
        if len(self.schedules) < original_count:
            self.logger.info(f"Removed schedule ID: {schedule_id}")
            return True
        return False
    
    def get_schedule_by_id(self, schedule_id: int) -> Optional[ScheduleEntry]:
        """Get a schedule by ID"""
        return next((s for s in self.schedules if s.schedule_id == schedule_id), None)
    
    def update_schedule(self, schedule: ScheduleEntry):
        """Update an existing schedule"""
        for i, s in enumerate(self.schedules):
            if s.schedule_id == schedule.schedule_id:
                self.schedules[i] = schedule
                self.logger.info(f"Updated schedule: {schedule.name}")
                return True
        return False
    
    def get_next_event(self) -> Optional[Tuple[ScheduleEntry, datetime, str]]:
        """Get the next scheduled event (schedule, time, action_type)"""
        next_event = None
        next_time = None
        next_action = None
        
        for schedule in self.schedules:
            if not schedule.enabled:
                continue
            
            # Check start time
            start_time = schedule.get_next_start_time()
            if start_time and (next_time is None or start_time < next_time):
                next_time = start_time
                next_event = schedule
                next_action = "start"
            
            # Check stop time
            stop_time = schedule.get_next_stop_time()
            if stop_time and (next_time is None or stop_time < next_time):
                next_time = stop_time
                next_event = schedule
                next_action = "stop"
        
        if next_event:
            return (next_event, next_time, next_action)
        return None
    
    def check_schedules(self) -> List[Tuple[ScheduleEntry, str]]:
        """Check for schedules that should trigger now"""
        now = datetime.now()
        triggered = []
        
        for schedule in self.schedules:
            if schedule.should_trigger_start(now):
                schedule.last_start_trigger = now
                triggered.append((schedule, 'start'))
                self.logger.info(f"Schedule '{schedule.name}' start triggered")
            
            if schedule.should_trigger_stop(now):
                schedule.last_stop_trigger = now
                triggered.append((schedule, 'stop'))
                self.logger.info(f"Schedule '{schedule.name}' stop triggered")
        
        return triggered
    
    def start(self):
        """Start the scheduler thread"""
        if self.running:
            return
        
        self.running = True
        self.thread = threading.Thread(target=self._scheduler_loop, daemon=True)
        self.thread.start()
        self.logger.info("Scheduler started")
    
    def stop(self):
        """Stop the scheduler thread"""
        self.running = False
        if self.thread:
            self.thread.join(timeout=5)
        self.logger.info("Scheduler stopped")
    
    def _scheduler_loop(self):
        """Main scheduler loop (runs in background thread)"""
        while self.running:
            try:
                # Check for triggered schedules
                triggered = self.check_schedules()
                
                # Execute triggered schedules
                for schedule, action_type in triggered:
                    if action_type == 'start':
                        self._execute_start_action(schedule)
                    elif action_type == 'stop':
                        self._execute_stop_action(schedule)
                
            except Exception as e:
                self.logger.error(f"Error in scheduler loop: {e}")
            
            # Sleep for check interval
            time.sleep(self.check_interval)
    
    def _execute_start_action(self, schedule: ScheduleEntry):
        """Execute start action for a schedule"""
        if self.on_start_streams:
            try:
                self.on_start_streams(schedule)
            except Exception as e:
                self.logger.error(f"Error executing start action for '{schedule.name}': {e}")
    
    def _execute_stop_action(self, schedule: ScheduleEntry):
        """Execute stop action for a schedule"""
        if self.on_stop_streams:
            try:
                self.on_stop_streams(schedule)
            except Exception as e:
                self.logger.error(f"Error executing stop action for '{schedule.name}': {e}")
    
    def has_active_schedules(self) -> bool:
        """Check if there are any enabled schedules"""
        return any(s.enabled for s in self.schedules)
    
    def get_next_schedule_id(self) -> int:
        """Get next available schedule ID"""
        if not self.schedules:
            return 1
        return max(s.schedule_id for s in self.schedules) + 1
    
    def validate_schedule(self, schedule: ScheduleEntry) -> Tuple[bool, str]:
        """Validate a schedule configuration"""
        # Check name
        if not schedule.name or not schedule.name.strip():
            return False, "Schedule name cannot be empty"
        
        # Check for duplicate name (excluding current schedule)
        for s in self.schedules:
            if s.name == schedule.name and s.schedule_id != schedule.schedule_id:
                return False, f"Schedule name '{schedule.name}' already exists"
        
        # Check times (support both HH:MM and HH:MM:SS)
        try:
            # Try HH:MM:SS first
            start_format = "%H:%M:%S" if schedule.start_time.count(':') == 2 else "%H:%M"
            stop_format = "%H:%M:%S" if schedule.stop_time.count(':') == 2 else "%H:%M"
            datetime.strptime(schedule.start_time, start_format)
            datetime.strptime(schedule.stop_time, stop_format)
        except ValueError:
            return False, "Invalid time format (use HH:MM or HH:MM:SS)"
        
        # Check days
        if not schedule.days_of_week:
            return False, "At least one day must be selected"
        
        if not all(0 <= day <= 6 for day in schedule.days_of_week):
            return False, "Invalid day of week (must be 0-6)"
        
        # Check streams
        if not schedule.stream_ids:
            return False, "At least one stream must be selected"
        
        return True, "OK"
