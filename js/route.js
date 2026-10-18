// js/route.js — desktop routing for motu-vault.html.
// EXTERNAL FILE ON PURPOSE: the app page ships a strict CSP
// (script-src 'self', no 'unsafe-inline' — v7.00 hardening), which
// silently blocked this logic when it shipped inline in v7.53
// (user-reported: desktop Firefox/Edge landed on the app, no redirect,
// no error — CSP refusals don't surface to users). 'self' permits
// external same-origin scripts, so the hardening stays.
// v7.53: desktop visitors are routed to desktop.html; phones/tablets and
// installed apps stay here. Capability-based, not UA-sniffing-first:
// fine pointer + hover + a big screen = desktop. Guards, in order:
//   • ?m=1 — explicit "give me the full app on desktop"; remembered
//     (localStorage motu-prefer-full) so it's one-time. ?m=0 forgets it.
//   • display-mode standalone / navigator.standalone — an INSTALLED app
//     must never be redirected out from under its start_url.
//   • mobile UA or coarse pointer (covers iPads masquerading as Macs —
//     their pointer is coarse even when the UA says macOS) — stay.
// search + hash are preserved, so a #wl= share link opened on desktop
// lands on desktop.html's shared-list view, which is where it renders
// best anyway. desktop.html links back with ?m=1 and never auto-
// redirects, so no loop is possible.
(function () {
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('m') === '0') { localStorage.removeItem('motu-prefer-full'); }
    if (q.get('m') === '1') { try { localStorage.setItem('motu-prefer-full', '1'); } catch (e) {} return; }
    if (localStorage.getItem('motu-prefer-full') === '1') return;
    if (window.matchMedia && matchMedia('(display-mode: standalone)').matches) return;
    if (navigator.standalone === true) return;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;
    if (!(window.matchMedia && matchMedia('(pointer: fine)').matches && matchMedia('(hover: hover)').matches)) return;
    if (Math.min(screen.width, screen.height) < 700) return;
    location.replace('desktop.html' + location.search + location.hash);
  } catch (e) { /* any doubt → stay on the app */ }
})();

// ─── v8.03: boot safety net ───────────────────────────────────────────
// If startup fails before the first screen is drawn, the page used to stay
// black behind a generic toast — with no way to reach Backup. Two triggers:
//   • app.js calls window.__motuBootFail(err) when init() throws before its
//     first render (it sets window.__motuBooted once that render is done);
//   • a watchdog fires if nothing has booted 15 s after the page loads —
//     that covers a module that fails to download or parse, where app.js
//     never runs at all (and a very slow first load, hence the wording).
// The screen offers "Try again" and "Save my data": a backup-format JSON
// built straight from storage (no app modules needed) that Backup &
// Restore can import. Photos stay on the phone and aren't in that file.
// If the app does finish starting, its first render replaces this screen.
// Classic script, ES5, CSP-safe: listeners only, no inline handlers.
(function () {
  var shown = false;

  function lsGet(k) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function idbGetAll(keys) {
    return new Promise(function (resolve) {
      var out = {};
      var req;
      try { req = indexedDB.open('motu-vault', 1); } catch (e) { resolve(out); return; }
      // Same upgrade as js/idb-store.js, so opening a missing DB here can
      // never leave one behind without the store the app expects.
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onerror = req.onblocked = function () { resolve(out); };
      req.onsuccess = function () {
        var db = req.result, tx;
        try { tx = db.transaction('kv', 'readonly'); } catch (e) { db.close(); resolve(out); return; }
        var st = tx.objectStore('kv');
        keys.forEach(function (k) {
          var r = st.get(k);
          r.onsuccess = function () { if (r.result !== undefined) out[k] = r.result; };
        });
        tx.oncomplete = tx.onerror = tx.onabort = function () { db.close(); resolve(out); };
      };
    });
  }
  function saveData(btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    idbGetAll(['motu-c2', 'motu-line-packs']).then(function (idb) {
      var raw = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('motu-') !== 0 || k.indexOf('motu-photo-') === 0) continue;
        raw[k] = lsGet(k);
      }
      var journal = lsGet('motu-c2-journal');
      var coll = (journal && typeof journal === 'object' && Object.keys(journal).length) ? journal
        : (idb['motu-c2'] || lsGet('motu-c2') || {});
      var backup = {
        version: 'motu-vault-backup-v6',
        exported: new Date().toISOString(),
        emergency: true,
        collection: coll,
        photos: {},
        photoCopy: lsGet('motu-photo-copy') || {},
        overrides: lsGet('motu-overrides') || {},
        soldLog: lsGet('motu-sold-log') || [],
        customFigs: lsGet('motu-custom-figs') || [],
        linePacks: idb['motu-line-packs'] || lsGet('motu-line-packs') || {},
        localStorage: raw
      };
      var blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'motu-collector-rescue-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      btn.disabled = false;
      btn.textContent = 'Saved — check Downloads';
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Couldn’t save — try again';
    });
  }
  function show(err) {
    if (shown || window.__motuBooted) return;
    var app = document.getElementById('app');
    if (!app) return;
    shown = true;
    var msg = err && (err.message || String(err));
    app.innerHTML =
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:#11131a;color:#f8fafc;font-family:Outfit,system-ui,sans-serif">' +
        '<div style="max-width:360px;width:100%;text-align:center">' +
          '<div style="font-size:18px;font-weight:700;margin-bottom:8px">' +
            (err ? 'MOTU Collector couldn’t start' : 'MOTU Collector is taking a long time to start') + '</div>' +
          '<div style="font-size:14px;color:#94a3b8;line-height:1.5;margin-bottom:20px">Your collection is still saved on this phone. Try again, or save a copy of your data first — you can import it later from Menu → Backup &amp; Restore.</div>' +
          '<button id="bootRetry" style="width:100%;padding:14px;border-radius:12px;border:0;background:#a855f7;color:#fff;font-size:15px;font-weight:700;margin-bottom:10px">Try again</button>' +
          '<button id="bootSave" style="width:100%;padding:14px;border-radius:12px;border:1px solid #363c52;background:#1b1e28;color:#f8fafc;font-size:15px;font-weight:600">Save my data</button>' +
          (msg ? '<div id="bootErr" style="margin-top:16px;font-size:12px;color:#64748b;word-break:break-word"></div>' : '') +
        '</div>' +
      '</div>';
    if (msg) document.getElementById('bootErr').textContent = 'Details: ' + msg;
    document.getElementById('bootRetry').addEventListener('click', function () { location.reload(); });
    var save = document.getElementById('bootSave');
    save.addEventListener('click', function () { saveData(save); });
  }
  window.__motuBootFail = function (err) { show(err); };
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () { if (!window.__motuBooted) show(null); }, 15000);
  });
})();
