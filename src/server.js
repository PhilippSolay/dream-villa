// Fastify app factory. Routes for the app itself land here in later steps.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import { nowIso } from './db.js';
import { sameTeamSql } from './teams.js';
import { ensureThumb } from './thumbs.js';
import { createJobs } from './jobs/index.js';
import propertiesRoutes from './routes/properties.js';
import marketRoutes from './routes/market.js';
import marketMetricsRoutes from './routes/market-metrics.js';
import adminRoutes from './routes/admin.js';
import agentRoutes from './routes/agent.js';
import statsRoutes from './routes/stats.js';
import importRoutes from './routes/import.js';
import importListingsRoutes from './routes/import-listings.js';
import duplicatesRoutes from './routes/duplicates.js';
import anchorsRoutes from './routes/anchors.js';
import peopleRoutes from './routes/people.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Content hash of everything under public/ (files starting with `_` are local scratch and
 * skipped). It becomes the `/v/<hash>/` prefix the page loads its modules from, so every
 * deploy is a new URL and no cache — Cloudflare's or the phone's — can serve stale code.
 */
export function assetVersion(dir) {
  const hash = crypto.createHash('sha1');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name.startsWith('_') || name.startsWith('.')) continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else {
        hash.update(path.relative(dir, p));
        hash.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 10);
}

/**
 * @param {object} opts
 * @param {object} [opts.jobs] createJobs options (src/jobs). Inline unless it says
 *   `mode: 'fork'`, which is what src/index.js — production — asks for.
 */
export async function buildServer({ db, env = process.env, logger = false, jobs: jobOptions = {} } = {}) {
  if (!db) throw new Error('buildServer needs a db');

  const app = Fastify({ logger, trustProxy: true });

  // Scrape and import work, off this thread (src/jobs). The routes and the cron hand it over.
  const jobs = createJobs({
    db,
    env,
    mode: 'inline',
    log: (line, level = 'info') => (app.log[level] || app.log.info).call(app.log, line),
    ...jobOptions,
  });
  app.decorate('jobs', jobs);
  app.addHook('onClose', async () => jobs.close());

  await registerAuth(app, db, env);

  const publicDir = path.join(ROOT, 'public');
  const imagesDir = path.resolve(ROOT, env.IMAGES_DIR || 'data/images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // Caching, three tiers:
  //  - index.html: served here, never cached, with its two asset URLs rewritten to /v/<hash>/.
  //    Cloudflare passes HTML through, so this is what actually defeats stale caches.
  //  - /v/<hash>/…: the same public/ files, immutable for a year. Module imports inside are
  //    relative, so app.js at /v/<hash>/app.js pulls /v/<hash>/lib/… on its own.
  //  - plain /app.js etc.: kept for dev and the preview harness, revalidated on every load
  //    (Cloudflare still stamps its own browser TTL on these — hence the versioned tier).
  //  - /images/…: a listing image never changes under its path; a month is safe.
  const version = assetVersion(publicDir);
  app.decorate('assetVersion', version);

  const indexPath = path.join(publicDir, 'index.html');
  const serveIndex = async (request, reply) => {
    const html = fs
      .readFileSync(indexPath, 'utf8')
      .replaceAll('href="/styles.css"', `href="/v/${version}/styles.css"`)
      .replaceAll('src="/app.js"', `src="/v/${version}/app.js"`);
    return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html);
  };
  app.get('/', serveIndex);
  app.get('/index.html', serveIndex);

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    index: false,
    cacheControl: false,
    setHeaders: (reply) => reply.header('Cache-Control', 'no-cache'), // @fastify/static 10 hands over the Fastify reply
  });
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: `/v/${version}/`,
    decorateReply: false,
    index: false,
    maxAge: '365d',
    immutable: true,
  });
  // A viewing's photos are the team's, like the viewing itself (SPEC §17) — the listing's
  // own photos came off a public page and stay public. Saved as `<property>/v<viewing>-<n>.jpg`
  // (routes/properties.js); matched on the decoded, normalised path the static server
  // will actually open, so an encoded `%76` or a `./` cannot walk around the check.
  const viewingPhoto = (url) => {
    let p;
    try {
      p = path.posix.normalize(decodeURIComponent(String(url).split('?')[0]));
    } catch {
      return null;
    }
    if (!p.startsWith('/images/')) return null;
    const base = path.posix.basename(p);
    const m = /^v(\d+)-/i.exec(base);
    if (!m) return null;
    return { viewingId: Number(m[1]), propertyId: Number(path.posix.basename(path.posix.dirname(p))) };
  };
  app.addHook('onRequest', async (request, reply) => {
    const photo = viewingPhoto(request.url);
    if (!photo) return;
    const user = app.resolveUser(request);
    const seen = user && Number.isInteger(photo.propertyId) && db
      .prepare(`SELECT 1 FROM viewings WHERE id = ? AND property_id = ? AND ${sameTeamSql(user)}`)
      .get(photo.viewingId, photo.propertyId);
    // 404, not 401/403: another team's visit is not there to be told about.
    if (!seen) return reply.code(404).send({ error: 'not_found' });
  });
  // …and never cached where the next caller could be served it without that check.
  app.addHook('onSend', async (request, reply, payload) => {
    if (viewingPhoto(request.url)) reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  await app.register(fastifyStatic, { root: imagesDir, prefix: '/images/', decorateReply: false, maxAge: '30d' });

  // Card-sized WebP cuts of the listing photos (src/thumbs.js), public like the photos
  // they are cut from and cached as long. Numeric names only: `v3-1.jpg` (a viewing's
  // photo, gated above) never matches. A cut that fails sends the caller to the original.
  const thumbsDir = path.resolve(ROOT, env.THUMBS_DIR || path.join(path.dirname(imagesDir), 'thumbs'));
  app.get('/thumbs/:id/:file', async (request, reply) => {
    const { id, file } = request.params;
    const m = /^(\d+)\.webp$/.exec(file);
    if (!/^\d+$/.test(id) || !m) return reply.code(404).send({ error: 'not_found' });
    let thumb;
    try {
      thumb = await ensureThumb(imagesDir, thumbsDir, id, m[1]);
    } catch (err) {
      request.log.warn({ err }, `thumb ${id}/${m[1]} failed`);
      return reply.redirect(`/images/${id}/${m[1]}.jpg`, 302);
    }
    if (!thumb) return reply.code(404).send({ error: 'not_found' });
    // The length lets a browser (and Cloudflare) tell a transfer cut short from a whole
    // picture; without it a cut-off thumb was cached as complete, a month's broken card.
    const { size } = await fs.promises.stat(thumb);
    return reply
      .header('Cache-Control', 'public, max-age=2592000')
      .header('Content-Length', size)
      .type('image/webp')
      .send(fs.createReadStream(thumb));
  });

  app.get('/healthz', async (request, reply) => {
    let dbOk = false;
    try {
      dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1;
    } catch (err) {
      request.log?.error?.({ err }, 'healthz db check failed');
    }
    if (!dbOk) return reply.code(503).send({ ok: false, db: false, time: nowIso() });
    return { ok: true, db: true, time: nowIso() };
  });

  // API route modules (SPEC §4). Each receives { db, env }; the scraper and import routes
  // also get `jobs`.
  await app.register(propertiesRoutes, { db, env });
  await app.register(marketRoutes, { db, env });
  await app.register(marketMetricsRoutes, { db, env });
  await app.register(adminRoutes, { db, env, jobs });
  await app.register(agentRoutes, { db, env });
  await app.register(statsRoutes, { db, env });
  await app.register(importRoutes, { db, env, jobs });
  await app.register(importListingsRoutes, { db, env, jobs });
  await app.register(duplicatesRoutes, { db, env });
  await app.register(anchorsRoutes, { db, env });
  await app.register(peopleRoutes, { db, env });

  return app;
}

export default buildServer;
