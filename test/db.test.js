import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getConfig, setConfig, nowIso, MIGRATIONS } from '../src/db.js';
import { DEFAULT_WEIGHTS } from '../src/defaults.js';
import { AREAS } from '../src/areas.js';

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
  assert.equal(cfg.weights.living_open, 3);
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
  assert.equal(cfg.weights.land, 14, 'a weight missing from the stored object reads as its default');
  assert.equal(cfg.weights.style, 12);
  assert.equal(cfg.weights.price, 10);
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

test('007: an old 25–50 M budget is widened to the SPEC brief, a chosen one is left alone', () => {
  // A database seeded before 2026-09-20 kept the narrow pair; seedConfig never overwrites.
  const stale = openDb(tmpDbPath());
  stale.prepare('DELETE FROM migrations WHERE name = ?').run('007_budget_20_80');
  setConfig(stale, 'budget_min', 25_000_000);
  setConfig(stale, 'budget_max', 50_000_000);
  const file = stale.name;
  stale.close();

  const migrated = openDb(file);
  assert.deepEqual(migrated.migrationsApplied, ['007_budget_20_80']);
  assert.equal(getConfig(migrated).budget_min, 20_000_000);
  assert.equal(getConfig(migrated).budget_max, 80_000_000);
  migrated.close();

  // A budget someone set deliberately survives the same migration.
  const chosen = openDb(tmpDbPath());
  chosen.prepare('DELETE FROM migrations WHERE name = ?').run('007_budget_20_80');
  setConfig(chosen, 'budget_min', 30_000_000);
  setConfig(chosen, 'budget_max', 45_000_000);
  const chosenFile = chosen.name;
  chosen.close();

  const after = openDb(chosenFile);
  assert.equal(getConfig(after).budget_min, 30_000_000);
  assert.equal(getConfig(after).budget_max, 45_000_000);
  after.close();
});

test('openDb reports nothing applied on a database that is already current', () => {
  const file = tmpDbPath();
  openDb(file).close();
  const again = openDb(file);
  assert.deepEqual(again.migrationsApplied, []);
  again.close();
});

test('008: the Canggu belt joins an untouched target list, a hand-edited one is left alone', () => {
  const BEFORE = [
    'seseh', 'cemagi', 'munggu', 'pererenan', 'nyanyi', 'kedungu', 'tanah_lot', 'buwit',
    'mengwi', 'bingin', 'padang_padang', 'uluwatu', 'balangan', 'ungasan', 'pandawa',
  ];

  const stale = openDb(tmpDbPath());
  stale.prepare('DELETE FROM migrations WHERE name = ?').run('008_canggu_belt_areas');
  setConfig(stale, 'areas', BEFORE);
  const file = stale.name;
  stale.close();

  const migrated = openDb(file);
  assert.deepEqual(migrated.migrationsApplied, ['008_canggu_belt_areas']);
  const areas = getConfig(migrated).areas;
  assert.equal(areas.length, 21);
  for (const a of ['canggu', 'babakan', 'berawa', 'padonan', 'tibubeneng', 'umalas']) {
    assert.ok(areas.includes(a), `${a} joined the target list`);
  }
  for (const a of BEFORE) assert.ok(areas.includes(a), `${a} is still in it`);
  migrated.close();

  // Someone who narrowed the brief by hand keeps their list.
  const chosen = openDb(tmpDbPath());
  chosen.prepare('DELETE FROM migrations WHERE name = ?').run('008_canggu_belt_areas');
  setConfig(chosen, 'areas', ['pererenan', 'seseh']);
  const chosenFile = chosen.name;
  chosen.close();

  const after = openDb(chosenFile);
  assert.deepEqual(getConfig(after).areas, ['pererenan', 'seseh']);
  after.close();
});

test('011: the desa around Ubud join the list 009 left, a hand-edited one is left alone', () => {
  const AFTER_009 = [
    'seseh', 'cemagi', 'munggu', 'pererenan', 'nyanyi', 'kedungu', 'tanah_lot', 'buwit',
    'mengwi', 'canggu', 'babakan', 'berawa', 'padonan', 'tibubeneng', 'umalas',
    'bingin', 'padang_padang', 'uluwatu', 'balangan', 'ungasan', 'pandawa', 'ubud',
  ];

  const stale = openDb(tmpDbPath());
  stale.prepare('DELETE FROM migrations WHERE name = ?').run('011_ubud_surrounds');
  setConfig(stale, 'areas', AFTER_009);
  const file = stale.name;
  stale.close();

  const migrated = openDb(file);
  assert.deepEqual(migrated.migrationsApplied, ['011_ubud_surrounds']);
  const areas = getConfig(migrated).areas;
  assert.equal(areas.length, 26);
  for (const a of ['tegallalang', 'payangan', 'pejeng', 'lodtunduh']) {
    assert.ok(areas.includes(a), `${a} joined the target list`);
  }
  for (const a of AFTER_009) assert.ok(areas.includes(a), `${a} is still in it`);
  migrated.close();

  // A brief someone narrowed by hand survives, Ubud centre included.
  const chosen = openDb(tmpDbPath());
  chosen.prepare('DELETE FROM migrations WHERE name = ?').run('011_ubud_surrounds');
  setConfig(chosen, 'areas', ['ubud', 'pererenan']);
  const chosenFile = chosen.name;
  chosen.close();

  const after = openDb(chosenFile);
  assert.deepEqual(getConfig(after).areas, ['ubud', 'pererenan']);
  after.close();
});

test('every area in the default brief is a SPEC §7 area with a group', () => {
  const db = openDb(tmpDbPath());
  for (const id of getConfig(db).areas) {
    assert.ok(AREAS[id], `${id} is in areas.js`);
    assert.ok(['center', 'west_coast', 'south'].includes(AREAS[id].group), `${id} has a group`);
  }
  db.close();
});
