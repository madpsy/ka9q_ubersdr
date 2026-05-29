/**
 * profiles.js — Profiles list, save, load, delete.
 *
 * Exports: Profiles.init()
 */

const Profiles = (() => {
  const profilesBtn     = () => document.getElementById('profiles-btn');
  const saveProfileBtn  = () => document.getElementById('save-profile-btn');
  const profilesList    = () => document.getElementById('profiles-list');
  const loadBtn         = () => document.getElementById('profile-load-btn');
  const deleteBtn       = () => document.getElementById('profile-delete-btn');
  const saveNameInput   = () => document.getElementById('save-profile-name');
  const saveConfirmBtn  = () => document.getElementById('save-profile-confirm-btn');

  let _profiles    = [];
  let _selectedIdx = -1;
  let _activeProfileName = '';

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function formatFreqKHz(hz) {
    return hz ? (hz / 1000).toFixed(3) + ' kHz' : '';
  }

  // ── Open profiles modal ───────────────────────────────────────────────────
  async function openProfilesModal() {
    _selectedIdx = -1;
    App.openModal('modal-profiles');
    renderList([]);

    try {
      const data = await API.getProfiles();
      _profiles = data?.profiles || [];
    } catch (e) {
      _profiles = [];
    }

    renderList(_profiles);
    updateButtons();
  }

  function renderList(profiles) {
    const ul = profilesList();
    if (!ul) return;
    ul.innerHTML = '';

    if (profiles.length === 0) {
      ul.innerHTML = '<li style="padding:12px;color:var(--text-muted)">No saved profiles yet. Use 💾 to save the current settings.</li>';
      return;
    }

    profiles.forEach((p, idx) => {
      const li = document.createElement('li');
      li.className = 'profile-item' + (idx === _selectedIdx ? ' selected' : '');

      const parts = [];
      if (p.callsign)     parts.push(p.callsign);
      if (p.frequency_hz) parts.push(formatFreqKHz(p.frequency_hz));
      if (p.mode)         parts.push(p.mode.toUpperCase());
      const subtitle = parts.join(' · ');

      li.innerHTML = `
        <div class="item-title">📋 ${escHtml(p.name)}</div>
        ${subtitle ? `<div class="item-subtitle">${escHtml(subtitle)}</div>` : ''}
      `;

      li.addEventListener('click', () => {
        _selectedIdx = idx;
        renderList(_profiles);
        updateButtons();
      });

      li.addEventListener('dblclick', () => {
        _selectedIdx = idx;
        loadSelectedProfile();
      });

      ul.appendChild(li);
    });
  }

  function updateButtons() {
    const lb = loadBtn();
    const db = deleteBtn();
    const hasSelection = _selectedIdx >= 0 && _selectedIdx < _profiles.length;
    if (lb) lb.disabled = !hasSelection;
    if (db) db.disabled = !hasSelection;
  }

  // ── Load profile ──────────────────────────────────────────────────────────
  async function loadSelectedProfile() {
    if (_selectedIdx < 0 || _selectedIdx >= _profiles.length) return;
    const name = _profiles[_selectedIdx].name;
    App.closeModal('modal-profiles');

    try {
      const result = await API.loadProfile(name);
      _activeProfileName = name;
      // The status will update via polling
    } catch (e) {
      console.warn('Load profile error:', e.message);
    }
  }

  // ── Delete profile ────────────────────────────────────────────────────────
  async function deleteSelectedProfile() {
    if (_selectedIdx < 0 || _selectedIdx >= _profiles.length) return;
    const name = _profiles[_selectedIdx].name;

    const ok = await App.confirm('Delete Profile', `Delete profile "${name}"?`);
    if (!ok) return;

    try {
      await API.deleteProfile(name);
      _profiles.splice(_selectedIdx, 1);
      _selectedIdx = -1;
      renderList(_profiles);
      updateButtons();
      if (_activeProfileName === name) _activeProfileName = '';
    } catch (e) {
      console.warn('Delete profile error:', e.message);
    }
  }

  // ── Save profile ──────────────────────────────────────────────────────────
  function openSaveModal() {
    const inp = saveNameInput();
    if (inp) inp.value = _activeProfileName || '';
    App.openModal('modal-save-profile');
    setTimeout(() => inp?.focus(), 100);
  }

  async function doSaveProfile() {
    const inp  = saveNameInput();
    const name = inp?.value?.trim();
    if (!name) {
      inp?.focus();
      return;
    }

    // Check if exists
    const exists = _profiles.some(p => p.name === name);
    if (exists) {
      const ok = await App.confirm(
        'Overwrite Profile',
        `A profile named "${name}" already exists. Overwrite it?`
      );
      if (!ok) return;
    }

    try {
      await API.saveProfile(name);
      _activeProfileName = name;
      App.closeModal('modal-save-profile');
    } catch (e) {
      console.warn('Save profile error:', e.message);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    profilesBtn()?.addEventListener('click', openProfilesModal);
    saveProfileBtn()?.addEventListener('click', openSaveModal);

    loadBtn()?.addEventListener('click', loadSelectedProfile);
    deleteBtn()?.addEventListener('click', deleteSelectedProfile);

    saveConfirmBtn()?.addEventListener('click', doSaveProfile);

    saveNameInput()?.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSaveProfile();
    });
  }

  return { init };
})();
