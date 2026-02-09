// Extension Panel Resize Functionality
// Allows users to drag-resize the extension panel height

(function() {
    'use strict';

    // Configuration
    const MIN_HEIGHT = 200;   // Minimum panel height in pixels
    const MAX_HEIGHT = 1200;  // Maximum panel height in pixels
    const STORAGE_KEY = 'extension-panel-height';

    // State
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;
    let resizeHandle = null;
    let extensionContent = null;
    let extensionContainer = null;

    // Initialize resize functionality when DOM is ready
    function initializeResize() {
        resizeHandle = document.querySelector('.decoder-extension-resize-handle');
        extensionContent = document.getElementById('extension-panel-content');
        extensionContainer = document.querySelector('.decoder-extension-container');

        if (!resizeHandle || !extensionContent || !extensionContainer) {
            console.warn('[Extension Resize] Required elements not found, retrying...');
            // Retry after a short delay in case elements aren't loaded yet
            setTimeout(initializeResize, 500);
            return;
        }

        // Load saved height from localStorage
        loadSavedHeight();

        // Add event listeners
        resizeHandle.addEventListener('mousedown', startResize);
        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);

        // Touch support for mobile/tablet
        resizeHandle.addEventListener('touchstart', startResizeTouch);
        document.addEventListener('touchmove', doResizeTouch);
        document.addEventListener('touchend', stopResize);

        console.log('[Extension Resize] ✅ Resize functionality initialized');
    }

    // Load saved height from localStorage
    function loadSavedHeight() {
        try {
            const savedHeight = localStorage.getItem(STORAGE_KEY);
            if (savedHeight) {
                const height = parseInt(savedHeight, 10);
                if (height >= MIN_HEIGHT && height <= MAX_HEIGHT) {
                    setContentHeight(height);
                    console.log(`[Extension Resize] Loaded saved height: ${height}px`);
                }
            }
        } catch (err) {
            console.warn('[Extension Resize] Failed to load saved height:', err);
        }
    }

    // Save height to localStorage
    function saveHeight(height) {
        try {
            localStorage.setItem(STORAGE_KEY, height.toString());
        } catch (err) {
            console.warn('[Extension Resize] Failed to save height:', err);
        }
    }

    // Set the content height
    function setContentHeight(height) {
        if (extensionContent) {
            extensionContent.style.maxHeight = `${height}px`;
        }
    }

    // Start resize (mouse)
    function startResize(e) {
        e.preventDefault();
        isResizing = true;
        startY = e.clientY;
        startHeight = extensionContent.offsetHeight;

        // Add resizing class for visual feedback
        if (extensionContainer) {
            extensionContainer.classList.add('resizing');
        }

        // Change cursor for entire document
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
    }

    // Start resize (touch)
    function startResizeTouch(e) {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        isResizing = true;
        startY = e.touches[0].clientY;
        startHeight = extensionContent.offsetHeight;

        if (extensionContainer) {
            extensionContainer.classList.add('resizing');
        }
    }

    // Do resize (mouse)
    function doResize(e) {
        if (!isResizing) return;
        e.preventDefault();

        const deltaY = e.clientY - startY;
        const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + deltaY));

        setContentHeight(newHeight);
    }

    // Do resize (touch)
    function doResizeTouch(e) {
        if (!isResizing || e.touches.length !== 1) return;
        e.preventDefault();

        const deltaY = e.touches[0].clientY - startY;
        const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + deltaY));

        setContentHeight(newHeight);
    }

    // Stop resize
    function stopResize() {
        if (!isResizing) return;

        isResizing = false;

        // Remove resizing class
        if (extensionContainer) {
            extensionContainer.classList.remove('resizing');
        }

        // Restore cursor
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // Save the new height
        const currentHeight = extensionContent.offsetHeight;
        saveHeight(currentHeight);

        console.log(`[Extension Resize] Panel resized to ${currentHeight}px`);
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeResize);
    } else {
        initializeResize();
    }

    // Expose reset function globally for debugging/testing
    window.resetExtensionPanelHeight = function() {
        try {
            localStorage.removeItem(STORAGE_KEY);
            setContentHeight(400); // Reset to default
            console.log('[Extension Resize] Height reset to default (400px)');
        } catch (err) {
            console.error('[Extension Resize] Failed to reset height:', err);
        }
    };

})();
