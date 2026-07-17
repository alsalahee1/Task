// Tier-3 tests: public passenger status page + rating, and multi-leg journeys.
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
async function agent(u) {
  return (await api('GET', '/api/agents', null, tok.admin)).data.find(a => a.username === u);
}

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  tok.admin = (await login('admin', 'admin123')).data.token;
  tok.ahmed = (await login('ahmed', 'agent123')).data.token;
});
after(() => server.close());

test('tasks get a public status token; the public view hides sensitive data', async () => {
  const [a3, bg1] = await Promise.all([locId('A3'), locId('BG1')]);
  const ahmed = await agent('ahmed');
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Maria Lopez', passenger_phone: '+971500000000',
    passenger_notes: 'secret note', flight_number: 'EK202', flight_direction: 'ARRIVAL',
    pickup_id: a3, destination_id: bg1, agent_ids: [ahmed.id],
  }, tok.admin)).data;
  assert.ok(t.public_token && t.public_token.length >= 16, 'token minted at creation');

  // public endpoint needs no auth
  const pub = await api('GET', `/api/public/task/${t.public_token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.passenger_first_name, 'Maria');
  assert.equal(pub.data.agent_first_name, 'Ahmed');
  assert.equal(pub.data.status, 'ASSIGNED');
  assert.ok(pub.data.status_text.length > 0);
  // sensitive fields must NOT be present
  assert.equal(pub.data.passenger_phone, undefined);
  assert.equal(pub.data.passenger_notes, undefined);
  assert.equal(pub.data.passenger_name, undefined); // only first name exposed
  assert.equal(pub.data.can_rate, false);

  // a bad token is a 404
  assert.equal((await api('GET', '/api/public/task/deadbeefdeadbeef')).status, 404);
});

test('passenger can rate only after delivery; rating is stored', async () => {
  const [a3, bg1] = await Promise.all([locId('A3'), locId('BG1')]);
  const ahmed = await agent('ahmed');
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Rate Me', flight_direction: 'ARRIVAL',
    pickup_id: a3, destination_id: bg1, agent_ids: [ahmed.id],
  }, tok.admin)).data;
  const token = t.public_token;

  // cannot rate before delivery
  assert.equal((await api('POST', `/api/public/task/${token}/rating`, { stars: 5 })).status, 409);

  // walk to delivered
  for (const type of ['ACCEPTED', 'ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP', 'IN_TRANSIT', 'PASSENGER_DELIVERED'])
    await api('POST', `/api/tasks/${t.id}/events`, { type }, tok.ahmed);

  assert.equal((await api('GET', `/api/public/task/${token}`)).data.can_rate, true);
  assert.equal((await api('POST', `/api/public/task/${token}/rating`, { stars: 9 })).status, 400); // out of range
  const ok = await api('POST', `/api/public/task/${token}/rating`, { stars: 5, comment: 'Excellent help, thank you' });
  assert.equal(ok.status, 200);

  // rating visible to staff on the task
  const detail = (await api('GET', `/api/tasks/${t.id}`, null, tok.admin)).data;
  assert.equal(detail.rating, 5);
  assert.equal(detail.rating_comment, 'Excellent help, thank you');
  // and reflected on the public view
  assert.equal((await api('GET', `/api/public/task/${token}`)).data.rating, 5);
});

test('multi-leg journey: add a connecting leg handed to another agent', async () => {
  const [a1, td1, b5] = await Promise.all([locId('A1'), locId('TD1'), locId('B5')]);
  const ahmed = await agent('ahmed'), fatima = await agent('fatima');
  // leg 1: A1 → Transfer Desk, agent ahmed
  const leg1 = (await api('POST', '/api/tasks', {
    passenger_name: 'Long Transfer', flight_direction: 'TRANSFER',
    pickup_id: a1, destination_id: td1, agent_ids: [ahmed.id],
  }, tok.admin)).data;

  // add leg 2: Transfer Desk → B5, agent fatima
  const leg2res = await api('POST', `/api/tasks/${leg1.id}/add-leg`, {
    destination_id: b5, agent_ids: [fatima.id],
  }, tok.admin);
  assert.equal(leg2res.status, 201);
  const leg2 = leg2res.data;
  assert.equal(leg2.leg_number, 2);
  assert.equal(leg2.pickup.code, 'TD1', 'leg 2 starts at leg 1 destination');
  assert.equal(leg2.destination.code, 'B5');
  assert.equal(leg2.parent_task_id, leg1.id);
  assert.equal(leg2.passenger_name, 'Long Transfer', 'passenger carried across legs');
  assert.deepEqual(leg2.assignments.map(a => a.agent_id), [fatima.id]);

  // both legs share the chain view
  const detail1 = (await api('GET', `/api/tasks/${leg1.id}`, null, tok.admin)).data;
  assert.equal(detail1.chain.length, 2);
  assert.ok(detail1.chain.find(c => c.leg_number === 1 && c.is_current));
  assert.equal(detail1.chain[1].destination.code, 'B5');

  // leg destination cannot equal the handoff point
  const bad = await api('POST', `/api/tasks/${leg1.id}/add-leg`, { destination_id: td1 }, tok.admin);
  assert.equal(bad.status, 400);

  // legs share one passenger status token (one link for the whole journey)
  assert.equal(leg2.public_token, leg1.public_token);
});

test('add-leg is audited', async () => {
  const audit = (await api('GET', '/api/audit', null, tok.admin)).data;
  assert.ok(audit.some(e => e.action === 'ADD_LEG'));
});
