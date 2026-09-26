// fetch wrapper for the JSON API. Same-origin cookie session; a 401 sends you to #/login.

/** Error thrown for any non-2xx response; `.status` is the HTTP code. */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parse(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageFrom(body, res) {
  // SPEC §17: a member's write to an owner-only control 403s `owners_only` — the UI is
  // supposed to hide those controls, but a stale role or a direct API hit still lands
  // here, and "owners_only" read as an error message means nothing to a friend.
  if (res.status === 403 && body?.error === 'owners_only') return 'Only the owners can change that';
  if (body && typeof body === 'object') return body.detail || body.error || res.statusText;
  if (typeof body === 'string' && body) return body.slice(0, 200);
  return res.statusText || `HTTP ${res.status}`;
}

/**
 * @param {{onUnauthorized?: () => void}} [opts]
 */
export function createApi({ onUnauthorized } = {}) {
  async function request(path, { method = 'GET', body, formData, skipAuthRedirect = false, withResponse = false } = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (formData) {
      init.body = formData; // the browser sets the multipart boundary itself
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      throw new ApiError('Network error — is the server running?', 0, null);
    }

    const payload = await parse(res);
    if (res.status === 401 && !skipAuthRedirect) onUnauthorized?.();
    if (!res.ok) throw new ApiError(messageFrom(payload, res), res.status, payload);
    return withResponse ? { body: payload, headers: res.headers } : payload;
  }

  /** GET a paged list: `{ rows, total }`, total from the `X-Total-Count` header (falls back to rows.length). */
  async function getPage(path, opts) {
    const { body, headers } = await request(path, { ...opts, method: 'GET', withResponse: true });
    const rows = Array.isArray(body) ? body : [];
    const total = Number.parseInt(headers.get('x-total-count') ?? '', 10);
    return { rows, total: Number.isFinite(total) ? total : rows.length };
  }

  return {
    request,
    get: (path, opts) => request(path, { ...opts, method: 'GET' }),
    getPage,
    post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
    patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
    del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
    upload: (path, formData, opts) => request(path, { ...opts, method: 'POST', formData }),
  };
}

export default createApi;
