// Import one listings file ({source, listings: [...]}: villa-bvh-listings-*.json from
// browser/bvh-harvester.js, or a hand-built villa-listings-*.json, see channels.md §6) into the
// tracker: POST /api/import/listings in chunks of 50.
//
//   ADMIN_TOKEN=... node harvest/bin/import-listings.mjs <file.json>
//
// Target: $VILLA_BASE (default https://villa.solay.cloud). Exit 1 when a chunk still fails after its
// retries, so bin/watch.sh files it as FAILED- rather than archiving it. Rows without ref, url or
// title are dropped here (the route requires all three).
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from './retry.mjs';
import { BASE, authHeaders } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node harvest/bin/import-listings.mjs <listings.json>   (ADMIN_TOKEN in the environment)');
  process.exit(2);
}
const h = authHeaders();
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!data.source) {
  console.error(`${file}: no "source" field — the file must be {source, listings}`);
  process.exit(2);
}
const listings = (data.listings || []).filter((l) => l.ref && l.url && l.title);
const totals = { file: path.basename(file), source: data.source, listings: listings.length, seen: 0, new: 0, updated: 0, images_downloaded: 0, images_failed: 0, retries: 0, errors: [] };
for (let i = 0; i < listings.length; i += 50) {
  const chunk = listings.slice(i, i + 50);
  const r = await fetchJson(BASE + '/api/import/listings', { method: 'POST', headers: h, body: JSON.stringify({ source: data.source, listings: chunk }) }, `listings ${i + 1}-${i + chunk.length}`);
  totals.retries += r.attempts - 1;
  const j = r.body || {};
  if (!r.ok) { totals.errors.push({ from: i + 1, status: r.status, body: JSON.stringify(j).slice(0, 300) }); continue; }
  for (const k of ['seen', 'new', 'updated', 'images_downloaded', 'images_failed']) totals[k] += j[k] || 0;
}
console.log(JSON.stringify(totals, null, 1));
if (totals.errors.length) process.exit(1);
