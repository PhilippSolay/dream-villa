// Hash router: #/, #/p/:id, #/shared, #/map, #/market, #/gone, #/agent, #/login.
// Views are `async mount(el, ctx) -> unmount()`. Home's scroll position survives a detour.

const ROUTES = [
  { path: '/', name: 'home', match: /^\/$/ },
  { path: '/p/:id', name: 'detail', match: /^\/p\/(\d+)$/, keys: ['id'] },
  { path: '/shared', name: 'shared', match: /^\/shared$/ },
  { path: '/market', name: 'market', match: /^\/market$/ },
  { path: '/map', name: 'map', match: /^\/map$/ },
  { path: '/gone', name: 'gone', match: /^\/gone$/ },
  { path: '/agent', name: 'agent', match: /^\/agent$/ },
  { path: '/login', name: 'login', match: /^\/login$/ },
];

export function parseHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { path: path || '/', query, hash: raw };
}

export function matchRoute(path) {
  for (const route of ROUTES) {
    const m = route.match.exec(path);
    if (!m) continue;
    const params = {};
    (route.keys || []).forEach((k, i) => {
      params[k] = m[i + 1];
    });
    return { name: route.name, params };
  }
  return { name: 'home', params: {} };
}

export function navigate(to, { replace = false } = {}) {
  const next = to.startsWith('#') ? to : `#${to}`;
  if (location.hash === next) return;
  if (replace) location.replace(next);
  else location.hash = next;
}

/**
 * @param {{outlet: HTMLElement, load: (name: string) => Promise<Function>, onRoute?: Function}} opts
 */
export function createRouter({ outlet, load, onRoute }) {
  let unmount = null;
  let current = null;
  let currentParams = null;
  let token = 0;
  const scrollByRoute = new Map();

  async function run() {
    const { path, query } = parseHash();
    const route = matchRoute(path);
    const mine = ++token;

    if (current === 'home') scrollByRoute.set('home', window.scrollY);

    // Same view, different query (tab switch) — let the view read it without a remount.
    // Same villa, different ?tab= → update in place. A different :id remounts.
    if (current === route.name && route.name === 'detail' && unmount?.onQuery && currentParams?.id === route.params?.id) {
      unmount.onQuery(query, route.params);
      onRoute?.(route, query);
      return;
    }

    if (unmount) {
      try {
        unmount();
      } catch (err) {
        console.error('unmount failed', err);
      }
      unmount = null;
    }

    outlet.innerHTML = '';
    outlet.setAttribute('data-view', route.name);
    current = route.name;
    currentParams = route.params || null;
    onRoute?.(route, query);

    let mount;
    try {
      mount = await load(route.name);
    } catch (err) {
      console.error('view failed to load', err);
      outlet.innerHTML = '<p class="empty">This view failed to load.</p>';
      return;
    }
    if (mine !== token) return;

    try {
      const result = await mount(outlet, { params: route.params, query, route: route.name });
      if (mine !== token) {
        result?.();
        return;
      }
      unmount = typeof result === 'function' ? result : null;
    } catch (err) {
      console.error('view failed to mount', err);
      outlet.innerHTML = '<p class="empty">Something went wrong rendering this view.</p>';
      return;
    }

    if (route.name === 'home') window.scrollTo(0, scrollByRoute.get('home') || 0);
    else window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', run);
  return { start: run, refresh: run };
}

export default createRouter;
