// SQLite access: schema (SPEC §3), tiny migration runner, config helpers.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from './defaults.js';

/** ISO-8601 UTC timestamp — the one time format used across the app. */
export function nowIso() {
  return new Date().toISOString();
}

/** SPEC §3, verbatim, made idempotent. */
const DDL_001 = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  ref TEXT, source TEXT NOT NULL,
  url TEXT NOT NULL, alt_urls TEXT,
  title TEXT NOT NULL, description TEXT, inclusions TEXT, terms TEXT,
  area TEXT NOT NULL,
  sub_area TEXT,
  address TEXT, lat REAL, lng REAL, pin_source TEXT,
  map_url TEXT,
  beach_km REAL, beach_name TEXT, beach_source TEXT,
  bedrooms INTEGER, extra_rooms INTEGER DEFAULT 0, bathrooms INTEGER,
  land_m2 INTEGER, build_m2 INTEGER,
  price_month_idr INTEGER, price_year_idr INTEGER, term TEXT,
  min_months INTEGER, furnished INTEGER, furniture_quality INTEGER,
  style TEXT,
  pool INTEGER, garden INTEGER, view TEXT, joglo INTEGER, aircon INTEGER, kitchen_full INTEGER,
  workspace INTEGER, living_open INTEGER, airy INTEGER,
  images TEXT,
  hero_file TEXT,
  availability TEXT,
  available_from TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, price_history TEXT,
  scope TEXT NOT NULL DEFAULT 'market',
  fit_score INTEGER, flagged INTEGER DEFAULT 0, red_flags TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  status_by INTEGER, status_at TEXT,
  assessed TEXT NOT NULL DEFAULT 'not_yet',
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_props_scope ON properties(scope, flagged, fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_props_area ON properties(area);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, name TEXT, role TEXT,
  phone TEXT, whatsapp TEXT, email TEXT, agency TEXT, instagram TEXT,
  responsiveness INTEGER, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_wa ON contacts(whatsapp) WHERE whatsapp IS NOT NULL;
CREATE TABLE IF NOT EXISTS property_contacts (property_id INTEGER, contact_id INTEGER, PRIMARY KEY(property_id, contact_id));

CREATE TABLE IF NOT EXISTS agent_info (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, contact_id INTEGER,
  by INTEGER NOT NULL, date TEXT NOT NULL,
  lease_terms TEXT, deposit TEXT, payment_schedule TEXT, included TEXT,
  neighbours TEXT, planned_builds TEXT, water_power TEXT, other TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS viewings (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, by INTEGER NOT NULL,
  date TEXT NOT NULL, time_of_day TEXT,
  quiet INTEGER, privacy INTEGER, living_room INTEGER, light INTEGER, breeze INTEGER,
  overlooked INTEGER, construction_nearby INTEGER, beach_minutes INTEGER,
  notes TEXT, photos TEXT,
  verdict TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, by INTEGER NOT NULL,
  feature TEXT NOT NULL,
  score INTEGER NOT NULL, comment TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY, property_id INTEGER, by INTEGER NOT NULL,
  text TEXT NOT NULL, applied INTEGER DEFAULT 0, applied_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
  kind TEXT NOT NULL,
  sources TEXT, seen INTEGER, new INTEGER, updated INTEGER, gone INTEGER, flagged INTEGER,
  weight_changes TEXT, notes TEXT, errors TEXT
);

CREATE TABLE IF NOT EXISTS agent_notes (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY, url TEXT UNIQUE NOT NULL, by TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Ordered; append only — never reorder or rewrite an applied migration. */
/** Adds a column unless it already exists (safe on DBs that predate the migration). */
function addColumn(db, table, column, type) {
  const has = db.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?').get(table, column).n;
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Append-only: never change an entry, only add.
export const MIGRATIONS = [
  { name: '001_initial_schema', up: (db) => db.exec(DDL_001) },
  // SPEC §4 lists `notes` among the person-editable fields of PATCH /api/properties/:id.
  { name: '002_property_notes', up: (db) => addColumn(db, 'properties', 'notes', 'TEXT') },
];

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const done = new Set(db.prepare('SELECT name FROM migrations').all().map((r) => r.name));
  const record = db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    db.transaction(() => {
      m.up(db);
      record.run(m.name, nowIso());
    })();
  }
}

/** Objects/arrays are stored as JSON; scalars as plain strings. */
function serialiseConfigValue(value) {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function parseConfigValue(raw) {
  if (raw === null || raw === undefined) return raw;
  const s = String(raw).trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  if (s !== '' && Number.isFinite(Number(s))) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return raw;
}

function seedConfig(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      insert.run(key, serialiseConfigValue(value));
    }
  })();
}

/** Whole config as a parsed object (numbers as numbers, JSON parsed). */
export function getConfig(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM config').all()) {
    out[row.key] = parseConfigValue(row.value);
  }
  return out;
}

export function setConfig(db, key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, serialiseConfigValue(value));
  return value;
}

/**
 * Open (and if needed create) the database file, run migrations, seed config.
 * Returns the better-sqlite3 Database instance; callers use prepare()/exec().
 */
export function openDb(dbPath = process.env.DB_PATH || 'data/villa.db') {
  const dir = path.dirname(path.resolve(dbPath));
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedConfig(db);
  return db;
}

export default openDb;
