// Witchgrid dashboard JS — Alpine.js components + small UX glue.
//
// Loaded by every page in dashboard/. Pre-paint theme application
// happens earlier via an inline script in <head> so the page never
// flashes the wrong palette.

// ── theme toggle ──────────────────────────────────────────────────
function themeToggle() {
  return {
    theme: 'dark',
    init() {
      const saved = (() => { try { return localStorage.getItem('witchgrid-theme'); } catch (e) { return null; } })();
      this.theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';
      document.documentElement.setAttribute('data-theme', this.theme);
    },
    toggle() {
      this.theme = (this.theme === 'dark') ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', this.theme);
      try { localStorage.setItem('witchgrid-theme', this.theme); } catch (e) {}
    },
  };
}

// ── /services POST form (Overview only) ───────────────────────────
function spawnForm() {
  return {
    profiles: {},
    profileName: '',
    model: '',
    advanced: false,
    node_id: '',
    port: '',
    gpus: '',
    message: '',
    isError: false,
    busy: false,

    async init() {
      try {
        // /api/profiles since v0.6 — the human-facing /profiles page
        // owns the URL root now.
        const r = await fetch('/api/profiles');
        this.profiles = await r.json();
      } catch (e) {
        this.message = 'could not load profiles: ' + e;
        this.isError = true;
      }
    },

    onProfileChange() {
      const p = this.profiles[this.profileName];
      if (!p) { this.model = ''; return; }
      if (p.model_alias) {
        this.model = '';
      } else if (p.default_model) {
        this.model = p.default_model;
      } else {
        this.model = '';
      }
    },

    async submit() {
      this.busy = true;
      this.message = '';
      const body = { profile: this.profileName };
      if (this.model) body.model = this.model;
      if (this.node_id) body.node_id = this.node_id;
      if (this.port)    body.port    = parseInt(this.port);
      if (this.gpus) {
        body.gpus = this.gpus.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      }
      try {
        const r = await fetch('/services', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        this.isError = !r.ok;
        if (r.ok) {
          this.message = 'spawned ' + d.id.slice(0, 8) + ' on ' + d.node_id + ' port ' + d.port;
        } else {
          this.message = d.error || ('HTTP ' + r.status);
        }
      } catch (e) {
        this.isError = true;
        this.message = 'request failed: ' + e;
      }
      this.busy = false;
    },
  };
}

// ── nav active highlight ──────────────────────────────────────────
// Matches the nav link whose href equals the current path, adds
// .active. Done in JS so the four page templates stay identical.
(function highlightNav() {
  document.addEventListener('DOMContentLoaded', () => {
    const here = window.location.pathname.replace(/\/+$/, '') || '/';
    document.querySelectorAll('.page-nav a').forEach(a => {
      const href = a.getAttribute('href').replace(/\/+$/, '') || '/';
      if (href === here) a.classList.add('active');
    });
  });
})();

// ── persist <details> open state ──────────────────────────────────
// Add data-detail-key="..." to any <details> you want remembered.
// State persists across HTMX swaps (so polling fragments don't
// re-collapse) and across page reloads (localStorage).
(function persistDetails() {
  const STORAGE = 'witchgrid-details-open';
  const load = () => {
    try { return JSON.parse(localStorage.getItem(STORAGE) || '{}'); }
    catch (e) { return {}; }
  };
  const save = (s) => {
    try { localStorage.setItem(STORAGE, JSON.stringify(s)); } catch (e) {}
  };

  const restore = (root) => {
    const state = load();
    (root || document).querySelectorAll('details[data-detail-key]').forEach(d => {
      if (state[d.dataset.detailKey]) d.open = true;
    });
  };

  document.addEventListener('DOMContentLoaded', () => restore());
  document.addEventListener('htmx:afterSwap', (e) => restore(e.detail.target));

  // Delegated toggle listener — handles details that arrive via
  // HTMX swap as well as those in the initial DOM.
  document.addEventListener('toggle', (e) => {
    if (e.target.tagName !== 'DETAILS') return;
    const key = e.target.dataset.detailKey;
    if (!key) return;
    const state = load();
    if (e.target.open) state[key] = true; else delete state[key];
    save(state);
  }, true);
})();
