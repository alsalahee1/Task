// Dispatch-room "TV wall": a big, auto-updating board for a wall screen.
// Reuses the logged-in admin/supervisor session and the live SSE stream.
import { API, esc, slaPill } from '/assets/api.js';
import { initTheme } from '/assets/theme.js';

initTheme();
API.requireRole('ADMIN', 'SUPERVISOR');

const tasks = new Map();
let agents = [];

const COLS = [
  ['Waiting', ['CREATED', 'ASSIGNED', 'ACCEPTED']],
  ['In progress', ['EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED', 'ARRIVED_AT_PICKUP',
    'PASSENGER_PICKED_UP', 'IN_TRANSIT', 'PASSENGER_DELIVERED']],
  ['Recently completed', ['COMPLETED']],
];

function slaClass(t) {
  if (['COMPLETED', 'CANCELLED'].includes(t.status) || t.sla_met != null) return '';
  const ms = new Date(t.sla_deadline_at) - Date.now();
  if (ms <= 0) return 'over';
  if (ms / (t.sla_target_minutes * 60000 || 1) <= 0.5) return 'at-risk';
  return '';
}

function render() {
  const all = [...tasks.values()];
  const active = all.filter(t => !['COMPLETED', 'CANCELLED'].includes(t.status));
  const atRisk = active.filter(t => slaClass(t)).length;
  const onDuty = agents.filter(a => a.on_duty && !a.on_break).length;
  const kpi = [
    ['Active requests', active.length, ''],
    ['At-risk / overdue', atRisk, atRisk ? 'color:var(--red)' : ''],
    ['Agents available', onDuty, ''],
    ['Completed today', all.filter(t => t.status === 'COMPLETED').length, 'color:var(--brand-green)'],
  ];
  document.getElementById('kpis').innerHTML = kpi.map(([k, v, s]) =>
    `<div class="kpi"><div class="k">${k}</div><div class="v" style="${s}">${v}</div></div>`).join('');

  document.getElementById('board').innerHTML = COLS.map(([title, statuses]) => {
    let items = all.filter(t => statuses.includes(t.status));
    if (title.startsWith('Recently')) items = items.sort((a, b) => b.id - a.id).slice(0, 6);
    else items = items.sort((a, b) => new Date(a.sla_deadline_at) - new Date(b.sla_deadline_at));
    return `<div class="wall-col"><h2>${title}<span>${items.length}</span></h2>
      <div class="cards">${items.map(t => `
        <div class="wall-card ${slaClass(t)}">
          <div class="row spread">
            <span class="badge blue">${esc(t.flight_number || t.flight_direction)}</span>
            ${t.priority !== 'NORMAL' ? `<span class="badge ${t.priority === 'URGENT' ? 'red' : 'amber'}">${t.priority}</span>` : ''}
            ${t.late_notification ? '<span class="badge amber">late notice</span>' : ''}
          </div>
          <div class="pax">${esc(t.passenger_name)}</div>
          <div class="route">${esc(t.pickup?.code || '')} → ${esc(t.destination?.code || '')}</div>
          <div class="foot">
            <span class="badge">${esc(t.assignments?.[0]?.agent_name?.split(' ')[0] || 'unassigned')}</span>
            <span class="sla" data-sla="${t.id}">${slaPill(t)}</span>
          </div>
        </div>`).join('') || '<div class="idle">—</div>'}</div></div>`;
  }).join('');
}

async function load() {
  const [active, agentsList] = await Promise.all([
    API.get('/api/tasks?active=1'), API.get('/api/agents'),
  ]);
  const todayDone = await API.get(`/api/tasks?date=${new Date().toISOString().slice(0, 10)}`);
  for (const t of [...active, ...todayDone]) tasks.set(t.id, t);
  agents = agentsList;
  render();
}

API.stream({
  task: t => { tasks.set(t.id, t); render(); },
  agent: a => { const i = agents.findIndex(x => x.id === a.id); if (i >= 0) agents[i] = a; else agents.push(a); render(); },
});

// tick clock + SLA pills every second
setInterval(() => {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  for (const el of document.querySelectorAll('[data-sla]')) {
    const t = tasks.get(Number(el.dataset.sla));
    if (t) el.innerHTML = slaPill(t);
  }
}, 1000);

await load();
