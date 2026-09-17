import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createCtx, sha1, cachePathFor } from '../src/scrape/fetch.js';

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'villa-cache-'));
}

/** A tiny local server so the tests never touch the network. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Force-close any lingering keep-alive sockets so server.close() resolves promptly
 *  instead of waiting on undici's connection pool to give them up on its own. */
function stop(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

test('sha1 / cachePathFor are deterministic', () => {
  assert.equal(sha1('hello'), sha1('hello'));
  assert.notEqual(sha1('hello'), sha1('world'));
  const dir = tmpCacheDir();
  assert.equal(cachePathFor('https://x.test/a', dir), path.join(dir, sha1('https://x.test/a')));
});

test('fetchHtml: 200 is cached to disk and served without a second request', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>hello</html>');
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/page`;
  const cacheDir = tmpCacheDir();
  const ctx = createCtx({ cacheDir, minIntervalMs: 10 });

  const first = await ctx.fetchHtml(url);
  assert.equal(first.status, 200);
  assert.equal(first.html, '<html>hello</html>');
  assert.equal(first.fromCache, false);
  assert.ok(fs.existsSync(`${cachePathFor(url, cacheDir)}.html`));
  assert.ok(fs.existsSync(`${cachePathFor(url, cacheDir)}.json`));

  const second = await ctx.fetchHtml(url);
  assert.equal(second.fromCache, true);
  assert.equal(second.html, '<html>hello</html>');
  assert.equal(hits, 1, 'second call must be served from cache, not the network');
  assert.equal(ctx.stats.requests, 1);
  assert.equal(ctx.stats.cached, 1);

  await stop(server);
});

test('fetchHtml: force skips the cache and re-requests', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    res.writeHead(200);
    res.end('body ' + hits);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/force`;
  const ctx = createCtx({ cacheDir: tmpCacheDir(), minIntervalMs: 10 });

  await ctx.fetchHtml(url);
  const forced = await ctx.fetchHtml(url, { force: true });
  assert.equal(hits, 2);
  assert.equal(forced.html, 'body 2');

  await stop(server);
});

test('fetchHtml: 404 is cached as a null-html result', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    res.writeHead(404);
    res.end('not found');
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/missing`;
  const ctx = createCtx({ cacheDir: tmpCacheDir(), minIntervalMs: 10 });

  const first = await ctx.fetchHtml(url);
  assert.equal(first.status, 404);
  assert.equal(first.html, null);
  assert.equal(first.fromCache, false);

  const second = await ctx.fetchHtml(url);
  assert.equal(second.status, 404);
  assert.equal(second.html, null);
  assert.equal(second.fromCache, true);
  assert.equal(hits, 1, '404 must be cached too');

  await stop(server);
});

test('fetchHtml: an expired cache entry (ttlHours=0) triggers a fresh request', async () => {
  let hits = 0;
  const server = await startServer((req, res) => {
    hits++;
    res.writeHead(200);
    res.end('v' + hits);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/ttl`;
  const ctx = createCtx({ cacheDir: tmpCacheDir(), minIntervalMs: 10 });

  await ctx.fetchHtml(url, { ttlHours: 24 });
  const again = await ctx.fetchHtml(url, { ttlHours: 0 });
  assert.equal(hits, 2);
  assert.equal(again.html, 'v2');

  await stop(server);
});

test('fetchHtml: rate limiter enforces >= minIntervalMs between requests to the same host', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const ctx = createCtx({ cacheDir: tmpCacheDir(), minIntervalMs: 200 });

  const t0 = Date.now();
  await ctx.fetchHtml(`${base}/a`);
  await ctx.fetchHtml(`${base}/b`); // different URL, same host — must still wait out the gap
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 200, `expected >= 200ms between same-host requests, got ${elapsed}ms`);

  await stop(server);
});

test('fetchBuffer: fetches bytes with content type, same rate limit, no cache', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/img.jpg`;
  const cacheDir = tmpCacheDir();
  const ctx = createCtx({ cacheDir, minIntervalMs: 10 });

  const { buffer, status, contentType } = await ctx.fetchBuffer(url);
  assert.equal(status, 200);
  assert.equal(contentType, 'image/jpeg');
  assert.deepEqual([...buffer], [1, 2, 3, 4]);
  assert.equal(fs.readdirSync(cacheDir).length, 0, 'fetchBuffer must not write to the cache');

  await stop(server);
});
