// App shell: store, api, theme, header, tab bar, router. Views live in ./views/.

import { createStore } from './lib/store.js';
import { defaultFilters } from './lib/filters.js';
import { createApi } from './lib/api.js';
import { createRouter, navigate } from './lib/router.js';
import { $, html, setHtml, icons, toast, todayMakassar, makassarDate } from './lib/ui.js';

const store = createStore(
  { filters: defaultFilters(), theme: 'system', user: null, counts: null, areas: [] },
  { persist: ['filters', 'theme'] }
);

/** How deep we look for "new today" before showing "200+" in the header chip. */
const NEW_TODAY_LIMIT = 200;

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
  { route: 'map', href: '#/map', label: 'Map', icon: icons.map },
  { route: 'market', href: '#/market', label: 'Market', icon: icons.chart },
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
  const { user, counts } = store.get();
  const chip = $('#counts');
  if (counts) {
    setHtml(
      chip,
      html`<span class="stat"><b>${counts.flagged}</b><span>flagged</span></span>
        <span class="stat"><b>${counts.new_today}</b><span>new today</span></span>
        <span class="stat count-wide"><b>${counts.shortlist}</b><span>shortlist</span></span>`
    );
  } else {
    chip.textContent = '';
  }

  const themeBtn = $('#theme-toggle');
  setHtml(themeBtn, isDark() ? icons.sun() : icons.moon());
  themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');

  const userBtn = $('#user-btn');
  userBtn.textContent = user ? (user.name || user.email).trim().charAt(0).toUpperCase() : '·';
  userBtn.setAttribute('aria-label', user ? `${user.name} — sign out` : 'Sign in');
  userBtn.hidden = !user;
}

async function refreshCounts() {
  if (!store.get().user) return;
  try {
    const [market, recent] = await Promise.all([
      api.get('/api/market'),
      api.get(`/api/properties?scope=all&status=all&hide_gone=0&sort=new&limit=${NEW_TODAY_LIMIT}`),
    ]);
    const today = todayMakassar();
    const newToday = recent.filter((r) => makassarDate(r.first_seen) === today).length;
    store.set({
      counts: {
        flagged: market.counts.flagged,
        shortlist: market.counts.shortlist,
        in_filter: market.counts.in_filter,
        market: market.counts.market,
        // A full count would mean pulling every row; cap it and say so instead of lying.
        new_today: newToday === NEW_TODAY_LIMIT ? `${NEW_TODAY_LIMIT}+` : newToday,
      },
    });
  } catch {
    /* the chip is decoration; a failure must never break a view */
  }
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
  detail: () => import('./views/detail.js').then((m) => m.mountDetail),
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
    refreshCounts,
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
  store.set({ user: null, counts: null });
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
    store.set({ user: me.user });
    const { areas } = await api.get('/api/areas');
    store.set({ areas });
    refreshCounts();
  } catch {
    store.set({ user: null });
    if (!location.hash.startsWith('#/login')) navigate('/login', { replace: true });
  }
  renderHeader();
  await router.start();
}

boot();

export { store, api };
