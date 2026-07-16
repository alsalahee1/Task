// Admin dispatcher dashboard.
import { API, toast, esc, fmtTime, fmtMin, slaPill } from '/assets/api.js';
import { renderMap, initMap, floorplanFor } from '/assets/map.js';
import { t as tr, statusLabel, applyDir, langToggle } from '/assets/i18n.js';

applyDir();
const user = API.requireRole('ADMIN');
document.getElementById('whoami').textContent = user.name;
document.getElementById('logout').onclick = () => API.logout();
langToggle(document.getElementById('langHost'));
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });

// ---------- state ----------
const state = {
  tab: 'board',
  tasks: new Map(),   // id -> task
  agents: [],
  locations: [],
  templates: [],
  flights: [],
  wheelchairs: [],
  summary: null,
  mapTerminal: '',   // '' = whole airport
  reportRange: { from: today(), to: today() },
};
function today() { return new Date().toISOString().slice(0, 10); }

async function loadAll() {
  const [tasks, agents, locations, templates, flights, wheelchairs] = await Promise.all([
    API.get(`/api/tasks?date=${today()}`), API.get('/api/agents'),
    API.get('/api/locations'), API.get('/api/templates'), API.get('/api/flights'),
    API.get('/api/wheelchairs'),
  ]);
  state.flights = flights;
  state.wheelchairs = wheelchairs;
  const active = await API.get('/api/tasks?active=1'); // include older still-active tasks
  state.tasks = new Map([...tasks, ...active].map(t => [t.id, t]));
  state.agents = agents;
  state.locations = locations;
  state.templates = templates;
}

// live updates
API.stream({
  task: t => { state.tasks.set(t.id, t); if (state.tab === 'board' || state.tab === 'map') render(); },
  flight: f => {
    const i = state.flights.findIndex(x => x.id === f.id);
    if (i >= 0) state.flights[i] = f; else state.flights.push(f);
    if (state.tab === 'flights') render();
  },
  wheelchair: w => {
    const i = state.wheelchairs.findIndex(x => x.id === w.id);
    if (i >= 0) state.wheelchairs[i] = w; else state.wheelchairs.push(w);
    if (state.tab === 'wheelchairs') render();
  },
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
  ({ board, new: renderNew, map: renderMapTab, flights: renderFlights,
     wheelchairs: renderWheelchairs, locations: renderLocations,
     templates: renderTemplates, reports: renderReports, team: renderTeam })[state.tab]();
}

// ---------- board ----------
const COLS = [
  ['col_unassigned', ['CREATED']],
  ['col_assigned', ['ASSIGNED', 'ACCEPTED']],
  ['col_progress', ['EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED', 'ARRIVED_AT_PICKUP',
    'PASSENGER_PICKED_UP', 'IN_TRANSIT', 'PASSENGER_DELIVERED']],
  ['col_completed', ['COMPLETED']],
  ['col_cancelled', ['CANCELLED']],
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
      <span class="badge">${statusLabel(t.status)}</span>
      <span class="muted small">${agents || tr('no_agent')}</span>
    </div>
  </div>`;
}

function board() {
  const tasks = [...state.tasks.values()].sort((a, b) => b.id - a.id);
  page.innerHTML = `<div class="board">` + COLS.map(([title, statuses]) => {
    const items = tasks.filter(t => statuses.includes(t.status));
    return `<div class="col"><h3>${tr(title)} <span>${items.length}</span></h3>
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
      <span class="badge">${statusLabel(t.status)}</span>
      ${slaPill(t)}
    </div>
    ${t.passenger_notes ? `<p class="small" style="color:#fcd34d">📝 ${esc(t.passenger_notes)}</p>` : ''}

    <div class="row mt" style="align-items:flex-start">
      <div class="grow" style="min-width:280px">
        <h3 class="small muted" style="text-transform:uppercase">Journey</h3>
        <p>${t.storage ? `<b>${esc(t.storage.name)}</b> → ` : ''}<b>${esc(t.pickup.name)}</b> → <b>${esc(t.destination.name)}</b>
          ${t.wheelchair ? `<span class="badge purple">♿ ${esc(t.wheelchair.qr_code)}</span>` : ''}</p>
        <p class="small muted">Template estimate: <b>${fmtMin(t.template_est_minutes)}</b> ·
          Admin estimate: <b>${fmtMin(t.admin_est_minutes)}</b> ·
          SLA target: <b>${t.sla_target_minutes} min</b></p>

        <h3 class="small muted mt" style="text-transform:uppercase">Timeline</h3>
        <div class="timeline">${t.events.map(ev => `
          <div class="ev ${['PROBLEM_REPORTED', 'ESCALATED', 'GATE_CHANGED'].includes(ev.type) ? 'problem' : ''}">
            <b>${statusLabel(ev.type)}</b>
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

        ${t.notifications?.length ? `
          <h3 class="small muted mt" style="text-transform:uppercase">${tr('sms_log')}</h3>
          ${t.notifications.map(n => `<div class="small" style="margin-bottom:6px">
            <span class="badge ${n.status === 'LOGGED' || n.status === 'SENT' ? 'green' : 'amber'}">${esc(n.status)}</span>
            <span class="muted">${fmtTime(n.created_at)} → ${esc(n.phone)}</span><br>${esc(n.message)}</div>`).join('')}` : ''}
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
            <button class="primary grow" id="assignBtn">${tr('assign_selected')}</button>
            <button class="danger" id="cancelBtn">${tr('cancel_task')}</button>
          </div>
          <button class="mt" style="width:100%" id="autoAssignBtn">${tr('auto_assign')}</button>
          ${onDuty.length === 0 ? '<p class="small" style="color:#fcd34d">No agents on duty right now.</p>' : ''}
        ` : ''}
      </div>
    </div>
  </div></div>`;

  // map: planned legs + actual GPS route
  const lines = [];
  if (t.storage) lines.push({ from: t.storage, to: t.pickup, color: '#8a7db8' });
  lines.push({ from: t.pickup, to: t.destination, color: '#c9a96a' });
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

  const autoBtn = document.getElementById('autoAssignBtn');
  if (autoBtn) autoBtn.onclick = async () => {
    try {
      const r = await API.post(`/api/tasks/${t.id}/autoassign`, {});
      state.tasks.set(r.task.id, r.task);
      toast(`Assigned to ${r.choice.agent.name} (${r.choice.distance_m} m away, ` +
        `${r.choice.active_tasks} active task(s))`);
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
        <div class="grow"><label>${tr('passenger_name')}</label><input name="passenger_name" required></div>
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
      <label>${tr('passenger_phone')}</label>
      <input name="passenger_phone" type="tel" placeholder="+971 50 123 4567">
      <div class="row">
        <div class="grow"><label>${tr('flight_number')}</label>
          <input name="flight_number" id="flightNum" placeholder="EK202" list="flightList">
          <datalist id="flightList">
            ${state.flights.map(f => `<option value="${esc(f.flight_number)}">${f.direction} · gate ${esc(f.gate?.code || '?')}</option>`).join('')}
          </datalist>
          <div class="small muted" id="flightInfo"></div></div>
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
      <label>${tr('assign_now')}</label>
      <select name="agent_id">
        <option value="">${tr('assign_later')}</option>
        <option value="auto">${tr('auto_assign_opt')}</option>
        ${state.agents.map(a => `<option value="${a.id}">${esc(a.name)} ${a.on_duty ? '🟢' : '⚪'}</option>`).join('')}
      </select>
      <button class="primary mt" style="width:100%; padding:13px" type="submit">${tr('create_task')}</button>
    </form>
  </div>`;

  const dirSel = document.getElementById('dirSelect');
  dirSel.onchange = () => {
    document.getElementById('slaTarget').value =
      { ARRIVAL: 20, DEPARTURE: 30, TRANSFER: 30 }[dirSel.value];
  };

  // Flight autofill: direction + gate (pickup for arrivals, destination for departures)
  document.getElementById('flightNum').addEventListener('change', async e => {
    const num = e.target.value.trim();
    const info = document.getElementById('flightInfo');
    info.textContent = '';
    if (!num) return;
    try {
      const f = await API.get(`/api/flights/lookup?number=${encodeURIComponent(num)}`);
      dirSel.value = f.direction;
      dirSel.onchange();
      if (f.gate) {
        const sel = f.direction === 'ARRIVAL'
          ? document.getElementById('pickupSel') : document.getElementById('destSel');
        sel.value = String(f.gate.id);
        sel.dispatchEvent(new Event('change'));
      }
      info.textContent = `✓ ${f.direction} · gate ${f.gate?.code || '?'} · ${f.status}` +
        (f.sched_time ? ` · ${new Date(f.sched_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');
    } catch { info.textContent = 'flight not in schedule — fill fields manually'; }
  });

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
    if (body.agent_id === 'auto') body.auto_assign = true;
    else if (body.agent_id) body.agent_ids = [Number(body.agent_id)];
    delete body.agent_id;
    try {
      const t = await API.post('/api/tasks', body);
      state.tasks.set(t.id, t);
      if (body.auto_assign && !t.auto_assign_result)
        toast(`Task #${t.id} created — no suitable agent on duty, assign manually`, true);
      else if (t.auto_assign_result)
        toast(`Task #${t.id} → ${t.auto_assign_result.agent.name} (${t.auto_assign_result.distance_m} m away)`);
      else toast(`Task #${t.id} created${t.assignments.length ? ' and assigned' : ''}`);
      state.tab = 'board';
      document.querySelectorAll('#tabs button').forEach(x =>
        x.classList.toggle('active', x.dataset.tab === 'board'));
      render();
    } catch (ex) { toast(ex.message, true); }
  });
}

// ---------- map tab ----------
function terminals() {
  return [...new Set(state.locations.map(l => l.terminal))].sort();
}

async function renderMapTab() {
  const terms = terminals();
  page.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <button class="${state.mapTerminal === '' ? 'primary' : ''}" data-map-term="">${tr('all_terminals')}</button>
      ${terms.map(t2 => `<button class="${state.mapTerminal === t2 ? 'primary' : ''}"
        data-map-term="${esc(t2)}">${esc(t2)}</button>`).join('')}
    </div>
    <div class="map-wrap" id="bigMap"></div>
    <p class="muted small mt">🟢 agents on duty · dashed lines = planned legs of active tasks · solid green = recorded GPS routes
      ${floorplanFor(state.mapTerminal) ? '' : ' · drop a floor-plan image at <code>web/assets/floorplan' +
        (state.mapTerminal ? '-' + esc(state.mapTerminal) : '') + '.png</code> to use it as this view\'s background'}</p>`;

  page.querySelectorAll('[data-map-term]').forEach(b => b.onclick = () => {
    state.mapTerminal = b.dataset.mapTerm;
    renderMapTab();
  });

  const term = state.mapTerminal;
  const locs = term ? state.locations.filter(l => l.terminal === term) : state.locations;

  // per-terminal view: zoom the viewport to that terminal's locations
  let viewport = null;
  if (term && locs.length) {
    const xs = locs.map(l => l.x), ys = locs.map(l => l.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const padX = Math.max((maxX - minX) * 0.15, 30), padY = Math.max((maxY - minY) * 0.15, 30);
    viewport = { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
  }

  const codes = new Set(locs.map(l => l.code));
  const active = [...state.tasks.values()]
    .filter(t => !['COMPLETED', 'CANCELLED', 'CREATED'].includes(t.status))
    .filter(t => !term || codes.has(t.pickup?.code) || codes.has(t.destination?.code));
  const details = await Promise.all(active.slice(0, 12).map(t => API.get(`/api/tasks/${t.id}`)));
  const lines = [], routes = [], highlight = [];
  for (const t of details) {
    if (t.storage) lines.push({ from: t.storage, to: t.pickup, color: '#8a7db8' });
    lines.push({ from: t.pickup, to: t.destination, color: '#c9a96a' });
    highlight.push(t.pickup.code, t.destination.code);
    if (t.trackpoints?.length) routes.push({ points: t.trackpoints, color: '#22c55e' });
  }
  renderMap(document.getElementById('bigMap'), {
    locations: locs,
    agents: state.agents.filter(a => a.on_duty),
    lines, routes, highlight,
    viewport,
    floorplan: floorplanFor(term),
  });
}

// ---------- flights ----------
const FLIGHT_STATUSES = ['ON_TIME', 'DELAYED', 'LANDED', 'BOARDING', 'DEPARTED', 'CANCELLED'];

function renderFlights() {
  const gates = state.locations.filter(l => l.type === 'GATE');
  page.innerHTML = `<div class="card">
    <div class="row spread"><h2>${tr('tab_flights')}</h2>
      <span class="muted small">Changing a gate automatically retargets every active task on that flight
      (arrivals: pickup point · departures: destination) and notifies passengers by SMS.</span></div>
    <table><thead><tr><th>Flight</th><th>Direction</th><th>Scheduled</th><th>Gate</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${state.flights.map(f => `<tr>
        <td><b>${esc(f.flight_number)}</b></td>
        <td>${f.direction}</td>
        <td>${f.sched_time ? new Date(f.sched_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
        <td><select data-fgate="${f.id}">
          ${gates.map(g => `<option value="${g.id}" ${g.id === f.gate?.id ? 'selected' : ''}>${esc(g.code)}</option>`).join('')}
        </select></td>
        <td><select data-fstatus="${f.id}">
          ${FLIGHT_STATUSES.map(st => `<option ${st === f.status ? 'selected' : ''}>${st}</option>`).join('')}
        </select></td>
        <td class="row">
          <button class="primary" data-fapply="${f.id}">Apply update</button>
          <button data-fssr="${f.id}">SSR list…</button>
        </td>
      </tr>
      <tr id="ssrRow-${f.id}" style="display:none"><td colspan="6">
        <div class="card" style="background:var(--panel-2)">
          <b>Airline SSR passenger list for ${esc(f.flight_number)}</b>
          <p class="muted small" style="margin:4px 0 8px">One passenger per line:
            <code>Name, SSR code, phone (optional)</code> — e.g. <code>Omar Farouk, WCHR, +97150...</code>.
            A task is created per passenger (${f.direction === 'ARRIVAL' ? 'gate → baggage claim' : 'check-in → gate'});
            duplicates are skipped.</p>
          <textarea data-ssrtext="${f.id}" rows="4" placeholder="Omar Farouk, WCHR, +971501234567&#10;Lina Haddad, WCHC"></textarea>
          <div class="row mt">
            <label class="row" style="margin:0; text-transform:none"><input type="checkbox" data-ssrauto="${f.id}" style="width:auto"> auto-assign agents</label>
            <span class="grow"></span>
            <button class="primary" data-ssrsend="${f.id}">Create tasks</button>
          </div>
        </div>
      </td></tr>`).join('')}
      <tr>
        <td><input id="nfNum" placeholder="XY123" style="width:110px"></td>
        <td><select id="nfDir"><option>ARRIVAL</option><option>DEPARTURE</option></select></td>
        <td><input id="nfTime" type="time"></td>
        <td><select id="nfGate">${gates.map(g => `<option value="${g.id}">${esc(g.code)}</option>`).join('')}</select></td>
        <td class="muted small">add flight</td>
        <td><button class="primary" id="nfAdd">Add</button></td>
      </tr>
    </tbody></table>
  </div>`;

  page.querySelectorAll('[data-fapply]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.fapply;
    try {
      const r = await API.post(`/api/flights/${id}/update`, {
        gate_id: Number(page.querySelector(`[data-fgate="${id}"]`).value),
        status: page.querySelector(`[data-fstatus="${id}"]`).value,
      });
      const i = state.flights.findIndex(x => x.id === Number(id));
      state.flights[i] = r.flight;
      toast(r.updated_tasks.length
        ? `Flight updated — ${r.updated_tasks.length} active task(s) retargeted to gate ${r.flight.gate.code}`
        : 'Flight updated');
      render();
    } catch (ex) { toast(ex.message, true); }
  });

  page.querySelectorAll('[data-fssr]').forEach(btn => btn.onclick = () => {
    const row = document.getElementById(`ssrRow-${btn.dataset.fssr}`);
    row.style.display = row.style.display === 'none' ? '' : 'none';
  });

  page.querySelectorAll('[data-ssrsend]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.ssrsend;
    const lines = page.querySelector(`[data-ssrtext="${id}"]`).value
      .split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return toast('Enter at least one passenger', true);
    const passengers = lines.map(l => {
      const [name, ssr, phone] = l.split(',').map(x => x.trim());
      return { name, ssr_code: (ssr || 'WCHR').toUpperCase(), phone: phone || null };
    });
    try {
      const r = await API.post(`/api/flights/${id}/ssrs`, {
        passengers, auto_assign: page.querySelector(`[data-ssrauto="${id}"]`).checked,
      });
      toast(`${r.created.length} task(s) created` +
        (r.skipped.length ? `, ${r.skipped.length} skipped (already exist)` : ''));
      const fresh = await API.get(`/api/tasks?date=${today()}`);
      for (const t of fresh) state.tasks.set(t.id, t);
      render();
    } catch (ex) { toast(ex.message, true); }
  });

  document.getElementById('nfAdd').onclick = async () => {
    const num = document.getElementById('nfNum').value.trim();
    if (!num) return toast('Flight number required', true);
    const time = document.getElementById('nfTime').value;
    const sched = time ? new Date(`${today()}T${time}:00`).toISOString() : null;
    try {
      await API.post('/api/flights', {
        flight_number: num, direction: document.getElementById('nfDir').value,
        gate_id: Number(document.getElementById('nfGate').value), sched_time: sched,
      });
      state.flights = await API.get('/api/flights');
      toast('Flight added');
      render();
    } catch (ex) { toast(ex.message, true); }
  };
}

// ---------- wheelchairs ----------
const CHAIR_BADGE = { AVAILABLE: 'green', IN_USE: 'blue', MAINTENANCE: 'amber' };

function renderWheelchairs() {
  const storages = state.locations.filter(l => l.type === 'STORAGE');
  const counts = {};
  for (const c of state.wheelchairs)
    if (c.status === 'AVAILABLE' && c.current_location)
      counts[c.current_location.code] = (counts[c.current_location.code] || 0) + 1;
  page.innerHTML = `
    <div class="stats" style="margin-bottom:14px">
      ${storages.map(st => `<div class="card stat">
        <div class="k">${esc(st.code)} — ${esc(st.name)}</div>
        <div class="v">${counts[st.code] || 0}</div>
        <div class="muted small">chairs available</div></div>`).join('')}
      <div class="card stat"><div class="k">In use now</div>
        <div class="v">${state.wheelchairs.filter(c => c.status === 'IN_USE').length}</div></div>
      <div class="card stat"><div class="k">In maintenance</div>
        <div class="v">${state.wheelchairs.filter(c => c.status === 'MAINTENANCE').length}</div></div>
    </div>
    <div class="card">
    <div class="row spread"><h2>${tr('tab_wheelchairs')}</h2>
      <span class="muted small">Agents scan the chair's QR label when collecting it —
      that links the chair to the task and tracks where every chair ends up.</span></div>
    <table><thead><tr><th>QR code</th><th>Type</th><th>Status</th><th>Location</th><th>On task</th><th></th></tr></thead>
    <tbody>
      ${state.wheelchairs.map(c => `<tr>
        <td><b>${esc(c.qr_code)}</b></td>
        <td>${esc(c.type)}</td>
        <td><span class="badge ${CHAIR_BADGE[c.status] || ''}">${esc(c.status)}</span></td>
        <td>${c.current_location ? esc(c.current_location.code) + ' — ' + esc(c.current_location.name)
             : c.status === 'IN_USE' ? '<span class="muted">with agent</span>' : '<span class="muted">unknown</span>'}</td>
        <td>${c.current_task_id ? `<a href="#" data-open-task="${c.current_task_id}">#${c.current_task_id}</a>` : '—'}</td>
        <td>${c.status !== 'IN_USE' ? `<button data-chair-toggle="${c.id}" data-next="${c.status === 'MAINTENANCE' ? 'AVAILABLE' : 'MAINTENANCE'}">
          ${c.status === 'MAINTENANCE' ? 'Back in service' : 'To maintenance'}</button>` : ''}</td>
      </tr>`).join('')}
      <tr>
        <td><input id="ncQr" placeholder="WC-S1-005" style="width:130px"></td>
        <td><select id="ncType"><option>MANUAL</option><option>ELECTRIC</option><option>AISLE</option><option>CART</option></select></td>
        <td colspan="2"><select id="ncStorage">${storages.map(st => `<option value="${st.id}">${esc(st.code)} — ${esc(st.name)}</option>`).join('')}</select></td>
        <td class="muted small">register chair</td>
        <td><button class="primary" id="ncAdd">Add</button></td>
      </tr>
    </tbody></table>
  </div>`;

  page.querySelectorAll('[data-chair-toggle]').forEach(btn => btn.onclick = async () => {
    try {
      await API.post(`/api/wheelchairs/${btn.dataset.chairToggle}/status`,
        { status: btn.dataset.next });
      state.wheelchairs = await API.get('/api/wheelchairs');
      toast('Wheelchair updated');
      render();
    } catch (ex) { toast(ex.message, true); }
  });

  document.getElementById('ncAdd').onclick = async () => {
    const qr = document.getElementById('ncQr').value.trim();
    if (!qr) return toast('QR code required', true);
    try {
      await API.post('/api/wheelchairs', {
        qr_code: qr, type: document.getElementById('ncType').value,
        home_storage_id: Number(document.getElementById('ncStorage').value),
      });
      state.wheelchairs = await API.get('/api/wheelchairs');
      toast('Wheelchair registered');
      render();
    } catch (ex) { toast(ex.message, true); }
  };
}

// ---------- locations (real-airport setup) ----------
const LOC_TYPES = ['GATE', 'CHECKIN', 'STORAGE', 'BAGGAGE', 'TAXI', 'TRANSFER_DESK', 'OTHER'];

function renderLocations() {
  page.innerHTML = `
    <div class="row" style="align-items:flex-start">
      <div class="card grow" style="min-width:420px">
        <h2>${tr('tab_locations')}</h2>
        <table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Terminal</th><th>GPS</th></tr></thead>
        <tbody>
          ${state.locations.map(l => `<tr>
            <td><b>${esc(l.code)}</b></td><td>${esc(l.name)}</td>
            <td><span class="badge">${esc(l.type)}</span></td><td>${esc(l.terminal)}</td>
            <td class="muted small">${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}</td>
          </tr>`).join('')}
          <tr>
            <td><input id="nlCode" placeholder="C12" style="width:70px"></td>
            <td><input id="nlName" placeholder="Gate C12"></td>
            <td><select id="nlType">${LOC_TYPES.map(t => `<option>${t}</option>`).join('')}</select></td>
            <td><input id="nlTerm" placeholder="T1" style="width:60px" value="T1"></td>
            <td class="row"><input id="nlLat" placeholder="lat" style="width:110px">
              <input id="nlLng" placeholder="lng" style="width:110px">
              <button class="primary" id="nlAdd">Add</button></td>
          </tr>
        </tbody></table>
        <p class="muted small">Tip: right-click any point in Google Maps (satellite view) and copy the
          coordinates shown — that is the lat/lng to paste here.</p>
      </div>
      <div class="card" style="width:480px; max-width:100%">
        <h3>Import real airport (JSON)</h3>
        <p class="small muted">Paste your full location list with real GPS coordinates.
          The map is automatically refitted to your airport, and existing codes are updated
          in place. Add <code>"replace": true</code> to also remove old demo locations
          that are not referenced anywhere. Optional <code>templates</code> seed the walking times
          (<code>both_ways</code> defaults to true). See
          <code>setup/airport-import.example.json</code> in the repository.</p>
        <textarea id="importJson" rows="14" spellcheck="false" style="font-family:monospace; font-size:12.5px"
          placeholder='{\n  "locations": [\n    {"code": "A1", "name": "Gate A1", "type": "GATE", "lat": 25.24851, "lng": 55.35262}\n  ],\n  "templates": [\n    {"from": "A1", "to": "BG1", "minutes": 12}\n  ]\n}'></textarea>
        <button class="primary mt" style="width:100%" id="importBtn">Import</button>
        <div class="small muted mt" id="importResult"></div>
      </div>
    </div>`;

  document.getElementById('nlAdd').onclick = async () => {
    try {
      await API.post('/api/locations', {
        code: document.getElementById('nlCode').value.trim(),
        name: document.getElementById('nlName').value.trim(),
        type: document.getElementById('nlType').value,
        terminal: document.getElementById('nlTerm').value.trim() || 'T1',
        lat: Number(document.getElementById('nlLat').value),
        lng: Number(document.getElementById('nlLng').value),
      });
      state.locations = await API.get('/api/locations');
      toast('Location added');
      render();
    } catch (ex) { toast(ex.message, true); }
  };

  document.getElementById('importBtn').onclick = async () => {
    let body;
    try { body = JSON.parse(document.getElementById('importJson').value); }
    catch { return toast('Invalid JSON — check the format', true); }
    try {
      const r = await API.post('/api/locations/import', body);
      document.getElementById('importResult').innerHTML =
        `✅ ${r.imported_locations} locations imported · ${r.seeded_templates} walking times seeded` +
        (r.removed_locations ? ` · ${r.removed_locations} old locations removed` : '') +
        (r.map_refitted ? ' · map projection refitted to your airport' : '');
      state.locations = await API.get('/api/locations');
      state.templates = await API.get('/api/templates');
      await initMap(API); // pick up the refitted projection
      toast('Airport imported');
    } catch (ex) { toast(ex.message, true); }
  };
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
await initMap(API, terminals());
render();
