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
  if (body && typeof body === 'object') return body.detail || body.error || res.statusText;
  if (typeof body === 'string' && body) return body.slice(0, 200);
  return res.statusText || `HTTP ${res.status}`;
}

/**
 * @param {{onUnauthorized?: () => void}} [opts]
 */
export function createApi({ onUnauthorized } = {}) {
  async function request(path, { method = 'GET', body, formData, skipAuthRedirect = false } = {}) {
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
    return payload;
  }

  return {
    request,
    get: (path, opts) => request(path, { ...opts, method: 'GET' }),
    post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
    patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
    upload: (path, formData, opts) => request(path, { ...opts, method: 'POST', formData }),
  };
}

export default createApi;
