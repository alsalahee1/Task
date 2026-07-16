// Database layer — uses Node's built-in sqlite so the app has zero npm dependencies.
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 32).toString('hex');
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return scryptSync(password, salt, 32).toString('hex') === hash;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','AGENT')),
  skills TEXT NOT NULL DEFAULT '[]',
  on_duty INTEGER NOT NULL DEFAULT 0,
  last_lat REAL, last_lng REAL, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  terminal TEXT NOT NULL DEFAULT 'T1',
  x REAL NOT NULL, y REAL NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS route_templates (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES locations(id),
  to_id INTEGER NOT NULL REFERENCES locations(id),
  est_minutes REAL NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  manually_set INTEGER NOT NULL DEFAULT 1,
  UNIQUE(from_id, to_id)
);
CREATE TABLE IF NOT EXISTS route_actuals (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  minutes REAL NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  passenger_phone TEXT,
  passenger_notes TEXT,
  ssr_code TEXT NOT NULL DEFAULT 'WCHR',
  wheelchair_type TEXT NOT NULL DEFAULT 'MANUAL',
  flight_number TEXT,
  flight_direction TEXT NOT NULL CHECK (flight_direction IN ('ARRIVAL','DEPARTURE','TRANSFER')),
  flight_time TEXT,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH','URGENT')),
  storage_id INTEGER REFERENCES locations(id),
  pickup_id INTEGER NOT NULL REFERENCES locations(id),
  destination_id INTEGER NOT NULL REFERENCES locations(id),
  template_est_minutes REAL,
  admin_est_minutes REAL,
  sla_target_minutes INTEGER NOT NULL,
  sla_deadline_at TEXT NOT NULL,
  sla_met INTEGER,
  status TEXT NOT NULL DEFAULT 'CREATED',
  cancel_reason TEXT,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS task_assignments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  agent_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'PRIMARY',
  assigned_at TEXT NOT NULL,
  UNIQUE(task_id, agent_id)
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY,
  uuid TEXT UNIQUE,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  agent_id INTEGER,
  type TEXT NOT NULL,
  server_time TEXT NOT NULL,
  client_time TEXT,
  lat REAL, lng REAL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS trackpoints (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  agent_id INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  accuracy REAL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wheelchairs (
  id INTEGER PRIMARY KEY,
  qr_code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'MANUAL',
  home_storage_id INTEGER REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','IN_USE','MAINTENANCE')),
  current_location_id INTEGER REFERENCES locations(id),
  current_task_id INTEGER REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY,
  flight_number TEXT UNIQUE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('ARRIVAL','DEPARTURE')),
  sched_time TEXT,
  gate_id INTEGER REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'ON_TIME'
    CHECK (status IN ('ON_TIME','DELAYED','LANDED','BOARDING','DEPARTED','CANCELLED')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'LOGGED',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_track_task ON trackpoints(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_actuals_route ON route_actuals(from_id, to_id);
`;

// Map coordinate system: the SVG airport map is 1000x600 "map units" (~1 unit = 1 m).
// Locations carry both map x/y and real-looking lat/lng linked by a linear transform,
// so GPS trackpoints can be projected onto the terminal map.
export const MAP_REF = { lat0: 25.256, lng0: 55.36, scale: 1e5 };
export const xyToLatLng = (x, y) => ({
  lat: MAP_REF.lat0 - y / MAP_REF.scale,
  lng: MAP_REF.lng0 + x / MAP_REF.scale,
});

const SEED_LOCATIONS = [
  ['CK1', 'Check-in Hall', 'CHECKIN', 500, 550],
  ['S1', 'Wheelchair Storage A', 'STORAGE', 150, 350],
  ['S2', 'Wheelchair Storage B', 'STORAGE', 850, 350],
  ['A1', 'Gate A1', 'GATE', 60, 80], ['A2', 'Gate A2', 'GATE', 160, 60],
  ['A3', 'Gate A3', 'GATE', 260, 50], ['A4', 'Gate A4', 'GATE', 360, 60],
  ['A5', 'Gate A5', 'GATE', 460, 80],
  ['B1', 'Gate B1', 'GATE', 540, 80], ['B2', 'Gate B2', 'GATE', 640, 60],
  ['B3', 'Gate B3', 'GATE', 740, 50], ['B4', 'Gate B4', 'GATE', 840, 60],
  ['B5', 'Gate B5', 'GATE', 940, 80],
  ['TD1', 'Transfer Desk', 'TRANSFER_DESK', 500, 300],
  ['BG1', 'Baggage Claim', 'BAGGAGE', 350, 500],
  ['TX1', 'Taxi & Pickup Rank', 'TAXI', 650, 520],
];

// (from, to, minutes) — admin-seeded "usual time" values; they self-tune from actuals.
const SEED_TEMPLATES = [
  ['S1', 'A3', 6], ['S1', 'CK1', 8], ['S2', 'B3', 6], ['S2', 'CK1', 8],
  ['CK1', 'A3', 12], ['CK1', 'B3', 12], ['A3', 'B3', 14], ['B3', 'A3', 14],
  ['A3', 'BG1', 10], ['B3', 'BG1', 12], ['BG1', 'TX1', 6],
  ['A1', 'TD1', 9], ['TD1', 'B5', 10],
];

const SEED_USERS = [
  ['admin', 'admin123', 'Dispatch Admin', 'ADMIN', []],
  ['ahmed', 'agent123', 'Ahmed Hassan', 'AGENT', ['TWO_PERSON_LIFT']],
  ['fatima', 'agent123', 'Fatima Ali', 'AGENT', ['AISLE_CHAIR']],
  ['john', 'agent123', 'John Okafor', 'AGENT', ['ELECTRIC_CART']],
  ['sara', 'agent123', 'Sara Khan', 'AGENT', []],
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

// Additive migrations for databases created by earlier versions.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  if (!cols.includes('passenger_phone'))
    db.exec('ALTER TABLE tasks ADD COLUMN passenger_phone TEXT');
  if (!cols.includes('wheelchair_id'))
    db.exec('ALTER TABLE tasks ADD COLUMN wheelchair_id INTEGER REFERENCES wheelchairs(id)');
}

function seed(db) {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUsers) return;
  const insUser = db.prepare(
    'INSERT INTO users (username, password_hash, name, role, skills) VALUES (?,?,?,?,?)');
  for (const [u, p, name, role, skills] of SEED_USERS)
    insUser.run(u, hashPassword(p), name, role, JSON.stringify(skills));

  const insLoc = db.prepare(
    'INSERT INTO locations (code, name, type, terminal, x, y, lat, lng) VALUES (?,?,?,?,?,?,?,?)');
  for (const [code, name, type, x, y] of SEED_LOCATIONS) {
    const { lat, lng } = xyToLatLng(x, y);
    insLoc.run(code, name, type, 'T1', x, y, lat, lng);
  }

  const locId = db.prepare('SELECT id FROM locations WHERE code = ?');
  const insTpl = db.prepare(
    'INSERT INTO route_templates (from_id, to_id, est_minutes) VALUES (?,?,?)');
  for (const [from, to, min] of SEED_TEMPLATES)
    insTpl.run(locId.get(from).id, locId.get(to).id, min);

  // Wheelchair fleet: QR-tagged chairs parked at the two storage rooms.
  const insChair = db.prepare(
    `INSERT INTO wheelchairs (qr_code, type, home_storage_id, current_location_id)
     VALUES (?,?,?,?)`);
  for (const [qr, type, storage] of [
    ['WC-S1-001', 'MANUAL', 'S1'], ['WC-S1-002', 'MANUAL', 'S1'],
    ['WC-S1-003', 'AISLE', 'S1'], ['WC-S1-004', 'ELECTRIC', 'S1'],
    ['WC-S2-001', 'MANUAL', 'S2'], ['WC-S2-002', 'MANUAL', 'S2'],
    ['WC-S2-003', 'AISLE', 'S2'], ['WC-S2-004', 'CART', 'S2'],
  ]) {
    const sid = locId.get(storage).id;
    insChair.run(qr, type, sid, sid);
  }

  // Demo flight schedule (stands in for the AODB/FIDS feed).
  const insFlight = db.prepare(
    `INSERT INTO flights (flight_number, direction, sched_time, gate_id, status, updated_at)
     VALUES (?,?,?,?,?,?)`);
  const inHours = h => new Date(Date.now() + h * 3600000).toISOString();
  for (const [num, dir, hrs, gate, status] of [
    ['EK202', 'ARRIVAL', 0.5, 'A3', 'ON_TIME'],
    ['QR117', 'DEPARTURE', 2, 'B3', 'ON_TIME'],
    ['BA106', 'ARRIVAL', 1, 'A1', 'DELAYED'],
    ['LH630', 'DEPARTURE', 3, 'B5', 'ON_TIME'],
    ['TK762', 'ARRIVAL', 1.5, 'B1', 'ON_TIME'],
  ]) insFlight.run(num, dir, inHours(hrs), locId.get(gate).id, status, new Date().toISOString());
}
