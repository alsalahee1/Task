// Tests for wheelchair QR inventory and SSR auto task creation.
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

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  for (const [u, p] of [['admin', 'admin123'], ['ahmed', 'agent123']])
    tokens[u] = (await api('POST', '/api/login', { username: u, password: p })).data.token;
});

after(() => server.close());

test('wheelchair fleet: seeded chairs, QR scan links chair, completion frees it at destination', async () => {
  const chairs = (await api('GET', '/api/wheelchairs', null, tokens.admin)).data;
  assert.equal(chairs.length, 8);
  assert.ok(chairs.every(c => c.status === 'AVAILABLE'));

  const [s1, a3, bg1] = await Promise.all([locId('S1'), locId('A3'), locId('BG1')]);
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  const ahmed = agents.find(a => a.username === 'ahmed');
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Chair Scan Test', flight_direction: 'ARRIVAL',
    storage_id: s1, pickup_id: a3, destination_id: bg1, agent_ids: [ahmed.id],
  }, tokens.admin)).data;

  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tokens.ahmed);
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'EN_ROUTE_TO_STORAGE' }, tokens.ahmed);
  // scan the chair QR at collection
  const collect = await api('POST', `/api/tasks/${t.id}/events`,
    { type: 'WHEELCHAIR_COLLECTED', wheelchair_qr: 'wc-s1-001' }, tokens.ahmed);
  assert.equal(collect.status, 200);
  assert.equal(collect.data.task.wheelchair.qr_code, 'WC-S1-001'); // case-insensitive
  assert.equal(collect.data.task.wheelchair.status, 'IN_USE');

  const inUse = (await api('GET', '/api/wheelchairs', null, tokens.admin)).data
    .find(c => c.qr_code === 'WC-S1-001');
  assert.equal(inUse.status, 'IN_USE');
  assert.equal(inUse.current_task_id, t.id);

  for (const type of ['ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP', 'IN_TRANSIT',
    'PASSENGER_DELIVERED', 'COMPLETED'])
    await api('POST', `/api/tasks/${t.id}/events`, { type }, tokens.ahmed);

  const freed = (await api('GET', '/api/wheelchairs', null, tokens.admin)).data
    .find(c => c.qr_code === 'WC-S1-001');
  assert.equal(freed.status, 'AVAILABLE');
  assert.equal(freed.current_task_id, null);
  assert.equal(freed.current_location.code, 'BG1'); // chair now sits at the destination
});

test('unknown QR code never blocks the task; it is noted for the dispatcher', async () => {
  const [s1, a3, bg1] = await Promise.all([locId('S1'), locId('A3'), locId('BG1')]);
  const agents = (await api('GET', '/api/agents', null, tokens.admin)).data;
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Bad QR', flight_direction: 'ARRIVAL',
    storage_id: s1, pickup_id: a3, destination_id: bg1,
    agent_ids: [agents.find(a => a.username === 'ahmed').id],
  }, tokens.admin)).data;
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'ACCEPTED' }, tokens.ahmed);
  await api('POST', `/api/tasks/${t.id}/events`, { type: 'EN_ROUTE_TO_STORAGE' }, tokens.ahmed);
  const r = await api('POST', `/api/tasks/${t.id}/events`,
    { type: 'WHEELCHAIR_COLLECTED', wheelchair_qr: 'NOT-A-CHAIR' }, tokens.ahmed);
  assert.equal(r.status, 200); // task proceeds
  assert.equal(r.data.task.wheelchair, null);
  const detail = (await api('GET', `/api/tasks/${t.id}`, null, tokens.admin)).data;
  assert.ok(detail.events.some(e =>
    e.type === 'WHEELCHAIR_COLLECTED' && e.note?.includes('Unregistered chair code')));
});

test('maintenance status blocks nothing but is flagged; in-use chairs cannot be edited', async () => {
  const chairs = (await api('GET', '/api/wheelchairs', null, tokens.admin)).data;
  const spare = chairs.find(c => c.qr_code === 'WC-S2-002');
  const m = await api('POST', `/api/wheelchairs/${spare.id}/status`,
    { status: 'MAINTENANCE' }, tokens.admin);
  assert.equal(m.data.status, 'MAINTENANCE');
  const back = await api('POST', `/api/wheelchairs/${spare.id}/status`,
    { status: 'AVAILABLE' }, tokens.admin);
  assert.equal(back.data.status, 'AVAILABLE');
});

test('admin can register a new chair; duplicate QR rejected', async () => {
  const s1 = await locId('S1');
  const r = await api('POST', '/api/wheelchairs',
    { qr_code: 'WC-S1-099', type: 'MANUAL', home_storage_id: s1 }, tokens.admin);
  assert.equal(r.status, 201);
  const dup = await api('POST', '/api/wheelchairs', { qr_code: 'WC-S1-099' }, tokens.admin);
  assert.equal(dup.status, 409);
});

test('SSR intake: creates tasks per passenger with correct routing, dedup on re-post', async () => {
  const flights = (await api('GET', '/api/flights', null, tokens.admin)).data;
  const ek = flights.find(f => f.flight_number === 'EK202'); // ARRIVAL, gate A3
  const r = await api('POST', `/api/flights/${ek.id}/ssrs`, {
    passengers: [
      { name: 'Omar Farouk', ssr_code: 'WCHR', phone: '+971500000001' },
      { name: 'Lina Haddad', ssr_code: 'WCHC' },
      { name: '', ssr_code: 'WCHR' }, // blank name ignored
    ],
  }, tokens.admin);
  assert.equal(r.status, 201);
  assert.equal(r.data.created.length, 2);

  const t1 = (await api('GET', `/api/tasks/${r.data.created[0].id}`, null, tokens.admin)).data;
  assert.equal(t1.pickup.code, 'A3');           // arrival: pickup at the gate
  assert.equal(t1.destination.code, 'BG1');     // arrival: default destination baggage
  assert.equal(t1.storage.type, 'STORAGE');     // nearest storage auto-picked
  assert.equal(t1.flight_number, 'EK202');
  assert.equal(t1.sla_target_minutes, 20);

  const t2 = (await api('GET', `/api/tasks/${r.data.created[1].id}`, null, tokens.admin)).data;
  assert.equal(t2.ssr_code, 'WCHC');
  assert.equal(t2.priority, 'HIGH');            // fully-immobile passengers prioritized
  assert.equal(t2.wheelchair_type, 'AISLE');

  // re-posting the same manifest creates nothing new
  const again = await api('POST', `/api/flights/${ek.id}/ssrs`, {
    passengers: [{ name: 'Omar Farouk', ssr_code: 'WCHR' }],
  }, tokens.admin);
  assert.equal(again.data.created.length, 0);
  assert.equal(again.data.skipped.length, 1);

  // departures route check-in → gate
  const qr = flights.find(f => f.flight_number === 'QR117'); // DEPARTURE, gate B3
  const dep = await api('POST', `/api/flights/${qr.id}/ssrs`, {
    passengers: [{ name: 'Departing Pax', ssr_code: 'WCHS' }],
  }, tokens.admin);
  const t3 = (await api('GET', `/api/tasks/${dep.data.created[0].id}`, null, tokens.admin)).data;
  assert.equal(t3.pickup.code, 'CK1');
  assert.equal(t3.destination.code, 'B3');
  assert.equal(t3.sla_target_minutes, 30);
});

test('SSR intake with auto_assign assigns on-duty agents', async () => {
  await api('POST', '/api/shift', { on_duty: true }, tokens.ahmed);
  const flights = (await api('GET', '/api/flights', null, tokens.admin)).data;
  const ba = flights.find(f => f.flight_number === 'BA106');
  const r = await api('POST', `/api/flights/${ba.id}/ssrs`, {
    passengers: [{ name: 'Assigned Automatically', ssr_code: 'WCHR' }],
    auto_assign: true,
  }, tokens.admin);
  assert.equal(r.data.created[0].assigned_to, 'Ahmed Hassan');
});
