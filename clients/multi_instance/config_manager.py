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
    
    def save_config(self, instances: List[SpectrumInstance], sync_enabled: bool = True,
                   throttle_enabled: bool = True, frequency: float = 14100000,
                   mode: str = "USB", bandwidth: int = 2700,
                   audio_left_instance: str = "None", audio_right_instance: str = "None",
                   audio_left_volume: float = 1.0, audio_right_volume: float = 1.0,
                   audio_left_mono: bool = False, audio_right_mono: bool = False,
                   compare_instance_a: str = "None", compare_instance_b: str = "None",
                   spectrum_center_freq: float = None, spectrum_bandwidth: float = None,
                   manual_offset: int = 0, window_geometries: dict = None) -> bool:
        """Save instances and settings to configuration file."""
        try:
            config = {
                'instances': [inst.to_dict() for inst in instances],
                'settings': {
                    'sync_enabled': sync_enabled,
                    'throttle_enabled': throttle_enabled,
                    'frequency': frequency,
                    'mode': mode,
                    'bandwidth': bandwidth,
                    'audio_preview': {
                        'left_instance': audio_left_instance,
                        'right_instance': audio_right_instance,
                        'left_volume': audio_left_volume,
                        'right_volume': audio_right_volume,
                        'left_mono': audio_left_mono,
                        'right_mono': audio_right_mono,
                        'manual_offset': manual_offset
                    },
                    'comparison': {
                        'instance_a': compare_instance_a,
                        'instance_b': compare_instance_b
                    },
                    'spectrum_display': {
                        'center_freq': spectrum_center_freq,
                        'bandwidth': spectrum_bandwidth
                    },
                    'window_geometries': window_geometries if window_geometries else {}
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
        default_settings = {
            'sync_enabled': True,
            'throttle_enabled': True,
            'frequency': 14100000,
            'mode': 'USB',
            'bandwidth': 2700,
            'audio_preview': {
                'left_instance': 'None',
                'right_instance': 'None',
                'left_volume': 1.0,
                'right_volume': 1.0,
                'left_mono': False,
                'right_mono': False,
                'manual_offset': 0
            },
            'comparison': {
                'instance_a': 'None',
                'instance_b': 'None'
            },
            'spectrum_display': {
                'center_freq': None,
                'bandwidth': None
            },
            'window_geometries': {}
        }
        
        if not os.path.exists(self.config_file):
            return [], default_settings

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
            settings.setdefault('frequency', 14100000)
            settings.setdefault('mode', 'USB')
            settings.setdefault('bandwidth', 2700)
            
            # Load audio preview settings with defaults
            if 'audio_preview' not in settings:
                settings['audio_preview'] = default_settings['audio_preview']
            else:
                audio_preview = settings['audio_preview']
                audio_preview.setdefault('left_instance', 'None')
                audio_preview.setdefault('right_instance', 'None')
                audio_preview.setdefault('left_volume', 1.0)
                audio_preview.setdefault('right_volume', 1.0)
                audio_preview.setdefault('left_mono', False)
                audio_preview.setdefault('right_mono', False)
                audio_preview.setdefault('manual_offset', 0)
            
            # Load comparison settings with defaults
            if 'comparison' not in settings:
                settings['comparison'] = default_settings['comparison']
            else:
                comparison = settings['comparison']
                comparison.setdefault('instance_a', 'None')
                comparison.setdefault('instance_b', 'None')
            
            # Load spectrum display settings with defaults
            if 'spectrum_display' not in settings:
                settings['spectrum_display'] = default_settings['spectrum_display']
            else:
                spectrum_display = settings['spectrum_display']
                spectrum_display.setdefault('center_freq', None)
                spectrum_display.setdefault('bandwidth', None)

            # Load window geometries with defaults
            if 'window_geometries' not in settings:
                settings['window_geometries'] = default_settings['window_geometries']

            return instances, settings

        except Exception as e:
            print(f"Failed to load config: {e}")
            return [], default_settings

    def load_instances(self, max_instances: int = 10) -> List[SpectrumInstance]:
        """Load instances from configuration file (legacy method for compatibility)."""
        instances, _ = self.load_config(max_instances)
        return instances