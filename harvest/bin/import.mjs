// Import one harvested Facebook file (villa-fb-posts-*.json, written by browser/harvester.js)
// into the tracker: POST /api/import/posts in chunks of at most 200 posts / 24 MB.
//
//   ADMIN_TOKEN=... node harvest/bin/import.mjs <file.json>
//
// Target: $VILLA_BASE (default https://villa.solay.cloud). Exit 1 when a chunk still fails after
// its retries, so bin/watch.sh files it as FAILED- instead of archiving it as imported
// (2026-09-27: a file lost chunks to a deploy that way). Safe to re-run: the route updates a
// post it already holds, never duplicates it.
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from './retry.mjs';
import { BASE, authHeaders, parseDate, sourceIdFor } from './lib.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node harvest/bin/import.mjs <villa-fb-posts-*.json>   (ADMIN_TOKEN in the environment)');
  process.exit(2);
}
const h = authHeaders();
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = path.basename(file);

// Relative `time` strings ("6d", "Yesterday at ...") are resolved against the file's
// own export time -- never `new Date()` -- so a backfilled batch gets real dates
// instead of everything landing on today.
const exportedAt = data.exported_at ? new Date(data.exported_at) : new Date();

const srcRes = await fetchJson(BASE + '/api/sources', { headers: h }, 'GET /api/sources');
if (!srcRes.ok) {
  console.log(JSON.stringify({ file: name, error: 'sources', status: srcRes.status, body: JSON.stringify(srcRes.body).slice(0, 300) }, null, 1));
  process.exit(1);
}
const groupId = sourceIdFor(srcRes.body.sources, data.group_id);
const posts = (data.posts || []).filter((p) => p.post_id && p.url && p.text).map((p) => {
  // posted_at wins when present; otherwise derive it from the raw `time` string
  // relative to exportedAt; a post with neither (or an unparseable `time`) is sent
  // with today's date -- the server has no better one.
  const posted_at = p.posted_at || (p.time ? parseDate(p.time, exportedAt) : null) || new Date().toISOString();
  return {
    post_id: String(p.post_id), url: p.url, posted_at, text: p.text.slice(0, 8000),
    poster_name: p.poster_name || undefined, poster_url: p.poster_url || undefined, whatsapp: p.whatsapp || undefined, group_name: data.group_name,
    image: p.image && p.image.data_base64 ? { data_base64: p.image.data_base64, w: p.image.w, h: p.image.h } : undefined,
    // The harvester captures the post's gallery; the importer sends up to 8 photos as images_b64.
    images_b64: Array.isArray(p.images_b64) && p.images_b64.length
      ? p.images_b64.filter((i) => i && i.data_base64).slice(0, 8).map((i) => ({ data_base64: i.data_base64, w: i.w, h: i.h }))
      : undefined,
  };
});

const totals = { seen: 0, imported: 0, new: 0, updated: 0, skipped: { no_signal: 0, offtopic: 0, wanted: 0 }, skipped_images: 0, merged: 0, retries: 0, errors: [] };
// Chunk by bytes, not count: a post with 8 photos is ~1 MB and the route's body limit is 60 MB.
const CHUNK_BYTES = 24 * 1024 * 1024;
const MAX_POSTS = 200;
const chunks = [];
let current = [];
let size = 0;
for (const post of posts) {
  const bytes = JSON.stringify(post).length;
  if (current.length && (size + bytes > CHUNK_BYTES || current.length >= MAX_POSTS)) { chunks.push(current); current = []; size = 0; }
  current.push(post);
  size += bytes;
}
if (current.length) chunks.push(current);

for (const [i, chunk] of chunks.entries()) {
  const r = await fetchJson(BASE + '/api/import/posts', { method: 'POST', headers: h, body: JSON.stringify({ source: 'fb', group_id: groupId, posts: chunk }) }, `chunk ${i + 1}/${chunks.length}`);
  totals.retries += r.attempts - 1;
  const j = r.body || {};
  if (!r.ok) { totals.errors.push({ chunk: i + 1, status: r.status, body: JSON.stringify(j).slice(0, 300) }); continue; }
  totals.seen += j.seen || 0; totals.imported += j.imported || 0; totals.new += j.new || 0; totals.updated += j.updated || 0; totals.merged += j.merged || 0; totals.skipped_images += j.skipped_images || 0;
  for (const k of Object.keys(totals.skipped)) totals.skipped[k] += (j.skipped && j.skipped[k]) || 0;
}
console.log(JSON.stringify({ file: name, group: groupId, posts: posts.length, ...totals }, null, 1));
if (totals.errors.length) process.exit(1);
