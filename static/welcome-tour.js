/**
 * UberSDR Welcome Tour & Announcements System
 * ============================================
 *
 * Two classes of help content:
 *
 * 1. TOUR STEPS  — A guided walkthrough that points to specific UI elements
 *    using a spotlight overlay and positioned tooltip cards. Shown once to
 *    new visitors. Users can dismiss at any step or complete the full tour.
 *    State stored in localStorage under key: 'ubersdr_tour_completed'
 *
 * 2. ANNOUNCEMENTS — Standalone notification cards (new features, notices).
 *    Each announcement has a unique `id`. Dismissed announcements are stored
 *    in localStorage under key: 'ubersdr_dismissed_announcements' (JSON array
 *    of ids). Adding a new announcement with a new id will always show it,
 *    even if the user has dismissed all previous ones.
 *
 * Platform targeting
 * ------------------
 * Both tour steps and announcements support an optional `platform` field:
 *   'both'    — shown on all devices (default when omitted)
 *   'desktop' — only shown when window.innerWidth >= 768px
 *   'mobile'  — only shown when window.innerWidth < 768px
 *
 * Usage:
 *   WelcomeTour.init();              // call after DOM ready — shows tour or announcements
 *   WelcomeTour.startTour();         // manually re-launch the tour
 *   WelcomeTour.showAnnouncements(); // manually show pending announcements
 *   WelcomeTour.resetAll();          // clear all localStorage state (dev/debug)
 *
 * Adding new announcements:
 *   Push to WelcomeTour.ANNOUNCEMENTS before calling init(), or add directly
 *   to the ANNOUNCEMENTS array below. Give each a unique `id`.
 */

(function (global) {
    'use strict';

    // =========================================================================
    // PLATFORM DETECTION
    // =========================================================================
    const MOBILE_BREAKPOINT = 768; // px — matches the CSS mobile breakpoint

    function isMobile() {
        return window.innerWidth < MOBILE_BREAKPOINT;
    }

    /**
     * Returns true if the item's platform field matches the current device.
     * @param {string|undefined} platform — 'both' | 'desktop' | 'mobile' | undefined
     */
    function matchesPlatform(platform) {
        if (!platform || platform === 'both') return true;
        if (platform === 'mobile')  return isMobile();
        if (platform === 'desktop') return !isMobile();
        return true; // unknown value — show everywhere
    }

    // =========================================================================
    // TOUR STEPS DEFINITION
    // Each step: { target, title, body, position, platform }
    //   target   — CSS selector for the element to spotlight (null = centred modal)
    //   title    — heading text
    //   body     — HTML string for the description
    //   position — preferred tooltip placement: 'top'|'bottom'|'left'|'right'|'center'
    //   platform — 'both' (default) | 'desktop' | 'mobile'
    // =========================================================================
    const TOUR_STEPS = [
        {
            target: null,
            title: '👋 Welcome to UberSDR',
            body: `<p>UberSDR is a powerful web-based Software Defined Radio receiver giving you
                   real-time access to the HF spectrum from your browser.</p>
                   <p>This short tour will walk you through the key parts of the interface.
                   You can skip it at any time.</p>`,
            position: 'center',
            platform: 'both'
        },
        {
            target: '.spectrum-display-controls',
            title: '🎛️ Waterfall Controls',
            body: `<p>These controls let you customise the waterfall display:</p>
                   <ul>
                     <li><strong>Zoom</strong> — Min/−/+/Max buttons or scroll wheel</li>
                     <li><strong>Colour scheme</strong> — choose from Turbo, Jet, Viridis and more</li>
                     <li><strong>Contrast</strong> — auto-range slider adjusts the dB window</li>
                     <li><strong>GPU</strong> — enables smoother 60fps scrolling via CSS compositing</li>
                   </ul>`,
            position: 'bottom',
            platform: 'desktop'
        },
        {
            target: '.spectrum-display-controls',
            title: '🎛️ Waterfall Controls',
            body: `<p>Tap the waterfall controls bar to customise the display:</p>
                   <ul>
                     <li><strong>Zoom</strong> — Min/−/+/Max buttons</li>
                     <li><strong>Colour scheme</strong> — choose from Turbo, Jet, Viridis and more</li>
                     <li><strong>Pause</strong> — saves battery on mobile</li>
                   </ul>`,
            position: 'bottom',
            platform: 'mobile'
        },
        {
            target: '#waterfall-resize-handle',
            title: '↕️ Resize the Waterfall',
            body: `<p>This drag handle lets you resize the waterfall height to suit your screen.</p>
                   <ul>
                     <li><strong>Drag up/down</strong> to make the waterfall taller or shorter</li>
                     <li><strong>Double-click</strong> to reset to the default height</li>
                   </ul>`,
            position: 'top',
            platform: 'desktop'
        },
        {
            target: '#waterfall-pause-btn',
            title: '⏸ Pause / Resume Waterfall',
            body: `<p>This button pauses and resumes the waterfall display.</p>
                   <ul>
                     <li><strong>Pause</strong> — freezes the waterfall; the receiver keeps running and audio continues</li>
                     <li><strong>Resume</strong> — restarts the live display from the current moment</li>
                   </ul>
                   <p>Useful for studying a signal without the display scrolling away, or for saving bandwidth.</p>`,
            position: 'left',
            mobilePosition: 'center',
            platform: 'both'
        },
        {
            target: '.band-status-bar',
            title: '📻 Band Status Bar',
            body: `<p>The coloured band badges show propagation conditions for each amateur band.
                   Click any badge to jump straight to that band.</p>
                   <p>The <strong>voice activity</strong> button (🔊) shows live voice signals
                   on the current band.</p>`,
            position: 'bottom',
            platform: 'both'
        },
        {
            target: '.mobile-tab-bar',
            title: '🗂️ Control Panels',
            body: `<p>These toggle buttons expand extra controls below them:</p>
                   <ul>
                     <li><strong>🎛 Tune</strong> — mode selection, bandwidth and squelch</li>
                     <li><strong>📡 Bookmarks</strong> — server bookmarks, personal bookmarks and search</li>
                   </ul>
                   <p>Tap to expand, tap again to collapse and maximise the waterfall.</p>`,
            position: 'top',
            platform: 'mobile',
            condition: () => !!document.getElementById('mobile-tab-bar')
        },
        {
            target: '.mobile-mode-toggles',
            title: '📻 Mode Selection',
            body: `<p>Tap either side of each button to select a mode:</p>
                   <ul>
                     <li><strong>LSB / USB</strong> — lower / upper sideband</li>
                     <li><strong>CWL / CWU</strong> — CW lower / upper</li>
                     <li><strong>AM / SAM</strong> — AM / synchronous AM</li>
                     <li><strong>FM / NFM</strong> — FM / narrow FM</li>
                   </ul>
                   <p>The active mode is highlighted in dark green.</p>`,
            position: 'top',
            platform: 'mobile',
            condition: () => !!document.getElementById('mobile-mode-toggles')
        },
        {
            target: '.bandwidth-controls',
            title: '↔️ Bandwidth',
            body: `<p>The <strong>BW slider</strong> sets the receive bandwidth. Narrower bandwidth
                   reduces noise; wider bandwidth captures more audio.</p>
                   <p>Click the <strong>◄►</strong> pill to switch between the combined slider
                   and separate low/high cut controls.</p>`,
            position: 'right',
            platform: 'desktop'
        },
        {
            target: '.s-meter-container',
            title: '📊 S-Meter',
            body: `<p>The analogue S-meter shows received signal strength. Below it you'll see
                   <strong>Instant</strong>, <strong>Hold</strong> (peak), and <strong>SNR</strong>
                   (signal-to-noise ratio) readouts.</p>
                   <p>Click the ◀ button to reveal mini history graphs for power and SNR.</p>`,
            position: 'left',
            platform: 'desktop'
        },
        {
            target: '#dock-controls-button',
            title: '⊞ Dock / Undock Controls',
            body: `<p>This button toggles the receiver controls between two layouts:</p>
                   <ul>
                     <li><strong>Docked</strong> — controls float as a compact overlay above the waterfall, maximising screen space</li>
                     <li><strong>Undocked</strong> — controls sit in the normal page flow below the waterfall</li>
                   </ul>
                   <p>Useful when you want more waterfall visible at once.</p>`,
            position: 'left',
            platform: 'desktop'
        },
        {
            target: '.audio-controls',
            title: '🔊 Audio Controls',
            body: `<p>Control your listening experience here:</p>
                   <ul>
                     <li><strong>Volume</strong> — master output level</li>
                     <li><strong>Squelch</strong> — mutes audio below a set SNR threshold</li>
                     <li><strong>NR</strong> — noise reduction (NR2 spectral / NR entropy)</li>
                     <li><strong>NB</strong> — noise blanker for impulse noise</li>
                     <li><strong>EQ</strong> — 12-band equaliser with voice/CW/music presets</li>
                     <li><strong>Rec</strong> — record audio to WebM or WAV</li>
                   </ul>`,
            position: 'top',
            platform: 'desktop'
        },
        {
            target: '#nr2-quick-toggle',
            title: '🔇 Noise Reduction (NR)',
            body: `<p>The <strong>NR</strong> button cycles through noise reduction modes:</p>
                   <ul>
                     <li><strong>Off</strong> — no processing</li>
                     <li><strong>NR2</strong> — spectral subtraction, learns noise on startup</li>
                     <li><strong>NR</strong> — entropy VAD soft-masking engine</li>
                   </ul>
                   <p>Press <kbd>N</kbd> to cycle, or right-click to turn off instantly.
                   Fine-tune settings in the <strong>Audio Filters</strong> section below.</p>`,
            position: 'top',
            platform: 'both'
        },
        {
            target: '#eq-quick-toggle',
            title: '🎚️ Equaliser (EQ)',
            body: `<p>The <strong>EQ</strong> button toggles the 12-band equaliser. Built-in presets:</p>
                   <ul>
                     <li><strong>Voice</strong> — optimised for SSB voice communications</li>
                     <li><strong>CW</strong> — optimised for Morse code reception</li>
                     <li><strong>Music</strong> — wideband audio / broadcast</li>
                   </ul>
                   <p>Press <kbd>V</kbd> to cycle presets, or right-click to turn off instantly.
                   Full band controls are in the <strong>Audio Filters</strong> section below.</p>`,
            position: 'top',
            platform: 'both'
        },
        {
            target: '#spectrum-label-autopause',
            title: '⏸ Auto-Pause Waterfall',
            body: `<p>The <strong>Pause</strong> checkbox enables automatic waterfall pausing
                   after 5 minutes of inactivity.</p>
                   <p>When paused, the waterfall stops updating — saving battery and data on
                   mobile. Tap anywhere on the waterfall to resume.</p>`,
            position: 'center',
            platform: 'mobile',
            // Only shown when the auto-pause label is visible (mobile CSS makes it flex)
            condition: () => {
                const el = document.getElementById('spectrum-label-autopause');
                if (!el) return false;
                const style = window.getComputedStyle(el);
                return style.display !== 'none';
            }
        },
        {
            target: '#audio-buffer-display',
            title: '🔊 Audio Settings',
            body: `<p>This indicator in the bottom-right shows the <strong>audio buffer level</strong>.
                   Click it to open the <strong>Audio Settings</strong> modal where you can:</p>
                   <ul>
                     <li><strong>Buffer size</strong> — set the maximum audio buffer (50–500ms); lower = less latency, higher = smoother playback on slow connections</li>
                     <li><strong>Output device</strong> — choose which speaker or headphone output to use</li>
                     <li><strong>Media Session</strong> — enable lock-screen playback controls</li>
                     <li><strong>SNR history</strong> — view a live signal quality chart</li>
                   </ul>`,
            position: 'left',
            platform: 'both'
        },
        {
            target: '#chat-header',
            title: '💬 Live Chat',
            body: `<p>This instance has <strong>live chat</strong> enabled. Click the tab on the
                   right edge of the screen to open the chat panel.</p>
                   <ul>
                     <li>Choose a username and click <strong>Join</strong> to start chatting</li>
                     <li>Share your current frequency with the 📻 button</li>
                     <li>Click another user's callsign to <strong>sync</strong> to their frequency</li>
                   </ul>`,
            position: 'left',
            platform: 'both',
            // Only shown when the chat panel has been injected into the DOM (chat_enabled = true)
            condition: () => !!document.getElementById('chat-header')
        },
        {
            target: '#extensions-dropdown',
            title: '🧩 Extensions',
            body: `<p>Extensions add extra functionality to the receiver:</p>
                   <ul>
                     <li><strong>FT8 / FT4 / WSPR</strong> — digital mode spot feeds</li>
                     <li><strong>CW Spots</strong> — live Morse code skimmer spots</li>
                     <li><strong>DX Cluster</strong> — DX cluster spot feed</li>
                   </ul>
                   <p>Select an extension from the dropdown to open its panel.</p>`,
            position: 'right',
            platform: 'desktop'
        },
        {
            target: '#addons-dropdown',
            title: '🔌 Addons',
            body: `<p>This instance has <strong>addons</strong> installed — extra tools and pages
                   provided by the station operator.</p>
                   <p>Select an addon from this dropdown to open it in a new tab or panel.</p>`,
            position: 'right',
            platform: 'desktop',
            // Only include this step when the addons dropdown is actually visible
            condition: () => {
                const el = document.getElementById('addons-dropdown');
                return !!(el && el.offsetParent !== null && el.style.display !== 'none');
            }
        },
        {
            target: null,
            title: '🎉 You\'re all set!',
            body: `<p>That covers the main controls. A few more tips:</p>
                   <ul>
                     <li>The <strong>Audio Filters</strong> section has notch, bandpass,
                         compressor and stereo virtualiser</li>
                     <li>The <strong>Audio Visualisation</strong> section has an oscilloscope
                         and audio waterfall</li>
                     <li>You can re-launch this tour any time from the help menu</li>
                   </ul>
                   <p>Enjoy the bands! 73 de UberSDR 📻</p>`,
            position: 'center',
            platform: 'desktop'
        },
        {
            target: '#tuning-mode-toggle',
            title: '🎛️ Tuning Mode',
            body: `<p>Switch between two tuning styles:</p>
                   <ul>
                     <li><strong>Btns</strong> — tap step buttons (±1 Hz, ±10 Hz, etc.) to nudge the frequency</li>
                     <li><strong>Wheel</strong> — drag the rotary tuning wheel for smooth continuous tuning</li>
                   </ul>
                   <p>Pick whichever feels more natural for your style of operating.</p>`,
            position: 'top',
            platform: 'mobile',
            condition: () => {
                const el = document.getElementById('tuning-mode-toggle');
                return !!el;
            }
        },
        {
            target: '#spectrum-vzoom-slider',
            title: '🔍 Vertical Zoom',
            body: `<p>The <strong>vertical zoom slider</strong> on the right edge of the waterfall adjusts how much of the signal amplitude range is shown.</p>
                   <p>Drag it up to zoom in on weak signals, or down to see the full dynamic range.</p>`,
            position: 'left',
            platform: 'mobile'
        }
    ];

    // =========================================================================
    // ANNOUNCEMENTS DEFINITION
    // Each announcement: { id, title, body, type, date, platform }
    //   id       — unique string; changing this makes the announcement show again
    //   title    — heading text
    //   body     — HTML string
    //   type     — 'info' | 'success' | 'warning' | 'new-feature'
    //   date     — ISO date string (display only)
    //   platform — 'both' (default) | 'desktop' | 'mobile'
    // =========================================================================
    const ANNOUNCEMENTS = [
        // -----------------------------------------------------------------------
        // Add new announcements here. Give each a unique `id`.
        // The `platform` field controls which devices see the announcement:
        //   'both'    — all devices (default)
        //   'desktop' — only desktop/tablet (>= 768px)
        //   'mobile'  — only phones (< 768px)
        //
        // Example — desktop-only new feature notice:
        // {
        //     id: 'feature-gpu-waterfall-2025-06',
        //     title: '🚀 New: GPU-accelerated Waterfall',
        //     body: `<p>The waterfall now supports GPU sub-pixel scrolling for smoother 60fps
        //            motion. Enable it with the <strong>GPU</strong> checkbox in the waterfall
        //            controls bar.</p>`,
        //     type: 'new-feature',
        //     date: '2025-06-01',
        //     platform: 'desktop'
        // },
        //
        // Example — mobile-only tip:
        // {
        //     id: 'tip-tuning-wheel-2025-06',
        //     title: '💡 Tip: Tuning Wheel',
        //     body: `<p>On mobile, switch to the <strong>Wheel</strong> tuning mode for
        //            smoother frequency control by dragging.</p>`,
        //     type: 'info',
        //     date: '2025-06-01',
        //     platform: 'mobile'
        // }
        // -----------------------------------------------------------------------
    ];

    // =========================================================================
    // STORAGE KEYS
    // =========================================================================
    const STORAGE_KEY_TOUR      = 'ubersdr_tour_completed';
    const STORAGE_KEY_DISMISSED = 'ubersdr_dismissed_announcements';

    // =========================================================================
    // STATE
    // =========================================================================
    let currentStep       = 0;
    let activeSteps       = [];   // TOUR_STEPS filtered for current platform
    let tourActive        = false;
    let overlay           = null;
    let spotlight         = null;
    let tooltipCard       = null;
    let announcementPanel = null;
    let resizeTimer       = null;

    // =========================================================================
    // LOCAL STORAGE HELPERS
    // =========================================================================
    function isTourCompleted() {
        return localStorage.getItem(STORAGE_KEY_TOUR) === 'true';
    }

    function markTourCompleted() {
        localStorage.setItem(STORAGE_KEY_TOUR, 'true');
    }

    function getDismissedAnnouncements() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY_DISMISSED) || '[]');
        } catch {
            return [];
        }
    }

    function dismissAnnouncement(id) {
        const dismissed = getDismissedAnnouncements();
        if (!dismissed.includes(id)) {
            dismissed.push(id);
            localStorage.setItem(STORAGE_KEY_DISMISSED, JSON.stringify(dismissed));
        }
    }

    function getPendingAnnouncements() {
        const dismissed = getDismissedAnnouncements();
        return ANNOUNCEMENTS.filter(a =>
            !dismissed.includes(a.id) && matchesPlatform(a.platform)
        );
    }

    // =========================================================================
    // DOM HELPERS
    // =========================================================================
    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html) e.innerHTML = html;
        return e;
    }

    function getTargetRect(selector) {
        if (!selector) return null;
        const target = document.querySelector(selector);
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return { top: r.top, left: r.left, width: r.width, height: r.height };
    }

    // =========================================================================
    // TOUR OVERLAY — dark backdrop with a cut-out spotlight
    // =========================================================================
    function createOverlay() {
        if (overlay) return;

        overlay = el('div', 'wt-overlay');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Welcome Tour');

        spotlight = el('div', 'wt-spotlight');
        overlay.appendChild(spotlight);

        document.body.appendChild(overlay);

        // Clicking outside the tooltip (on the overlay) advances to next step
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) advanceTour();
        });
    }

    function removeOverlay() {
        if (overlay) {
            overlay.remove();
            overlay    = null;
            spotlight  = null;
        }
        if (tooltipCard) {
            tooltipCard.remove();
            tooltipCard = null;
        }
    }

    function positionSpotlight(rect) {
        if (!spotlight) return;
        const pad = 10;
        if (!rect) {
            spotlight.style.cssText = 'display:none;';
            return;
        }
        spotlight.style.cssText = `
            display: block;
            top:    ${rect.top    - pad}px;
            left:   ${rect.left   - pad}px;
            width:  ${rect.width  + pad * 2}px;
            height: ${rect.height + pad * 2}px;
        `;
    }

    // =========================================================================
    // TOOLTIP CARD
    // =========================================================================
    function createTooltipCard(step, stepIndex, totalSteps) {
        if (tooltipCard) tooltipCard.remove();

        const card = el('div', 'wt-card');
        card.setAttribute('role', 'document');

        // Progress dots
        const dots = el('div', 'wt-dots');
        for (let i = 0; i < totalSteps; i++) {
            const dot = el('span', 'wt-dot' + (i === stepIndex ? ' wt-dot-active' : ''));
            dots.appendChild(dot);
        }

        // Header — title + × close button
        const header   = el('div', 'wt-card-header');
        const title    = el('h3',  'wt-card-title', step.title);
        const closeBtn = el('button', 'wt-btn-close', '×');
        closeBtn.setAttribute('title', 'Close tour');
        closeBtn.setAttribute('aria-label', 'Close tour');
        closeBtn.addEventListener('click', endTour);
        header.appendChild(title);
        header.appendChild(closeBtn);

        // Body
        const body = el('div', 'wt-card-body', step.body);

        // Footer
        const footer   = el('div', 'wt-card-footer');
        const counter  = el('span', 'wt-counter', `${stepIndex + 1} / ${totalSteps}`);
        const btnGroup = el('div', 'wt-btn-group');

        // Always show a "Skip Tour" dismiss option in the button row
        const skipBtn = el('button', 'wt-btn wt-btn-skip-footer', 'Skip Tour');
        skipBtn.setAttribute('title', 'Dismiss tour and don\'t show again');
        skipBtn.addEventListener('click', endTour);
        btnGroup.appendChild(skipBtn);

        if (stepIndex > 0) {
            const prevBtn = el('button', 'wt-btn wt-btn-secondary', '← Back');
            prevBtn.addEventListener('click', () => goToStep(stepIndex - 1));
            btnGroup.appendChild(prevBtn);
        }

        const isLast  = stepIndex === totalSteps - 1;
        const nextBtn = el('button', 'wt-btn wt-btn-primary', isLast ? 'Finish ✓' : 'Next →');
        nextBtn.addEventListener('click', advanceTour);
        btnGroup.appendChild(nextBtn);

        footer.appendChild(counter);
        footer.appendChild(btnGroup);

        card.appendChild(dots);
        card.appendChild(header);
        card.appendChild(body);
        card.appendChild(footer);

        document.body.appendChild(card);
        tooltipCard = card;

        return card;
    }

    function positionTooltipCard(card, rect, position) {
        const margin   = 14;
        const vw       = window.innerWidth;
        const vh       = window.innerHeight;
        const isMobile = vw <= 768;

        card.style.cssText = '';

        if (!rect || position === 'center') {
            card.classList.add('wt-card-center');
            card.style.top       = '50%';
            card.style.left      = '50%';
            card.style.transform = 'translate(-50%, -50%)';
            return;
        }

        card.classList.remove('wt-card-center');

        // On mobile, cap card width so it doesn't span the full screen and
        // cover narrow elements (e.g. the vzoom slider on the right edge).
        if (isMobile) {
            card.style.maxWidth = Math.min(vw - margin * 2, 300) + 'px';
        }

        const cw = card.offsetWidth  || (isMobile ? 280 : 340);
        const ch = card.offsetHeight || 240;

        // Helper: compute top/left for a given side
        function calcPos(side) {
            switch (side) {
                case 'bottom': return { top: rect.top + rect.height + margin,
                                        left: rect.left + rect.width / 2 - cw / 2 };
                case 'top':    return { top: rect.top - ch - margin,
                                        left: rect.left + rect.width / 2 - cw / 2 };
                case 'right':  return { top: rect.top + rect.height / 2 - ch / 2,
                                        left: rect.left + rect.width + margin };
                case 'left':   return { top: rect.top + rect.height / 2 - ch / 2,
                                        left: rect.left - cw - margin };
                default:       return { top: rect.top + rect.height + margin,
                                        left: rect.left + rect.width / 2 - cw / 2 };
            }
        }

        // On mobile, auto-flip the preferred side if it would go off-screen or
        // overlap the spotlight rect.  Try the requested side first, then
        // fall back through alternatives in priority order.
        let resolvedSide = position;
        if (isMobile) {
            const fallbackOrder = {
                'bottom': ['bottom', 'top', 'right', 'left'],
                'top':    ['top', 'bottom', 'right', 'left'],
                'right':  ['right', 'left', 'bottom', 'top'],
                'left':   ['left', 'right', 'bottom', 'top']
            };
            const order = fallbackOrder[position] || ['bottom', 'top', 'right', 'left'];
            for (const side of order) {
                const p = calcPos(side);
                const fitsH = p.left >= margin && p.left + cw <= vw - margin;
                const fitsV = p.top  >= margin && p.top  + ch <= vh - margin;
                // Also check the card doesn't overlap the spotlight rect
                const overlapsSpot = !(
                    p.left + cw < rect.left - margin ||
                    p.left      > rect.left + rect.width  + margin ||
                    p.top  + ch < rect.top  - margin ||
                    p.top       > rect.top  + rect.height + margin
                );
                if (fitsH && fitsV && !overlapsSpot) {
                    resolvedSide = side;
                    break;
                }
                // Accept a side that fits spatially even if it slightly overlaps
                if (fitsH && fitsV) {
                    resolvedSide = side;
                    break;
                }
            }
        }

        let { top, left } = calcPos(resolvedSide);

        // Clamp to viewport
        left = Math.max(margin, Math.min(left, vw - cw - margin));
        top  = Math.max(margin, Math.min(top,  vh - ch - margin));

        card.style.position  = 'fixed';
        card.style.top       = top  + 'px';
        card.style.left      = left + 'px';
        card.style.transform = 'none';
    }

    // =========================================================================
    // TOUR FLOW
    // =========================================================================
    function goToStep(index) {
        if (!tourActive) return;
        currentStep = index;
        const step  = activeSteps[index];
        const rect  = getTargetRect(step.target);

        positionSpotlight(rect);

        // Scroll target into view if needed
        if (step.target) {
            const targetEl = document.querySelector(step.target);
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        const card = createTooltipCard(step, index, activeSteps.length);

        // Allow layout to settle before positioning
        requestAnimationFrame(() => {
            const isMobile = window.innerWidth <= 768;
            const pos = (isMobile && step.mobilePosition) ? step.mobilePosition : step.position;
            positionTooltipCard(card, rect, pos);
        });
    }

    function advanceTour() {
        if (currentStep < activeSteps.length - 1) {
            goToStep(currentStep + 1);
        } else {
            endTour(true);
        }
    }

    function endTour(completed) {
        tourActive = false;
        markTourCompleted();
        removeOverlay();
        window.removeEventListener('resize', onWindowResize);

        // After tour ends, show any pending announcements
        const pending = getPendingAnnouncements();
        if (pending.length > 0) {
            setTimeout(showAnnouncements, 400);
        }
    }

    function startTour() {
        if (tourActive) return;

        // Filter steps for the current platform and any runtime condition
        activeSteps = TOUR_STEPS.filter(s =>
            matchesPlatform(s.platform) &&
            (typeof s.condition !== 'function' || s.condition())
        );
        if (activeSteps.length === 0) {
            markTourCompleted();
            return;
        }

        tourActive  = true;
        currentStep = 0;

        createOverlay();
        goToStep(0);

        window.addEventListener('resize', onWindowResize);
    }

    function onWindowResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (tourActive) goToStep(currentStep);
        }, 150);
    }

    // =========================================================================
    // ANNOUNCEMENTS PANEL
    // =========================================================================
    function buildAnnouncementCard(announcement) {
        const card = el('div', `wt-announcement wt-announcement-${announcement.type}`);

        const iconMap = {
            'info':        'ℹ️',
            'success':     '✅',
            'warning':     '⚠️',
            'new-feature': '🚀'
        };
        const icon = iconMap[announcement.type] || 'ℹ️';

        const header   = el('div', 'wt-ann-header');
        const titleEl  = el('div', 'wt-ann-title', `${icon} ${announcement.title}`);
        const dateEl   = el('div', 'wt-ann-date',  announcement.date || '');
        const closeBtn = el('button', 'wt-ann-close', '×');
        closeBtn.setAttribute('title', 'Dismiss');
        closeBtn.setAttribute('aria-label', 'Dismiss announcement');
        closeBtn.addEventListener('click', () => {
            dismissAnnouncement(announcement.id);
            card.classList.add('wt-ann-dismissed');
            setTimeout(() => {
                card.remove();
                if (announcementPanel &&
                    announcementPanel.querySelectorAll('.wt-announcement:not(.wt-ann-dismissed)').length === 0) {
                    removeAnnouncementPanel();
                }
            }, 300);
        });

        header.appendChild(titleEl);
        header.appendChild(dateEl);
        header.appendChild(closeBtn);

        const body = el('div', 'wt-ann-body', announcement.body);

        // If tour not yet completed, offer to start it
        if (!isTourCompleted() && announcement.type === 'info') {
            const tourBtn = el('button', 'wt-btn wt-btn-primary wt-ann-tour-btn', '🗺️ Take the Tour');
            tourBtn.addEventListener('click', () => {
                removeAnnouncementPanel();
                startTour();
            });
            body.appendChild(tourBtn);
        }

        card.appendChild(header);
        card.appendChild(body);
        return card;
    }

    function removeAnnouncementPanel() {
        if (announcementPanel) {
            announcementPanel.classList.add('wt-panel-hide');
            setTimeout(() => {
                if (announcementPanel) {
                    announcementPanel.remove();
                    announcementPanel = null;
                }
            }, 350);
        }
    }

    function showAnnouncements() {
        const pending = getPendingAnnouncements(); // already platform-filtered
        if (pending.length === 0) return;

        if (announcementPanel) announcementPanel.remove();

        const panel = el('div', 'wt-announcement-panel');
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Announcements');

        const panelHeader = el('div', 'wt-ann-panel-header');
        const panelTitle  = el('span', 'wt-ann-panel-title', '📢 Announcements');
        const dismissAll  = el('button', 'wt-ann-dismiss-all', 'Dismiss All');
        dismissAll.addEventListener('click', () => {
            pending.forEach(a => dismissAnnouncement(a.id));
            removeAnnouncementPanel();
        });
        panelHeader.appendChild(panelTitle);
        panelHeader.appendChild(dismissAll);
        panel.appendChild(panelHeader);

        pending.forEach(a => panel.appendChild(buildAnnouncementCard(a)));

        document.body.appendChild(panel);
        announcementPanel = panel;

        // Animate in
        requestAnimationFrame(() => panel.classList.add('wt-panel-show'));
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _waitForOverlayDismiss);
        } else {
            _waitForOverlayDismiss();
        }
    }

    /**
     * Waits for the audio-start-overlay to be dismissed (hidden class added by app.js)
     * before showing the tour or announcements. Uses a MutationObserver so we don't
     * need to modify app.js at all.
     */
    function _waitForOverlayDismiss() {
        const overlay = document.getElementById('audio-start-overlay');

        // If the overlay doesn't exist or is already hidden, run immediately
        if (!overlay || overlay.classList.contains('hidden')) {
            setTimeout(_doInit, 400);
            return;
        }

        // Watch for the 'hidden' class being added to the overlay
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' &&
                    mutation.attributeName === 'class' &&
                    overlay.classList.contains('hidden')) {
                    observer.disconnect();
                    // Small delay so the UI finishes its reveal animation
                    setTimeout(_doInit, 600);
                    return;
                }
            }
        });

        observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    function _doInit() {
        const pending = getPendingAnnouncements();

        if (!isTourCompleted()) {
            // New user — show tour first, then announcements after
            startTour();
        } else if (pending.length > 0) {
            // Returning user with new announcements
            showAnnouncements();
        }
    }

    function resetAll() {
        localStorage.removeItem(STORAGE_KEY_TOUR);
        localStorage.removeItem(STORAGE_KEY_DISMISSED);
        console.log('[WelcomeTour] All tour/announcement state cleared.');
    }

    // Expose public API
    global.WelcomeTour = {
        init,
        startTour,
        showAnnouncements,
        resetAll,
        // Expose data arrays so operators can push to them before calling init()
        TOUR_STEPS,
        ANNOUNCEMENTS
    };

})(window);
