import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getConfig, setConfig, nowIso, MIGRATIONS } from '../src/db.js';
import { DEFAULT_WEIGHTS } from '../src/defaults.js';

const TABLES = [
  'users', 'properties', 'contacts', 'property_contacts', 'agent_info', 'viewings',
  'ratings', 'feedback', 'runs', 'agent_notes', 'inbox', 'config', 'migrations',
];

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-db-'));
  return path.join(dir, 'nested', 'villa.db');
}

function names(db, type) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type).map((r) => r.name);
}

test('openDb creates the file, the directory and every SPEC §3 table', () => {
  const file = tmpDbPath();
  const db = openDb(file);
  assert.ok(fs.existsSync(file));
  const tables = names(db, 'table');
  for (const t of TABLES) assert.ok(tables.includes(t), `missing table ${t}`);
  const indexes = names(db, 'index');
  for (const i of ['idx_props_scope', 'idx_props_area', 'idx_contacts_wa']) {
    assert.ok(indexes.includes(i), `missing index ${i}`);
  }
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('config is seeded from DEFAULT_CONFIG and parsed back to real types', () => {
  const db = openDb(tmpDbPath());
  const cfg = getConfig(db);
  assert.equal(typeof cfg.weights, 'object');
  assert.equal(cfg.weights.living_open, 15);
  assert.equal(cfg.flag_threshold, 65);
  assert.equal(cfg.budget_min, 20_000_000);
  assert.equal(cfg.budget_max, 80_000_000);
  assert.equal(cfg.beach_km_max, 4);
  assert.equal(typeof cfg.band, 'object');
  assert.ok(Array.isArray(cfg.areas));
  assert.ok(cfg.areas.includes('seseh'));
  assert.equal(typeof cfg.red_flag_keywords, 'object');
  assert.ok(Array.isArray(cfg.low_priority_pockets));
  db.close();
});

test('setConfig round-trips objects and scalars', () => {
  const db = openDb(tmpDbPath());
  setConfig(db, 'flag_threshold', 70);
  setConfig(db, 'weights', { pool: 20 });
  const cfg = getConfig(db);
  assert.equal(cfg.flag_threshold, 70);
  assert.equal(cfg.weights.pool, 20);
  assert.equal(cfg.weights.land, 12, 'a weight missing from the stored object reads as its default');
  assert.equal(cfg.weights.style, 10);
  assert.equal(Object.keys(cfg.weights).length, Object.keys(DEFAULT_WEIGHTS).length);
  db.close();
});

test('migrations run once and reopening is idempotent', () => {
  const file = tmpDbPath();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrations').get().n, MIGRATIONS.length);
  setConfig(db, 'flag_threshold', 71);
  db.prepare('INSERT INTO agent_notes (date, text) VALUES (?, ?)').run('2026-09-17', 'hello');
  db.close();

  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM migrations').get().n, MIGRATIONS.length);
  assert.equal(getConfig(again).flag_threshold, 71, 'seeding must not overwrite existing keys');
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM agent_notes').get().n, 1);
  again.close();
});

test('nowIso is an ISO-8601 timestamp', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
