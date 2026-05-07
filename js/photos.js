// ════════════════════════════════════════════════════════════════════
// MOTU Vault — photos.js
// ────────────────────────────────────────────────────────────────────
// OPFS + localStorage fallback photo system, photo handlers
// (camera/file/clear/zoom/copy-assignment), and JPEG compression.
// ════════════════════════════════════════════════════════════════════

import {
  S, store, ICO, icon, IMG,
  esc, _clone, isSelecting,
} from './state.js';
import { render, toast, haptic, appConfirm, patchDetailStatus, renderDetail } from './render.js';
import { doImport, importJSON, figById } from './data.js';
import { pushNav } from './handlers.js';

// § PHOTO-STORAGE ── OPFS + localStorage fallback, photoStore API ──
// Per figure: up to MAX_PHOTOS photos, each with optional label.
// OPFS filename: photo-{figId}-{n}.jpg  (n = 0..MAX_PHOTOS-1)
// Labels stored separately in localStorage: { [figId]: { [n]: label } }
// Per-copy photo assignment (v4.46+): { [figId]: { [n]: copyId } }
// A photo with no entry here is "shared" — visible from any copy view.
const MAX_PHOTOS = 8;
const PHOTO_LABELS_KEY = 'motu-photo-labels';
const PHOTO_COPY_KEY = 'motu-photo-copy';
const photoURLs = {};   // { "figId-n": objectURL }
let _opfsDir = null;
let _opfsReady = false;
let _photoLabels = {};  // { [figId]: { [n]: label } }
let _photoCopy = {};    // { [figId]: { [n]: copyId } } — n's copy assignment

async function initOPFS() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    _opfsDir = await navigator.storage.getDirectory();
    _opfsReady = true;
    return true;
  } catch { return false; }
}

function loadPhotoLabels() {
  try { _photoLabels = JSON.parse(localStorage.getItem(PHOTO_LABELS_KEY) || '{}'); } catch { _photoLabels = {}; }
}
function savePhotoLabels() {
  try { localStorage.setItem(PHOTO_LABELS_KEY, JSON.stringify(_photoLabels)); } catch {}
}
function loadPhotoCopyMap() {
  try { _photoCopy = JSON.parse(localStorage.getItem(PHOTO_COPY_KEY) || '{}'); } catch { _photoCopy = {}; }
}
function savePhotoCopyMap() {
  try { localStorage.setItem(PHOTO_COPY_KEY, JSON.stringify(_photoCopy)); } catch {}
}
// Returns the copyId a photo is assigned to (null/undefined if shared).
function photoCopyOf(figId, n) {
  return _photoCopy[figId]?.[n];
}
// Set or clear a photo's copy assignment.
function setPhotoCopy(figId, n, copyId) {
  if (copyId == null) {
    if (_photoCopy[figId]) {
      delete _photoCopy[figId][n];
      if (!Object.keys(_photoCopy[figId]).length) delete _photoCopy[figId];
    }
  } else {
    if (!_photoCopy[figId]) _photoCopy[figId] = {};
    _photoCopy[figId][n] = copyId;
  }
  savePhotoCopyMap();
}

// v6.26: public accessors for the module-private _photoCopy map.
// Previously data.js (exportJSON / importJSON) reached into _photoCopy directly,
// which silently produced a ReferenceError because _photoCopy is module-scoped
// here and was never imported. Result: backups did not include per-copy photo
// assignments and import failed at the photoCopy step. These accessors keep
// the storage encapsulated while letting the import/export layer do its job.
function getPhotoCopyMap() { return _photoCopy; }
function replacePhotoCopyMap(m) {
  _photoCopy = (m && typeof m === 'object') ? m : {};
  savePhotoCopyMap();
}
function mergePhotoCopyMap(incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  // Skip sentinel keys to avoid prototype manipulation via crafted backup files.
  const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
  for (const figId of Object.keys(incoming)) {
    if (RESERVED.has(figId)) continue;
    _photoCopy[figId] = {...(_photoCopy[figId] || {}), ...incoming[figId]};
  }
  savePhotoCopyMap();
}

const photoStore = {
  // Sync: get primary (first) photo URL for a figure — used in list/grid thumbnails
  // Sync: get primary photo URL for list/grid thumbnails
  // Returns null if default is stock image (n=-1) so renderer falls through to f.image
  get: id => {
    const defN = S.defaultPhoto?.[id];
    if (defN === -1) return null;  // user chose stock as default
    const arr = S.customPhotos[id];
    if (!arr || !arr.length) return null;
    const targetN = defN != null ? defN : arr[0].n;
    return photoURLs[id + '-' + targetN] || photoURLs[id + '-' + arr[0].n] || null;
  },

  // Sync: get all photos for a figure — { url, label, n }[]
  getAll: id => {
    const arr = S.customPhotos[id] || [];
    return arr.map(({n, label}) => ({
      n, label: label || '',
      url: photoURLs[id + '-' + n] || null,
    })).filter(p => p.url);
  },

  // Sync: get photos belonging to a specific copy. Includes shared (unassigned)
  // photos when includeShared is true, so a single-copy figure sees everything.
  getForCopy: (id, copyId, includeShared = true) => {
    const arr = S.customPhotos[id] || [];
    return arr
      .filter(({n}) => {
        const owner = photoCopyOf(id, n);
        if (owner == null) return includeShared;
        return owner === copyId;
      })
      .map(({n, label}) => ({
        n, label: label || '',
        url: photoURLs[id + '-' + n] || null,
        copyId: photoCopyOf(id, n) ?? null,
      }))
      .filter(p => p.url);
  },

  // Async: add a new photo to a figure. Returns index (n) on success, -1 on failure.
  // Optional copyId associates the photo with a specific copy; null/undefined = shared.
  add: async (id, blob, label = '', copyId = null) => {
    try {
      const existing = S.customPhotos[id] || [];
      if (existing.length >= MAX_PHOTOS) return -1;
      // Find first free slot n
      const used = new Set(existing.map(p => p.n));
      let n = 0;
      while (used.has(n) && n < MAX_PHOTOS) n++;
      if (n >= MAX_PHOTOS) return -1;

      if (_opfsReady) {
        const fh = await _opfsDir.getFileHandle(`photo-${id}-${n}.jpg`, {create: true});
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
        const key = id + '-' + n;
        if (photoURLs[key]) URL.revokeObjectURL(photoURLs[key]);
        photoURLs[key] = URL.createObjectURL(blob);
      } else {
        // Fallback: localStorage base64
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
        });
        try { localStorage.setItem(`motu-photo-${id}-${n}`, dataUrl); }
        catch { return -1; }
        photoURLs[id + '-' + n] = dataUrl;
      }

      // Update state
      const arr = [...(S.customPhotos[id] || []), {n, label}];
      S.customPhotos[id] = arr;
      if (label) {
        if (!_photoLabels[id]) _photoLabels[id] = {};
        _photoLabels[id][n] = label;
        savePhotoLabels();
      }
      if (copyId != null) setPhotoCopy(id, n, copyId);
      return n;
    } catch { return -1; }
  },

  // Async: remove photo at index n for a figure
  remove: async (id, n) => {
    const key = id + '-' + n;
    if (photoURLs[key]) { URL.revokeObjectURL(photoURLs[key]); delete photoURLs[key]; }
    try {
      if (_opfsReady) await _opfsDir.removeEntry(`photo-${id}-${n}.jpg`);
    } catch {}
    try { localStorage.removeItem(`motu-photo-${id}-${n}`); } catch {}
    // Update state
    const arr = (S.customPhotos[id] || []).filter(p => p.n !== n);
    if (arr.length) S.customPhotos[id] = arr;
    else delete S.customPhotos[id];
    // Clean label
    if (_photoLabels[id]) {
      delete _photoLabels[id][n];
      if (!Object.keys(_photoLabels[id]).length) delete _photoLabels[id];
      savePhotoLabels();
    }
    // Clean copy assignment
    setPhotoCopy(id, n, null);
  },

  // Async: update label for photo n of figure id
  setLabel: async (id, n, label) => {
    if (!_photoLabels[id]) _photoLabels[id] = {};
    if (label) _photoLabels[id][n] = label;
    else delete _photoLabels[id][n];
    if (!Object.keys(_photoLabels[id]).length) delete _photoLabels[id];
    savePhotoLabels();
    const arr = S.customPhotos[id] || [];
    const idx = arr.findIndex(p => p.n === n);
    if (idx >= 0) arr[idx] = {...arr[idx], label};
  },

  // Delete all photos for a figure (used by clearPhoto legacy API)
  delAll: async id => {
    const arr = [...(S.customPhotos[id] || [])];
    for (const p of arr) await photoStore.remove(id, p.n);
  },

  // Load all photos into URL cache (called during init)
  loadAll: async () => {
    loadPhotoLabels();
    loadPhotoCopyMap();

    // Revoke any existing blob URLs before rebuilding to prevent leaks on double-call
    Object.entries(photoURLs).forEach(([, url]) => {
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
    });
    for (const k in photoURLs) delete photoURLs[k];
    S.customPhotos = {};

    // Parse filename: photo-{figId}-{n}.jpg
    // Note: figId itself may contain hyphens, so we must match -{digit}.jpg at the end
    const parsePhotoName = name => {
      if (!name.startsWith('photo-') || !name.endsWith('.jpg')) return null;
      const core = name.slice(6, -4);
      const m = core.match(/^(.+)-(\d+)$/);
      if (!m) return null;
      return {id: m[1], n: parseInt(m[2], 10)};
    };

    const buckets = {};  // { figId: [n, ...] }

    if (_opfsReady) {
      try {
        for await (const [name, handle] of _opfsDir) {
          if (handle.kind !== 'file') continue;
          const parsed = parsePhotoName(name);
          if (!parsed) continue;
          const file = await handle.getFile();
          photoURLs[parsed.id + '-' + parsed.n] = URL.createObjectURL(file);
          (buckets[parsed.id] = buckets[parsed.id] || []).push(parsed.n);
        }
      } catch(e) { console.error('OPFS loadAll error:', e); }
    }

    // Load localStorage fallback photos — guard against overwriting OPFS blob URLs
    try {
      const keys = Object.keys(localStorage).filter(k => /^motu-photo-.+-\d+$/.test(k));
      keys.forEach(k => {
        const core = k.slice('motu-photo-'.length);
        const m = core.match(/^(.+)-(\d+)$/);
        if (!m) return;
        const id = m[1], n = parseInt(m[2], 10);
        const cacheKey = id + '-' + n;
        if (photoURLs[cacheKey]) return; // OPFS already owns this slot
        photoURLs[cacheKey] = localStorage.getItem(k);
        (buckets[id] = buckets[id] || []).push(n);
      });
    } catch {}

    // Populate customPhotos from buckets, sorted by n
    Object.entries(buckets).forEach(([id, ns]) => {
      ns.sort((a, b) => a - b);
      S.customPhotos[id] = ns.map(n => ({n, label: _photoLabels[id]?.[n] || ''}));
    });
  },

  // One-time migration: rename photo-{figId}.jpg → photo-{figId}-0.jpg
  migrateToMulti: async () => {
    if (!_opfsReady) return 0;
    let migrated = 0;
    try {
      const toMigrate = [];
      for await (const [name, handle] of _opfsDir) {
        if (handle.kind !== 'file') continue;
        if (name.startsWith('photo-') && name.endsWith('.jpg')) {
          const core = name.slice(6, -4);
          // If core doesn't end with -digit, it's the old format
          if (!/-\d+$/.test(core)) toMigrate.push({name, id: core});
        }
      }
      for (const {name, id} of toMigrate) {
        try {
          const oldHandle = await _opfsDir.getFileHandle(name);
          const file = await oldHandle.getFile();
          const newHandle = await _opfsDir.getFileHandle(`photo-${id}-0.jpg`, {create: true});
          const writable = await newHandle.createWritable();
          await writable.write(await file.arrayBuffer());
          await writable.close();
          await _opfsDir.removeEntry(name);
          migrated++;
        } catch(e) { console.error('Migration failed for ' + name, e); }
      }
    } catch {}
    return migrated;
  },

  // Legacy migration: localStorage old single-photo format → OPFS multi-photo format
  migrateLegacyLS: async () => {
    if (!_opfsReady) return 0;
    let migrated = 0;
    try {
      // Old single-photo format: motu-photo-{figId}  (no trailing -digit)
      const keys = Object.keys(localStorage).filter(k =>
        k.startsWith('motu-photo-') && !/-\d+$/.test(k)
      );
      for (const k of keys) {
        const id = k.slice('motu-photo-'.length);
        const dataUrl = localStorage.getItem(k);
        if (!dataUrl) continue;
        try {
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          const fh = await _opfsDir.getFileHandle(`photo-${id}-0.jpg`, {create: true});
          const writable = await fh.createWritable();
          await writable.write(blob);
          await writable.close();
          photoURLs[id + '-0'] = URL.createObjectURL(blob);
          localStorage.removeItem(k);
          migrated++;
        } catch(e) { console.error('LS migration failed for ' + id, e); }
      }
    } catch {}
    return migrated;
  },

  // Export all photos for a figure as [{label, dataUrl}, ...] (for JSON backup)
  exportAllAsDataURLs: async id => {
    const arr = S.customPhotos[id] || [];
    const result = [];
    for (const {n, label} of arr) {
      const key = id + '-' + n;
      const url = photoURLs[key];
      if (!url) continue;
      try {
        let dataUrl;
        if (url.startsWith('data:')) dataUrl = url;
        else {
          // Object URL — need to fetch blob and read as data URL
          const res = await fetch(url);
          const blob = await res.blob();
          dataUrl = await new Promise((r, rj) => {
            const fr = new FileReader();
            fr.onload = () => r(fr.result);
            fr.onerror = rj;
            fr.readAsDataURL(blob);
          });
        }
        result.push({label: label || '', dataUrl});
      } catch {}
    }
    return result;
  },

  // Get all photos for a figure as raw blobs (for ZIP packaging).
  // Returns [{n, label, blob}, ...]
  getAllAsBlobs: async id => {
    const arr = S.customPhotos[id] || [];
    const result = [];
    for (const {n, label} of arr) {
      const key = id + '-' + n;
      const url = photoURLs[key];
      if (!url) continue;
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        result.push({n, label: label || '', blob});
      } catch {}
    }
    return result;
  },

  // Import photos for a figure from backup
  importPhotos: async (id, photos) => {
    let count = 0;
    for (const p of photos) {
      try {
        const res = await fetch(p.dataUrl);
        const blob = await res.blob();
        const n = await photoStore.add(id, blob, p.label || '');
        if (n >= 0) count++;
      } catch {}
    }
    return count;
  },
};

// § PHOTO-HANDLERS ── handlePhoto, removePhoto, openPhotoViewer, setDefaultPhoto, compressPhoto ──
async function compressPhoto(file) {
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = objUrl;
    });
    const MAX = 800;
    const scale = Math.min(1, MAX / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.75));
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}
window.handlePhoto = (input, figId) => {
  const file = input.files?.[0]; if (!file) return;
  if (file.size > 20000000) { toast('✗ Image too large (max 20MB)'); return; }
  const existing = S.customPhotos[figId] || [];
  if (existing.length >= MAX_PHOTOS) { toast(`✗ Max ${MAX_PHOTOS} photos — remove one first`); input.value = ''; return; }
  compressPhoto(file).then(async blob => {
    if (!blob) { toast('✗ Could not process image'); return; }
    const n = await photoStore.add(figId, blob, '');
    if (n < 0) { toast('✗ Storage full or photo limit reached'); return; }
    S.imgErrors[figId] = false;
    input.value = '';
    haptic && haptic();
    renderDetail();
  }).catch(() => { toast('✗ Could not read image file'); input.value = ''; });
};

window.removePhoto = async (id, n) => {
  if (!await appConfirm('Remove this photo?', {danger: true, ok: 'Remove'})) return;
  await photoStore.remove(id, n);
  haptic && haptic();
  renderDetail();
};

window.handleCopyPhoto = (input, figId, copyId) => {
  const file = input.files?.[0]; if (!file) return;
  if (file.size > 20000000) { toast('✗ Image too large (max 20MB)'); return; }
  const existing = S.customPhotos[figId] || [];
  if (existing.length >= MAX_PHOTOS) { toast(`✗ Max ${MAX_PHOTOS} photos — remove one first`); input.value = ''; return; }
  compressPhoto(file).then(async blob => {
    if (!blob) { toast('✗ Could not process image'); return; }
    const n = await photoStore.add(figId, blob, '', copyId);
    if (n < 0) { toast('✗ Storage full or photo limit reached'); return; }
    S.imgErrors[figId] = false;
    input.value = '';
    haptic && haptic();
    patchDetailStatus();
    renderDetail();
  }).catch(() => { toast('✗ Could not read image file'); input.value = ''; });
};

// Unlink a photo from its copy (makes it shared / visible from any copy view).
window.unlinkCopyPhoto = (figId, n) => {
  setPhotoCopy(figId, n, null);
  haptic && haptic();
  patchDetailStatus();
};

// Open a copy photo in the full-screen viewer (reuses existing photoViewer state).
window.openCopyPhoto = (figId, n) => {
  // Find the index in the full carousel for the viewer
  const all = photoStore.getAll(figId);
  const idx = all.findIndex(p => p.n === n);
  if (idx < 0) return;
  // photos[] is required — renderPhotoViewer + photoViewerNav both read from it.
  S.photoViewer = { figId, idx, photos: all };
  pushNav();
  renderDetail();
};

window.clearPhoto = async id => {
  if (!await appConfirm('Remove all photos for this figure?', {danger: true, ok: 'Remove all'})) return;
  await photoStore.delAll(id);
  renderDetail();
};

window.setPhotoLabel = async (id, n, label) => {
  await photoStore.setLabel(id, n, label.trim());
  renderDetail();
};

window.setDefaultPhoto = (id, n) => {
  if (S.defaultPhoto[id] === n) {
    delete S.defaultPhoto[id];
  } else {
    S.defaultPhoto[id] = n;
  }
  store.set('motu-default-photo', S.defaultPhoto);
  haptic && haptic();
  // Preserve carousel scroll position across re-render
  const carousel = document.getElementById('photoCarousel');
  const scrollPos = carousel ? carousel.scrollLeft : 0;
  renderDetail();
  const newCarousel = document.getElementById('photoCarousel');
  if (newCarousel && scrollPos) {
    newCarousel.scrollLeft = scrollPos;
  }
};

// Full-screen photo viewer
window.openPhotoViewer = (id, startN) => {
  const photos = photoStore.getAll(id);
  if (!photos.length) return;
  const startIdx = Math.max(0, photos.findIndex(p => p.n === startN));
  S.photoViewer = { figId: id, photos, idx: startIdx };
  pushNav();
  haptic && haptic();
  render();
  requestAnimationFrame(initPhotoViewerZoom);
};

// Opens viewer for any slide by carousel index — works for both user photos and stock image.
window.openSlideViewer = (figId, slideIdx) => {
  const fig = figById(figId);
  if (!fig) return;
  const userPhotos = photoStore.getAll(figId);
  const stockImg = (fig.image && !S.imgErrors[figId]) ? fig.image : null;
  const slides = [...userPhotos.map(p => ({...p, stock: false}))];
  if (stockImg) slides.push({n: -1, url: stockImg, label: fig.name, stock: true});
  if (!slides.length) return;
  const idx = Math.max(0, Math.min(slideIdx, slides.length - 1));
  S.photoViewer = { figId, photos: slides, idx };
  pushNav();
  haptic && haptic();
  render();
  requestAnimationFrame(initPhotoViewerZoom);
};
window.closePhotoViewer = () => { history.back(); };
window.photoViewerNav = dir => {
  if (!S.photoViewer) return;
  const len = S.photoViewer.photos.length;
  S.photoViewer.idx = (S.photoViewer.idx + dir + len) % len;
  render();
  requestAnimationFrame(initPhotoViewerZoom);
};

// Pinch-to-zoom and pan for photo viewer image.
// Uses CSS transform on the img-wrap element.
function initPhotoViewerZoom() {
  const wrap = document.querySelector('.photo-viewer-img-wrap');
  const img  = wrap?.querySelector('img');
  if (!wrap || !img) return;

  let scale = 1, tx = 0, ty = 0;
  let startDist = 0, startScale = 1;
  let startTx = 0, startTy = 0;
  let lastTap = 0;
  let panStart = null;

  const apply = () => {
    img.style.transform = `scale(${scale}) translate(${tx/scale}px,${ty/scale}px)`;
    img.style.transformOrigin = 'center center';
    img.style.cursor = scale > 1 ? 'grab' : 'default';
  };

  const clamp = () => {
    if (scale <= 1) { tx = 0; ty = 0; return; }
    const maxX = (img.offsetWidth  * (scale - 1)) / 2;
    const maxY = (img.offsetHeight * (scale - 1)) / 2;
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  };

  // Double-tap to zoom/reset
  img.addEventListener('click', e => {
    const now = Date.now();
    if (now - lastTap < 300) {
      scale = scale > 1 ? 1 : 2.5; tx = 0; ty = 0;
      img.style.transition = 'transform 0.25s ease';
      apply();
      setTimeout(() => img.style.transition = '', 260);
    }
    lastTap = now;
  });

  // Pinch
  // v6.27: track single-touch start so swipe-left/right (when not zoomed)
  // navigates between photos. Mirrors the chevron buttons on desktop.
  let _swipeStart = null;
  wrap.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      startScale = scale; startTx = tx; startTy = ty;
      _swipeStart = null;
    } else if (e.touches.length === 1 && scale > 1) {
      panStart = {x: e.touches[0].clientX - tx, y: e.touches[0].clientY - ty};
      _swipeStart = null;
    } else if (e.touches.length === 1) {
      _swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    }
  }, {passive: true});

  wrap.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      scale = Math.max(1, Math.min(5, startScale * (dist / startDist)));
      clamp(); apply();
      e.preventDefault();
    } else if (e.touches.length === 1 && panStart && scale > 1) {
      tx = e.touches[0].clientX - panStart.x;
      ty = e.touches[0].clientY - panStart.y;
      clamp(); apply();
      e.preventDefault();
    }
  }, {passive: false});

  wrap.addEventListener('touchend', e => {
    if (e.touches.length < 2 && scale < 1.05) { scale = 1; tx = 0; ty = 0; apply(); }
    panStart = null;
    // v6.27: detect a swipe — only when not zoomed, the gesture was fast,
    // mostly horizontal, and crossed a sane threshold. Navigates to prev/next.
    if (_swipeStart && scale === 1 && e.changedTouches.length) {
      const dx = e.changedTouches[0].clientX - _swipeStart.x;
      const dy = e.changedTouches[0].clientY - _swipeStart.y;
      const dt = Date.now() - _swipeStart.t;
      if (dt < 500 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (typeof window.photoViewerNav === 'function') {
          window.photoViewerNav(dx > 0 ? -1 : 1);
        }
      }
    }
    _swipeStart = null;
  }, {passive: true});
}

window.handleCSV = input => {
  const file = input.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const overwrite = document.querySelector('.checkbox.checked') !== null;
    const result = doImport(ev.target.result, overwrite);
    const body = document.querySelector('.sheet-body');
    if (body) {
      body.innerHTML = `<div style="text-align:center;padding:20px 0">
        <div style="font-size:48px;margin-bottom:12px">${result.matched>0?'✅':'🤷'}</div>
        <div class="font-display" style="font-size:22px;color:var(--gold);margin-bottom:4px">${result.matched} imported</div>
        ${result.skipped>0 ? `<div class="text-sm text-dim" style="margin-bottom:8px">${result.skipped} already owned, skipped</div>` : ''}
        ${result.unmatched.length>0 ? `<details style="text-align:left;margin-top:16px">
          <summary class="text-sm text-dim" style="cursor:pointer;padding:8px 0">${result.unmatched.length} not found in app</summary>
          <div style="margin-top:8px;max-height:160px;overflow-y:auto;font-size:12px;color:var(--t3);line-height:2">${result.unmatched.map(u=>'<div>'+esc(u)+'</div>').join('')}</div>
        </details>` : ''}
      </div>`;
    }
  };
  reader.readAsText(file);
};

// Drop zone support
document.addEventListener('dragover', e => {
  const dz = document.getElementById('dropZone');
  if (!dz) return;  // Don't interfere with unrelated drag operations
  e.preventDefault();
  dz.classList.add('dragover');
});
document.addEventListener('dragleave', () => {
  const dz = document.getElementById('dropZone');
  if (dz) dz.classList.remove('dragover');
});
document.addEventListener('drop', e => {
  const dz = document.getElementById('dropZone');
  if (!dz) return;
  e.preventDefault();
  dz.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (file.name.endsWith('.json')) {
    importJSON(file);
  } else {
    const r = new FileReader();
    r.onload = ev => {
      const overwrite = document.querySelector('.checkbox.checked') !== null;
      const result = doImport(ev.target.result, overwrite);
      const body = document.querySelector('.sheet-body');
      if (body) {
        body.innerHTML = `<div style="text-align:center;padding:20px 0">
          <div style="font-size:48px;margin-bottom:12px">${result.matched>0?'✅':'🤷'}</div>
          <div class="font-display" style="font-size:22px;color:var(--gold);margin-bottom:4px">${result.matched} imported</div>
        </div>`;
      }
    };
    r.readAsText(file);
  }
});

// ── Exports ─────────────────────────────────────────────────
export {
  MAX_PHOTOS, PHOTO_LABELS_KEY, PHOTO_COPY_KEY, photoURLs, photoStore, _opfsReady, initOPFS, loadPhotoLabels, savePhotoLabels, loadPhotoCopyMap, savePhotoCopyMap, photoCopyOf, setPhotoCopy, getPhotoCopyMap, replacePhotoCopyMap, mergePhotoCopyMap, compressPhoto, initPhotoViewerZoom
};
