// SQLite access: schema (SPEC §3), tiny migration runner, config helpers.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from './defaults.js';
import { forSale } from './scrape/sale.js';

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
  // Pairs a person has looked at and said "not the same villa". The duplicate checker
  // (src/scrape/duplicates.js) never offers a dismissed pair again. Always stored with
  // property_a < property_b so the UNIQUE index catches the pair in either direction.
  {
    name: '003_duplicate_dismissals',
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS duplicate_dismissals (
        id INTEGER PRIMARY KEY,
        property_a INTEGER NOT NULL, property_b INTEGER NOT NULL,
        by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(property_a, property_b)
      );`),
  },
  // Shared search: each person's one-tap call on a listing (yes / maybe / no). One row per
  // person per listing; the scraper never touches it (CLAUDE.md: people's rows are theirs).
  {
    name: '004_verdicts',
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS verdicts (
        id INTEGER PRIMARY KEY,
        property_id INTEGER NOT NULL, by INTEGER NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'maybe', 'no')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(property_id, by)
      );`),
  },
  // Anchors: the people's own places (gym, school, co-working). Distances to them are
  // derived on every row; the scraper never writes here.
  {
    name: '005_anchors',
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS anchors (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        lat REAL NOT NULL, lng REAL NOT NULL,
        by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`),
  },
  // The archive (SPEC §16): a listing that leaves the market keeps its row, and the row
  // now records *when* it went and *why*, instead of the reader inferring it from
  // `last_seen`. `last_seen` goes back to meaning what it says — the last time the source
  // actually showed us the listing — so "it was live for 6 days" is answerable.
  {
    name: '006_removed_at',
    up: (db) => {
      addColumn(db, 'properties', 'removed_at', 'TEXT');
      addColumn(db, 'properties', 'removed_reason', 'TEXT');
      // Backfill what the old rows can still tell us. A gone/unlisted row's `last_seen`
      // was the detection moment for `gone` and the last sighting for `unlisted`; both
      // are the best removal date on record, so both become `removed_at`.
      db.exec(`UPDATE properties
                  SET removed_at = last_seen,
                      removed_reason = CASE
                        WHEN json_extract(raw, '$.merged_into') IS NOT NULL THEN 'merged'
                        WHEN availability = 'unlisted' THEN 'unlisted'
                        ELSE 'delisted' END
                WHERE availability IN ('gone', 'unlisted') AND removed_at IS NULL`);
      db.exec(`UPDATE properties
                  SET removed_at = COALESCE(status_at, last_seen), removed_reason = 'taken'
                WHERE status = 'gone' AND removed_at IS NULL`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_props_removed ON properties(removed_at DESC)');
    },
  },
  // SPEC §2 widened the budget to 20–80 M on 2026-09-20, but `seedConfig` only ever
  // INSERT OR IGNOREs, so a database seeded before that kept scoring against 25–50 M.
  // Move it — but only where the old pair is still untouched, so a budget someone set
  // deliberately afterwards survives. Scope depends on it: the caller rescores (openDb).
  {
    name: '007_budget_20_80',
    up: (db) => {
      const read = db.prepare('SELECT value FROM config WHERE key = ?');
      const at = (key) => read.get(key)?.value;
      if (at('budget_min') !== '25000000' || at('budget_max') !== '50000000') return;
      const set = db.prepare('UPDATE config SET value = ? WHERE key = ?');
      set.run(String(DEFAULT_CONFIG.budget_min), 'budget_min');
      set.run(String(DEFAULT_CONFIG.budget_max), 'budget_max');
    },
  },
  // The Canggu belt joined the brief on 2026-09-22 (SPEC §2, §7). `config.areas` is seeded
  // once and never widens on its own, so a database from before that date scores the belt
  // as `market`. Both lists are spelled out here rather than read from DEFAULT_CONFIG: an
  // applied migration must mean the same thing forever. Replace the list only where it is
  // still exactly the old one, so a target list someone edited by hand survives.
  {
    name: '008_canggu_belt_areas',
    up: (db) => {
      const BEFORE = [
        'seseh', 'cemagi', 'munggu', 'pererenan', 'nyanyi', 'kedungu', 'tanah_lot', 'buwit',
        'mengwi', 'bingin', 'padang_padang', 'uluwatu', 'balangan', 'ungasan', 'pandawa',
      ];
      const AFTER = [
        'seseh', 'cemagi', 'munggu', 'pererenan', 'nyanyi', 'kedungu', 'tanah_lot', 'buwit',
        'mengwi', 'canggu', 'babakan', 'berawa', 'padonan', 'tibubeneng', 'umalas',
        'bingin', 'padang_padang', 'uluwatu', 'balangan', 'ungasan', 'pandawa',
      ];
      const row = db.prepare("SELECT value FROM config WHERE key = 'areas'").get();
      if (!row) return;
      let stored;
      try {
        stored = JSON.parse(row.value);
      } catch {
        return;
      }
      if (!Array.isArray(stored) || stored.length !== BEFORE.length) return;
      if (!BEFORE.every((a) => stored.includes(a))) return;
      db.prepare("UPDATE config SET value = ? WHERE key = 'areas'").run(JSON.stringify(AFTER));
    },
  },
  // Center — around Ubud — joined the brief on 2026-09-22, a few hours after the belt
  // (SPEC §2, §7). Same guard, same reason as 008: only a list that is still exactly the
  // one 008 left behind is widened, so a brief someone narrowed by hand survives.
  {
    name: '009_ubud_area',
    up: (db) => {
      const BEFORE = [
        'seseh', 'cemagi', 'munggu', 'pererenan', 'nyanyi', 'kedungu', 'tanah_lot', 'buwit',
        'mengwi', 'canggu', 'babakan', 'berawa', 'padonan', 'tibubeneng', 'umalas',
        'bingin', 'padang_padang', 'uluwatu', 'balangan', 'ungasan', 'pandawa',
      ];
      const row = db.prepare("SELECT value FROM config WHERE key = 'areas'").get();
      if (!row) return;
      let stored;
      try {
        stored = JSON.parse(row.value);
      } catch {
        return;
      }
      if (!Array.isArray(stored) || stored.length !== BEFORE.length) return;
      if (!BEFORE.every((a) => stored.includes(a))) return;
      db.prepare("UPDATE config SET value = ? WHERE key = 'areas'").run(JSON.stringify([...BEFORE, 'ubud']));
    },
  },
  // Friends join on 2026-09-26 (SPEC §17). People now sit in teams: a team shares its
  // verdicts, pipeline, notes, visits and places; nothing crosses to another team.
  // Team 1 is the home team (the two owners) and keeps its pipeline on the `properties`
  // columns, so the scraper and every existing query stay as they were; any other team's
  // pipeline lives in `team_listings`. Everyone who exists today is an owner of team 1.
  {
    name: '010_teams',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS team_listings (
        team_id INTEGER NOT NULL, property_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'new', status_by INTEGER, status_at TEXT,
        notes TEXT, assessed TEXT NOT NULL DEFAULT 'not_yet',
        PRIMARY KEY (team_id, property_id)
      );`);
      addColumn(db, 'users', 'team_id', 'INTEGER');
      addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'member'");
      addColumn(db, 'users', 'disabled_at', 'TEXT');
      // Session cookies issued before this moment are void (password reset, disable).
      addColumn(db, 'users', 'session_epoch', 'TEXT');
      const names = db.prepare('SELECT name FROM users ORDER BY id').all().map((u) => u.name);
      if (!names.length) return; // a fresh database: seedUsers creates the home team
      db.prepare('INSERT OR IGNORE INTO teams (id, name, created_at) VALUES (1, ?, ?)').run(names.join(' & '), nowIso());
      db.exec("UPDATE users SET team_id = 1, role = 'owner' WHERE team_id IS NULL");
    },
  },
  // The desa around Ubud — Tegallalang, Payangan, Pejeng, Lodtunduh/Mas — joined the
  // brief on 2026-09-26 ("activate ubud and surrounding areas"). Same guard as 008/009:
  // only the list 009 left behind is widened, so a brief someone narrowed by hand stays.
  {
    name: '011_ubud_surrounds',
    up: (db) => {
      const BEFORE = [
        'seseh', 'cemagi', 'munggu', 'pererenan', 'nyanyi', 'kedungu', 'tanah_lot', 'buwit',
        'mengwi', 'canggu', 'babakan', 'berawa', 'padonan', 'tibubeneng', 'umalas',
        'bingin', 'padang_padang', 'uluwatu', 'balangan', 'ungasan', 'pandawa', 'ubud',
      ];
      const ADDED = ['tegallalang', 'payangan', 'pejeng', 'lodtunduh'];
      const row = db.prepare("SELECT value FROM config WHERE key = 'areas'").get();
      if (!row) return;
      let stored;
      try {
        stored = JSON.parse(row.value);
      } catch {
        return;
      }
      if (!Array.isArray(stored) || stored.length !== BEFORE.length) return;
      if (!BEFORE.every((a) => stored.includes(a))) return;
      db.prepare("UPDATE config SET value = ? WHERE key = 'areas'").run(JSON.stringify([...stored, ...ADDED]));
    },
  },
  // "For sale" (2026-09-27, Philipp: filter out monthly, yearly, sale). Derived from the
  // title and description (src/scrape/sale.js) on every write and rescore; filled here once
  // for the rows already stored.
  {
    name: '012_for_sale',
    up: (db) => {
      addColumn(db, 'properties', 'for_sale', 'INTEGER NOT NULL DEFAULT 0');
      const set = db.prepare('UPDATE properties SET for_sale = 1 WHERE id = ?');
      for (const row of db.prepare('SELECT id, title, description FROM properties').all()) {
        if (forSale(row)) set.run(row.id);
      }
    },
  },
];

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const done = new Set(db.prepare('SELECT name FROM migrations').all().map((r) => r.name));
  const record = db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)');
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    db.transaction(() => {
      m.up(db);
      record.run(m.name, nowIso());
    })();
    applied.push(m.name);
  }
  return applied;
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
  // A weight added to the brief after the config was seeded (land, style on 2026-09-20)
  // shows up at its default until someone edits it, so the Agent page can offer the slider.
  if (out.weights && typeof out.weights === 'object') out.weights = { ...DEFAULT_WEIGHTS, ...out.weights };
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
  const applied = runMigrations(db);
  seedConfig(db);
  // A migration can move the brief (007) or backfill derived columns (006); every scope
  // and score is stale until someone rescores. `src/index.js` does it on boot.
  db.migrationsApplied = applied;
  return db;
}

export default openDb;
