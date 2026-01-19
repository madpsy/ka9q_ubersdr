/**
 * UberSDR Rotator UI Component
 * Adds a collapsible rotator panel to the main page (left side)
 * Requires: rotator-display.js library
 */

class RotatorUI {
    constructor() {
        this.isExpanded = false;
        this.rotatorDisplay = null;
        
        // Load saved state from localStorage
        const savedState = localStorage.getItem('ubersdr_rotator_expanded');
        this.isExpanded = savedState === 'true';
        
        this.createRotatorPanel();
        this.setupEventHandlers();
    }
    
    /**
     * Create the rotator panel HTML and inject into page
     */
    createRotatorPanel() {
        const rotatorHTML = `
            <div id="rotator-panel" class="rotator-panel ${this.isExpanded ? 'expanded' : 'collapsed'}">
                <!-- Rotator tab (always visible, on left edge) -->
                <div id="rotator-header" class="rotator-header" onclick="rotatorUI.togglePanel()">
                    <span>🛰️</span>
                    <span id="rotator-collapse-arrow" class="rotator-collapse-arrow" style="display:${this.isExpanded ? 'block' : 'none'};">←</span>
                </div>
                
                <!-- Rotator content (slides out from left) -->
                <div id="rotator-content" class="rotator-content" style="display:${this.isExpanded ? 'flex' : 'none'};">
                    <div id="rotator-display-container" class="rotator-display-container">
                        <!-- Rotator display will be injected here -->
                    </div>
                </div>
            </div>
        `;
        
        // Inject CSS
        this.injectCSS();
        
        // Inject HTML before time display (bottom left)
        const timeDisplay = document.getElementById('time-display');
        if (timeDisplay && timeDisplay.parentNode) {
            timeDisplay.insertAdjacentHTML('beforebegin', rotatorHTML);
        } else {
            // Fallback: append to body
            document.body.insertAdjacentHTML('beforeend', rotatorHTML);
        }
        
        // Initialize rotator display if expanded on load
        if (this.isExpanded) {
            this.initializeRotatorDisplay();
        }
    }
    
    /**
     * Inject CSS styles for rotator panel
     */
    injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            .rotator-panel {
                position: fixed;
                bottom: 50px;
                left: 0;
                z-index: 900;
                font-family: Arial, sans-serif;
                font-size: 13px;
                display: flex;
                flex-direction: row;
                align-items: flex-end;
                transition: all 0.3s ease;
            }
            
            .rotator-panel.collapsed {
                width: 40px;
            }
            
            .rotator-panel.expanded {
                width: min(540px, 100vw);
                max-width: 100vw;
            }
            
            .rotator-header {
                width: 40px;
                height: 100px;
                padding: 8px 0;
                background: rgba(50, 50, 50, 0.7);
                color: #fff;
                cursor: pointer;
                user-select: none;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                font-size: 20px;
                border: 1px solid rgba(100, 100, 100, 0.5);
                border-left: none;
                border-radius: 0 8px 8px 0;
                order: 1;
                flex-shrink: 0;
                position: relative;
                overflow: visible;
            }
            
            .rotator-header:hover {
                background: rgba(70, 70, 70, 0.6);
            }
            
            .rotator-collapse-arrow {
                position: absolute;
                bottom: 8px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 20px;
                color: #fff;
                font-weight: bold;
                z-index: 10;
                pointer-events: none;
            }
            
            .rotator-content {
                width: min(500px, calc(100vw - 40px));
                max-width: 100%;
                height: 500px;
                background: rgba(40, 40, 40, 0.7);
                border: 1px solid rgba(100, 100, 100, 0.6);
                border-left: none;
                border-radius: 0 8px 8px 0;
                order: 2;
                flex-shrink: 0;
                overflow: hidden;
            }
            
            .rotator-display-container {
                width: 100%;
                height: 100%;
                padding: 0;
                overflow: auto;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
            }
            
            /* Mobile responsive styles */
            @media (max-width: 768px) {
                .rotator-panel.expanded {
                    width: 100vw;
                    left: 0;
                }
                
                .rotator-content {
                    width: calc(100vw - 40px);
                    height: 400px;
                }
            }
            
            @media (max-width: 480px) {
                .rotator-content {
                    height: 350px;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    /**
     * Set up DOM event handlers
     */
    setupEventHandlers() {
        // Panel toggle is handled via onclick in HTML
    }
    
    /**
     * Toggle rotator panel expanded/collapsed
     */
    togglePanel() {
        this.isExpanded = !this.isExpanded;
        const panel = document.getElementById('rotator-panel');
        const content = document.getElementById('rotator-content');
        const arrow = document.getElementById('rotator-collapse-arrow');
        
        if (this.isExpanded) {
            panel.classList.remove('collapsed');
            panel.classList.add('expanded');
            content.style.display = 'flex';
            if (arrow) arrow.style.display = 'block';
            
            // Initialize rotator display if not already done
            if (!this.rotatorDisplay) {
                this.initializeRotatorDisplay();
            }
        } else {
            panel.classList.remove('expanded');
            panel.classList.add('collapsed');
            content.style.display = 'none';
            if (arrow) arrow.style.display = 'none';
        }
        
        // Save state to localStorage
        localStorage.setItem('ubersdr_rotator_expanded', this.isExpanded.toString());
    }
    
    /**
     * Initialize the rotator display component
     */
    initializeRotatorDisplay() {
        if (typeof RotatorDisplay === 'undefined') {
            console.error('[RotatorUI] RotatorDisplay class not found. Make sure rotator-display.js is loaded.');
            return;
        }
        
        // Create rotator display with map and compass, no controls
        this.rotatorDisplay = new RotatorDisplay({
            containerId: 'rotator-display-container',
            showMap: true,
            showCompass: true,
            showControls: false,
            showPassword: false,
            mapSize: 480,
            compassSize: 150,
            updateInterval: 1000
        });
    }
    
    /**
     * Destroy the rotator display
     */
    destroy() {
        if (this.rotatorDisplay) {
            this.rotatorDisplay.destroy();
            this.rotatorDisplay = null;
        }
    }
}

// Global instance (will be initialized when rotator is enabled)
let rotatorUI = null;

/**
 * Initialize rotator UI
 * Call this after checking if rotator is enabled
 */
function initializeRotatorUI() {
    if (!rotatorUI) {
        rotatorUI = new RotatorUI();
        // Expose globally for debugging and access
        window.rotatorUI = rotatorUI;
    }
}
