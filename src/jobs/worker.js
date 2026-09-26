// The child end of src/jobs/index.js: one job per process. Open a connection of its own,
// run the handler, report back over IPC, exit. See the header there for why.
//
// Messages to the web process: { type: 'ready' } (the job may be sent now) · { type: 'log',
// line, level } · { type: 'run', id } (a runs row this job opened, so a crash can still
// close it) · { type: 'done', result } · { type: 'failed', message, stack }.

import { openDb } from '../db.js';
import { HANDLERS } from './handlers.js';

// The web process went away (a restart, a crash): there is nobody left to report to.
process.on('disconnect', () => process.exit(1));

process.once('message', async ({ kind, args }) => {
  const report = (msg) => process.send(msg);
  let db = null;
  let reply;
  try {
    const handler = HANDLERS[kind];
    if (!handler) throw new Error(`unknown job kind: ${kind}`);
    db = openDb(process.env.DB_PATH);
    // The web process's writes take milliseconds; a job can afford to wait its turn at
    // the write lock far longer than better-sqlite3's default 5 s.
    db.pragma('busy_timeout = 30000');
    const result = await handler(db, args, {
      env: process.env,
      log: (line, level = 'info') => report({ type: 'log', line, level }),
      onRun: (id) => report({ type: 'run', id }),
    });
    reply = { type: 'done', result };
  } catch (err) {
    reply = { type: 'failed', message: String((err && err.message) || err), stack: err?.stack };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }

  // Exit explicitly: keep-alive sockets or a headless browser would otherwise hold the
  // process open after its one job.
  try {
    process.send(reply, () => process.exit(0));
  } catch (err) {
    process.send({ type: 'failed', message: `result could not be sent: ${err.message}` }, () => process.exit(1));
  }
});

// Only now: an ES module loads asynchronously, and a message that arrived before the
// listener above existed would have been dropped.
process.send({ type: 'ready' });
