// Tier-2 tests: agent availability (break), mid-task reassignment, delay reason
// codes, late-notification detection, and the per-airline compliance report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

let server, base;
const tok = {};

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
const login = (u, p) => api('POST', '/api/login', { username: u, password: p });
async function locId(code) {
  const locs = (await api('GET', '/api/locations', null, tok.admin)).data;
  return locs.find(l => l.code === code).id;
}
async function agent(username) {
  const a = (await api('GET', '/api/agents', null, tok.admin)).data;
  return a.find(x => x.username === username);
}

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  tok.admin = (await login('admin', 'admin123')).data.token;
  tok.ahmed = (await login('ahmed', 'agent123')).data.token;
  tok.fatima = (await login('fatima', 'agent123')).data.token;
});
after(() => server.close());

test('break: on-break agents are skipped by auto-assign', async () => {
  const [a1, td1] = await Promise.all([locId('A1'), locId('TD1')]);
  // both agents on duty, positioned near A1; ahmed closer
  await api('POST', '/api/shift', { on_duty: true }, tok.ahmed);
  await api('POST', '/api/shift', { on_duty: true }, tok.fatima);
  await api('POST', '/api/position', { lat: 25.2559, lng: 55.3606 }, tok.ahmed); // ~A1 (x60,y80)
  await api('POST', '/api/position', { lat: 25.2559, lng: 55.3606 }, tok.fatima);

  // ahmed takes a break → auto-assign must pick fatima
  const br = await api('POST', '/api/break', { on_break: true }, tok.ahmed);
  assert.equal(br.status, 200);
  assert.equal((await api('GET', '/api/me', null, tok.ahmed)).data.on_break, true);

  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Break Test', flight_direction: 'TRANSFER',
    pickup_id: a1, destination_id: td1, auto_assign: true,
  }, tok.admin)).data;
  assert.equal(t.auto_assign_result?.agent.username, 'fatima', 'on-break ahmed skipped');

  // ending the break makes ahmed assignable again
  await api('POST', '/api/break', { on_break: false }, tok.ahmed);
  assert.equal((await api('GET', '/api/me', null, tok.ahmed)).data.on_break, false);

  // going off duty clears any break
  await api('POST', '/api/break', { on_break: true }, tok.fatima);
  await api('POST', '/api/shift', { on_duty: false }, tok.fatima);
  assert.equal((await api('GET', '/api/me', null, tok.fatima)).data.on_break, false);
  await api('POST', '/api/shift', { on_duty: true }, tok.fatima);
});

test('break requires being on duty', async () => {
  await api('POST', '/api/shift', { on_duty: false }, tok.ahmed);
  const r = await api('POST', '/api/break', { on_break: true }, tok.ahmed);
  assert.equal(r.status, 409);
  await api('POST', '/api/shift', { on_duty: true }, tok.ahmed);
});

test('mid-task reassignment moves an active task to a new agent, keeping its stage', async () => {
  const [s1, a3, bg1] = await Promise.all([locId('S1'), locId('A3'), locId('BG1')]);
  const ahmed = await agent('ahmed'), fatima = await agent('fatima');
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Handover Pax', flight_direction: 'ARRIVAL',
    storage_id: s1, pickup_id: a3, destination_id: bg1, agent_ids: [ahmed.id],
  }, tok.admin)).data;
  // advance a couple of stages under ahmed
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tok.ahmed);
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'EN_ROUTE_TO_STORAGE' }, tok.ahmed);

  const re = await api('POST', `/api/tasks/${t.id}/reassign`,
    { agent_ids: [fatima.id], reason: 'Ahmed ended shift' }, tok.admin);
  assert.equal(re.status, 200);
  assert.equal(re.data.status, 'EN_ROUTE_TO_STORAGE', 'stage preserved through handover');
  assert.deepEqual(re.data.assignments.map(a => a.agent_id), [fatima.id]);

  // ahmed can no longer act on it; fatima can continue
  assert.equal((await api('POST', `/api/tasks/${t.id}/events`, { type: 'WHEELCHAIR_COLLECTED' }, tok.ahmed)).status, 403);
  assert.equal((await api('POST', `/api/tasks/${t.id}/events`, { type: 'WHEELCHAIR_COLLECTED' }, tok.fatima)).status, 200);

  const detail = (await api('GET', `/api/tasks/${t.id}`, null, tok.admin)).data;
  assert.ok(detail.events.some(e => e.type === 'REASSIGNED' && e.note.includes('Ahmed Hassan → Fatima Ali')));
});

test('delay reason codes validate and attach to the task', async () => {
  const [ck1, b3] = await Promise.all([locId('CK1'), locId('B3')]);
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Delay Pax', flight_direction: 'DEPARTURE',
    pickup_id: ck1, destination_id: b3,
  }, tok.admin)).data;
  assert.equal((await api('POST', `/api/tasks/${t.id}/delay-reason`, { reason: 'NONSENSE' }, tok.admin)).status, 400);
  const ok = await api('POST', `/api/tasks/${t.id}/delay-reason`, { reason: 'UNDERSTAFFED' }, tok.admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.delay_reason, 'UNDERSTAFFED');
});

test('late-notification is flagged when the airline notified too close to the flight', async () => {
  const [ck1, b3] = await Promise.all([locId('CK1'), locId('B3')]);
  const soon = new Date(Date.now() + 30 * 60000).toISOString();      // flight in 30 min
  const late = (await api('POST', '/api/tasks', {
    passenger_name: 'Late Notice', flight_number: 'EK500', flight_direction: 'DEPARTURE',
    pickup_id: ck1, destination_id: b3, flight_time: soon,           // notified now, <120 min lead
  }, tok.admin)).data;
  assert.equal(late.late_notification, true);

  const early = new Date(Date.now() + 5 * 3600000).toISOString();    // flight in 5 hours
  const onTime = (await api('POST', '/api/tasks', {
    passenger_name: 'Early Notice', flight_number: 'EK500', flight_direction: 'DEPARTURE',
    pickup_id: ck1, destination_id: b3, flight_time: early,
  }, tok.admin)).data;
  assert.equal(onTime.late_notification, false);

  // no flight_time → cannot be judged late
  const noFlight = (await api('POST', '/api/tasks', {
    passenger_name: 'No Flight Time', flight_direction: 'DEPARTURE',
    pickup_id: ck1, destination_id: b3,
  }, tok.admin)).data;
  assert.equal(noFlight.late_notification, false);
});

test('compliance report groups by airline with SLA %, breaches, and late-notice count', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const rep = await api('GET', `/api/reports/compliance?from=${today}&to=${today}`, null, tok.admin);
  assert.equal(rep.status, 200);
  assert.ok(rep.data.airlines.length > 0);
  const ek = rep.data.airlines.find(a => a.airline === 'EK');
  assert.ok(ek, 'EK airline present from EK500 tasks');
  assert.ok(ek.late_notifications >= 1, 'late notification counted for EK');
  assert.ok(rep.data.totals.requests >= 1);
  assert.equal(rep.data.late_threshold_minutes, 120);
  // airline code parsing: 2-3 letter prefixes
  assert.ok(rep.data.airlines.every(a => /^[A-Z]{2,3}$|^—$/.test(a.airline)));
});

test('compliance report attributes breaches to their delay-reason', async () => {
  const [a2, bg1] = await Promise.all([locId('A2'), locId('BG1')]);
  const ahmed = await agent('ahmed');
  // create a task that will breach (sla 0), assign, arrive → breach recorded
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Breach Pax', flight_number: 'QR900', flight_direction: 'ARRIVAL',
    pickup_id: a2, destination_id: bg1, sla_target_minutes: 0, agent_ids: [ahmed.id],
  }, tok.admin)).data;
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tok.ahmed);
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ARRIVED_AT_PICKUP' }, tok.ahmed);
  await api('POST', `/api/tasks/${t.id}/delay-reason`, { reason: 'LATE_NOTIFICATION' }, tok.admin);

  const today = new Date().toISOString().slice(0, 10);
  const rep = (await api('GET', `/api/reports/compliance?from=${today}&to=${today}`, null, tok.admin)).data;
  const qrAirline = rep.airlines.find(a => a.airline === 'QR');
  assert.ok(qrAirline.breaches >= 1, 'QR breach counted');
  assert.equal(qrAirline.breach_reasons.LATE_NOTIFICATION, 1);
  assert.equal(qrAirline.late_notification_breaches, 1);
});
