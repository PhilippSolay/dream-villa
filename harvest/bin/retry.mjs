// fetch with retries, for the minutes villa.solay.cloud is restarting. A deploy recreates the
// container (~30–60 s): meanwhile Traefik answers 404, Cloudflare 502/52x, or the socket
// drops. Those are retried (10, 20, 40, 60, 60, 60 s ≈ 4 min); anything else (400, 401, 413)
// fails at once, retrying cannot fix it. Safe for the import routes: they are idempotent
// (a post or listing already stored is updated, never duplicated).
const RETRY_STATUS = new Set([404, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const WAITS_S = [10, 20, 40, 60, 60, 60];

/** @returns {Promise<{ok:boolean, status:number, body:object, attempts:number}>} */
export async function fetchJson(url, opts, label) {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let body = null;
    try {
      const r = await fetch(url, opts);
      status = r.status;
      const text = await r.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 200) };
      }
      if (r.ok) return { ok: true, status, body, attempts: attempt + 1 };
      if (!RETRY_STATUS.has(status)) return { ok: false, status, body, attempts: attempt + 1 };
    } catch (err) {
      body = { error: err.cause?.code || err.message };
    }
    if (attempt >= WAITS_S.length) return { ok: false, status, body, attempts: attempt + 1 };
    console.error(`[retry] ${label}: ${status || body.error} — waiting ${WAITS_S[attempt]} s (try ${attempt + 2} of ${WAITS_S.length + 1})`);
    await new Promise((resolve) => setTimeout(resolve, WAITS_S[attempt] * 1000));
  }
}
