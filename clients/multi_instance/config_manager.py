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
    
    def save_instances(self, instances: List[SpectrumInstance]) -> bool:
        """Save instances to configuration file."""
        try:
            config = {
                'instances': [inst.to_dict() for inst in instances]
            }
            
            with open(self.config_file, 'w') as f:
                json.dump(config, f, indent=2)
            
            return True
                
        except Exception as e:
            print(f"Failed to save config: {e}")
            return False
    
    def load_instances(self, max_instances: int = 10) -> List[SpectrumInstance]:
        """Load instances from configuration file."""
        if not os.path.exists(self.config_file):
            return []
        
        try:
            with open(self.config_file, 'r') as f:
                config = json.load(f)
            
            instances = []
            for i, inst_config in enumerate(config.get('instances', [])):
                if i >= max_instances:
                    break
                
                instance = SpectrumInstance.from_dict(i, inst_config)
                instances.append(instance)
            
            return instances
                
        except Exception as e:
            print(f"Failed to load config: {e}")
            return []