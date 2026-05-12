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

// ── profile editor (CRUD modal, Profiles page only) ──────────────
//
// Driven by buttons in the rendered profiles table:
//   onclick="openEditor()"            — new profile
//   onclick="openEditor('chat-mahou')" — edit existing
//   onclick="deleteProfile('name')"   — delete with confirm
//
// The component reads /api/profiles/{name} on edit so we get the
// canonical JSON shape; on save it PUTs (existing) or POSTs (new)
// and reloads the page so the rendered table refreshes (cheap;
// htmx-swap-on-event would be cleaner but we'd need a custom event
// dispatch which adds a moving part for one form).

function profileEditor() {
  return {
    open: false,
    isNew: true,
    name: '',
    binary: 'llama-server',
    default_port: 18080,
    context: 4096,
    kv_type: 'f16',
    model_alias: '',
    default_model: '',
    hf_repo: '',
    hf_file: '',
    extra_flags: '',
    intentRows: [{ k: '', v: '' }],
    error: '',
    busy: false,

    init() {
      // Listen for synthetic events fired by the in-table buttons.
      window.addEventListener('witchgrid:edit-profile', (e) => this.openFor(e.detail.name));
      window.addEventListener('witchgrid:new-profile',  ()  => this.openNew());
    },

    addIntent()        { this.intentRows.push({ k: '', v: '' }); },
    removeIntent(i)    { this.intentRows.splice(i, 1); if (this.intentRows.length === 0) this.intentRows.push({k:'',v:''}); },

    reset() {
      this.name = ''; this.binary = 'llama-server';
      this.default_port = 18080; this.context = 4096; this.kv_type = 'f16';
      this.model_alias = ''; this.default_model = '';
      this.hf_repo = ''; this.hf_file = '';
      this.extra_flags = '';
      this.intentRows = [{ k: '', v: '' }];
      this.error = '';
    },

    openNew() {
      this.reset();
      this.isNew = true;
      this.open = true;
    },

    async openFor(name) {
      this.reset();
      this.isNew = false;
      this.open = true;
      this.busy = true;
      try {
        const r = await fetch('/api/profiles/' + encodeURIComponent(name));
        if (!r.ok) { this.error = 'load failed: HTTP ' + r.status; this.busy = false; return; }
        const p = await r.json();
        this.name = name;
        this.binary = p.binary || 'llama-server';
        this.default_port = p.default_port || 18080;
        this.context = p.context || 4096;
        this.kv_type = p.kv_type || 'f16';
        this.model_alias = p.model_alias || '';
        this.default_model = p.default_model || '';
        if (p.hf_source) {
          this.hf_repo = p.hf_source.repo || '';
          this.hf_file = p.hf_source.file || '';
        }
        this.extra_flags = (p.extra_flags || []).join('\n');
        this.intentRows = Object.entries(p.intent || {}).map(([k, v]) => ({ k, v: String(v) }));
        if (this.intentRows.length === 0) this.intentRows.push({ k: '', v: '' });
      } catch (e) {
        this.error = 'load failed: ' + e;
      }
      this.busy = false;
    },

    cancel() { this.open = false; this.error = ''; },

    buildPayload() {
      const intent = {};
      for (const r of this.intentRows) {
        const k = (r.k || '').trim();
        if (!k) continue;
        const v = (r.v || '').trim();
        // Coerce to int / bool / string by shape — operators commonly type
        // 131072 / true / q4_0 and don't want to think about JSON quoting.
        if (v === 'true')        intent[k] = true;
        else if (v === 'false')  intent[k] = false;
        else if (/^-?\d+$/.test(v)) intent[k] = parseInt(v, 10);
        else                     intent[k] = v;
      }
      const profile = {
        binary: this.binary,
        intent,
        extra_flags: this.extra_flags.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
        default_port: parseInt(this.default_port, 10),
        context: parseInt(this.context, 10),
        kv_type: this.kv_type,
      };
      if (this.model_alias)   profile.model_alias = this.model_alias;
      if (this.default_model) profile.default_model = this.default_model;
      if (this.hf_repo && this.hf_file) {
        profile.hf_source = { repo: this.hf_repo, file: this.hf_file };
      }
      return profile;
    },

    async save() {
      this.busy = true; this.error = '';
      const profile = this.buildPayload();
      try {
        let r;
        if (this.isNew) {
          if (!this.name) { this.error = 'name required'; this.busy = false; return; }
          r = await fetch('/api/profiles', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: this.name, profile }),
          });
        } else {
          r = await fetch('/api/profiles/' + encodeURIComponent(this.name), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(profile),
          });
        }
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.error = d.error || ('HTTP ' + r.status);
          this.busy = false;
          return;
        }
        this.open = false;
        // Refresh the page so the rendered table picks up the new
        // version + any added/removed rows. HTMX-swap would be slicker
        // but reload's two lines and matches reload-after-spawn UX.
        window.location.reload();
      } catch (e) {
        this.error = 'save failed: ' + e;
        this.busy = false;
      }
    },
  };
}

async function deleteProfile(name) {
  if (!confirm('Delete profile "' + name + '"?')) return;
  const r = await fetch('/api/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert('Delete failed: ' + (d.error || ('HTTP ' + r.status)));
    return;
  }
  window.location.reload();
}

function editProfile(name) {
  window.dispatchEvent(new CustomEvent('witchgrid:edit-profile', { detail: { name } }));
}
function newProfile() {
  window.dispatchEvent(new CustomEvent('witchgrid:new-profile'));
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
