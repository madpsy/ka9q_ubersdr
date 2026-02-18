// Local Bookmarks Manager
// Handles client-side bookmark storage using localStorage
// Compatible with server bookmark format for easy import/export

class LocalBookmarkManager {
    constructor() {
        this.storageKey = 'ubersdr_local_bookmarks';
        this.backupKey = 'ubersdr_local_bookmarks_backup';
        this.bookmarks = [];
        this.load();
    }

    // Load bookmarks from localStorage
    load() {
        try {
            const data = localStorage.getItem(this.storageKey);
            if (data) {
                this.bookmarks = JSON.parse(data);
                console.log(`[LocalBookmarks] Loaded ${this.bookmarks.length} local bookmarks`);
            } else {
                this.bookmarks = [];
                console.log('[LocalBookmarks] No local bookmarks found, starting fresh');
            }
            return this.bookmarks;
        } catch (error) {
            console.error('[LocalBookmarks] Error loading bookmarks:', error);
            this.bookmarks = [];
            return [];
        }
    }

    // Save bookmarks to localStorage
    save() {
        try {
            // Create backup before saving
            const currentData = localStorage.getItem(this.storageKey);
            if (currentData) {
                localStorage.setItem(this.backupKey, currentData);
            }

            // Save new data
            localStorage.setItem(this.storageKey, JSON.stringify(this.bookmarks));
            console.log(`[LocalBookmarks] Saved ${this.bookmarks.length} bookmarks`);
            return true;
        } catch (error) {
            console.error('[LocalBookmarks] Error saving bookmarks:', error);
            return false;
        }
    }

    // Get all bookmarks
    getAll() {
        return [...this.bookmarks]; // Return copy to prevent external modification
    }

    // Get bookmark by name
    get(name) {
        return this.bookmarks.find(b => b.name === name);
    }

    // Check if bookmark exists
    exists(name) {
        return this.bookmarks.some(b => b.name === name);
    }

    // Add new bookmark
    add(bookmark) {
        // Validate required fields
        if (!bookmark.name || !bookmark.frequency || !bookmark.mode) {
            throw new Error('Bookmark must have name, frequency, and mode');
        }

        // Check for duplicate name
        if (this.exists(bookmark.name)) {
            throw new Error(`Bookmark with name "${bookmark.name}" already exists`);
        }

        // Create bookmark with metadata
        const newBookmark = {
            name: bookmark.name,
            frequency: parseInt(bookmark.frequency),
            mode: bookmark.mode.toLowerCase(),
            group: bookmark.group || null,
            comment: bookmark.comment || null,
            extension: bookmark.extension || null,
            bandwidth_low: typeof bookmark.bandwidth_low === 'number' ? bookmark.bandwidth_low : null,
            bandwidth_high: typeof bookmark.bandwidth_high === 'number' ? bookmark.bandwidth_high : null,
            source: 'local',
            created: Date.now(),
            modified: Date.now()
        };

        this.bookmarks.push(newBookmark);
        this.save();
        console.log(`[LocalBookmarks] Added bookmark: ${newBookmark.name}`);
        return newBookmark;
    }

    // Update existing bookmark
    update(oldName, updatedBookmark) {
        const index = this.bookmarks.findIndex(b => b.name === oldName);
        if (index === -1) {
            throw new Error(`Bookmark "${oldName}" not found`);
        }

        // If name is changing, check for conflicts
        if (updatedBookmark.name && updatedBookmark.name !== oldName) {
            if (this.exists(updatedBookmark.name)) {
                throw new Error(`Bookmark with name "${updatedBookmark.name}" already exists`);
            }
        }

        // Update bookmark, preserving created timestamp
        const existing = this.bookmarks[index];
        this.bookmarks[index] = {
            name: updatedBookmark.name || existing.name,
            frequency: updatedBookmark.frequency !== undefined ? parseInt(updatedBookmark.frequency) : existing.frequency,
            mode: updatedBookmark.mode ? updatedBookmark.mode.toLowerCase() : existing.mode,
            group: updatedBookmark.group !== undefined ? updatedBookmark.group : existing.group,
            comment: updatedBookmark.comment !== undefined ? updatedBookmark.comment : existing.comment,
            extension: updatedBookmark.extension !== undefined ? updatedBookmark.extension : existing.extension,
            bandwidth_low: updatedBookmark.bandwidth_low !== undefined ? updatedBookmark.bandwidth_low : existing.bandwidth_low,
            bandwidth_high: updatedBookmark.bandwidth_high !== undefined ? updatedBookmark.bandwidth_high : existing.bandwidth_high,
            source: 'local',
            created: existing.created,
            modified: Date.now()
        };

        this.save();
        console.log(`[LocalBookmarks] Updated bookmark: ${this.bookmarks[index].name}`);
        return this.bookmarks[index];
    }

    // Delete bookmark
    delete(name) {
        const index = this.bookmarks.findIndex(b => b.name === name);
        if (index === -1) {
            throw new Error(`Bookmark "${name}" not found`);
        }

        const deleted = this.bookmarks.splice(index, 1)[0];
        this.save();
        console.log(`[LocalBookmarks] Deleted bookmark: ${deleted.name}`);
        return deleted;
    }

    // Delete all bookmarks
    deleteAll() {
        const count = this.bookmarks.length;
        this.bookmarks = [];
        this.save();
        console.log(`[LocalBookmarks] Deleted all ${count} bookmarks`);
        return count;
    }

    // Search bookmarks
    search(query) {
        const lowerQuery = query.toLowerCase();
        return this.bookmarks.filter(b => 
            b.name.toLowerCase().includes(lowerQuery) ||
            (b.group && b.group.toLowerCase().includes(lowerQuery)) ||
            (b.comment && b.comment.toLowerCase().includes(lowerQuery)) ||
            b.frequency.toString().includes(query) ||
            b.mode.toLowerCase().includes(lowerQuery)
        );
    }

    // Filter by group
    filterByGroup(group) {
        if (!group) {
            return this.bookmarks.filter(b => !b.group);
        }
        return this.bookmarks.filter(b => b.group === group);
    }

    // Get all unique groups
    getGroups() {
        const groups = new Set();
        this.bookmarks.forEach(b => {
            if (b.group) {
                groups.add(b.group);
            }
        });
        return Array.from(groups).sort();
    }

    // Sort bookmarks
    sort(by = 'name', ascending = true) {
        const sortFunctions = {
            name: (a, b) => a.name.localeCompare(b.name),
            frequency: (a, b) => a.frequency - b.frequency,
            mode: (a, b) => a.mode.localeCompare(b.mode),
            group: (a, b) => (a.group || '').localeCompare(b.group || ''),
            created: (a, b) => a.created - b.created,
            modified: (a, b) => a.modified - b.modified
        };

        const sortFn = sortFunctions[by] || sortFunctions.name;
        this.bookmarks.sort((a, b) => ascending ? sortFn(a, b) : sortFn(b, a));
        this.save();
        return this.bookmarks;
    }

    // Export bookmarks to JSON
    exportJSON() {
        return JSON.stringify(this.bookmarks, null, 2);
    }

    // Export bookmarks to YAML format (compatible with server bookmarks.yaml)
    exportYAML() {
        let yaml = 'bookmarks:\n';
        this.bookmarks.forEach(bookmark => {
            yaml += `  - name: "${bookmark.name}"\n`;
            yaml += `    frequency: ${bookmark.frequency}\n`;
            yaml += `    mode: ${bookmark.mode}\n`;
            if (bookmark.group) {
                yaml += `    group: ${bookmark.group}\n`;
            }
            if (bookmark.comment) {
                yaml += `    comment: "${bookmark.comment}"\n`;
            }
            if (bookmark.extension) {
                yaml += `    extension: ${bookmark.extension}\n`;
            }
            if (bookmark.bandwidth_low !== null) {
                yaml += `    bandwidth_low: ${bookmark.bandwidth_low}\n`;
            }
            if (bookmark.bandwidth_high !== null) {
                yaml += `    bandwidth_high: ${bookmark.bandwidth_high}\n`;
            }
        });
        return yaml;
    }

    // Export bookmarks to CSV
    exportCSV() {
        const headers = ['Name', 'Frequency', 'Mode', 'Group', 'Comment', 'Extension', 'Bandwidth Low', 'Bandwidth High'];
        let csv = headers.join(',') + '\n';
        
        this.bookmarks.forEach(bookmark => {
            const row = [
                `"${bookmark.name}"`,
                bookmark.frequency,
                bookmark.mode,
                bookmark.group ? `"${bookmark.group}"` : '',
                bookmark.comment ? `"${bookmark.comment}"` : '',
                bookmark.extension || '',
                bookmark.bandwidth_low !== null && bookmark.bandwidth_low !== undefined ? bookmark.bandwidth_low : '',
                bookmark.bandwidth_high !== null && bookmark.bandwidth_high !== undefined ? bookmark.bandwidth_high : ''
            ];
            csv += row.join(',') + '\n';
        });
        
        return csv;
    }

    // Export to KiwiSDR format
    exportKiwiSDR() {
        const dx = this.bookmarks.map(bookmark => {
            // Map group to KiwiSDR type flags
            const groupToType = {
                'Active': 'T1',
                'Watch': 'T2',
                'Sub': 'T3',
                'DX': 'T4',
                'Digital': 'T5',
                'SSTV-FAX': 'T6',
                'Aviation': 'T7',
                'Marine': 'T8',
                'Mil-Gov': 'T9',
                'Time': 'T10',
                'Beacons': 'T11',
                'Broadcast': 'T12',
                'Other': 'T13'
            };

            const entry = {
                f: Math.round(bookmark.frequency / 1000), // Convert Hz to kHz
                m: this.modeToKiwiMode(bookmark.mode),
                n: bookmark.name
            };

            // Add type flag if group is recognized
            if (bookmark.group && groupToType[bookmark.group]) {
                entry[groupToType[bookmark.group]] = 1;
            }

            // Add extension as passband if present
            if (bookmark.extension) {
                entry.pb = `ext:${bookmark.extension}`;
            }

            // Add comment if present (URL encoded)
            if (bookmark.comment) {
                entry.no = encodeURIComponent(bookmark.comment);
            }

            return entry;
        });

        return JSON.stringify({ dx }, null, 2);
    }

    // Helper: Convert mode to KiwiSDR mode index
    modeToKiwiMode(mode) {
        const modeMap = {
            'am': 0,
            'amn': 1,
            'usb': 2,
            'lsb': 3,
            'cw': 4,
            'cwn': 5,
            'nbfm': 6,
            'iq': 7,
            'drm': 8
        };
        return modeMap[mode.toLowerCase()] || 0;
    }

    // Helper: Convert KiwiSDR mode index to mode string
    kiwiModeToMode(modeIndex) {
        const modes = ['am', 'amn', 'usb', 'lsb', 'cw', 'cwn', 'nbfm', 'iq', 'drm'];
        return modes[modeIndex] || 'am';
    }

    // Import bookmarks from JSON
    importJSON(jsonString, mode = 'merge') {
        try {
            const data = JSON.parse(jsonString);
            let bookmarks = Array.isArray(data) ? data : (data.bookmarks || []);
            
            // Auto-detect and convert alternate formats
            bookmarks = bookmarks.map(b => this.normalizeBookmark(b));
            
            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid JSON: ${error.message}`);
        }
    }

    // Normalize bookmark from various formats to standard format
    normalizeBookmark(bookmark) {
        // If already in standard format, return as-is
        if (bookmark.frequency && bookmark.name && bookmark.mode) {
            return bookmark;
        }

        // Detect and convert alternate formats
        const normalized = {};

        // Name field (various possibilities)
        normalized.name = bookmark.name || bookmark.label || bookmark.title || 'Unnamed';

        // Frequency field (various possibilities)
        normalized.frequency = bookmark.frequency ||
                              bookmark.frequencyHz ||
                              bookmark.freq ||
                              bookmark.f ||
                              0;

        // Mode field (various possibilities, normalize to lowercase)
        const mode = bookmark.mode ||
                    bookmark.modulation ||
                    bookmark.m ||
                    'usb';
        normalized.mode = mode.toString().toLowerCase();

        // Optional fields
        normalized.group = bookmark.group || bookmark.category || bookmark.type || null;
        normalized.comment = bookmark.comment || bookmark.notes || bookmark.description || null;
        normalized.extension = bookmark.extension || bookmark.decoder || null;
        normalized.bandwidth_low = bookmark.bandwidth_low || bookmark.bandwidthLow || null;
        normalized.bandwidth_high = bookmark.bandwidth_high || bookmark.bandwidthHigh || null;

        return normalized;
    }

    // Import bookmarks from YAML
    importYAML(yamlString, mode = 'merge') {
        try {
            // Simple YAML parser for bookmarks format
            const bookmarks = [];
            const lines = yamlString.split('\n');
            let currentBookmark = null;

            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('#')) continue;

                if (line.startsWith('- name:')) {
                    if (currentBookmark) {
                        bookmarks.push(currentBookmark);
                    }
                    currentBookmark = {
                        name: line.match(/name:\s*["']?(.+?)["']?\s*$/)?.[1] || ''
                    };
                } else if (currentBookmark) {
                    const match = line.match(/(\w+):\s*(.+)/);
                    if (match) {
                        const [, key, value] = match;
                        if (key === 'frequency') {
                            currentBookmark.frequency = parseInt(value);
                        } else if (key === 'mode') {
                            currentBookmark.mode = value;
                        } else if (key === 'group') {
                            currentBookmark.group = value;
                        } else if (key === 'comment') {
                            currentBookmark.comment = value.replace(/^["']|["']$/g, '');
                        } else if (key === 'extension') {
                            currentBookmark.extension = value;
                        } else if (key === 'bandwidth_low') {
                            currentBookmark.bandwidth_low = parseInt(value);
                        } else if (key === 'bandwidth_high') {
                            currentBookmark.bandwidth_high = parseInt(value);
                        }
                    }
                }
            }

            if (currentBookmark) {
                bookmarks.push(currentBookmark);
            }

            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid YAML: ${error.message}`);
        }
    }

    // Import bookmarks from CSV
    importCSV(csvString, mode = 'merge') {
        try {
            const lines = csvString.split('\n');
            const bookmarks = [];

            // Skip header row
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                // Simple CSV parser (handles quoted fields)
                const fields = [];
                let current = '';
                let inQuotes = false;

                for (let char of line) {
                    if (char === '"') {
                        inQuotes = !inQuotes;
                    } else if (char === ',' && !inQuotes) {
                        fields.push(current.trim());
                        current = '';
                    } else {
                        current += char;
                    }
                }
                fields.push(current.trim());

                if (fields.length >= 3) {
                    const bookmark = {
                        name: fields[0].replace(/^"|"$/g, ''),
                        frequency: parseInt(fields[1]),
                        mode: fields[2],
                        group: fields[3] ? fields[3].replace(/^"|"$/g, '') : null,
                        comment: fields[4] ? fields[4].replace(/^"|"$/g, '') : null,
                        extension: fields[5] || null,
                        bandwidth_low: fields[6] ? parseInt(fields[6]) : null,
                        bandwidth_high: fields[7] ? parseInt(fields[7]) : null
                    };
                    bookmarks.push(bookmark);
                }
            }

            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid CSV: ${error.message}`);
        }
    }

    // Import bookmarks from KiwiSDR format
    importKiwiSDR(jsonString, mode = 'merge') {
        try {
            const data = JSON.parse(jsonString);
            if (!data.dx || !Array.isArray(data.dx)) {
                throw new Error('Invalid KiwiSDR format: missing dx array');
            }

            const bookmarks = data.dx.map(entry => {
                const bookmark = {
                    name: entry.n || `${entry.f} kHz`,
                    frequency: entry.f * 1000, // Convert kHz to Hz
                    mode: this.kiwiModeToMode(entry.m || 0)
                };

                // Extract group from type flags
                const typeToGroup = {
                    'T1': 'Active',
                    'T2': 'Watch',
                    'T3': 'Sub',
                    'T4': 'DX',
                    'T5': 'Digital',
                    'T6': 'SSTV-FAX',
                    'T7': 'Aviation',
                    'T8': 'Marine',
                    'T9': 'Mil-Gov',
                    'T10': 'Time',
                    'T11': 'Beacons',
                    'T12': 'Broadcast',
                    'T13': 'Other'
                };

                for (let [key, group] of Object.entries(typeToGroup)) {
                    if (entry[key]) {
                        bookmark.group = group;
                        break;
                    }
                }

                // Extract extension from passband
                if (entry.pb && entry.pb.startsWith('ext:')) {
                    bookmark.extension = entry.pb.substring(4);
                }

                // Extract comment (URL decode)
                if (entry.no) {
                    try {
                        bookmark.comment = decodeURIComponent(entry.no.replace(/\+/g, ' '));
                    } catch (e) {
                        bookmark.comment = entry.no;
                    }
                }

                return bookmark;
            });

            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid KiwiSDR format: ${error.message}`);
        }
    }

    // Generic import function
    importBookmarks(bookmarks, mode = 'merge') {
        if (!Array.isArray(bookmarks)) {
            throw new Error('Bookmarks must be an array');
        }

        const imported = [];
        const skipped = [];
        const errors = [];

        if (mode === 'replace') {
            this.bookmarks = [];
        }

        bookmarks.forEach((bookmark, index) => {
            try {
                // Validate required fields
                if (!bookmark.name || !bookmark.frequency || !bookmark.mode) {
                    skipped.push({ index, reason: 'Missing required fields', bookmark });
                    return;
                }

                // Check for duplicates
                if (this.exists(bookmark.name)) {
                    if (mode === 'skip') {
                        skipped.push({ index, reason: 'Duplicate name', bookmark });
                        return;
                    } else if (mode === 'merge') {
                        // Update existing
                        this.update(bookmark.name, bookmark);
                        imported.push(bookmark.name);
                        return;
                    }
                }

                // Add bookmark
                this.add(bookmark);
                imported.push(bookmark.name);
            } catch (error) {
                errors.push({ index, error: error.message, bookmark });
            }
        });

        this.save();

        return {
            imported: imported.length,
            skipped: skipped.length,
            errors: errors.length,
            details: { imported, skipped, errors }
        };
    }

    // Restore from backup
    restoreBackup() {
        try {
            const backup = localStorage.getItem(this.backupKey);
            if (!backup) {
                throw new Error('No backup found');
            }

            localStorage.setItem(this.storageKey, backup);
            this.load();
            console.log('[LocalBookmarks] Restored from backup');
            return true;
        } catch (error) {
            console.error('[LocalBookmarks] Error restoring backup:', error);
            return false;
        }
    }

    // Get statistics
    getStats() {
        const stats = {
            total: this.bookmarks.length,
            groups: this.getGroups().length,
            modes: new Set(this.bookmarks.map(b => b.mode)).size,
            withComments: this.bookmarks.filter(b => b.comment).length,
            withExtensions: this.bookmarks.filter(b => b.extension).length,
            withBandwidth: this.bookmarks.filter(b => b.bandwidth_low !== null || b.bandwidth_high !== null).length,
            frequencyRange: {
                min: Math.min(...this.bookmarks.map(b => b.frequency)),
                max: Math.max(...this.bookmarks.map(b => b.frequency))
            }
        };

        return stats;
    }
}

// Export for use as ES6 module
export default LocalBookmarkManager;

// Also expose on window for non-module usage
if (typeof window !== 'undefined') {
    window.LocalBookmarkManager = LocalBookmarkManager;
}
