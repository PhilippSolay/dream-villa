// Fastify app factory. Routes for the app itself land here in later steps.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import { nowIso } from './db.js';
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

export async function buildServer({ db, env = process.env, logger = false } = {}) {
  if (!db) throw new Error('buildServer needs a db');

  const app = Fastify({ logger, trustProxy: true });

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
  await app.register(fastifyStatic, { root: imagesDir, prefix: '/images/', decorateReply: false, maxAge: '30d' });

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

  // API route modules (SPEC §4). Each receives { db, env }.
  await app.register(propertiesRoutes, { db, env });
  await app.register(marketRoutes, { db, env });
  await app.register(marketMetricsRoutes, { db, env });
  await app.register(adminRoutes, { db, env });
  await app.register(agentRoutes, { db, env });
  await app.register(statsRoutes, { db, env });
  await app.register(importRoutes, { db, env });
  await app.register(importListingsRoutes, { db, env });
  await app.register(duplicatesRoutes, { db, env });
  await app.register(anchorsRoutes, { db, env });

  return app;
}

export default buildServer;
