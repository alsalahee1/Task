// Tests for Tier-1 hardening: roles, account management, password flows,
// login throttling, session invalidation, and the audit log.
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

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  tok.admin = (await login('admin', 'admin123')).data.token;
  tok.super = (await login('omar', 'super123')).data.token;
  tok.agent = (await login('ahmed', 'agent123')).data.token;
});
after(() => server.close());

test('seed includes a SUPERVISOR account that can sign in', async () => {
  const r = await login('omar', 'super123');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'SUPERVISOR');
});

test('role gating: supervisor can dispatch but cannot manage users', async () => {
  // supervisor CAN read the board / reports (dispatch)
  assert.equal((await api('GET', '/api/tasks', null, tok.super)).status, 200);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await api('GET', `/api/reports/summary?from=${today}&to=${today}`, null, tok.super)).status, 200);
  // supervisor CANNOT list or create users (admin-only)
  assert.equal((await api('GET', '/api/users', null, tok.super)).status, 403);
  assert.equal((await api('POST', '/api/users', { username: 'x', name: 'X', role: 'AGENT', password: 'secret1' }, tok.super)).status, 403);
  // agent cannot reach the audit log
  assert.equal((await api('GET', '/api/audit', null, tok.agent)).status, 403);
  // supervisor CAN read the audit log
  assert.equal((await api('GET', '/api/audit', null, tok.super)).status, 200);
});

test('admin creates a user; new user must change password on first sign-in', async () => {
  const c = await api('POST', '/api/users',
    { username: 'newagent', name: 'New Agent', role: 'AGENT', skills: ['AISLE_CHAIR'], password: 'temp123' }, tok.admin);
  assert.equal(c.status, 201);
  assert.equal(c.data.must_change_password, true);

  const l = await login('newagent', 'temp123');
  assert.equal(l.status, 200);
  assert.equal(l.data.user.must_change_password, true, 'login flags forced change');

  // duplicate username rejected
  const dup = await api('POST', '/api/users',
    { username: 'newagent', name: 'Dup', role: 'AGENT', password: 'temp123' }, tok.admin);
  assert.equal(dup.status, 409);

  // too-short password rejected
  const short = await api('POST', '/api/users',
    { username: 'shorty', name: 'S', role: 'AGENT', password: '123' }, tok.admin);
  assert.equal(short.status, 400);
});

test('password change: wrong current rejected, success invalidates other sessions', async () => {
  // sign the new agent in twice → two sessions
  const s1 = (await login('newagent', 'temp123')).data.token;
  const s2 = (await login('newagent', 'temp123')).data.token;

  assert.equal((await api('POST', '/api/password', { current: 'wrong', new: 'brandnew1' }, s1)).status, 403);
  assert.equal((await api('POST', '/api/password', { current: 'temp123', new: 'x' }, s1)).status, 400);

  const ok = await api('POST', '/api/password', { current: 'temp123', new: 'brandnew1' }, s1);
  assert.equal(ok.status, 200);
  // the OTHER session is now invalid; the current one still works
  assert.equal((await api('GET', '/api/me', null, s2)).status, 401);
  assert.equal((await api('GET', '/api/me', null, s1)).data.must_change_password, false);
  // and the new password works
  assert.equal((await login('newagent', 'brandnew1')).status, 200);
});

test('admin reset-password issues a temporary password and forces a change', async () => {
  const target = (await api('GET', '/api/users', null, tok.admin)).data.find(u => u.username === 'newagent');
  const r = await api('POST', `/api/users/${target.id}/reset-password`, {}, tok.admin);
  assert.equal(r.status, 200);
  assert.ok(r.data.temporary_password.length >= 6);
  const l = await login('newagent', r.data.temporary_password);
  assert.equal(l.status, 200);
  assert.equal(l.data.user.must_change_password, true);
});

test('disabling a user blocks login and kills their live session immediately', async () => {
  const c = await api('POST', '/api/users',
    { username: 'tempuser', name: 'Temp User', role: 'AGENT', password: 'temp123' }, tok.admin);
  const id = c.data.id;
  const sess = (await login('tempuser', 'temp123')).data.token;
  assert.equal((await api('GET', '/api/me', null, sess)).status, 200);

  const dis = await api('PATCH', `/api/users/${id}`, { disabled: true }, tok.admin);
  assert.equal(dis.status, 200);
  assert.equal(dis.data.disabled, true);
  // existing token no longer valid
  assert.equal((await api('GET', '/api/me', null, sess)).status, 401);
  // and cannot log back in
  assert.equal((await login('tempuser', 'temp123')).status, 403);

  // re-enable restores login
  await api('PATCH', `/api/users/${id}`, { disabled: false }, tok.admin);
  assert.equal((await login('tempuser', 'temp123')).status, 200);
});

test('guards: cannot disable yourself or remove the last admin', async () => {
  const me = (await api('GET', '/api/me', null, tok.admin)).data;
  assert.equal((await api('PATCH', `/api/users/${me.id}`, { disabled: true }, tok.admin)).status, 409);
  // only one admin exists → cannot demote or disable it
  assert.equal((await api('PATCH', `/api/users/${me.id}`, { role: 'AGENT' }, tok.admin)).status, 409);

  // after a SECOND admin exists, demoting the first is allowed
  const second = await api('POST', '/api/users',
    { username: 'admin2', name: 'Second Admin', role: 'ADMIN', password: 'admin234' }, tok.admin);
  assert.equal(second.status, 201);
  assert.equal((await api('PATCH', `/api/users/${me.id}`, { role: 'SUPERVISOR' }, tok.admin)).status, 200);
  // restore so later assumptions hold
  await api('PATCH', `/api/users/${me.id}`, { role: 'ADMIN' }, tok.admin);
});

test('login throttling locks after repeated failures', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await login('probe_user', 'wrongpass');
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
  }
  const locked = await login('probe_user', 'wrongpass');
  assert.equal(locked.status, 429, 'locked after 5 failures');
});

test('audit log captures admin actions with actor attribution', async () => {
  // trigger an auditable action
  const today = new Date().toISOString().slice(0, 10);
  const locs = (await api('GET', '/api/locations', null, tok.admin)).data;
  const [a3, bg1] = [locs.find(l => l.code === 'A3').id, locs.find(l => l.code === 'BG1').id];
  const t = (await api('POST', '/api/tasks', {
    passenger_name: 'Audit Pax', flight_direction: 'ARRIVAL', pickup_id: a3, destination_id: bg1,
  }, tok.admin)).data;
  await api('POST', `/api/tasks/${t.id}/cancel`, { reason: 'test cancel' }, tok.admin);

  const audit = (await api('GET', '/api/audit', null, tok.admin)).data;
  assert.ok(audit.length > 0);
  assert.ok(audit.some(e => e.action === 'USER_CREATE'), 'user creation audited');
  assert.ok(audit.some(e => e.action === 'TASK_CANCEL' && e.detail === 'test cancel'), 'cancel audited');
  assert.ok(audit.some(e => e.action === 'LOGIN'), 'logins audited');
  assert.ok(audit.every(e => e.actor_name), 'every entry has an actor');
});
