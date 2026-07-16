// One-command DXB setup: imports Terminals 1/2/3 locations + walking-time seeds
// and installs the schematic floor plans as the per-terminal map backgrounds.
//
//   node setup/load-dxb.mjs [--url http://localhost:3000] [--user admin] [--pass admin123]
//
// Re-runnable: locations update in place; floor plans are overwritten.
import { readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const URL_ = arg('url', 'http://localhost:3000');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin123');

const login = await fetch(`${URL_}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (!login.ok) throw new Error(`Login failed: ${(await login.json()).error}`);
const { token } = await login.json();

const payload = JSON.parse(readFileSync(join(ROOT, 'setup', 'dxb-import.json'), 'utf8'));
const res = await fetch(`${URL_}/api/locations/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(payload),
});
const result = await res.json();
if (!res.ok) throw new Error(`Import failed: ${result.error}`);
console.log(`Imported ${result.imported_locations} locations ` +
  `(${result.removed_locations} old removed), seeded ${result.seeded_templates} walking times.`);
console.log(`Map projection refitted: ${result.map_refitted}`);

// install schematic floor plans (drop official PNGs over these later)
for (const f of readdirSync(join(ROOT, 'setup', 'floorplans'))) {
  copyFileSync(join(ROOT, 'setup', 'floorplans', f), join(ROOT, 'web', 'assets', f));
  console.log(`Installed web/assets/${f}`);
}
console.log('\nDXB T1/T2/T3 loaded. Open the Map tab and use the terminal buttons.');
console.log('NOTE: coordinates are approximate placeholders — verify via Google Maps');
console.log('satellite view and re-import (see docs/05-real-airport-setup.md).');
