// Admin dispatcher dashboard.
import { API, toast, esc, fmtTime, fmtMin, STATUS_LABELS, slaPill } from '/assets/api.js';
import { renderMap } from '/assets/map.js';

const user = API.requireRole('ADMIN');
document.getElementById('whoami').textContent = user.name;
document.getElementById('logout').onclick = () => API.logout();

// ---------- state ----------
const state = {
  tab: 'board',
  tasks: new Map(),   // id -> task
  agents: [],
  locations: [],
  templates: [],
  summary: null,
  reportRange: { from: today(), to: today() },
};
function today() { return new Date().toISOString().slice(0, 10); }

async function loadAll() {
  const [tasks, agents, locations, templates] = await Promise.all([
    API.get(`/api/tasks?date=${today()}`), API.get('/api/agents'),
    API.get('/api/locations'), API.get('/api/templates'),
  ]);
  const active = await API.get('/api/tasks?active=1'); // include older still-active tasks
  state.tasks = new Map([...tasks, ...active].map(t => [t.id, t]));
  state.agents = agents;
  state.locations = locations;
  state.templates = templates;
}

// live updates
API.stream({
  task: t => { state.tasks.set(t.id, t); if (state.tab === 'board' || state.tab === 'map') render(); },
  agent: a => {
    const i = state.agents.findIndex(x => x.id === a.id);
    if (i >= 0) state.agents[i] = a; else state.agents.push(a);
    if (state.tab === 'map' || state.tab === 'team') render();
  },
});

// SLA countdowns tick
setInterval(() => {
  if (state.tab === 'board') {
    for (const el of document.querySelectorAll('[data-sla-task]')) {
      const t = state.tasks.get(Number(el.dataset.slaTask));
      if (t) el.innerHTML = slaPill(t);
    }
  }
}, 1000);

// ---------- tabs ----------
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  render();
});

const page = document.getElementById('page');

function render() {
  ({ board, new: renderNew, map: renderMapTab, templates: renderTemplates,
     reports: renderReports, team: renderTeam })[state.tab]();
}

// ---------- board ----------
const COLS = [
  ['Unassigned', ['CREATED']],
  ['Assigned', ['ASSIGNED', 'ACCEPTED']],
  ['In progress', ['EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED', 'ARRIVED_AT_PICKUP',
    'PASSENGER_PICKED_UP', 'IN_TRANSIT', 'PASSENGER_DELIVERED']],
  ['Completed', ['COMPLETED']],
  ['Cancelled', ['CANCELLED']],
];

function taskCard(t) {
  const prio = t.priority !== 'NORMAL'
    ? `<span class="badge ${t.priority === 'URGENT' ? 'red' : 'amber'}">${t.priority}</span>` : '';
  const agents = t.assignments.map(a => esc(a.agent_name)).join(', ');
  return `<div class="card task-card" data-open-task="${t.id}">
    <div class="row spread">
      <span class="badge blue">${esc(t.flight_number || t.flight_direction)}</span>
      ${prio}
      ${t.has_problem ? '<span class="badge red">⚠ problem</span>' : ''}
      <span class="grow"></span>
      <span data-sla-task="${t.id}">${slaPill(t)}</span>
    </div>
    <div class="route">${esc(t.passenger_name)}</div>
    <div class="small">${esc(t.pickup?.code)} <em style="color:var(--accent-2)">→</em> ${esc(t.destination?.code)}
      ${t.storage ? `<span class="muted">(chair from ${esc(t.storage.code)})</span>` : ''}</div>
    <div class="row spread mt">
      <span class="badge">${STATUS_LABELS[t.status] || t.status}</span>
      <span class="muted small">${agents || 'no agent'}</span>
    </div>
  </div>`;
}

function board() {
  const tasks = [...state.tasks.values()].sort((a, b) => b.id - a.id);
  page.innerHTML = `<div class="board">` + COLS.map(([title, statuses]) => {
    const items = tasks.filter(t => statuses.includes(t.status));
    return `<div class="col"><h3>${title} <span>${items.length}</span></h3>
      <div class="cards">${items.map(taskCard).join('') ||
        '<div class="muted small" style="padding:8px">—</div>'}</div></div>`;
  }).join('') + `</div>`;
}

page.addEventListener('click', e => {
  const card = e.target.closest('[data-open-task]');
  if (card) openTask(Number(card.dataset.openTask));
});

// ---------- task detail modal ----------
const modalHost = document.getElementById('modalHost');

async function openTask(id) {
  const t = await API.get(`/api/tasks/${id}`);
  const isDone = ['COMPLETED', 'CANCELLED'].includes(t.status);
  const report = t.status === 'COMPLETED' ? await API.get(`/api/tasks/${id}/report`) : null;
  const onDuty = state.agents.filter(a => a.on_duty);
  const assignedIds = t.assignments.map(a => a.agent_id);

  modalHost.innerHTML = `<div class="modal-back" id="modalBack"><div class="modal">
    <div class="row spread">
      <h2 style="margin:0">Task #${t.id} — ${esc(t.passenger_name)}</h2>
      <button id="closeModal">✕ Close</button>
    </div>
    <div class="row mt">
      <span class="badge blue">${esc(t.flight_number || '')} ${t.flight_direction}</span>
      <span class="badge">${esc(t.ssr_code)} · ${esc(t.wheelchair_type)}</span>
      <span class="badge ${t.priority === 'NORMAL' ? '' : t.priority === 'URGENT' ? 'red' : 'amber'}">${t.priority}</span>
      <span class="badge">${STATUS_LABELS[t.status]}</span>
      ${slaPill(t)}
    </div>
    ${t.passenger_notes ? `<p class="small" style="color:#fcd34d">📝 ${esc(t.passenger_notes)}</p>` : ''}

    <div class="row mt" style="align-items:flex-start">
      <div class="grow" style="min-width:280px">
        <h3 class="small muted" style="text-transform:uppercase">Journey</h3>
        <p>${t.storage ? `<b>${esc(t.storage.name)}</b> → ` : ''}<b>${esc(t.pickup.name)}</b> → <b>${esc(t.destination.name)}</b></p>
        <p class="small muted">Template estimate: <b>${fmtMin(t.template_est_minutes)}</b> ·
          Admin estimate: <b>${fmtMin(t.admin_est_minutes)}</b> ·
          SLA target: <b>${t.sla_target_minutes} min</b></p>

        <h3 class="small muted mt" style="text-transform:uppercase">Timeline</h3>
        <div class="timeline">${t.events.map(ev => `
          <div class="ev ${['PROBLEM_REPORTED', 'ESCALATED'].includes(ev.type) ? 'problem' : ''}">
            <b>${STATUS_LABELS[ev.type] || ev.type.replaceAll('_', ' ')}</b>
            <span class="muted small">${fmtTime(ev.server_time)} · ${esc(ev.agent_name || 'system')}</span>
            ${ev.note ? `<div class="small" style="color:#fcd34d">${esc(ev.note)}</div>` : ''}
          </div>`).join('') || '<div class="muted small">No events yet</div>'}
        </div>

        ${report ? `
          <h3 class="small muted mt" style="text-transform:uppercase">Result</h3>
          <div class="stats">
            <div class="card stat"><div class="k">Total time</div><div class="v">${fmtMin(report.totals.total_minutes)}</div></div>
            <div class="card stat"><div class="k">Passenger wait</div><div class="v">${fmtMin(report.totals.passenger_wait_minutes)}</div></div>
            <div class="card stat"><div class="k">Transit</div><div class="v">${fmtMin(report.totals.transit_minutes)}</div></div>
            <div class="card stat"><div class="k">Distance</div><div class="v">${report.totals.distance_meters} m</div></div>
          </div>
          <p class="small muted">Estimate vs actual: template ${fmtMin(report.totals.template_est_minutes)},
            admin ${fmtMin(report.totals.admin_est_minutes)}, actual ${fmtMin(report.totals.total_minutes)}.</p>` : ''}
      </div>

      <div style="width:360px; max-width:100%">
        <div class="map-wrap" id="taskMap"></div>
        ${!isDone ? `
          <h3 class="small muted mt" style="text-transform:uppercase">Assign agents</h3>
          <select id="assignSelect" multiple size="4">
            ${state.agents.map(a => `<option value="${a.id}" ${assignedIds.includes(a.id) ? 'selected disabled' : ''}>
              ${esc(a.name)} ${a.on_duty ? '🟢 on duty' : '⚪ off duty'}</option>`).join('')}
          </select>
          <div class="row mt">
            <button class="primary grow" id="assignBtn">Assign selected</button>
            <button class="danger" id="cancelBtn">Cancel task…</button>
          </div>
          ${onDuty.length === 0 ? '<p class="small" style="color:#fcd34d">No agents on duty right now.</p>' : ''}
        ` : ''}
      </div>
    </div>
  </div></div>`;

  // map: planned legs + actual GPS route
  const lines = [];
  if (t.storage) lines.push({ from: t.storage, to: t.pickup, color: '#a78bfa' });
  lines.push({ from: t.pickup, to: t.destination, color: '#3b82f6' });
  renderMap(document.getElementById('taskMap'), {
    locations: state.locations,
    lines,
    routes: t.trackpoints?.length ? [{ points: t.trackpoints, color: '#22c55e' }] : [],
    highlight: [t.storage?.code, t.pickup.code, t.destination.code].filter(Boolean),
  });

  document.getElementById('closeModal').onclick = close;
  document.getElementById('modalBack').onclick = e => { if (e.target.id === 'modalBack') close(); };
  function close() { modalHost.innerHTML = ''; }

  const assignBtn = document.getElementById('assignBtn');
  if (assignBtn) assignBtn.onclick = async () => {
    const ids = [...document.getElementById('assignSelect').selectedOptions]
      .filter(o => !o.disabled).map(o => Number(o.value));
    if (!ids.length) return toast('Select at least one agent', true);
    try {
      const updated = await API.post(`/api/tasks/${t.id}/assign`, { agent_ids: ids });
      state.tasks.set(updated.id, updated);
      toast('Agent(s) assigned');
      close(); render();
    } catch (ex) { toast(ex.message, true); }
  };

  const cancelBtn = document.getElementById('cancelBtn');
  if (cancelBtn) cancelBtn.onclick = async () => {
    const reason = prompt('Cancel reason (required):');
    if (!reason) return;
    try {
      const updated = await API.post(`/api/tasks/${t.id}/cancel`, { reason });
      state.tasks.set(updated.id, updated);
      toast('Task cancelled');
      close(); render();
    } catch (ex) { toast(ex.message, true); }
  };
}

// ---------- new task ----------
function locOptions(types = null, includeEmpty = false) {
  const locs = state.locations.filter(l => !types || types.includes(l.type));
  return (includeEmpty ? '<option value="">— none (no storage chair needed) —</option>' : '') +
    locs.map(l => `<option value="${l.id}">${esc(l.code)} — ${esc(l.name)}</option>`).join('');
}

function renderNew() {
  page.innerHTML = `<div class="card" style="max-width:680px; margin:0 auto">
    <h2>New assistance task</h2>
    <form id="newTask">
      <div class="row">
        <div class="grow"><label>Passenger name *</label><input name="passenger_name" required></div>
        <div><label>SSR code</label>
          <select name="ssr_code">
            <option>WCHR</option><option>WCHS</option><option>WCHC</option><option>DPNA</option>
          </select></div>
        <div><label>Wheelchair</label>
          <select name="wheelchair_type">
            <option>MANUAL</option><option>ELECTRIC</option><option>AISLE</option>
            <option>OWN_CHAIR</option><option>CART</option>
          </select></div>
      </div>
      <div class="row">
        <div class="grow"><label>Flight number</label><input name="flight_number" placeholder="EK202"></div>
        <div><label>Direction *</label>
          <select name="flight_direction" id="dirSelect">
            <option>ARRIVAL</option><option>DEPARTURE</option><option>TRANSFER</option>
          </select></div>
        <div><label>Priority</label>
          <select name="priority"><option>NORMAL</option><option>HIGH</option><option>URGENT</option></select></div>
      </div>
      <label>Wheelchair storage (optional)</label>
      <select name="storage_id" id="storageSel">${locOptions(['STORAGE'], true)}</select>
      <div class="row">
        <div class="grow"><label>Pickup point *</label><select name="pickup_id" id="pickupSel" required>${locOptions()}</select></div>
        <div class="grow"><label>Destination *</label><select name="destination_id" id="destSel" required>${locOptions()}</select></div>
      </div>
      <div class="card mt" id="estBox" style="background:var(--panel-2)">
        <span class="muted small">Estimated time appears here when you choose the route.</span>
      </div>
      <div class="row">
        <div class="grow"><label>Your estimate (min)</label><input name="admin_est_minutes" id="adminEst" type="number" min="1" step="0.5"></div>
        <div class="grow"><label>SLA target (min)</label><input name="sla_target_minutes" id="slaTarget" type="number" min="0" value="20"></div>
      </div>
      <label>Notes for the agent</label>
      <textarea name="passenger_notes" rows="2" placeholder="e.g. passenger is deaf; travelling with infant; needs 2-person lift"></textarea>
      <label>Assign now (optional)</label>
      <select name="agent_id">
        <option value="">— assign later —</option>
        ${state.agents.map(a => `<option value="${a.id}">${esc(a.name)} ${a.on_duty ? '🟢' : '⚪'}</option>`).join('')}
      </select>
      <button class="primary mt" style="width:100%; padding:13px" type="submit">Create task</button>
    </form>
  </div>`;

  const dirSel = document.getElementById('dirSelect');
  dirSel.onchange = () => {
    document.getElementById('slaTarget').value =
      { ARRIVAL: 20, DEPARTURE: 30, TRANSFER: 30 }[dirSel.value];
  };

  async function refreshEstimate() {
    const s = document.getElementById('storageSel').value;
    const p = document.getElementById('pickupSel').value;
    const d = document.getElementById('destSel').value;
    if (!p || !d || p === d) return;
    const est = await API.get(`/api/estimate?storage=${s || ''}&pickup=${p}&destination=${d}`);
    const box = document.getElementById('estBox');
    if (est.total_minutes == null) {
      box.innerHTML = '<span class="muted small">No estimate available for this route.</span>';
      return;
    }
    box.innerHTML = `<b>Template estimate: ${est.total_minutes} min</b>
      <div class="small muted">${est.legs.map(l =>
        `${l.name.replaceAll('_', ' ')}: ${l.minutes ?? '?'} min (${l.source || 'n/a'})`).join(' · ')}</div>`;
    const adminEst = document.getElementById('adminEst');
    if (!adminEst.value) adminEst.placeholder = est.total_minutes;
  }
  for (const id of ['storageSel', 'pickupSel', 'destSel'])
    document.getElementById(id).addEventListener('change', () => refreshEstimate().catch(() => {}));

  document.getElementById('newTask').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    for (const k of ['storage_id', 'pickup_id', 'destination_id'])
      body[k] = body[k] ? Number(body[k]) : null;
    if (body.pickup_id === body.destination_id) return toast('Pickup and destination must differ', true);
    if (body.admin_est_minutes) body.admin_est_minutes = Number(body.admin_est_minutes);
    else delete body.admin_est_minutes;
    body.sla_target_minutes = Number(body.sla_target_minutes);
    if (body.agent_id) body.agent_ids = [Number(body.agent_id)];
    delete body.agent_id;
    try {
      const t = await API.post('/api/tasks', body);
      state.tasks.set(t.id, t);
      toast(`Task #${t.id} created${t.assignments.length ? ' and assigned' : ''}`);
      state.tab = 'board';
      document.querySelectorAll('#tabs button').forEach(x =>
        x.classList.toggle('active', x.dataset.tab === 'board'));
      render();
    } catch (ex) { toast(ex.message, true); }
  });
}

// ---------- map tab ----------
async function renderMapTab() {
  page.innerHTML = `<div class="map-wrap" id="bigMap"></div>
    <p class="muted small mt">🟢 agents on duty · dashed lines = planned legs of active tasks · solid green = recorded GPS routes</p>`;
  const active = [...state.tasks.values()]
    .filter(t => !['COMPLETED', 'CANCELLED', 'CREATED'].includes(t.status));
  const details = await Promise.all(active.slice(0, 12).map(t => API.get(`/api/tasks/${t.id}`)));
  const lines = [], routes = [], highlight = [];
  for (const t of details) {
    if (t.storage) lines.push({ from: t.storage, to: t.pickup, color: '#a78bfa' });
    lines.push({ from: t.pickup, to: t.destination, color: '#3b82f6' });
    highlight.push(t.pickup.code, t.destination.code);
    if (t.trackpoints?.length) routes.push({ points: t.trackpoints, color: '#22c55e' });
  }
  renderMap(document.getElementById('bigMap'), {
    locations: state.locations,
    agents: state.agents.filter(a => a.on_duty),
    lines, routes, highlight,
  });
}

// ---------- templates ----------
function renderTemplates() {
  page.innerHTML = `<div class="card">
    <div class="row spread"><h2>Route time templates</h2>
      <span class="muted small">Values marked <span class="badge purple">learned</span> are auto-tuned from the median of real completed tasks (after 5 samples).</span>
    </div>
    <table><thead><tr><th>From</th><th>To</th><th>Usual time (min)</th><th>Samples</th><th>Source</th><th></th></tr></thead>
    <tbody>
      ${state.templates.map(t => `<tr>
        <td>${esc(t.from_code)} <span class="muted small">${esc(t.from_name)}</span></td>
        <td>${esc(t.to_code)} <span class="muted small">${esc(t.to_name)}</span></td>
        <td><input style="width:90px" type="number" step="0.5" min="0.5" value="${t.est_minutes}" data-tpl="${t.id}"></td>
        <td>${t.sample_count}</td>
        <td>${t.manually_set ? '<span class="badge">manual</span>' : '<span class="badge purple">learned</span>'}</td>
        <td><button data-save-tpl="${t.id}" data-from="${t.from_id}" data-to="${t.to_id}">Save</button></td>
      </tr>`).join('')}
      <tr>
        <td><select id="newFrom">${locOptions()}</select></td>
        <td><select id="newTo">${locOptions()}</select></td>
        <td><input id="newMin" style="width:90px" type="number" step="0.5" min="0.5" placeholder="min"></td>
        <td colspan="2" class="muted small">add a new route</td>
        <td><button class="primary" id="addTpl">Add</button></td>
      </tr>
    </tbody></table>
  </div>`;

  page.querySelectorAll('[data-save-tpl]').forEach(btn => btn.onclick = async () => {
    const input = page.querySelector(`input[data-tpl="${btn.dataset.saveTpl}"]`);
    try {
      await API.put('/api/templates', {
        from_id: Number(btn.dataset.from), to_id: Number(btn.dataset.to),
        est_minutes: Number(input.value),
      });
      toast('Template updated');
      state.templates = await API.get('/api/templates');
      render();
    } catch (ex) { toast(ex.message, true); }
  });

  document.getElementById('addTpl').onclick = async () => {
    try {
      await API.put('/api/templates', {
        from_id: Number(document.getElementById('newFrom').value),
        to_id: Number(document.getElementById('newTo').value),
        est_minutes: Number(document.getElementById('newMin').value),
      });
      toast('Template added');
      state.templates = await API.get('/api/templates');
      render();
    } catch (ex) { toast(ex.message, true); }
  };
}

// ---------- reports ----------
async function renderReports() {
  const { from, to } = state.reportRange;
  page.innerHTML = `<div class="row">
      <div><label>From</label><input type="date" id="repFrom" value="${from}"></div>
      <div><label>To</label><input type="date" id="repTo" value="${to}"></div>
      <div style="align-self:flex-end"><button class="primary" id="repLoad">Load</button></div>
      <div style="align-self:flex-end"><button id="repCsv">Export CSV</button></div>
    </div>
    <div id="repBody" class="mt"><span class="muted">Loading…</span></div>`;

  document.getElementById('repLoad').onclick = () => {
    state.reportRange = {
      from: document.getElementById('repFrom').value,
      to: document.getElementById('repTo').value,
    };
    renderReports();
  };

  const s = await API.get(`/api/reports/summary?from=${from}&to=${to}`);
  state.summary = s;
  const T = s.totals;
  document.getElementById('repBody').innerHTML = `
    <div class="stats">
      <div class="card stat"><div class="k">Tasks created</div><div class="v">${T.created}</div></div>
      <div class="card stat"><div class="k">Completed</div><div class="v">${T.completed}</div></div>
      <div class="card stat"><div class="k">SLA compliance</div>
        <div class="v" style="color:${T.sla_compliance_pct >= 90 ? 'var(--green)' : T.sla_compliance_pct >= 70 ? 'var(--amber)' : 'var(--red)'}">
        ${T.sla_compliance_pct ?? '—'}%</div></div>
      <div class="card stat"><div class="k">Avg duration</div><div class="v">${fmtMin(T.avg_duration_minutes)}</div></div>
      <div class="card stat"><div class="k">Median duration</div><div class="v">${fmtMin(T.median_duration_minutes)}</div></div>
      <div class="card stat"><div class="k">Cancelled</div><div class="v">${T.cancelled}</div></div>
    </div>
    <div class="row mt" style="align-items:flex-start">
      <div class="card grow" style="min-width:320px">
        <h3>Per agent</h3>
        <table><thead><tr><th>Agent</th><th>Assigned</th><th>Completed</th><th>Distance</th></tr></thead>
        <tbody>${s.per_agent.map(a => `<tr><td>${esc(a.name)}</td><td>${a.tasks_assigned}</td>
          <td>${a.tasks_completed}</td><td>${a.distance_meters ? (a.distance_meters / 1000).toFixed(1) + ' km' : '—'}</td></tr>`).join('')
          || '<tr><td colspan="4" class="muted">No data</td></tr>'}</tbody></table>
      </div>
      <div class="card grow" style="min-width:320px">
        <h3>Per route (template vs reality)</h3>
        <table><thead><tr><th>Route</th><th>Usual time</th><th>Samples</th><th>In period</th><th>Source</th></tr></thead>
        <tbody>${s.per_route.map(r => `<tr><td>${esc(r.from_code)} → ${esc(r.to_code)}</td>
          <td>${fmtMin(r.est_minutes)}</td><td>${r.sample_count}</td><td>${r.actuals_in_period}</td>
          <td>${r.manually_set ? 'manual' : '<span class="badge purple">learned</span>'}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>`;

  document.getElementById('repCsv').onclick = () => {
    if (!state.summary) return;
    const rows = [['agent', 'tasks_assigned', 'tasks_completed', 'distance_meters'],
      ...state.summary.per_agent.map(a => [a.name, a.tasks_assigned, a.tasks_completed, a.distance_meters])];
    const csv = rows.map(r => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `aeroassist-report-${from}-${to}.csv`;
    a.click();
  };
}

// ---------- team ----------
function renderTeam() {
  page.innerHTML = `<div class="stats">${state.agents.map(a => `
    <div class="card">
      <div class="row spread"><b>${esc(a.name)}</b>
        <span class="badge ${a.on_duty ? 'green' : ''}">${a.on_duty ? 'ON DUTY' : 'off duty'}</span></div>
      <div class="muted small mt">@${esc(a.username)}
        ${a.skills.length ? '· ' + a.skills.join(', ') : ''}</div>
      <div class="muted small">Last seen: ${a.last_seen ? fmtTime(a.last_seen) : 'never'}</div>
    </div>`).join('')}</div>`;
}

// ---------- boot ----------
await loadAll();
render();
