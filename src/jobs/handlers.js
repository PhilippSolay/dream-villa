// What each job does — the same code in a worker (src/jobs/worker.js) or inline.
//
// A handler is (db, args, { env, log, onRun }) → Promise<result>. `log(line, level)` reaches
// the server's log; `onRun(id)` names a runs row the job opened, so a worker that dies
// can still have it closed. Args and results cross a process boundary: plain data only.
// Modules load on first use, so an import worker never loads the scraper.

import { pathToFileURL } from 'node:url';

/** Console/pino-shaped logger over `log(line, level)`, for the modules that take one. */
function logger(log) {
  const at = (level) => (...parts) => log(lineOf(parts), level);
  return { info: at('info'), warn: at('warn'), error: at('error'), debug: () => {} };
}

/** `('msg')`, `({ err, step }, 'msg')` or `(new Error())` → one line of text. */
export function lineOf(parts) {
  const words = [];
  const details = [];
  for (const p of parts) {
    if (p == null) continue;
    if (typeof p !== 'object') words.push(String(p));
    else if (p instanceof Error) details.push(p.message);
    else {
      const { err, ...rest } = p;
      if (Object.keys(rest).length) details.push(JSON.stringify(rest));
      if (err) details.push(String(err.message || err));
    }
  }
  return [...words, ...details].join(' ');
}

export const HANDLERS = {
  /**
   * The daily run (src/scrape/index.js). `adapterModules` (tests only) are file paths to
   * run instead of the registry — adapter objects do not cross a process boundary.
   */
  async scrape(db, args, { log, onRun }) {
    const { runScrape } = await import('../scrape/index.js');
    const { sources = null, adapterModules = null, limit = null, detail = true, images = true, cacheDir } = args;
    const adapters = adapterModules
      ? await Promise.all(adapterModules.map(async (file) => (await import(pathToFileURL(file).href)).default))
      : null;
    const summary = await runScrape({
      db, sources, adapters, limit, detail, images, cacheDir, onRun,
      log: (...parts) => log(parts.join(' ')),
    });
    const { run_id, seen, updated, unchanged, errors, notes, ms } = summary;
    return { run_id, seen, new: summary.new, updated, unchanged, errors, notes, ms };
  },

  /** SPEC §9: the nightly copy, taken on this connection so its page steps stay off the web thread. */
  async backup(db, { dir, keep }) {
    const { runBackup } = await import('../backup.js');
    return runBackup(db, dir, keep);
  },

  /**
   * Every row's scope and fit score against the config as it stands now: after a weight or
   * threshold edit, or a migration that moved the brief (src/db.js).
   */
  async rescore(db) {
    const { rescoreAll } = await import('../scrape/store.js');
    return rescoreAll(db);
  },

  /** POST /api/import/posts — the whole batch, including its dedupe pass over the table. */
  async 'import-posts'(db, args) {
    const { importPosts } = await import('../routes/import.js');
    return importPosts(db, args);
  },

  /** POST /api/import/listings — the upserts; the route queues the settle after it. */
  async 'import-listings'(db, args) {
    const { importListings } = await import('../routes/import-listings.js');
    return importListings(db, args);
  },

  /** /api/import/listings' settle: dedupe, hero probe, the remaining galleries (src/scrape/settle.js). */
  async settle(db, args, { log, onRun }) {
    const { settleBatch } = await import('../routes/import-listings.js');
    return settleBatch(db, { ...args, log: logger(log), onRun });
  },
};

export default { HANDLERS, lineOf };
