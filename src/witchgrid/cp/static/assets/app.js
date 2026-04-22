// Witchgrid dashboard. Polls /api/nodes every 5s and renders cards.

const POLL_MS = 5000

const el = {
  status: document.getElementById('status'),
  count: document.getElementById('count'),
  nodes: document.getElementById('nodes'),
}

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

function renderCard(n) {
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

async function tick() {
  try {
    const r = await fetch('/api/nodes')
    if (!r.ok) throw new Error('http ' + r.status)
    const nodes = await r.json()
    el.status.textContent = '● live'
    el.status.className = 'status status--ok'
    el.count.textContent = `${nodes.filter((n) => n.online).length} online · ${nodes.length} total`
    el.nodes.innerHTML = nodes.length
      ? nodes.map(renderCard).join('')
      : '<p class="muted">No nodes have joined yet. Start a worker with WITCHGRID_CP=' + window.location.origin + '</p>'
  } catch (err) {
    el.status.textContent = '● disconnected'
    el.status.className = 'status status--err'
    console.error(err)
  }
}

tick()
setInterval(tick, POLL_MS)
