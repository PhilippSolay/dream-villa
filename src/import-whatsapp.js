// `npm run import:whatsapp -- <export.zip|folder> [options]`
//
// Turns a WhatsApp "Export chat" (with media) into rent posts and sends them to
// POST /api/import/posts as source `wa` — the same door the Facebook harvester
// uses, so classification, area/price parsing, contacts, dedupe and the gallery
// all happen server-side, once, in src/routes/import.js.
//
// Options
//   --group=<id>        tracker source id for the group (default: slug of the group
//                       name; created as a whatsapp_group source when missing)
//   --name="…"          group name (default: from the file name)
//   --days=30           only posts from the last N days (Philipp, 2026-09-20)
//   --since=YYYY-MM-DD  explicit cutoff instead of --days
//   --gap=3             minutes between two messages of one sender that still
//                       form one post (text, then the photos one by one)
//   --tz=+08:00         the phone's UTC offset (export times are phone-local)
//   --base=URL          tracker base ($VILLA_BASE, else https://villa.solay.cloud)
//   --token=…           admin token ($ADMIN_TOKEN from .env)
//   --dry               parse, classify and print; send nothing
//   --no-images         send text only
//   --out=file.json     also write the posts (without images) to a file

import fs from 'node:fs';
import path from 'node:path';

import { loadEnvFile } from './index.js';
import { classifySkip, detectArea } from './routes/import.js';
import { parseRent } from './scrape/normalise.js';
import { openExport, parseChat, bundlePosts, postsFromBundles, attachImages, toApiPost, slug } from './whatsapp.js';

const DEFAULT_DAYS = 30;
const DEFAULT_BASE = 'https://villa.solay.cloud';
// Route limit is 60 MB / 200 posts; stay well under both.
const CHUNK_BYTES = 40 * 1024 * 1024;
const CHUNK_POSTS = 100;

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(a);
    if (!m) args._.push(a);
    else args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function usage(code = 2) {
  (code ? console.error : console.log)('usage: npm run import:whatsapp -- <export.zip|folder> [--group=id] [--name=…] [--days=30|--since=YYYY-MM-DD] [--dry] [--no-images] [--base=URL] [--token=…]');
  process.exit(code);
}

function fmtIdr(n) {
  return n == null ? '' : `${Math.round(n / 1_000_000)}M`;
}

function oneLine(s, max = 70) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function api(base, token, method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${oneLine(text, 300)}`);
  return json;
}

async function ensureSource(base, token, groupId, groupName) {
  const list = (await api(base, token, 'GET', '/api/sources'))?.sources || [];
  const existing = list.find((s) => s.id === groupId);
  if (existing) return { id: existing.id, created: false };
  await api(base, token, 'POST', '/api/sources', { id: groupId, kind: 'whatsapp_group', name: groupName || groupId });
  return { id: groupId, created: true };
}

/** Split posts into batches that stay under the route's size and count limits. */
function chunk(posts) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const post of posts) {
    const size = JSON.stringify(post).length;
    if (current.length && (current.length >= CHUNK_POSTS || bytes + size > CHUNK_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(post);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (args.help) usage(0);
  if (!input) usage();

  const days = Number(args.days || DEFAULT_DAYS);
  const since = args.since
    ? new Date(`${args.since}T00:00:00${args.tz || '+08:00'}`).toISOString()
    : new Date(Date.now() - days * 86_400_000).toISOString();
  const gapMinutes = args.gap ? Number(args.gap) : undefined;
  const dry = Boolean(args.dry);
  const withImages = !args['no-images'];

  const opened = openExport(input);
  let sent;
  try {
    const content = fs.readFileSync(opened.chatFile, 'utf8');
    const messages = parseChat(content, { tzOffset: args.tz || undefined });
    const bundles = bundlePosts(messages, { gapMinutes });
    const groupName = args.name || opened.name || path.basename(input);
    const groupId = args.group ? slug(args.group) : slug(groupName);
    const { posts, stats } = postsFromBundles(bundles, { groupId, groupName, since });

    const kept = [];
    const skipped = { no_signal: 0, offtopic: 0, wanted: 0 };
    console.log(`${groupName} (${groupId}) — ${messages.length} messages, ${bundles.length} bursts, cutoff ${since.slice(0, 10)}`);
    console.log(`  before cutoff ${stats.before_cutoff} · photo-only ${stats.no_text} · candidates ${posts.length}`);
    console.log('');
    for (const post of posts) {
      // Local preview only; the server classifies again with its own config (usd_idr).
      const verdict = classifySkip(post.text, {});
      const rent = parseRent(post.text, {});
      const priceText = !rent
        ? ''
        : rent.price_month_idr != null
          ? `${fmtIdr(rent.price_month_idr)}/month`
          : `${fmtIdr(rent.price_year_idr)}/year`;
      const line = [
        post.posted_at.slice(0, 10),
        (verdict || 'RENT').padEnd(9),
        detectArea(post.text).padEnd(13),
        priceText.padEnd(9),
        `${post.image_files.length}img`.padEnd(6),
        oneLine(post.poster_name, 22).padEnd(22),
        oneLine(post.text),
      ].join('  ');
      console.log(`  ${line}`);
      if (verdict) skipped[verdict] += 1;
      else kept.push(post);
    }
    console.log('');
    console.log(`rent offers ${kept.length} · skipped: no signal ${skipped.no_signal}, offtopic ${skipped.offtopic}, wanted ${skipped.wanted}`);

    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify({ source: 'wa', group_id: groupId, group_name: groupName, posts: kept.map(toApiPost) }, null, 2));
      console.log(`wrote ${args.out}`);
    }
    if (dry) return;
    if (!kept.length) {
      console.log('nothing to send');
      return;
    }

    const base = (args.base || process.env.VILLA_BASE || DEFAULT_BASE).replace(/\/$/, '');
    const token = args.token || process.env.ADMIN_TOKEN;
    if (!token) throw new Error('no admin token: pass --token=… or set ADMIN_TOKEN in .env');

    if (withImages) {
      const { attached, missing } = await attachImages(kept, opened.dir);
      console.log(`images: ${attached} attached, ${missing} missing from the export`);
    }

    const source = await ensureSource(base, token, groupId, groupName);
    if (source.created) console.log(`registered WhatsApp group source "${groupId}"`);

    sent = { seen: 0, new: 0, updated: 0, skipped_images: 0, merged: 0, skipped: { no_signal: 0, offtopic: 0, wanted: 0 } };
    for (const batch of chunk(kept.map(toApiPost))) {
      const r = await api(base, token, 'POST', '/api/import/posts', { source: 'wa', group_id: groupId, posts: batch });
      sent.seen += r.seen;
      sent.new += r.new;
      sent.updated += r.updated;
      sent.skipped_images += r.skipped_images;
      sent.merged += r.merged;
      for (const k of Object.keys(sent.skipped)) sent.skipped[k] += r.skipped?.[k] || 0;
      console.log(`sent ${batch.length}: new ${r.new}, updated ${r.updated}, merged ${r.merged}, run #${r.run_id}`);
    }
  } finally {
    opened.cleanup();
  }
  if (sent) {
    console.log(`done: ${sent.new} new, ${sent.updated} updated, ${sent.merged} merged into existing listings, ${sent.skipped_images} images rejected`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
