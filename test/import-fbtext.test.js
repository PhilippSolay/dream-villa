// Facebook's collapsed-post noise on import: a harvester that could not expand a
// post ships "… See more" at the tail and "See translation" lines in the body.
// cleanPostText strips both and flags the post; the route records the flag in raw.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { cleanPostText } from '../src/routes/import.js';

const ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  AGENT_TOKEN: 'test-agent-token-0123456789abcdef',
  USER1_EMAIL: 'philipp@example.com',
  USER1_NAME: 'Philipp',
  USER1_PASSWORD: 'correct horse battery staple',
  USER2_EMAIL: 'abigail@example.com',
  USER2_NAME: 'Abigail',
  USER2_PASSWORD: 'another long passphrase',
};

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-import-fbtext-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  const app = await buildServer({ db, env });
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { email: env.USER1_EMAIL, password: env.USER1_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { db, call };
}

test('cleanPostText: strips "… See more" and "See translation" and flags the post as truncated', () => {
  const { text, truncated } = cleanPostText(
    'New Renovation 2 bedroom house in Dewi Uma\nFOR ONLY YEARLY RENT\nSee translation\nLand size 70m2… See more'
  );
  assert.equal(text, 'New Renovation 2 bedroom house in Dewi Uma\nFOR ONLY YEARLY RENT\nLand size 70m2…');
  assert.equal(truncated, true);
});

test('cleanPostText: "See more" without an ellipsis still becomes one', () => {
  const { text, truncated } = cleanPostText('Available Now See more');
  assert.equal(text, 'Available Now…');
  assert.equal(truncated, true);
});

test('cleanPostText: a fully expanded post is untouched and not truncated', () => {
  const { text, truncated } = cleanPostText('Lovely villa, 2 bedrooms.\nIDR 30.000.000/month.');
  assert.equal(text, 'Lovely villa, 2 bedrooms.\nIDR 30.000.000/month.');
  assert.equal(truncated, false);
});

test('cleanPostText: a "See more" mid-text (collapsed copy followed by the full repost) is not a truncation', () => {
  const { text, truncated } = cleanPostText('Short… See more\nSee translation\nShort version, then the full text here.');
  assert.equal(text, 'Short…\nShort version, then the full text here.');
  assert.equal(truncated, false);
});

test('a collapsed post imports with the noise stripped and truncated recorded in raw', async (t) => {
  const { db, call } = await setup(t);
  const text =
    'For rent 2 bedroom villa in Cemagi with pool, IDR 30.000.000/month.\nSee translation\nFully furnished… See more';
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [{ post_id: 'cut1', url: 'https://facebook.com/groups/x/posts/cut1', posted_at: '2026-09-10T08:00:00.000Z', text }],
    },
  });
  assert.equal(res.statusCode, 200);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.equal(row.description, 'For rent 2 bedroom villa in Cemagi with pool, IDR 30.000.000/month.\nFully furnished…');
  assert.doesNotMatch(row.description, /See (?:more|translation)/i);
  assert.equal(JSON.parse(row.raw).truncated, true);
  assert.equal(row.area, 'cemagi');
  assert.equal(row.price_month_idr, 30_000_000);
});
