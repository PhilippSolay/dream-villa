// Intake sources — every channel a listing can arrive through, not just the scrapers.
//
// SPEC is silent on this (it only names `source` on a property row and the `inbox`
// table), so the shape lives in `config.sources` as a JSON array: one entry per
// channel, seeded on first read from the adapter registry plus the sites we looked at
// and skipped (adapters/*.md). Nothing is ever deleted — CLAUDE.md — a channel is
// disabled (`enabled: false`) or hidden from the list (`archived: true`).
//
// Manual channels (a Facebook group, a WhatsApp group, an agent) have no adapter; what
// they produce is inbox rows. The convention that ties an inbox row to its channel is a
// prefix on `inbox.note`: `[src:<id>] whatever the person typed`. `POST /api/inbox`
// writes it from `source_id`; `sourceStats` reads it back.

import { setConfig, nowIso } from './db.js';
import { adapters as registry, ADAPTER_IDS } from './scrape/adapters/index.js';

/** The channel kinds the UI groups by. `scraper` is the only kind that can run. */
export const SOURCE_KINDS = [
  'scraper', 'facebook_group', 'whatsapp_group', 'instagram', 'agent', 'website', 'other',
];

export const KIND_LABELS = {
  scraper: 'Scrapers',
  facebook_group: 'Facebook groups',
  whatsapp_group: 'WhatsApp groups',
  instagram: 'Instagram',
  agent: 'Agents',
  website: 'Websites',
  other: 'Other',
};

/** Kinds a person feeds by hand (they get the "Add URL from this source" button). */
export const MANUAL_KINDS = SOURCE_KINDS.filter((k) => k !== 'scraper');

/**
 * Sites inspected 2026-09-18 and deliberately not implemented — one line each, taken
 * from the verdict of the matching `adapters/<id>.md`. They are seeded disabled so the
 * Agent page can say why rather than leaving a silent hole in the source list.
 */
export const SKIPPED_SCRAPERS = [
  {
    id: 'exotiq',
    name: 'Exotiq Property',
    url: 'https://www.exotiqproperty.com',
    notes: 'Not implemented: sales-only agency — no long-term rentals to scrape (adapters/exotiq.md).',
  },
  {
    id: 'balivillahub',
    name: 'Bali Villa Hub',
    url: 'https://balivillahub.com',
    notes: 'Not implemented: every request, robots.txt included, returns HTTP 429 and a Vercel Security Checkpoint (adapters/balivillahub.md).',
  },
  {
    id: 'olx',
    name: 'OLX Indonesia',
    url: 'https://www.olx.co.id',
    notes: 'Not implemented: blocked by Akamai Bot Manager — a browser UA is killed mid-connection, no UA gets an interstitial (adapters/olx.md).',
  },
  {
    id: 'lamudi',
    name: 'Lamudi Indonesia',
    url: 'https://www.lamudi.co.id',
    notes: 'Not implemented: an edge WAF answers every request, robots.txt included, with 401 Access Denied (adapters/lamudi.md).',
  },
  {
    id: '99co',
    name: '99.co Indonesia',
    url: 'https://www.99.co',
    notes: 'Not implemented: Cloudflare "Just a moment..." challenge (HTTP 403), which SPEC §6 rules out solving (adapters/99co.md).',
  },
  {
    id: 'fbmarketplace',
    name: 'Facebook Marketplace',
    url: 'https://www.facebook.com/marketplace',
    notes: 'Skipped as SPEC §6 allows: login-only and JS-rendered — an anonymous request gets a 400 error shell, never a listing (adapters/fbmarketplace.md).',
  },
];

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

/**
 * A non-scraper's id is its name, slugified. Scrapers keep the adapter id, which is
 * what `properties.source` stores, so it can never be re-derived from a renamed entry.
 */
export function slugify(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// the stored array
// ---------------------------------------------------------------------------

function normalise(entry) {
  return {
    id: String(entry.id),
    kind: SOURCE_KINDS.includes(entry.kind) ? entry.kind : 'other',
    name: entry.name ?? String(entry.id),
    url: entry.url ?? null,
    enabled: entry.enabled !== false,
    notes: entry.notes ?? null,
    contact_id: entry.contact_id ?? null,
    archived: entry.archived === true,
    created_by: entry.created_by ?? 'system',
    created_at: entry.created_at ?? null,
    updated_at: entry.updated_at ?? null,
  };
}

/** The registry, in run order, then the skipped sites — all of them `kind: 'scraper'`. */
export function seedList(now = nowIso()) {
  const fromRegistry = ADAPTER_IDS.map((id) =>
    normalise({
      id,
      kind: 'scraper',
      name: registry[id].name || id,
      url: registry[id].base || null,
      enabled: true,
      notes: null,
      created_by: 'system',
      created_at: now,
      updated_at: now,
    })
  );
  const skipped = SKIPPED_SCRAPERS.map((s) =>
    normalise({ ...s, kind: 'scraper', enabled: false, created_by: 'system', created_at: now, updated_at: now })
  );
  return [...fromRegistry, ...skipped];
}

function readRaw(db) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('sources');
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every source, seeding `config.sources` on the first read. Archived entries included. */
export function listSources(db) {
  const stored = readRaw(db);
  if (stored) return withNewAdapters(db, stored.map(normalise));
  const seeded = seedList();
  setConfig(db, 'sources', seeded);
  return seeded;
}

/**
 * An adapter added to the registry after `config.sources` was seeded joins the stored
 * list on the next read — enabled, right after the last registry scraper — so the Agent
 * page shows it and can turn it off. Entries already stored are never touched.
 */
function withNewAdapters(db, list, now = nowIso()) {
  const have = new Set(list.map((s) => s.id));
  const missing = ADAPTER_IDS.filter((id) => !have.has(id));
  if (!missing.length) return list;
  const added = missing.map((id) =>
    normalise({
      id,
      kind: 'scraper',
      name: registry[id].name || id,
      url: registry[id].base || null,
      enabled: true,
      created_by: 'system',
      created_at: now,
      updated_at: now,
    })
  );
  let at = -1;
  list.forEach((s, i) => {
    if (ADAPTER_IDS.includes(s.id)) at = i;
  });
  const merged = [...list.slice(0, at + 1), ...added, ...list.slice(at + 1)];
  save(db, merged);
  return merged;
}

export function getSource(db, id) {
  return listSources(db).find((s) => s.id === String(id)) || null;
}

function save(db, list) {
  setConfig(db, 'sources', list);
  return list;
}

/**
 * Create or update one source. Throws on a bad kind, an unknown scraper id, or a
 * kind change on a scraper entry.
 *
 * @param {object} input `{id?, kind, name, url?, notes?, enabled?, contact_id?, archived?}`
 * @param {{name?:string}|string|null} [user] who is writing (stored as `created_by` on create)
 */
export function upsertSource(db, input = {}, user = null, now = nowIso()) {
  const who = (user && typeof user === 'object' ? user.name : user) || 'system';
  const list = listSources(db);

  const givenId = input.id == null || input.id === '' ? null : slugify(input.id) || String(input.id);
  const existing = givenId ? list.find((s) => s.id === givenId) : null;

  if (!existing) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('name is required');
    const kind = input.kind;
    if (!SOURCE_KINDS.includes(kind)) throw new Error(`kind must be one of: ${SOURCE_KINDS.join(', ')}`);

    const id = givenId || slugify(name);
    if (!id) throw new Error('name must contain at least one letter or digit');
    if (list.some((s) => s.id === id)) throw new Error(`a source with id "${id}" already exists`);
    // A scraper without an adapter would never run, so it cannot be invented here.
    if (kind === 'scraper' && !ADAPTER_IDS.includes(id)) {
      throw new Error('a scraper source must match an adapter in the registry — use another kind');
    }

    const created = normalise({
      id,
      kind,
      name,
      url: input.url ?? null,
      enabled: input.enabled !== false,
      notes: input.notes ?? null,
      contact_id: input.contact_id ?? null,
      archived: input.archived === true,
      created_by: who,
      created_at: now,
      updated_at: now,
    });
    save(db, [...list, created]);
    return created;
  }

  if (input.kind !== undefined && input.kind !== existing.kind) {
    if (!SOURCE_KINDS.includes(input.kind)) throw new Error(`kind must be one of: ${SOURCE_KINDS.join(', ')}`);
    if (existing.kind === 'scraper' || input.kind === 'scraper') {
      throw new Error('a scraper source keeps its kind — its id is the adapter id');
    }
  }

  const updated = normalise({
    ...existing,
    kind: input.kind ?? existing.kind,
    name: input.name === undefined ? existing.name : String(input.name).trim() || existing.name,
    url: input.url === undefined ? existing.url : input.url,
    notes: input.notes === undefined ? existing.notes : input.notes,
    contact_id: input.contact_id === undefined ? existing.contact_id : input.contact_id,
    enabled: input.enabled === undefined ? existing.enabled : input.enabled !== false,
    archived: input.archived === undefined ? existing.archived : input.archived === true,
    updated_at: now,
  });
  save(db, list.map((s) => (s.id === updated.id ? updated : s)));
  return updated;
}

/** Disable/enable one source; returns the stored entry, or null when the id is unknown. */
export function setSourceEnabled(db, id, enabled, user = null, now = nowIso()) {
  const list = listSources(db);
  const existing = list.find((s) => s.id === String(id));
  if (!existing) return null;
  void user;
  const updated = { ...existing, enabled: enabled !== false, updated_at: now };
  save(db, list.map((s) => (s.id === updated.id ? updated : s)));
  return updated;
}

/** Ids the daily run must not touch (`enabled: false`). Unknown ids are never disabled. */
export function disabledSourceIds(db) {
  return new Set(listSources(db).filter((s) => s.enabled === false).map((s) => s.id));
}

// ---------------------------------------------------------------------------
// inbox ↔ source
// ---------------------------------------------------------------------------

const NOTE_PREFIX = /^\[src:([A-Za-z0-9][A-Za-z0-9._-]*)\]\s*/;

/** `'[src:fb-bali-rentals] from Ketut'` → `'fb-bali-rentals'` (null when absent). */
export function sourceIdFromNote(note) {
  const m = NOTE_PREFIX.exec(String(note ?? ''));
  return m ? m[1] : null;
}

/** The note without its `[src:…]` prefix. */
export function noteWithoutSource(note) {
  return String(note ?? '').replace(NOTE_PREFIX, '') || null;
}

/** Build the stored note for `POST /api/inbox {url, note, source_id}`. */
export function noteWithSource(note, sourceId) {
  const text = note == null ? '' : String(note).trim();
  if (!sourceId) return text || null;
  return text ? `[src:${sourceId}] ${text}` : `[src:${sourceId}]`;
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function blank() {
  return { listings: 0, in_filter: 0, flagged: 0, last_seen: null, inbox_pending: 0, inbox_done: 0 };
}

/**
 * Per source id: what it has actually produced.
 *
 * Scrapers are counted through `properties.source` (the adapter id). Manual channels
 * are counted through the inbox: a row belongs to a source when its note carries the
 * `[src:<id>]` prefix, or when `inbox.by` is itself a known source id (the phase-5
 * WhatsApp reader writes the sender there).
 *
 * @returns {Record<string, {listings:number,in_filter:number,flagged:number,last_seen:string|null,inbox_pending:number,inbox_done:number}>}
 */
export function sourceStats(db, knownIds = null) {
  const known = new Set(knownIds || listSources(db).map((s) => s.id));
  const out = {};
  const ensure = (id) => {
    if (!out[id]) out[id] = blank();
    return out[id];
  };
  for (const id of known) ensure(id);

  const rows = db
    .prepare(
      `SELECT source,
              COUNT(*) AS listings,
              SUM(CASE WHEN scope = 'in_filter' THEN 1 ELSE 0 END) AS in_filter,
              SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged,
              MAX(last_seen) AS last_seen
         FROM properties
        GROUP BY source`
    )
    .all();
  for (const r of rows) {
    if (!r.source) continue;
    const s = ensure(r.source);
    s.listings = r.listings || 0;
    s.in_filter = r.in_filter || 0;
    s.flagged = r.flagged || 0;
    s.last_seen = r.last_seen || null;
  }

  for (const r of db.prepare('SELECT "by" AS added_by, note, status FROM inbox').all()) {
    const fromNote = sourceIdFromNote(r.note);
    const id = fromNote || (known.has(r.added_by) ? r.added_by : null);
    if (!id) continue;
    const s = ensure(id);
    if (r.status === 'done') s.inbox_done += 1;
    else if (r.status === 'pending') s.inbox_pending += 1;
  }

  return out;
}

/** The list the API returns: every source with its stats folded in. */
export function sourcesWithStats(db, { includeArchived = false } = {}) {
  const list = listSources(db);
  const stats = sourceStats(db, list.map((s) => s.id));
  return list
    .filter((s) => includeArchived || !s.archived)
    .map((s) => ({ ...s, stats: stats[s.id] || blank() }));
}

export default {
  SOURCE_KINDS, KIND_LABELS, MANUAL_KINDS, SKIPPED_SCRAPERS,
  slugify, seedList, listSources, getSource, upsertSource, setSourceEnabled,
  disabledSourceIds, sourceIdFromNote, noteWithoutSource, noteWithSource,
  sourceStats, sourcesWithStats,
};
