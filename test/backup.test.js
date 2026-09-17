import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { backupDb, pruneBackups, runBackup, backupName } from '../src/backup.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-backup-'));
  const db = openDb(path.join(dir, 'villa.db'));
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('backupName — dated, one file per day', () => {
  assert.equal(backupName(new Date('2026-09-17T23:30:00.000Z')), 'villa-2026-09-17.db');
});

test('backupDb — writes a readable copy of the database', async () => {
  const t = tmpDb();
  try {
    t.db.prepare('INSERT INTO agent_notes (date, text) VALUES (?, ?)').run('2026-09-17', 'hello');

    const dir = path.join(t.dir, 'backups');
    const file = await backupDb(t.db, dir, { date: new Date('2026-09-17T00:00:00.000Z') });

    assert.equal(file, path.join(dir, 'villa-2026-09-17.db'));
    assert.ok(fs.existsSync(file));
    assert.ok(fs.statSync(file).size > 0);

    const copy = openDb(file);
    try {
      assert.equal(copy.prepare('SELECT text FROM agent_notes').get().text, 'hello');
    } finally {
      copy.close();
    }
  } finally {
    cleanup(t);
  }
});

test('pruneBackups — keeps the newest 14 and ignores anything else in the directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-prune-'));
  try {
    for (let d = 1; d <= 20; d++) {
      fs.writeFileSync(path.join(dir, `villa-2026-09-${String(d).padStart(2, '0')}.db`), 'x');
    }
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not a backup');
    fs.writeFileSync(path.join(dir, 'villa.db'), 'not dated');

    const removed = pruneBackups(dir, 14);
    assert.equal(removed.length, 6);

    const left = fs.readdirSync(dir).filter((f) => f.startsWith('villa-2026')).sort();
    assert.equal(left.length, 14);
    assert.equal(left[0], 'villa-2026-09-07.db');
    assert.equal(left[13], 'villa-2026-09-20.db');
    assert.ok(fs.existsSync(path.join(dir, 'README.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'villa.db')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneBackups — a missing directory is not an error', () => {
  assert.deepEqual(pruneBackups(path.join(os.tmpdir(), 'villa-does-not-exist-12345'), 14), []);
});

test('runBackup — backs up and prunes in one call', async () => {
  const t = tmpDb();
  try {
    const dir = path.join(t.dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'villa-2026-01-01.db'), 'old');

    const { file, removed } = await runBackup(t.db, dir, 1, { date: new Date('2026-09-17T00:00:00.000Z') });
    assert.equal(path.basename(file), 'villa-2026-09-17.db');
    assert.deepEqual(removed.map((p) => path.basename(p)), ['villa-2026-01-01.db']);
  } finally {
    cleanup(t);
  }
});
