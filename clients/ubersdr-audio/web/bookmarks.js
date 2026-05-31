/**
 * bookmarks.js — Searchable bookmark combobox for the web frontend.
 *
 * Replaces the plain <select> with a text input + filtered dropdown list.
 * Typing filters bookmarks by name, group, mode, or frequency.
 * Clicking (or pressing Enter on) a result tunes immediately and shows the
 * bookmark name in the input field.
 *
 * Exports: Bookmarks.init(), Bookmarks.onConnected(), Bookmarks.onDisconnected()
 */

const Bookmarks = (() => {
  const input    = () => document.getElementById('bm-input');
  const list     = () => document.getElementById('bm-list');
  const combo    = () => document.getElementById('bm-combo');

  let _bookmarks    = [];   // full bookmark objects from server
  let _filtered     = [];   // currently displayed subset
  let _activeIdx    = -1;   // keyboard-highlighted index in _filtered
  let _selectedName = '';   // name of the last tuned bookmark
  let _open         = false;
  let _fetching     = false; // guard against concurrent fetches

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function formatFreqKHz(hz) {
    return hz ? (hz / 1000).toFixed(3) + ' kHz' : '';
  }

  function matchesQuery(bm, q) {
    if (!q) return true;
    const hay = [
      bm.name || '',
      bm.group || '',
      bm.mode || '',
      formatFreqKHz(bm.frequency),
      bm.comment || '',
    ].join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  // ── Position the fixed dropdown under the input ───────────────────────────
  function positionList() {
    const inp = input();
    const ul  = list();
    if (!inp || !ul) return;
    const rect = inp.getBoundingClientRect();
    ul.style.top   = `${rect.bottom + 2}px`;
    ul.style.left  = `${rect.left}px`;
    ul.style.width = `${rect.width}px`;
  }

  // ── Dropdown open/close ───────────────────────────────────────────────────
  function openList() {
    if (_bookmarks.length === 0) return;
    _open = true;
    positionList();
    list()?.classList.add('open');
  }

  function closeList() {
    _open = false;
    _activeIdx = -1;
    list()?.classList.remove('open');
  }

  // ── Render filtered list ──────────────────────────────────────────────────
  function renderList(query) {
    const ul = list();
    if (!ul) return;

    _filtered = _bookmarks.filter(bm => matchesQuery(bm, query));
    _activeIdx = -1;

    if (_filtered.length === 0) {
      ul.innerHTML = '<li class="bm-item" style="color:var(--text-muted);cursor:default">No matches</li>';
      openList();
      return;
    }

    ul.innerHTML = _filtered.map((bm, i) => {
      const meta = [formatFreqKHz(bm.frequency), (bm.mode || '').toUpperCase(), bm.group].filter(Boolean).join(' · ');
      return `<li class="bm-item" data-idx="${i}" role="option">
        <div class="bm-item-name">${escHtml(bm.name)}</div>
        ${meta ? `<div class="bm-item-meta">${escHtml(meta)}</div>` : ''}
      </li>`;
    }).join('');

    // Wire click handlers
    ul.querySelectorAll('.bm-item[data-idx]').forEach(li => {
      li.addEventListener('mousedown', e => {
        e.preventDefault(); // prevent input blur before click fires
        const idx = parseInt(li.dataset.idx, 10);
        if (!isNaN(idx) && idx < _filtered.length) {
          selectBookmark(_filtered[idx]);
        }
      });
    });

    openList();
  }

  // ── Highlight active item ─────────────────────────────────────────────────
  function setActive(idx) {
    const ul = list();
    if (!ul) return;
    const items = ul.querySelectorAll('.bm-item[data-idx]');
    items.forEach(li => li.classList.remove('active'));
    if (idx >= 0 && idx < items.length) {
      items[idx].classList.add('active');
      items[idx].scrollIntoView({ block: 'nearest' });
    }
    _activeIdx = idx;
  }

  // ── Select and tune ───────────────────────────────────────────────────────
  async function selectBookmark(bm) {
    _selectedName = bm.name;
    const inp = input();
    if (inp) inp.value = bm.name;
    closeList();

    const body = { frequency_hz: bm.frequency, mode: bm.mode };
    if (typeof bm.bandwidth_low === 'number' && typeof bm.bandwidth_high === 'number') {
      body.bandwidth_low  = bm.bandwidth_low;
      body.bandwidth_high = bm.bandwidth_high;
    }

    try {
      const result = await API.putTune(body);
      if (result) {
        Tune.applySnapshot(result);
        Tune.suppressPollUntil(Date.now() + 3000);
      }
    } catch (e) {
      console.warn('Bookmark tune error:', e.message);
    }
  }

  // ── Fetch and populate ────────────────────────────────────────────────────
  async function fetchAndPopulate() {
    if (_fetching) return; // prevent concurrent fetches
    const inp = input();
    if (!inp) return;

    _fetching = true;
    try {
      const data = await API.getBookmarks();
      _bookmarks = Array.isArray(data) ? data : [];
    } catch (e) {
      _bookmarks = [];
    } finally {
      _fetching = false;
    }

    if (_bookmarks.length > 0) {
      inp.disabled = false;
      inp.placeholder = `Search ${_bookmarks.length} bookmark${_bookmarks.length !== 1 ? 's' : ''}…`;
    } else {
      inp.disabled = true;
      inp.placeholder = 'No bookmarks available';
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function onConnected() {
    fetchAndPopulate();
  }

  // retryIfEmpty re-fetches bookmarks when connected but the previous fetch
  // failed (e.g. due to a race with auto-connect).  Called from the status
  // poll on every connected tick while _bookmarks is still empty.
  function retryIfEmpty() {
    if (_bookmarks.length === 0) {
      fetchAndPopulate();
    }
  }

  function onDisconnected() {
    _bookmarks = [];
    _selectedName = '';
    _filtered = [];
    closeList();
    const inp = input();
    if (inp) {
      inp.value = '';
      inp.disabled = true;
      inp.placeholder = 'Search bookmarks…';
    }
    const ul = list();
    if (ul) ul.innerHTML = '';
  }

  function init() {
    const inp = input();
    if (!inp) return;

    // Show filtered list on input
    inp.addEventListener('input', e => {
      renderList(e.target.value.trim());
    });

    // Open on focus (show all if empty)
    inp.addEventListener('focus', () => {
      if (_bookmarks.length > 0) {
        renderList(inp.value.trim());
      }
    });

    // Keyboard navigation
    inp.addEventListener('keydown', e => {
      if (!_open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
          renderList(inp.value.trim());
          return;
        }
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActive(Math.min(_activeIdx + 1, _filtered.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActive(Math.max(_activeIdx - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (_activeIdx >= 0 && _activeIdx < _filtered.length) {
            selectBookmark(_filtered[_activeIdx]);
          } else if (_filtered.length === 1) {
            selectBookmark(_filtered[0]);
          }
          break;
        case 'Escape':
          closeList();
          inp.blur();
          break;
      }
    });

    // Close when clicking outside (but not on the fixed list itself)
    document.addEventListener('click', e => {
      if (!combo()?.contains(e.target) && !list()?.contains(e.target)) {
        closeList();
      }
    });

    // Close on touch outside (mobile)
    document.addEventListener('touchstart', e => {
      if (!combo()?.contains(e.target) && !list()?.contains(e.target)) {
        closeList();
      }
    }, { passive: true });

    // Reposition the fixed list on scroll or resize while open
    const reposition = () => { if (_open) positionList(); };
    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    document.getElementById('main-content')?.addEventListener('scroll', reposition, { passive: true });
  }

  return { init, onConnected, onDisconnected, retryIfEmpty };
})();
