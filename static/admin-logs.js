// Admin Logs Management
// Handles container log viewing with auto-refresh

let logsRefreshInterval = null;
let currentSelectedContainer = '';
let allLogs = []; // Store all logs for client-side filtering

/**
 * Load available container names from the API
 */
async function loadContainerNames() {
    try {
        const response = await fetch('/admin/logs');
        if (response.status === 401) {
            // Auth failed
            return;
        }

        const data = await response.json();
        const select = document.getElementById('containerSelect');

        // Save current selection
        const currentValue = select.value;

        // Clear and rebuild options
        select.innerHTML = '<option value="">Select a container...</option>';

        if (data.container_names && data.container_names.length > 0) {
            // Sort container names alphabetically
            data.container_names.sort().forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                select.appendChild(option);
            });

            // Restore selection if it still exists
            if (currentValue && data.container_names.includes(currentValue)) {
                select.value = currentValue;
            } else if (!currentValue && data.container_names.includes('ka9q_ubersdr')) {
                // Auto-select ka9q_ubersdr if available and no previous selection
                select.value = 'ka9q_ubersdr';
                currentSelectedContainer = 'ka9q_ubersdr';
                // Trigger load and auto-refresh
                loadLogs();
                const autoRefreshCheckbox = document.getElementById('logsAutoRefresh');
                if (autoRefreshCheckbox && autoRefreshCheckbox.checked) {
                    startLogsAutoRefresh();
                }
            }
        } else {
            select.innerHTML += '<option value="" disabled>No containers found</option>';
        }
    } catch (error) {
        console.error('Failed to load container names:', error);
        showAlert('Failed to load containers: ' + error.message, 'error');
    }
}

/**
 * Load logs for the selected container
 */
async function loadLogs() {
    const container = document.getElementById('containerSelect').value;
    const display = document.getElementById('logsDisplay');

    if (!container) {
        allLogs = [];
        display.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">Please select a container to view logs</div>';
        return;
    }

    // Store current selection
    currentSelectedContainer = container;

    try {
        const response = await fetch(`/admin/logs?container=${encodeURIComponent(container)}&limit=1000`);

        if (response.status === 401) {
            // Auth failed, stop auto-refresh
            stopLogsAutoRefresh();
            return;
        }

        const data = await response.json();

        if (!data.logs || data.logs.length === 0) {
            allLogs = [];
            display.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">No logs available for this container</div>';
            return;
        }

        // Store all logs for filtering
        allLogs = data.logs;

        // Update source dropdown with available sources
        updateSourceDropdown();

        // Apply current filter
        filterAndDisplayLogs();

        // Update count display
        const countDisplay = document.getElementById('logsCount');
        if (countDisplay) {
            const filterInput = document.getElementById('logsFilter');
            const filterText = filterInput ? filterInput.value : '';
            if (filterText) {
                const filteredCount = allLogs.filter(log => log.log.toLowerCase().includes(filterText.toLowerCase())).length;
                countDisplay.textContent = `Showing ${filteredCount} of ${data.total} logs (filtered)`;
            } else {
                countDisplay.textContent = `Showing ${data.count} of ${data.total} logs`;
            }
        }
    } catch (error) {
        console.error('Failed to load logs:', error);
        display.innerHTML = `<div style="color: #f44; padding: 20px;">Error loading logs: ${escapeHtml(error.message)}</div>`;
    }
}

/**
 * Update source dropdown with available sources from current logs
 */
function updateSourceDropdown() {
    const sourceSelect = document.getElementById('sourceSelect');
    if (!sourceSelect) return;

    // Save current selection
    const currentValue = sourceSelect.value;

    // Get unique sources from logs
    const sources = new Set();
    allLogs.forEach(log => {
        if (log.source) {
            sources.add(log.source);
        }
    });

    // Rebuild dropdown
    sourceSelect.innerHTML = '<option value="">All sources</option>';
    Array.from(sources).sort().forEach(source => {
        const option = document.createElement('option');
        option.value = source;
        option.textContent = source;
        sourceSelect.appendChild(option);
    });

    // Restore selection if it still exists
    if (currentValue && sources.has(currentValue)) {
        sourceSelect.value = currentValue;
    }
}

/**
 * Handle source selection change
 */
function onSourceChange() {
    filterAndDisplayLogs();
}

/**
 * Filter and display logs based on current filter text and source
 */
function filterAndDisplayLogs() {
    const display = document.getElementById('logsDisplay');
    const filterInput = document.getElementById('logsFilter');
    const sourceSelect = document.getElementById('sourceSelect');
    const filterText = filterInput ? filterInput.value.toLowerCase() : '';
    const sourceFilter = sourceSelect ? sourceSelect.value : '';

    // Filter logs by source first, then by text
    let logsToDisplay = allLogs;

    // Filter by source if selected
    if (sourceFilter) {
        logsToDisplay = logsToDisplay.filter(log => log.source === sourceFilter);
    }

    // Filter by text if provided
    if (filterText) {
        logsToDisplay = logsToDisplay.filter(log => log.log.toLowerCase().includes(filterText));
    }

    if (logsToDisplay.length === 0 && (filterText || sourceFilter)) {
        display.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">No logs match the filter</div>';
        return;
    }

    if (logsToDisplay.length === 0) {
        display.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">No logs available</div>';
        return;
    }

    // Build log display
    const logLines = logsToDisplay.map(log => {
        const date = new Date(log.date);
        const timestamp = date.toLocaleString('en-GB', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        // Escape HTML to prevent XSS
        const logText = escapeHtml(log.log.trim());

        // Color code based on log level
        let color = '#0f0'; // Default green
        if (logText.includes('ERROR') || logText.includes('FATAL') || logText.includes('CRITICAL')) {
            color = '#f44';
        } else if (logText.includes('WARN') || logText.includes('WARNING')) {
            color = '#fa0';
        } else if (logText.includes('INFO')) {
            color = '#4af';
        }

        return `<div style="color: ${color}; margin-bottom: 2px;"><span style="color: #888;">[${timestamp}]</span> ${logText}</div>`;
    }).join('');

    display.innerHTML = logLines;

    // Auto-scroll to bottom
    display.scrollTop = display.scrollHeight;

    // Update count display if filtering
    const countDisplay = document.getElementById('logsCount');
    if (countDisplay && (filterText || sourceFilter)) {
        countDisplay.textContent = `Showing ${logsToDisplay.length} of ${allLogs.length} logs (filtered)`;
    }
}

/**
 * Handle filter input change
 */
function onFilterChange() {
    filterAndDisplayLogs();
}

/**
 * Start auto-refresh for logs (every 5 seconds)
 */
function startLogsAutoRefresh() {
    // Clear any existing interval
    stopLogsAutoRefresh();

    // Only start if a container is selected
    if (currentSelectedContainer) {
        logsRefreshInterval = setInterval(() => {
            loadLogs();
        }, 5000); // Refresh every 5 seconds
    }
}

/**
 * Stop auto-refresh for logs
 */
function stopLogsAutoRefresh() {
    if (logsRefreshInterval) {
        clearInterval(logsRefreshInterval);
        logsRefreshInterval = null;
    }
}

/**
 * Handle container selection change
 */
function onContainerChange() {
    const container = document.getElementById('containerSelect').value;
    currentSelectedContainer = container;

    // Enable/disable download button
    const downloadBtn = document.getElementById('downloadLogsBtn');
    if (downloadBtn) {
        downloadBtn.disabled = !container;
    }

    if (container) {
        loadLogs();
        // Start auto-refresh if checkbox is checked
        const autoRefreshCheckbox = document.getElementById('logsAutoRefresh');
        if (autoRefreshCheckbox && autoRefreshCheckbox.checked) {
            startLogsAutoRefresh();
        }
    } else {
        stopLogsAutoRefresh();
        allLogs = [];
        document.getElementById('logsDisplay').innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">Please select a container to view logs</div>';
    }
}

/**
 * Handle auto-refresh checkbox change
 */
function onAutoRefreshChange() {
    const checkbox = document.getElementById('logsAutoRefresh');
    const container = document.getElementById('containerSelect').value;

    if (checkbox.checked && container) {
        startLogsAutoRefresh();
    } else {
        stopLogsAutoRefresh();
    }
}

/**
 * Download logs for the selected container
 */
async function downloadLogs() {
    const container = document.getElementById('containerSelect').value;

    if (!container) {
        showAlert('Please select a container first', 'error');
        return;
    }

    try {
        const response = await fetch(`/admin/logs?container=${encodeURIComponent(container)}&limit=1000`);

        if (response.status === 401) {
            showAlert('Authentication required', 'error');
            return;
        }

        const data = await response.json();

        if (!data.logs || data.logs.length === 0) {
            showAlert('No logs available to download', 'info');
            return;
        }

        // Format logs as plain text
        const logText = data.logs.map(log => {
            const date = new Date(log.date);
            const timestamp = date.toISOString();
            return `[${timestamp}] ${log.log.trim()}`;
        }).join('\n');

        // Create blob and download
        const blob = new Blob([logText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${container}-logs-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showAlert(`Downloaded ${data.logs.length} log entries`, 'success');
    } catch (error) {
        console.error('Failed to download logs:', error);
        showAlert('Failed to download logs: ' + error.message, 'error');
    }
}

/**
 * Clear logs display
 */
function clearLogsDisplay() {
    allLogs = [];
    document.getElementById('logsDisplay').innerHTML = '';
    const countDisplay = document.getElementById('logsCount');
    if (countDisplay) {
        countDisplay.textContent = '';
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Initialize logs tab when it becomes active
 */
function initLogsTab() {
    loadContainerNames();
    clearLogsDisplay();

    // Set up auto-refresh if a container is already selected
    const container = document.getElementById('containerSelect').value;
    if (container) {
        currentSelectedContainer = container;
        loadLogs();
        const autoRefreshCheckbox = document.getElementById('logsAutoRefresh');
        if (autoRefreshCheckbox && autoRefreshCheckbox.checked) {
            startLogsAutoRefresh();
        }
    }

    // Set initial download button state
    const downloadBtn = document.getElementById('downloadLogsBtn');
    if (downloadBtn) {
        downloadBtn.disabled = !container;
    }
}

/**
 * Cleanup when leaving logs tab
 */
function cleanupLogsTab() {
    stopLogsAutoRefresh();
}
