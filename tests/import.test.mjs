// Tests for real-airport import: GPS locations, projection refit, template seeding.
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

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  tokens.admin = (await api('POST', '/api/login',
    { username: 'admin', password: 'admin123' })).data.token;
});

after(() => server.close());

// A tiny "real airport": ~500 m wide, ~300 m tall, somewhere else on the planet.
const REAL = {
  locations: [
    { code: 'G1', name: 'Gate 1', type: 'GATE', lat: 40.6420, lng: -73.7790 },
    { code: 'G2', name: 'Gate 2', type: 'GATE', lat: 40.6435, lng: -73.7760 },
    { code: 'CKA', name: 'Check-in A', type: 'CHECKIN', lat: 40.6408, lng: -73.7775 },
    { code: 'STA', name: 'Storage A', type: 'STORAGE', lat: 40.6412, lng: -73.7782 },
    { code: 'BGA', name: 'Baggage A', type: 'BAGGAGE', lat: 40.6405, lng: -73.7768 },
  ],
  templates: [
    { from: 'STA', to: 'G1', minutes: 5 },
    { from: 'G1', to: 'BGA', minutes: 9, both_ways: false },
  ],
};

test('import validates input', async () => {
  assert.equal((await api('POST', '/api/locations/import', {}, tokens.admin)).status, 400);
  const bad = await api('POST', '/api/locations/import',
    { locations: [{ code: 'X', name: 'X', type: 'GATE' }] }, tokens.admin);
  assert.equal(bad.status, 400); // no coordinates
});

test('import refits map projection and places locations inside the map box', async () => {
  const r = await api('POST', '/api/locations/import', REAL, tokens.admin);
  assert.equal(r.status, 200);
  assert.equal(r.data.imported_locations, 5);
  assert.equal(r.data.map_refitted, true);
  assert.equal(r.data.seeded_templates, 3); // 2 both-ways + 1 one-way
  assert.ok(r.data.map_ref.meters_per_unit > 0);

  const locs = (await api('GET', '/api/locations', null, tokens.admin)).data;
  const g1 = locs.find(l => l.code === 'G1');
  assert.ok(g1, 'imported location exists');
  // every location (including pre-existing demo ones, re-projected) has finite x/y
  for (const l of locs) {
    assert.ok(Number.isFinite(l.x) && Number.isFinite(l.y), `${l.code} projected`);
  }
  // the imported airport spans the map box
  const imported = locs.filter(l => ['G1', 'G2', 'CKA', 'STA', 'BGA'].includes(l.code));
  for (const l of imported) {
    assert.ok(l.x >= 45 && l.x <= 955, `${l.code} x in box (${l.x})`);
    assert.ok(l.y >= 55 && l.y <= 545, `${l.code} y in box (${l.y})`);
  }
  // westernmost longitude maps near x=50, easternmost near x=950
  const g1x = imported.find(l => l.code === 'G1').x;
  const g2x = imported.find(l => l.code === 'G2').x;
  assert.ok(g1x < g2x, 'east-west order preserved');
});

test('imported templates drive estimates; config endpoint exposes projection', async () => {
  const cfg = (await api('GET', '/api/config', null, tokens.admin)).data;
  assert.ok(cfg.map_ref.meters_per_unit > 0);

  const locs = (await api('GET', '/api/locations', null, tokens.admin)).data;
  const sta = locs.find(l => l.code === 'STA').id;
  const g1 = locs.find(l => l.code === 'G1').id;
  const bga = locs.find(l => l.code === 'BGA').id;
  const est = (await api('GET',
    `/api/estimate?storage=${sta}&pickup=${g1}&destination=${bga}`, null, tokens.admin)).data;
  assert.equal(est.total_minutes, 14); // STA→G1 = 5 (seeded), G1→BGA = 9 (seeded one-way)
  assert.ok(est.legs.every(l => l.source === 'template'));

  // distance fallback on an unseeded pair stays sane (uses meters_per_unit)
  const g2 = locs.find(l => l.code === 'G2').id;
  const fb = (await api('GET',
    `/api/estimate?pickup=${g2}&destination=${bga}`, null, tokens.admin)).data;
  assert.equal(fb.legs[0].source, 'distance');
  assert.ok(fb.total_minutes >= 2 && fb.total_minutes < 60, `sane fallback (${fb.total_minutes})`);
});

test('re-import updates in place (no duplicates), one-way template respected', async () => {
  const again = await api('POST', '/api/locations/import', {
    locations: [{ code: 'G1', name: 'Gate 1 (renamed)', type: 'GATE', lat: 40.6420, lng: -73.7790 }],
    fit_map: false,
  }, tokens.admin);
  assert.equal(again.data.imported_locations, 1);
  assert.equal(again.data.map_refitted, false);
  const locs = (await api('GET', '/api/locations', null, tokens.admin)).data;
  assert.equal(locs.filter(l => l.code === 'G1').length, 1);
  assert.equal(locs.find(l => l.code === 'G1').name, 'Gate 1 (renamed)');

  // G1→BGA was seeded one-way; the reverse should have no template
  const tpls = (await api('GET', '/api/templates', null, tokens.admin)).data;
  assert.ok(tpls.some(t => t.from_code === 'G1' && t.to_code === 'BGA'));
  assert.ok(!tpls.some(t => t.from_code === 'BGA' && t.to_code === 'G1'));
  // but STA↔G1 was seeded both ways
  assert.ok(tpls.some(t => t.from_code === 'STA' && t.to_code === 'G1'));
  assert.ok(tpls.some(t => t.from_code === 'G1' && t.to_code === 'STA'));
});

test('replace: true removes unreferenced old locations but keeps referenced ones', async () => {
  const before = (await api('GET', '/api/locations', null, tokens.admin)).data;
  assert.ok(before.some(l => l.code === 'CK1')); // demo location, unreferenced
  const r = await api('POST', '/api/locations/import',
    { ...REAL, replace: true, fit_map: false }, tokens.admin);
  assert.ok(r.data.removed_locations > 0, 'some demo locations removed');
  const after = (await api('GET', '/api/locations', null, tokens.admin)).data;
  assert.ok(!after.some(l => l.code === 'CK1'), 'unreferenced demo location gone');
  assert.ok(after.some(l => l.code === 'S1'), 'storage with chairs kept');
  assert.ok(after.some(l => l.code === 'A3'), 'gate referenced by a flight kept');
  assert.ok(after.some(l => l.code === 'G1'), 'imported locations present');
});

test('single location add accepts real GPS and derives map position', async () => {
  const r = await api('POST', '/api/locations', {
    code: 'G9', name: 'Gate 9', type: 'GATE', lat: 40.6428, lng: -73.7770,
  }, tokens.admin);
  assert.equal(r.status, 201);
  assert.ok(Number.isFinite(r.data.x) && Number.isFinite(r.data.y));
  assert.ok(Math.abs(r.data.lat - 40.6428) < 1e-9);
});
