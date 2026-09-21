// App shell: store, api, theme, header, tab bar, router. Views live in ./views/.

import { createStore } from './lib/store.js';
import { defaultFilters } from './lib/filters.js';
import { createApi } from './lib/api.js';
import { createRouter, navigate } from './lib/router.js';
import { $, html, setHtml, icons, toast } from './lib/ui.js';

const store = createStore(
  { filters: defaultFilters(), theme: 'system', user: null, areas: [] },
  { persist: ['filters', 'theme'] }
);

const api = createApi({ onUnauthorized: () => navigate('/login', { replace: true }) });

// --- theme -----------------------------------------------------------------

function prefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

function isDark() {
  const { theme } = store.get();
  return theme === 'dark' || (theme !== 'light' && prefersDark());
}

// --- header and tab bar ----------------------------------------------------

const TABS = [
  { route: 'home', href: '#/', label: 'Home', icon: icons.home },
  { route: 'shared', href: '#/shared', label: 'Shared', icon: icons.users },
  { route: 'map', href: '#/map', label: 'Map', icon: icons.map },
  { route: 'market', href: '#/market', label: 'Market', icon: icons.chart },
  { route: 'gone', href: '#/gone', label: 'Gone', icon: icons.archive },
  { route: 'agent', href: '#/agent', label: 'Agent', icon: icons.robot },
];

function renderTabs(active) {
  for (const tab of TABS) {
    const el = $(`.tab[data-route="${tab.route}"]`);
    if (!el) continue;
    setHtml(el, html`${tab.icon()}<span>${tab.label}</span>`);
    if (tab.route === active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function renderHeader() {
  const { user } = store.get();

  const themeBtn = $('#theme-toggle');
  setHtml(themeBtn, isDark() ? icons.sun() : icons.moon());
  themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');

  const userBtn = $('#user-btn');
  userBtn.textContent = user ? (user.name || user.email).trim().charAt(0).toUpperCase() : '·';
  userBtn.setAttribute('aria-label', user ? `${user.name} — sign out` : 'Sign in');
  userBtn.hidden = !user;
}

// --- views -----------------------------------------------------------------

/** market.js and map.js are written by another agent — degrade instead of crashing. */
async function loadOptional(path, name, message) {
  try {
    const mod = await import(path);
    if (typeof mod[name] === 'function') return mod[name];
  } catch (err) {
    console.warn(`${path} is not available yet`, err);
  }
  return (el) => {
    setHtml(el, html`<p class="empty">${message}</p>`);
    return () => {};
  };
}

const VIEWS = {
  home: () => import('./views/home.js').then((m) => m.mountHome),
  shared: () => import('./views/shared.js').then((m) => m.mountShared),
  detail: () => import('./views/detail.js').then((m) => m.mountDetail),
  gone: () => import('./views/gone.js').then((m) => m.mountGone),
  login: () => import('./views/login.js').then((m) => m.mountLogin),
  agent: () => import('./views/agent.js').then((m) => m.mountAgent),
  market: () => loadOptional('./views/market.js', 'mountMarket', 'Market view not available yet'),
  map: () => loadOptional('./views/map.js', 'mountMap', 'Map view not available yet'),
};

function context(routeCtx) {
  return {
    api,
    store,
    navigate,
    areas: store.get().areas,
    ...routeCtx,
  };
}

const router = createRouter({
  outlet: $('#view'),
  onRoute: (route) => renderTabs(route.name),
  load: async (name) => {
    const mount = await VIEWS[name]();
    return async (el, routeCtx) => {
      if (!store.get().user && name !== 'login') {
        navigate('/login', { replace: true });
        return () => {};
      }
      return mount(el, context(routeCtx));
    };
  },
});

// --- wiring ----------------------------------------------------------------

store.subscribe(renderHeader);

$('#theme-toggle').addEventListener('click', () => {
  const theme = isDark() ? 'light' : 'dark';
  store.set({ theme });
  applyTheme(theme);
});

$('#user-btn').addEventListener('click', async () => {
  if (!store.get().user) return navigate('/login');
  try {
    await api.post('/api/logout');
  } catch {
    /* the cookie is cleared server-side or already gone */
  }
  store.set({ user: null });
  toast('Signed out');
  navigate('/login', { replace: true });
});

$('#backdrop').addEventListener('click', () => import('./lib/ui.js').then((m) => m.closeSheet()));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') import('./lib/ui.js').then((m) => m.closeSheet());
});
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', renderHeader);

async function boot() {
  applyTheme(store.get().theme);
  renderTabs('home');
  try {
    const me = await api.get('/api/me', { skipAuthRedirect: true });
    store.set({ user: me.user, users: me.users || [] });
    const { areas } = await api.get('/api/areas');
    store.set({ areas });
  } catch {
    store.set({ user: null });
    if (!location.hash.startsWith('#/login')) navigate('/login', { replace: true });
  }
  renderHeader();
  await router.start();
}

boot();

export { store, api };
