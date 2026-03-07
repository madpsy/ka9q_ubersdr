#!/usr/bin/env python3
"""
Configuration Manager for IQ Recorder
Handles automatic saving/loading of configuration to standard user directories
"""

import os
import json
import platform
from pathlib import Path
from typing import Optional, Dict, Any
import logging


class ConfigManager:
    """Manages application configuration with auto-save to user directories"""
    
    # Application name for config directory
    APP_NAME = "ubersdr_iq_recorder"
    CONFIG_FILENAME = "config.json"
    
    def __init__(self, auto_save: bool = True):
        """
        Initialize configuration manager
        
        Args:
            auto_save: Enable automatic saving on config changes
        """
        self.auto_save = auto_save
        self.config_dir = self._get_config_directory()
        self.config_file = self.config_dir / self.CONFIG_FILENAME
        self.logger = logging.getLogger(__name__)
        
        # Ensure config directory exists
        self._ensure_config_directory()
        
        # Current configuration
        self._config: Dict[str, Any] = self._get_default_config()
        
        # Load existing config if available
        self.load()
    
    @staticmethod
    def _get_config_directory() -> Path:
        """
        Get platform-specific configuration directory
        
        Returns:
            Path to configuration directory
        """
        system = platform.system()
        
        if system == "Windows":
            # Windows: %APPDATA%\ubersdr_iq_recorder
            appdata = os.environ.get('APPDATA')
            if appdata:
                return Path(appdata) / ConfigManager.APP_NAME
            else:
                # Fallback to user home
                return Path.home() / "AppData" / "Roaming" / ConfigManager.APP_NAME
        
        elif system == "Darwin":
            # macOS: ~/Library/Application Support/ubersdr_iq_recorder
            return Path.home() / "Library" / "Application Support" / ConfigManager.APP_NAME
        
        else:
            # Linux/Unix: ~/.config/ubersdr_iq_recorder (XDG Base Directory)
            xdg_config = os.environ.get('XDG_CONFIG_HOME')
            if xdg_config:
                return Path(xdg_config) / ConfigManager.APP_NAME
            else:
                return Path.home() / ".config" / ConfigManager.APP_NAME
    
    def _ensure_config_directory(self):
        """Create configuration directory if it doesn't exist"""
        try:
            self.config_dir.mkdir(parents=True, exist_ok=True)
            self.logger.info(f"Config directory: {self.config_dir}")
        except Exception as e:
            self.logger.error(f"Failed to create config directory: {e}")
    
    @staticmethod
    def _get_default_config() -> Dict[str, Any]:
        """
        Get default configuration
        
        Returns:
            Default configuration dictionary
        """
        return {
            'host': 'ubersdr.local',
            'port': 8080,
            'recording_dir': str(Path.home() / "IQ_Recordings"),
            'duration': 0,  # 0 = no limit
            'streams': [],
            'schedules': [],
            'window_geometry': None,  # Store window size/position
            'last_used_template': 'default',
            'version': '1.0'
        }
    
    def load(self) -> bool:
        """
        Load configuration from file
        
        Returns:
            True if loaded successfully, False otherwise
        """
        if not self.config_file.exists():
            self.logger.info("No existing config file, using defaults")
            return False
        
        try:
            with open(self.config_file, 'r') as f:
                loaded_config = json.load(f)
            
            # Merge with defaults (in case new fields were added)
            self._config = self._get_default_config()
            self._config.update(loaded_config)
            
            self.logger.info(f"Configuration loaded from {self.config_file}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to load configuration: {e}")
            return False
    
    def save(self) -> bool:
        """
        Save configuration to file
        
        Returns:
            True if saved successfully, False otherwise
        """
        try:
            # Ensure directory exists
            self._ensure_config_directory()
            
            # Write config file
            with open(self.config_file, 'w') as f:
                json.dump(self._config, f, indent=2)
            
            self.logger.debug(f"Configuration saved to {self.config_file}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to save configuration: {e}")
            return False
    
    def get(self, key: str, default: Any = None) -> Any:
        """
        Get configuration value
        
        Args:
            key: Configuration key
            default: Default value if key doesn't exist
            
        Returns:
            Configuration value
        """
        return self._config.get(key, default)
    
    def set(self, key: str, value: Any, save_now: bool = None):
        """
        Set configuration value
        
        Args:
            key: Configuration key
            value: Configuration value
            save_now: Override auto_save setting for this call
        """
        self._config[key] = value
        
        # Determine if we should save
        should_save = save_now if save_now is not None else self.auto_save
        
        if should_save:
            self.save()
    
    def update(self, updates: Dict[str, Any], save_now: bool = None):
        """
        Update multiple configuration values
        
        Args:
            updates: Dictionary of key-value pairs to update
            save_now: Override auto_save setting for this call
        """
        self._config.update(updates)
        
        # Determine if we should save
        should_save = save_now if save_now is not None else self.auto_save
        
        if should_save:
            self.save()
    
    def get_all(self) -> Dict[str, Any]:
        """
        Get entire configuration
        
        Returns:
            Configuration dictionary
        """
        return self._config.copy()
    
    def reset_to_defaults(self):
        """Reset configuration to defaults"""
        self._config = self._get_default_config()
        if self.auto_save:
            self.save()
    
    def get_config_file_path(self) -> Path:
        """
        Get path to configuration file
        
        Returns:
            Path to config file
        """
        return self.config_file
    
    def export_to_file(self, filepath: str) -> bool:
        """
        Export configuration to a specific file
        
        Args:
            filepath: Path to export file
            
        Returns:
            True if exported successfully
        """
        try:
            with open(filepath, 'w') as f:
                json.dump(self._config, f, indent=2)
            self.logger.info(f"Configuration exported to {filepath}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to export configuration: {e}")
            return False
    
    def import_from_file(self, filepath: str) -> bool:
        """
        Import configuration from a specific file
        
        Args:
            filepath: Path to import file
            
        Returns:
            True if imported successfully
        """
        try:
            with open(filepath, 'r') as f:
                imported_config = json.load(f)
            
            # Merge with defaults
            self._config = self._get_default_config()
            self._config.update(imported_config)
            
            if self.auto_save:
                self.save()
            
            self.logger.info(f"Configuration imported from {filepath}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to import configuration: {e}")
            return False
    
    # Convenience methods for common operations
    
    def get_host(self) -> str:
        """Get server host"""
        return self.get('host', 'ubersdr.local')
    
    def set_host(self, host: str):
        """Set server host"""
        self.set('host', host)
    
    def get_port(self) -> int:
        """Get server port"""
        return self.get('port', 8080)
    
    def set_port(self, port: int):
        """Set server port"""
        self.set('port', port)
    
    def get_recording_dir(self) -> str:
        """Get recording directory"""
        return self.get('recording_dir', str(Path.home() / "IQ_Recordings"))
    
    def set_recording_dir(self, directory: str):
        """Set recording directory"""
        self.set('recording_dir', directory)
    
    def get_duration(self) -> int:
        """Get default recording duration"""
        return self.get('duration', 0)
    
    def set_duration(self, duration: int):
        """Set default recording duration"""
        self.set('duration', duration)
    
    def get_streams(self) -> list:
        """Get stream configurations"""
        return self.get('streams', [])
    
    def set_streams(self, streams: list):
        """Set stream configurations"""
        self.set('streams', streams)
    
    def get_schedules(self) -> list:
        """Get schedule configurations"""
        return self.get('schedules', [])
    
    def set_schedules(self, schedules: list):
        """Set schedule configurations"""
        self.set('schedules', schedules)
    
    def get_window_geometry(self) -> Optional[str]:
        """Get window geometry"""
        return self.get('window_geometry')
    
    def set_window_geometry(self, geometry: str):
        """Set window geometry"""
        self.set('window_geometry', geometry)
