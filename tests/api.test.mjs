// End-to-end API test: full task lifecycle, SLA, GPS, idempotency, template learning.
// Run with: npm test  (node --test tests/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

let server, base;
const tokens = {};

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  for (const [user, pass] of [['admin', 'admin123'], ['ahmed', 'agent123'], ['fatima', 'agent123']]) {
    const { status, data } = await api('POST', '/api/login', { username: user, password: pass });
    assert.equal(status, 200, `login ${user}`);
    tokens[user] = data.token;
  }
});

after(() => server.close());

test('rejects bad credentials and unauthorized access', async () => {
  assert.equal((await api('POST', '/api/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await api('GET', '/api/tasks')).status, 401);
  // agents cannot create tasks
  assert.equal((await api('POST', '/api/tasks', {}, tokens.ahmed)).status, 403);
});

test('seed data: locations and templates exist', async () => {
  const locs = (await api('GET', '/api/locations', null, tokens.admin)).data;
  assert.ok(locs.length >= 16);
  const tpls = (await api('GET', '/api/templates', null, tokens.admin)).data;
  assert.ok(tpls.length >= 13);
});

async function locId(code) {
  const locs = (await api('GET', '/api/locations', null, tokens.admin)).data;
  return locs.find(l => l.code === code).id;
}

test('estimate uses templates per leg (storage→pickup + pickup→destination)', async () => {
  const [s1, a3, bg1] = await Promise.all([locId('S1'), locId('A3'), locId('BG1')]);
  const est = (await api('GET',
    `/api/estimate?storage=${s1}&pickup=${a3}&destination=${bg1}`, null, tokens.admin)).data;
  assert.equal(est.total_minutes, 16); // S1→A3 = 6, A3→BG1 = 10
  assert.equal(est.legs.length, 2);
  assert.equal(est.legs[0].source, 'template');
});

test('full lifecycle: create → assign → all stages → report; SLA met; GPS distance', async () => {
  const [s1, a3, bg1] = await Promise.all([locId('S1'), locId('A3'), locId('BG1')]);
  const create = await api('POST', '/api/tasks', {
    passenger_name: 'Maria Lopez', ssr_code: 'WCHR', flight_number: 'EK202',
    flight_direction: 'ARRIVAL', priority: 'HIGH',
    storage_id: s1, pickup_id: a3, destination_id: bg1,
  }, tokens.admin);
  assert.equal(create.status, 201);
  const task = create.data;
  assert.equal(task.status, 'CREATED');
  assert.equal(task.template_est_minutes, 16);
  assert.equal(task.sla_target_minutes, 20); // ARRIVAL default
  assert.equal(task.sla_state, 'pending');

  // assign
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  const ahmed = agents.find(a => a.username === 'ahmed');
  const asg = await api('POST', `/api/tasks/${task.id}/assign`, { agent_ids: [ahmed.id] }, tokens.admin);
  assert.equal(asg.data.status, 'ASSIGNED');
  assert.equal(asg.data.next_action.type, 'ACCEPTED');

  // agent sees only own tasks
  const mine = (await api('GET', '/api/tasks?active=1', null, tokens.ahmed)).data;
  assert.ok(mine.some(t => t.id === task.id));
  const fatimas = (await api('GET', '/api/tasks?active=1', null, tokens.fatima)).data;
  assert.ok(!fatimas.some(t => t.id === task.id));

  // out-of-order event rejected
  const bad = await api('POST', `/api/tasks/${task.id}/events`,
    { type: 'PASSENGER_PICKED_UP' }, tokens.ahmed);
  assert.equal(bad.status, 409);

  // unassigned agent rejected
  const forbidden = await api('POST', `/api/tasks/${task.id}/events`,
    { type: 'ACCEPTED' }, tokens.fatima);
  assert.equal(forbidden.status, 403);

  // walk all stages, with idempotent retry on the first one
  const uuid = crypto.randomUUID();
  const acc1 = await api('POST', `/api/tasks/${task.id}/events`,
    { type: 'ACCEPTED', uuid }, tokens.ahmed);
  assert.equal(acc1.status, 200);
  const acc2 = await api('POST', `/api/tasks/${task.id}/events`,
    { type: 'ACCEPTED', uuid }, tokens.ahmed); // offline retry
  assert.equal(acc2.data.duplicate, true);

  for (const type of ['EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED', 'ARRIVED_AT_PICKUP',
    'PASSENGER_PICKED_UP', 'IN_TRANSIT']) {
    const r = await api('POST', `/api/tasks/${task.id}/events`, { type }, tokens.ahmed);
    assert.equal(r.status, 200, type);
  }

  // GPS breadcrumbs (synthetic straight walk ~111m: 0.001 deg lat)
  const pts = Array.from({ length: 11 }, (_, i) => ({
    lat: 25.2555 + i * 0.0001, lng: 55.3626, accuracy: 5,
    recorded_at: new Date().toISOString(),
  }));
  const tp = await api('POST', `/api/tasks/${task.id}/trackpoints`, { points: pts }, tokens.ahmed);
  assert.equal(tp.data.saved, 11);

  for (const type of ['PASSENGER_DELIVERED', 'COMPLETED']) {
    const r = await api('POST', `/api/tasks/${task.id}/events`, { type }, tokens.ahmed);
    assert.equal(r.status, 200, type);
  }

  const report = (await api('GET', `/api/tasks/${task.id}/report`, null, tokens.admin)).data;
  assert.equal(report.task.status, 'COMPLETED');
  assert.equal(report.totals.sla_state, 'met');
  assert.ok(report.totals.total_minutes >= 0);
  assert.ok(report.totals.distance_meters > 100 && report.totals.distance_meters < 130);
  assert.equal(report.timeline.at(-1).type, 'COMPLETED');
  // stage events after COMPLETED are rejected
  const late = await api('POST', `/api/tasks/${task.id}/events`, { type: 'COMPLETED' }, tokens.ahmed);
  assert.equal(late.status, 409);
});

test('tasks without storage skip storage stages', async () => {
  const [a1, td1] = await Promise.all([locId('A1'), locId('TD1')]);
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Own-chair passenger', flight_direction: 'TRANSFER',
    pickup_id: a1, destination_id: td1,
    agent_ids: [agents.find(a => a.username === 'fatima').id], // assign at creation
  }, tokens.admin)).data;
  assert.equal(t.status, 'ASSIGNED');
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tokens.fatima);
  const wrong = await api('POST', `/api/tasks/${t.id}/events`,
    { type: 'EN_ROUTE_TO_STORAGE' }, tokens.fatima);
  assert.equal(wrong.status, 409); // storage stage not allowed
  const ok = await api('POST', `/api/tasks/${t.id}/events`,
    { type: 'ARRIVED_AT_PICKUP' }, tokens.fatima);
  assert.equal(ok.status, 200);
});

test('SLA breach is detected (target 0 → deadline already passed)', async () => {
  const [a2, bg1] = await Promise.all([locId('A2'), locId('BG1')]);
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Late Passenger', flight_direction: 'ARRIVAL',
    pickup_id: a2, destination_id: bg1, sla_target_minutes: 0,
    agent_ids: [agents.find(a => a.username === 'ahmed').id],
  }, tokens.admin)).data;
  assert.equal(t.sla_state, 'breached'); // computed live even before arrival
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tokens.ahmed);
  const r = await api('POST', `/api/tasks/${t.id}/events`, { type: 'ARRIVED_AT_PICKUP' }, tokens.ahmed);
  assert.equal(r.data.task.sla_met, 0);
  assert.equal(r.data.task.sla_state, 'breached');
});

test('cancel flow', async () => {
  const [ck1, b3] = await Promise.all([locId('CK1'), locId('B3')]);
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'No Show', flight_direction: 'DEPARTURE',
    pickup_id: ck1, destination_id: b3,
  }, tokens.admin)).data;
  const noReason = await api('POST', `/api/tasks/${t.id}/cancel`, {}, tokens.admin);
  assert.equal(noReason.status, 400);
  const c = await api('POST', `/api/tasks/${t.id}/cancel`,
    { reason: 'Passenger no-show' }, tokens.admin);
  assert.equal(c.data.status, 'CANCELLED');
  assert.equal(c.data.sla_state, 'cancelled');
});

test('template learning: after 5 completed tasks the route time becomes learned', async () => {
  const [td1, b5] = await Promise.all([locId('TD1'), locId('B5')]);
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  const sara = agents.find(a => a.username === 'ahmed');
  for (let i = 0; i < 5; i++) {
    const t = (await api('POST', '/api/tasks', {
      passenger_name: `Learner ${i}`, flight_direction: 'TRANSFER',
      pickup_id: td1, destination_id: b5, agent_ids: [sara.id],
    }, tokens.admin)).data;
    for (const type of ['ACCEPTED', 'ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP',
      'IN_TRANSIT', 'PASSENGER_DELIVERED', 'COMPLETED']) {
      // Transit duration (PICKED_UP → DELIVERED) must be measurably > 0 minutes
      // for the learning rule to record an actual.
      if (type === 'PASSENGER_DELIVERED') await new Promise(r => setTimeout(r, 400));
      const res = await api('POST', `/api/tasks/${t.id}/events`, { type }, tokens.ahmed);
      assert.equal(res.status, 200, `${type} on learner ${i}`);
    }
  }
  const tpls = (await api('GET', '/api/templates', null, tokens.admin)).data;
  const tpl = tpls.find(x => x.from_code === 'TD1' && x.to_code === 'B5');
  assert.equal(tpl.sample_count, 5);
  assert.equal(tpl.manually_set, 0); // switched from seeded value to learned median
  assert.ok(tpl.est_minutes < 10);   // learned from fast test runs, not the seeded 10
});

test('admin can update a template manually', async () => {
  const [a3, b3] = await Promise.all([locId('A3'), locId('B3')]);
  const r = await api('PUT', '/api/templates',
    { from_id: a3, to_id: b3, est_minutes: 17 }, tokens.admin);
  assert.equal(r.data.est_minutes, 17);
  assert.equal(r.data.manually_set, 1);
});

test('summary report aggregates', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const s = (await api('GET', `/api/reports/summary?from=${today}&to=${today}`,
    null, tokens.admin)).data;
  assert.ok(s.totals.created >= 9);
  assert.ok(s.totals.completed >= 6);
  assert.equal(s.totals.cancelled, 1);
  assert.ok(s.totals.sla_compliance_pct >= 50); // 1 intentional breach among met tasks
  assert.ok(s.per_agent.length >= 2);
  assert.ok(s.per_route.some(r => r.from_code === 'TD1' && r.to_code === 'B5'));
});

test('shift toggle and live agent list', async () => {
  await api('POST', '/api/shift', { on_duty: true }, tokens.ahmed);
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  assert.equal(agents.find(a => a.username === 'ahmed').on_duty, true);
});
