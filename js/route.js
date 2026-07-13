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
