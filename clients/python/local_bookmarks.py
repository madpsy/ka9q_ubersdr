#!/usr/bin/env python3
"""
Local Bookmark Manager for ka9q_ubersdr Python Client
Manages user's personal bookmarks stored locally.
Compatible with web UI bookmark format.
"""

import json
import os
import time
from pathlib import Path
from typing import List, Dict, Optional, Any


class LocalBookmarkManager:
    """Manages local bookmarks stored in user's config directory.

    Compatible with web UI bookmark format including:
    - name, frequency, mode (required)
    - bandwidth_low, bandwidth_high (optional)
    - group, comment, extension (optional)
    - source, created, modified (auto-managed)
    """

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
                    # Support both wrapped and unwrapped formats
                    if isinstance(data, list):
                        return data
                    return data.get('local_bookmarks', data if isinstance(data, list) else [])
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Failed to load local bookmarks: {e}")
                return []
        return []

    def save_bookmark(self, name: str, frequency: int, mode: str,
                     bandwidth_low: Optional[int] = None,
                     bandwidth_high: Optional[int] = None,
                     group: Optional[str] = None,
                     comment: Optional[str] = None,
                     extension: Optional[str] = None,
                     overwrite: bool = False) -> bool:
        """Save a new bookmark or overwrite an existing one.

        Args:
            name: Bookmark name
            frequency: Frequency in Hz
            mode: Demodulation mode (e.g., 'usb', 'lsb', 'am')
            bandwidth_low: Low bandwidth edge in Hz (optional)
            bandwidth_high: High bandwidth edge in Hz (optional)
            group: Category/group for organization (optional)
            comment: Notes about this bookmark (optional)
            extension: Decoder extension to auto-open (optional)
            overwrite: If True, overwrite existing bookmark with same name

        Returns:
            True if saved successfully, False otherwise
        """
        # Check if bookmark with same name already exists
        existing_index = None
        for i, b in enumerate(self.bookmarks):
            if b['name'] == name:
                existing_index = i
                break

        current_time = int(time.time() * 1000)  # Milliseconds since epoch

        if existing_index is not None:
            if overwrite:
                # Preserve created timestamp when updating
                created = self.bookmarks[existing_index].get('created', current_time)
                bookmark = self._create_bookmark_dict(
                    name, frequency, mode, bandwidth_low, bandwidth_high,
                    group, comment, extension, created, current_time
                )
                self.bookmarks[existing_index] = bookmark
            else:
                # Don't overwrite without permission
                return False
        else:
            # Add new bookmark
            bookmark = self._create_bookmark_dict(
                name, frequency, mode, bandwidth_low, bandwidth_high,
                group, comment, extension, current_time, current_time
            )
            self.bookmarks.append(bookmark)

        return self._save_to_file()

    def _create_bookmark_dict(self, name: str, frequency: int, mode: str,
                             bandwidth_low: Optional[int],
                             bandwidth_high: Optional[int],
                             group: Optional[str],
                             comment: Optional[str],
                             extension: Optional[str],
                             created: int,
                             modified: int) -> Dict[str, Any]:
        """Create a bookmark dictionary with web UI compatible format.

        Args:
            name: Bookmark name
            frequency: Frequency in Hz
            mode: Demodulation mode
            bandwidth_low: Low bandwidth edge in Hz
            bandwidth_high: High bandwidth edge in Hz
            group: Category/group
            comment: Notes
            extension: Decoder extension
            created: Creation timestamp (ms)
            modified: Last modified timestamp (ms)

        Returns:
            Bookmark dictionary
        """
        return {
            'name': name,
            'frequency': frequency,
            'mode': mode.lower(),
            'group': group,
            'comment': comment,
            'extension': extension,
            'bandwidth_low': bandwidth_low,
            'bandwidth_high': bandwidth_high,
            'source': 'local',
            'created': created,
            'modified': modified
        }

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
            self.bookmarks[index]['modified'] = int(time.time() * 1000)
            return self._save_to_file()
        return False

    def update_bookmark(self, index: int, name: str, frequency: int, mode: str,
                       bandwidth_low: Optional[int] = None,
                       bandwidth_high: Optional[int] = None,
                       group: Optional[str] = None,
                       comment: Optional[str] = None,
                       extension: Optional[str] = None) -> bool:
        """Update an existing bookmark.

        Args:
            index: Index of bookmark to update
            name: New bookmark name
            frequency: New frequency in Hz
            mode: New demodulation mode
            bandwidth_low: New low bandwidth edge in Hz (optional)
            bandwidth_high: New high bandwidth edge in Hz (optional)
            group: New category/group (optional)
            comment: New notes (optional)
            extension: New decoder extension (optional)

        Returns:
            True if updated successfully, False otherwise
        """
        if 0 <= index < len(self.bookmarks):
            # Check if new name conflicts with another bookmark
            if any(b['name'] == name for i, b in enumerate(self.bookmarks) if i != index):
                return False

            # Preserve created timestamp
            created = self.bookmarks[index].get('created', int(time.time() * 1000))
            modified = int(time.time() * 1000)

            self.bookmarks[index] = self._create_bookmark_dict(
                name, frequency, mode, bandwidth_low, bandwidth_high,
                group, comment, extension, created, modified
            )
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
                # Save as array directly (web UI format)
                json.dump(self.bookmarks, f, indent=2)
            return True
        except IOError as e:
            print(f"Error: Failed to save local bookmarks: {e}")
            return False

    def export_bookmarks(self, export_file: Path) -> bool:
        """Export bookmarks to a file in web UI compatible JSON format.

        Args:
            export_file: Path to export file

        Returns:
            True if exported successfully, False otherwise
        """
        try:
            with open(export_file, 'w') as f:
                # Export as array directly (web UI format)
                json.dump(self.bookmarks, f, indent=2)
            return True
        except IOError as e:
            print(f"Error: Failed to export bookmarks: {e}")
            return False

    def import_bookmarks(self, import_file: Path, merge: bool = True) -> Dict[str, int]:
        """Import bookmarks from a file (web UI compatible).

        Supports both web UI format (array) and legacy format (wrapped in object).

        Args:
            import_file: Path to import file
            merge: If True, merge with existing bookmarks. If False, replace.

        Returns:
            Dictionary with import statistics: {'imported': N, 'skipped': N, 'errors': N}
        """
        stats = {'imported': 0, 'skipped': 0, 'errors': 0}

        try:
            with open(import_file, 'r') as f:
                data = json.load(f)

                # Support both formats
                if isinstance(data, list):
                    imported = data
                elif isinstance(data, dict):
                    imported = data.get('local_bookmarks', data.get('bookmarks', []))
                else:
                    print(f"Error: Invalid bookmark file format")
                    stats['errors'] = 1
                    return stats

                if not merge:
                    # Replace mode
                    self.bookmarks = []

                # Import bookmarks
                existing_names = {b['name'] for b in self.bookmarks}

                for bookmark in imported:
                    try:
                        # Validate required fields
                        if not all(k in bookmark for k in ['name', 'frequency', 'mode']):
                            stats['errors'] += 1
                            continue

                        name = bookmark['name']

                        if name in existing_names:
                            if merge:
                                # Skip duplicates in merge mode
                                stats['skipped'] += 1
                                continue
                            else:
                                # In replace mode, we already cleared bookmarks
                                pass

                        # Normalize bookmark to ensure all fields are present
                        current_time = int(time.time() * 1000)
                        normalized = self._create_bookmark_dict(
                            name=bookmark['name'],
                            frequency=bookmark['frequency'],
                            mode=bookmark['mode'],
                            bandwidth_low=bookmark.get('bandwidth_low'),
                            bandwidth_high=bookmark.get('bandwidth_high'),
                            group=bookmark.get('group'),
                            comment=bookmark.get('comment'),
                            extension=bookmark.get('extension'),
                            created=bookmark.get('created', current_time),
                            modified=bookmark.get('modified', current_time)
                        )

                        self.bookmarks.append(normalized)
                        existing_names.add(name)
                        stats['imported'] += 1

                    except Exception as e:
                        print(f"Warning: Failed to import bookmark: {e}")
                        stats['errors'] += 1

                self._save_to_file()

        except (json.JSONDecodeError, IOError) as e:
            print(f"Error: Failed to import bookmarks: {e}")
            stats['errors'] += 1

        return stats
