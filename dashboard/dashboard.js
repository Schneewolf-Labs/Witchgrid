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
    nodes: [],
    profileName: '',
    model: '',
    node_id: '',
    port: '',
    gpus: '',
    message: '',
    isError: false,
    busy: false,

    async init() {
      try {
        // Profiles + nodes both fetched up front; pin-placement dropdown
        // needs the node list to be useful, and we want the spawn form
        // ready as soon as the page paints.
        const [pr, nr] = await Promise.all([fetch('/api/profiles'), fetch('/nodes')]);
        this.profiles = await pr.json();
        this.nodes = (await nr.json()).filter(n => (n.state || 'active') !== 'disabled');
      } catch (e) {
        this.message = 'could not load form data: ' + e;
        this.isError = true;
      }
    },

    onProfileChange() {
      const p = this.profiles[this.profileName];
      if (!p) { this.model = ''; this.preview = ''; return; }
      if (p.model_alias) {
        this.model = '';
      } else if (p.default_model) {
        this.model = p.default_model;
      } else {
        this.model = '';
      }
      this.refreshPreview();
    },
    preview: '',
    async refreshPreview() {
      this.preview = '…';
      try {
        const r = await fetch('/api/placement_preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profile_name: this.profileName }),
        });
        const d = await r.json();
        if (d.ok) {
          const fmtMb = (mb) => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
          const headroom = (d.free_mb_on_picked_gpus || 0) - (d.est_mb || 0);
          const where = d.cpu_only
            ? d.node_id + ' (CPU)'
            : d.node_id + ' GPU ' + (d.gpu_indices || []).join(',');
          const capLabel = d.cpu_only ? 'RAM' : 'VRAM';
          this.preview = '→ would land on ' + where
            + ' · ~' + fmtMb(d.est_mb) + ' needed of ' + fmtMb(d.free_mb_on_picked_gpus) + ' free ' + capLabel
            + (headroom > 0 ? ' (' + fmtMb(headroom) + ' headroom)' : '');
        } else {
          this.preview = '⚠ ' + (d.reason || 'no fit');
        }
      } catch (e) { this.preview = ''; }
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
          const where = d.id.slice(0, 8) + ' on ' + d.node_id + ' port ' + d.port
            + (d.device ? ' (' + d.device.toUpperCase() + ')' : '');
          this.message = 'spawned ' + where + ' — loading model…';
          this.busy = false;
          const prof = this.profileName;
          if (window.wgPollReady) {
            window.wgPollReady(prof, (phase) => {
              if (phase === 'ready')        this.message = '✓ ready — ' + prof + ' is serving on port ' + d.port;
              else if (phase === 'timeout') this.message = 'spawned ' + where + ' — still loading, see Services';
            });
          }
          return;
        }
        this.message = d.error || ('HTTP ' + r.status);
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
  { k: 'context',         flag: 'ctx-size',     kind: 'number',   help: 'Prompt+generation context window. Maps to -c / --ctx-size N.' },
  { k: 'kv_cache_k',      flag: 'cache-type-k', kind: 'kv_quant', help: 'Quantization for the K side of the KV cache.' },
  { k: 'kv_cache_v',      flag: 'cache-type-v', kind: 'kv_quant', help: 'Quantization for the V side of the KV cache.' },
  { k: 'parallel_slots',  flag: 'parallel',     kind: 'number',   help: 'Parallel decode slots. Set 1 for RP/chat models.' },
  { k: 'gpu_layers',      flag: 'gpu-layers',   kind: 'number',   help: 'Layers to offload to GPU. 99 = all (llama.cpp clamps to model depth).' },
  { k: 'flash_attention', flag: 'flash-attn',   kind: 'tri_bool', help: 'FlashAttention. true → on, false → off, auto → llama.cpp decides.' },
  { k: 'host',            flag: 'host',         kind: 'text',     help: 'Bind address. Spawner overrides; here for completeness.' },
  { k: 'port',            flag: 'port',         kind: 'number',   help: 'Bind port. Spawner overrides per-service.' },
];
const KV_QUANT_OPTIONS = ['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl'];
const KNOWN_INTENT_KEYS = KNOWN_INTENTS.map(i => i.k);

// One-click presets for the common intent combos, so you don't have to
// know the intent keys. Each toggles a set of (intent → value) pairs;
// they map straight onto the normalized intents the agent translates.
const QUICK_TOGGLES = [
  { id: 'flash',   label: '⚡ flash attention', set: [{ k: 'flash_attention', v: 'true' }] },
  { id: 'q4kv',    label: '🗜 q4 KV cache',     set: [{ k: 'kv_cache_k', v: 'q4_0' }, { k: 'kv_cache_v', v: 'q4_0' }] },
  { id: 'single',  label: '👤 single slot (chat/RP)', set: [{ k: 'parallel_slots', v: '1' }] },
  { id: 'fullgpu', label: '🎮 full GPU offload', set: [{ k: 'gpu_layers', v: '99' }] },
  { id: 'cpu',     label: '🧮 CPU only',         set: [{ k: 'gpu_layers', v: '0' }] },
  { id: 'ctx128',  label: '📏 128K context',     set: [{ k: 'context', v: '131072' }] },
];
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
    default_device: 'auto',   // auto = honor intent.gpu_layers; cpu/gpu override
    useRawPath: false,        // toggle catalog-dropdown vs raw default_model text
    hf_repo: '',
    hf_file: '',
    extra_flags: '',
    intentRows: [{ k: '', v: '' }],
    catalog: [],              // [{alias, size_mb, architecture, on_nodes:[...]}]
    capabilities: {},         // { node_id → { binary → { flag → {...} } } }
    error: '',
    busy: false,

    init() {
      // Listen for synthetic events fired by the in-table buttons.
      window.addEventListener('witchgrid:edit-profile', (e) => this.openFor(e.detail.name));
      window.addEventListener('witchgrid:new-profile',  ()  => this.openNew());
      // "customize (advanced)" hand-off from the guided wizard.
      window.addEventListener('witchgrid:wizard-advanced', (e) => this.openFromWizard(e.detail));
      // Auto-open prefilled from a ?prefill_alias=... query string —
      // used by the catalog page's "create profile for <alias>" CTA
      // after a successful HF pull. We pop the query off the URL so a
      // refresh doesn't re-open the modal.
      const params = new URLSearchParams(window.location.search);
      const alias = params.get('prefill_alias');
      if (alias) {
        this.openPrefilled({
          alias,
          hf_repo: params.get('prefill_hf_repo') || '',
          hf_file: params.get('prefill_hf_file') || '',
        });
        history.replaceState({}, '', window.location.pathname);
      }
      // Adopt hand-off: a profile draft parsed from an unmanaged
      // llama-server's argv, stashed in sessionStorage by adoptUnmanaged().
      let adopt = null;
      try { adopt = sessionStorage.getItem('wg-adopt-profile'); } catch (e) {}
      if (adopt) {
        try { this.openFromAdopt(JSON.parse(adopt)); } catch (e) {}
        try { sessionStorage.removeItem('wg-adopt-profile'); } catch (e) {}
      }
    },

    openFromAdopt(draft) {
      this.reset();
      this.isNew = true;
      this.open = true;
      this.binary = 'llama-server';
      this.name = draft.name || '';
      this.useRawPath = true;                       // adopted procs use a raw -m path
      this.default_model = draft.default_model || '';
      this.intentRows = Object.entries(draft.intent || {}).map(([k, v]) => ({ k, v: String(v) }));
      if (this.intentRows.length === 0) this.intentRows.push({ k: '', v: '' });
      if (draft.intent && draft.intent.context)    this.context = parseInt(draft.intent.context, 10) || this.context;
      if (draft.intent && draft.intent.kv_cache_k) this.kv_type = draft.intent.kv_cache_k;
      this.loadCatalog();
      this.loadCapabilities();
    },

    async openPrefilled({ alias, hf_repo, hf_file }) {
      this.reset();
      this.isNew = true;
      this.open = true;
      // Default the profile name to the alias with quant suffix
      // dropped — operator can edit before save. Sensible defaults
      // for context + kv_type match the chat-mahou template.
      this.name = alias.replace(/\.q\d.*$/, '').replace(/[^a-z0-9-]/g, '-');
      this.model_alias = alias;
      this.hf_repo = hf_repo;
      this.hf_file = hf_file;
      this.context = 8192;
      this.kv_type = 'q4_0';
      this.intentRows = [
        { k: 'context',         v: '8192' },
        { k: 'kv_cache_k',      v: 'q4_0' },
        { k: 'kv_cache_v',      v: 'q4_0' },
        { k: 'gpu_layers',      v: '99' },
        { k: 'flash_attention', v: 'true' },
        { k: 'parallel_slots',  v: '1' },
      ];
      await this.loadCatalog();
    },

    async loadCatalog() {
      try {
        const r = await fetch('/api/catalog');
        if (r.ok) this.catalog = await r.json();
      } catch (e) { /* dropdown will be empty; raw-path toggle still works */ }
    },
    async loadCapabilities() {
      try {
        const r = await fetch('/api/capabilities');
        if (r.ok) this.capabilities = await r.json();
      } catch (e) { /* warnings will be silent if caps fetch fails */ }
    },
    // For an intent row, return the list of nodes whose `binary` doesn't
    // expose the underlying flag. Empty array = supported everywhere.
    intentUnsupportedOn(intentKey) {
      const spec = KNOWN_INTENTS.find(i => i.k === intentKey);
      if (!spec) return [];                  // unknown intent — agent will throw at spawn time
      const flag = spec.flag;
      const out = [];
      for (const [nodeId, binMap] of Object.entries(this.capabilities)) {
        const bin = binMap[this.binary];
        if (!bin) continue;                  // node doesn't run this binary at all — skip
        if (!(flag in bin)) out.push(nodeId);
      }
      return out;
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

    // ── quick toggles (suggested flags) ──
    quickToggles: QUICK_TOGGLES,
    hasIntent(k, v)  { const r = this.intentRows.find(r => r.k === k); return !!r && String(r.v) === String(v); },
    setIntent(k, v)  {
      const r = this.intentRows.find(r => r.k === k);
      if (r) r.v = v; else this.intentRows.push({ k, v });
      this.intentRows = this.intentRows.filter(r => r.k !== '');   // drop the placeholder row
      if (this.intentRows.length === 0) this.intentRows.push({ k: '', v: '' });
    },
    unsetIntent(k)   {
      this.intentRows = this.intentRows.filter(r => r.k !== k);
      if (this.intentRows.length === 0) this.intentRows.push({ k: '', v: '' });
    },
    quickActive(t)   { return t.set.every(p => this.hasIntent(p.k, p.v)); },
    toggleQuick(t)   {
      if (this.quickActive(t)) { t.set.forEach(p => this.unsetIntent(p.k)); }
      else                     { t.set.forEach(p => this.setIntent(p.k, p.v)); }
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
      this.default_device = 'auto';
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
      this.loadCapabilities();
    },

    async openFor(name) {
      this.reset();
      this.isNew = false;
      this.open = true;
      this.busy = true;
      this.loadCatalog();
      this.loadCapabilities();
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
        this.default_device = p.default_device || 'auto';
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

    // Open the full editor pre-populated from the guided wizard's choices,
    // so an operator can fine-tune intents/flags before saving.
    openFromWizard(d) {
      this.reset();
      this.isNew = true;
      this.open = true;
      this.loadCatalog();
      this.loadCapabilities();
      const p = (d && d.profile) || {};
      this.name = (d && d.name) || '';
      this.binary = p.binary || 'llama-server';
      this.default_port = p.default_port || 18080;
      this.context = p.context || 4096;
      this.kv_type = p.kv_type || 'f16';
      this.default_device = p.default_device || 'auto';
      this.model_alias = p.model_alias || '';
      this.default_model = p.default_model || '';
      this.useRawPath = !this.model_alias && !!this.default_model;
      if (p.hf_source) { this.hf_repo = p.hf_source.repo || ''; this.hf_file = p.hf_source.file || ''; }
      this.extra_flags = (p.extra_flags || []).join('\n');
      this.intentRows = Object.entries(p.intent || {}).map(([k, v]) => ({ k, v: String(v) }));
      if (this.intentRows.length === 0) this.intentRows.push({ k: '', v: '' });
    },

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
        default_device: this.default_device || 'auto',
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

// Auto-restart watchdog toggle — per-row button in the nodes table.
// PUTs to CP which proxies to the agent's /settings (agent owns the
// knob). `enable` is the desired next state (bool). Refreshes the nodes
// panel in place, like stopService.
async function toggleAutoRestart(node_id, enable) {
  const verb = enable ? 'enable' : 'disable';
  if (!confirm(verb + ' auto-restart on ' + node_id + '?')) return;
  const r = await fetch('/api/nodes/' + encodeURIComponent(node_id) + '/auto-restart', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auto_restart: enable }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert('Toggle failed: ' + (d.error || ('HTTP ' + r.status)));
    return;
  }
  const panel = document.querySelector('[hx-get="/ui/nodes"]');
  if (panel && window.htmx) { window.htmx.trigger(panel, 'load'); }
  else { window.location.reload(); }
}

// Best-effort SIGTERM of an unmanaged process from the node card.
// Cross-user procs (different owner than the agent) will fail with EPERM
// — surfaced from the agent as a 502 so we can tell the operator plainly.
async function killUnmanaged(node, pid) {
  if (!confirm('Send SIGTERM to PID ' + pid + ' on ' + node + '?\n\n' +
               'This is an unmanaged process (not spawned by witchgrid). ' +
               'If it is owned by another user the kill will be denied.')) return;
  const r = await fetch('/unmanaged/kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node_id: node, pid: pid }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert('Kill failed: ' + (d.error || ('HTTP ' + r.status)));
    return;
  }
  const panel = document.querySelector('[hx-get="/ui/nodes"]');
  if (panel && window.htmx) { window.htmx.trigger(panel, 'load'); }
  else { window.location.reload(); }
}

// Parse an unmanaged llama-server's argv into a profile draft and hand it
// to the profiles editor (via sessionStorage) prefilled. Reuses the
// cmdline we already captured — no live API probe needed.
function adoptUnmanaged(btn) {
  const cmdline = (btn && btn.dataset && btn.dataset.cmdline) || '';
  const toks = cmdline.trim().split(/\s+/);
  const get = (...flags) => {
    for (let i = 0; i < toks.length - 1; i++) if (flags.includes(toks[i])) return toks[i + 1];
    return null;
  };
  const model = get('-m', '--model') || '';
  const alias = model.split('/').pop().replace(/\.gguf$/i, '').toLowerCase();
  const intent = {};
  const ctx = get('-c', '--ctx-size');                 if (ctx) intent.context = ctx;
  const ngl = get('-ngl', '--gpu-layers', '--n-gpu-layers'); if (ngl != null) intent.gpu_layers = ngl;
  const np  = get('-np', '--parallel');                if (np) intent.parallel_slots = np;
  const ctk = get('-ctk', '--cache-type-k');           if (ctk) intent.kv_cache_k = ctk;
  const ctv = get('-ctv', '--cache-type-v');           if (ctv) intent.kv_cache_v = ctv;
  const faIdx = toks.findIndex(t => t === '-fa' || t === '--flash-attn');
  if (faIdx >= 0) {
    const v = toks[faIdx + 1];
    intent.flash_attention = (v === 'off') ? 'false' : (v === 'auto') ? 'auto' : 'true';
  }
  const draft = {
    name: (alias || 'adopted').replace(/[^a-z0-9-]/g, '-'),
    default_model: model,
    intent,
  };
  try { sessionStorage.setItem('wg-adopt-profile', JSON.stringify(draft)); } catch (e) {}
  window.location.href = '/profiles';
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

// Service log modal — opened by `logs` button in the services row.
// Polls /services/log/{node}/{id} every 3s while open. Tail is text/plain;
// we just dump it in a <pre>. 32KB cap on the agent side keeps payload
// small enough that a 3s poll over LAN is unnoticeable.
function serviceLogModal() {
  return {
    open: false,
    profile: '', node: '', id: '', body: '', err: '', timer: null,
    init() {
      window.addEventListener('witchgrid:show-service-log', (e) => this.openFor(e.detail));
    },
    async openFor({ id, profile, node }) {
      this.id = id; this.profile = profile; this.node = node;
      this.body = ''; this.err = '';
      this.open = true;
      await this.refresh();
      this.timer = setInterval(() => this.refresh(), 3000);
    },
    close() {
      this.open = false;
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    },
    async refresh() {
      try {
        const r = await fetch('/services/log/' + encodeURIComponent(this.node) + '/' + encodeURIComponent(this.id));
        if (!r.ok) { this.err = 'HTTP ' + r.status; return; }
        this.body = await r.text();
        this.err = '';
        // Auto-scroll to bottom on the next paint.
        this.$nextTick(() => {
          const pre = document.querySelector('#service-log-body');
          if (pre) pre.scrollTop = pre.scrollHeight;
        });
      } catch (e) { this.err = String(e); }
    },
  };
}

function showServiceLog(id, profile, node) {
  window.dispatchEvent(new CustomEvent('witchgrid:show-service-log', { detail: { id, profile, node } }));
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
      // Explicit stored state wins (true OR false); otherwise keep the
      // rendered default. This supports both default-collapsed panels and
      // default-expanded ones (node cards) with collapse remembered.
      const k = d.dataset.detailKey;
      if (Object.prototype.hasOwnProperty.call(state, k)) d.open = state[k];
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
    state[key] = e.target.open;   // store true/false explicitly
    save(state);
  }, true);
})();

// ── live state stream (SSE) ──────────────────────────────────────────
// One EventSource per tab consumes /events. On each pushed snapshot we
// (a) refresh this page's htmx live panels immediately and (b) diff against
// the previous snapshot to raise toasts for the transitions an operator
// actually wants pushed at them — services going down/failed/recovered and
// nodes going offline/online. This replaces the old 5s polling cadence; the
// htmx panels keep a slow 30s fallback timer. EventSource auto-reconnects.
(function () {
  let prev = null;   // { services: {id:svc}, nodes: {id:node} } or null (first)

  function refreshLivePanels() {
    if (!window.htmx) return;
    document
      .querySelectorAll('[hx-get="/ui/services"],[hx-get="/ui/nodes"],[hx-get="/ui/stats"]')
      .forEach((el) => { try { window.htmx.trigger(el, 'load'); } catch (e) {} });
  }

  function index(snap) {
    const s = {}, n = {};
    (snap.services || []).forEach((x) => { s[x.id] = x; });
    (snap.nodes || []).forEach((x) => { n[x.node_id] = x; });
    return { services: s, nodes: n };
  }

  // Compare two indexed snapshots and fire one toast per meaningful change.
  // Deliberately quiet: no toasts for operator-initiated spawn/stop (the
  // actor already gets inline feedback), and a node going offline takes its
  // services with it — we toast the node, not each vanished service.
  function diffToasts(p, c) {
    // node transitions first (they explain service disappearances)
    for (const id in c.nodes) {
      const was = p.nodes[id], now = c.nodes[id];
      if (was && was.up && !now.up)        wgToast('⚠ Node offline: ' + id + ' — its services are unreachable', 'err');
      else if (was && !was.up && now.up)   wgToast('Node back online: ' + id, 'ok');
      else if (!was && now.up)             wgToast('Node online: ' + id, 'ok');
    }
    // service transitions (only for services present in both snapshots, so a
    // service that vanished with its node doesn't double-fire)
    for (const id in c.services) {
      const was = p.services[id], now = c.services[id];
      if (!was) continue;
      if (was.alive && !now.alive) {
        const failed = now.state === 'failed';
        wgToast((failed ? '✗ Service failed (crash-loop): ' : '⚠ Service down: ')
          + now.profile + ' on ' + now.node, 'err');
      } else if (!was.alive && now.alive) {
        wgToast('✓ Service recovered: ' + now.profile + ' on ' + now.node, 'ok');
      }
    }
  }

  function onSnapshot(snap) {
    refreshLivePanels();
    const cur = index(snap);
    if (prev) { try { diffToasts(prev, cur); } catch (e) {} }   // skip first paint
    prev = cur;
    window.dispatchEvent(new CustomEvent('witchgrid:state', { detail: snap }));
  }

  function connect() {
    let es;
    try { es = new EventSource('/events'); } catch (e) { return; }
    es.addEventListener('state', (e) => {
      try { onSnapshot(JSON.parse(e.data)); } catch (_) {}
    });
    // No explicit onerror handler needed: EventSource reconnects itself.
  }

  if (document.readyState !== 'loading') connect();
  else document.addEventListener('DOMContentLoaded', connect);
})();

// Minimal toast system: bottom-right stack, auto-dismiss, screen-reader
// announced via aria-live. Exposed as window.wgToast(msg, kind) so any
// component (spawn/stop flows, the SSE stream) can use it.
function wgToast(msg, kind) {
  let host = document.getElementById('wg-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'wg-toasts';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('role', 'status');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'wg-toast' + (kind === 'err' ? ' wg-toast-err' : (kind === 'ok' ? ' wg-toast-ok' : ''));
  t.textContent = msg;
  t.title = 'click to dismiss';
  host.appendChild(t);
  let gone = false;
  const dismiss = () => {
    if (gone) return; gone = true;
    t.classList.add('wg-toast-out');
    setTimeout(() => t.remove(), 300);
  };
  t.addEventListener('click', dismiss);
  // Errors dwell longer (8s) than ok/info (5s) so a failure doesn't slip past.
  setTimeout(dismiss, kind === 'err' ? 8000 : 5000);
}
window.wgToast = wgToast;

// ── failure-first health banner (Overview) ───────────────────────────
// A pure function of the live snapshot: calm when healthy, loud when a
// service is down or a node is offline — each with one-click triage that
// reuses the existing log/stop helpers. Fed by the /events SSE stream
// (witchgrid:state), with a one-shot /api/state fetch for instant first
// paint before the first SSE frame arrives.
function healthBanner() {
  return {
    ready: false,
    dead: [],
    offline: [],
    _svcCount: 0,
    _nodeUp: 0,
    get ok() { return this.dead.length === 0 && this.offline.length === 0; },
    get summary() {
      const s = this._svcCount, n = this._nodeUp;
      return s + ' service' + (s === 1 ? '' : 's') + ' live on '
        + n + ' node' + (n === 1 ? '' : 's');
    },
    get headline() {
      const parts = [];
      if (this.dead.length)    parts.push(this.dead.length + ' service' + (this.dead.length === 1 ? '' : 's') + ' down');
      if (this.offline.length) parts.push(this.offline.length + ' node' + (this.offline.length === 1 ? '' : 's') + ' offline');
      return parts.join(' · ');
    },
    apply(snap) {
      const svcs = snap.services || [], nodes = snap.nodes || [];
      this.dead = svcs.filter((s) => !s.alive);
      this.offline = nodes.filter((n) => !n.up);
      this._svcCount = svcs.filter((s) => s.alive).length;
      this._nodeUp = nodes.filter((n) => n.up).length;
      this.ready = true;
    },
    init() {
      window.addEventListener('witchgrid:state', (e) => this.apply(e.detail));
      fetch('/api/state').then((r) => r.json()).then((s) => this.apply(s)).catch(() => {});
    },
    logs(d) { if (window.showServiceLog) window.showServiceLog(d.id, d.profile, d.node); },
    stop(d) { if (window.stopService)    window.stopService(d.id, d.profile, d.node); },
  };
}

// ── spawn readiness polling ──────────────────────────────────────────
// POST /services returns once the process is up, but the model is still
// loading for ~10–15s. Poll /api/ready/{profile} so the spawn UI can show
// "loading model… → ready" instead of a misleading bare "spawned".
// onPhase(phase, info) is called with 'loading' | 'ready' | 'timeout'.
async function wgPollReady(profile, onPhase) {
  const deadlineMs = Date.now() + 60000;
  while (Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, 1500));
    let d = null;
    try { d = await (await fetch('/api/ready/' + encodeURIComponent(profile))).json(); }
    catch (e) { continue; }
    if (d && d.ready) { onPhase('ready', d); return; }
    onPhase('loading', d || {});
  }
  onPhase('timeout', null);
}
window.wgPollReady = wgPollReady;

// ── guided profile wizard ────────────────────────────────────────────
// Use-case presets that hide the intent/flag complexity behind a sensible
// starting point. Each maps to the same profile shape buildPayload() emits.
// llama-server cases expose context/kv in the review step; sd/whisper/piper
// don't (no context/KV concept), so showCtx/showKv gate those fields.
const USE_CASES = [
  { id:'chat', icon:'💬', label:'Chat / Roleplay',
    desc:'Conversational & RP models. GPU, long context, KV-quantized.',
    binary:'llama-server', device:'gpu', context:32768, kv_type:'q4_0', port:18080,
    intent:{ context:32768, kv_cache_k:'q4_0', kv_cache_v:'q4_0', gpu_layers:99, flash_attention:true, parallel_slots:1 } },
  { id:'assistant', icon:'🤖', label:'Assistant / Instruct',
    desc:'General instruction-following. GPU, balanced context.',
    binary:'llama-server', device:'gpu', context:16384, kv_type:'q8_0', port:18082,
    intent:{ context:16384, kv_cache_k:'q8_0', kv_cache_v:'q8_0', gpu_layers:99, flash_attention:true, parallel_slots:1 } },
  { id:'summarizer', icon:'📝', label:'Summarizer (CPU)',
    desc:'Background summarization. CPU-only so it never competes for VRAM.',
    binary:'llama-server', device:'cpu', context:16384, kv_type:'q4_0', port:18085,
    intent:{ context:16384, kv_cache_k:'q4_0', kv_cache_v:'q4_0', gpu_layers:0, parallel_slots:1 } },
  { id:'structured', icon:'🧩', label:'Structured output (JSON)',
    desc:'Tool/JSON generation via the chat template. Adds --jinja.',
    binary:'llama-server', device:'cpu', context:4096, kv_type:'q8_0', port:18081, extra_flags:['--jinja'],
    intent:{ context:4096, kv_cache_k:'q8_0', kv_cache_v:'q8_0', gpu_layers:0, parallel_slots:1 } },
  { id:'embeddings', icon:'🔢', label:'Embeddings',
    desc:'Vector embeddings. CPU, --embedding mode.',
    binary:'llama-server', device:'cpu', context:8192, kv_type:'f16', port:18090, extra_flags:['--embedding'],
    intent:{ context:8192, gpu_layers:0 } },
  { id:'image', icon:'🎨', label:'Image generation',
    desc:'stable-diffusion.cpp server (A1111-compatible API).',
    binary:'sd-server', device:'gpu', port:19080, intent:{} },
  { id:'stt', icon:'🎙️', label:'Speech → text',
    desc:'whisper.cpp transcription server.',
    binary:'whisper-server', device:'gpu', port:19090, intent:{} },
  { id:'tts', icon:'🔊', label:'Text → speech',
    desc:'piper voice synthesis.',
    binary:'piper', device:'cpu', port:19095, intent:{} },
];

function newProfileWizard() { window.dispatchEvent(new CustomEvent('witchgrid:new-wizard')); }

function profileWizard() {
  return {
    open: false, step: 1, busy: false, error: '',
    useCases: USE_CASES,
    useCase: null,
    catalog: [],
    alias: '', useRaw: false, rawPath: '',
    name: '', context: 4096, device: 'auto', kv_type: 'f16',
    kvQuants: KV_QUANT_OPTIONS,
    get showCtx() { return !!(this.useCase && this.useCase.binary === 'llama-server'); },
    get showKv()  { return this.showCtx; },

    init() { window.addEventListener('witchgrid:new-wizard', () => this.start()); },
    async start() {
      this.reset();
      this.open = true;
      try { const r = await fetch('/api/catalog'); if (r.ok) this.catalog = await r.json(); } catch (e) {}
    },
    reset() {
      this.step = 1; this.useCase = null; this.alias = ''; this.useRaw = false;
      this.rawPath = ''; this.name = ''; this.error = ''; this.busy = false;
      this.context = 4096; this.device = 'auto'; this.kv_type = 'f16';
    },
    pickUseCase(uc) {
      this.useCase = uc;
      this.context = uc.context || 4096;
      this.device = uc.device || 'auto';
      this.kv_type = uc.kv_type || 'f16';
    },
    canNext() {
      if (this.step === 1) return !!this.useCase;
      if (this.step === 2) return !!(this.alias || (this.useRaw && this.rawPath));
      return true;
    },
    next() { if (this.canNext() && this.step < 3) { if (this.step === 2) this.suggestName(); this.step++; } },
    back() { if (this.step > 1) this.step--; },
    suggestName() {
      if (this.name) return;
      const src = this.alias || this.rawPath.split('/').pop() || 'profile';
      const base = src.replace(/\.q\d.*$/i, '').replace(/\.gguf$/i, '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      this.name = (base || 'profile') + (this.useCase ? '-' + this.useCase.id : '');
    },
    summary() {
      const uc = this.useCase; if (!uc) return '';
      return 'Creates a ' + uc.binary + ' profile · ' + this.device.toUpperCase()
        + (this.showCtx ? ' · ctx ' + this.context + ' · kv ' + this.kv_type : '')
        + ' · model ' + (this.alias || this.rawPath || '—');
    },
    buildProfile() {
      const uc = this.useCase;
      const intent = Object.assign({}, uc.intent || {});
      if ('context' in intent) intent.context = parseInt(this.context, 10);
      const profile = {
        binary: uc.binary,
        intent,
        extra_flags: (uc.extra_flags || []).slice(),
        default_port: uc.port || 18080,
        context: this.showCtx ? parseInt(this.context, 10) : 0,
        kv_type: this.kv_type,
        default_device: this.device,
      };
      if (this.useRaw && this.rawPath) profile.default_model = this.rawPath;
      else if (this.alias) profile.model_alias = this.alias;
      const m = this.catalog.find((c) => c.alias === this.alias);
      if (m && m.hf_repo && m.hf_file) profile.hf_source = { repo: m.hf_repo, file: m.hf_file };
      return profile;
    },
    async create() {
      this.busy = true; this.error = '';
      try {
        const r = await fetch('/api/profiles', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: this.name, profile: this.buildProfile() }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { this.error = d.error || ('HTTP ' + r.status); this.busy = false; return; }
        this.open = false;
        if (window.wgToast) window.wgToast('✓ Profile created: ' + this.name, 'ok');
        window.location.reload();
      } catch (e) { this.error = String(e); this.busy = false; }
    },
    // Hand the computed profile to the full editor for fine-tuning.
    openAdvanced() {
      window.dispatchEvent(new CustomEvent('witchgrid:wizard-advanced', {
        detail: { name: this.name, profile: this.buildProfile() },
      }));
      this.open = false;
    },
    cancel() { this.open = false; },
  };
}

// ── version badge ────────────────────────────────────────────────────
// Fill any #wg-version element from /healthz so the dashboard shows which
// CP build it's talking to (single source of truth: version.hml).
(function () {
  function fill() {
    const el = document.getElementById('wg-version');
    if (!el) return;
    fetch('/healthz').then((r) => r.json()).then((d) => {
      if (d && d.version) el.textContent = 'v' + d.version;
    }).catch(() => {});
  }
  if (document.readyState !== 'loading') fill();
  else document.addEventListener('DOMContentLoaded', fill);
})();

// ── footer build info ────────────────────────────────────────────────
// Fill #wg-footer-info with version + the CP endpoint you're actually
// talking to (window.location.host — more useful than the 0.0.0.0 bind)
// + auth posture, from /api/config.
(function () {
  function fill() {
    const el = document.getElementById('wg-footer-info');
    if (!el) return;
    fetch('/api/config').then((r) => r.json()).then((d) => {
      if (!d) return;
      const parts = ['witchgrid v' + (d.version || '?'), 'CP ' + window.location.host];
      parts.push('auth ' + (d.auth_enabled ? 'on' : 'off'));
      el.textContent = parts.join(' · ');
    }).catch(() => {});
  }
  if (document.readyState !== 'loading') fill();
  else document.addEventListener('DOMContentLoaded', fill);
})();
