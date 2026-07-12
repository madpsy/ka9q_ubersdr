/**
 * pages-menu.js
 * Injects a two-level flyout "Pages" menu at the top-left of the document.
 *
 * Level 1: dropdown lists group names.
 * Level 2: hovering a group expands its pages to the right.
 * Descriptions are shown as native tooltips on each page link.
 *
 * All visual styling lives in the STYLES constant below — edit it freely
 * without touching index.html.
 */
(function () {
    'use strict';

    const PAGES_JSON  = '/frontend-pages.json';
    const POPUP_W     = 1200;
    const POPUP_H     = 800;

    /* =========================================================================
       STYLES — edit freely; no other file needs changing
       ========================================================================= */
    const STYLES = `
#pages-menu-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 99999;
    font-family: inherit;
    font-size: 13px;
}

#pages-menu-btn {
    display: block;
    padding: 5px 10px;
    background: rgba(52, 73, 94, 0.7);
    color: var(--text-light, #ecf0f1);
    border: none;
    border-radius: 0 0 4px 0;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.03em;
    white-space: nowrap;
    line-height: 1.4;
    transition: background 0.15s;
}

#pages-menu-btn:hover,
#pages-menu-btn.is-open {
    background: var(--accent, #667eea);
}

/* Level 1 — group list */
#pages-menu-dropdown {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 180px;
    background: var(--panel-dark, #2c3e50);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-top: none;
    border-bottom-right-radius: 8px;
    border-bottom-left-radius: 0;
    box-shadow: 4px 4px 16px rgba(0, 0, 0, 0.5);
    padding: 4px 0;
}

#pages-menu-dropdown.is-open {
    display: block;
}

/* Group row in level 1 */
.pages-menu-group-row {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 12px;
    color: var(--text-light, #ecf0f1);
    cursor: default;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 600;
    transition: background 0.1s;
    gap: 8px;
}

.pages-menu-group-row:hover {
    background: var(--panel-mid, #34495e);
}

.pages-menu-group-row:hover > .pages-menu-submenu {
    display: block;
}

.pages-menu-group-arrow {
    font-size: 10px;
    opacity: 0.6;
    flex-shrink: 0;
}

/* Level 2 — submenu */
.pages-menu-submenu {
    display: none;
    position: absolute;
    top: -4px;          /* align with parent row top (offset by dropdown padding) */
    left: 100%;
    min-width: 200px;
    background: var(--panel-dark, #2c3e50);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0 8px 8px 8px;
    box-shadow: 4px 4px 16px rgba(0, 0, 0, 0.5);
    padding: 4px 0;
}

.pages-menu-link {
    display: block;
    padding: 6px 14px;
    color: var(--text-light, #ecf0f1);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    font-weight: 400;
    transition: background 0.1s;
}

.pages-menu-link:hover {
    background: var(--panel-mid, #34495e);
}
`;
    /* ========================================================================= */

    function injectStyles() {
        const style = document.createElement('style');
        style.id          = 'pages-menu-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
    }

    function buildMenu(data) {
        const wrapper = document.createElement('div');
        wrapper.id = 'pages-menu-wrapper';

        // Level 1 toggle button
        const btn = document.createElement('button');
        btn.id          = 'pages-menu-btn';
        btn.textContent = 'Links ▾';
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', 'pages-menu-dropdown');

        // Level 1 dropdown (group list)
        const dropdown = document.createElement('div');
        dropdown.id = 'pages-menu-dropdown';
        dropdown.setAttribute('role', 'menu');

        // Helper: open a URL as a centred popup
        function openPopup(url) {
            const left = Math.round((screen.width  - POPUP_W) / 2);
            const top  = Math.round((screen.height - POPUP_H) / 2);
            window.open(
                url,
                '_blank',
                `width=${POPUP_W},height=${POPUP_H},left=${left},top=${top},` +
                'resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no'
            );
        }

        // Helper: build and append a group row with its submenu
        function addGroupRow(groupName, links) {
            // links: array of { url, label, tooltip }
            const row = document.createElement('div');
            row.className = 'pages-menu-group-row';
            row.setAttribute('role', 'menuitem');
            row.setAttribute('aria-haspopup', 'true');

            const label = document.createElement('span');
            label.textContent = groupName;

            const arrow = document.createElement('span');
            arrow.className   = 'pages-menu-group-arrow';
            arrow.textContent = '›';

            const submenu = document.createElement('div');
            submenu.className = 'pages-menu-submenu';
            submenu.setAttribute('role', 'menu');

            links.forEach(({ url, label: text, tooltip }) => {
                const link = document.createElement('a');
                link.className   = 'pages-menu-link';
                link.href        = url;
                if (tooltip) link.title = tooltip;
                link.setAttribute('role', 'menuitem');
                link.textContent = text;
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    openPopup(url);
                });
                submenu.appendChild(link);
            });

            row.appendChild(label);
            row.appendChild(arrow);
            row.appendChild(submenu);
            dropdown.appendChild(row);
        }

        // Static groups from frontend-pages.json
        (data.groups || []).forEach(group => {
            const links = (group.files || []).map(file => ({
                url:     '/' + file.path.replace(/^static\//, ''),
                label:   file.name,
                tooltip: file.description || '',
            }));
            addGroupRow(group.group, links);
        });

        // Dynamic Add-ons group from window.apiDescription
        const apiDesc = window.apiDescription;
        if (apiDesc && Array.isArray(apiDesc.addons) && apiDesc.addons.length > 0) {
            const addonLinks = apiDesc.addons.map(name => ({
                url:   `/addon/${name}/`,
                label: name.toUpperCase(),
            }));
            addGroupRow('Add-ons', addonLinks);
        }

        // Toggle open/close
        function openMenu() {
            dropdown.classList.add('is-open');
            btn.classList.add('is-open');
            btn.setAttribute('aria-expanded', 'true');
            btn.textContent = 'Links ▴';
        }

        function closeMenu() {
            dropdown.classList.remove('is-open');
            btn.classList.remove('is-open');
            btn.setAttribute('aria-expanded', 'false');
            btn.textContent = 'Links ▾';
        }

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.contains('is-open') ? closeMenu() : openMenu();
        });

        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) closeMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMenu();
        });

        wrapper.appendChild(btn);
        wrapper.appendChild(dropdown);
        document.body.appendChild(wrapper);
    }

    async function init() {
        // Don't show on mobile — window._isMobile is set by app.js
        if (window._isMobile) return;

        injectStyles();

        // Ensure window.apiDescription is populated before building the menu
        // so the Add-ons group can be injected without a separate fetch.
        if (!window.apiDescription && window.descriptionPromise) {
            try { await window.descriptionPromise; } catch (_) {}
        }

        fetch(PAGES_JSON)
            .then(r => {
                if (!r.ok) throw new Error('Failed to load ' + PAGES_JSON);
                return r.json();
            })
            .then(buildMenu)
            .catch(err => console.warn('[pages-menu]', err));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
