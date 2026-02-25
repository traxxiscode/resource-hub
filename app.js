/* ============================================================
   RESOURCE HUB — app.js
   All state persisted in localStorage.
   ============================================================ */

'use strict';

/* ==============================
   STATE
   ============================== */
let state = {
  sections: [],   // [{ id, name }]
  resources: []   // [{ id, sectionId, name, url, desc, tags[] }]
};

let editingResourceId = null;
let editingSectionId  = null;
let contextResourceId = null;
let contextSectionId  = null;

/* ==============================
   PERSISTENCE
   ============================== */
function loadState() {
  try {
    const saved = localStorage.getItem('resourceHub');
    if (saved) state = JSON.parse(saved);
  } catch (e) { /* fresh start */ }
}

function saveState() {
  localStorage.setItem('resourceHub', JSON.stringify(state));
}

/* ==============================
   THEME
   ============================== */
function loadTheme() {
  const saved = localStorage.getItem('resourceHubTheme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next    = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('resourceHubTheme', next);
}

document.getElementById('themeToggle').addEventListener('click', toggleTheme);

/* ==============================
   UTILITIES
   ============================== */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getFavicon(url) {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return null;
  }
}

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url; }
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ==============================
   RENDER
   ============================== */
function render() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const main  = document.getElementById('mainContent');
  const empty = document.getElementById('emptyState');

  // Clear non-empty-state children
  [...main.children].forEach(c => { if (c !== empty) c.remove(); });

  if (state.sections.length === 0 && !query) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  if (state.sections.length === 0) return;

  let totalVisible = 0;

  state.sections.forEach(sec => {
    const secResources = state.resources.filter(r => r.sectionId === sec.id);

    const filtered = query
      ? secResources.filter(r =>
          r.name.toLowerCase().includes(query) ||
          r.url.toLowerCase().includes(query) ||
          (r.desc && r.desc.toLowerCase().includes(query)) ||
          (r.tags && r.tags.some(t => t.toLowerCase().includes(query)))
        )
      : secResources;

    if (query && filtered.length === 0) return;

    totalVisible += filtered.length;

    const block = document.createElement('div');
    block.className = 'section-block';
    block.dataset.sectionId = sec.id;

    block.innerHTML = `
      <div class="section-header">
        <span class="section-name" data-section-id="${sec.id}" title="Click to rename">${esc(sec.name)}</span>
        <span class="section-count">${filtered.length}</span>
        <div class="section-actions">
          <button class="btn btn-sm btn-outline add-res-to-sec" data-section-id="${sec.id}">+ Resource</button>
          <button class="btn-icon rename-sec" data-section-id="${sec.id}" title="Rename section">✎</button>
          <button class="btn-icon delete-sec" data-section-id="${sec.id}" title="Delete section">✕</button>
        </div>
      </div>
      <div class="resource-grid" id="grid-${sec.id}"></div>
    `;

    const grid = block.querySelector(`#grid-${sec.id}`);

    if (filtered.length === 0) {
      grid.innerHTML = `<p class="section-empty">No resources yet. Add one above.</p>`;
    } else {
      filtered.forEach((r, i) => grid.appendChild(buildCard(r, i)));
    }

    main.appendChild(block);
  });

  if (query && totalVisible === 0) {
    const msg = document.createElement('div');
    msg.className = 'search-no-results';
    msg.textContent = `No resources found for "${query}"`;
    main.appendChild(msg);
  }
}

function buildCard(r, index) {
  // The entire card is an <a> that opens the link
  const card = document.createElement('a');
  card.className = 'resource-card';
  card.href = r.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.dataset.resourceId = r.id;
  card.style.animationDelay = `${index * 30}ms`;

  const faviconUrl = getFavicon(r.url);
  const domain     = getDomain(r.url);
  const letter     = r.name.charAt(0).toUpperCase();

  const tagsHtml = r.tags && r.tags.length
    ? `<div class="card-tags">${r.tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>`
    : '';

  const descHtml = r.desc
    ? `<p class="card-desc">${esc(r.desc)}</p>`
    : '';

  card.innerHTML = `
    <div class="card-top">
      <div class="card-favicon">
        ${faviconUrl
          ? `<img src="${faviconUrl}" alt="" onerror="this.parentElement.innerHTML='<span class=card-favicon-letter>${letter}</span>'" />`
          : `<span class="card-favicon-letter">${letter}</span>`
        }
      </div>
      <div class="card-info">
        <div class="card-name" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="card-url">${esc(domain)}</div>
      </div>
    </div>
    ${descHtml}
    ${tagsHtml}
    <div class="card-footer">
      <button class="card-menu-btn" data-resource-id="${r.id}" title="Options">⋯</button>
    </div>
  `;

  return card;
}

/* ==============================
   SECTIONS
   ============================== */
function addSection(name) {
  const sec = { id: uid(), name: name.trim() };
  state.sections.push(sec);
  saveState();
  render();
  return sec;
}

function renameSection(id, name) {
  const sec = state.sections.find(s => s.id === id);
  if (sec) { sec.name = name.trim(); saveState(); render(); }
}

function deleteSection(id) {
  if (!confirm('Delete this section and all its resources?')) return;
  state.sections  = state.sections.filter(s => s.id !== id);
  state.resources = state.resources.filter(r => r.sectionId !== id);
  saveState();
  render();
}

/* ==============================
   RESOURCES
   ============================== */
function addResource(data) {
  const r = {
    id: uid(),
    sectionId: data.sectionId,
    name: data.name.trim(),
    url:  data.url.trim(),
    desc: data.desc ? data.desc.trim() : '',
    tags: data.tags ? data.tags.split(',').map(t => t.trim()).filter(Boolean) : []
  };
  state.resources.push(r);
  saveState();
  render();
}

function updateResource(id, data) {
  const r = state.resources.find(r => r.id === id);
  if (!r) return;
  r.sectionId = data.sectionId;
  r.name = data.name.trim();
  r.url  = data.url.trim();
  r.desc = data.desc ? data.desc.trim() : '';
  r.tags = data.tags ? data.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  saveState();
  render();
}

function deleteResource(id) {
  if (!confirm('Delete this resource?')) return;
  state.resources = state.resources.filter(r => r.id !== id);
  saveState();
  render();
}

function moveOrCopyResource(resourceId, targetSectionId, action) {
  const r = state.resources.find(r => r.id === resourceId);
  if (!r) return;
  if (action === 'move') {
    r.sectionId = targetSectionId;
  } else {
    state.resources.push({ ...r, id: uid(), sectionId: targetSectionId });
  }
  saveState();
  render();
}

/* ==============================
   MODAL HELPERS
   ============================== */
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function populateSectionSelect(selectId, excludeId = null) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '';
  state.sections.forEach(sec => {
    if (sec.id === excludeId) return;
    const opt = document.createElement('option');
    opt.value = sec.id;
    opt.textContent = sec.name;
    sel.appendChild(opt);
  });
}

/* ==============================
   OPEN RESOURCE MODAL
   ============================== */
function openResourceModal(resourceId = null, defaultSectionId = null) {
  const titleEl = document.getElementById('resourceModalTitle');
  const nameEl  = document.getElementById('resName');
  const urlEl   = document.getElementById('resUrl');
  const descEl  = document.getElementById('resDesc');
  const tagsEl  = document.getElementById('resTags');
  const secSel  = document.getElementById('resSection');

  editingResourceId = resourceId;
  populateSectionSelect('resSection');

  if (resourceId) {
    const r = state.resources.find(r => r.id === resourceId);
    titleEl.textContent = 'Edit Resource';
    nameEl.value = r.name;
    urlEl.value  = r.url;
    descEl.value = r.desc || '';
    tagsEl.value = r.tags ? r.tags.join(', ') : '';
    secSel.value = r.sectionId;
  } else {
    titleEl.textContent = 'Add Resource';
    nameEl.value = '';
    urlEl.value  = '';
    descEl.value = '';
    tagsEl.value = '';
    if (defaultSectionId) secSel.value = defaultSectionId;
  }

  openModal('resourceModal');
  setTimeout(() => nameEl.focus(), 50);
}

/* ==============================
   OPEN SECTION MODAL
   ============================== */
function openSectionModal(sectionId = null) {
  const titleEl = document.getElementById('sectionModalTitle');
  const nameEl  = document.getElementById('secName');
  editingSectionId = sectionId;

  if (sectionId) {
    const sec = state.sections.find(s => s.id === sectionId);
    titleEl.textContent = 'Rename Section';
    nameEl.value = sec.name;
  } else {
    titleEl.textContent = 'Add Section';
    nameEl.value = '';
  }

  openModal('sectionModal');
  setTimeout(() => nameEl.focus(), 50);
}

/* ==============================
   OPEN MOVE MODAL
   ============================== */
function openMoveModal(resourceId) {
  const r = state.resources.find(r => r.id === resourceId);
  if (!r) return;
  contextResourceId = resourceId;

  document.getElementById('moveResourceName').textContent = `"${r.name}"`;
  populateSectionSelect('moveTarget', null);
  const otherSec = state.sections.find(s => s.id !== r.sectionId);
  if (otherSec) document.getElementById('moveTarget').value = otherSec.id;

  document.querySelector('input[name="moveAction"][value="move"]').checked = true;
  openModal('moveModal');
}

/* ==============================
   CONTEXT MENU
   ============================== */
function openContextMenu(resourceId, x, y) {
  contextResourceId = resourceId;
  const r = state.resources.find(r => r.id === resourceId);
  contextSectionId  = r ? r.sectionId : null;

  const menu = document.getElementById('contextMenu');
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.classList.add('open');

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right  > window.innerWidth  - 8) menu.style.left = (x - rect.width)  + 'px';
    if (rect.bottom > window.innerHeight - 8) menu.style.top  = (y - rect.height) + 'px';
  });
}

function closeContextMenu() {
  document.getElementById('contextMenu').classList.remove('open');
}

/* ==============================
   SEARCH
   ============================== */
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');

searchInput.addEventListener('input', () => {
  searchClear.classList.toggle('visible', searchInput.value.length > 0);
  render();
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.remove('visible');
  render();
  searchInput.focus();
});

/* ==============================
   DELEGATED CLICK HANDLER
   ============================== */
document.addEventListener('click', e => {
  if (!e.target.closest('#contextMenu')) closeContextMenu();

  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeModal(closeBtn.dataset.close); return; }

  if (e.target.classList.contains('modal-backdrop')) {
    closeModal(e.target.id); return;
  }

  if (e.target.id === 'addSectionBtn' || e.target.id === 'emptyAddSectionBtn') {
    openSectionModal(); return;
  }

  if (e.target.id === 'addResourceBtn' || e.target.id === 'emptyAddResourceBtn') {
    if (state.sections.length === 0) {
      alert('Please add a section first.');
      openSectionModal();
      return;
    }
    openResourceModal(); return;
  }

  const addToSec = e.target.closest('.add-res-to-sec');
  if (addToSec) { openResourceModal(null, addToSec.dataset.sectionId); return; }

  const renameSec = e.target.closest('.rename-sec');
  if (renameSec) { openSectionModal(renameSec.dataset.sectionId); return; }

  const deleteSec = e.target.closest('.delete-sec');
  if (deleteSec) { deleteSection(deleteSec.dataset.sectionId); return; }

  const secName = e.target.closest('.section-name');
  if (secName && !e.target.closest('.section-actions')) {
    startInlineRename(secName); return;
  }

  // Card menu button — stop propagation so the <a> card doesn't navigate
  const menuBtn = e.target.closest('.card-menu-btn');
  if (menuBtn) {
    e.preventDefault();
    e.stopPropagation();
    const rect = menuBtn.getBoundingClientRect();
    openContextMenu(menuBtn.dataset.resourceId, rect.left, rect.bottom + 6);
    return;
  }

  if (e.target.id === 'ctxEdit')   { closeContextMenu(); openResourceModal(contextResourceId); return; }
  if (e.target.id === 'ctxMove')   {
    closeContextMenu();
    if (state.sections.length < 2) { alert('You need at least 2 sections to move resources.'); return; }
    openMoveModal(contextResourceId); return;
  }
  if (e.target.id === 'ctxDelete') { closeContextMenu(); deleteResource(contextResourceId); return; }
});

/* ==============================
   INLINE SECTION RENAME
   ============================== */
function startInlineRename(el) {
  const id = el.dataset.sectionId;
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function finish() {
    el.contentEditable = 'false';
    const newName = el.textContent.trim();
    if (newName) renameSection(id, newName);
    else render();
    el.removeEventListener('blur', finish);
    el.removeEventListener('keydown', onKey);
  }
  function onKey(ev) {
    if (ev.key === 'Enter')  { ev.preventDefault(); finish(); }
    if (ev.key === 'Escape') { el.contentEditable = 'false'; render(); }
  }
  el.addEventListener('blur', finish);
  el.addEventListener('keydown', onKey);
}

/* ==============================
   SAVE RESOURCE
   ============================== */
document.getElementById('saveResourceBtn').addEventListener('click', () => {
  const name      = document.getElementById('resName').value.trim();
  const url       = document.getElementById('resUrl').value.trim();
  const desc      = document.getElementById('resDesc').value.trim();
  const tags      = document.getElementById('resTags').value.trim();
  const sectionId = document.getElementById('resSection').value;

  if (!name)      { document.getElementById('resName').focus(); return; }
  if (!url)       { document.getElementById('resUrl').focus(); return; }
  if (!sectionId) { alert('Please select a section.'); return; }

  const finalUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  const data = { name, url: finalUrl, desc, tags, sectionId };

  if (editingResourceId) updateResource(editingResourceId, data);
  else addResource(data);

  closeModal('resourceModal');
});

['resName', 'resUrl', 'resDesc', 'resTags'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('saveResourceBtn').click();
  });
});

/* ==============================
   SAVE SECTION
   ============================== */
document.getElementById('saveSectionBtn').addEventListener('click', () => {
  const name = document.getElementById('secName').value.trim();
  if (!name) { document.getElementById('secName').focus(); return; }
  if (editingSectionId) renameSection(editingSectionId, name);
  else addSection(name);
  closeModal('sectionModal');
});

document.getElementById('secName').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('saveSectionBtn').click();
});

/* ==============================
   CONFIRM MOVE / COPY
   ============================== */
document.getElementById('confirmMoveBtn').addEventListener('click', () => {
  const targetSectionId = document.getElementById('moveTarget').value;
  const action = document.querySelector('input[name="moveAction"]:checked').value;
  if (!targetSectionId) return;
  moveOrCopyResource(contextResourceId, targetSectionId, action);
  closeModal('moveModal');
});

/* ==============================
   KEYBOARD SHORTCUTS
   ============================== */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeContextMenu();
    ['resourceModal', 'sectionModal', 'moveModal'].forEach(id => {
      if (document.getElementById(id).classList.contains('open')) closeModal(id);
    });
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

/* ==============================
   INIT
   ============================== */
loadTheme();
loadState();
render();