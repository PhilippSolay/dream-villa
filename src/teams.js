// Teams (SPEC §17): who sees whose calls. A team shares its verdicts, pipeline status,
// notes, visits, ratings, feedback, agent info and places; nothing crosses to another
// team. Listing *facts* (the scraper's rows, photos, pins, contacts) are shared by all.
//
// Team 1 is the home team — the two owners. Its pipeline stays on the `properties`
// columns, so the scraper and every query written before teams existed read it
// unchanged. Any other team's pipeline lives in `team_listings`, and `listingsSql()`
// lays it over `properties` so a route can keep writing `WHERE status = 'shortlist'`.

import { getConfig, nowIso } from './db.js';

export const HOME_TEAM_ID = 1;
export const ROLES = ['owner', 'member'];

/** The pipeline columns a team owns; everything else on `properties` is a shared fact. */
export const TEAM_FIELDS = ['status', 'status_by', 'status_at', 'notes', 'assessed'];

// Columns the overlay recomputes per team instead of passing through.
const OVERLAID = new Set([...TEAM_FIELDS, 'flagged', 'removed_at', 'removed_reason']);

export function teamIdOf(user) {
  return Number.isInteger(user?.team_id) ? user.team_id : HOME_TEAM_ID;
}

/** No user (a script, the scraper) reads as the home team. */
export function isHome(user) {
  return teamIdOf(user) === HOME_TEAM_ID;
}

export function isOwner(user) {
  return user?.role === 'owner';
}

/**
 * SQL predicate: `col` holds the id of someone on the caller's team. The team id is an
 * integer from our own users table, so it is inlined rather than bound — callers can
 * drop this into any WHERE without re-counting their placeholders.
 */
export function sameTeamSql(user, col = 'by') {
  return `${col} IN (SELECT id FROM users WHERE COALESCE(team_id, ${HOME_TEAM_ID}) = ${teamIdOf(user)})`;
}

/** Ids of everyone on the caller's team, disabled people included (their rows stay the team's). */
export function teamMemberIds(db, user) {
  return db
    .prepare(`SELECT id FROM users WHERE COALESCE(team_id, ${HOME_TEAM_ID}) = ? ORDER BY id`)
    .all(teamIdOf(user))
    .map((r) => r.id);
}

/** Active teammates, the caller included: `[{id, name}]`, the roster `/api/me` returns. */
export function teamRoster(db, user) {
  return db
    .prepare(`SELECT id, name FROM users
               WHERE COALESCE(team_id, ${HOME_TEAM_ID}) = ? AND disabled_at IS NULL ORDER BY id`)
    .all(teamIdOf(user));
}

export function teamOf(db, user) {
  const id = teamIdOf(user);
  const row = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(id);
  return row || { id, name: null };
}

function propertyColumns(db) {
  return db.prepare("SELECT name FROM pragma_table_info('properties') ORDER BY cid").all().map((r) => r.name);
}

/**
 * A table expression with every `properties` column, as the caller's team sees it:
 * use it as `FROM ${listingsSql(db, user)} AS properties` (or any alias). For the home
 * team it is `properties` itself. For another team:
 *
 * - `status`, `status_by`, `status_at`, `notes`, `assessed` come from `team_listings`
 *   (`new` / `not_yet` when the team has not touched the listing);
 * - a listing the home team marked taken (`removed_reason = 'taken'`) reads `gone` for
 *   everyone — the agent said it is let, and that is a fact, not a preference;
 * - `removed_at` / `removed_reason` add the team's own Gone to the scraper's record;
 * - `flagged` is the §2 flag rule over the shared scope, score and red flags, with the
 *   team's own status in place of the home team's (a home Reject does not un-feature
 *   a listing for anyone else).
 */
export function listingsSql(db, user, config = null) {
  if (isHome(user)) return 'properties';
  const teamId = teamIdOf(user);
  const threshold = Number((config || getConfig(db)).flag_threshold);
  const thr = Number.isFinite(threshold) ? threshold : 65;
  const passThrough = propertyColumns(db)
    .filter((c) => !OVERLAID.has(c))
    .map((c) => `p.${c}`);
  const taken = "p.removed_reason = 'taken'";
  const status = `(CASE WHEN ${taken} THEN 'gone' ELSE COALESCE(t.status, 'new') END)`;
  return `(SELECT ${passThrough.join(', ')},
      ${status} AS status,
      CASE WHEN ${taken} THEN NULL ELSE t.status_by END AS status_by,
      CASE WHEN ${taken} THEN p.removed_at ELSE t.status_at END AS status_at,
      t.notes AS notes,
      COALESCE(t.assessed, 'not_yet') AS assessed,
      COALESCE(p.removed_at, CASE WHEN t.status = 'gone' THEN t.status_at END) AS removed_at,
      COALESCE(p.removed_reason, CASE WHEN t.status = 'gone' THEN 'taken' END) AS removed_reason,
      CASE WHEN p.scope = 'in_filter' AND p.fit_score >= ${thr}
                AND COALESCE(p.red_flags, '[]') = '[]'
                AND (p.availability IS NULL OR p.availability NOT IN ('gone', 'unlisted'))
                AND ${status} NOT IN ('rejected', 'gone')
           THEN 1 ELSE 0 END AS flagged
    FROM properties p
    LEFT JOIN team_listings t ON t.property_id = p.id AND t.team_id = ${teamId})`;
}

/** One listing as the caller's team sees it, or undefined. */
export function getListing(db, user, id, config = null) {
  return db.prepare(`SELECT * FROM ${listingsSql(db, user, config)} AS properties WHERE id = ?`).get(id);
}

/**
 * Write the caller's team's pipeline fields (any of TEAM_FIELDS) for one listing. The
 * home team writes the `properties` columns; any other team upserts its `team_listings`
 * row. Returns nothing; the caller re-reads through `getListing`.
 */
export function writeListingState(db, user, propertyId, fields) {
  const keys = Object.keys(fields).filter((k) => TEAM_FIELDS.includes(k));
  if (!keys.length) return;
  const values = keys.map((k) => fields[k]);
  if (isHome(user)) {
    db.prepare(`UPDATE properties SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...values, propertyId);
    return;
  }
  db.prepare(
    `INSERT INTO team_listings (team_id, property_id, ${keys.join(', ')})
     VALUES (?, ?, ${keys.map(() => '?').join(', ')})
     ON CONFLICT(team_id, property_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`
  ).run(teamIdOf(user), propertyId, ...values);
}

/** Creates a team and returns its id. */
export function createTeam(db, name) {
  const info = db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(String(name).trim(), nowIso());
  return Number(info.lastInsertRowid);
}

/** The home team exists and carries the owners' names until someone renames it. */
export function ensureHomeTeam(db, name) {
  db.prepare('INSERT OR IGNORE INTO teams (id, name, created_at) VALUES (?, ?, ?)').run(HOME_TEAM_ID, name, nowIso());
}
