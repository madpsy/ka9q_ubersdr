#!/usr/bin/env python3
"""
Local Bookmark Manager for ka9q_ubersdr Python Client
Manages user's personal bookmarks stored locally.
"""

import json
import os
from pathlib import Path
from typing import List, Dict, Optional


class LocalBookmarkManager:
    """Manages local bookmarks stored in user's config directory."""
    
    def __init__(self, config_file: Optional[Path] = None):
        """Initialize the local bookmark manager.
        
        Args:
            config_file: Optional path to config file. If None, uses default location.
        """
        if config_file is None:
            config_dir = Path.home() / '.ubersdr'
            config_dir.mkdir(exist_ok=True)
            config_file = config_dir / 'local_bookmarks.json'
        
        self.config_file = config_file
        self.bookmarks = self.load_bookmarks()
    
    def load_bookmarks(self) -> List[Dict]:
        """Load local bookmarks from config file.
        
        Returns:
            List of bookmark dictionaries
        """
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r') as f:
                    data = json.load(f)
                    return data.get('local_bookmarks', [])
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Failed to load local bookmarks: {e}")
                return []
        return []
    
    def save_bookmark(self, name: str, frequency: int, mode: str,
                     bandwidth_low: int, bandwidth_high: int, overwrite: bool = False) -> bool:
        """Save a new bookmark or overwrite an existing one.
        
        Args:
            name: Bookmark name
            frequency: Frequency in Hz
            mode: Demodulation mode (e.g., 'usb', 'lsb', 'am')
            bandwidth_low: Low bandwidth edge in Hz
            bandwidth_high: High bandwidth edge in Hz
            overwrite: If True, overwrite existing bookmark with same name
            
        Returns:
            True if saved successfully, False otherwise
        """
        bookmark = {
            'name': name,
            'frequency': frequency,
            'mode': mode,
            'bandwidth_low': bandwidth_low,
            'bandwidth_high': bandwidth_high
        }
        
        # Check if bookmark with same name already exists
        existing_index = None
        for i, b in enumerate(self.bookmarks):
            if b['name'] == name:
                existing_index = i
                break
        
        if existing_index is not None:
            if overwrite:
                # Overwrite existing bookmark
                self.bookmarks[existing_index] = bookmark
            else:
                # Don't overwrite without permission
                return False
        else:
            # Add new bookmark
            self.bookmarks.append(bookmark)
        
        return self._save_to_file()
    
    def delete_bookmark(self, index: int) -> bool:
        """Delete a bookmark by index.
        
        Args:
            index: Index of bookmark to delete
            
        Returns:
            True if deleted successfully, False otherwise
        """
        if 0 <= index < len(self.bookmarks):
            del self.bookmarks[index]
            return self._save_to_file()
        return False
    
    def delete_bookmark_by_name(self, name: str) -> bool:
        """Delete a bookmark by name.
        
        Args:
            name: Name of bookmark to delete
            
        Returns:
            True if deleted successfully, False otherwise
        """
        for i, bookmark in enumerate(self.bookmarks):
            if bookmark['name'] == name:
                del self.bookmarks[i]
                return self._save_to_file()
        return False
    
    def rename_bookmark(self, index: int, new_name: str) -> bool:
        """Rename a bookmark.
        
        Args:
            index: Index of bookmark to rename
            new_name: New name for the bookmark
            
        Returns:
            True if renamed successfully, False otherwise
        """
        if 0 <= index < len(self.bookmarks):
            # Check if new name already exists
            if any(b['name'] == new_name for i, b in enumerate(self.bookmarks) if i != index):
                return False
            self.bookmarks[index]['name'] = new_name
            return self._save_to_file()
        return False
    
    def update_bookmark(self, index: int, name: str, frequency: int, mode: str,
                       bandwidth_low: int, bandwidth_high: int) -> bool:
        """Update an existing bookmark.
        
        Args:
            index: Index of bookmark to update
            name: New bookmark name
            frequency: New frequency in Hz
            mode: New demodulation mode
            bandwidth_low: New low bandwidth edge in Hz
            bandwidth_high: New high bandwidth edge in Hz
            
        Returns:
            True if updated successfully, False otherwise
        """
        if 0 <= index < len(self.bookmarks):
            # Check if new name conflicts with another bookmark
            if any(b['name'] == name for i, b in enumerate(self.bookmarks) if i != index):
                return False
            
            self.bookmarks[index] = {
                'name': name,
                'frequency': frequency,
                'mode': mode,
                'bandwidth_low': bandwidth_low,
                'bandwidth_high': bandwidth_high
            }
            return self._save_to_file()
        return False
    
    def get_bookmarks(self) -> List[Dict]:
        """Get all bookmarks.
        
        Returns:
            List of bookmark dictionaries
        """
        return self.bookmarks.copy()
    
    def get_bookmark(self, index: int) -> Optional[Dict]:
        """Get a specific bookmark by index.
        
        Args:
            index: Index of bookmark to retrieve
            
        Returns:
            Bookmark dictionary or None if index is invalid
        """
        if 0 <= index < len(self.bookmarks):
            return self.bookmarks[index].copy()
        return None
    
    def _save_to_file(self) -> bool:
        """Write bookmarks to config file.
        
        Returns:
            True if saved successfully, False otherwise
        """
        try:
            with open(self.config_file, 'w') as f:
                json.dump({'local_bookmarks': self.bookmarks}, f, indent=2)
            return True
        except IOError as e:
            print(f"Error: Failed to save local bookmarks: {e}")
            return False
    
    def export_bookmarks(self, export_file: Path) -> bool:
        """Export bookmarks to a file.
        
        Args:
            export_file: Path to export file
            
        Returns:
            True if exported successfully, False otherwise
        """
        try:
            with open(export_file, 'w') as f:
                json.dump({'local_bookmarks': self.bookmarks}, f, indent=2)
            return True
        except IOError as e:
            print(f"Error: Failed to export bookmarks: {e}")
            return False
    
    def import_bookmarks(self, import_file: Path, merge: bool = True) -> bool:
        """Import bookmarks from a file.
        
        Args:
            import_file: Path to import file
            merge: If True, merge with existing bookmarks. If False, replace.
            
        Returns:
            True if imported successfully, False otherwise
        """
        try:
            with open(import_file, 'r') as f:
                data = json.load(f)
                imported = data.get('local_bookmarks', [])
                
                if merge:
                    # Merge, avoiding duplicates by name
                    existing_names = {b['name'] for b in self.bookmarks}
                    for bookmark in imported:
                        if bookmark['name'] not in existing_names:
                            self.bookmarks.append(bookmark)
                else:
                    # Replace
                    self.bookmarks = imported
                
                return self._save_to_file()
        except (json.JSONDecodeError, IOError) as e:
            print(f"Error: Failed to import bookmarks: {e}")
            return False