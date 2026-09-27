// Shared helpers for the app API (SPEC §4). Everything here is used by more than one
// route module; route-specific logic stays in its own file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig, nowIso } from '../db.js';
import { parseRow } from '../scrape/store.js';
import { scoreRow } from '../scrape/score.js';
import { forSale } from '../scrape/sale.js';
import { resizeToJpeg } from '../scrape/images.js';
import { AREA_GROUPS, AREAS, TARGET_AREAS } from '../areas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Same resolution as server.js so uploads land where @fastify/static serves /images/. */
export function imagesDirFor(env = process.env) {
  return path.resolve(ROOT, env.IMAGES_DIR || 'data/images');
}

export function badRequest(reply, detail) {
  return reply.code(400).send({ error: 'bad_request', detail });
}

export function notFound(reply) {
  return reply.code(404).send({ error: 'not_found' });
}

/** Rows a route must not invent: 404 unless the property exists. */
export function getProperty(db, id) {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
}

export function heroUrl(row) {
  if (row.hero_file) return `/images/${row.hero_file}`;
  const images = Array.isArray(row.images) ? row.images : [];
  // images-audit.js marks a permanently-gone remote image `dead: true` (src_url kept
  // for reference, never shown) — never picked as a fallback hero.
  const first = images.find((i) => i && !i.dead && (i.file || i.src_url));
  if (!first) return null;
  return first.file ? `/images/${first.file}` : first.src_url || null;
}

/** Local file when the image was downloaded, the remote src_url otherwise — but never
 *  a `dead` entry (images-audit.js: a link images-audit.js gave up refetching). */
export function imageUrls(row) {
  const images = Array.isArray(row.images) ? row.images : [];
  return images
    .filter((i) => i && !i.dead)
    .map((i) => (i.file ? `/images/${i.file}` : i.src_url || null))
    .filter(Boolean);
}

export function jsonArray(value) {
  if (Array.isArray(value)) return [...value];
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeJson(value) {
  if (value === null || value === undefined || typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Re-run SPEC §2 over one row and persist scope/fit_score/flagged/red_flags.
 * Called after every write that can move the score (CLAUDE.md: the scraper only ever
 * touches listing facts, so the API has to rescore the rows people edit).
 */
export function rescoreOne(db, id, config = getConfig(db)) {
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!row) return null;
  const scored = scoreRow(parseRow(row), config);
  db.prepare('UPDATE properties SET scope = ?, fit_score = ?, flagged = ?, red_flags = ?, for_sale = ? WHERE id = ?')
    .run(scored.scope, scored.fit_score, scored.flagged, JSON.stringify(scored.red_flags), forSale(row), id);
  return scored;
}

/** Union the given flags into red_flags, then rescore. Returns the stored flags. */
export function addRedFlags(db, id, flags, config = getConfig(db)) {
  const wanted = (Array.isArray(flags) ? flags : [flags]).filter(Boolean);
  const row = db.prepare('SELECT red_flags FROM properties WHERE id = ?').get(id);
  if (!row) return null;
  const current = jsonArray(row.red_flags);
  const merged = [...new Set([...current, ...wanted])];
  if (merged.length !== current.length) {
    db.prepare('UPDATE properties SET red_flags = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }
  rescoreOne(db, id, config);
  return jsonArray(db.prepare('SELECT red_flags FROM properties WHERE id = ?').get(id).red_flags);
}

/** `IN (?, ?, ?)` placeholders for a bound-parameter list. */
export function placeholders(list) {
  return list.map(() => '?').join(', ');
}

/** SPEC §7 region ids, the values `?region=` takes (Market's tabs). */
export const REGION_IDS = AREA_GROUPS.map((g) => g.id);

/** The area ids of one region, or null for no region (every listing, `other` included). */
export function regionAreas(region) {
  return region ? TARGET_AREAS.filter((id) => AREAS[id].group === region) : null;
}

/**
 * `?region=` as a WHERE fragment: `area IN (…)` for one region, `1 = 1` for none, so a
 * query can always AND it in. `column` is for an aliased read (`p.area`).
 */
export function regionWhere(region, column = 'area') {
  const ids = regionAreas(region);
  return ids ? { sql: `${column} IN (${placeholders(ids)})`, params: ids } : { sql: '1 = 1', params: [] };
}

/** id → user name, for `by_name` on rows people wrote. */
export function userNames(db) {
  const out = new Map();
  for (const u of db.prepare('SELECT id, name FROM users').all()) out.set(u.id, u.name);
  return out;
}

export function withByName(db, rows) {
  const names = userNames(db);
  return rows.map((r) => ({ ...r, by_name: names.get(r.by) || null }));
}

/**
 * Read a multipart request into `{ fields, files }`. Files are buffered in memory;
 * @fastify/multipart's own limits (10 files, 15 MB each) cap that.
 */
export async function readMultipart(request) {
  const fields = {};
  const files = [];
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (buffer.length) files.push({ field: part.fieldname, filename: part.filename, buffer });
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, files };
}

/** Resize to the gallery's 1600 px JPEG and write it under <imagesDir>/<id>/<name>. */
export async function saveImage(imagesDir, propertyId, name, buffer) {
  const { buffer: out, w, h } = await resizeToJpeg(buffer);
  const dir = path.join(imagesDir, String(propertyId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), out);
  return { file: `${propertyId}/${name}`, w, h };
}

/** '' / undefined → null; otherwise the trimmed string. */
export function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Strict-ish integer coercion for multipart fields (which always arrive as strings). */
export function int(v) {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * Fastify's ajv is configured with `removeAdditional: true`, so a schema saying
 * `additionalProperties: false` silently DROPS unknown keys instead of rejecting them —
 * and SPEC §4 wants a 400 for a field nobody is allowed to set. `propertyNames` is not
 * touched by removeAdditional, so that is the keyword that actually produces the error.
 */
function tighten(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(tighten);
  const out = { ...node };
  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, tighten(v)]));
  }
  if (out.items) out.items = tighten(out.items);
  if (out.additionalProperties === false) {
    delete out.additionalProperties;
    out.propertyNames = { enum: Object.keys(out.properties || {}) };
  }
  return out;
}

/**
 * Apply `tighten` to every body/params schema in this plugin.
 *
 * Querystrings are deliberately left alone: there `additionalProperties: false` plus
 * removeAdditional means an unknown parameter is ignored, so a cache-buster or a UTM
 * tag on a shared link cannot break the page. A body is a deliberate write and gets
 * the strict treatment.
 */
export function strictSchemas(app) {
  app.addHook('onRoute', (route) => {
    if (!route.schema) return;
    const schema = { ...route.schema };
    for (const part of ['body', 'params']) {
      if (schema[part]) schema[part] = tighten(schema[part]);
    }
    route.schema = schema;
  });
}

export { nowIso };
