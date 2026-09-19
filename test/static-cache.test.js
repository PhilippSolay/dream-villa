// App files (HTML, JS, CSS) must revalidate on every load so a deploy shows up at once —
// behind Cloudflare, a public max-age is honoured for hours by both edge and browser.
// Listing images are immutable per path and may stay cached.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-static-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  const app = await buildServer({ db, env });
  fs.mkdirSync(path.join(env.IMAGES_DIR, '7'), { recursive: true });
  fs.writeFileSync(path.join(env.IMAGES_DIR, '7', '1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app };
}

test('index: no-cache HTML that points at versioned app.js and styles.css', async (t) => {
  const { app } = await setup(t);
  assert.match(app.assetVersion, /^[0-9a-f]{10}$/, 'a content hash of public/');
  for (const url of ['/', '/index.html']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.headers['cache-control'], 'no-cache', `${url}: the phone must ask every time`);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(res.body.includes(`src="/v/${app.assetVersion}/app.js"`), `${url} loads the versioned app.js`);
    assert.ok(res.body.includes(`href="/v/${app.assetVersion}/styles.css"`), `${url} loads the versioned styles.css`);
    assert.ok(!res.body.includes('src="/app.js"'), 'no unversioned script left');
  }
});

test('versioned app files: immutable for a year; the plain paths still work with no-cache', async (t) => {
  const { app } = await setup(t);
  const v = app.assetVersion;
  for (const file of ['app.js', 'styles.css', 'views/home.js', 'views/charts.css', 'lib/ui.js']) {
    const res = await app.inject({ method: 'GET', url: `/v/${v}/${file}` });
    assert.equal(res.statusCode, 200, file);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', file);
    const plain = await app.inject({ method: 'GET', url: `/${file}` });
    assert.equal(plain.statusCode, 200, file);
    assert.equal(plain.headers['cache-control'], 'no-cache', `/${file} is the dev / fallback path`);
    assert.ok(plain.headers.etag, `/${file} keeps an etag so revalidation is a cheap 304`);
  }
  const first = await app.inject({ method: 'GET', url: '/app.js' });
  const again = await app.inject({ method: 'GET', url: '/app.js', headers: { 'if-none-match': first.headers.etag } });
  assert.equal(again.statusCode, 304);
  assert.equal((await app.inject({ method: 'GET', url: '/v/0000000000/app.js' })).statusCode, 404, 'a stale version is not served');
});

test('listing images: long public cache', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/images/7/1.jpg' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['cache-control'] || '', /public, max-age=\d{5,}/, 'images are safe to hold for days');
});
