// src/jobs — scrape and import work in a child process, off the web thread.
//
// The fixture adapter burns BUSY_MS of synchronous CPU per card, the way cheerio parsing
// and better-sqlite3 upserts do. Run in a worker, GET /healthz keeps answering at once;
// run inline (the control), the same scrape holds every request for about BUSY_MS.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { createJobs } from '../src/jobs/index.js';
import { cachedContext } from '../src/scrape/duplicates.js';
import { BUSY_MS, CARDS } from './fixtures/jobs/slow-adapter.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/jobs');
const SLOW = path.join(FIXTURES, 'slow-adapter.js');
const CRASH = path.join(FIXTURES, 'crash-adapter.js');

const ENV = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  AGENT_TOKEN: 'test-agent-token-0123456789abcdef',
  USER1_EMAIL: 'philipp@example.com',
  USER1_NAME: 'Philipp',
  USER1_PASSWORD: 'correct horse battery staple',
};

const AUTH = { authorization: `Bearer ${ENV.ADMIN_TOKEN}` };

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-jobs-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images'), CACHE_DIR: path.join(dir, 'cache') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env, db };
}

/** A listening server (real HTTP, as the container's healthcheck calls it). */
async function server(t, { db, env }, jobs) {
  const app = await buildServer({ db, env, jobs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (url, { method = 'GET', body } = {}) =>
    fetch(`${base}${url}`, {
      method,
      headers: body ? { ...AUTH, 'content-type': 'application/json' } : AUTH,
      body: body ? JSON.stringify(body) : undefined,
    });
  return { app, call };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lastRun = (db, kind = 'scrape') => db.prepare('SELECT * FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);

/**
 * Hit /healthz every 50 ms, in the background, until stopped. Each sample is when the
 * request left, how long its answer took, and when it came. The client shares the web
 * process's thread, so a blocked thread shows as a gap between answers as much as a slow one.
 */
function probeHealthz(call) {
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const at = performance.now();
      const res = await call('/healthz');
      const body = await res.json();
      const answered = performance.now();
      samples.push({ at, answered, ms: answered - at, ok: res.status === 200 && body.ok === true });
      await sleep(50);
    }
  })();
  return {
    samples,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

async function idle(jobs, lane, timeoutMs = 30_000) {
  const started = Date.now();
  while (jobs.busy(lane)) {
    if (Date.now() - started > timeoutMs) throw new Error(`the ${lane} job never finished`);
    await sleep(25);
  }
}

/**
 * POST /api/scrape with /healthz probed throughout. `slowest` is the slowest answer to a
 * request sent while the scrape ran; `silence` the longest stretch of that time with no
 * answer at all.
 */
async function scrapeUnderProbe(app, call) {
  const probe = probeHealthz(call);
  await sleep(150); // a few answers before, as a baseline

  const from = performance.now();
  const started = await call('/api/scrape', { method: 'POST', body: {} });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { started: true, source: null });
  await idle(app.jobs, 'scrape');
  const to = performance.now();

  await probe.stop();
  assert.ok(probe.samples.every((s) => s.ok), 'every healthz answer was 200 {ok: true}');
  const during = probe.samples.filter((s) => s.at >= from && s.at <= to);
  const marks = [from, ...probe.samples.map((s) => s.answered).filter((a) => a > from && a < to), to];
  const silence = Math.max(...marks.slice(1).map((m, i) => m - marks[i]));
  return { during, slowest: Math.max(0, ...during.map((s) => s.ms)), silence, seconds: (to - from) / 1000 };
}

// ---------------------------------------------------------------------------
// The point of it all
// ---------------------------------------------------------------------------

test('a long scrape in a worker leaves GET /healthz answering at once, and keeps its run log', async (t) => {
  const ctx = tmp(t);
  const { app, call } = await server(t, ctx, { mode: 'fork', args: { scrape: { adapterModules: [SLOW], images: false } } });
  assert.equal(app.jobs.mode, 'fork');

  const { during, slowest, silence, seconds } = await scrapeUnderProbe(app, call);
  t.diagnostic(`worker: ${during.length} answers in ${seconds.toFixed(1)} s, slowest ${slowest.toFixed(0)} ms, longest silence ${silence.toFixed(0)} ms`);

  assert.ok(seconds >= (CARDS * BUSY_MS) / 1000, `the scrape really took its ${CARDS} × ${BUSY_MS} ms (${seconds.toFixed(1)} s)`);
  assert.ok(during.length >= 10, `healthz answered ${during.length} times while the scrape ran`);
  assert.ok(slowest < BUSY_MS / 2, `healthz took ${slowest.toFixed(0)} ms at worst while the worker spun ${BUSY_MS} ms per card`);
  assert.ok(silence < BUSY_MS / 2, `the longest wait for any healthz answer was ${silence.toFixed(0)} ms`);

  // The run log, written by the worker's own connection, read through the web's.
  const run = lastRun(ctx.db);
  assert.ok(run.finished_at, 'the run is closed');
  assert.deepEqual(JSON.parse(run.sources), ['slow']);
  assert.equal(run.seen, CARDS);
  assert.equal(run.new, CARDS);
  assert.deepEqual(JSON.parse(run.errors), []);
  assert.ok(JSON.parse(run.notes).some((n) => n.startsWith(`slow: seen ${CARDS}`)));
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM properties WHERE source = 'slow'").get().n, CARDS);
});

test('control: the same scrape inline holds GET /healthz for about a card at a time', async (t) => {
  const ctx = tmp(t);
  const { app, call } = await server(t, ctx, { mode: 'inline', args: { scrape: { adapterModules: [SLOW], images: false } } });

  const { silence, seconds } = await scrapeUnderProbe(app, call);
  t.diagnostic(`inline: longest silence ${silence.toFixed(0)} ms in ${seconds.toFixed(1)} s`);

  assert.ok(silence >= BUSY_MS * 0.8, `inline, healthz went ${silence.toFixed(0)} ms without an answer behind ${BUSY_MS} ms cards`);
});

test('POST /api/scrape: one at a time — a 409 while the worker runs, a 202 once it is done', async (t) => {
  const ctx = tmp(t);
  const { app, call } = await server(t, ctx, { mode: 'fork', args: { scrape: { adapterModules: [SLOW], images: false } } });

  assert.equal((await call('/api/scrape', { method: 'POST', body: {} })).status, 202);
  const again = await call('/api/scrape', { method: 'POST', body: { source: 'bhi' } });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'already_running' });

  await idle(app.jobs, 'scrape');
  assert.equal((await call('/api/scrape', { method: 'POST', body: {} })).status, 202, 'the guard lifts');
  await idle(app.jobs, 'scrape');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'scrape' AND finished_at IS NOT NULL").get().n, 2);
});

// ---------------------------------------------------------------------------
// A worker that goes wrong
// ---------------------------------------------------------------------------

test('a worker that dies mid-run has its run row closed, and the lane frees', async (t) => {
  const { db } = tmp(t);
  const jobs = createJobs({ db, mode: 'fork', args: { scrape: { adapterModules: [CRASH], images: false } } });
  t.after(() => jobs.close());

  await assert.rejects(jobs.run('scrape'), /worker exited \(SIGKILL\)/);
  assert.equal(jobs.busy('scrape'), false);

  const run = lastRun(db);
  assert.ok(run.finished_at, 'closed, not left reading as running');
  assert.match(JSON.parse(run.errors)[0], /^scrape: worker exited \(SIGKILL\)/);
});

test('a job past its timeout is stopped and its run row closed with the reason', async (t) => {
  const { db } = tmp(t);
  const jobs = createJobs({
    db,
    mode: 'fork',
    timeouts: { scrape: 1500 },
    args: { scrape: { adapterModules: [SLOW], images: false } },
  });
  t.after(() => jobs.close());

  await assert.rejects(jobs.run('scrape'), /timed out after 1500 ms/);
  const run = lastRun(db);
  assert.ok(run.finished_at);
  assert.deepEqual(JSON.parse(run.errors), ['scrape: timed out after 1500 ms']);
});

test('a handler that throws fails its job with the message, in a worker as inline', async (t) => {
  const { db } = tmp(t);
  const jobs = createJobs({ db, mode: 'fork' });
  t.after(() => jobs.close());
  await assert.rejects(jobs.run('scrape', { sources: ['nope'] }), /unknown source\(s\): nope/);
  await assert.rejects(jobs.run('no-such-job'), /unknown job kind/);
});

test('closing the runner stops a running worker and refuses queued and new jobs', async (t) => {
  const { db } = tmp(t);
  const jobs = createJobs({ db, mode: 'fork', args: { scrape: { adapterModules: [SLOW], images: false } } });

  const running = assert.rejects(jobs.run('scrape'), /stopped: the server shut down/);
  const queued = assert.rejects(jobs.run('scrape'), /shutting down/);
  while (lastRun(db)?.finished_at !== null) await sleep(20); // the worker has opened its run
  await jobs.close();

  await running;
  await queued;
  await assert.rejects(jobs.run('scrape'), /shutting down/);
  assert.deepEqual(JSON.parse(lastRun(db).errors), ['scrape: stopped: the server shut down']);
});

// ---------------------------------------------------------------------------
// Imports: same answer from a worker, and the web's cached views catch up
// ---------------------------------------------------------------------------

function fbBatch(price = '35.000.000') {
  return {
    source: 'fb',
    group_id: 'cemagi-pererenan-villas',
    posts: [
      {
        post_id: 'p1',
        url: 'https://facebook.com/groups/x/posts/p1',
        posted_at: '2026-09-10T08:00:00.000Z',
        text: `For rent: lovely 2 bedroom villa in Cemagi with pool and garden. IDR ${price}/month. Contact 0812-3456-7890 (WhatsApp).`,
        poster_name: 'Wayan',
        group_name: 'Cemagi Pererenan Villas For Rent',
      },
      {
        post_id: 'p2',
        url: 'https://facebook.com/groups/x/posts/p2',
        posted_at: '2026-09-11T08:00:00.000Z',
        text: 'Looking for a 3 bedroom villa in Pererenan, budget 40 juta/month',
      },
    ],
  };
}

test('POST /api/import/posts answers from a worker exactly as inline, and the duplicate context is re-read after it', async (t) => {
  const forked = tmp(t);
  const inline = tmp(t);
  const { call: forkCall } = await server(t, forked, { mode: 'fork' });
  const { call: inlineCall } = await server(t, inline, { mode: 'inline' });

  const fromWorker = await forkCall('/api/import/posts', { method: 'POST', body: fbBatch() });
  const fromInline = await inlineCall('/api/import/posts', { method: 'POST', body: fbBatch() });
  assert.equal(fromWorker.status, 200);
  assert.equal(fromInline.status, 200);
  const body = await fromWorker.json();
  assert.deepEqual(body, await fromInline.json());
  assert.equal(body.new, 1);
  assert.deepEqual(body.skipped, { no_signal: 0, offtopic: 0, wanted: 1 });
  assert.equal(forked.db.prepare('SELECT price_month_idr FROM properties WHERE id = ?').get(body.ids[0]).price_month_idr, 35_000_000);

  // A re-import that changes a price moves nothing the context fingerprint counts (rows,
  // max id, gone, contacts, dismissals). The job's end is what tells the web to re-read.
  const before = cachedContext(forked.db).rows.find((r) => r.id === body.ids[0]);
  assert.equal(before.price_month_idr, 35_000_000);
  const reimport = await forkCall('/api/import/posts', { method: 'POST', body: fbBatch('38.000.000') });
  assert.equal((await reimport.json()).updated, 1);
  const after = cachedContext(forked.db).rows.find((r) => r.id === body.ids[0]);
  assert.equal(after.price_month_idr, 38_000_000);
});

test('POST /api/import/listings answers from a worker, and its settle runs in one after it', async (t) => {
  const ctx = tmp(t);
  const { call } = await server(t, ctx, { mode: 'fork' });

  const res = await call('/api/import/listings', {
    method: 'POST',
    body: {
      source: 'balivillahub',
      listings: [
        { ref: 'r1', url: 'https://balivillahub.com/listing/r1', title: '2 Bedroom Villa in Cemagi', bedrooms: 2, price_month_idr: 35_000_000, area: 'cemagi' },
        { ref: 'r2', url: 'https://balivillahub.com/listing/r2', title: '9 Bedroom Palace', bedrooms: 9, price_month_idr: 300_000_000, area: 'cemagi' },
      ],
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.new, 1);
  assert.deepEqual(body.skipped, { out_of_band: 1 });
  assert.equal(body.settle_queued, true);

  const started = Date.now();
  let settle;
  while (!(settle = lastRun(ctx.db, 'settle'))?.finished_at) {
    if (Date.now() - started > 20_000) throw new Error('settle never finished');
    await sleep(50);
  }
  assert.deepEqual(JSON.parse(settle.sources), ['balivillahub']);
  assert.equal(settle.seen, 1);
  assert.deepEqual(JSON.parse(settle.errors), []);
});

// ---------------------------------------------------------------------------
// Rescores after a weight edit
// ---------------------------------------------------------------------------

test('weight edits that land while a rescore runs share the next one, which starts after them', async (t) => {
  const { db } = tmp(t);
  const gates = [];
  let calls = 0;
  const jobs = createJobs({
    db,
    mode: 'inline',
    handlers: {
      rescore: async () => {
        const n = (calls += 1);
        await new Promise((resolve) => gates.push(resolve));
        return { n };
      },
    },
  });

  const first = jobs.run('rescore');
  while (!gates.length) await sleep(1); // running
  const second = jobs.run('rescore');
  const third = jobs.run('rescore');
  assert.equal(third, second, 'the waiting rescore is shared, not queued twice');

  gates.shift()();
  assert.deepEqual(await first, { n: 1 });
  while (!gates.length) await sleep(1);
  gates.shift()();
  assert.deepEqual(await second, { n: 2 });
  assert.equal(calls, 2);
  await new Promise((resolve) => setImmediate(resolve)); // the lane clears just after it answers
  assert.equal(jobs.busy('rescore'), false);
});

test('a rescore never waits behind a running scrape: its own lane', async (t) => {
  const { db } = tmp(t);
  let releaseScrape;
  const jobs = createJobs({
    db,
    mode: 'inline',
    handlers: {
      scrape: () => new Promise((resolve) => { releaseScrape = resolve; }),
      rescore: async () => ({ total: 0 }),
    },
  });
  const scrape = jobs.run('scrape');
  assert.deepEqual(await jobs.run('rescore'), { total: 0 });
  assert.equal(jobs.busy('scrape'), true);
  releaseScrape();
  await scrape;
});

test('PATCH /api/config and the agent weights call rescore in a worker and answer as before', async (t) => {
  const ctx = tmp(t);
  const { call } = await server(t, ctx, { mode: 'fork' });

  const imported = await (await call('/api/import/posts', { method: 'POST', body: fbBatch() })).json();
  const id = imported.ids[0];
  const fit = () => ctx.db.prepare('SELECT fit_score FROM properties WHERE id = ?').get(id).fit_score;
  const before = fit();

  const res = await call('/api/config', { method: 'PATCH', body: { weights: { pool: 20 } } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.weights.pool, 20);
  assert.equal(body.rescored.total, 1);
  assert.equal(body.weight_changes[0].feature, 'pool');
  const raised = fit();
  assert.ok(raised > before, `a pool villa scores higher with pool at 20 (${before} → ${raised})`);
  assert.equal(lastRun(ctx.db, 'learn').seen, 1);

  const set = encodeURIComponent(JSON.stringify({ pool: 0 }));
  const agent = await call(`/api/agent/weights?token=${ENV.AGENT_TOKEN}&set=${set}`);
  assert.equal(agent.status, 200);
  assert.equal((await agent.json()).weights.pool, 0);
  assert.ok(fit() < raised, 'and lower again once the agent sets it to 0');
});
