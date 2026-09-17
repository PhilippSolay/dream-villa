// SPEC §9 "Backups" — nightly `data/backups/villa-<YYYY-MM-DD>.db`, keep 14.
//
// The slim runtime image has no sqlite3 CLI, so the copy is taken in-process with
// better-sqlite3's own online backup (consistent while the server keeps serving).

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BACKUP_DIR = 'data/backups';
export const DEFAULT_KEEP = 14;

const NAME_RE = /^villa-(\d{4}-\d{2}-\d{2})\.db$/;

export function backupName(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `villa-${d.toISOString().slice(0, 10)}.db`;
}

/**
 * Write one dated backup. Same-day reruns overwrite that day's file.
 * @returns {Promise<string>} the path written
 */
export async function backupDb(db, dir = DEFAULT_BACKUP_DIR, { date = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, backupName(date));
  await db.backup(dest);
  return dest;
}

/** Newest `keep` dated backups stay; the rest are removed. @returns {string[]} removed paths */
export function pruneBackups(dir = DEFAULT_BACKUP_DIR, keep = DEFAULT_KEEP) {
  if (!fs.existsSync(dir)) return [];
  const dated = fs
    .readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .sort()
    .reverse(); // ISO dates sort lexicographically — newest first

  const removed = [];
  for (const f of dated.slice(Math.max(0, keep))) {
    const p = path.join(dir, f);
    fs.rmSync(p, { force: true });
    removed.push(p);
  }
  return removed;
}

/** backup + prune, the whole nightly job. */
export async function runBackup(db, dir = DEFAULT_BACKUP_DIR, keep = DEFAULT_KEEP, { date = new Date() } = {}) {
  const file = await backupDb(db, dir, { date });
  const removed = pruneBackups(dir, keep);
  return { file, removed };
}

export default { backupDb, pruneBackups, runBackup, backupName, DEFAULT_BACKUP_DIR, DEFAULT_KEEP };
