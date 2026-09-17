// Fastify app factory. Routes for the app itself land here in later steps.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import { nowIso } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildServer({ db, env = process.env, logger = false } = {}) {
  if (!db) throw new Error('buildServer needs a db');

  const app = Fastify({ logger, trustProxy: true });

  await registerAuth(app, db, env);

  const publicDir = path.join(ROOT, 'public');
  const imagesDir = path.resolve(ROOT, env.IMAGES_DIR || 'data/images');
  fs.mkdirSync(imagesDir, { recursive: true });

  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  await app.register(fastifyStatic, { root: imagesDir, prefix: '/images/', decorateReply: false });

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

  return app;
}

export default buildServer;
