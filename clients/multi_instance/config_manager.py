"""
Configuration Manager
Handles saving and loading of instance configurations
"""

import json
import os
import platform
from typing import List

from spectrum_instance import SpectrumInstance


class ConfigManager:
    """Manages configuration persistence."""
    
    def __init__(self):
        self.config_file = self._get_config_file_path()
    
    def _get_config_file_path(self) -> str:
        """Get platform-appropriate config file path."""
        if platform.system() == 'Windows':
            config_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'ubersdr')
            os.makedirs(config_dir, exist_ok=True)
            return os.path.join(config_dir, 'multi_spectrum_config.json')
        else:
            return os.path.expanduser("~/.ubersdr_multi_spectrum.json")
    
    def save_config(self, instances: List[SpectrumInstance], sync_enabled: bool = True, throttle_enabled: bool = True) -> bool:
        """Save instances and settings to configuration file."""
        try:
            config = {
                'instances': [inst.to_dict() for inst in instances],
                'settings': {
                    'sync_enabled': sync_enabled,
                    'throttle_enabled': throttle_enabled
                }
            }

            with open(self.config_file, 'w') as f:
                json.dump(config, f, indent=2)

            return True

        except Exception as e:
            print(f"Failed to save config: {e}")
            return False

    def save_instances(self, instances: List[SpectrumInstance]) -> bool:
        """Save instances to configuration file (legacy method for compatibility)."""
        return self.save_config(instances)
    
    def load_config(self, max_instances: int = 10) -> tuple:
        """Load instances and settings from configuration file.

        Returns:
            Tuple of (instances, settings_dict)
        """
        if not os.path.exists(self.config_file):
            return [], {'sync_enabled': True, 'throttle_enabled': True}

        try:
            with open(self.config_file, 'r') as f:
                config = json.load(f)

            instances = []
            for i, inst_config in enumerate(config.get('instances', [])):
                if i >= max_instances:
                    break

                instance = SpectrumInstance.from_dict(i, inst_config)
                instances.append(instance)

            # Load settings with defaults
            settings = config.get('settings', {})
            settings.setdefault('sync_enabled', True)
            settings.setdefault('throttle_enabled', True)

            return instances, settings

        except Exception as e:
            print(f"Failed to load config: {e}")
            return [], {'sync_enabled': True, 'throttle_enabled': True}

    def load_instances(self, max_instances: int = 10) -> List[SpectrumInstance]:
        """Load instances from configuration file (legacy method for compatibility)."""
        instances, _ = self.load_config(max_instances)
        return instances