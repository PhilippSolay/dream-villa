// SPEC §6 "Scraper" — HTTP fetch with disk caching, per-host rate limiting and
// polite backoff. Pure I/O layer: adapters call fetchHtml/fetchBuffer through
// the ctx this module builds; nothing here parses HTML or touches the DB.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetch } from 'undici';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const BACKOFF_MS = 30_000; // 429 / 403
const RETRY_5XX_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha1(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

/** Base cache path (no extension) for a URL — callers append `.html` / `.json`. */
export function cachePathFor(url, cacheDir) {
  return path.join(cacheDir, sha1(url));
}

function readCache(htmlPath, metaPath, ttlHours) {
  if (!fs.existsSync(metaPath)) return null;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  const fetchedAt = new Date(meta.fetched_at).getTime();
  if (!Number.isFinite(fetchedAt)) return null;
  const ageMs = Date.now() - fetchedAt;
  // >= rather than >: a ttlHours of 0 means "never serve from cache" even when the
  // read happens in the same millisecond as the write (ageMs === 0).
  if (ageMs < 0 || ageMs >= ttlHours * 3_600_000) return null;

  if (meta.status === 200) {
    if (!fs.existsSync(htmlPath)) return null;
    return { html: fs.readFileSync(htmlPath, 'utf8'), status: 200, fromCache: true, fetchedAt: meta.fetched_at };
  }
  if (meta.status === 404 || meta.status === 410) {
    return { html: null, status: meta.status, fromCache: true, fetchedAt: meta.fetched_at };
  }
  return null; // only terminal 200/404/410 outcomes are ever cached
}

function writeCache(htmlPath, metaPath, { url, status, fetched_at, html }) {
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html ?? '', 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({ url, status, fetched_at }), 'utf8');
}

/**
 * @param {object} [opts]
 * @param {object|null} [opts.db] passed through, unused here — for callers that want it on ctx
 * @param {object} [opts.config]
 * @param {object} [opts.log] console-shaped logger
 * @param {string} [opts.cacheDir]
 * @param {number} [opts.minIntervalMs] minimum gap between two requests to the same host
 * @param {string} [opts.userAgent]
 */
export function createCtx({
  db = null,
  config = {},
  log = console,
  cacheDir = process.env.CACHE_DIR || 'data/cache',
  minIntervalMs = 1000,
  userAgent,
} = {}) {
  const stats = { requests: 0, cached: 0, blocked: 0, errors: 0 };
  const lastRequestAt = new Map(); // host -> ms timestamp
  const hostQueue = new Map(); // host -> promise chain, serialises the gap check

  const headers = {
    'User-Agent': userAgent || DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en',
  };

  /** Serialise requests to `host` and wait out any remaining part of minIntervalMs. */
  function throttleHost(host) {
    const prev = hostQueue.get(host) || Promise.resolve();
    const gate = prev.then(async () => {
      const wait = (lastRequestAt.get(host) || 0) + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt.set(host, Date.now());
    });
    hostQueue.set(host, gate);
    return gate;
  }

  async function rawFetch(url) {
    stats.requests++;
    await throttleHost(new URL(url).host);
    try {
      return await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      stats.errors++;
      throw err;
    }
  }

  /** One GET with the 429/403 back-off-and-retry-once and 5xx retry-once policy. */
  async function fetchWithPolicy(url) {
    let res = await rawFetch(url);

    if (res.status === 429 || res.status === 403) {
      log.warn?.(`[fetch] ${res.status} ${url} — backing off ${BACKOFF_MS}ms`);
      await sleep(BACKOFF_MS);
      res = await rawFetch(url);
      if (res.status === 429 || res.status === 403) {
        stats.blocked++;
        throw new Error(`blocked:${res.status}`);
      }
      return res;
    }

    if (res.status >= 500) {
      log.warn?.(`[fetch] ${res.status} ${url} — retrying in ${RETRY_5XX_MS}ms`);
      await sleep(RETRY_5XX_MS);
      res = await rawFetch(url);
      if (res.status >= 500) {
        stats.errors++;
        throw new Error(`fetch failed: ${res.status} ${url}`);
      }
    }

    return res;
  }

  async function fetchHtml(url, { ttlHours = 24, force = false } = {}) {
    const base = cachePathFor(url, cacheDir);
    const htmlPath = `${base}.html`;
    const metaPath = `${base}.json`;

    if (!force) {
      const cached = readCache(htmlPath, metaPath, ttlHours);
      if (cached) {
        stats.cached++;
        return cached;
      }
    }

    const res = await fetchWithPolicy(url);
    let html = null;
    if (res.status === 200) {
      html = await res.text();
    } else if (res.status === 404 || res.status === 410) {
      html = null;
    } else {
      stats.errors++;
      throw new Error(`unexpected status:${res.status} ${url}`);
    }

    const fetchedAt = new Date().toISOString();
    writeCache(htmlPath, metaPath, { url, status: res.status, fetched_at: fetchedAt, html });
    return { html, status: res.status, fromCache: false, fetchedAt };
  }

  async function fetchBuffer(url) {
    const res = await fetchWithPolicy(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, status: res.status, contentType: res.headers.get('content-type') };
  }

  return { fetchHtml, fetchBuffer, log, config, db, stats };
}

export default { createCtx, sha1, cachePathFor };
