// A tiny reactive store: get / set (shallow merge) / subscribe. No framework, no batching.
// `persist` keys are mirrored into localStorage so filters and theme survive a reload.

const KEY = 'villa.state.v1';

function readPersisted(keys) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out = {};
    for (const k of keys) if (saved[k] !== undefined) out[k] = saved[k];
    return out;
  } catch {
    return {};
  }
}

function writePersisted(state, keys) {
  try {
    const out = {};
    for (const k of keys) out[k] = state[k];
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* private mode, quota, disabled storage — persistence is a convenience, never required */
  }
}

/**
 * @param {object} initial
 * @param {{persist?: string[]}} [opts]
 */
export function createStore(initial, { persist = [] } = {}) {
  let state = { ...initial, ...readPersisted(persist) };
  const subscribers = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next) return state;
    state = { ...state, ...next };
    if (persist.some((k) => k in next)) writePersisted(state, persist);
    for (const fn of [...subscribers]) {
      try {
        fn(state);
      } catch (err) {
        console.error('store subscriber failed', err);
      }
    }
    return state;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { get, set, subscribe };
}

export default createStore;
