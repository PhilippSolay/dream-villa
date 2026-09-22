// SPEC §7 has one copy of the area table, and this test is what keeps it that way.
//
// It used to live in three places — src/areas.js, plus a hand-kept FALLBACK_AREAS in
// public/views/map.js and another in public/views/market.js, with the region ids and
// labels copied a fourth time into public/views/home.js. On 2026-09-22 all three
// frontend copies were found a week stale: still the pre-Canggu-belt 15 areas under the
// old west/bukit groups, while the source had 22 under center/west_coast/south. They
// were re-synced by hand, which fixes the symptom and not the cause.
//
// The table now lives once, in public/lib/areas.js, which both halves of the app import.
// These tests fail if that stops being true:
//   1. src/areas.js re-exports the shared objects rather than declaring its own.
//   2. no file under public/ grows a second §7 table.
//   3. the table and the SPEC §7 markdown table still say the same thing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as shared from '../public/lib/areas.js';
import * as server from '../src/areas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_MODULE = path.join(ROOT, 'public', 'lib', 'areas.js');

/** Every .js under `dir`, skipping node_modules and `_`-prefixed scratch files. */
function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name.startsWith('_') || name.startsWith('.') || name === 'node_modules') continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// 1. One table, shared by reference
// ---------------------------------------------------------------------------

test('src/areas.js re-exports the shared table rather than holding its own', () => {
  // Same object, not a deep-equal twin: a copy could not pass this.
  assert.ok(Object.is(server.AREAS, shared.AREAS), 'AREAS must be the shared object');
  assert.ok(Object.is(server.AREA_GROUPS, shared.AREA_GROUPS), 'AREA_GROUPS must be the shared object');
  assert.ok(Object.is(server.TARGET_AREAS, shared.TARGET_AREAS), 'TARGET_AREAS must be the shared object');
  assert.ok(Object.is(server.BEACHES, shared.BEACHES), 'BEACHES must be the shared object');

  const src = fs.readFileSync(path.join(ROOT, 'src', 'areas.js'), 'utf8');
  assert.ok(
    !/const\s+AREAS\s*=\s*\{/.test(src),
    'src/areas.js declares its own AREAS — it should import it from public/lib/areas.js'
  );
});

test('the shared module is browser-safe: no imports, no Node built-ins', () => {
  const src = fs.readFileSync(SHARED_MODULE, 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'public/lib/areas.js must not import anything');
  assert.ok(!/require\(|node:/.test(src), 'public/lib/areas.js must not reach for Node built-ins');
});

// ---------------------------------------------------------------------------
// 2. No second copy in the frontend
// ---------------------------------------------------------------------------

test('no file under public/ keeps its own copy of the SPEC §7 table', () => {
  const groupIds = shared.AREA_GROUPS.map((g) => g.id);
  const offenders = [];

  for (const file of jsFiles(path.join(ROOT, 'public'))) {
    if (file === SHARED_MODULE) continue;
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);

    // An area table is the only reason to write `centroid:` in a view.
    if (/centroid\s*:/.test(src)) {
      offenders.push(`${rel} declares centroids — import AREAS from lib/areas.js instead`);
    }
    // Naming one region id is fine; listing them is a copied AREA_GROUPS.
    const named = groupIds.filter((id) => new RegExp(`['"\`]${id}['"\`]`).test(src));
    if (named.length > 1) {
      offenders.push(`${rel} lists region ids ${named.join(', ')} — import AREA_GROUPS from lib/areas.js instead`);
    }
  }

  assert.deepEqual(offenders, [], `SPEC §7 copied back into the frontend:\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// 3. Internal shape
// ---------------------------------------------------------------------------

test('every area sits in a declared region, and the regions run in table order', () => {
  const groupIds = shared.AREA_GROUPS.map((g) => g.id);
  const seen = [];
  for (const [id, a] of Object.entries(shared.AREAS)) {
    assert.ok(groupIds.includes(a.group), `area ${id} has unknown group ${a.group}`);
    if (seen[seen.length - 1] !== a.group) seen.push(a.group);
  }
  // Each region's areas are contiguous and the regions come in AREA_GROUPS order.
  assert.deepEqual(seen, groupIds.filter((g) => seen.includes(g)));
  assert.deepEqual(new Set(seen).size, seen.length, 'a region\'s areas must be contiguous');
});

// ---------------------------------------------------------------------------
// 4. The SPEC §7 markdown table is the fourth reader, and it must agree
// ---------------------------------------------------------------------------

/** Parse the `| area | label | centroid | beach | group |` table out of SPEC §7. */
function specAreaTable() {
  const spec = fs.readFileSync(path.join(ROOT, 'SPEC.md'), 'utf8');
  const section = spec.slice(spec.indexOf('## 7. Areas, centroids, beaches'));
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) {
      if (rows.length) break; // table ended
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 5) continue;
    if (cells[0] === 'area' || /^-+$/.test(cells[0])) continue; // header / rule
    const [id, label, centroid, beach, group] = cells;
    const [lat, lng] = centroid.split(',').map((n) => Number(n.trim()));
    const m = beach.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    assert.ok(m, `SPEC §7 row "${id}" has an unparseable beach cell: ${beach}`);
    rows.push({
      id,
      label,
      centroid: [lat, lng],
      beach: { name: m[1].trim(), lat: Number(m[2]), lng: Number(m[3]) },
      group: group.split(/\s|\(/)[0], // "west_coast (inland ~10 km)" → west_coast
    });
  }
  return rows;
}

test('SPEC §7 and the shared table hold the same areas, in the same order', () => {
  const spec = specAreaTable();
  assert.ok(spec.length > 0, 'could not parse the SPEC §7 table');
  assert.deepEqual(
    spec.map((r) => r.id),
    Object.keys(shared.AREAS),
    'SPEC §7 and public/lib/areas.js list different areas (or list them in a different order)'
  );

  for (const row of spec) {
    const a = shared.AREAS[row.id];
    assert.equal(a.label, row.label, `${row.id}: label`);
    assert.equal(a.group, row.group, `${row.id}: group`);
    assert.deepEqual(a.centroid.map(Number), row.centroid, `${row.id}: centroid`);
    assert.equal(a.beach.name, row.beach.name, `${row.id}: beach name`);
    assert.equal(Number(a.beach.lat), row.beach.lat, `${row.id}: beach lat`);
    assert.equal(Number(a.beach.lng), row.beach.lng, `${row.id}: beach lng`);
  }
});
