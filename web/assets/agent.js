// Agent mobile app: shift, task queue, one-tap stage progression,
// GPS breadcrumbs, and an offline-tolerant send queue.
import { API, toast, esc, fmtTime, fmtMin, slaPill } from '/assets/api.js';
import { t, statusLabel, actionLabel, applyDir, langToggle } from '/assets/i18n.js';

applyDir();
const i18nT = t;

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
      toast(i18nT('offline_saved'));
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
    `<div class="step ${i < cur ? 'done' : i === cur ? 'current' : ''}" title="${statusLabel(s)}"></div>`
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
    ${!state.online ? `<div class="offline-banner">${t('offline_note')}</div>` : ''}
    <div class="row spread">
      <div><h2 style="margin:0">${t('hi')}, ${esc(me.name.split(' ')[0])} 👋</h2>
        <span class="muted small">${state.tasks.length} ${t('active_tasks')}</span></div>
      <span id="langHost"></span>
      <button id="logout" class="small">${t('sign_out')}</button>
    </div>
    <div class="card mt">
      <div class="row spread">
        <div><b>${state.onDuty ? t('on_duty') : t('off_duty')}</b>
          <div class="muted small">${state.onDuty ? t('on_duty_hint') : t('off_duty_hint')}</div></div>
        <button class="${state.onDuty ? 'danger' : 'primary'}" id="shiftBtn">
          ${state.onDuty ? t('end_shift') : t('start_shift')}</button>
      </div>
    </div>
    <h3 class="mt">${t('my_tasks')}</h3>
    ${sorted.map(t => `
      <div class="card agent-task-card task-card" data-task="${t.id}">
        <div class="row spread">
          <span class="badge blue">${esc(t.flight_number || t.flight_direction)}</span>
          ${t.priority !== 'NORMAL' ? `<span class="badge ${t.priority === 'URGENT' ? 'red' : 'amber'}">${t.priority}</span>` : ''}
          <span class="grow"></span>
          <span data-sla-task="${t.id}">${slaPill(t)}</span>
        </div>
        <div class="route" style="font-size:17px; font-weight:700; margin:6px 0 2px">${esc(t.passenger_name)}</div>
        <div class="small muted">${t.storage ? `${i18nT('chair_from')} <b>${esc(t.storage.code)}</b> · ` : ''}
          ${i18nT('pickup_l')} <b>${esc(t.pickup?.code)}</b> → <b>${esc(t.destination?.code)}</b>
          · ${i18nT('est')} ${fmtMin(t.admin_est_minutes)}</div>
        ${stepper(t)}
        <div class="row spread">
          <span class="stage-chip">● ${statusLabel(t.status)}</span>
          ${t.next_action ? `<span class="muted small">${i18nT('next')}: ${esc(actionLabel(t.next_action.type))}</span>` : ''}
        </div>
      </div>`).join('') ||
      `<div class="card muted" style="text-align:center; padding:32px">${i18nT('no_tasks')}<br>${i18nT('tasks_appear')}</div>`}
  `;
  langToggle(document.getElementById('langHost'));
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
    ${!state.online ? `<div class="offline-banner">${i18nT('offline_note')}</div>` : ''}
    <div class="row spread">
      <button id="back">${i18nT('back_tasks')}</button>
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
      <div class="stage-chip" style="font-size:14px">● ${statusLabel(t.status)}</div>
      <div class="big-timer" id="elapsed" data-since="${since}">--:--</div>
      <div class="info-grid">
        ${t.storage ? `<div class="cell"><div class="k">${i18nT('wheelchair_from')}</div><div class="v">${esc(t.storage.code)} — ${esc(t.storage.name)}</div></div>` : ''}
        <div class="cell"><div class="k">${i18nT('pickup')}</div><div class="v">${esc(t.pickup.code)} — ${esc(t.pickup.name)}</div></div>
        <div class="cell"><div class="k">${i18nT('destination')}</div><div class="v">${esc(t.destination.code)} — ${esc(t.destination.name)}</div></div>
        <div class="cell"><div class="k">${i18nT('estimated')}</div><div class="v">${fmtMin(t.admin_est_minutes)}</div></div>
      </div>
      ${t.wheelchair ? `<div class="mt small"><span class="badge purple">♿ ${i18nT('chair')} ${esc(t.wheelchair.qr_code)}</span></div>` : ''}
      ${t.next_action?.type === 'WHEELCHAIR_COLLECTED' ? `
        <label>${i18nT('qr_label')}</label>
        <div class="row">
          <input id="qrInput" class="grow" placeholder="${i18nT('qr_placeholder')}"
            autocapitalize="characters" autocomplete="off">
          <button id="qrScanBtn">${i18nT('scan')}</button>
        </div>
        <div id="qrVideoWrap" style="display:none; margin-top:10px; border-radius:12px; overflow:hidden">
          <video id="qrVideo" playsinline style="width:100%; display:block"></video>
          <div class="small muted" style="text-align:center; padding:4px">${i18nT('scan_hint')}</div>
        </div>` : ''}
      ${t.next_action ? `<button class="big mt ${t.next_action.type === 'COMPLETED' ? 'green' : ''}" id="nextBtn">
        ${esc(actionLabel(t.next_action.type))}</button>` : ''}
      ${done ? `<div class="mt" style="text-align:center">
        <div style="font-size:40px">${t.status === 'COMPLETED' ? '✅' : '🚫'}</div>
        <b>${statusLabel(t.status)}</b>
        <div id="miniReport" class="muted small mt">Loading summary…</div></div>` : ''}
      ${!done ? `<div class="row mt">
        <button class="grow" id="problemBtn">${i18nT('report_problem')}</button>
      </div>` : ''}
    </div>`;

  document.getElementById('back').onclick = () => { stopQrScan(); state.view = 'home'; render(); };
  const qrScanBtn = document.getElementById('qrScanBtn');
  if (qrScanBtn) qrScanBtn.onclick = () => startQrScan();

  const nextBtn = document.getElementById('nextBtn');
  if (nextBtn) nextBtn.onclick = async () => {
    nextBtn.disabled = true;
    const fix = lastFix();
    const qr = document.getElementById('qrInput')?.value.trim();
    const body = {
      type: t.next_action.type,
      uuid: crypto.randomUUID(),
      client_time: new Date().toISOString(),
      ...(qr ? { wheelchair_qr: qr } : {}),
      ...(fix ? { lat: fix.lat, lng: fix.lng } : {}),
    };
    stopQrScan();
    try {
      await send(`/api/tasks/${t.id}/events`, body);
      // optimistic local update so the app works offline
      const stages = STAGE_ORDER.filter(s =>
        t.storage || !['EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED'].includes(s));
      t.status = t.next_action.type;
      const i = stages.indexOf(t.status);
      t.next_action = i >= 0 && i < stages.length - 1
        ? { type: stages[i + 1], label: actionLabel(stages[i + 1]) } : null;
      if (t.status === 'COMPLETED') toast(i18nT('task_done'));
      render();
    } catch (ex) {
      toast(ex.message, true);
      refresh();
    }
  };

  const problemBtn = document.getElementById('problemBtn');
  if (problemBtn) problemBtn.onclick = async () => {
    const note = prompt(i18nT('problem_prompt'));
    if (!note) return;
    await send(`/api/tasks/${t.id}/events`, {
      type: 'PROBLEM_REPORTED', uuid: crypto.randomUUID(),
      client_time: new Date().toISOString(), note,
    });
    toast(i18nT('problem_sent'));
  };

  if (done && t.status === 'COMPLETED') {
    API.get(`/api/tasks/${t.id}/report`).then(r => {
      const el = document.getElementById('miniReport');
      if (el) el.innerHTML = `${i18nT('total')}: <b>${fmtMin(r.totals.total_minutes)}</b>
        (${i18nT('estimate')} ${fmtMin(r.totals.admin_est_minutes)}) ·
        ${i18nT('distance')}: <b>${r.totals.distance_meters} m</b> ·
        SLA: <b>${r.totals.sla_state}</b>`;
    }).catch(() => {});
  }
}

// ---------------- camera QR scanning (BarcodeDetector, with manual fallback) ----------------
let qrStream = null, qrScanTimer = null;

function stopQrScan() {
  if (qrScanTimer) { clearInterval(qrScanTimer); qrScanTimer = null; }
  if (qrStream) { qrStream.getTracks().forEach(tr => tr.stop()); qrStream = null; }
  const wrap = document.getElementById('qrVideoWrap');
  if (wrap) wrap.style.display = 'none';
}

async function startQrScan() {
  const input = document.getElementById('qrInput');
  const video = document.getElementById('qrVideo');
  const wrap = document.getElementById('qrVideoWrap');
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    toast(i18nT('no_camera_qr'), true);
    input?.focus();
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code', 'code_128'] });
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = qrStream;
    await video.play();
    wrap.style.display = 'block';
    qrScanTimer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          input.value = codes[0].rawValue;
          if (navigator.vibrate) navigator.vibrate(100);
          stopQrScan();
        }
      } catch { /* frame not ready */ }
    }, 350);
  } catch {
    toast(i18nT('no_camera_qr'), true);
    stopQrScan();
    input?.focus();
  }
}

// PWA service worker (best effort)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// boot
await refresh();
flushQueue();
