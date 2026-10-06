// Shared bits for the harvest scripts: where things live, which tracker to talk to, the
// token, and the Facebook date parser. Every path is relative to this kit or to an env var,
// never to one person's home layout.
//
//   HARVEST_DIR        working directory: archived harvest files, known/, logs, nightly-state.json
//                      (default: the harvest/ directory this file sits in; all of it is gitignored)
//   HARVEST_DOWNLOADS  where the browser saves harvest files (default: ~/Downloads)
//   VILLA_BASE         the tracker to import into (default: https://villa.solay.cloud;
//                      http://localhost:8080 for a local dev server)
//   ADMIN_TOKEN        an owner's bearer token for VILLA_BASE (the import routes are owner-only)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HARVEST_DIR = path.resolve(process.env.HARVEST_DIR || KIT_DIR);
export const DOWNLOADS = path.resolve(process.env.HARVEST_DOWNLOADS || path.join(os.homedir(), 'Downloads'));
export const BASE = (process.env.VILLA_BASE || 'https://villa.solay.cloud').replace(/\/+$/, '');

/** The owner token from the environment; exits with a clear message when it is missing. */
export function adminToken() {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('ADMIN_TOKEN is not set. Export an owner token for ' + BASE + ' first (never pass it as an argument).');
    process.exit(2);
  }
  return token;
}

export function authHeaders(token = adminToken()) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

/** Harvest files in `dir` whose name starts with `prefix` and ends in .json (a missing dir is empty). */
export function filesIn(dir, prefix) {
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** A harvest file's parsed JSON, or null when it cannot be read. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Port of browser/harvester.js's V.parseDate, evaluated against `now` (a Date) instead of
 * wall-clock time: an archived file's relative `time` strings ("6d", "Yesterday at 8:15 PM")
 * must resolve against the moment the file was EXPORTED, not import time, or every
 * backfilled post would land on today.
 * @returns {string|null} ISO timestamp
 */
export function parseDate(t, now) {
  let m;
  t = String(t || '').trim();
  if ((m = t.match(/^(\d+)\s*([mhdw])$/))) {
    const n = +m[1];
    const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]];
    return new Date(now.getTime() - n * ms).toISOString();
  }
  if (/^Yesterday/i.test(t)) {
    const d = new Date(now.getTime() - 86400e3);
    const tm = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (tm) {
      let hh = +tm[1];
      if (tm[3]) {
        if (/PM/i.test(tm[3]) && hh < 12) hh += 12;
        if (/AM/i.test(tm[3]) && hh === 12) hh = 0;
      }
      d.setHours(hh, +tm[2], 0, 0);
    }
    return d.toISOString();
  }
  // "September 12 at 11:04 PM", "September 12, 2025 at 9:00 AM", "Sep 12", "12 September at 10:20", "12 September 2025"
  m = t.match(/^(?:([A-Z][a-z]+)\.? (\d{1,2})|(\d{1,2}) ([A-Z][a-z]+)\.?)(?:,? (\d{4}))?(?: at (\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (m) {
    const mon = m[1] || m[4];
    const day = +(m[2] || m[3]);
    const year = m[5] ? +m[5] : now.getFullYear();
    const d = new Date(`${mon} ${day}, ${year}`);
    if (isNaN(d)) return null;
    if (m[6]) {
      let hh = +m[6];
      if (m[8]) {
        if (/PM/i.test(m[8]) && hh < 12) hh += 12;
        if (/AM/i.test(m[8]) && hh === 12) hh = 0;
      }
      d.setHours(hh, +m[7], 0, 0);
    }
    if (!m[5] && d > now) d.setFullYear(d.getFullYear() - 1);
    return d.toISOString();
  }
  return null;
}

/**
 * The tracker's source id for a Facebook group: the registered source whose url points at
 * the group, else `fb-<groupId>` (the import route accepts an unregistered group).
 */
export function sourceIdFor(sources, fbGroupId) {
  const src = (sources || []).find(
    (s) => (s.url || '').includes('/groups/' + fbGroupId + '/') || (s.url || '').endsWith('/groups/' + fbGroupId)
  );
  return src ? src.id : 'fb-' + fbGroupId;
}
