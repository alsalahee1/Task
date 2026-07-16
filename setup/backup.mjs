// Database backup: writes a clean, single-file snapshot of the live database
// using SQLite's `VACUUM INTO` (safe to run while the server is running — it
// produces a consistent copy without stopping the app).
//
//   node setup/backup.mjs [--db data/aeroassist.db] [--out backups/]
//
// Cron example (daily at 02:30, keeping the last 30 days):
//   30 2 * * *  cd /path/to/app && node setup/backup.mjs && \
//               find backups -name 'aeroassist-*.db' -mtime +30 -delete
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const dbPath = arg('db', process.env.AERO_DB || 'data/aeroassist.db');
const outDir = arg('out', 'backups');
mkdirSync(outDir, { recursive: true });

// Timestamp for the filename (colon-free so it is valid on every filesystem).
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = join(outDir, `aeroassist-${stamp}.db`);

const db = new DatabaseSync(dbPath);
try {
  // VACUUM INTO takes a live-consistent snapshot into a brand-new file.
  db.exec(`VACUUM INTO '${outFile.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const kb = Math.max(1, Math.round(statSync(outFile).size / 1024));
console.log(`Backup written: ${outFile} (${kb} KB)`);
console.log('Restore by stopping the server and copying this file over data/aeroassist.db');
