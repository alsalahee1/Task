// AeroAssist server — zero-dependency Node.js (node:http + node:sqlite + SSE).
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, verifyPassword, hashPassword } from './db.js';
import { createNotifier } from './notify.js';
import {
  nextStage, validateEvent, stagesFor, STAGE_ACTION_LABELS,
  TERMINAL_STATUSES, LOG_ONLY_EVENTS,
} from './statemachine.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIR = join(ROOT, 'web');
const SLA_DEFAULTS = { ARRIVAL: 20, DEPARTURE: 30, TRANSFER: 30 };
const WALK_METERS_PER_MIN = 55; // pushing a wheelchair; used only when no template exists

export function createApp({ dbPath = join(ROOT, 'data', 'aeroassist.db') } = {}) {
  const db = openDb(dbPath);
  const now = () => new Date().toISOString();
  const notifier = createNotifier(db);

  // ---------- settings & map projection ----------
  const getSetting = k => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return row ? JSON.parse(row.value) : null;
  };
  const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, JSON.stringify(v));

  // Linear GPS↔map transform: x = ax·lng + bx, y = ay·lat + by (map is 1000×600).
  // Defaults match the demo seed; a real-airport import refits these from the data.
  const DEFAULT_MAP_REF = {
    ax: 1e5, bx: -5536000, ay: -1e5, by: 2525600, meters_per_unit: 1,
  };
  let mapRef = getSetting('map_ref');
  if (!mapRef) { mapRef = DEFAULT_MAP_REF; setSetting('map_ref', mapRef); }
  const llToXy = (lat, lng) => ({ x: mapRef.ax * lng + mapRef.bx, y: mapRef.ay * lat + mapRef.by });
  const xyToLl = (x, y) => ({ lng: (x - mapRef.bx) / mapRef.ax, lat: (y - mapRef.by) / mapRef.ay });

  // ---------- live updates (Server-Sent Events) ----------
  const sseClients = new Set(); // { res, user }
  function broadcast(event, payload, { agentIds = null } = {}) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of sseClients) {
      const isAdmin = c.user.role === 'ADMIN';
      const isTargetAgent = agentIds ? agentIds.includes(c.user.id) : c.user.role === 'AGENT';
      if (isAdmin || isTargetAgent) c.res.write(msg);
    }
  }

  // ---------- helpers ----------
  const getUserByToken = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`);
  const getLoc = db.prepare('SELECT * FROM locations WHERE id = ?');
  const getTemplate = db.prepare(
    'SELECT * FROM route_templates WHERE from_id = ? AND to_id = ?');

  function publicUser(u) {
    return {
      id: u.id, username: u.username, name: u.name, role: u.role,
      skills: JSON.parse(u.skills || '[]'), on_duty: !!u.on_duty, on_break: !!u.on_break,
      disabled: !!u.disabled, must_change_password: !!u.must_change_password,
      created_at: u.created_at,
      last_lat: u.last_lat, last_lng: u.last_lng, last_seen: u.last_seen,
    };
  }

  // ---------- session validation (sliding idle expiry + disabled check) ----------
  const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // sign back in after 12h idle
  function validateSession(token) {
    if (!token) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s) return null;
    const lastSeen = Date.parse(s.last_seen_at || s.created_at);
    if (Number.isFinite(lastSeen) && Date.now() - lastSeen > SESSION_IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!u || u.disabled) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(now(), token);
    return u;
  }

  // ---------- audit log ----------
  function audit(actor, action, target, detail) {
    db.prepare(
      `INSERT INTO audit_log (at, actor_id, actor_name, action, target, detail)
       VALUES (?,?,?,?,?,?)`)
      .run(now(), actor?.id ?? null, actor?.name ?? 'system', action,
        target ?? null, detail ?? null);
  }

  // ---------- login throttling (in-memory; per username+IP) ----------
  const loginAttempts = new Map(); // key -> { count, firstAt, lockUntil }
  const MAX_ATTEMPTS = 5, ATTEMPT_WINDOW_MS = 15 * 60 * 1000, LOCK_MS = 15 * 60 * 1000;
  function loginKey(username, ip) { return `${(username || '').toLowerCase()}|${ip}`; }
  function isLocked(key) {
    const a = loginAttempts.get(key);
    return a && a.lockUntil && a.lockUntil > Date.now();
  }
  function recordFailure(key) {
    const a = loginAttempts.get(key) || { count: 0, firstAt: Date.now(), lockUntil: 0 };
    if (Date.now() - a.firstAt > ATTEMPT_WINDOW_MS) { a.count = 0; a.firstAt = Date.now(); }
    a.count++;
    if (a.count >= MAX_ATTEMPTS) a.lockUntil = Date.now() + LOCK_MS;
    loginAttempts.set(key, a);
  }
  function clearFailures(key) { loginAttempts.delete(key); }

  function legEstimate(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return null;
    const tpl = getTemplate.get(fromId, toId);
    if (tpl) return { minutes: tpl.est_minutes, source: tpl.manually_set ? 'template' : 'learned' };
    const a = getLoc.get(fromId), b = getLoc.get(toId);
    if (!a || !b) return null;
    const meters = Math.hypot(a.x - b.x, a.y - b.y) * (mapRef.meters_per_unit || 1);
    return { minutes: Math.max(2, Math.round(meters / WALK_METERS_PER_MIN)), source: 'distance' };
  }

  function estimateTask(storageId, pickupId, destinationId) {
    const legs = [];
    if (storageId) legs.push({ name: 'storage_to_pickup', ...legEstimate(storageId, pickupId) });
    legs.push({ name: 'pickup_to_destination', ...legEstimate(pickupId, destinationId) });
    const valid = legs.filter(l => l.minutes != null);
    return {
      legs,
      total_minutes: valid.length ? Math.round(valid.reduce((s, l) => s + l.minutes, 0)) : null,
    };
  }

  function taskAssignments(taskId) {
    return db.prepare(
      `SELECT ta.agent_id, ta.role, ta.assigned_at, u.name AS agent_name
       FROM task_assignments ta JOIN users u ON u.id = ta.agent_id
       WHERE ta.task_id = ?`).all(taskId);
  }

  function taskEvents(taskId) {
    return db.prepare(
      `SELECT e.*, u.name AS agent_name FROM task_events e
       LEFT JOIN users u ON u.id = e.agent_id
       WHERE e.task_id = ? ORDER BY e.id`).all(taskId);
  }

  function slaState(task) {
    if (task.status === 'CANCELLED') return 'cancelled';
    if (task.sla_met === 1) return 'met';
    if (task.sla_met === 0) return 'breached';
    return new Date() >= new Date(task.sla_deadline_at) ? 'breached' : 'pending';
  }

  function locBrief(id) {
    if (!id) return null;
    const l = getLoc.get(id);
    return l && { id: l.id, code: l.code, name: l.name, type: l.type, x: l.x, y: l.y };
  }

  function chairBrief(id) {
    if (!id) return null;
    const c = db.prepare('SELECT * FROM wheelchairs WHERE id = ?').get(id);
    return c && { id: c.id, qr_code: c.qr_code, type: c.type, status: c.status };
  }

  // Late-notification: did the airline notify us too close to the flight? The lead
  // threshold (minutes before the flight) is configurable; default 120 min. This is
  // the evidence a handler uses to attribute an SLA breach to late airline notice.
  const lateThreshold = () => Number(getSetting('late_notification_minutes')) || 120;
  function lateNotificationFlag(flightTime, notifiedAt) {
    if (!flightTime || !notifiedAt) return 0;
    const leadMins = (Date.parse(flightTime) - Date.parse(notifiedAt)) / 60000;
    return Number.isFinite(leadMins) && leadMins < lateThreshold() ? 1 : 0;
  }

  // Airline code = the IATA prefix of the flight number (letters before the digits).
  function airlineOf(flightNumber) {
    if (!flightNumber) return '—';
    const m = String(flightNumber).trim().toUpperCase().match(/^([A-Z]{2,3})/);
    return m ? m[1] : '—';
  }

  function taskJson(task, { withEvents = false } = {}) {
    const next = nextStage(task);
    const out = {
      ...task,
      late_notification: !!task.late_notification,
      airline: airlineOf(task.flight_number),
      wheelchair: chairBrief(task.wheelchair_id),
      storage: locBrief(task.storage_id),
      pickup: locBrief(task.pickup_id),
      destination: locBrief(task.destination_id),
      assignments: taskAssignments(task.id),
      sla_state: slaState(task),
      next_action: next && { type: next, label: STAGE_ACTION_LABELS[next] },
      has_problem: !!db.prepare(
        `SELECT 1 FROM task_events WHERE task_id = ? AND type IN ('PROBLEM_REPORTED','ESCALATED') LIMIT 1`
      ).get(task.id),
    };
    if (withEvents) {
      out.events = taskEvents(task.id);
      out.trackpoints = db.prepare(
        'SELECT lat, lng, accuracy, recorded_at FROM trackpoints WHERE task_id = ? ORDER BY id'
      ).all(task.id);
      out.notifications = db.prepare(
        'SELECT phone, message, status, created_at FROM notifications WHERE task_id = ? ORDER BY id'
      ).all(task.id);
    }
    return out;
  }

  const getTask = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

  function pushTaskUpdate(taskId) {
    const t = getTask(taskId);
    if (!t) return;
    broadcast('task', taskJson(t), { agentIds: taskAssignments(taskId).map(a => a.agent_id) });
  }

  // ---------- template learning ----------
  function recordActual(fromId, toId, minutes) {
    if (!fromId || !toId || !(minutes > 0)) return;
    db.prepare('INSERT INTO route_actuals (from_id, to_id, minutes, completed_at) VALUES (?,?,?,?)')
      .run(fromId, toId, minutes, now());
    let tpl = getTemplate.get(fromId, toId);
    if (!tpl) {
      db.prepare(
        `INSERT INTO route_templates (from_id, to_id, est_minutes, sample_count, manually_set)
         VALUES (?,?,?,0,0)`).run(fromId, toId, Math.round(minutes * 10) / 10);
      tpl = getTemplate.get(fromId, toId);
    }
    const count = tpl.sample_count + 1;
    let est = tpl.est_minutes, learned = tpl.manually_set;
    if (count >= 5) {
      const last = db.prepare(
        `SELECT minutes FROM route_actuals WHERE from_id = ? AND to_id = ?
         ORDER BY id DESC LIMIT 20`).all(fromId, toId).map(r => r.minutes).sort((a, b) => a - b);
      const mid = Math.floor(last.length / 2);
      const median = last.length % 2 ? last[mid] : (last[mid - 1] + last[mid]) / 2;
      est = Math.round(median * 10) / 10;
      learned = 0;
    }
    db.prepare(
      'UPDATE route_templates SET sample_count = ?, est_minutes = ?, manually_set = ? WHERE id = ?')
      .run(count, est, learned, tpl.id);
  }

  function eventTime(taskId, type) {
    const r = db.prepare(
      'SELECT server_time FROM task_events WHERE task_id = ? AND type = ? ORDER BY id LIMIT 1'
    ).get(taskId, type);
    return r ? new Date(r.server_time) : null;
  }

  function minutesBetween(a, b) {
    return a && b ? Math.round(((b - a) / 60000) * 100) / 100 : null;
  }

  function onTaskCompleted(task) {
    db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(now(), task.id);
    const t = id => eventTime(task.id, id);
    if (task.storage_id) {
      const m = minutesBetween(t('EN_ROUTE_TO_STORAGE'), t('ARRIVED_AT_PICKUP'));
      recordActual(task.storage_id, task.pickup_id, m);
    }
    const transit = minutesBetween(t('PASSENGER_PICKED_UP'), t('PASSENGER_DELIVERED'));
    recordActual(task.pickup_id, task.destination_id, transit);
  }

  // ---------- auto-assignment ----------
  // Skill requirements implied by the request type.
  const SKILL_BY_CHAIR = { CART: 'ELECTRIC_CART', AISLE: 'AISLE_CHAIR' };
  const SKILL_BY_SSR = { WCHC: 'TWO_PERSON_LIFT' }; // fully immobile passenger

  function requiredSkills(task) {
    return [SKILL_BY_CHAIR[task.wheelchair_type], SKILL_BY_SSR[task.ssr_code]]
      .filter(Boolean);
  }

  function agentActiveTaskCount(agentId) {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
       WHERE ta.agent_id = ? AND t.status NOT IN ('COMPLETED','CANCELLED','CREATED')`)
      .get(agentId).n;
  }

  // Pick the best agent: must be on duty and have the required skills;
  // ranked by current workload first, then by distance to the task's start point.
  function pickBestAgent(task) {
    const start = getLoc.get(task.storage_id || task.pickup_id);
    const needs = requiredSkills(task);
    const candidates = db.prepare(
      `SELECT * FROM users WHERE role = 'AGENT' AND on_duty = 1 AND on_break = 0 AND disabled = 0`).all()
      .filter(a => {
        const skills = JSON.parse(a.skills || '[]');
        return needs.every(s => skills.includes(s));
      })
      .map(a => {
        const distance = a.last_lat != null && start
          ? Math.round(haversineMeters(
              { lat: a.last_lat, lng: a.last_lng }, { lat: start.lat, lng: start.lng }))
          : 800; // unknown position: assume "far side of the terminal"
        const load = agentActiveTaskCount(a.id);
        return { agent: a, distance_m: distance, active_tasks: load,
          score: load * 1000 + distance };
      })
      .sort((x, y) => x.score - y.score);
    return candidates[0] || null;
  }

  function autoAssign(task, byUser) {
    const best = pickBestAgent(task);
    if (!best) return null;
    assign(task, [best.agent.id], byUser);
    return {
      agent: publicUser(best.agent),
      distance_m: best.distance_m,
      active_tasks: best.active_tasks,
      required_skills: requiredSkills(task),
    };
  }

  // ---------- wheelchair fleet ----------
  const getChairByQr = db.prepare(
    'SELECT * FROM wheelchairs WHERE upper(qr_code) = upper(?)');

  function chairJson(c) {
    return {
      ...c,
      home_storage: locBrief(c.home_storage_id),
      current_location: locBrief(c.current_location_id),
    };
  }

  // Agent scanned a chair at collection: link it to the task and mark it in use.
  // An unknown code never blocks the task (offline queues must always drain) —
  // it is recorded on the event note for the dispatcher instead.
  function attachWheelchair(task, qr, agentId) {
    const chair = getChairByQr.get(qr);
    if (!chair) return { note: `Unregistered chair code: ${qr}` };
    db.prepare(
      `UPDATE wheelchairs SET status = 'IN_USE', current_task_id = ?, current_location_id = NULL
       WHERE id = ?`).run(task.id, chair.id);
    db.prepare('UPDATE tasks SET wheelchair_id = ? WHERE id = ?').run(chair.id, task.id);
    broadcast('wheelchair', chairJson(getChairByQr.get(qr)));
    const warn = chair.status !== 'AVAILABLE'
      ? ` (warning: chair was marked ${chair.status})` : '';
    return { note: `Chair ${chair.qr_code} collected${warn}` };
  }

  // Task finished: free the chair. Completed → it now sits at the destination;
  // cancelled → whereabouts unknown until it is scanned again or seen at storage.
  function releaseWheelchair(task, finalStatus) {
    if (!task.wheelchair_id) return;
    db.prepare(
      `UPDATE wheelchairs SET status = 'AVAILABLE', current_task_id = NULL,
         current_location_id = ? WHERE id = ?`)
      .run(finalStatus === 'COMPLETED' ? task.destination_id : null, task.wheelchair_id);
    const c = db.prepare('SELECT * FROM wheelchairs WHERE id = ?').get(task.wheelchair_id);
    broadcast('wheelchair', chairJson(c));
  }

  function availableChairsAt(storageId) {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM wheelchairs
       WHERE status = 'AVAILABLE' AND current_location_id = ?`).get(storageId).n;
  }

  // Nearest storage to a pickup point, preferring ones with available chairs.
  function pickStorage(pickupId) {
    const pickup = getLoc.get(pickupId);
    const storages = db.prepare(`SELECT * FROM locations WHERE type = 'STORAGE'`).all()
      .map(s => ({
        s,
        dist: Math.hypot(s.x - pickup.x, s.y - pickup.y),
        chairs: availableChairsAt(s.id),
      }))
      .sort((a, b) => (b.chairs > 0) - (a.chairs > 0) || a.dist - b.dist);
    return storages[0]?.s.id ?? null;
  }

  // ---------- flight feed ----------
  function flightJson(f) {
    return { ...f, gate: locBrief(f.gate_id) };
  }

  const getFlightByNumber = db.prepare(
    'SELECT * FROM flights WHERE upper(flight_number) = upper(?)');

  // A gate change from the feed retargets every active task on that flight:
  // arrivals meet the passenger AT the gate (pickup moves), departures deliver
  // the passenger TO the gate (destination moves). Tasks that already passed
  // the affected point are left alone for the dispatcher to judge.
  function applyFlightUpdate(flight, { gate_id, status, sched_time }, byUser) {
    const oldGateId = flight.gate_id;
    db.prepare(
      `UPDATE flights SET gate_id = ?, status = ?, sched_time = ?, updated_at = ? WHERE id = ?`)
      .run(gate_id ?? flight.gate_id, status || flight.status,
        sched_time || flight.sched_time, now(), flight.id);
    const updated = db.prepare('SELECT * FROM flights WHERE id = ?').get(flight.id);
    broadcast('flight', flightJson(updated));

    const gateChanged = gate_id && gate_id !== oldGateId;
    if (!gateChanged) return { updated_tasks: [] };

    const newGate = getLoc.get(gate_id);
    const oldGate = oldGateId ? getLoc.get(oldGateId) : null;
    const activeTasks = db.prepare(
      `SELECT * FROM tasks WHERE upper(flight_number) = upper(?)
       AND status NOT IN ('COMPLETED','CANCELLED')`).all(flight.flight_number);
    const updatedTasks = [];

    for (const t of activeTasks) {
      const stages = stagesFor(t);
      const idx = s => stages.indexOf(s);
      const cur = t.status === 'CREATED' ? -1 : idx(t.status);
      let field = null;
      if (flight.direction === 'ARRIVAL' && t.pickup_id === oldGateId &&
          cur < idx('ARRIVED_AT_PICKUP')) field = 'pickup_id';
      if (flight.direction === 'DEPARTURE' && t.destination_id === oldGateId &&
          cur < idx('PASSENGER_DELIVERED')) field = 'destination_id';
      if (!field) continue;

      db.prepare(`UPDATE tasks SET ${field} = ? WHERE id = ?`).run(gate_id, t.id);
      const fresh = getTask(t.id);
      const est = estimateTask(fresh.storage_id, fresh.pickup_id, fresh.destination_id);
      db.prepare('UPDATE tasks SET template_est_minutes = ? WHERE id = ?')
        .run(est.total_minutes, t.id);
      db.prepare(
        `INSERT INTO task_events (uuid, task_id, agent_id, type, server_time, note)
         VALUES (?,?,?,?,?,?)`)
        .run(randomUUID(), t.id, byUser?.id ?? null, 'GATE_CHANGED', now(),
          `Flight ${flight.flight_number}: gate ${oldGate?.code || '?'} → ${newGate.code}; ` +
          `${field === 'pickup_id' ? 'pickup' : 'destination'} updated automatically`);
      if (fresh.passenger_phone) notifier.send(t.id, fresh.passenger_phone,
        `AeroAssist: flight ${flight.flight_number} gate changed to ${newGate.code}. ` +
        `Your assistance has been updated automatically.`);
      pushTaskUpdate(t.id);
      updatedTasks.push(t.id);
    }
    return { updated_tasks: updatedTasks };
  }

  // ---------- geo ----------
  function haversineMeters(a, b) {
    const R = 6371000, toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function taskDistanceMeters(taskId) {
    const pts = db.prepare(
      'SELECT lat, lng FROM trackpoints WHERE task_id = ? ORDER BY id').all(taskId);
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversineMeters(pts[i - 1], pts[i]);
    return Math.round(d);
  }

  // ---------- report ----------
  function taskReport(task) {
    const events = taskEvents(task.id);
    const NON_STAGE = [...LOG_ONLY_EVENTS, 'GATE_CHANGED', 'REASSIGNED'];
    const stageEvents = events.filter(e => !NON_STAGE.includes(e.type));
    const timeline = stageEvents.map((e, i) => ({
      type: e.type, at: e.server_time, agent: e.agent_name, note: e.note,
      minutes_since_previous: i === 0
        ? minutesBetween(new Date(task.created_at), new Date(e.server_time))
        : minutesBetween(new Date(stageEvents[i - 1].server_time), new Date(e.server_time)),
    }));
    const t = id => eventTime(task.id, id);
    return {
      task: taskJson(task, { withEvents: true }),
      timeline,
      problems: events.filter(e => NON_STAGE.includes(e.type)),
      totals: {
        total_minutes: minutesBetween(new Date(task.created_at), t('COMPLETED')),
        response_minutes: minutesBetween(new Date(task.created_at), t('ACCEPTED')),
        passenger_wait_minutes: minutesBetween(new Date(task.created_at), t('ARRIVED_AT_PICKUP')),
        transit_minutes: minutesBetween(t('PASSENGER_PICKED_UP'), t('PASSENGER_DELIVERED')),
        distance_meters: taskDistanceMeters(task.id),
        template_est_minutes: task.template_est_minutes,
        admin_est_minutes: task.admin_est_minutes,
        sla_target_minutes: task.sla_target_minutes,
        sla_state: slaState(task),
      },
    };
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, roles, handler) =>
    routes.push({ method, pattern, roles, handler });

  const json = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    });
    res.end(data);
  };
  const err = (res, code, message) => json(res, code, { error: message });

  // --- auth ---
  route('POST', /^\/api\/login$/, null, (req, res, m, body) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || 'unknown';
    const key = loginKey(body.username, ip);
    if (isLocked(key))
      return err(res, 429, 'Too many attempts. Try again in a few minutes.');
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(body.username || '');
    if (!u || !verifyPassword(body.password || '', u.password_hash)) {
      recordFailure(key);
      return err(res, 401, 'Invalid username or password');
    }
    if (u.disabled) {
      recordFailure(key);
      return err(res, 403, 'This account has been disabled. Contact your dispatch admin.');
    }
    clearFailures(key);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?,?,?,?)')
      .run(token, u.id, now(), now());
    audit(u, 'LOGIN', `user #${u.id}`, `from ${ip}`);
    json(res, 200, { token, user: publicUser(u) });
  });

  route('POST', /^\/api\/logout$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res, m, body, user) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(user._token);
    json(res, 200, { ok: true });
  });

  // Change own password. Any signed-in user; clears the must-change flag.
  route('POST', /^\/api\/password$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res, m, body, user) => {
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(body.current || '', fresh.password_hash))
      return err(res, 403, 'Current password is incorrect');
    const next = String(body.new || '');
    if (next.length < 6) return err(res, 400, 'New password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashPassword(next), user.id);
    // Invalidate this user's OTHER sessions; keep the current one.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, user._token);
    audit(user, 'PASSWORD_CHANGE', `user #${user.id}`, null);
    json(res, 200, { ok: true });
  });

  route('GET', /^\/api\/me$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res, m, b, user) =>
    json(res, 200, publicUser(user)));

  // --- users / shift ---
  route('GET', /^\/api\/agents$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res) => {
    const agents = db.prepare(`SELECT * FROM users WHERE role = 'AGENT' ORDER BY name`).all();
    json(res, 200, agents.map(publicUser));
  });

  route('POST', /^\/api\/shift$/, ['AGENT'], (req, res, m, body, user) => {
    // Going off duty also ends any break.
    db.prepare('UPDATE users SET on_duty = ?, on_break = CASE WHEN ? = 0 THEN 0 ELSE on_break END, last_seen = ? WHERE id = ?')
      .run(body.on_duty ? 1 : 0, body.on_duty ? 1 : 0, now(), user.id);
    broadcast('agent', publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
    json(res, 200, { ok: true, on_duty: !!body.on_duty });
  });

  // Break toggle — an on-duty agent marks themselves temporarily unavailable.
  // Auto-assign skips agents on break; they still see and can act on their tasks.
  route('POST', /^\/api\/break$/, ['AGENT'], (req, res, m, body, user) => {
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!fresh.on_duty) return err(res, 409, 'Go on duty before taking a break');
    db.prepare('UPDATE users SET on_break = ?, last_seen = ? WHERE id = ?')
      .run(body.on_break ? 1 : 0, now(), user.id);
    broadcast('agent', publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
    json(res, 200, { ok: true, on_break: !!body.on_break });
  });

  route('POST', /^\/api\/position$/, ['AGENT'], (req, res, m, body, user) => {
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number')
      return err(res, 400, 'lat/lng required');
    db.prepare('UPDATE users SET last_lat = ?, last_lng = ?, last_seen = ? WHERE id = ?')
      .run(body.lat, body.lng, now(), user.id);
    broadcast('agent', publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
    json(res, 200, { ok: true });
  });

  // --- user / staff management (ADMIN only) ---
  const VALID_ROLES = ['ADMIN', 'SUPERVISOR', 'AGENT'];
  const countAdmins = () => db.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND disabled = 0`).get().n;

  route('GET', /^\/api\/users$/, ['ADMIN'], (req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY role, name').all();
    json(res, 200, users.map(publicUser));
  });

  route('POST', /^\/api\/users$/, ['ADMIN'], (req, res, m, body, actor) => {
    const username = String(body.username || '').trim().toLowerCase();
    const name = String(body.name || '').trim();
    const role = body.role;
    if (!username || !name) return err(res, 400, 'username and name are required');
    if (!VALID_ROLES.includes(role)) return err(res, 400, 'Invalid role');
    const password = String(body.password || '');
    if (password.length < 6) return err(res, 400, 'Password must be at least 6 characters');
    const skills = Array.isArray(body.skills) ? body.skills : [];
    try {
      const r = db.prepare(
        `INSERT INTO users (username, password_hash, name, role, skills, created_at,
           must_change_password) VALUES (?,?,?,?,?,?,1)`)
        .run(username, hashPassword(password), name, role, JSON.stringify(skills), now());
      const created = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
      audit(actor, 'USER_CREATE', `user #${created.id} (${username})`, `role ${role}`);
      json(res, 201, publicUser(created));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return err(res, 409, 'That username is already taken');
      console.error('USER_CREATE error:', e.message);
      err(res, 500, 'Could not create user');
    }
  });

  route('PATCH', /^\/api\/users\/(\d+)$/, ['ADMIN'], (req, res, m, body, actor) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(m[1]));
    if (!target) return err(res, 404, 'User not found');
    const changes = [];
    let name = target.name, role = target.role, skills = target.skills,
      disabled = target.disabled;
    if (body.name != null && String(body.name).trim()) { name = String(body.name).trim(); changes.push('name'); }
    if (body.role != null) {
      if (!VALID_ROLES.includes(body.role)) return err(res, 400, 'Invalid role');
      if (target.role === 'ADMIN' && body.role !== 'ADMIN' && countAdmins() <= 1)
        return err(res, 409, 'Cannot change the role of the last active admin');
      role = body.role; changes.push('role');
    }
    if (Array.isArray(body.skills)) { skills = JSON.stringify(body.skills); changes.push('skills'); }
    if (body.disabled != null) {
      const dis = body.disabled ? 1 : 0;
      if (dis && target.id === actor.id) return err(res, 409, 'You cannot disable your own account');
      if (dis && target.role === 'ADMIN' && countAdmins() <= 1)
        return err(res, 409, 'Cannot disable the last active admin');
      disabled = dis; changes.push(dis ? 'disabled' : 'enabled');
    }
    db.prepare('UPDATE users SET name = ?, role = ?, skills = ?, disabled = ? WHERE id = ?')
      .run(name, role, skills, disabled, target.id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit(actor, 'USER_UPDATE', `user #${target.id} (${target.username})`, changes.join(', '));
    json(res, 200, publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
  });

  // Admin reset: sets a temporary password the admin reads out; forces a change.
  route('POST', /^\/api\/users\/(\d+)\/reset-password$/, ['ADMIN'], (req, res, m, body, actor) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(m[1]));
    if (!target) return err(res, 404, 'User not found');
    const temp = body.password && String(body.password).length >= 6
      ? String(body.password)
      : 'dnata-' + randomBytes(3).toString('hex');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
      .run(hashPassword(temp), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit(actor, 'PASSWORD_RESET', `user #${target.id} (${target.username})`, null);
    json(res, 200, { ok: true, temporary_password: temp });
  });

  // --- audit log (ADMIN + SUPERVISOR) ---
  route('GET', /^\/api\/audit$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, b, u, url) => {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    json(res, 200, rows);
  });

  // --- locations ---
  route('GET', /^\/api\/locations$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res) =>
    json(res, 200, db.prepare('SELECT * FROM locations ORDER BY type, code').all()));

  route('GET', /^\/api\/config$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res) =>
    json(res, 200, { map_ref: mapRef }));

  route('POST', /^\/api\/locations$/, ['ADMIN'], (req, res, m, body) => {
    const { code, name, type } = body;
    if (!code || !name || !type) return err(res, 400, 'code, name, type required');
    // Accept either real GPS (lat/lng) or map coordinates (x/y); derive the other.
    let { x, y, lat, lng } = body;
    if (typeof lat === 'number' && typeof lng === 'number') ({ x, y } = llToXy(lat, lng));
    else if (typeof x === 'number' && typeof y === 'number') ({ lat, lng } = xyToLl(x, y));
    else return err(res, 400, 'either lat+lng or x+y required');
    try {
      const r = db.prepare(
        `INSERT INTO locations (code, name, type, terminal, x, y, lat, lng)
         VALUES (?,?,?,?,?,?,?,?)`)
        .run(code.toUpperCase(), name, type, body.terminal || 'T1', x, y, lat, lng);
      json(res, 201, getLoc.get(r.lastInsertRowid));
    } catch { err(res, 409, 'Location code already exists'); }
  });

  // Bulk import of the real airport: locations with GPS coordinates (+ optional
  // seed walking times). When every location has lat/lng, the map projection is
  // refitted so the whole airport fills the map view, and meters_per_unit is set
  // so distance-based estimates stay honest.
  route('POST', /^\/api\/locations\/import$/, ['ADMIN'], (req, res, m, body, actor) => {
    const locs = Array.isArray(body.locations) ? body.locations : [];
    if (!locs.length) return err(res, 400, 'locations[] required');
    for (const l of locs) {
      if (!l.code || !l.name || !l.type)
        return err(res, 400, 'every location needs code, name, type');
      const hasLl = typeof l.lat === 'number' && typeof l.lng === 'number';
      const hasXy = typeof l.x === 'number' && typeof l.y === 'number';
      if (!hasLl && !hasXy)
        return err(res, 400, `location ${l.code}: needs lat+lng (or x+y)`);
    }

    const allGps = locs.every(l => typeof l.lat === 'number' && typeof l.lng === 'number');
    if (allGps && body.fit_map !== false) {
      // Refit projection: bounding box of the airport → map box [50..950]×[60..540].
      const lats = locs.map(l => l.lat), lngs = locs.map(l => l.lng);
      const latMin = Math.min(...lats), latMax = Math.max(...lats);
      const lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);
      const latSpan = Math.max(latMax - latMin, 0.0005);
      const lngSpan = Math.max(lngMax - lngMin, 0.0005);
      const ax = 900 / lngSpan, ay = -480 / latSpan;
      const midLat = (latMin + latMax) / 2;
      const widthMeters = lngSpan * 111320 * Math.cos((midLat * Math.PI) / 180);
      const heightMeters = latSpan * 111320;
      mapRef = {
        ax, bx: 50 - ax * lngMin,
        ay, by: 60 - ay * latMax,
        meters_per_unit: Math.round(((widthMeters / 900 + heightMeters / 480) / 2) * 1000) / 1000,
      };
      setSetting('map_ref', mapRef);
      // Re-project every existing location's stored GPS onto the new map.
      for (const ex of db.prepare('SELECT id, lat, lng FROM locations').all()) {
        const { x, y } = llToXy(ex.lat, ex.lng);
        db.prepare('UPDATE locations SET x = ?, y = ? WHERE id = ?').run(x, y, ex.id);
      }
    }

    // replace: true — remove locations not in this import, unless referenced by
    // history (tasks/templates/chairs keep their locations for reporting integrity).
    let removed = 0;
    if (body.replace) {
      const keep = new Set(locs.map(l => l.code.toUpperCase()));
      for (const ex of db.prepare('SELECT id, code FROM locations').all()) {
        if (keep.has(ex.code.toUpperCase())) continue;
        const used = db.prepare(
          `SELECT (SELECT COUNT(*) FROM tasks WHERE storage_id = $id OR pickup_id = $id OR destination_id = $id)
            + (SELECT COUNT(*) FROM wheelchairs WHERE home_storage_id = $id OR current_location_id = $id)
            + (SELECT COUNT(*) FROM flights WHERE gate_id = $id) AS n`).get({ id: ex.id }).n;
        if (used) continue;
        db.prepare('DELETE FROM route_templates WHERE from_id = ? OR to_id = ?').run(ex.id, ex.id);
        db.prepare('DELETE FROM locations WHERE id = ?').run(ex.id);
        removed++;
      }
    }

    const upsert = db.prepare(
      `INSERT INTO locations (code, name, type, terminal, x, y, lat, lng)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, type = excluded.type,
         terminal = excluded.terminal, x = excluded.x, y = excluded.y,
         lat = excluded.lat, lng = excluded.lng`);
    let imported = 0;
    for (const l of locs) {
      let { x, y, lat, lng } = l;
      if (typeof lat === 'number' && typeof lng === 'number') ({ x, y } = llToXy(lat, lng));
      else ({ lat, lng } = xyToLl(x, y));
      upsert.run(l.code.toUpperCase(), l.name, l.type, l.terminal || 'T1', x, y, lat, lng);
      imported++;
    }

    // Optional walking-time seeds: { from, to, minutes, both_ways? }
    let templatesUpserted = 0;
    const locIdByCode = code => db.prepare(
      'SELECT id FROM locations WHERE upper(code) = upper(?)').get(code)?.id;
    for (const tRow of Array.isArray(body.templates) ? body.templates : []) {
      const fromId = locIdByCode(tRow.from), toId = locIdByCode(tRow.to);
      if (!fromId || !toId || !(tRow.minutes > 0)) continue;
      const pairs = tRow.both_ways === false ? [[fromId, toId]] : [[fromId, toId], [toId, fromId]];
      for (const [f, t2] of pairs) {
        db.prepare(
          `INSERT INTO route_templates (from_id, to_id, est_minutes, manually_set)
           VALUES (?,?,?,1)
           ON CONFLICT(from_id, to_id)
           DO UPDATE SET est_minutes = excluded.est_minutes, manually_set = 1`)
          .run(f, t2, tRow.minutes);
        templatesUpserted++;
      }
    }

    audit(actor, 'LOCATIONS_IMPORT', `${imported} locations`,
      `${removed} removed, ${templatesUpserted} templates` +
      (allGps && body.fit_map !== false ? ', map refitted' : ''));
    json(res, 200, {
      imported_locations: imported,
      removed_locations: removed,
      seeded_templates: templatesUpserted,
      map_refitted: allGps && body.fit_map !== false,
      map_ref: mapRef,
    });
  });

  // --- templates ---
  route('GET', /^\/api\/templates$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res) => {
    const rows = db.prepare(
      `SELECT t.*, f.code AS from_code, f.name AS from_name,
              d.code AS to_code, d.name AS to_name
       FROM route_templates t
       JOIN locations f ON f.id = t.from_id JOIN locations d ON d.id = t.to_id
       ORDER BY f.code, d.code`).all();
    json(res, 200, rows);
  });

  route('PUT', /^\/api\/templates$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body) => {
    const { from_id, to_id, est_minutes } = body;
    if (!from_id || !to_id || !(est_minutes > 0))
      return err(res, 400, 'from_id, to_id, est_minutes required');
    db.prepare(
      `INSERT INTO route_templates (from_id, to_id, est_minutes, manually_set)
       VALUES (?,?,?,1)
       ON CONFLICT(from_id, to_id)
       DO UPDATE SET est_minutes = excluded.est_minutes, manually_set = 1`)
      .run(from_id, to_id, est_minutes);
    json(res, 200, getTemplate.get(from_id, to_id));
  });

  route('GET', /^\/api\/estimate$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, b, u, url) => {
    const q = url.searchParams;
    json(res, 200, estimateTask(
      Number(q.get('storage')) || null, Number(q.get('pickup')), Number(q.get('destination'))));
  });

  // --- flights (stands in for the AODB/FIDS feed; same shape a real feed adapter would use) ---
  route('GET', /^\/api\/flights$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res) =>
    json(res, 200, db.prepare('SELECT * FROM flights ORDER BY sched_time').all().map(flightJson)));

  route('GET', /^\/api\/flights\/lookup$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, b, u, url) => {
    const f = getFlightByNumber.get(url.searchParams.get('number') || '');
    if (!f) return err(res, 404, 'Unknown flight');
    json(res, 200, flightJson(f));
  });

  route('POST', /^\/api\/flights$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body) => {
    const { flight_number, direction } = body;
    if (!flight_number || !['ARRIVAL', 'DEPARTURE'].includes(direction))
      return err(res, 400, 'flight_number and direction (ARRIVAL|DEPARTURE) required');
    if (body.gate_id && !getLoc.get(body.gate_id)) return err(res, 400, 'Unknown gate');
    try {
      db.prepare(
        `INSERT INTO flights (flight_number, direction, sched_time, gate_id, status, updated_at)
         VALUES (?,?,?,?,?,?)`)
        .run(flight_number.toUpperCase(), direction, body.sched_time || null,
          body.gate_id || null, body.status || 'ON_TIME', now());
    } catch { return err(res, 409, 'Flight already exists'); }
    json(res, 201, flightJson(getFlightByNumber.get(flight_number)));
  });

  // Feed update: gate change / delay / status. Gate changes cascade to active tasks.
  route('POST', /^\/api\/flights\/(\d+)\/update$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const flight = db.prepare('SELECT * FROM flights WHERE id = ?').get(Number(m[1]));
    if (!flight) return err(res, 404, 'Flight not found');
    if (body.gate_id && !getLoc.get(body.gate_id)) return err(res, 400, 'Unknown gate');
    const result = applyFlightUpdate(flight, body, user);
    const fresh = db.prepare('SELECT * FROM flights WHERE id = ?').get(flight.id);
    audit(user, 'FLIGHT_UPDATE', flight.flight_number,
      `status ${fresh.status}` + (result.updated_tasks?.length
        ? `; ${result.updated_tasks.length} task(s) retargeted` : ''));
    json(res, 200, { flight: flightJson(fresh), ...result });
  });

  // --- wheelchair fleet ---
  route('GET', /^\/api\/wheelchairs$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res) =>
    json(res, 200, db.prepare('SELECT * FROM wheelchairs ORDER BY qr_code').all().map(chairJson)));

  route('POST', /^\/api\/wheelchairs$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body) => {
    const { qr_code, type, home_storage_id } = body;
    if (!qr_code) return err(res, 400, 'qr_code required');
    if (home_storage_id && !getLoc.get(home_storage_id)) return err(res, 400, 'Unknown storage');
    try {
      db.prepare(
        `INSERT INTO wheelchairs (qr_code, type, home_storage_id, current_location_id)
         VALUES (?,?,?,?)`)
        .run(qr_code.toUpperCase(), type || 'MANUAL',
          home_storage_id || null, home_storage_id || null);
    } catch { return err(res, 409, 'QR code already registered'); }
    json(res, 201, chairJson(getChairByQr.get(qr_code)));
  });

  // Maintenance toggle / return to a storage room.
  route('POST', /^\/api\/wheelchairs\/(\d+)\/status$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const chair = db.prepare('SELECT * FROM wheelchairs WHERE id = ?').get(Number(m[1]));
    if (!chair) return err(res, 404, 'Wheelchair not found');
    if (chair.status === 'IN_USE') return err(res, 409, 'Chair is in use on a task');
    const status = body.status;
    if (!['AVAILABLE', 'MAINTENANCE'].includes(status))
      return err(res, 400, 'status must be AVAILABLE or MAINTENANCE');
    if (body.location_id && !getLoc.get(body.location_id)) return err(res, 400, 'Unknown location');
    db.prepare('UPDATE wheelchairs SET status = ?, current_location_id = ? WHERE id = ?')
      .run(status, body.location_id ?? chair.current_location_id, chair.id);
    const fresh = db.prepare('SELECT * FROM wheelchairs WHERE id = ?').get(chair.id);
    audit(user, 'WHEELCHAIR_STATUS', chair.qr_code, status);
    broadcast('wheelchair', chairJson(fresh));
    json(res, 200, chairJson(fresh));
  });

  // --- SSR intake: airline passenger-assistance manifest for a flight ---
  // Real feeds deliver SSR codes (WCHR/WCHS/WCHC) per passenger; this endpoint
  // accepts that list and turns each passenger into a task automatically.
  route('POST', /^\/api\/flights\/(\d+)\/ssrs$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const flight = db.prepare('SELECT * FROM flights WHERE id = ?').get(Number(m[1]));
    if (!flight) return err(res, 404, 'Flight not found');
    if (!flight.gate_id) return err(res, 409, 'Flight has no gate assigned yet');
    const passengers = Array.isArray(body.passengers) ? body.passengers : [];
    if (!passengers.length) return err(res, 400, 'passengers[] required');

    const checkin = db.prepare(`SELECT id FROM locations WHERE type = 'CHECKIN' LIMIT 1`).get();
    const baggage = db.prepare(`SELECT id FROM locations WHERE type = 'BAGGAGE' LIMIT 1`).get();
    if (!checkin || !baggage) return err(res, 500, 'CHECKIN/BAGGAGE locations missing');
    const pickupId = flight.direction === 'ARRIVAL' ? flight.gate_id : checkin.id;
    const destinationId = flight.direction === 'ARRIVAL' ? baggage.id : flight.gate_id;

    const created = [], skipped = [];
    for (const p of passengers) {
      const name = (p.name || '').trim();
      if (!name) continue;
      const dup = db.prepare(
        `SELECT id FROM tasks WHERE upper(flight_number) = upper(?)
         AND passenger_name = ? AND status != 'CANCELLED'`)
        .get(flight.flight_number, name);
      if (dup) { skipped.push({ name, reason: `already has task #${dup.id}` }); continue; }

      const ssr = ['WCHR', 'WCHS', 'WCHC', 'DPNA'].includes(p.ssr_code) ? p.ssr_code : 'WCHR';
      const storageId = pickStorage(pickupId);
      const est = estimateTask(storageId, pickupId, destinationId);
      const slaTarget = SLA_DEFAULTS[flight.direction] || 30;
      const createdAt = now();
      const notifiedAt = body.notified_at || createdAt;
      const lateFlag = lateNotificationFlag(flight.sched_time, notifiedAt);
      const r = db.prepare(
        `INSERT INTO tasks (created_by, created_at, passenger_name, passenger_phone,
          passenger_notes, ssr_code, wheelchair_type, flight_number, flight_direction,
          flight_time, priority, storage_id, pickup_id, destination_id,
          template_est_minutes, admin_est_minutes, sla_target_minutes, sla_deadline_at,
          notified_at, late_notification)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(user.id, createdAt, name, p.phone || null,
          `Auto-created from airline SSR list (${ssr})`,
          ssr, ssr === 'WCHC' ? 'AISLE' : 'MANUAL',
          flight.flight_number, flight.direction, flight.sched_time,
          ssr === 'WCHC' ? 'HIGH' : 'NORMAL',
          storageId, pickupId, destinationId,
          est.total_minutes, est.total_minutes, slaTarget,
          new Date(Date.parse(createdAt) + slaTarget * 60000).toISOString(),
          notifiedAt, lateFlag);
      const task = getTask(r.lastInsertRowid);
      let autoResult = null;
      if (body.auto_assign) autoResult = autoAssign(task, user);
      pushTaskUpdate(task.id);
      created.push({ id: task.id, name, ssr, assigned_to: autoResult?.agent.name ?? null });
    }
    json(res, 201, { flight: flight.flight_number, created, skipped });
  });

  // --- tasks ---
  route('POST', /^\/api\/tasks$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const { passenger_name, pickup_id, destination_id, flight_direction } = body;
    if (!passenger_name || !pickup_id || !destination_id || !flight_direction)
      return err(res, 400, 'passenger_name, pickup_id, destination_id, flight_direction required');
    if (!getLoc.get(pickup_id) || !getLoc.get(destination_id) ||
        (body.storage_id && !getLoc.get(body.storage_id)))
      return err(res, 400, 'Unknown location id');
    const est = estimateTask(body.storage_id || null, pickup_id, destination_id);
    const slaRaw = Number(body.sla_target_minutes);
    const slaTarget = body.sla_target_minutes != null && Number.isFinite(slaRaw) && slaRaw >= 0
      ? slaRaw : (SLA_DEFAULTS[flight_direction] || 30);
    const createdAt = now();
    const deadline = new Date(Date.parse(createdAt) + slaTarget * 60000).toISOString();
    // When the airline notified us of this assistance need (defaults to now).
    const notifiedAt = body.notified_at || createdAt;
    const flightTime = body.flight_time || null;
    const lateFlag = lateNotificationFlag(flightTime, notifiedAt);
    const r = db.prepare(
      `INSERT INTO tasks (created_by, created_at, passenger_name, passenger_phone,
        passenger_notes, ssr_code, wheelchair_type, flight_number, flight_direction,
        flight_time, priority, storage_id, pickup_id, destination_id,
        template_est_minutes, admin_est_minutes, sla_target_minutes, sla_deadline_at,
        notified_at, late_notification)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(user.id, createdAt, passenger_name, body.passenger_phone || null,
        body.passenger_notes || null,
        body.ssr_code || 'WCHR', body.wheelchair_type || 'MANUAL',
        body.flight_number || null, flight_direction, flightTime,
        body.priority || 'NORMAL', body.storage_id || null, pickup_id, destination_id,
        est.total_minutes, Number(body.admin_est_minutes) || est.total_minutes,
        slaTarget, deadline, notifiedAt, lateFlag);
    const task = getTask(r.lastInsertRowid);
    let autoResult;
    if (Array.isArray(body.agent_ids) && body.agent_ids.length) assign(task, body.agent_ids, user);
    else if (body.auto_assign) autoResult = autoAssign(task, user);
    pushTaskUpdate(task.id);
    json(res, 201, { ...taskJson(getTask(task.id)), auto_assign_result: autoResult ?? null });
  });

  route('POST', /^\/api\/tasks\/(\d+)\/autoassign$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    if (TERMINAL_STATUSES.includes(task.status)) return err(res, 409, `Task is ${task.status}`);
    const result = autoAssign(task, user);
    if (!result) return err(res, 409,
      'No suitable agent available (on duty with required skills)');
    pushTaskUpdate(task.id);
    json(res, 200, { task: taskJson(getTask(task.id)), choice: result });
  });

  function assign(task, agentIds, byUser) {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO task_assignments (task_id, agent_id, role, assigned_at)
       VALUES (?,?,?,?)`);
    agentIds.forEach((id, i) => ins.run(task.id, id, i === 0 ? 'PRIMARY' : 'ASSIST', now()));
    const names = agentIds
      .map(id => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name)
      .filter(Boolean);
    if (task.status === 'CREATED') {
      db.prepare(`UPDATE tasks SET status = 'ASSIGNED' WHERE id = ?`).run(task.id);
      db.prepare(
        `INSERT INTO task_events (uuid, task_id, agent_id, type, server_time)
         VALUES (?,?,?,?,?)`)
        .run(randomUUID(), task.id, byUser.id, 'ASSIGNED', now());
      notifier.onTaskEvent(getTask(task.id), 'ASSIGNED', names[0]);
    }
    audit(byUser, 'TASK_ASSIGN', `task #${task.id}`, names.join(', '));
  }

  route('POST', /^\/api\/tasks\/(\d+)\/assign$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    if (TERMINAL_STATUSES.includes(task.status))
      return err(res, 409, `Task is ${task.status}`);
    const ids = (body.agent_ids || []).map(Number).filter(Boolean);
    if (!ids.length) return err(res, 400, 'agent_ids required');
    for (const id of ids) {
      const a = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'AGENT'`).get(id);
      if (!a) return err(res, 400, `User ${id} is not an agent`);
    }
    assign(task, ids, user);
    pushTaskUpdate(task.id);
    json(res, 200, taskJson(getTask(task.id)));
  });

  route('GET', /^\/api\/tasks$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res, m, b, user, url) => {
    const q = url.searchParams;
    let sql = 'SELECT DISTINCT t.* FROM tasks t';
    const where = [], params = [];
    if (user.role === 'AGENT' || q.get('agent') === 'me') {
      sql += ' JOIN task_assignments ta ON ta.task_id = t.id';
      where.push('ta.agent_id = ?'); params.push(user.id);
    }
    if (q.get('status')) { where.push('t.status = ?'); params.push(q.get('status')); }
    if (q.get('active') === '1')
      where.push(`t.status NOT IN ('COMPLETED','CANCELLED')`);
    if (q.get('date')) {
      where.push(`t.created_at >= ? AND t.created_at < ?`);
      const d = q.get('date');
      params.push(d, new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10));
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY t.id DESC LIMIT 500';
    json(res, 200, db.prepare(sql).all(...params).map(t => taskJson(t)));
  });

  route('GET', /^\/api\/tasks\/(\d+)$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res, m, b, user) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    json(res, 200, taskJson(task, { withEvents: true }));
  });

  route('POST', /^\/api\/tasks\/(\d+)\/events$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res, m, body, user) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    if (user.role === 'AGENT' &&
        !taskAssignments(task.id).some(a => a.agent_id === user.id))
      return err(res, 403, 'You are not assigned to this task');
    const { type } = body;
    // Idempotency: offline retries resend the same client-generated uuid.
    if (body.uuid) {
      const dup = db.prepare('SELECT id FROM task_events WHERE uuid = ?').get(body.uuid);
      if (dup) return json(res, 200, { ok: true, duplicate: true, task: taskJson(getTask(task.id)) });
    }
    const v = validateEvent(task, type);
    if (!v.ok) return err(res, 409, v.error);
    const serverTime = now();
    let note = body.note || null;
    if (type === 'WHEELCHAIR_COLLECTED' && body.wheelchair_qr) {
      const chairNote = attachWheelchair(task, String(body.wheelchair_qr).trim(), user.id).note;
      note = note ? `${note} · ${chairNote}` : chairNote;
    }
    db.prepare(
      `INSERT INTO task_events (uuid, task_id, agent_id, type, server_time, client_time, lat, lng, note)
       VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(body.uuid || randomUUID(), task.id, user.id, type, serverTime,
        body.client_time || null, body.lat ?? null, body.lng ?? null, note);
    if (v.statusChange) {
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(v.statusChange, task.id);
      if (type === 'ARRIVED_AT_PICKUP') {
        const met = new Date(serverTime) <= new Date(task.sla_deadline_at) ? 1 : 0;
        db.prepare('UPDATE tasks SET sla_met = ? WHERE id = ?').run(met, task.id);
      }
      if (type === 'COMPLETED') {
        onTaskCompleted(getTask(task.id));
        releaseWheelchair(getTask(task.id), 'COMPLETED');
      }
      const locName = type === 'ARRIVED_AT_PICKUP' ? getLoc.get(task.pickup_id)?.name
        : type === 'PASSENGER_DELIVERED' ? getLoc.get(task.destination_id)?.name : null;
      notifier.onTaskEvent(getTask(task.id), type, user.name, locName);
    }
    pushTaskUpdate(task.id);
    json(res, 200, { ok: true, task: taskJson(getTask(task.id)) });
  });

  route('POST', /^\/api\/tasks\/(\d+)\/trackpoints$/, ['AGENT', 'ADMIN', 'SUPERVISOR'],
    (req, res, m, body, user) => {
      const task = getTask(Number(m[1]));
      if (!task) return err(res, 404, 'Task not found');
      const points = Array.isArray(body) ? body : body.points || [];
      const ins = db.prepare(
        `INSERT INTO trackpoints (task_id, agent_id, lat, lng, accuracy, recorded_at)
         VALUES (?,?,?,?,?,?)`);
      let n = 0;
      for (const p of points) {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
        ins.run(task.id, user.id, p.lat, p.lng, p.accuracy ?? null, p.recorded_at || now());
        n++;
      }
      if (n) {
        db.prepare('UPDATE users SET last_lat = ?, last_lng = ?, last_seen = ? WHERE id = ?')
          .run(points.at(-1).lat, points.at(-1).lng, now(), user.id);
        broadcast('agent', publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
      }
      json(res, 200, { ok: true, saved: n });
    });

  route('POST', /^\/api\/tasks\/(\d+)\/cancel$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    if (TERMINAL_STATUSES.includes(task.status)) return err(res, 409, `Task is ${task.status}`);
    if (!body.reason) return err(res, 400, 'reason required');
    db.prepare(`UPDATE tasks SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`)
      .run(body.reason, task.id);
    releaseWheelchair(task, 'CANCELLED');
    db.prepare(
      `INSERT INTO task_events (uuid, task_id, agent_id, type, server_time, note)
       VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), task.id, user.id, 'CANCELLED', now(), body.reason);
    audit(user, 'TASK_CANCEL', `task #${task.id}`, body.reason);
    pushTaskUpdate(task.id);
    json(res, 200, taskJson(getTask(task.id)));
  });

  // Reassign an in-progress task to different agent(s). Keeps the task's status and
  // timeline; records who took over and why. Used when an agent goes off-shift,
  // is injured, or a supervisor rebalances load mid-task.
  const DELAY_REASONS = ['LATE_NOTIFICATION', 'UNDERSTAFFED', 'EQUIPMENT',
    'PASSENGER_DELAY', 'ACCESS_ISSUE', 'FLIGHT_CHANGE', 'OTHER'];

  route('POST', /^\/api\/tasks\/(\d+)\/reassign$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    if (TERMINAL_STATUSES.includes(task.status)) return err(res, 409, `Task is ${task.status}`);
    const ids = (body.agent_ids || []).map(Number).filter(Boolean);
    if (!ids.length) return err(res, 400, 'agent_ids required');
    for (const id of ids) {
      const a = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'AGENT' AND disabled = 0`).get(id);
      if (!a) return err(res, 400, `User ${id} is not an active agent`);
    }
    const prev = taskAssignments(task.id).map(a => a.agent_name);
    db.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(task.id);
    const ins = db.prepare(
      `INSERT INTO task_assignments (task_id, agent_id, role, assigned_at) VALUES (?,?,?,?)`);
    ids.forEach((id, i) => ins.run(task.id, id, i === 0 ? 'PRIMARY' : 'ASSIST', now()));
    const names = ids.map(id => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name).filter(Boolean);
    // Never let a task sit "unassigned"; if it was CREATED, move it to ASSIGNED.
    if (task.status === 'CREATED') db.prepare(`UPDATE tasks SET status = 'ASSIGNED' WHERE id = ?`).run(task.id);
    db.prepare(
      `INSERT INTO task_events (uuid, task_id, agent_id, type, server_time, note)
       VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), task.id, user.id, 'REASSIGNED', now(),
        `${prev.join(', ') || 'unassigned'} → ${names.join(', ')}` +
        (body.reason ? ` (${body.reason})` : ''));
    notifier.onTaskEvent(getTask(task.id), 'ASSIGNED', names[0]);
    audit(user, 'TASK_REASSIGN', `task #${task.id}`, `${prev.join(', ') || '—'} → ${names.join(', ')}`);
    pushTaskUpdate(task.id);
    json(res, 200, taskJson(getTask(task.id)));
  });

  // Tag why a task ran late — the root-cause code that feeds the compliance report.
  route('POST', /^\/api\/tasks\/(\d+)\/delay-reason$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, body, user) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    const reason = body.reason || null;
    if (reason && !DELAY_REASONS.includes(reason))
      return err(res, 400, 'Unknown delay reason');
    db.prepare('UPDATE tasks SET delay_reason = ? WHERE id = ?').run(reason, task.id);
    audit(user, 'DELAY_REASON', `task #${task.id}`, reason || 'cleared');
    pushTaskUpdate(task.id);
    json(res, 200, taskJson(getTask(task.id)));
  });

  route('GET', /^\/api\/tasks\/(\d+)\/report$/, ['ADMIN', 'SUPERVISOR', 'AGENT'], (req, res, m) => {
    const task = getTask(Number(m[1]));
    if (!task) return err(res, 404, 'Task not found');
    json(res, 200, taskReport(task));
  });

  // --- summary reports ---
  // Per-airline compliance report — the monthly figures a handler reports to each
  // airline: SLA compliance %, breaches, and how many breaches came with late
  // airline notification (the handler's defence against SLA penalties).
  route('GET', /^\/api\/reports\/compliance$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, b, u, url) => {
    const from = url.searchParams.get('from') || '0000';
    const to = url.searchParams.get('to')
      ? new Date(Date.parse(url.searchParams.get('to')) + 86400000).toISOString().slice(0, 10)
      : '9999';
    const tasks = db.prepare(
      'SELECT * FROM tasks WHERE created_at >= ? AND created_at < ?').all(from, to);
    const byAirline = new Map();
    for (const t of tasks) {
      const code = airlineOf(t.flight_number);
      if (!byAirline.has(code)) byAirline.set(code, {
        airline: code, requests: 0, completed: 0, cancelled: 0,
        sla_measured: 0, sla_met: 0, breaches: 0, late_notifications: 0,
        breach_reasons: {},
      });
      const a = byAirline.get(code);
      a.requests++;
      if (t.status === 'COMPLETED') a.completed++;
      if (t.status === 'CANCELLED') a.cancelled++;
      if (t.late_notification) a.late_notifications++;
      if (t.sla_met !== null) {
        a.sla_measured++;
        if (t.sla_met === 1) a.sla_met++;
        else {
          a.breaches++;
          const reason = t.delay_reason || 'UNTAGGED';
          a.breach_reasons[reason] = (a.breach_reasons[reason] || 0) + 1;
        }
      }
    }
    const airlines = [...byAirline.values()].map(a => ({
      ...a,
      compliance_pct: a.sla_measured ? Math.round((a.sla_met / a.sla_measured) * 100) : null,
      late_notification_breaches: Object.entries(a.breach_reasons)
        .filter(([k]) => k === 'LATE_NOTIFICATION').reduce((s, [, v]) => s + v, 0),
    })).sort((x, y) => y.requests - x.requests);
    const totals = airlines.reduce((s, a) => ({
      requests: s.requests + a.requests, completed: s.completed + a.completed,
      sla_measured: s.sla_measured + a.sla_measured, sla_met: s.sla_met + a.sla_met,
      breaches: s.breaches + a.breaches, late_notifications: s.late_notifications + a.late_notifications,
    }), { requests: 0, completed: 0, sla_measured: 0, sla_met: 0, breaches: 0, late_notifications: 0 });
    totals.compliance_pct = totals.sla_measured
      ? Math.round((totals.sla_met / totals.sla_measured) * 100) : null;
    json(res, 200, { period: { from, to }, late_threshold_minutes: lateThreshold(), airlines, totals });
  });

  route('GET', /^\/api\/reports\/summary$/, ['ADMIN', 'SUPERVISOR'], (req, res, m, b, u, url) => {
    const from = url.searchParams.get('from') || '0000';
    const to = url.searchParams.get('to')
      ? new Date(Date.parse(url.searchParams.get('to')) + 86400000).toISOString().slice(0, 10)
      : '9999';
    const tasks = db.prepare(
      'SELECT * FROM tasks WHERE created_at >= ? AND created_at < ?').all(from, to);
    const completed = tasks.filter(t => t.status === 'COMPLETED');
    const durations = completed
      .map(t => minutesBetween(new Date(t.created_at), new Date(t.completed_at)))
      .filter(Boolean).sort((a, b) => a - b);
    const median = durations.length
      ? durations[Math.floor(durations.length / 2)] : null;
    const slaKnown = tasks.filter(t => t.sla_met !== null);

    const perAgent = db.prepare(
      `SELECT u.id, u.name,
              COUNT(DISTINCT ta.task_id) AS tasks_assigned,
              SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS tasks_completed
       FROM users u
       JOIN task_assignments ta ON ta.agent_id = u.id
       JOIN tasks t ON t.id = ta.task_id
       WHERE t.created_at >= ? AND t.created_at < ?
       GROUP BY u.id ORDER BY tasks_completed DESC`).all(from, to);
    for (const a of perAgent) {
      a.distance_meters = db.prepare(
        `SELECT COUNT(*) AS n FROM trackpoints tp JOIN tasks t ON t.id = tp.task_id
         WHERE tp.agent_id = ? AND t.created_at >= ? AND t.created_at < ?`)
        .get(a.id, from, to).n > 1
        ? db.prepare(
            `SELECT DISTINCT task_id FROM trackpoints WHERE agent_id = ?`).all(a.id)
            .reduce((s, r) => s + taskDistanceMeters(r.task_id), 0)
        : 0;
    }

    const perRoute = db.prepare(
      `SELECT f.code AS from_code, d.code AS to_code, rt.est_minutes, rt.sample_count,
              rt.manually_set,
              (SELECT COUNT(*) FROM route_actuals ra
               WHERE ra.from_id = rt.from_id AND ra.to_id = rt.to_id
                 AND ra.completed_at >= ? AND ra.completed_at < ?) AS actuals_in_period
       FROM route_templates rt
       JOIN locations f ON f.id = rt.from_id JOIN locations d ON d.id = rt.to_id
       ORDER BY actuals_in_period DESC, f.code`).all(from, to);

    json(res, 200, {
      period: { from, to },
      totals: {
        created: tasks.length,
        completed: completed.length,
        cancelled: tasks.filter(t => t.status === 'CANCELLED').length,
        active: tasks.filter(t => !TERMINAL_STATUSES.includes(t.status)).length,
        sla_compliance_pct: slaKnown.length
          ? Math.round((slaKnown.filter(t => t.sla_met === 1).length / slaKnown.length) * 100)
          : null,
        avg_duration_minutes: durations.length
          ? Math.round((durations.reduce((s, d) => s + d, 0) / durations.length) * 10) / 10
          : null,
        median_duration_minutes: median,
      },
      per_agent: perAgent,
      per_route: perRoute,
    });
  });

  // ---------- HTTP server ----------
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.ico': 'image/x-icon',
  };

  function serveStatic(res, urlPath) {
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    if (!extname(rel)) rel += '.html';
    const file = normalize(join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Live stream (auth via query param because EventSource can't set headers).
    if (path === '/api/stream') {
      const u = validateSession(url.searchParams.get('token') || '');
      if (!u) return err(res, 401, 'Unauthorized');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const client = { res, user: u };
      sseClients.add(client);
      const hb = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(client); });
      return;
    }

    if (!path.startsWith('/api/')) return serveStatic(res, path);

    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => {
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw); } catch { return err(res, 400, 'Invalid JSON'); }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = path.match(r.pattern);
        if (!m) continue;
        let user = null;
        if (r.roles) {
          const token = (req.headers.authorization || '').replace(/^Bearer /, '');
          user = validateSession(token);
          if (!user) return err(res, 401, 'Unauthorized');
          if (!r.roles.includes(user.role)) return err(res, 403, 'Forbidden');
          user._token = token;
        }
        try { return r.handler(req, res, m, body, user, url); }
        catch (e) { console.error(e); return err(res, 500, 'Internal error'); }
      }
      err(res, 404, 'Not found');
    });
  });

  return { server, db };
}

// Start directly (not under test import).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp({ dbPath: process.env.AERO_DB || undefined });
  server.listen(port, () =>
    console.log(`AeroAssist running on http://localhost:${port}
  Admin dashboard: http://localhost:${port}/admin   (admin / admin123)
  Agent app:       http://localhost:${port}/agent   (ahmed / agent123)`));
}
