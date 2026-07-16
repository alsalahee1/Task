// Agent mobile app: shift, task queue, one-tap stage progression,
// GPS breadcrumbs, and an offline-tolerant send queue.
import { API, toast, esc, fmtTime, fmtMin, STATUS_LABELS, slaPill } from '/assets/api.js';

const me = API.requireRole('AGENT');
const app = document.getElementById('app');

const state = {
  view: 'home',          // 'home' | 'task'
  taskId: null,
  tasks: [],
  onDuty: false,
  online: navigator.onLine,
};

// ---------------- offline queue ----------------
// Stage taps and GPS batches are queued in localStorage and retried, so the app
// keeps working through terminal dead zones. Event uuids make retries idempotent.
const QKEY = 'aero_queue';
const loadQ = () => JSON.parse(localStorage.getItem(QKEY) || '[]');
const saveQ = q => localStorage.setItem(QKEY, JSON.stringify(q));

function enqueue(path, body) {
  const q = loadQ();
  q.push({ path, body });
  saveQ(q);
}

async function flushQueue() {
  let q = loadQ();
  while (q.length) {
    try {
      await API.post(q[0].path, q[0].body);
      q.shift();
      saveQ(q);
    } catch (ex) {
      if (String(ex.message).startsWith('Out of order') || String(ex.message).includes('no stage event')) {
        q.shift(); saveQ(q); continue; // stale queued event; drop it
      }
      break; // still offline / server unreachable — retry next cycle
    }
  }
  const wasOffline = !state.online;
  state.online = navigator.onLine && loadQ().length === 0;
  if (wasOffline !== !state.online) render();
}
setInterval(flushQueue, 5000);
addEventListener('online', flushQueue);

async function send(path, body) {
  try {
    await API.post(path, body);
    state.online = true;
  } catch (ex) {
    if (ex.message.includes('HTTP') || ex instanceof TypeError || ex.message.includes('fetch')) {
      enqueue(path, body);
      state.online = false;
      toast('Offline — action saved, will sync automatically');
    } else {
      throw ex; // real validation error
    }
  }
}

// ---------------- GPS breadcrumbs ----------------
let gpsWatch = null, gpsBuffer = [];

function activeTask() {
  return state.tasks.find(t =>
    !['COMPLETED', 'CANCELLED', 'CREATED', 'ASSIGNED'].includes(t.status));
}

function startGps() {
  if (gpsWatch != null || !navigator.geolocation) return;
  gpsWatch = navigator.geolocation.watchPosition(pos => {
    gpsBuffer.push({
      lat: pos.coords.latitude, lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy, recorded_at: new Date().toISOString(),
    });
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}
function stopGps() {
  if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
}
setInterval(() => {
  const t = activeTask();
  if (t) startGps(); else stopGps();
  if (t && gpsBuffer.length) {
    const points = gpsBuffer.splice(0);
    send(`/api/tasks/${t.id}/trackpoints`, { points }).catch(() => {});
  }
}, 10000);

function lastFix() {
  return gpsBuffer.at(-1) || null;
}

// ---------------- data ----------------
async function refresh() {
  try {
    const [meNow, tasks] = await Promise.all([API.get('/api/me'), API.get('/api/tasks?active=1')]);
    state.onDuty = meNow.on_duty;
    state.tasks = tasks;
    state.online = true;
  } catch { state.online = false; }
  render();
}

API.stream({
  task: t => {
    const i = state.tasks.findIndex(x => x.id === t.id);
    if (['COMPLETED', 'CANCELLED'].includes(t.status)) {
      if (i >= 0 && state.taskId !== t.id) state.tasks.splice(i, 1);
      else if (i >= 0) state.tasks[i] = t;
    } else if (i >= 0) state.tasks[i] = t;
    else state.tasks.push(t);
    render();
    if (t.status === 'ASSIGNED' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  },
});

// task elapsed timer + SLA pills tick
setInterval(() => {
  const el = document.getElementById('elapsed');
  if (el && el.dataset.since) {
    const s = Math.floor((Date.now() - new Date(el.dataset.since)) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  for (const pill of document.querySelectorAll('[data-sla-task]')) {
    const t = state.tasks.find(x => x.id === Number(pill.dataset.slaTask));
    if (t) pill.innerHTML = slaPill(t);
  }
}, 1000);

// ---------------- views ----------------
const STAGE_ORDER = ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED',
  'ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP', 'IN_TRANSIT', 'PASSENGER_DELIVERED', 'COMPLETED'];

function stepper(t) {
  const stages = STAGE_ORDER.filter(s =>
    t.storage || !['EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED'].includes(s));
  const cur = stages.indexOf(t.status);
  return `<div class="stepper">${stages.map((s, i) =>
    `<div class="step ${i < cur ? 'done' : i === cur ? 'current' : ''}" title="${STATUS_LABELS[s]}"></div>`
  ).join('')}</div>`;
}

function render() {
  if (state.view === 'task' && state.taskId) return renderTask();
  renderHome();
}

function renderHome() {
  const sorted = [...state.tasks].sort((a, b) => {
    const p = { URGENT: 0, HIGH: 1, NORMAL: 2 };
    return (p[a.priority] - p[b.priority]) || (new Date(a.sla_deadline_at) - new Date(b.sla_deadline_at));
  });
  app.innerHTML = `
    ${!state.online ? '<div class="offline-banner">📡 Offline — actions are queued and will sync</div>' : ''}
    <div class="row spread">
      <div><h2 style="margin:0">Hi, ${esc(me.name.split(' ')[0])} 👋</h2>
        <span class="muted small">${state.tasks.length} active task(s)</span></div>
      <button id="logout" class="small">Sign out</button>
    </div>
    <div class="card mt">
      <div class="row spread">
        <div><b>${state.onDuty ? 'You are on duty' : 'You are off duty'}</b>
          <div class="muted small">${state.onDuty ? 'Dispatch can assign you tasks' : 'Go on duty to receive tasks'}</div></div>
        <button class="${state.onDuty ? 'danger' : 'primary'}" id="shiftBtn">
          ${state.onDuty ? 'End shift' : 'Start shift'}</button>
      </div>
    </div>
    <h3 class="mt">My tasks</h3>
    ${sorted.map(t => `
      <div class="card agent-task-card task-card" data-task="${t.id}">
        <div class="row spread">
          <span class="badge blue">${esc(t.flight_number || t.flight_direction)}</span>
          ${t.priority !== 'NORMAL' ? `<span class="badge ${t.priority === 'URGENT' ? 'red' : 'amber'}">${t.priority}</span>` : ''}
          <span class="grow"></span>
          <span data-sla-task="${t.id}">${slaPill(t)}</span>
        </div>
        <div class="route" style="font-size:17px; font-weight:700; margin:6px 0 2px">${esc(t.passenger_name)}</div>
        <div class="small muted">${t.storage ? `chair from <b>${esc(t.storage.code)}</b> · ` : ''}
          pickup <b>${esc(t.pickup?.code)}</b> → <b>${esc(t.destination?.code)}</b>
          · est ${fmtMin(t.admin_est_minutes)}</div>
        ${stepper(t)}
        <div class="row spread">
          <span class="stage-chip">● ${STATUS_LABELS[t.status]}</span>
          ${t.next_action ? `<span class="muted small">next: ${esc(t.next_action.label)}</span>` : ''}
        </div>
      </div>`).join('') ||
      '<div class="card muted" style="text-align:center; padding:32px">No active tasks.<br>New tasks appear here automatically.</div>'}
  `;
  document.getElementById('logout').onclick = () => API.logout();
  document.getElementById('shiftBtn').onclick = async () => {
    try {
      await API.post('/api/shift', { on_duty: !state.onDuty });
      state.onDuty = !state.onDuty;
      render();
    } catch (ex) { toast(ex.message, true); }
  };
  app.querySelectorAll('[data-task]').forEach(el => el.onclick = () => {
    state.view = 'task';
    state.taskId = Number(el.dataset.task);
    render();
  });
}

function renderTask() {
  const t = state.tasks.find(x => x.id === state.taskId);
  if (!t) { state.view = 'home'; return renderHome(); }
  const done = ['COMPLETED', 'CANCELLED'].includes(t.status);
  const since = t.created_at;

  app.innerHTML = `
    ${!state.online ? '<div class="offline-banner">📡 Offline — actions are queued and will sync</div>' : ''}
    <div class="row spread">
      <button id="back">← My tasks</button>
      <span data-sla-task="${t.id}">${slaPill(t)}</span>
    </div>
    <div class="card mt">
      <div class="row spread">
        <span class="badge blue">${esc(t.flight_number || '')} ${t.flight_direction}</span>
        <span class="badge">${esc(t.ssr_code)} · ${esc(t.wheelchair_type)}</span>
      </div>
      <h2 style="margin:10px 0 0">${esc(t.passenger_name)}</h2>
      ${t.passenger_notes ? `<p class="small" style="color:#fcd34d; margin:6px 0 0">📝 ${esc(t.passenger_notes)}</p>` : ''}
      ${stepper(t)}
      <div class="stage-chip" style="font-size:14px">● ${STATUS_LABELS[t.status]}</div>
      <div class="big-timer" id="elapsed" data-since="${since}">--:--</div>
      <div class="info-grid">
        ${t.storage ? `<div class="cell"><div class="k">Wheelchair from</div><div class="v">${esc(t.storage.code)} — ${esc(t.storage.name)}</div></div>` : ''}
        <div class="cell"><div class="k">Pickup</div><div class="v">${esc(t.pickup.code)} — ${esc(t.pickup.name)}</div></div>
        <div class="cell"><div class="k">Destination</div><div class="v">${esc(t.destination.code)} — ${esc(t.destination.name)}</div></div>
        <div class="cell"><div class="k">Estimated</div><div class="v">${fmtMin(t.admin_est_minutes)}</div></div>
      </div>
      ${t.next_action ? `<button class="big mt ${t.next_action.type === 'COMPLETED' ? 'green' : ''}" id="nextBtn">
        ${esc(t.next_action.label)}</button>` : ''}
      ${done ? `<div class="mt" style="text-align:center">
        <div style="font-size:40px">${t.status === 'COMPLETED' ? '✅' : '🚫'}</div>
        <b>${STATUS_LABELS[t.status]}</b>
        <div id="miniReport" class="muted small mt">Loading summary…</div></div>` : ''}
      ${!done ? `<div class="row mt">
        <button class="grow" id="problemBtn">⚠ Report problem</button>
      </div>` : ''}
    </div>`;

  document.getElementById('back').onclick = () => { state.view = 'home'; render(); };

  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) nextBtn.onclick = async () => {
    nextBtn.disabled = true;
    const fix = lastFix();
    const body = {
      type: t.next_action.type,
      uuid: crypto.randomUUID(),
      client_time: new Date().toISOString(),
      ...(fix ? { lat: fix.lat, lng: fix.lng } : {}),
    };
    try {
      await send(`/api/tasks/${t.id}/events`, body);
      // optimistic local update so the app works offline
      const stages = STAGE_ORDER.filter(s =>
        t.storage || !['EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED'].includes(s));
      t.status = t.next_action.type;
      const i = stages.indexOf(t.status);
      t.next_action = i >= 0 && i < stages.length - 1
        ? { type: stages[i + 1], label: nextLabel(stages[i + 1]) } : null;
      if (t.status === 'COMPLETED') toast('Task completed — great job! ✅');
      render();
    } catch (ex) {
      toast(ex.message, true);
      refresh();
    }
  };

  const problemBtn = document.getElementById('problemBtn');
  if (problemBtn) problemBtn.onclick = async () => {
    const note = prompt('Describe the problem (e.g. broken wheelchair, passenger not found, elevator out of service):');
    if (!note) return;
    await send(`/api/tasks/${t.id}/events`, {
      type: 'PROBLEM_REPORTED', uuid: crypto.randomUUID(),
      client_time: new Date().toISOString(), note,
    });
    toast('Problem reported to dispatch');
  };

  if (done && t.status === 'COMPLETED') {
    API.get(`/api/tasks/${t.id}/report`).then(r => {
      const el = document.getElementById('miniReport');
      if (el) el.innerHTML = `Total: <b>${fmtMin(r.totals.total_minutes)}</b>
        (estimate ${fmtMin(r.totals.admin_est_minutes)}) ·
        Distance: <b>${r.totals.distance_meters} m</b> ·
        SLA: <b>${r.totals.sla_state}</b>`;
    }).catch(() => {});
  }
}

function nextLabel(type) {
  return {
    ACCEPTED: 'Accept task', EN_ROUTE_TO_STORAGE: 'Heading to wheelchair storage',
    WHEELCHAIR_COLLECTED: 'Wheelchair collected', ARRIVED_AT_PICKUP: 'Arrived at pickup point',
    PASSENGER_PICKED_UP: 'Passenger picked up', IN_TRANSIT: 'Start moving to destination',
    PASSENGER_DELIVERED: 'Passenger delivered', COMPLETED: 'Complete task',
  }[type] || type;
}

// PWA service worker (best effort)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// boot
await refresh();
flushQueue();
