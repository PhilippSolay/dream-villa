// GET /api/areas — SPEC §7 served as data for the UI (labels, groups, centroids, beaches).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { AREAS } from '../src/areas.js';

const ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  AGENT_TOKEN: 'test-agent-token-0123456789abcdef',
  USER1_EMAIL: 'philipp@example.com',
  USER1_NAME: 'Philipp',
  USER1_PASSWORD: 'correct horse battery staple',
};

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-areas-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  const app = await buildServer({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, env };
}

test('GET /api/areas: 401 without a session', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/api/areas' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/areas: every SPEC §7 area with label, group, centroid and beach', async (t) => {
  const { app, env } = await setup(t);
  const res = await app.inject({
    method: 'GET', url: '/api/areas',
    headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
  });
  assert.equal(res.statusCode, 200);

  const { areas } = res.json();
  assert.equal(areas.length, Object.keys(AREAS).length);
  assert.deepEqual(areas.map((a) => a.id), Object.keys(AREAS));
  assert.deepEqual(
    [...new Set(areas.map((a) => a.group))].sort(),
    ['bukit', 'canggu', 'west']
  );

  const cemagi = areas.find((a) => a.id === 'cemagi');
  assert.equal(cemagi.label, 'Cemagi');
  assert.deepEqual(cemagi.centroid, AREAS.cemagi.centroid);
  assert.deepEqual(cemagi.beach, AREAS.cemagi.beach);

  for (const a of areas) {
    assert.equal(typeof a.label, 'string');
    assert.equal(a.centroid.length, 2);
    assert.equal(typeof a.beach.lat, 'number');
    assert.equal(typeof a.beach.lng, 'number');
  }
});
