// Alpine.js component for the spawn form. Pure client state — fetches
// the profile map once on init, POSTs to /services on submit, shows
// inline status. The auto-refreshing services table picks up the new
// row on its next 5s tick.

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
        const r = await fetch('/profiles');
        this.profiles = await r.json();
      } catch (e) {
        this.message = 'could not load profiles: ' + e;
        this.isError = true;
      }
    },

    onProfileChange() {
      // Prefer leaving the model field blank when the profile has an
      // alias — placement will resolve it via the catalog. Operator can
      // still type a path to override. Fall back to default_model when
      // the profile carries one but no alias.
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
      // Only include model if the operator actually filled it; CP will
      // resolve from profile.model_alias / default_model otherwise.
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
