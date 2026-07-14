/*
 * config-help.js
 *
 * Adds contextual "?" help buttons and a keyword search box to the
 * Admin → Config visual editor.
 *
 * The help text is sourced from the canonical example configuration file on
 * GitHub (config/config.yaml.example), which contains rich inline and block
 * comments for (almost) every option. We fetch it once, parse the comments
 * into a map keyed by dotted YAML path (e.g. "server.max_sessions",
 * "admin.gps.lat"), and expose:
 *
 *   ConfigHelp.load()                  -> Promise, fetch + parse (cached, idempotent)
 *   ConfigHelp.get(path)               -> help string or undefined
 *   ConfigHelp.attach(el, path)        -> append a "?" button to el IF help exists
 *   ConfigHelp.renderSearchBox(parent) -> inject search UI into parent element
 *
 * The "no comment => no ? button" rule is enforced by attach(): if get(path)
 * returns nothing, no button is created.
 *
 * The search box is only rendered when help text was successfully loaded
 * (ConfigHelp.isReady() && Object.keys(helpMap).length > 0). Clicking a
 * search result expands the relevant config section and scrolls to + briefly
 * highlights the matching field.
 *
 * raw.githubusercontent.com serves "Access-Control-Allow-Origin: *", so the
 * cross-origin fetch works directly from the browser with no proxy. If the
 * fetch fails (offline, rate-limited, etc.) the help map is simply empty and
 * no buttons are shown — the editor degrades gracefully.
 */
(function () {
    'use strict';

    const RAW_URL =
        'https://raw.githubusercontent.com/madpsy/ka9q_ubersdr/refs/heads/main/config/config.yaml.example';

    // Dotted-path -> help text
    let helpMap = null;
    // In-flight / completed load promise (so load() is idempotent)
    let loadPromise = null;

    /**
     * Parse a YAML document's comments into a map of dotted-path -> help text.
     *
     * Association rules:
     *   - A run of consecutive full-line "# ..." comments is buffered and
     *     attached to the NEXT "key:" line encountered at the same or deeper
     *     indentation.
     *   - An inline trailing comment (e.g. "lat: 51.507  # Latitude") is
     *     attached to that key, appended after any block comment.
     *   - Indentation determines the parent path. We keep a stack of
     *     (indent, key) frames so nested keys resolve to full dotted paths.
     *   - List item markers ("- ...") do not contribute to the path; keys that
     *     appear under a "- name: foo" style list item are stored at the field
     *     level (e.g. "noisefloor.bands.bin_bandwidth") so they match how the
     *     visual editor renders array-of-object fields.
     */
    function parseYamlComments(text) {
        const map = {};
        const lines = text.split(/\r?\n/);

        // Stack of { indent, key } describing the current mapping path.
        const stack = [];
        // Buffered full-line comments awaiting the next key.
        let commentBuf = [];

        const indentOf = (line) => {
            let n = 0;
            while (n < line.length && line[n] === ' ') n++;
            return n;
        };

        // Strip an inline comment from a value, respecting quotes. Returns
        // { value, comment } where comment may be ''.
        const splitInlineComment = (rest) => {
            let inSingle = false;
            let inDouble = false;
            for (let i = 0; i < rest.length; i++) {
                const c = rest[i];
                if (c === "'" && !inDouble) inSingle = !inSingle;
                else if (c === '"' && !inSingle) inDouble = !inDouble;
                else if (c === '#' && !inSingle && !inDouble) {
                    // A '#' only starts a comment if preceded by whitespace or
                    // at the very start of the value region.
                    if (i === 0 || /\s/.test(rest[i - 1])) {
                        return {
                            value: rest.slice(0, i).trim(),
                            comment: rest.slice(i + 1).trim(),
                        };
                    }
                }
            }
            return { value: rest.trim(), comment: '' };
        };

        const buildPath = (indent, key) => {
            // Pop frames that are at the same or deeper indent than this key.
            while (stack.length && stack[stack.length - 1].indent >= indent) {
                stack.pop();
            }
            const parts = stack.map((f) => f.key);
            parts.push(key);
            return { path: parts.join('.'), pathParts: parts };
        };

        for (let raw of lines) {
            // Normalise tabs to spaces for indent counting (YAML forbids tabs,
            // but be defensive).
            const line = raw.replace(/\t/g, '    ');
            const trimmed = line.trim();

            if (trimmed === '') {
                // Blank line breaks a comment block so unrelated comments far
                // above a key don't leak into it.
                commentBuf = [];
                continue;
            }

            if (trimmed.startsWith('#')) {
                // Accumulate full-line comment (strip leading '#' and one space).
                const c = trimmed.replace(/^#\s?/, '');
                // Skip pure-decoration banner lines (e.g. "====", "----", "~~~~")
                // which are used only as visual separators in the example file.
                if (!/^[=~-]{3,}$/.test(c.trim())) {
                    commentBuf.push(c);
                }
                continue;
            }

            const indent = indentOf(line);

            // List item line: "- ..." possibly followed by "key: value".
            let working = trimmed;
            let isListItem = false;
            if (working.startsWith('- ')) {
                isListItem = true;
                working = working.slice(2).trim();
            } else if (working === '-') {
                // Bare list item marker; nothing else on the line.
                commentBuf = [];
                continue;
            }

            // Match "key:" or "key: value".
            const m = working.match(/^([A-Za-z0-9_.-]+)\s*:(.*)$/);
            if (!m) {
                // Not a key line (e.g. a plain scalar list element) — drop any
                // buffered comment so it doesn't attach to something unrelated.
                commentBuf = [];
                continue;
            }

            const key = m[1];
            const rest = m[2];
            const { comment: inlineComment } = splitInlineComment(rest);

            // Effective indent for path purposes: a list-item key ("- name:")
            // sits one level under the list key. We treat the list-item key as
            // belonging to the list key's children, using the list key's own
            // frame; to keep array-of-object fields flat we do NOT push an
            // index frame.
            const effIndent = isListItem ? indent + 2 : indent;
            const { path } = buildPath(effIndent, key);

            // Assemble help text: block comments first, then inline comment.
            const pieces = [];
            if (commentBuf.length) pieces.push(commentBuf.join('\n'));
            if (inlineComment) pieces.push(inlineComment);
            const help = pieces.join('\n').trim();

            if (help && map[path] === undefined) {
                map[path] = help;
            }
            commentBuf = [];

            // Decide whether this key opens a nested mapping. If there is no
            // scalar value after the colon (rest is empty/whitespace), it's a
            // parent — push it so children resolve under it. For list-item keys
            // we push using the effective indent so subsequent sibling fields
            // in the same object nest correctly.
            const hasScalarValue = splitInlineComment(rest).value !== '';
            if (!hasScalarValue) {
                stack.push({ indent: effIndent, key });
            }
            // For list-item scalar fields (e.g. "- name: foo" and the fields
            // that follow it) we deliberately do NOT push an index frame, so
            // all fields of every array element share one flat namespace
            // (e.g. "noisefloor.bands.bin_bandwidth"). This matches how the
            // visual editor renders array-of-object fields.
        }

        return map;
    }

    function ensureStyles() {
        if (document.getElementById('config-help-styles')) return;
        const style = document.createElement('style');
        style.id = 'config-help-styles';
        style.textContent = `
            /* ── ? help buttons ─────────────────────────────────────────── */
            .config-help-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                margin-left: 8px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: #667eea;
                color: #fff;
                font-size: 12px;
                font-weight: 700;
                line-height: 1;
                cursor: pointer;
                vertical-align: middle;
                flex: 0 0 auto;
                transition: background 0.2s;
            }
            .config-help-btn:hover { background: #4c5bd4; }

            /* ── help popover ────────────────────────────────────────────── */
            .config-help-popover {
                position: absolute;
                z-index: 10000;
                max-width: 380px;
                background: #fff;
                color: #333;
                border: 1px solid #d0d0e0;
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.18);
                padding: 0;
                font-size: 13px;
                line-height: 1.5;
            }
            .config-help-popover-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 8px 12px;
                background: #f4f5fb;
                border-bottom: 1px solid #e5e6f0;
                border-radius: 8px 8px 0 0;
                font-weight: 700;
                color: #4c5bd4;
                font-family: monospace;
                word-break: break-all;
            }
            .config-help-popover-close {
                border: none;
                background: transparent;
                color: #888;
                font-size: 18px;
                line-height: 1;
                cursor: pointer;
                padding: 0 2px;
            }
            .config-help-popover-close:hover { color: #333; }
            .config-help-popover-body {
                padding: 10px 12px;
                white-space: pre-wrap;
                word-wrap: break-word;
                max-height: 320px;
                overflow-y: auto;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif;
            }

            /* ── config search box ───────────────────────────────────────── */
            .config-search-wrap {
                position: relative;
                margin-bottom: 18px;
            }
            .config-search-input-row {
                display: flex;
                align-items: center;
                gap: 8px;
                background: #fff;
                border: 2px solid #667eea;
                border-radius: 8px;
                padding: 6px 12px;
                box-shadow: 0 2px 8px rgba(102,126,234,0.10);
            }
            .config-search-icon {
                color: #667eea;
                font-size: 16px;
                flex: 0 0 auto;
            }
            .config-search-input {
                flex: 1;
                border: none;
                outline: none;
                font-size: 14px;
                background: transparent;
                color: #333;
                min-width: 0;
            }
            .config-search-input::placeholder { color: #aaa; }
            .config-search-clear {
                border: none;
                background: transparent;
                color: #aaa;
                font-size: 18px;
                line-height: 1;
                cursor: pointer;
                padding: 0 2px;
                display: none;
            }
            .config-search-clear:hover { color: #555; }
            .config-search-results {
                position: absolute;
                top: calc(100% + 4px);
                left: 0;
                right: 0;
                background: #fff;
                border: 1px solid #d0d0e0;
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.14);
                z-index: 9000;
                max-height: 420px;
                overflow-y: auto;
                display: none;
            }
            .config-search-results.visible { display: block; }
            .config-search-result-item {
                padding: 10px 14px;
                cursor: pointer;
                border-bottom: 1px solid #f0f0f0;
                transition: background 0.15s;
            }
            .config-search-result-item:last-child { border-bottom: none; }
            .config-search-result-item:hover { background: #f4f5fb; }
            .config-search-result-path {
                font-family: monospace;
                font-size: 12px;
                font-weight: 700;
                color: #4c5bd4;
                margin-bottom: 3px;
            }
            .config-search-result-desc {
                font-size: 12px;
                color: #555;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .config-search-no-results {
                padding: 14px;
                color: #888;
                font-size: 13px;
                text-align: center;
            }
            .config-search-result-path mark,
            .config-search-result-desc mark {
                background: #fff3b0;
                color: inherit;
                border-radius: 2px;
                padding: 0 1px;
            }

            /* ── field highlight on navigate ─────────────────────────────── */
            @keyframes config-field-flash {
                0%   { background: #fff3b0; }
                60%  { background: #fff3b0; }
                100% { background: transparent; }
            }
            .config-field-highlight {
                animation: config-field-flash 1.6s ease-out forwards;
                border-radius: 4px;
            }
        `;
        document.head.appendChild(style);
    }

    let openPopover = null;

    function closePopover() {
        if (openPopover) {
            openPopover.remove();
            openPopover = null;
            document.removeEventListener('mousedown', onDocMouseDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('resize', closePopover);
            window.removeEventListener('scroll', onScroll, true);
        }
    }

    function onDocMouseDown(e) {
        // Keep the popover open when interacting with it (including dragging
        // its scrollbar) or when clicking any help button.
        if (openPopover && !openPopover.contains(e.target) &&
            !e.target.classList.contains('config-help-btn')) {
            closePopover();
        }
    }

    // Close only when the PAGE scrolls, not when the popover's own body scrolls.
    function onScroll(e) {
        if (openPopover && openPopover.contains(e.target)) return;
        closePopover();
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') closePopover();
    }

    function showPopover(anchorBtn, path, help) {
        ensureStyles();
        closePopover();

        const pop = document.createElement('div');
        pop.className = 'config-help-popover';

        const header = document.createElement('div');
        header.className = 'config-help-popover-header';
        const title = document.createElement('span');
        title.textContent = path;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'config-help-popover-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', closePopover);
        header.appendChild(title);
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'config-help-popover-body';
        body.textContent = help;

        pop.appendChild(header);
        pop.appendChild(body);
        document.body.appendChild(pop);

        // Position below the button, clamped to viewport.
        const rect = anchorBtn.getBoundingClientRect();
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;
        let left = rect.left + scrollX;
        let top = rect.bottom + scrollY + 6;

        // Clamp horizontally.
        const popWidth = Math.min(380, window.innerWidth - 20);
        if (left + popWidth > scrollX + window.innerWidth - 10) {
            left = scrollX + window.innerWidth - popWidth - 10;
        }
        if (left < scrollX + 10) left = scrollX + 10;

        pop.style.left = left + 'px';
        pop.style.top = top + 'px';

        openPopover = pop;
        // Defer listener attach so the opening click doesn't immediately close it.
        setTimeout(() => {
            document.addEventListener('mousedown', onDocMouseDown, true);
            document.addEventListener('keydown', onKeyDown, true);
            window.addEventListener('resize', closePopover);
            window.addEventListener('scroll', onScroll, true);
        }, 0);
    }

    const ConfigHelp = {
        /** Fetch and parse the example config. Idempotent; returns a Promise. */
        load() {
            if (loadPromise) return loadPromise;
            loadPromise = fetch(RAW_URL, { cache: 'no-cache' })
                .then((res) => {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.text();
                })
                .then((text) => {
                    helpMap = parseYamlComments(text);
                    return helpMap;
                })
                .catch((err) => {
                    console.warn('[config-help] Could not load help text:', err);
                    helpMap = {};
                    return helpMap;
                });
            return loadPromise;
        },

        /** Exposed for testing: parse a YAML string into a path->help map. */
        _parseYamlComments: parseYamlComments,

        /** True once a load attempt has completed (success or failure). */
        isReady() {
            return helpMap !== null;
        },

        /** Get help text for a dotted path, or undefined. */
        get(path) {
            if (!helpMap || !path) return undefined;
            if (helpMap[path] !== undefined) return helpMap[path];
            // Fallback: match on the final key segment for array-of-object
            // fields whose parent path includes an index or differs slightly.
            return undefined;
        },

        /**
         * Append a "?" help button to `el` for `path` IF help text exists.
         * Returns true if a button was added, false otherwise.
         */
        attach(el, path) {
            if (!el || !path) return false;
            const help = this.get(path);
            if (!help) return false;
            // Avoid duplicate buttons if a render pass runs twice.
            if (el.querySelector && el.querySelector(':scope > .config-help-btn')) {
                return false;
            }
            ensureStyles();
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'config-help-btn';
            btn.textContent = '?';
            btn.setAttribute('aria-label', 'Help for ' + path);
            btn.dataset.helpPath = path;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (openPopover && openPopover.dataset &&
                    openPopover.dataset.forPath === path) {
                    closePopover();
                    return;
                }
                showPopover(btn, path, help);
                if (openPopover) openPopover.dataset.forPath = path;
            });
            el.appendChild(btn);
            return true;
        },

        /**
         * Navigate to a config field by its dotted path.
         * Expands the section, scrolls to the field, and briefly highlights it.
         */
        navigateTo(path) {
            if (!path) return;
            const section = path.split('.')[0];

            // Find the section div.
            const sectionDiv = document.querySelector(
                `[data-section="${CSS.escape(section)}"]`
            );
            if (!sectionDiv) return;

            // Expand the section if collapsed.
            const content = sectionDiv.querySelector('.config-section-content');
            const toggle = sectionDiv.querySelector('.config-section-toggle');
            if (content && !content.classList.contains('expanded')) {
                content.classList.add('expanded');
                if (toggle) toggle.classList.remove('collapsed');
            }

            // Find the field element by data-path (label or h4).
            // Try exact match first, then section-level fallback.
            let target = sectionDiv.querySelector(`[data-path="${CSS.escape(path)}"]`);
            if (!target) {
                // For section-level paths (e.g. "server") scroll to the section header.
                target = sectionDiv.querySelector('.config-section-header');
            }
            if (!target) return;

            // Scroll into view smoothly.
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Flash the nearest .config-field ancestor, or the target itself.
            const flashEl = target.closest('.config-field') || target;
            flashEl.classList.remove('config-field-highlight');
            // Force reflow so re-adding the class restarts the animation.
            void flashEl.offsetWidth;
            flashEl.classList.add('config-field-highlight');
            setTimeout(() => flashEl.classList.remove('config-field-highlight'), 1700);
        },

        /**
         * Inject a keyword search box into `parent`.
         * Only call this when isReady() is true and helpMap is non-empty.
         */
        renderSearchBox(parent) {
            if (!helpMap || Object.keys(helpMap).length === 0) return;
            ensureStyles();

            // Remove any existing search box (e.g. on re-render).
            const existing = parent.querySelector('.config-search-wrap');
            if (existing) existing.remove();

            const wrap = document.createElement('div');
            wrap.className = 'config-search-wrap';

            // ── Input row ──────────────────────────────────────────────────
            const inputRow = document.createElement('div');
            inputRow.className = 'config-search-input-row';

            const icon = document.createElement('span');
            icon.className = 'config-search-icon';
            icon.textContent = '🔍';
            icon.setAttribute('aria-hidden', 'true');

            const input = document.createElement('input');
            input.type = 'search';
            input.className = 'config-search-input';
            input.placeholder = 'Search config settings…';
            input.setAttribute('aria-label', 'Search configuration settings');
            input.autocomplete = 'off';
            input.spellcheck = false;

            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'config-search-clear';
            clearBtn.textContent = '×';
            clearBtn.setAttribute('aria-label', 'Clear search');

            inputRow.appendChild(icon);
            inputRow.appendChild(input);
            inputRow.appendChild(clearBtn);

            // ── Results panel ──────────────────────────────────────────────
            const results = document.createElement('div');
            results.className = 'config-search-results';
            results.setAttribute('role', 'listbox');

            wrap.appendChild(inputRow);
            wrap.appendChild(results);
            parent.appendChild(wrap);

            // ── Helpers ────────────────────────────────────────────────────

            // Escape special regex chars in a string.
            const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Wrap all occurrences of `term` in `text` with <mark>.
            const highlight = (text, term) => {
                if (!term) return escapeHtml(text);
                const re = new RegExp('(' + escapeRe(term) + ')', 'gi');
                return escapeHtml(text).replace(
                    new RegExp('(' + escapeRe(escapeHtml(term)) + ')', 'gi'),
                    '<mark>$1</mark>'
                );
            };

            const escapeHtml = (s) =>
                s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const showResults = (items, term) => {
                results.innerHTML = '';
                if (items.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'config-search-no-results';
                    empty.textContent = 'No matching settings found.';
                    results.appendChild(empty);
                } else {
                    items.forEach(({ path, help }) => {
                        const item = document.createElement('div');
                        item.className = 'config-search-result-item';
                        item.setAttribute('role', 'option');

                        const pathEl = document.createElement('div');
                        pathEl.className = 'config-search-result-path';
                        pathEl.innerHTML = highlight(path, term);

                        // Show first non-empty line of help as description.
                        const firstLine = help.split('\n').find(l => l.trim()) || help;
                        const desc = document.createElement('div');
                        desc.className = 'config-search-result-desc';
                        desc.innerHTML = highlight(
                            firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
                            term
                        );

                        item.appendChild(pathEl);
                        item.appendChild(desc);

                        item.addEventListener('click', () => {
                            // Close search and navigate.
                            input.value = '';
                            clearBtn.style.display = 'none';
                            results.classList.remove('visible');
                            ConfigHelp.navigateTo(path);
                        });

                        results.appendChild(item);
                    });
                }
                results.classList.add('visible');
            };

            const hideResults = () => results.classList.remove('visible');

            // ── Search logic (debounced) ───────────────────────────────────
            let debounceTimer = null;

            const doSearch = (term) => {
                const q = term.trim().toLowerCase();
                if (!q) { hideResults(); return; }

                const matches = [];
                for (const [path, help] of Object.entries(helpMap)) {
                    if (path.toLowerCase().includes(q) || help.toLowerCase().includes(q)) {
                        matches.push({ path, help });
                    }
                }
                // Sort: path matches first, then by path length (shorter = more specific).
                matches.sort((a, b) => {
                    const aPath = a.path.toLowerCase().includes(q);
                    const bPath = b.path.toLowerCase().includes(q);
                    if (aPath && !bPath) return -1;
                    if (!aPath && bPath) return 1;
                    return a.path.length - b.path.length;
                });

                showResults(matches.slice(0, 20), term.trim());
            };

            input.addEventListener('input', () => {
                const val = input.value;
                clearBtn.style.display = val ? 'block' : 'none';
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => doSearch(val), 180);
            });

            clearBtn.addEventListener('click', () => {
                input.value = '';
                clearBtn.style.display = 'none';
                hideResults();
                input.focus();
            });

            // Close results when clicking outside the search widget.
            document.addEventListener('mousedown', (e) => {
                if (!wrap.contains(e.target)) hideResults();
            }, true);

            // Keyboard: Escape closes results; Enter navigates to first result.
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    hideResults();
                    input.blur();
                } else if (e.key === 'Enter') {
                    const first = results.querySelector('.config-search-result-item');
                    if (first) first.click();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const first = results.querySelector('.config-search-result-item');
                    if (first) first.focus();
                }
            });

            // Allow keyboard navigation within results.
            results.addEventListener('keydown', (e) => {
                const items = [...results.querySelectorAll('.config-search-result-item')];
                const idx = items.indexOf(document.activeElement);
                if (e.key === 'ArrowDown' && idx < items.length - 1) {
                    e.preventDefault();
                    items[idx + 1].focus();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (idx <= 0) { input.focus(); }
                    else { items[idx - 1].focus(); }
                } else if (e.key === 'Enter' && idx >= 0) {
                    items[idx].click();
                } else if (e.key === 'Escape') {
                    hideResults();
                    input.focus();
                }
            });

            // Make result items focusable for keyboard nav.
            results.addEventListener('mousedown', (e) => {
                // Prevent input blur when clicking a result.
                if (e.target.closest('.config-search-result-item')) {
                    e.preventDefault();
                }
            });
        },
    };

    window.ConfigHelp = ConfigHelp;
})();
