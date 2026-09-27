// Scrape and import work, off the request thread.
//
// better-sqlite3 is synchronous, so while the daily scrape (thousands of upserts, cheerio
// parsing, image downloads and hashing, a rescore of every row) or an import's dedupe pass
// ran inside the web process, every API call and every /images/ read queued behind it —
// 2026-09-26 05:17–05:50 UTC: a manual full scrape, a post-deploy rescore and five
// /api/import/posts batches at 27–71 s each, and the photos crawled. Each job now runs in
// a child process with a connection of its own. WAL lets the web process keep reading
// while the child writes, and the child's heap, event loop and libuv pool (file reads,
// DNS) are not the ones serving photos.
//
// Lanes: one job at a time per lane, the rest wait their turn in order. Lanes run side by
// side and take turns at SQLite's one write lock, a short transaction at a time.
//   scrape  the daily run, POST /api/scrape, the nightly backup. The route and the cron
//           ask busy('scrape') first and refuse (409, or skip the tick), so a scrape
//           never queues behind another.
//   import  POST /api/import/posts and /api/import/listings. The request awaits its turn
//           and its result, so the response keeps its shape.
//   settle  /api/import/listings' background settle (dedupe, hero probe, galleries).
//   dedupe  the Agent page's "run the automatic pass" button (POST /api/duplicates/auto).
//   rescore every row's scope and fit score, after a weight or threshold edit (Agent page,
//           the agent's weights call) or a migration. Its own lane: an edit never waits
//           behind a scrape. Edits that land while one runs share the next one, which
//           reads the brief as it stands when it starts.
//
// mode 'inline' runs the same handlers on the caller's own connection: what the route
// tests use, and the only choice for an in-memory database, which a child cannot open.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nowIso } from '../db.js';
import { forgetContext } from '../scrape/duplicates.js';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));

/** Job kind → lane. */
export const LANES = {
  scrape: 'scrape',
  backup: 'scrape',
  rescore: 'rescore',
  'import-posts': 'import',
  'import-listings': 'import',
  settle: 'settle',
  dedupe: 'dedupe',
};

const MINUTE = 60_000;

/** A job still running after this is stopped, and its run row closed with the reason. */
export const TIMEOUTS = {
  scrape: 6 * 60 * MINUTE, // a cold source takes hours: Uma di Bali's first run, ~6k photos at 1/s
  backup: 15 * MINUTE,
  rescore: 15 * MINUTE,
  'import-posts': 15 * MINUTE,
  'import-listings': 15 * MINUTE,
  settle: 3 * 60 * MINUTE,
  dedupe: 15 * MINUTE,
};

/**
 * Kinds whose queued job a new request joins instead of queueing another: a rescore reads
 * the config when it starts, so the one already waiting covers every edit made before it.
 */
const COALESCING = new Set(['rescore']);

/** Flags a child must not inherit: a second file watcher, the test runner, a debugger port. */
const NOT_INHERITED = /^--(watch|test|inspect)/;

/**
 * Close a run row the worker opened and never finished (it crashed, timed out or was
 * stopped by a shutdown). Left open, it would read as still running forever.
 */
function abandonRun(db, id, message) {
  db.prepare('UPDATE runs SET finished_at = ?, errors = ? WHERE id = ? AND finished_at IS NULL')
    .run(nowIso(), JSON.stringify([message]), id);
}

/** SIGTERM, then SIGKILL if it has not gone after `graceMs`. Resolves once it has exited. */
function stop(child, graceMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db the web process's connection: its file
 *   is what the workers open, and it closes a run row a dead worker left open
 * @param {object} [opts.env] the server's env, handed to every worker
 * @param {'fork'|'inline'} [opts.mode]
 * @param {(line:string, level?:string) => void} [opts.log]
 * @param {Object<string, object>} [opts.args] per-kind defaults merged under every job's args
 * @param {Object<string, Function>} [opts.handlers] inline only: stand-ins for ./handlers.js (tests)
 * @param {Object<string, number>} [opts.timeouts]
 * @param {Array} [opts.stdio] the worker's stdio (its console goes to the server's own log)
 */
export function createJobs({
  db,
  env = process.env,
  mode = 'fork',
  log = () => {},
  args: defaults = {},
  handlers = null,
  timeouts = TIMEOUTS,
  stdio = ['ignore', 'inherit', 'inherit', 'ipc'],
} = {}) {
  if (!db) throw new Error('createJobs needs a db');
  const inline = mode === 'inline' || db.memory;
  const lanes = new Map(); // lane → { running, queue }
  const children = new Set();
  let closed = false;

  const laneOf = (name) => {
    let lane = lanes.get(name);
    if (!lane) lanes.set(name, (lane = { running: null, queue: [] }));
    return lane;
  };

  async function runInline(kind, args) {
    const table = handlers || (await import('./handlers.js')).HANDLERS;
    // Cloned both ways, as a worker would see them: a route that hands over a function
    // or gets one back fails its tests here, not in production.
    const result = await table[kind](db, structuredClone(args), { env, log, onRun: () => {} });
    return structuredClone(result);
  }

  function runForked(kind, args) {
    return new Promise((resolve, reject) => {
      const child = fork(WORKER, [], {
        env: { ...process.env, ...env, DB_PATH: db.name },
        execArgv: process.execArgv.filter((a) => !NOT_INHERITED.test(a)),
        serialization: 'advanced', // structured clone: a 60 MB import batch goes over as-is
        stdio,
      });
      children.add(child);
      const openRuns = new Set();
      let failure = null;
      let settled = false;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!err) return resolve(value);
        for (const id of openRuns) {
          try {
            abandonRun(db, id, `${kind}: ${err.message}`);
          } catch {
            /* the database is closing too — nothing left to write to */
          }
        }
        reject(err);
      };

      const limit = timeouts[kind] ?? TIMEOUTS[kind];
      const timer = setTimeout(() => {
        failure = new Error(`timed out after ${limit >= MINUTE ? `${Math.round(limit / MINUTE)} min` : `${limit} ms`}`);
        stop(child);
      }, limit);
      timer.unref();

      child.on('message', (msg) => {
        if (msg?.type === 'ready') {
          child.send({ kind, args }, (err) => {
            if (err) failure ??= err;
          });
        } else if (msg?.type === 'log') log(msg.line, msg.level);
        else if (msg?.type === 'run') openRuns.add(msg.id);
        else if (msg?.type === 'done') finish(null, msg.result);
        else if (msg?.type === 'failed') finish(Object.assign(new Error(msg.message), { stack: msg.stack }));
      });
      child.on('error', (err) => {
        failure ??= err;
        if (child.pid === undefined) { // never spawned: no 'exit' follows
          children.delete(child);
          finish(err);
        }
      });
      child.on('exit', (code, signal) => {
        children.delete(child);
        if (!failure && closed) failure = new Error('stopped: the server shut down');
        finish(failure || new Error(`worker exited (${signal || `code ${code}`}) before it answered`));
      });
    });
  }

  function pump(name) {
    const lane = lanes.get(name);
    if (closed || lane.running || !lane.queue.length) return;
    const job = (lane.running = lane.queue.shift());
    const t0 = Date.now();
    (inline ? runInline : runForked)(job.kind, job.args)
      .then(
        (value) => {
          log(`[jobs] ${job.kind} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          job.resolve(value);
        },
        (err) => {
          log(`[jobs] ${job.kind} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`, 'error');
          job.reject(err);
        }
      )
      .finally(() => {
        lane.running = null;
        // The job merged, retired or linked rows under this process's cached duplicate
        // context. Its fingerprint (src/scrape/duplicates.js) sees another connection's
        // inserts and merges, not a changed price or a new photo hash: start clean.
        forgetContext(db);
        pump(name);
      });
  }

  /**
   * Queue a job on its lane.
   * @param {string} kind a LANES key
   * @param {object} [args] plain data: it crosses a process boundary
   * @returns {Promise<any>} the handler's result
   */
  function run(kind, args = {}) {
    const lane = LANES[kind];
    if (!lane) return Promise.reject(new Error(`unknown job kind: ${kind}`));
    if (closed) return Promise.reject(new Error('jobs: shutting down'));
    if (COALESCING.has(kind)) {
      const waiting = laneOf(lane).queue.find((job) => job.kind === kind);
      if (waiting) return waiting.promise;
    }
    const job = { kind, args: { ...defaults[kind], ...args } };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    laneOf(lane).queue.push(job);
    pump(lane);
    return job.promise;
  }

  /** Is anything running or waiting on this lane? */
  function busy(lane) {
    const state = lanes.get(lane);
    return Boolean(state && (state.running || state.queue.length));
  }

  /** Refuse new work, drop the queued, stop the running workers (their run rows are closed). */
  async function close() {
    closed = true;
    for (const lane of lanes.values()) {
      for (const job of lane.queue.splice(0)) job.reject(new Error('jobs: shutting down'));
    }
    await Promise.all([...children].map((child) => stop(child)));
  }

  return { run, busy, close, mode: inline ? 'inline' : 'fork' };
}

export default { createJobs, LANES, TIMEOUTS };
