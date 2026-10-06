// One-off repair, kept for the record and for any archive that predates the date-parser fix:
// backfill posted_at for archived Facebook posts saved with posted_at: null, then re-send ONLY
// those posts through POST /api/import/posts (text/url/group only, no images), so the importer's
// "an earlier posted_at corrects first_seen" rule can pull first_seen back to the post's real
// Facebook date. The scraper only touches listing facts, and a re-import never moves first_seen
// LATER, so running it twice is harmless.
//
//   ADMIN_TOKEN=... node harvest/bin/fix-dates.mjs
//
// Reads every villa-fb-posts-*.json in $HARVEST_DIR; target $VILLA_BASE.
import fs from 'node:fs';
import path from 'node:path';
import { HARVEST_DIR, BASE, authHeaders, filesIn, parseDate, sourceIdFor } from './lib.mjs';

const CHUNK_SIZE = 100;
const h = authHeaders();

// /api/sources lookup, cached across every file so it is fetched once.
let sourcesPromise = null;
async function groupIdFor(fbId) {
  if (!sourcesPromise) {
    sourcesPromise = fetch(BASE + '/api/sources', { headers: h })
      .then((r) => r.json())
      .then((j) => j.sources || []);
  }
  return sourceIdFor(await sourcesPromise, fbId);
}

async function sendChunk(groupId, chunk) {
  const r = await fetch(BASE + '/api/import/posts', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ source: 'fb', group_id: groupId, posts: chunk }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, body: JSON.stringify(j).slice(0, 300) };
  return { ok: true, ...j };
}

async function processFile(file) {
  const full = path.join(HARVEST_DIR, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    return { file, error: `unreadable: ${e.message}` };
  }

  const exportedAt = data.exported_at ? new Date(data.exported_at) : new Date(fs.statSync(full).mtime);
  const allPosts = Array.isArray(data.posts) ? data.posts : [];
  const nullPosts = allPosts.filter((p) => !p.posted_at && p.post_id && p.url && p.text);
  const nNull = nullPosts.length;

  if (!nNull) return { file, null: 0, fixed: 0, sent: 0, new: 0, updated: 0, errors: 0 };

  const groupId = await groupIdFor(data.group_id);

  const fixed = nullPosts.map((p) => ({
    post_id: String(p.post_id),
    url: p.url,
    // posted_at is missing here (that's the filter above), so derive it from `time` relative
    // to exportedAt, same as import.mjs; fall back to the export time itself -- never "now".
    posted_at: (p.time ? parseDate(p.time, exportedAt) : null) || exportedAt.toISOString(),
    text: String(p.text).slice(0, 8000),
    poster_name: p.poster_name || undefined,
    poster_url: p.poster_url || undefined,
    whatsapp: p.whatsapp || undefined,
    group_name: data.group_name,
    images_b64: [], // no images needed for this backfill
  }));

  let sent = 0;
  let newCount = 0;
  let updated = 0;
  let errors = 0;
  const errorDetails = [];

  for (let i = 0; i < fixed.length; i += CHUNK_SIZE) {
    const chunk = fixed.slice(i, i + CHUNK_SIZE);
    const res = await sendChunk(groupId, chunk);
    if (!res.ok) {
      errors += chunk.length;
      errorDetails.push({ status: res.status, body: res.body });
      continue;
    }
    sent += chunk.length;
    newCount += res.new || 0;
    updated += res.updated || 0;
  }

  return { file, group: groupId, null: nNull, fixed: fixed.length, sent, new: newCount, updated, errors, errorDetails };
}

const files = filesIn(HARVEST_DIR, 'villa-fb-posts-');
const totals = { files: 0, null: 0, fixed: 0, sent: 0, new: 0, updated: 0, errors: 0 };

for (const file of files) {
  const result = await processFile(file);
  if (result.error) {
    console.log(`${result.file}: ERROR ${result.error}`);
    continue;
  }
  totals.files += 1;
  for (const k of ['null', 'fixed', 'sent', 'new', 'updated', 'errors']) totals[k] += result[k];
  if (result.null > 0) {
    console.log(
      `${result.file} (${result.group}): null=${result.null} fixed=${result.fixed} sent=${result.sent} new=${result.new} updated=${result.updated} errors=${result.errors}`
    );
    if (result.errorDetails?.length) console.log('  errors:', JSON.stringify(result.errorDetails).slice(0, 500));
  }
}

console.log('---');
console.log(JSON.stringify({ files_scanned: files.length, ...totals }, null, 1));
