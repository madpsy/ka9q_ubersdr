// Local Bookmarks Manager
// Handles client-side bookmark storage using IndexedDB.
// Automatically migrates any existing data from the legacy localStorage keys
// ('ubersdr_local_bookmarks' and 'ubersdr_local_bookmarks_backup') on first use,
// then removes those keys so they no longer consume the 5 MB quota.

const DB_NAME    = 'ubersdr_bookmarks';
const DB_VERSION = 1;
const STORE_NAME = 'bookmarks';

// Legacy localStorage keys (read-once for migration, then deleted)
const LS_KEY        = 'ubersdr_local_bookmarks';
const LS_BACKUP_KEY = 'ubersdr_local_bookmarks_backup';

class LocalBookmarkManager {
    constructor() {
        // In-memory cache — kept in sync with IndexedDB after every write
        this.bookmarks = [];

        // Promise that resolves once the DB is open and migration is complete.
        // All public methods await this before touching the DB.
        this.ready = this._open();
    }

    // -------------------------------------------------------------------------
    // IndexedDB lifecycle
    // -------------------------------------------------------------------------

    /** Open (or upgrade) the IndexedDB database, then migrate from localStorage. */
    _open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    // 'name' is the primary key — matches the bookmark.name field
                    db.createObjectStore(STORE_NAME, { keyPath: 'name' });
                }
            };

            req.onsuccess = async (event) => {
                this._db = event.target.result;
                try {
                    await this._migrateFromLocalStorage();
                    await this._loadAll();
                    console.log(`[LocalBookmarks] Ready — ${this.bookmarks.length} bookmark(s) in IndexedDB`);
                    resolve();
                } catch (err) {
                    console.error('[LocalBookmarks] Init error:', err);
                    reject(err);
                }
            };

            req.onerror = () => {
                console.error('[LocalBookmarks] Failed to open IndexedDB:', req.error);
                reject(req.error);
            };
        });
    }

    /**
     * If localStorage contains legacy bookmark data, import it into IndexedDB
     * and then remove the localStorage keys so they no longer consume quota.
     */
    async _migrateFromLocalStorage() {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return; // Nothing to migrate

        let migratedCount = 0;
        let migrationError = null;

        try {
            const legacy = JSON.parse(raw);
            if (Array.isArray(legacy) && legacy.length > 0) {
                console.log(`[LocalBookmarks] Migration: found ${legacy.length} bookmark(s) in localStorage — copying to IndexedDB…`);
                await this._putAll(legacy);
                migratedCount = legacy.length;
                console.log(`[LocalBookmarks] Migration successful: ${migratedCount} bookmark(s) moved to IndexedDB`);
            } else {
                console.log('[LocalBookmarks] Migration: localStorage key present but contained no bookmarks — cleaning up');
            }
        } catch (err) {
            migrationError = err;
            console.error('[LocalBookmarks] Migration failed — could not parse or write legacy localStorage data:', err);
            // Do NOT remove the localStorage keys if the write failed,
            // so the data is not lost and migration can be retried next load.
            return;
        }

        // Remove both legacy keys now that data is safely in IndexedDB.
        let cleanedMain   = false;
        let cleanedBackup = false;
        try { localStorage.removeItem(LS_KEY);        cleanedMain   = true; } catch (_) { /* ignore */ }
        try { localStorage.removeItem(LS_BACKUP_KEY); cleanedBackup = true; } catch (_) { /* ignore */ }

        if (migratedCount > 0) {
            console.log(
                `[LocalBookmarks] Migration complete — ${migratedCount} bookmark(s) migrated.` +
                ` localStorage keys removed: main=${cleanedMain}, backup=${cleanedBackup}`
            );
        }
    }

    // -------------------------------------------------------------------------
    // Low-level IndexedDB helpers
    // -------------------------------------------------------------------------

    /** Load all records from IndexedDB into this.bookmarks (in-memory cache). */
    _loadAll() {
        return new Promise((resolve, reject) => {
            const tx    = this._db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req   = store.getAll();
            req.onsuccess = () => {
                this.bookmarks = req.result || [];
                // Pre-cache label widths so the hot draw path never calls measureText()
                if (window._stampLabelWidth) {
                    this.bookmarks.forEach(window._stampLabelWidth);
                }
                resolve(this.bookmarks);
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Write a single bookmark record (insert or overwrite by name).
     * Also updates the in-memory cache entry.
     */
    _put(bookmark) {
        // Stamp label width before writing so the in-memory copy is always ready
        if (window._stampLabelWidth) window._stampLabelWidth(bookmark);
        return new Promise((resolve, reject) => {
            const tx    = this._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req   = store.put(bookmark);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    /**
     * Write an array of bookmark records in a single transaction.
     * Replaces the entire in-memory cache with the provided array.
     */
    _putAll(bookmarks) {
        return new Promise((resolve, reject) => {
            const tx    = this._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const bm of bookmarks) {
                store.put(bm);
            }
            tx.oncomplete = () => {
                // Refresh in-memory cache from the written data
                this.bookmarks = [...bookmarks];
                if (window._stampLabelWidth) {
                    this.bookmarks.forEach(window._stampLabelWidth);
                }
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Replace the entire object store with the provided array in one transaction.
     * Used by 'replace' import mode and deleteAll().
     */
    _replaceAll(bookmarks) {
        return new Promise((resolve, reject) => {
            const tx    = this._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.clear();
            for (const bm of bookmarks) {
                store.put(bm);
            }
            tx.oncomplete = () => {
                this.bookmarks = [...bookmarks];
                if (window._stampLabelWidth) {
                    this.bookmarks.forEach(window._stampLabelWidth);
                }
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    /** Delete a single record by name. */
    _delete(name) {
        return new Promise((resolve, reject) => {
            const tx    = this._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req   = store.delete(name);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    // -------------------------------------------------------------------------
    // Public API  (all async — callers should await manager.ready first)
    // -------------------------------------------------------------------------

    /** Return a shallow copy of all bookmarks from the in-memory cache. */
    getAll() {
        return [...this.bookmarks];
    }

    /** Return a single bookmark by name, or undefined. */
    get(name) {
        return this.bookmarks.find(b => b.name === name);
    }

    /** Return true if a bookmark with the given name exists. */
    exists(name) {
        return this.bookmarks.some(b => b.name === name);
    }

    /**
     * Add a new bookmark.
     * @throws if required fields are missing or name already exists.
     */
    async add(bookmark) {
        await this.ready;

        if (!bookmark.name || !bookmark.frequency || !bookmark.mode) {
            throw new Error('Bookmark must have name, frequency, and mode');
        }
        if (this.exists(bookmark.name)) {
            throw new Error(`Bookmark with name "${bookmark.name}" already exists`);
        }

        const newBookmark = {
            name:           bookmark.name,
            frequency:      parseInt(bookmark.frequency),
            mode:           bookmark.mode.toLowerCase(),
            group:          bookmark.group          || null,
            comment:        bookmark.comment        || null,
            extension:      bookmark.extension      || null,
            bandwidth_low:  typeof bookmark.bandwidth_low  === 'number' ? bookmark.bandwidth_low  : null,
            bandwidth_high: typeof bookmark.bandwidth_high === 'number' ? bookmark.bandwidth_high : null,
            source:         'local',
            created:        Date.now(),
            modified:       Date.now()
        };

        await this._put(newBookmark);
        // Update in-memory cache
        this.bookmarks.push(newBookmark);
        console.log(`[LocalBookmarks] Added: ${newBookmark.name}`);
        return newBookmark;
    }

    /**
     * Update an existing bookmark identified by oldName.
     * @throws if the bookmark is not found, or if the new name conflicts.
     */
    async update(oldName, updatedBookmark) {
        await this.ready;

        const index = this.bookmarks.findIndex(b => b.name === oldName);
        if (index === -1) {
            throw new Error(`Bookmark "${oldName}" not found`);
        }

        if (updatedBookmark.name && updatedBookmark.name !== oldName) {
            if (this.exists(updatedBookmark.name)) {
                throw new Error(`Bookmark with name "${updatedBookmark.name}" already exists`);
            }
            // Delete the old record (new name = new primary key)
            await this._delete(oldName);
        }

        const existing = this.bookmarks[index];
        const updated = {
            name:           updatedBookmark.name           || existing.name,
            frequency:      updatedBookmark.frequency !== undefined ? parseInt(updatedBookmark.frequency) : existing.frequency,
            mode:           updatedBookmark.mode           ? updatedBookmark.mode.toLowerCase() : existing.mode,
            group:          updatedBookmark.group          !== undefined ? updatedBookmark.group          : existing.group,
            comment:        updatedBookmark.comment        !== undefined ? updatedBookmark.comment        : existing.comment,
            extension:      updatedBookmark.extension      !== undefined ? updatedBookmark.extension      : existing.extension,
            bandwidth_low:  updatedBookmark.bandwidth_low  !== undefined ? updatedBookmark.bandwidth_low  : existing.bandwidth_low,
            bandwidth_high: updatedBookmark.bandwidth_high !== undefined ? updatedBookmark.bandwidth_high : existing.bandwidth_high,
            source:         'local',
            created:        existing.created,
            modified:       Date.now()
        };

        await this._put(updated);
        this.bookmarks[index] = updated;
        console.log(`[LocalBookmarks] Updated: ${updated.name}`);
        return updated;
    }

    /**
     * Delete a bookmark by name.
     * @throws if the bookmark is not found.
     */
    async delete(name) {
        await this.ready;

        const index = this.bookmarks.findIndex(b => b.name === name);
        if (index === -1) {
            throw new Error(`Bookmark "${name}" not found`);
        }

        await this._delete(name);
        const [deleted] = this.bookmarks.splice(index, 1);
        console.log(`[LocalBookmarks] Deleted: ${deleted.name}`);
        return deleted;
    }

    /** Delete all bookmarks. */
    async deleteAll() {
        await this.ready;
        const count = this.bookmarks.length;
        await this._replaceAll([]);
        console.log(`[LocalBookmarks] Deleted all ${count} bookmarks`);
        return count;
    }

    // -------------------------------------------------------------------------
    // Search / filter / sort  (synchronous — operate on in-memory cache)
    // -------------------------------------------------------------------------

    search(query) {
        const lowerQuery = query.toLowerCase();
        return this.bookmarks.filter(b =>
            b.name.toLowerCase().includes(lowerQuery) ||
            (b.group   && b.group.toLowerCase().includes(lowerQuery))   ||
            (b.comment && b.comment.toLowerCase().includes(lowerQuery)) ||
            b.frequency.toString().includes(query) ||
            b.mode.toLowerCase().includes(lowerQuery)
        );
    }

    filterByGroup(group) {
        if (!group) return this.bookmarks.filter(b => !b.group);
        return this.bookmarks.filter(b => b.group === group);
    }

    getGroups() {
        const groups = new Set();
        this.bookmarks.forEach(b => { if (b.group) groups.add(b.group); });
        return Array.from(groups).sort();
    }

    /** Sort the in-memory cache and persist the new order. */
    async sort(by = 'name', ascending = true) {
        await this.ready;

        const sortFunctions = {
            name:      (a, b) => a.name.localeCompare(b.name),
            frequency: (a, b) => a.frequency - b.frequency,
            mode:      (a, b) => a.mode.localeCompare(b.mode),
            group:     (a, b) => (a.group || '').localeCompare(b.group || ''),
            created:   (a, b) => a.created  - b.created,
            modified:  (a, b) => a.modified - b.modified
        };

        const sortFn = sortFunctions[by] || sortFunctions.name;
        this.bookmarks.sort((a, b) => ascending ? sortFn(a, b) : sortFn(b, a));
        // Persist the sorted array (IndexedDB doesn't have an inherent order,
        // but we keep the in-memory array sorted for consistent UI rendering)
        await this._putAll(this.bookmarks);
        return this.bookmarks;
    }

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    exportJSON() {
        return JSON.stringify(this.bookmarks, null, 2);
    }

    exportYAML() {
        let yaml = 'bookmarks:\n';
        this.bookmarks.forEach(bookmark => {
            yaml += `  - name: "${bookmark.name}"\n`;
            yaml += `    frequency: ${bookmark.frequency}\n`;
            yaml += `    mode: ${bookmark.mode}\n`;
            if (bookmark.group)          yaml += `    group: ${bookmark.group}\n`;
            if (bookmark.comment)        yaml += `    comment: "${bookmark.comment}"\n`;
            if (bookmark.extension)      yaml += `    extension: ${bookmark.extension}\n`;
            if (bookmark.bandwidth_low  !== null) yaml += `    bandwidth_low: ${bookmark.bandwidth_low}\n`;
            if (bookmark.bandwidth_high !== null) yaml += `    bandwidth_high: ${bookmark.bandwidth_high}\n`;
        });
        return yaml;
    }

    exportCSV() {
        const headers = ['Name', 'Frequency', 'Mode', 'Group', 'Comment', 'Extension', 'Bandwidth Low', 'Bandwidth High'];
        let csv = headers.join(',') + '\n';
        this.bookmarks.forEach(bookmark => {
            const row = [
                `"${bookmark.name}"`,
                bookmark.frequency,
                bookmark.mode,
                bookmark.group    ? `"${bookmark.group}"`    : '',
                bookmark.comment  ? `"${bookmark.comment}"`  : '',
                bookmark.extension || '',
                bookmark.bandwidth_low  !== null && bookmark.bandwidth_low  !== undefined ? bookmark.bandwidth_low  : '',
                bookmark.bandwidth_high !== null && bookmark.bandwidth_high !== undefined ? bookmark.bandwidth_high : ''
            ];
            csv += row.join(',') + '\n';
        });
        return csv;
    }

    exportKiwiSDR() {
        const dx = this.bookmarks.map(bookmark => {
            const groupToType = {
                'Active': 'T1', 'Watch': 'T2', 'Sub': 'T3', 'DX': 'T4',
                'Digital': 'T5', 'SSTV-FAX': 'T6', 'Aviation': 'T7',
                'Marine': 'T8', 'Mil-Gov': 'T9', 'Time': 'T10',
                'Beacons': 'T11', 'Broadcast': 'T12', 'Other': 'T13'
            };
            const entry = {
                f: Math.round(bookmark.frequency / 1000),
                m: this.modeToKiwiMode(bookmark.mode),
                n: bookmark.name
            };
            if (bookmark.group && groupToType[bookmark.group]) {
                entry[groupToType[bookmark.group]] = 1;
            }
            if (bookmark.extension) entry.pb = `ext:${bookmark.extension}`;
            if (bookmark.comment)   entry.no = encodeURIComponent(bookmark.comment);
            return entry;
        });
        return JSON.stringify({ dx }, null, 2);
    }

    // -------------------------------------------------------------------------
    // Import
    // -------------------------------------------------------------------------

    async importJSON(jsonString, mode = 'merge') {
        await this.ready;
        try {
            const data = JSON.parse(jsonString);
            let bookmarks = Array.isArray(data) ? data : (data.bookmarks || []);
            bookmarks = bookmarks.map(b => this.normalizeBookmark(b));
            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid JSON: ${error.message}`);
        }
    }

    async importYAML(yamlString, mode = 'merge') {
        await this.ready;
        try {
            const bookmarks = [];
            const lines = yamlString.split('\n');
            let currentBookmark = null;

            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('#')) continue;

                if (line.startsWith('- name:')) {
                    if (currentBookmark) bookmarks.push(currentBookmark);
                    currentBookmark = {
                        name: line.match(/name:\s*["']?(.+?)["']?\s*$/)?.[1] || ''
                    };
                } else if (currentBookmark) {
                    const match = line.match(/(\w+):\s*(.+)/);
                    if (match) {
                        const [, key, value] = match;
                        if      (key === 'frequency')      currentBookmark.frequency      = parseInt(value);
                        else if (key === 'mode')           currentBookmark.mode           = value;
                        else if (key === 'group')          currentBookmark.group          = value;
                        else if (key === 'comment')        currentBookmark.comment        = value.replace(/^["']|["']$/g, '');
                        else if (key === 'extension')      currentBookmark.extension      = value;
                        else if (key === 'bandwidth_low')  currentBookmark.bandwidth_low  = parseInt(value);
                        else if (key === 'bandwidth_high') currentBookmark.bandwidth_high = parseInt(value);
                    }
                }
            }
            if (currentBookmark) bookmarks.push(currentBookmark);

            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid YAML: ${error.message}`);
        }
    }

    async importCSV(csvString, mode = 'merge') {
        await this.ready;
        try {
            const lines = csvString.split('\n');
            const bookmarks = [];

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

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
                    bookmarks.push({
                        name:           fields[0].replace(/^"|"$/g, ''),
                        frequency:      parseInt(fields[1]),
                        mode:           fields[2],
                        group:          fields[3] ? fields[3].replace(/^"|"$/g, '') : null,
                        comment:        fields[4] ? fields[4].replace(/^"|"$/g, '') : null,
                        extension:      fields[5] || null,
                        bandwidth_low:  fields[6] ? parseInt(fields[6]) : null,
                        bandwidth_high: fields[7] ? parseInt(fields[7]) : null
                    });
                }
            }

            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid CSV: ${error.message}`);
        }
    }

    async importKiwiSDR(jsonString, mode = 'merge') {
        await this.ready;
        try {
            const data = JSON.parse(jsonString);
            if (!data.dx || !Array.isArray(data.dx)) {
                throw new Error('Invalid KiwiSDR format: missing dx array');
            }

            const typeToGroup = {
                'T1': 'Active',  'T2': 'Watch',    'T3': 'Sub',      'T4': 'DX',
                'T5': 'Digital', 'T6': 'SSTV-FAX', 'T7': 'Aviation', 'T8': 'Marine',
                'T9': 'Mil-Gov', 'T10': 'Time',    'T11': 'Beacons', 'T12': 'Broadcast',
                'T13': 'Other'
            };

            // KiwiSDR mode string → UberSDR mode string
            const modeStrMap = {
                'USB': 'usb', 'LSB': 'lsb',
                'CW':  'cwu', 'CWN': 'cwu',
                'AM':  'am',  'AMN': 'am',
                'FM':  'fm',  'NFM': 'nfm',
                'SAM': 'sam', 'NBFM': 'nfm'
            };

            const bookmarks = data.dx.map(entry => {
                let bookmark;

                if (Array.isArray(entry)) {
                    // ── Array-of-arrays format (native KiwiSDR dx.json export) ──
                    // Each entry: [freqKHz, modeString, name, comment, optionsObject]
                    const [freqKHz, modeStr, name, comment, options] = entry;

                    const resolvedMode = modeStrMap[(modeStr || '').toUpperCase()] || 'usb';

                    bookmark = {
                        name:      name || `${freqKHz} kHz`,
                        frequency: Math.round(freqKHz * 1000),
                        mode:      resolvedMode
                    };

                    // Decode URL-encoded comment (e.g. %5cn → newline)
                    if (comment && comment.trim()) {
                        try { bookmark.comment = decodeURIComponent(comment.replace(/\+/g, ' ')); }
                        catch (_) { bookmark.comment = comment; }
                    }

                    if (options && typeof options === 'object') {
                        // Extract group from type flags (T1–T15)
                        for (const [key, group] of Object.entries(typeToGroup)) {
                            if (options[key]) { bookmark.group = group; break; }
                        }
                        // Passband offsets (Hz) → bandwidth_low / bandwidth_high
                        if (typeof options.lo === 'number') bookmark.bandwidth_low  = options.lo;
                        if (typeof options.hi === 'number') bookmark.bandwidth_high = options.hi;
                        // Extension from 'p' preset field (e.g. "ft8,*")
                        if (options.p) {
                            const extMatch = options.p.toString().match(/^([^,]+)/);
                            if (extMatch) bookmark.extension = extMatch[1];
                        }
                    }

                } else {
                    // ── Object format (UberSDR export / older KiwiSDR API) ──
                    // Each entry: { n, f, m (numeric index), T4, pb, no, ... }
                    const rawMode = this.kiwiModeToMode(entry.m || 0);
                    const resolvedMode = modeStrMap[rawMode.toUpperCase()] || rawMode || 'usb';

                    bookmark = {
                        name:      entry.n || `${entry.f} kHz`,
                        frequency: entry.f * 1000,
                        mode:      resolvedMode
                    };

                    for (const [key, group] of Object.entries(typeToGroup)) {
                        if (entry[key]) { bookmark.group = group; break; }
                    }
                    if (entry.pb && entry.pb.startsWith('ext:')) {
                        bookmark.extension = entry.pb.substring(4);
                    }
                    if (entry.no) {
                        try { bookmark.comment = decodeURIComponent(entry.no.replace(/\+/g, ' ')); }
                        catch (_) { bookmark.comment = entry.no; }
                    }
                }

                return bookmark;
            });

            return this.importBookmarks(bookmarks, mode);
        } catch (error) {
            throw new Error(`Invalid KiwiSDR format: ${error.message}`);
        }
    }

    /**
     * Generic import — accumulates all changes in memory, then writes to
     * IndexedDB in a single transaction. This avoids the per-item save
     * overhead and the quota-doubling backup pattern of the old implementation.
     */
    async importBookmarks(bookmarks, mode = 'merge') {
        await this.ready;

        if (!Array.isArray(bookmarks)) {
            throw new Error('Bookmarks must be an array');
        }

        const imported = [];
        const skipped  = [];
        const errors   = [];

        // Work on a mutable copy of the current list
        let working = mode === 'replace' ? [] : [...this.bookmarks];

        // Build a name→index map for O(1) duplicate detection
        const nameIndex = new Map();
        working.forEach((b, i) => nameIndex.set(b.name, i));

        const now = Date.now();

        // Modes recognised by UberSDR — anything else falls back to 'usb'
        const VALID_MODES = new Set([
            'am', 'sam', 'usb', 'lsb', 'cw', 'cwu', 'cwl', 'fm', 'nfm', 'nbfm',
            'iq', 'iq48', 'iq96', 'iq192', 'iq384', 'drm'
        ]);

        for (const [index, bookmark] of bookmarks.entries()) {
            try {
                if (!bookmark.name || !bookmark.frequency || !bookmark.mode) {
                    skipped.push({ index, reason: 'Missing required fields', bookmark });
                    continue;
                }

                const rawMode = bookmark.mode.toString().toLowerCase();
                const resolvedMode = VALID_MODES.has(rawMode) ? rawMode : 'usb';
                if (resolvedMode !== rawMode) {
                    console.warn(`[LocalBookmarks] Unknown mode "${rawMode}" for "${bookmark.name}" — falling back to usb`);
                }

                const normalised = {
                    name:           bookmark.name,
                    frequency:      parseInt(bookmark.frequency),
                    mode:           resolvedMode,
                    group:          bookmark.group          || null,
                    comment:        bookmark.comment        || null,
                    extension:      bookmark.extension      || null,
                    bandwidth_low:  typeof bookmark.bandwidth_low  === 'number' ? bookmark.bandwidth_low  : null,
                    bandwidth_high: typeof bookmark.bandwidth_high === 'number' ? bookmark.bandwidth_high : null,
                    source:         'local',
                    modified:       now
                };

                if (nameIndex.has(bookmark.name)) {
                    if (mode === 'skip') {
                        skipped.push({ index, reason: 'Duplicate name', bookmark });
                        continue;
                    } else if (mode === 'merge') {
                        const existingIdx = nameIndex.get(bookmark.name);
                        normalised.created = working[existingIdx].created || now;
                        working[existingIdx] = normalised;
                        imported.push(bookmark.name);
                        continue;
                    }
                }

                // New bookmark
                normalised.created = now;
                nameIndex.set(bookmark.name, working.length);
                working.push(normalised);
                imported.push(bookmark.name);
            } catch (error) {
                errors.push({ index, error: error.message, bookmark });
            }
        }

        // Single bulk write to IndexedDB
        if (mode === 'replace') {
            await this._replaceAll(working);
        } else {
            await this._putAll(working);
        }

        console.log(`[LocalBookmarks] Import complete — ${imported.length} imported, ${skipped.length} skipped, ${errors.length} errors`);

        return {
            imported: imported.length,
            skipped:  skipped.length,
            errors:   errors.length,
            details:  { imported, skipped, errors }
        };
    }

    // -------------------------------------------------------------------------
    // Statistics
    // -------------------------------------------------------------------------

    getStats() {
        const freqs = this.bookmarks.map(b => b.frequency);
        return {
            total:          this.bookmarks.length,
            groups:         this.getGroups().length,
            modes:          new Set(this.bookmarks.map(b => b.mode)).size,
            withComments:   this.bookmarks.filter(b => b.comment).length,
            withExtensions: this.bookmarks.filter(b => b.extension).length,
            withBandwidth:  this.bookmarks.filter(b => b.bandwidth_low !== null || b.bandwidth_high !== null).length,
            frequencyRange: {
                min: freqs.length ? Math.min(...freqs) : 0,
                max: freqs.length ? Math.max(...freqs) : 0
            }
        };
    }

    // -------------------------------------------------------------------------
    // Mode helpers
    // -------------------------------------------------------------------------

    modeToKiwiMode(mode) {
        const modeMap = { am: 0, amn: 1, usb: 2, lsb: 3, cw: 4, cwn: 5, nbfm: 6, iq: 7, drm: 8 };
        return modeMap[mode.toLowerCase()] || 0;
    }

    kiwiModeToMode(modeIndex) {
        const modes = ['am', 'amn', 'usb', 'lsb', 'cw', 'cwn', 'nbfm', 'iq', 'drm'];
        return modes[modeIndex] || 'am';
    }

    // -------------------------------------------------------------------------
    // Normalise bookmark from various import formats
    // -------------------------------------------------------------------------

    normalizeBookmark(bookmark) {
        if (bookmark.frequency && bookmark.name && bookmark.mode) return bookmark;

        const mode = bookmark.mode || bookmark.modulation || bookmark.m || 'usb';
        return {
            name:           bookmark.name      || bookmark.label  || bookmark.title || 'Unnamed',
            frequency:      bookmark.frequency || bookmark.frequencyHz || bookmark.freq || bookmark.f || 0,
            mode:           mode.toString().toLowerCase(),
            group:          bookmark.group     || bookmark.category || bookmark.type || null,
            comment:        bookmark.comment   || bookmark.notes  || bookmark.description || null,
            extension:      bookmark.extension || bookmark.decoder || null,
            bandwidth_low:  bookmark.bandwidth_low  || bookmark.bandwidthLow  || null,
            bandwidth_high: bookmark.bandwidth_high || bookmark.bandwidthHigh || null
        };
    }
}

// Export for use as ES6 module
export default LocalBookmarkManager;

// Also expose on window for non-module usage
if (typeof window !== 'undefined') {
    window.LocalBookmarkManager = LocalBookmarkManager;
}
