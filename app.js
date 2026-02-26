/* ============================================================
   RESOURCE HUB — app.js
   State stored in Firestore. Edit access protected by hashed key.
   ============================================================ */

'use strict';
//Hello
/* ==============================
   FIREBASE CONFIG
   Replace with your own project config from Firebase Console:
   https://console.firebase.google.com → Project Settings → Your apps
   ============================== */
const firebaseConfig = {
  apiKey: "AIzaSyA5Tl5nDWZsfnnbm6O1LJII9KcQMkT37uc",
  authDomain: "resource-hub-966bc.firebaseapp.com",
  projectId: "resource-hub-966bc",
  storageBucket: "resource-hub-966bc.firebasestorage.app",
  messagingSenderId: "506921157050",
  appId: "1:506921157050:web:4160264248522f3734dd83"
};

/* ==============================
   FIRESTORE COLLECTION NAMES
   ============================== */
const COL_SECTIONS  = 'sections';
const COL_RESOURCES = 'resources';
const COL_GROUPS    = 'groups';          // { sectionId, name, order }
const COL_CONFIG    = 'config';          // stores { editKeyHash, editKeySalt }
const CONFIG_DOC    = 'editKey';

/* ==============================
   AUTH CONSTANTS
   ============================== */
const MAX_ATTEMPTS    = 3;
const SESSION_KEY     = 'resourceHubAuth';  // sessionStorage key
const SESSION_LOCKED  = 'resourceHubLocked';
const SESSION_FAILS   = 'resourceHubFails';

/* ==============================
   STATE
   ============================== */
let db;
let sections  = [];   // [{ id, name, order }]
let resources = [];   // [{ id, sectionId, groupId, name, url, desc, tags[], order }]
let groups    = [];   // [{ id, sectionId, name, order }]
let isEditor  = false;

let editingResourceId = null;
let editingSectionId  = null;
let editingGroupId    = null;
let contextResourceId = null;
let contextSectionId  = null;

// Drag state managed by pointer-event drag system (see startCardDrag)

/* ==============================
   FIREBASE INIT
   ============================== */
async function initFirebase() {
  const { initializeApp }   = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const { getFirestore, collection, doc, getDocs, getDoc,
          setDoc, addDoc, updateDoc, deleteDoc, onSnapshot,
          orderBy, query, where, writeBatch }  = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);

  // Expose Firestore helpers globally for the rest of the module
  window._fs = { collection, doc, getDocs, getDoc, setDoc, addDoc,
                 updateDoc, deleteDoc, onSnapshot, orderBy, query, where, writeBatch };

  return db;
}

/* ==============================
   CRYPTO HELPERS
   ============================== */
async function hashKey(password, salt) {
  const enc      = new TextEncoder();
  const keyMat   = await crypto.subtle.importKey('raw', enc.encode(password),
                     { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits     = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 200_000, hash: 'SHA-256' },
    keyMat, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ==============================
   AUTH STATE (sessionStorage)
   ============================== */
function loadAuthState() {
  isEditor = sessionStorage.getItem(SESSION_KEY) === 'true';
}

function setEditor(value) {
  isEditor = value;
  sessionStorage.setItem(SESSION_KEY, value ? 'true' : 'false');
}

function getFailCount() {
  return parseInt(sessionStorage.getItem(SESSION_FAILS) || '0', 10);
}

function incFailCount() {
  const n = getFailCount() + 1;
  sessionStorage.setItem(SESSION_FAILS, String(n));
  return n;
}

function isLocked() {
  return sessionStorage.getItem(SESSION_LOCKED) === 'true';
}

function lockOut() {
  sessionStorage.setItem(SESSION_LOCKED, 'true');
}

/* ==============================
   FIRESTORE: LOAD DATA
   ============================== */
async function loadData() {
  const { collection, getDocs, orderBy, query } = window._fs;

  const [secSnap, resSnap] = await Promise.all([
    getDocs(query(collection(db, COL_SECTIONS),  orderBy('order',     'asc'))),
    getDocs(query(collection(db, COL_RESOURCES), orderBy('createdAt', 'asc')))
  ]);

  sections  = secSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  resources = resSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Groups collection may not exist yet — don't let it block the rest
  try {
    const grpSnap = await getDocs(query(collection(db, COL_GROUPS), orderBy('createdAt', 'asc')));
    groups = grpSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    groups = [];
  }
}

/* ==============================
   FIRESTORE: REAL-TIME LISTENER
   ============================== */
function subscribeRealtime() {
  const { collection, onSnapshot, orderBy, query } = window._fs;

  onSnapshot(query(collection(db, COL_SECTIONS), orderBy('order', 'asc')), snap => {
    sections = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });

  onSnapshot(query(collection(db, COL_RESOURCES), orderBy('createdAt', 'asc')), snap => {
    resources = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });

  onSnapshot(query(collection(db, COL_GROUPS), orderBy('createdAt', 'asc')), snap => {
    groups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, () => { groups = []; });
}

/* ==============================
   EDIT KEY: CHECK IF SET
   ============================== */
async function getEditKeyDoc() {
  const { doc, getDoc } = window._fs;
  const snap = await getDoc(doc(db, COL_CONFIG, CONFIG_DOC));
  return snap.exists() ? snap.data() : null;
}

/* ==============================
   EDIT KEY: VERIFY
   ============================== */
async function verifyEditKey(input) {
  const keyDoc = await getEditKeyDoc();
  if (!keyDoc) return false;
  const hash = await hashKey(input, keyDoc.salt);
  return hash === keyDoc.hash;
}

/* ==============================
   EDIT KEY: SAVE (first-time setup or change)
   ============================== */
async function saveEditKey(password) {
  const { doc, setDoc } = window._fs;
  const salt = generateSalt();
  const hash = await hashKey(password, salt);
  await setDoc(doc(db, COL_CONFIG, CONFIG_DOC), { hash, salt });
}

/* ==============================
   AUTH MODAL LOGIC
   ============================== */
function openAuthModal(isSetup = false) {
  const modal   = document.getElementById('authModal');
  const title   = document.getElementById('authModalTitle');
  const body    = document.getElementById('authModalBody');
  const hint    = document.getElementById('authHint');
  const input   = document.getElementById('authKeyInput');
  const saveBtn = document.getElementById('authSaveBtn');
  const locked  = isLocked();

  if (locked) {
    title.textContent = '🔒 Locked Out';
    body.innerHTML = `<p style="color:var(--text-muted);font-size:15px;">Too many failed attempts. Close this tab or clear session storage to try again.</p>`;
    saveBtn.style.display = 'none';
    modal.classList.add('open');
    return;
  }

  const remaining = MAX_ATTEMPTS - getFailCount();

  if (isSetup) {
    title.textContent = 'Set Edit Key';
    hint.textContent  = 'No edit key exists yet. Set one to enable editing.';
    hint.style.display = '';
    saveBtn.textContent = 'Set Key';
    input.placeholder   = 'Choose a secure passphrase…';
  } else {
    title.textContent = 'Enter Edit Key';
    hint.textContent  = `${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`;
    hint.style.display = '';
    saveBtn.textContent = 'Unlock';
    input.placeholder   = 'Enter edit key…';
  }

  saveBtn.style.display = '';
  saveBtn.dataset.mode  = isSetup ? 'setup' : 'verify';
  input.value = '';
  input.type  = 'password';
  modal.classList.add('open');
  setTimeout(() => input.focus(), 60);
}

function closeAuthModal() {
  document.getElementById('authModal').classList.remove('open');
}

async function handleAuthSave() {
  const input   = document.getElementById('authKeyInput');
  const errEl   = document.getElementById('authError');
  const saveBtn = document.getElementById('authSaveBtn');
  const mode    = saveBtn.dataset.mode;
  const value   = input.value.trim();

  errEl.textContent = '';
  if (!value) { errEl.textContent = 'Please enter a key.'; return; }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Checking…';

  if (mode === 'setup') {
    await saveEditKey(value);
    setEditor(true);
    closeAuthModal();
    renderEditKeyBtn();
    render();
  } else {
    const ok = await verifyEditKey(value);
    if (ok) {
      setEditor(true);
      sessionStorage.removeItem(SESSION_FAILS);
      closeAuthModal();
      renderEditKeyBtn();
      render();
    } else {
      const fails = incFailCount();
      if (fails >= MAX_ATTEMPTS) {
        lockOut();
        errEl.textContent = 'Too many failed attempts. You are locked out.';
        saveBtn.style.display = 'none';
        input.disabled = true;
      } else {
        const rem = MAX_ATTEMPTS - fails;
        errEl.textContent = `Incorrect key. ${rem} attempt${rem !== 1 ? 's' : ''} remaining.`;
        document.getElementById('authHint').textContent = `${rem} attempt${rem !== 1 ? 's' : ''} remaining.`;
      }
    }
  }

  saveBtn.disabled    = false;
  saveBtn.textContent = mode === 'setup' ? 'Set Key' : 'Unlock';
}

/* ==============================
   EDIT KEY BUTTON (header)
   ============================== */
function renderEditKeyBtn() {
  const btn = document.getElementById('editKeyBtn');
  if (!btn) return;

  if (isEditor) {
    btn.textContent = '🔓 Editor Mode';
    btn.classList.remove('btn-outline');
    btn.classList.add('btn-accent-dim');
    btn.title = 'Click to lock / sign out of editor mode';
  } else {
    btn.textContent = '🔑 Edit Key';
    btn.classList.add('btn-outline');
    btn.classList.remove('btn-accent-dim');
    btn.title = 'Enter edit key to enable editing';
  }
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
  } catch { return null; }
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

  [...main.children].forEach(c => { if (c !== empty) c.remove(); });

  document.getElementById('emptyActionsEditor').style.display  = isEditor ? 'flex' : 'none';
  document.getElementById('emptyActionsViewer').style.display  = isEditor ? 'none' : 'flex';

  document.getElementById('addSectionBtn').style.display  = isEditor ? '' : 'none';
  document.getElementById('addGroupBtn').style.display    = isEditor ? '' : 'none';
  document.getElementById('addResourceBtn').style.display = isEditor ? '' : 'none';

  if (sections.length === 0 && !query) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  if (sections.length === 0) return;

  let totalVisible = 0;

  sections.forEach(sec => {
    const secResources = resources.filter(r => r.sectionId === sec.id);
    const secGroups    = groups.filter(g => g.sectionId === sec.id)
                               .sort((a, b) => (a.order || 0) - (b.order || 0));

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

    const sectionActions = isEditor ? `
      <div class="section-actions">
        <button class="btn btn-sm btn-outline add-res-to-sec" data-section-id="${sec.id}">+ Resource</button>
        <button class="btn-icon rename-sec" data-section-id="${sec.id}" title="Rename section">✎</button>
        <button class="btn-icon delete-sec" data-section-id="${sec.id}" title="Delete section">✕</button>
      </div>` : '';

    block.innerHTML = `
      <div class="section-header">
        <span class="section-name" data-section-id="${sec.id}" title="${isEditor ? 'Click to rename' : ''}">${esc(sec.name)}</span>
        <span class="section-count">${filtered.length}</span>
        ${sectionActions}
      </div>
      <div class="section-content" id="content-${sec.id}"></div>
    `;

    const contentEl = block.querySelector(`#content-${sec.id}`);

    const validGroupIds = new Set(secGroups.map(g => g.id));

    // Ungrouped resources
    const ungrouped = filtered
      .filter(r => !r.groupId || !validGroupIds.has(r.groupId))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (filtered.length === 0 && secGroups.length === 0) {
      contentEl.innerHTML = `<p class="section-empty">No resources yet. Add one above.</p>`;
    } else {
      // Ungrouped grid
      if (ungrouped.length > 0 || !query) {
        const ungroupedGrid = document.createElement('div');
        ungroupedGrid.className = 'resource-grid';
        ungroupedGrid.dataset.sectionId = sec.id;
        ungroupedGrid.dataset.groupId   = '';
        ungroupedGrid.id = `grid-${sec.id}`;

        if (ungrouped.length === 0 && isEditor && !query) {
          ungroupedGrid.innerHTML = `<p class="section-empty">No ungrouped resources.</p>`;
        } else {
          ungrouped.forEach((r, i) => ungroupedGrid.appendChild(buildCard(r, i)));
        }
        contentEl.appendChild(ungroupedGrid);
      }

      // Groups — compact iOS-style
      secGroups.forEach(grp => {
        const grpResources = filtered
          .filter(r => r.groupId === grp.id)
          .sort((a, b) => (a.order || 0) - (b.order || 0));

        // In search mode, skip groups with no matching resources
        if (query && grpResources.length === 0) return;

        const grpEl = document.createElement('div');
        grpEl.className = 'resource-group';
        grpEl.dataset.groupId   = grp.id;
        grpEl.dataset.sectionId = sec.id;

        const grpActions = isEditor ? `
          <div class="group-actions">
            <button class="btn-icon rename-group" data-group-id="${grp.id}" title="Rename group">✎</button>
            <button class="btn-icon delete-group" data-group-id="${grp.id}" title="Delete group">✕</button>
          </div>` : '';

        grpEl.innerHTML = `
          <div class="group-header">
            <button class="group-toggle-btn" data-group-id="${grp.id}" aria-label="Toggle group">
              <svg class="group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>
            </button>
            <span class="group-name">${esc(grp.name)}</span>
            <span class="group-count">${grpResources.length}</span>
            ${grpActions}
          </div>
          <div class="group-body" id="grpbody-${grp.id}"></div>
        `;

        const grpBody = grpEl.querySelector(`#grpbody-${grp.id}`);
        const grpGrid = document.createElement('div');
        grpGrid.className = 'resource-grid group-grid';
        grpGrid.dataset.sectionId = sec.id;
        grpGrid.dataset.groupId   = grp.id;
        grpGrid.id = `grid-${grp.id}`;

        if (grpResources.length === 0 && isEditor) {
          grpGrid.innerHTML = `<p class="section-empty" style="padding:12px 0 4px;">No resources in this group yet.</p>`;
        } else {
          grpResources.forEach((r, i) => grpGrid.appendChild(buildCard(r, i)));
        }
        grpBody.appendChild(grpGrid);
        contentEl.appendChild(grpEl);
      });
    }

    // Wire up drag-and-drop on all grids (only within section, no cross-grid)
    if (isEditor && !query) {
      block.querySelectorAll('.resource-grid').forEach(grid => setupGridDrop(grid));
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

  const menuBtn = isEditor
    ? `<button class="card-menu-btn" data-resource-id="${r.id}" title="Options">⋯</button>`
    : '';

  const dragHandle = isEditor
    ? `<span class="drag-handle" title="Drag to reorder">⠿</span>`
    : '';

  card.innerHTML = `
    ${dragHandle}
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
    ${menuBtn ? `<div class="card-footer">${menuBtn}</div>` : ''}
  `;

  if (isEditor) {
    const handle = card.querySelector('.drag-handle');
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      startCardDrag(e, card, r.id);
    });
  }

  return card;
}

/* ==============================
   POINTER-BASED DRAG & DROP
   ============================== */
let _dragCard      = null;   // the ghost element
let _dragSrcCard   = null;   // the original card (kept as placeholder)
let _dragResId     = null;   // resource id being dragged
let _dragGrid      = null;   // grid the drag started in
let _dragOffX      = 0;
let _dragOffY      = 0;

function startCardDrag(e, card, resourceId) {
  _dragResId   = resourceId;
  _dragGrid    = card.closest('.resource-grid');
  _dragSrcCard = card;

  const rect = card.getBoundingClientRect();
  _dragOffX = e.clientX - rect.left;
  _dragOffY = e.clientY - rect.top;

  // Ghost
  _dragCard = card.cloneNode(true);
  _dragCard.classList.add('drag-ghost');
  _dragCard.style.width  = rect.width  + 'px';
  _dragCard.style.height = rect.height + 'px';
  _dragCard.style.left   = rect.left   + 'px';
  _dragCard.style.top    = rect.top    + 'px';
  document.body.appendChild(_dragCard);

  // Placeholder appearance
  card.classList.add('drag-placeholder');

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup',   onPointerUp, { once: true });
}

function onPointerMove(e) {
  if (!_dragCard) return;
  _dragCard.style.left = (e.clientX - _dragOffX) + 'px';
  _dragCard.style.top  = (e.clientY - _dragOffY) + 'px';

  // Hide ghost temporarily to find element underneath
  _dragCard.style.pointerEvents = 'none';
  const below = document.elementFromPoint(e.clientX, e.clientY);
  _dragCard.style.pointerEvents = '';

  if (!below) return;

  // Only allow reordering within the same grid
  const targetCard = below.closest('.resource-card');
  if (targetCard && targetCard !== _dragSrcCard && targetCard.closest('.resource-grid') === _dragGrid) {
    const box = targetCard.getBoundingClientRect();
    const isAfter = e.clientY > box.top + box.height / 2;
    if (isAfter) {
      _dragGrid.insertBefore(_dragSrcCard, targetCard.nextSibling);
    } else {
      _dragGrid.insertBefore(_dragSrcCard, targetCard);
    }
  }
}

async function onPointerUp() {
  document.removeEventListener('pointermove', onPointerMove);

  if (_dragCard) {
    _dragCard.remove();
    _dragCard = null;
  }
  if (_dragSrcCard) {
    _dragSrcCard.classList.remove('drag-placeholder');
  }

  if (!_dragResId || !_dragGrid) {
    _dragResId = _dragSrcCard = _dragGrid = null;
    return;
  }

  // Collect new order from DOM
  const cards   = [..._dragGrid.querySelectorAll('.resource-card[data-resource-id]')];
  const updates = cards.map((c, idx) => ({ id: c.dataset.resourceId, order: idx }));

  await saveResourceOrder(updates);

  _dragResId = _dragSrcCard = _dragGrid = null;
}

/* ==============================
   DRAG & DROP: GRID SETUP (just prevents default for pointer compat)
   ============================== */
function setupGridDrop(grid) {
  // Nothing extra needed — pointer events handle everything above.
  // Keeping this function in case future cross-grid drops are added.
}

async function saveResourceOrder(updates) {
  if (!isEditor) return;
  const { doc, writeBatch: wb } = window._fs;
  const batch = wb(db);
  for (const u of updates) {
    batch.update(doc(db, COL_RESOURCES, u.id), { order: u.order });
  }
  await batch.commit();
}

/* ==============================
   SECTIONS (Firestore)
   ============================== */
async function addSection(name) {
  if (!isEditor) return;
  const { collection, addDoc } = window._fs;
  await addDoc(collection(db, COL_SECTIONS), {
    name: name.trim(),
    order: sections.length,
    createdAt: Date.now()
  });
}

async function renameSection(id, name) {
  if (!isEditor) return;
  const { doc, updateDoc } = window._fs;
  await updateDoc(doc(db, COL_SECTIONS, id), { name: name.trim() });
}

async function deleteSection(id) {
  if (!isEditor) return;
  if (!confirm('Delete this section and all its resources?')) return;
  const { doc, deleteDoc, collection, getDocs, query: fsQuery, where } = window._fs;

  // Delete all resources in this section
  const resSnap = await getDocs(
    fsQuery(collection(db, COL_RESOURCES), where('sectionId', '==', id))
  );
  await Promise.all(resSnap.docs.map(d => deleteDoc(doc(db, COL_RESOURCES, d.id))));

  // Delete all groups in this section
  const grpSnap = await getDocs(
    fsQuery(collection(db, COL_GROUPS), where('sectionId', '==', id))
  );
  await Promise.all(grpSnap.docs.map(d => deleteDoc(doc(db, COL_GROUPS, d.id))));

  await deleteDoc(doc(db, COL_SECTIONS, id));
}

/* ==============================
   GROUPS (Firestore)
   ============================== */
async function addGroup(sectionId, name) {
  if (!isEditor) return;
  const { collection, addDoc } = window._fs;
  const secGroups = groups.filter(g => g.sectionId === sectionId);
  await addDoc(collection(db, COL_GROUPS), {
    sectionId,
    name: name.trim(),
    order: secGroups.length,
    createdAt: Date.now()
  });
}

async function renameGroup(id, name) {
  if (!isEditor) return;
  const { doc, updateDoc } = window._fs;
  await updateDoc(doc(db, COL_GROUPS, id), { name: name.trim() });
}

async function deleteGroup(id) {
  if (!isEditor) return;
  if (!confirm('Delete this group? Resources inside will be moved to ungrouped.')) return;
  const { doc, deleteDoc, updateDoc, collection, getDocs, query: fsQuery, where } = window._fs;

  // Ungroup resources
  const resSnap = await getDocs(
    fsQuery(collection(db, COL_RESOURCES), where('groupId', '==', id))
  );
  await Promise.all(resSnap.docs.map(d => updateDoc(doc(db, COL_RESOURCES, d.id), { groupId: '' })));

  await deleteDoc(doc(db, COL_GROUPS, id));
}

/* ==============================
   RESOURCES (Firestore)
   ============================== */
async function addResource(data) {
  if (!isEditor) return;
  const { collection, addDoc } = window._fs;
  const secResources = resources.filter(r => r.sectionId === data.sectionId);
  await addDoc(collection(db, COL_RESOURCES), {
    sectionId: data.sectionId,
    groupId:   data.groupId   || '',
    name: data.name.trim(),
    url:  data.url.trim(),
    desc: data.desc ? data.desc.trim() : '',
    tags: data.tags ? data.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    order: secResources.length,
    createdAt: Date.now()
  });
}

async function updateResource(id, data) {
  if (!isEditor) return;
  const { doc, updateDoc } = window._fs;
  await updateDoc(doc(db, COL_RESOURCES, id), {
    sectionId: data.sectionId,
    name: data.name.trim(),
    url:  data.url.trim(),
    desc: data.desc ? data.desc.trim() : '',
    tags: data.tags ? data.tags.split(',').map(t => t.trim()).filter(Boolean) : []
  });
}

async function deleteResource(id) {
  if (!isEditor) return;
  if (!confirm('Delete this resource?')) return;
  const { doc, deleteDoc } = window._fs;
  await deleteDoc(doc(db, COL_RESOURCES, id));
}

async function moveOrCopyResource(resourceId, targetSectionId, action) {
  if (!isEditor) return;
  const { doc, updateDoc, addDoc, collection } = window._fs;
  const r = resources.find(r => r.id === resourceId);
  if (!r) return;

  if (action === 'move') {
    await updateDoc(doc(db, COL_RESOURCES, resourceId), { sectionId: targetSectionId });
  } else {
    const { id: _id, ...rest } = r;
    await addDoc(collection(db, COL_RESOURCES), { ...rest, sectionId: targetSectionId, createdAt: Date.now() });
  }
}

/* ==============================
   MODAL HELPERS
   ============================== */
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function populateSectionSelect(selectId, excludeId = null) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = '';
  sections.forEach(sec => {
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
  if (!isEditor) return;
  const titleEl = document.getElementById('resourceModalTitle');
  const nameEl  = document.getElementById('resName');
  const urlEl   = document.getElementById('resUrl');
  const descEl  = document.getElementById('resDesc');
  const tagsEl  = document.getElementById('resTags');
  const secSel  = document.getElementById('resSection');

  editingResourceId = resourceId;
  populateSectionSelect('resSection');

  if (resourceId) {
    const r = resources.find(r => r.id === resourceId);
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
  if (!isEditor) return;
  const titleEl = document.getElementById('sectionModalTitle');
  const nameEl  = document.getElementById('secName');
  editingSectionId = sectionId;

  if (sectionId) {
    const sec = sections.find(s => s.id === sectionId);
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
   OPEN GROUP MODAL
   ============================== */
function openGroupModal(sectionId = null, groupId = null) {
  if (!isEditor) return;
  const titleEl  = document.getElementById('groupModalTitle');
  const nameEl   = document.getElementById('grpName');
  const secSel   = document.getElementById('grpSection');
  const saveBtn  = document.getElementById('saveGroupBtn');
  editingGroupId = groupId;

  // Populate section dropdown
  secSel.innerHTML = '';
  sections.forEach(sec => {
    const opt = document.createElement('option');
    opt.value = sec.id;
    opt.textContent = sec.name;
    secSel.appendChild(opt);
  });
  if (sectionId) secSel.value = sectionId;

  // When renaming a group, lock the section selector and prefill name
  if (groupId) {
    const grp = groups.find(g => g.id === groupId);
    titleEl.textContent = 'Rename Group';
    nameEl.value = grp ? grp.name : '';
    secSel.disabled = true;
    secSel.value = grp ? grp.sectionId : (sectionId || '');
  } else {
    titleEl.textContent = 'Add Group';
    nameEl.value = '';
    secSel.disabled = false;
  }

  saveBtn.dataset.sectionId = '';  // read from select at save time

  openModal('groupModal');
  setTimeout(() => nameEl.focus(), 50);
}

/* ==============================
   OPEN MOVE MODAL
   ============================== */
function openMoveModal(resourceId) {
  if (!isEditor) return;
  const r = resources.find(r => r.id === resourceId);
  if (!r) return;
  contextResourceId = resourceId;

  document.getElementById('moveResourceName').textContent = `"${r.name}"`;
  populateSectionSelect('moveTarget', null);
  const otherSec = sections.find(s => s.id !== r.sectionId);
  if (otherSec) document.getElementById('moveTarget').value = otherSec.id;

  document.querySelector('input[name="moveAction"][value="move"]').checked = true;
  openModal('moveModal');
}

/* ==============================
   OPEN ASSIGN GROUP MODAL
   ============================== */
function openAssignGroupModal(resourceId) {
  if (!isEditor) return;
  const r = resources.find(r => r.id === resourceId);
  if (!r) return;
  contextResourceId = resourceId;

  document.getElementById('assignGroupResourceName').textContent = `"${r.name}"`;

  const sel = document.getElementById('assignGroupSelect');
  sel.innerHTML = '';

  // "No group" option
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '— No group (ungrouped) —';
  sel.appendChild(noneOpt);

  // Groups in the same section
  const secGroups = groups.filter(g => g.sectionId === r.sectionId)
                          .sort((a,b) => (a.order||0) - (b.order||0));
  secGroups.forEach(grp => {
    const opt = document.createElement('option');
    opt.value = grp.id;
    opt.textContent = grp.name;
    sel.appendChild(opt);
  });

  sel.value = r.groupId || '';
  openModal('assignGroupModal');
}

document.getElementById('confirmAssignGroupBtn').addEventListener('click', async () => {
  if (!isEditor) return;
  const newGroupId = document.getElementById('assignGroupSelect').value;
  const { doc, updateDoc } = window._fs;
  await updateDoc(doc(db, COL_RESOURCES, contextResourceId), { groupId: newGroupId });
  closeModal('assignGroupModal');
});

/* ==============================
   CONTEXT MENU
   ============================== */
function openContextMenu(resourceId, x, y) {
  if (!isEditor) return;
  contextResourceId = resourceId;
  const r = resources.find(r => r.id === resourceId);
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

  // Edit Key button
  if (e.target.id === 'editKeyBtn') {
    if (isEditor) {
      // Lock / sign out
      setEditor(false);
      sessionStorage.removeItem(SESSION_FAILS);
      renderEditKeyBtn();
      render();
    } else {
      handleAuthFlow();
    }
    return;
  }

  if (e.target.id === 'authSaveBtn') { handleAuthSave(); return; }

  if (e.target.id === 'addSectionBtn' || e.target.id === 'emptyAddSectionBtn') {
    if (!isEditor) return;
    openSectionModal(); return;
  }

  if (e.target.id === 'addGroupBtn') {
    if (!isEditor) return;
    if (sections.length === 0) { alert('Please add a section first.'); return; }
    openGroupModal(); return;
  }

  if (e.target.id === 'addResourceBtn' || e.target.id === 'emptyAddResourceBtn') {
    if (!isEditor) return;
    if (sections.length === 0) { alert('Please add a section first.'); openSectionModal(); return; }
    openResourceModal(); return;
  }

  const addToSec = e.target.closest('.add-res-to-sec');
  if (addToSec && isEditor) { openResourceModal(null, addToSec.dataset.sectionId); return; }

  const addGroupToSec = e.target.closest('.add-group-to-sec');
  if (addGroupToSec && isEditor) { openGroupModal(addGroupToSec.dataset.sectionId); return; }

  const renameSec = e.target.closest('.rename-sec');
  if (renameSec && isEditor) { openSectionModal(renameSec.dataset.sectionId); return; }

  const deleteSec = e.target.closest('.delete-sec');
  if (deleteSec && isEditor) { deleteSection(deleteSec.dataset.sectionId); return; }

  const renameGrp = e.target.closest('.rename-group');
  if (renameGrp && isEditor) {
    const grp = groups.find(g => g.id === renameGrp.dataset.groupId);
    openGroupModal(grp ? grp.sectionId : null, renameGrp.dataset.groupId); return;
  }

  const deleteGrp = e.target.closest('.delete-group');
  if (deleteGrp && isEditor) { deleteGroup(deleteGrp.dataset.groupId); return; }

  // Group toggle collapse/expand
  const grpToggle = e.target.closest('.group-toggle-btn');
  if (grpToggle) {
    const grpEl   = grpToggle.closest('.resource-group');
    const grpBody = grpEl.querySelector('.group-body');
    const chevron = grpToggle.querySelector('.group-chevron');
    const collapsed = grpEl.classList.toggle('collapsed');
    if (chevron) chevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
    grpBody.style.display = collapsed ? 'none' : '';
    return;
  }

  const secName = e.target.closest('.section-name');
  if (secName && isEditor && !e.target.closest('.section-actions')) {
    startInlineRename(secName); return;
  }

  const menuBtn = e.target.closest('.card-menu-btn');
  if (menuBtn && isEditor) {
    e.preventDefault();
    e.stopPropagation();
    const rect = menuBtn.getBoundingClientRect();
    openContextMenu(menuBtn.dataset.resourceId, rect.left, rect.bottom + 6);
    return;
  }

  if (e.target.id === 'ctxEdit'  && isEditor) { closeContextMenu(); openResourceModal(contextResourceId); return; }
  if (e.target.id === 'ctxAssignGroup' && isEditor) {
    closeContextMenu();
    openAssignGroupModal(contextResourceId); return;
  }
  if (e.target.id === 'ctxMove'  && isEditor) {
    closeContextMenu();
    if (sections.length < 2) { alert('You need at least 2 sections to move resources.'); return; }
    openMoveModal(contextResourceId); return;
  }
  if (e.target.id === 'ctxDelete' && isEditor) { closeContextMenu(); deleteResource(contextResourceId); return; }
});

/* ==============================
   AUTH FLOW (check if key exists first)
   ============================== */
async function handleAuthFlow() {
  const keyDoc = await getEditKeyDoc();
  openAuthModal(!keyDoc);
}

/* ==============================
   INLINE SECTION RENAME
   ============================== */
function startInlineRename(el) {
  if (!isEditor) return;
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
document.getElementById('saveResourceBtn').addEventListener('click', async () => {
  if (!isEditor) return;
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

  const btn = document.getElementById('saveResourceBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  if (editingResourceId) await updateResource(editingResourceId, data);
  else await addResource(data);

  btn.disabled = false; btn.textContent = 'Save Resource';
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
document.getElementById('saveSectionBtn').addEventListener('click', async () => {
  if (!isEditor) return;
  const name = document.getElementById('secName').value.trim();
  if (!name) { document.getElementById('secName').focus(); return; }

  const btn = document.getElementById('saveSectionBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  if (editingSectionId) await renameSection(editingSectionId, name);
  else await addSection(name);

  btn.disabled = false; btn.textContent = 'Save Section';
  closeModal('sectionModal');
});

document.getElementById('secName').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('saveSectionBtn').click();
});

/* ==============================
   SAVE GROUP
   ============================== */
document.getElementById('saveGroupBtn').addEventListener('click', async () => {
  if (!isEditor) return;
  const name      = document.getElementById('grpName').value.trim();
  const sectionId = document.getElementById('grpSection').value;
  if (!name) { document.getElementById('grpName').focus(); return; }
  if (!sectionId && !editingGroupId) { alert('Please select a section.'); return; }

  const btn = document.getElementById('saveGroupBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  if (editingGroupId) await renameGroup(editingGroupId, name);
  else await addGroup(sectionId, name);

  btn.disabled = false; btn.textContent = 'Save Group';
  closeModal('groupModal');
});

document.getElementById('grpName').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('saveGroupBtn').click();
});

/* ==============================
   CONFIRM MOVE / COPY
   ============================== */
document.getElementById('confirmMoveBtn').addEventListener('click', async () => {
  if (!isEditor) return;
  const targetSectionId = document.getElementById('moveTarget').value;
  const action = document.querySelector('input[name="moveAction"]:checked').value;
  if (!targetSectionId) return;
  await moveOrCopyResource(contextResourceId, targetSectionId, action);
  closeModal('moveModal');
});

/* ==============================
   AUTH MODAL: Enter key
   ============================== */
document.getElementById('authKeyInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('authSaveBtn').click();
});

/* ==============================
   KEYBOARD SHORTCUTS
   ============================== */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeContextMenu();
    ['resourceModal', 'sectionModal', 'groupModal', 'assignGroupModal', 'moveModal', 'authModal'].forEach(id => {
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
   LOADING OVERLAY
   ============================== */
function showLoading() {
  document.getElementById('loadingOverlay').style.display = 'flex';
}
function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
}

/* ==============================
   INIT
   ============================== */
async function init() {
  loadTheme();
  loadAuthState();

  showLoading();

  try {
    await initFirebase();
    await loadData();
    subscribeRealtime();
  } catch (err) {
    console.error('Firebase init error:', err);
    document.getElementById('loadingOverlay').innerHTML =
      `<div style="color:var(--danger);text-align:center;padding:20px;">
        <p style="font-size:1.2rem;font-weight:700;">⚠ Firebase connection failed</p>
        <p style="color:var(--text-muted);margin-top:8px;font-size:14px;">${err.message}</p>
        <p style="color:var(--text-dim);margin-top:8px;font-size:13px;">Check your FIREBASE_CONFIG in app.js</p>
      </div>`;
    return;
  }

  hideLoading();
  renderEditKeyBtn();
  render();
}

init();