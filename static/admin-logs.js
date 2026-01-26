// Admin Logs Management
// Handles container log viewing with auto-refresh

let logsRefreshInterval = null;
let currentSelectedContainer = '';

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
            display.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">No logs available for this container</div>';
            return;
        }
        
        // Build log display
        const logLines = data.logs.map(log => {
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
        
        // Update count display
        const countDisplay = document.getElementById('logsCount');
        if (countDisplay) {
            countDisplay.textContent = `Showing ${data.count} of ${data.total} logs`;
        }
    } catch (error) {
        console.error('Failed to load logs:', error);
        display.innerHTML = `<div style="color: #f44; padding: 20px;">Error loading logs: ${escapeHtml(error.message)}</div>`;
    }
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
    
    if (container) {
        loadLogs();
        startLogsAutoRefresh();
    } else {
        stopLogsAutoRefresh();
        document.getElementById('logsDisplay').innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">Please select a container to view logs</div>';
    }
}

/**
 * Clear logs display
 */
function clearLogsDisplay() {
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
        startLogsAutoRefresh();
    }
}

/**
 * Cleanup when leaving logs tab
 */
function cleanupLogsTab() {
    stopLogsAutoRefresh();
}
