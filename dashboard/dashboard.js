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

// Known witchgrid-level intents. Source of truth is agent/intent.hml's
// build_intents(); keep this list in sync when adding new entries.
// Each row describes the editor UX for that key:
//   kind: 'number' | 'kv_quant' | 'tri_bool' | 'text'
//   help: shown inline under the field, mirrors INTENTS[k].help server-side
const KNOWN_INTENTS = [
  { k: 'context',         kind: 'number',   help: 'Prompt+generation context window. Maps to -c / --ctx-size N.' },
  { k: 'kv_cache_k',      kind: 'kv_quant', help: 'Quantization for the K side of the KV cache.' },
  { k: 'kv_cache_v',      kind: 'kv_quant', help: 'Quantization for the V side of the KV cache.' },
  { k: 'parallel_slots',  kind: 'number',   help: 'Parallel decode slots. Set 1 for RP/chat models.' },
  { k: 'gpu_layers',      kind: 'number',   help: 'Layers to offload to GPU. 99 = all (llama.cpp clamps to model depth).' },
  { k: 'flash_attention', kind: 'tri_bool', help: 'FlashAttention. true → on, false → off, auto → llama.cpp decides.' },
  { k: 'host',            kind: 'text',     help: 'Bind address. Spawner overrides; here for completeness.' },
  { k: 'port',            kind: 'number',   help: 'Bind port. Spawner overrides per-service.' },
];
const KV_QUANT_OPTIONS = ['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl'];
const KNOWN_INTENT_KEYS = KNOWN_INTENTS.map(i => i.k);
function intentSpec(k) {
  return KNOWN_INTENTS.find(i => i.k === k) || { k, kind: 'text', help: '' };
}

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
    useRawPath: false,        // toggle catalog-dropdown vs raw default_model text
    hf_repo: '',
    hf_file: '',
    extra_flags: '',
    intentRows: [{ k: '', v: '' }],
    catalog: [],              // [{alias, size_mb, architecture, on_nodes:[...]}]
    error: '',
    busy: false,

    init() {
      // Listen for synthetic events fired by the in-table buttons.
      window.addEventListener('witchgrid:edit-profile', (e) => this.openFor(e.detail.name));
      window.addEventListener('witchgrid:new-profile',  ()  => this.openNew());
    },

    async loadCatalog() {
      try {
        const r = await fetch('/api/catalog');
        if (r.ok) this.catalog = await r.json();
      } catch (e) { /* dropdown will be empty; raw-path toggle still works */ }
    },

    intentSpec,                      // expose to template
    kvQuants: KV_QUANT_OPTIONS,
    knownIntentKeys: KNOWN_INTENT_KEYS,

    addIntent()        {
      // Default to the first known key that's not already used, so adding
      // a row gives the operator a useful starting point.
      const used = new Set(this.intentRows.map(r => r.k));
      const next = KNOWN_INTENT_KEYS.find(k => !used.has(k)) || '';
      this.intentRows.push({ k: next, v: this.defaultIntentValue(next) });
    },
    removeIntent(i)    { this.intentRows.splice(i, 1); if (this.intentRows.length === 0) this.intentRows.push({k:'',v:''}); },
    defaultIntentValue(k) {
      const s = intentSpec(k);
      if (s.kind === 'kv_quant') return 'f16';
      if (s.kind === 'tri_bool') return 'true';
      if (s.kind === 'number')   return '';
      return '';
    },
    onIntentKeyChange(i, newKey) {
      // Reset value to the new key's default when the operator switches
      // keys so the input shape matches what they see in the dropdown.
      this.intentRows[i].k = newKey;
      this.intentRows[i].v = this.defaultIntentValue(newKey);
    },

    reset() {
      this.name = ''; this.binary = 'llama-server';
      this.default_port = 18080; this.context = 4096; this.kv_type = 'f16';
      this.model_alias = ''; this.default_model = '';
      this.useRawPath = false;
      this.hf_repo = ''; this.hf_file = '';
      this.extra_flags = '';
      this.intentRows = [{ k: '', v: '' }];
      this.error = '';
    },

    async openNew() {
      this.reset();
      this.isNew = true;
      this.open = true;
      this.loadCatalog();
    },

    async openFor(name) {
      this.reset();
      this.isNew = false;
      this.open = true;
      this.busy = true;
      this.loadCatalog();
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
        // Pre-open the raw-path toggle when the profile already uses
        // default_model without an alias — operator clearly wanted raw.
        this.useRawPath = !this.model_alias && !!this.default_model;
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
      // useRawPath gates which model field saves: catalog picker → model_alias,
      // raw textbox → default_model. We never save both — that hides bugs
      // where the operator thinks they switched but stale state lingers.
      if (this.useRawPath) {
        if (this.default_model) profile.default_model = this.default_model;
      } else {
        if (this.model_alias) profile.model_alias = this.model_alias;
      }
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

// ── node editor (Overview page) ──────────────────────────────────
//
// Opens via editNode(node_id, current_state) called from the per-row
// "options" button. Saves via PATCH /api/nodes/{node_id}.

function nodeEditor() {
  return {
    open: false,
    node_id: '',
    state: 'active',
    error: '',
    busy: false,
    // llama.cpp install panel
    installs: [],            // {tag, path, is_current, has_binary}
    currentPath: '',
    detectedFlavor: '',
    installTag: '',
    installFlavor: '',
    installBusy: false,
    installMsg: '',

    init() {
      window.addEventListener('witchgrid:edit-node', async (e) => {
        this.node_id = e.detail.node_id;
        this.state = e.detail.state || 'active';
        this.error = '';
        this.installMsg = '';
        this.open = true;
        await this.refreshInstalls();
      });
    },

    cancel() { this.open = false; },

    async refreshInstalls() {
      try {
        const [r1, r2] = await Promise.all([
          fetch('/api/nodes/' + encodeURIComponent(this.node_id) + '/llama_cpp/installed'),
          fetch('/api/nodes/' + encodeURIComponent(this.node_id) + '/llama_cpp/flavor'),
        ]);
        if (r1.ok) {
          const d = await r1.json();
          this.installs = d.installed || [];
          this.currentPath = d.current_path || '';
        }
        if (r2.ok) {
          const d = await r2.json();
          this.detectedFlavor = d.flavor || '';
          if (!this.installFlavor) this.installFlavor = this.detectedFlavor || '';
        }
      } catch (e) {
        this.error = 'load failed: ' + e;
      }
    },

    async save() {
      this.busy = true; this.error = '';
      try {
        const r = await fetch('/api/nodes/' + encodeURIComponent(this.node_id), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: this.state }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.error = d.error || ('HTTP ' + r.status);
          this.busy = false;
          return;
        }
        this.open = false;
      } catch (e) {
        this.error = 'save failed: ' + e;
      }
      this.busy = false;
    },

    async installNew() {
      if (!this.installTag) { this.installMsg = 'tag required (e.g. b9124)'; return; }
      if (!this.installFlavor) { this.installMsg = 'flavor required'; return; }
      this.installBusy = true; this.installMsg = '';
      try {
        const r = await fetch('/api/nodes/' + encodeURIComponent(this.node_id) + '/llama_cpp/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tag: this.installTag, flavor: this.installFlavor }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { this.installMsg = 'error: ' + (d.error || ('HTTP ' + r.status)); }
        else      { this.installMsg = 'queued ' + d.install_id + ' (poll Installed list to see progress)'; }
        await this.refreshInstalls();
      } catch (e) {
        this.installMsg = 'install failed: ' + e;
      }
      this.installBusy = false;
    },

    async activate(tag) {
      this.installBusy = true; this.installMsg = '';
      try {
        const r = await fetch('/api/nodes/' + encodeURIComponent(this.node_id) + '/llama_cpp/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tag }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { this.installMsg = 'error: ' + (d.error || ('HTTP ' + r.status)); }
        else      { this.installMsg = 'active: ' + (d.current_path || tag); }
        await this.refreshInstalls();
      } catch (e) {
        this.installMsg = 'activate failed: ' + e;
      }
      this.installBusy = false;
    },
  };
}

function editNode(node_id, state) {
  window.dispatchEvent(new CustomEvent('witchgrid:edit-node', {
    detail: { node_id, state },
  }));
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

// Inline test-prompt panel (Overview page). Lets the operator send
// a single completion request through the routing layer without
// leaving the dashboard — closes the loop on "spawn → verify it
// answers → stop". Skipped streaming: we want the timings block
// from the response which the server only returns on stream:false.
function testPrompt() {
  return {
    profiles: {},
    profile: '',
    prompt: '<|im_start|>system\nYou are helpful.<|im_end|>\n<|im_start|>user\nWrite a haiku about a thunderstorm.<|im_end|>\n<|im_start|>assistant\n',
    n_predict: 100,
    busy: false,
    error: '',
    result: null,
    elapsedMs: 0,
    async init() {
      try {
        const r = await fetch('/api/profiles');
        if (r.ok) this.profiles = await r.json();
      } catch (e) { /* dropdown will be empty; user can refresh */ }
    },
    async send() {
      if (!this.profile) { this.error = 'pick a profile'; return; }
      this.busy = true; this.error = ''; this.result = null;
      const t0 = performance.now();
      try {
        const r = await fetch('/v1/llama/' + encodeURIComponent(this.profile) + '/completion', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: this.prompt,
            n_predict: parseInt(this.n_predict, 10),
            stream: false,
          }),
        });
        this.elapsedMs = Math.round(performance.now() - t0);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          this.error = 'HTTP ' + r.status + ': ' + (d.error || JSON.stringify(d).substring(0, 200));
        } else {
          this.result = d;
        }
      } catch (e) { this.error = String(e); }
      this.busy = false;
    },
  };
}

// Stop a running service. Confirm → POST /services/stop → reload.
// Used by the per-row stop button in the services table.
async function stopService(id, profile, node) {
  if (!confirm('Stop ' + profile + ' on ' + node + '?')) return;
  const r = await fetch('/services/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, node_id: node }),
  });
  if (!r.ok && r.status !== 204) {
    const d = await r.json().catch(() => ({}));
    alert('Stop failed: ' + (d.error || ('HTTP ' + r.status)));
    return;
  }
  // Trigger an immediate refresh of the services panel rather than
  // waiting for the next 5s htmx poll. Falls back to a full reload
  // if the panel isn't on this page.
  const panel = document.querySelector('[hx-get="/ui/services"]');
  if (panel && window.htmx) { window.htmx.trigger(panel, 'load'); }
  else { window.location.reload(); }
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
