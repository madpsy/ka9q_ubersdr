// Local Bookmarks UI Module
// Provides user interface for managing local bookmarks
// Requires: local-bookmarks.js, local-bookmarks.css

import LocalBookmarkManager from './local-bookmarks.js';

class LocalBookmarksUI {
    constructor() {
        this.manager = new LocalBookmarkManager();
        this.currentEditingBookmark = null;
        this.filterGroup = null;
        this.searchQuery = '';
        this.sortBy = 'name';
        this.sortAscending = true;
        
        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    // Initialize UI
    init() {
        this.createModals();
        this.attachEventListeners();
        // Delay dropdown update to ensure DOM is ready
        setTimeout(() => this.updateMainDropdown(), 100);
        console.log('[LocalBookmarksUI] Initialized with', this.manager.getAll().length, 'bookmarks');
    }

    // Create modal HTML structures
    createModals() {
        // Main management modal
        this.createManagementModal();
        // Add/Edit modal
        this.createEditModal();
        // Import/Export modal
        this.createImportExportModal();
    }

    createManagementModal() {
        const modal = document.createElement('div');
        modal.id = 'local-bookmarks-management-modal';
        modal.className = 'local-bookmarks-modal';
        modal.innerHTML = `
            <div class="local-bookmarks-modal-content">
                <div class="local-bookmarks-modal-header">
                    <h2>⭐ My Bookmarks</h2>
                    <button class="local-bookmarks-close">&times;</button>
                </div>
                <div id="local-bookmarks-alert-container"></div>
                <div class="local-bookmarks-stats" id="local-bookmarks-stats"></div>
                <div class="local-bookmarks-toolbar">
                    <input type="text" class="local-bookmarks-search" id="local-bookmarks-search" placeholder="🔍 Search bookmarks...">
                    <button class="local-bookmarks-btn success" id="local-bookmarks-add-btn">+ Add</button>
                    <button class="local-bookmarks-btn" id="local-bookmarks-add-current-btn">+ Add Current</button>
                    <button class="local-bookmarks-btn" id="local-bookmarks-import-btn">📥 Import</button>
                    <button class="local-bookmarks-btn" id="local-bookmarks-export-btn">📤 Export</button>
                </div>
                <div class="local-bookmarks-filter-group" id="local-bookmarks-filter-group"></div>
                <div class="local-bookmarks-list" id="local-bookmarks-list"></div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    createEditModal() {
        const modal = document.createElement('div');
        modal.id = 'local-bookmarks-edit-modal';
        modal.className = 'local-bookmarks-modal';
        modal.innerHTML = `
            <div class="local-bookmarks-modal-content" style="max-width: 500px;">
                <div class="local-bookmarks-modal-header">
                    <h2 id="local-bookmarks-edit-title">Add Bookmark</h2>
                    <button class="local-bookmarks-close">&times;</button>
                </div>
                <div id="local-bookmarks-edit-alert-container"></div>
                <form id="local-bookmarks-edit-form">
                    <div class="local-bookmarks-form-group">
                        <label for="local-bookmarks-edit-name">Name *</label>
                        <input type="text" id="local-bookmarks-edit-name" required placeholder="e.g., WWV 10 MHz">
                        <small>Unique name for this bookmark</small>
                    </div>
                    <div class="local-bookmarks-form-group">
                        <label for="local-bookmarks-edit-frequency">Frequency (kHz) *</label>
                        <input type="number" id="local-bookmarks-edit-frequency" required placeholder="e.g., 7074" step="0.001">
                        <small>Frequency in kilohertz (will be converted to Hz)</small>
                    </div>
                    <div class="local-bookmarks-form-group">
                        <label for="local-bookmarks-edit-mode">Mode *</label>
                        <select id="local-bookmarks-edit-mode" required>
                            <option value="am">AM</option>
                            <option value="usb">USB</option>
                            <option value="lsb">LSB</option>
                            <option value="cw">CW</option>
                            <option value="cwu">CWU</option>
                            <option value="cwl">CWL</option>
                            <option value="nbfm">NBFM</option>
                        </select>
                    </div>
                    <div class="local-bookmarks-form-group">
                        <label for="local-bookmarks-edit-group">Group</label>
                        <input type="text" id="local-bookmarks-edit-group" placeholder="e.g., Digital, Voice, Beacons">
                        <small>Optional category for organizing bookmarks</small>
                    </div>
                    <div class="local-bookmarks-form-group">
                        <label for="local-bookmarks-edit-comment">Comment</label>
                        <textarea id="local-bookmarks-edit-comment" placeholder="Optional notes about this bookmark"></textarea>
                    </div>
                    <div class="local-bookmarks-form-group">
                        <label for="local-bookmarks-edit-extension">Extension</label>
                        <input type="text" id="local-bookmarks-edit-extension" placeholder="e.g., ft8, sstv">
                        <small>Decoder extension to open automatically</small>
                    </div>
                    <div class="local-bookmarks-form-actions">
                        <button type="button" class="local-bookmarks-btn secondary" id="local-bookmarks-edit-cancel">Cancel</button>
                        <button type="submit" class="local-bookmarks-btn success">Save</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(modal);
    }

    createImportExportModal() {
        const modal = document.createElement('div');
        modal.id = 'local-bookmarks-import-export-modal';
        modal.className = 'local-bookmarks-modal';
        modal.innerHTML = `
            <div class="local-bookmarks-modal-content" style="max-width: 600px;">
                <div class="local-bookmarks-modal-header">
                    <h2 id="local-bookmarks-ie-title">Import/Export</h2>
                    <button class="local-bookmarks-close">&times;</button>
                </div>
                <div id="local-bookmarks-ie-alert-container"></div>
                <div id="local-bookmarks-ie-content"></div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    // Attach event listeners
    attachEventListeners() {
        // Close buttons
        document.querySelectorAll('.local-bookmarks-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.target.closest('.local-bookmarks-modal').classList.remove('active');
            });
        });

        // Click outside to close
        document.querySelectorAll('.local-bookmarks-modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });

        // Management modal buttons
        document.getElementById('local-bookmarks-add-btn')?.addEventListener('click', () => this.showAddModal());
        document.getElementById('local-bookmarks-add-current-btn')?.addEventListener('click', () => this.addCurrentFrequency());
        document.getElementById('local-bookmarks-import-btn')?.addEventListener('click', () => this.showImportModal());
        document.getElementById('local-bookmarks-export-btn')?.addEventListener('click', () => this.showExportModal());
        document.getElementById('local-bookmarks-search')?.addEventListener('input', (e) => this.handleSearch(e.target.value));

        // Edit form
        document.getElementById('local-bookmarks-edit-form')?.addEventListener('submit', (e) => this.handleSaveBookmark(e));
        document.getElementById('local-bookmarks-edit-cancel')?.addEventListener('click', () => {
            document.getElementById('local-bookmarks-edit-modal').classList.remove('active');
        });
    }

    // Show management modal
    show() {
        this.renderStats();
        this.renderFilterTags();
        this.renderBookmarkList();
        document.getElementById('local-bookmarks-management-modal').classList.add('active');
    }

    // Hide management modal
    hide() {
        document.getElementById('local-bookmarks-management-modal').classList.remove('active');
    }

    // Show alert message
    showAlert(container, type, message) {
        const containerId = container === 'management' ? 'local-bookmarks-alert-container' :
                           container === 'edit' ? 'local-bookmarks-edit-alert-container' :
                           'local-bookmarks-ie-alert-container';
        
        const alertContainer = document.getElementById(containerId);
        if (!alertContainer) return;

        alertContainer.innerHTML = `
            <div class="local-bookmarks-alert ${type}">
                ${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'} ${message}
            </div>
        `;

        // Auto-hide success messages after 3 seconds
        if (type === 'success') {
            setTimeout(() => {
                alertContainer.innerHTML = '';
            }, 3000);
        }
    }

    // Render statistics
    renderStats() {
        const stats = this.manager.getStats();
        const container = document.getElementById('local-bookmarks-stats');
        
        if (stats.total === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'grid';
        container.innerHTML = `
            <div class="local-bookmarks-stat">
                <div class="local-bookmarks-stat-value">${stats.total}</div>
                <div class="local-bookmarks-stat-label">Total</div>
            </div>
            <div class="local-bookmarks-stat">
                <div class="local-bookmarks-stat-value">${stats.groups}</div>
                <div class="local-bookmarks-stat-label">Groups</div>
            </div>
            <div class="local-bookmarks-stat">
                <div class="local-bookmarks-stat-value">${stats.modes}</div>
                <div class="local-bookmarks-stat-label">Modes</div>
            </div>
            <div class="local-bookmarks-stat">
                <div class="local-bookmarks-stat-value">${stats.withExtensions}</div>
                <div class="local-bookmarks-stat-label">With Extensions</div>
            </div>
        `;
    }

    // Render filter tags
    renderFilterTags() {
        const groups = this.manager.getGroups();
        const container = document.getElementById('local-bookmarks-filter-group');
        
        if (groups.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        container.innerHTML = `
            <div class="local-bookmarks-filter-tag ${!this.filterGroup ? 'active' : ''}" data-group="">
                All
            </div>
            ${groups.map(group => `
                <div class="local-bookmarks-filter-tag ${this.filterGroup === group ? 'active' : ''}" data-group="${this.escapeHtml(group)}">
                    ${this.escapeHtml(group)}
                </div>
            `).join('')}
        `;

        // Attach click handlers
        container.querySelectorAll('.local-bookmarks-filter-tag').forEach(tag => {
            tag.addEventListener('click', () => {
                this.filterGroup = tag.dataset.group || null;
                this.renderFilterTags();
                this.renderBookmarkList();
            });
        });
    }

    // Render bookmark list
    renderBookmarkList() {
        const container = document.getElementById('local-bookmarks-list');
        let bookmarks = this.manager.getAll();

        // Apply filters
        if (this.searchQuery) {
            bookmarks = this.manager.search(this.searchQuery);
        }
        if (this.filterGroup) {
            bookmarks = bookmarks.filter(b => b.group === this.filterGroup);
        }

        // Sort
        bookmarks.sort((a, b) => {
            const result = this.sortBy === 'name' ? a.name.localeCompare(b.name) :
                          this.sortBy === 'frequency' ? a.frequency - b.frequency :
                          a.name.localeCompare(b.name);
            return this.sortAscending ? result : -result;
        });

        if (bookmarks.length === 0) {
            container.innerHTML = `
                <div class="local-bookmarks-empty">
                    <div class="local-bookmarks-empty-icon">📻</div>
                    <p>${this.searchQuery || this.filterGroup ? 'No bookmarks match your filter' : 'No bookmarks yet'}</p>
                    <p style="font-size: 0.9em; color: #7f8c8d;">Click "+ Add" or "+ Add Current" to create your first bookmark</p>
                </div>
            `;
            return;
        }

        container.innerHTML = bookmarks.map(bookmark => `
            <div class="local-bookmarks-item" data-name="${this.escapeHtml(bookmark.name)}">
                <div class="local-bookmarks-item-info" onclick="window.localBookmarksUI.tuneToBookmark('${this.escapeJs(bookmark.name)}')">
                    <div class="local-bookmarks-item-name">
                        ${this.escapeHtml(bookmark.name)}
                        ${bookmark.group ? `<span class="local-bookmarks-item-group">${this.escapeHtml(bookmark.group)}</span>` : ''}
                    </div>
                    <div class="local-bookmarks-item-details">
                        ${this.formatFrequency(bookmark.frequency)} • ${bookmark.mode.toUpperCase()}
                        ${bookmark.comment ? ` • ${this.escapeHtml(bookmark.comment)}` : ''}
                        ${bookmark.extension ? ` • 🔌 ${this.escapeHtml(bookmark.extension)}` : ''}
                    </div>
                </div>
                <div class="local-bookmarks-item-actions">
                    <button class="local-bookmarks-item-btn" onclick="window.localBookmarksUI.editBookmark('${this.escapeJs(bookmark.name)}')">✏️ Edit</button>
                    <button class="local-bookmarks-item-btn danger" onclick="window.localBookmarksUI.deleteBookmark('${this.escapeJs(bookmark.name)}')">🗑️ Delete</button>
                </div>
            </div>
        `).join('');
    }

    // Utility functions
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escapeJs(text) {
        return text.replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
    }

    formatFrequency(freq) {
        // Always display in kHz for consistency with input format
        return `${(freq / 1000).toFixed(1)} kHz`;
    }

    // Update the main UI dropdown and refresh spectrum display
    updateMainDropdown() {
        if (window.populateLocalBookmarkSelector) {
            window.populateLocalBookmarkSelector();
        }
        // Invalidate spectrum marker cache to force redraw with new bookmarks
        if (window.spectrumDisplay && window.spectrumDisplay.invalidateMarkerCache) {
            window.spectrumDisplay.invalidateMarkerCache();
            if (window.spectrumDisplay.draw) {
                window.spectrumDisplay.draw();
            }
        }
    }

    // Handle search
    handleSearch(query) {
        this.searchQuery = query.trim();
        this.renderBookmarkList();
    }

    // Show add modal
    showAddModal() {
        this.currentEditingBookmark = null;
        document.getElementById('local-bookmarks-edit-title').textContent = 'Add Bookmark';
        document.getElementById('local-bookmarks-edit-form').reset();
        document.getElementById('local-bookmarks-edit-alert-container').innerHTML = '';
        document.getElementById('local-bookmarks-edit-modal').classList.add('active');
    }

    // Add current frequency as bookmark
    addCurrentFrequency() {
        const freqInput = document.getElementById('frequency');
        // Get frequency from data-hz-value attribute (actual Hz value)
        const frequency = freqInput ? parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value) : null;
        
        let mode = 'usb';
        if (window.currentMode) {
            mode = window.currentMode;
        } else if (window.radioAPI && window.radioAPI.getMode) {
            mode = window.radioAPI.getMode();
        }

        // Get current bandwidth settings (use !== undefined to allow 0 values)
        const bandwidthLow = window.currentBandwidthLow !== undefined ? window.currentBandwidthLow : null;
        const bandwidthHigh = window.currentBandwidthHigh !== undefined ? window.currentBandwidthHigh : null;

        console.log('[LocalBookmarksUI] Capturing bandwidth - Low:', bandwidthLow, 'High:', bandwidthHigh);

        if (!frequency) {
            this.showAlert('management', 'error', 'Cannot determine current frequency');
            return;
        }

        // Store bandwidth in a temporary property so handleSaveBookmark can access it
        this.tempBandwidthLow = bandwidthLow;
        this.tempBandwidthHigh = bandwidthHigh;
        console.log('[LocalBookmarksUI] Stored temp bandwidth - Low:', this.tempBandwidthLow, 'High:', this.tempBandwidthHigh);

        this.currentEditingBookmark = null;
        document.getElementById('local-bookmarks-edit-title').textContent = 'Add Current Frequency';
        document.getElementById('local-bookmarks-edit-name').value = `${this.formatFrequency(frequency)}`;
        document.getElementById('local-bookmarks-edit-frequency').value = frequency / 1000; // Convert Hz to kHz
        document.getElementById('local-bookmarks-edit-mode').value = mode.toLowerCase();
        document.getElementById('local-bookmarks-edit-group').value = '';
        document.getElementById('local-bookmarks-edit-comment').value = bandwidthLow && bandwidthHigh ? `BW: ${bandwidthLow} to ${bandwidthHigh} Hz` : '';
        document.getElementById('local-bookmarks-edit-extension').value = '';
        document.getElementById('local-bookmarks-edit-alert-container').innerHTML = '';
        document.getElementById('local-bookmarks-edit-modal').classList.add('active');
    }

    // Edit bookmark
    editBookmark(name) {
        const bookmark = this.manager.get(name);
        if (!bookmark) {
            this.showAlert('management', 'error', `Bookmark "${name}" not found`);
            return;
        }

        this.currentEditingBookmark = name;
        document.getElementById('local-bookmarks-edit-title').textContent = 'Edit Bookmark';
        document.getElementById('local-bookmarks-edit-name').value = bookmark.name;
        document.getElementById('local-bookmarks-edit-frequency').value = bookmark.frequency / 1000; // Convert Hz to kHz
        document.getElementById('local-bookmarks-edit-mode').value = bookmark.mode;
        document.getElementById('local-bookmarks-edit-group').value = bookmark.group || '';
        document.getElementById('local-bookmarks-edit-comment').value = bookmark.comment || '';
        document.getElementById('local-bookmarks-edit-extension').value = bookmark.extension || '';
        document.getElementById('local-bookmarks-edit-alert-container').innerHTML = '';
        document.getElementById('local-bookmarks-edit-modal').classList.add('active');
    }

    // Delete bookmark
    deleteBookmark(name) {
        // Show custom confirmation dialog
        this.showConfirmDialog(
            'Delete Bookmark',
            `Are you sure you want to delete "${name}"?`,
            () => {
                try {
                    this.manager.delete(name);
                    this.showAlert('management', 'success', `Deleted bookmark "${name}"`);
                    this.renderStats();
                    this.renderFilterTags();
                    this.renderBookmarkList();
                    this.updateMainDropdown();
                } catch (error) {
                    this.showAlert('management', 'error', error.message);
                }
            }
        );
    }

    // Show custom confirmation dialog
    showConfirmDialog(title, message, onConfirm) {
        const existingDialog = document.getElementById('local-bookmarks-confirm-dialog');
        if (existingDialog) {
            existingDialog.remove();
        }

        const dialog = document.createElement('div');
        dialog.id = 'local-bookmarks-confirm-dialog';
        dialog.className = 'local-bookmarks-modal active';
        dialog.innerHTML = `
            <div class="local-bookmarks-modal-content" style="max-width: 400px;">
                <div class="local-bookmarks-modal-header">
                    <h2>${title}</h2>
                </div>
                <p style="margin: 20px 0; color: #ecf0f1;">${message}</p>
                <div class="local-bookmarks-form-actions">
                    <button class="local-bookmarks-btn secondary" id="local-bookmarks-confirm-cancel">Cancel</button>
                    <button class="local-bookmarks-btn danger" id="local-bookmarks-confirm-ok">Delete</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        // Handle cancel
        const handleCancel = () => {
            dialog.remove();
        };

        // Handle confirm
        const handleConfirm = () => {
            dialog.remove();
            if (onConfirm) onConfirm();
        };

        document.getElementById('local-bookmarks-confirm-cancel').addEventListener('click', handleCancel);
        document.getElementById('local-bookmarks-confirm-ok').addEventListener('click', handleConfirm);
        
        // Click outside to cancel
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                handleCancel();
            }
        });
    }

    // Handle save bookmark
    handleSaveBookmark(e) {
        e.preventDefault();

        const frequencyKHz = parseFloat(document.getElementById('local-bookmarks-edit-frequency').value);
        const bookmark = {
            name: document.getElementById('local-bookmarks-edit-name').value.trim(),
            frequency: Math.round(frequencyKHz * 1000), // Convert kHz to Hz
            mode: document.getElementById('local-bookmarks-edit-mode').value,
            group: document.getElementById('local-bookmarks-edit-group').value.trim() || null,
            comment: document.getElementById('local-bookmarks-edit-comment').value.trim() || null,
            extension: document.getElementById('local-bookmarks-edit-extension').value.trim() || null,
            bandwidth_low: typeof this.tempBandwidthLow === 'number' ? this.tempBandwidthLow : null,
            bandwidth_high: typeof this.tempBandwidthHigh === 'number' ? this.tempBandwidthHigh : null
        };

        console.log('[LocalBookmarksUI] Saving bookmark:', bookmark);
        console.log('[LocalBookmarksUI] Temp bandwidth before clear - Low:', this.tempBandwidthLow, 'High:', this.tempBandwidthHigh);

        // Clear temporary bandwidth values
        this.tempBandwidthLow = null;
        this.tempBandwidthHigh = null;

        try {
            if (this.currentEditingBookmark) {
                this.manager.update(this.currentEditingBookmark, bookmark);
                this.showAlert('management', 'success', `Updated bookmark "${bookmark.name}"`);
            } else {
                this.manager.add(bookmark);
                this.showAlert('management', 'success', `Added bookmark "${bookmark.name}"`);
            }

            document.getElementById('local-bookmarks-edit-modal').classList.remove('active');
            this.renderStats();
            this.renderFilterTags();
            this.renderBookmarkList();
            this.updateMainDropdown();
        } catch (error) {
            this.showAlert('edit', 'error', error.message);
        }
    }

    // Tune to bookmark
    tuneToBookmark(name) {
        const bookmark = this.manager.get(name);
        if (!bookmark) return;

        // Use existing bookmark click handler if available
        if (window.handleBookmarkClick) {
            window.handleBookmarkClick(bookmark, false, false);
        } else {
            // Fallback: set frequency and mode directly
            const freqInput = document.getElementById('frequency');
            if (freqInput) {
                freqInput.value = bookmark.frequency;
            }
            if (window.setMode) {
                window.setMode(bookmark.mode);
            }
            if (window.autoTune) {
                window.autoTune();
            }
        }

        console.log(`[LocalBookmarksUI] Tuned to ${bookmark.name}: ${bookmark.frequency} Hz ${bookmark.mode}`);
    }

    // Show import modal
    showImportModal() {
        const content = document.getElementById('local-bookmarks-ie-content');
        document.getElementById('local-bookmarks-ie-title').textContent = 'Import Bookmarks';
        document.getElementById('local-bookmarks-ie-alert-container').innerHTML = '';
        
        content.innerHTML = `
            <div class="local-bookmarks-import-area" id="local-bookmarks-drop-area">
                <p style="font-size: 1.2em; margin-bottom: 10px;">📁 Drop file here or click to browse</p>
                <p style="color: #95a5a6; font-size: 0.9em;">Supports: JSON, YAML, CSV, KiwiSDR format</p>
                <input type="file" id="local-bookmarks-file-input" accept=".json,.yaml,.yml,.csv" style="display: none;">
            </div>
            <div style="margin-top: 20px;">
                <label style="display: block; margin-bottom: 10px; color: #bdc3c7; font-weight: bold;">Import Mode:</label>
                <select id="local-bookmarks-import-mode" style="width: 100%; padding: 8px; background: #34495e; border: 1px solid #7f8c8d; border-radius: 4px; color: #ecf0f1;">
                    <option value="merge">Merge - Update existing, add new</option>
                    <option value="replace">Replace - Delete all and import</option>
                    <option value="skip">Skip - Skip duplicates</option>
                </select>
            </div>
        `;

        const dropArea = document.getElementById('local-bookmarks-drop-area');
        const fileInput = document.getElementById('local-bookmarks-file-input');

        dropArea.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileImport(e.target.files[0]));

        // Drag and drop
        dropArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropArea.classList.add('dragover');
        });
        dropArea.addEventListener('dragleave', () => {
            dropArea.classList.remove('dragover');
        });
        dropArea.addEventListener('drop', (e) => {
            e.preventDefault();
            dropArea.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                this.handleFileImport(e.dataTransfer.files[0]);
            }
        });

        document.getElementById('local-bookmarks-import-export-modal').classList.add('active');
    }

    // Handle file import
    async handleFileImport(file) {
        if (!file) return;

        const mode = document.getElementById('local-bookmarks-import-mode').value;
        const reader = new FileReader();

        reader.onload = async (e) => {
            try {
                const content = e.target.result;
                const ext = file.name.split('.').pop().toLowerCase();
                let result;

                if (ext === 'json') {
                    result = this.manager.importJSON(content, mode);
                } else if (ext === 'yaml' || ext === 'yml') {
                    result = this.manager.importYAML(content, mode);
                } else if (ext === 'csv') {
                    result = this.manager.importCSV(content, mode);
                } else {
                    throw new Error('Unsupported file format');
                }

                this.showAlert('ie', 'success', `Imported ${result.imported} bookmarks (${result.skipped} skipped, ${result.errors} errors)`);
                this.renderStats();
                this.renderFilterTags();
                this.renderBookmarkList();
                this.updateMainDropdown();
            } catch (error) {
                this.showAlert('ie', 'error', `Import failed: ${error.message}`);
            }
        };

        reader.readAsText(file);
    }

    // Show export modal
    showExportModal() {
        const content = document.getElementById('local-bookmarks-ie-content');
        document.getElementById('local-bookmarks-ie-title').textContent = 'Export Bookmarks';
        document.getElementById('local-bookmarks-ie-alert-container').innerHTML = '';
        
        content.innerHTML = `
            <p style="margin-bottom: 15px; color: #bdc3c7;">Choose export format:</p>
            <button class="local-bookmarks-format-btn" onclick="window.localBookmarksUI.exportFormat('json')">
                <strong>JSON</strong>
                <span style="color: #ecf0f1;">Native format, best for backup</span>
            </button>
            <button class="local-bookmarks-format-btn" onclick="window.localBookmarksUI.exportFormat('yaml')">
                <strong>YAML</strong>
                <span style="color: #ecf0f1;">Compatible with server bookmarks.yaml</span>
            </button>
            <button class="local-bookmarks-format-btn" onclick="window.localBookmarksUI.exportFormat('csv')">
                <strong>CSV</strong>
                <span style="color: #ecf0f1;">For spreadsheet editing</span>
            </button>
            <button class="local-bookmarks-format-btn" onclick="window.localBookmarksUI.exportFormat('kiwisdr')">
                <strong>KiwiSDR</strong>
                <span style="color: #ecf0f1;">Compatible with KiwiSDR dx.json</span>
            </button>
        `;

        document.getElementById('local-bookmarks-import-export-modal').classList.add('active');
    }

    // Export in specified format
    exportFormat(format) {
        try {
            let content, filename, mimeType;

            switch (format) {
                case 'json':
                    content = this.manager.exportJSON();
                    filename = 'local-bookmarks.json';
                    mimeType = 'application/json';
                    break;
                case 'yaml':
                    content = this.manager.exportYAML();
                    filename = 'local-bookmarks.yaml';
                    mimeType = 'text/yaml';
                    break;
                case 'csv':
                    content = this.manager.exportCSV();
                    filename = 'local-bookmarks.csv';
                    mimeType = 'text/csv';
                    break;
                case 'kiwisdr':
                    content = this.manager.exportKiwiSDR();
                    filename = 'dx.json';
                    mimeType = 'application/json';
                    break;
                default:
                    throw new Error('Unknown format');
            }

            // Create download
            const blob = new Blob([content], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            this.showAlert('ie', 'success', `Exported ${this.manager.getAll().length} bookmarks as ${format.toUpperCase()}`);
        } catch (error) {
            this.showAlert('ie', 'error', `Export failed: ${error.message}`);
        }
    }
}

// Export for use as ES6 module
export default LocalBookmarksUI;

// Also expose on window for non-module usage and inline onclick handlers
if (typeof window !== 'undefined') {
    window.LocalBookmarksUI = LocalBookmarksUI;
    // Auto-initialize
    window.localBookmarksUI = new LocalBookmarksUI();
}
