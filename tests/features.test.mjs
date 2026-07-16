// Tests for the flight feed, auto-assignment, and passenger notifications.
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
  return { status: res.status, data: await res.json() };
}

async function locId(code) {
  const locs = (await api('GET', '/api/locations', null, tokens.admin)).data;
  return locs.find(l => l.code === code).id;
}
async function agentByName(username) {
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  return agents.find(a => a.username === username);
}

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  for (const [u, p] of [['admin', 'admin123'], ['ahmed', 'agent123'],
    ['fatima', 'agent123'], ['john', 'agent123']]) {
    tokens[u] = (await api('POST', '/api/login', { username: u, password: p })).data.token;
  }
});

after(() => server.close());

test('flight feed: seeded flights, lookup, gate change cascades to active tasks', async () => {
  const flights = (await api('GET', '/api/flights', null, tokens.admin)).data;
  assert.ok(flights.length >= 5);
  const ek = flights.find(f => f.flight_number === 'EK202');
  assert.equal(ek.direction, 'ARRIVAL');
  assert.equal(ek.gate.code, 'A3');

  const look = await api('GET', '/api/flights/lookup?number=ek202', null, tokens.admin);
  assert.equal(look.status, 200);

  // task for EK202: pickup at its gate A3
  const [a3, a5, bg1, s1] = await Promise.all([locId('A3'), locId('A5'), locId('BG1'), locId('S1')]);
  const ahmed = await agentByName('ahmed');
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Gate Change Test', flight_number: 'EK202',
    flight_direction: 'ARRIVAL', storage_id: s1, pickup_id: a3, destination_id: bg1,
    passenger_phone: '+971501234567', agent_ids: [ahmed.id],
  }, tokens.admin)).data;
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tokens.ahmed);

  // feed reports gate change A3 → A5
  const upd = await api('POST', `/api/flights/${ek.id}/update`, { gate_id: a5 }, tokens.admin);
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.data.updated_tasks, [t.id]);
  assert.equal(upd.data.flight.gate.code, 'A5');

  const fresh = (await api('GET', `/api/tasks/${t.id}`, null, tokens.admin)).data;
  assert.equal(fresh.pickup.code, 'A5'); // pickup retargeted automatically
  assert.ok(fresh.events.some(e => e.type === 'GATE_CHANGED' && e.note.includes('A3 → A5')));
  // passenger was notified about the gate change
  assert.ok(fresh.notifications.some(n => n.message.includes('gate changed to A5')));

  // a task already past pickup is NOT retargeted
  const t2 = (await api('POST', '/api/tasks', {
    passenger_name: 'Already Picked Up', flight_number: 'EK202',
    flight_direction: 'ARRIVAL', pickup_id: a5, destination_id: bg1,
    agent_ids: [ahmed.id],
  }, tokens.admin)).data;
  for (const type of ['ACCEPTED', 'ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP'])
    await api('POST', `/api/tasks/${t2.id}/events`, { type }, tokens.ahmed);
  const upd2 = await api('POST', `/api/flights/${ek.id}/update`, { gate_id: a3 }, tokens.admin);
  assert.ok(!upd2.data.updated_tasks.includes(t2.id));
});

test('auto-assign: prefers idle agents, ranks by distance, respects skills', async () => {
  const [a1, td1, b3, ck1] = await Promise.all([locId('A1'), locId('TD1'), locId('B3'), locId('CK1')]);

  // no one on duty → 409
  const t0 = (await api('POST', '/api/tasks', {
    passenger_name: 'Nobody Available', flight_direction: 'TRANSFER',
    pickup_id: a1, destination_id: td1,
  }, tokens.admin)).data;
  const none = await api('POST', `/api/tasks/${t0.id}/autoassign`, {}, tokens.admin);
  assert.equal(none.status, 409);

  // fatima and john go on duty; fatima reports position near Gate A1, john near B3
  await api('POST', '/api/shift', { on_duty: true }, tokens.fatima);
  await api('POST', '/api/shift', { on_duty: true }, tokens.john);
  await api('POST', '/api/position', { lat: 25.25520, lng: 55.36060 }, tokens.fatima); // ~A1
  await api('POST', '/api/position', { lat: 25.25550, lng: 55.36740 }, tokens.john);   // ~B3

  // task starting at A1 → fatima (closer)
  const near = await api('POST', `/api/tasks/${t0.id}/autoassign`, {}, tokens.admin);
  assert.equal(near.status, 200);
  assert.equal(near.data.choice.agent.username, 'fatima');
  assert.ok(near.data.choice.distance_m < 100);

  // next task also near A1: fatima is now busy → john picked despite distance
  const t1 = (await api('POST', '/api/tasks', {
    passenger_name: 'Load Balance', flight_direction: 'TRANSFER',
    pickup_id: a1, destination_id: td1, auto_assign: true,
  }, tokens.admin)).data;
  assert.equal(t1.auto_assign_result.agent.username, 'john');

  // skill filter: electric cart requires ELECTRIC_CART (only john has it, but john
  // is busy; fatima lacks the skill → john still chosen)
  const t2 = (await api('POST', '/api/tasks', {
    passenger_name: 'Cart Rider', flight_direction: 'DEPARTURE',
    wheelchair_type: 'CART', pickup_id: ck1, destination_id: b3, auto_assign: true,
  }, tokens.admin)).data;
  assert.equal(t2.auto_assign_result.agent.username, 'john');
  assert.deepEqual(t2.auto_assign_result.required_skills, ['ELECTRIC_CART']);
});

test('passenger SMS notifications logged across the lifecycle', async () => {
  const [ck1, b3] = await Promise.all([locId('CK1'), locId('B3')]);
  const ahmed = await agentByName('ahmed');
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Notified Passenger', passenger_phone: '+971509999999',
    flight_number: 'QR117', flight_direction: 'DEPARTURE',
    pickup_id: ck1, destination_id: b3, agent_ids: [ahmed.id],
  }, tokens.admin)).data;
  for (const type of ['ACCEPTED', 'ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP',
    'IN_TRANSIT', 'PASSENGER_DELIVERED', 'COMPLETED'])
    await api('POST', `/api/tasks/${t.id}/events`, { type }, tokens.ahmed);

  const detail = (await api('GET', `/api/tasks/${t.id}`, null, tokens.admin)).data;
  const msgs = detail.notifications.map(n => n.message);
  assert.equal(detail.notifications.length, 4); // assigned, on the way, arrived, delivered
  assert.ok(msgs[0].includes('Ahmed Hassan has been assigned'));
  assert.ok(msgs[1].includes('on the way'));
  assert.ok(msgs[2].includes('arrived at Check-in Hall'));
  assert.ok(msgs[3].includes('Have a good trip'));
  assert.ok(detail.notifications.every(n => n.status === 'LOGGED')); // no gateway configured

  // tasks without a phone number produce no notifications
  const t2 = (await api('POST', '/api/tasks', {
    passenger_name: 'No Phone', flight_direction: 'DEPARTURE',
    pickup_id: ck1, destination_id: b3, agent_ids: [ahmed.id],
  }, tokens.admin)).data;
  const d2 = (await api('GET', `/api/tasks/${t2.id}`, null, tokens.admin)).data;
  assert.equal(d2.notifications.length, 0);
});

test('gate-changed events do not distort stage timeline durations', async () => {
  const [a3, bg1] = await Promise.all([locId('A3'), locId('BG1')]);
  const ahmed = await agentByName('ahmed');
  const flights = (await api('GET', '/api/flights', null, tokens.admin)).data;
  const tk = flights.find(f => f.flight_number === 'TK762');
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Timeline Check', flight_number: 'TK762',
    flight_direction: 'ARRIVAL', pickup_id: tk.gate.id, destination_id: bg1,
    agent_ids: [ahmed.id],
  }, tokens.admin)).data;
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tokens.ahmed);
  await api('POST', `/api/flights/${tk.id}/update`, { gate_id: a3 }, tokens.admin);
  for (const type of ['ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP', 'IN_TRANSIT',
    'PASSENGER_DELIVERED', 'COMPLETED'])
    await api('POST', `/api/tasks/${t.id}/events`, { type }, tokens.ahmed);
  const report = (await api('GET', `/api/tasks/${t.id}/report`, null, tokens.admin)).data;
  assert.ok(!report.timeline.some(e => e.type === 'GATE_CHANGED'));
  assert.ok(report.problems.some(e => e.type === 'GATE_CHANGED'));
  assert.equal(report.task.pickup.code, 'A3');
});
