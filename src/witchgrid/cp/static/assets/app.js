// Witchgrid dashboard. Polls /api/nodes + /api/services every 5s and
// renders cards. Lets the operator spawn / stop services.

const POLL_MS = 5000

const el = {
  status: document.getElementById('status'),
  count: document.getElementById('count'),
  nodes: document.getElementById('nodes'),
  services: document.getElementById('services'),
  servicesCount: document.getElementById('services-count'),
  openSpawn: document.getElementById('open-spawn'),
  spawnBackdrop: document.getElementById('spawn-backdrop'),
  spawnForm: document.getElementById('spawn-form'),
  spawnNode: document.getElementById('spawn-node'),
  spawnError: document.getElementById('spawn-error'),
  spawnCancel: document.getElementById('spawn-cancel'),
}

let lastNodes = []

function fmtMb(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB'
  return mb + ' MB'
}

function fmtRel(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function escape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function gpuBar(used, total) {
  const pct = Math.max(0, Math.min(100, Math.round((used / total) * 100)))
  return `
    <div class="bar"><div class="bar__fill" style="width:${pct}%"></div></div>
    <div class="bar__label">
      <span>${fmtMb(used)} / ${fmtMb(total)} VRAM</span>
      <span>${pct}%</span>
    </div>`
}

function renderNodeCard(n) {
  const hw = n.hardware
  const gpus = (hw.gpus || [])
    .map((g) => {
      const used = g.total_mem_mb - g.free_mem_mb
      return `
        <div class="gpu">
          <div class="gpu__head">
            <span class="gpu__name">GPU ${g.index}: ${escape(g.name)}</span>
            <span class="gpu__util">${g.util_pct ?? '–'}% util</span>
          </div>
          ${gpuBar(used, g.total_mem_mb)}
        </div>`
    })
    .join('')

  const ramUsed = hw.ram_total_mb - hw.ram_free_mb
  return `
    <div class="card ${n.online ? '' : 'card--offline'}">
      <div class="card__head">
        <span class="dot ${n.online ? 'dot--online' : ''}"></span>
        <h3 class="card__name">${escape(n.hostname)}</h3>
      </div>
      <div class="card__meta">
        <span>${escape(n.role)}</span>
        <span>·</span>
        <span>v${escape(n.version || '?')}</span>
        <span>·</span>
        <span>${n.online ? 'last seen ' : 'offline ('}${fmtRel(n.last_heartbeat_at)}${n.online ? '' : ')'}</span>
      </div>
      <div class="specs">
        <div>
          <div class="spec__k">CPU</div>
          <div class="spec__v">${hw.cpu_count}× cores · ${(hw.cpu_util_pct ?? 0).toFixed(0)}% util</div>
        </div>
        <div>
          <div class="spec__k">RAM</div>
          <div class="spec__v">${fmtMb(ramUsed)} / ${fmtMb(hw.ram_total_mb)}</div>
        </div>
      </div>
      ${gpus ? `<div class="gpus">${gpus}</div>` : '<div class="muted">No GPUs reported</div>'}
    </div>`
}

function renderServiceCard(s, hostByNodeId) {
  const host = hostByNodeId.get(s.node_id) || s.node_id.slice(0, 8)
  const modelPath = s.config?.model_path || '?'
  const modelName = modelPath.split('/').pop()
  const stoppable = !['stopped', 'stopping', 'failed'].includes(s.state)
  return `
    <div class="svc">
      <div class="svc__head">
        <h3 class="svc__title">${escape(modelName)}</h3>
        <span class="svc__state svc__state--${s.state}">${s.state}</span>
      </div>
      <div class="svc__row">
        <span>${escape(s.template)}</span>
        <span>·</span>
        <span>${escape(host)}</span>
        ${s.port ? `<span>·</span><span><code>:${s.port}</code></span>` : ''}
        ${s.pid ? `<span>·</span><span>pid ${s.pid}</span>` : ''}
      </div>
      <div class="svc__row" title="${escape(modelPath)}">
        <code>${escape(modelPath)}</code>
      </div>
      ${s.error ? `<p class="svc__error">${escape(s.error)}</p>` : ''}
      <div class="svc__actions">
        ${stoppable
          ? `<button class="btn btn--danger" data-stop="${escape(s.service_id)}">Stop</button>`
          : ''}
      </div>
    </div>`
}

async function tick() {
  try {
    const [nodes, services] = await Promise.all([
      fetch('/api/nodes').then((r) => r.json()),
      fetch('/api/services').then((r) => r.json()),
    ])
    lastNodes = nodes
    el.status.textContent = '● live'
    el.status.className = 'status status--ok'
    el.count.textContent = `${nodes.filter((n) => n.online).length} online · ${nodes.length} total`
    el.nodes.innerHTML = nodes.length
      ? nodes.map(renderNodeCard).join('')
      : '<p class="muted">No nodes have joined yet. Start a worker with WITCHGRID_CP=' + window.location.origin + '</p>'

    const hostByNodeId = new Map(nodes.map((n) => [n.node_id, n.hostname]))
    const running = services.filter((s) => s.state === 'running').length
    el.servicesCount.textContent = `${running} running · ${services.length} total`
    el.services.innerHTML = services.length
      ? services.map((s) => renderServiceCard(s, hostByNodeId)).join('')
      : '<p class="muted">Nothing running. Click + Spawn to start one.</p>'

    el.services.querySelectorAll('[data-stop]').forEach((b) => {
      b.addEventListener('click', () => stopService(b.getAttribute('data-stop')))
    })
  } catch (err) {
    el.status.textContent = '● disconnected'
    el.status.className = 'status status--err'
    console.error(err)
  }
}

async function stopService(serviceId) {
  if (!confirm('Stop this service?')) return
  await fetch(`/api/services/${serviceId}/stop`, { method: 'POST' })
  tick()
}

function openSpawn() {
  const opts = lastNodes
    .filter((n) => n.online && n.role.includes('worker'))
    .map((n) => `<option value="${escape(n.node_id)}">${escape(n.hostname)}</option>`)
    .join('')
  el.spawnNode.innerHTML = opts || '<option value="">no online workers</option>'
  el.spawnError.textContent = ''
  el.spawnBackdrop.hidden = false
}

function closeSpawn() {
  el.spawnBackdrop.hidden = true
}

el.openSpawn.addEventListener('click', openSpawn)
el.spawnCancel.addEventListener('click', closeSpawn)
el.spawnBackdrop.addEventListener('click', (e) => {
  if (e.target === el.spawnBackdrop) closeSpawn()
})

el.spawnForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  el.spawnError.textContent = ''
  const fd = new FormData(el.spawnForm)
  const nodeId = fd.get('node_id')
  const template = fd.get('template')
  if (!nodeId) {
    el.spawnError.textContent = 'No worker selected.'
    return
  }
  const config = {
    model_path: fd.get('model_path'),
    context_size: parseInt(fd.get('context_size'), 10),
    n_gpu_layers: parseInt(fd.get('n_gpu_layers'), 10),
  }
  try {
    const r = await fetch('/api/services/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, template, config }),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      throw new Error(body.detail || `http ${r.status}`)
    }
    closeSpawn()
    tick()
  } catch (err) {
    el.spawnError.textContent = err.message
  }
})

tick()
setInterval(tick, POLL_MS)
