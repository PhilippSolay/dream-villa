// App shell: store, api, theme, header, tab bar, router. Views live in ./views/.

import { createStore } from './lib/store.js';
import { defaultFilters } from './lib/filters.js';
import { createApi } from './lib/api.js';
import { createRouter, navigate } from './lib/router.js';
import { $, html, setHtml, icons, toast } from './lib/ui.js';
import { isSolo, isOwner } from './lib/people.js';

const store = createStore(
  { filters: defaultFilters(), theme: 'system', user: null, users: [], team: null, areas: [] },
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

// `solo` and `owner` are predicates on the store's state, not fixed booleans: a friend's
// role can only be known once /api/me answers, and the nav has to redraw the moment it
// does (SPEC §17 — a solo team sees no collaboration, a member sees no owner tools).
const TABS = [
  { route: 'home', href: '#/', label: 'Home', icon: icons.home },
  { route: 'shared', href: '#/shared', label: 'Shared', icon: icons.users, hide: isSolo },
  { route: 'map', href: '#/map', label: 'Map', icon: icons.map },
  { route: 'market', href: '#/market', label: 'Market', icon: icons.chart },
  { route: 'gone', href: '#/gone', label: 'Gone', icon: icons.archive },
  { route: 'agent', href: '#/agent', label: 'Agent', icon: icons.robot, hide: (s) => !isOwner(s) },
  // The owners' mini CMS — also in the account menu, but a tab is one tap from anywhere.
  { route: 'people', href: '#/people', label: 'People', icon: icons.idcard, hide: (s) => !isOwner(s) },
];

/** Only the hidden flag, cheap enough to run on every store change (a filter tweak on
    Home fires this too, but it is a handful of attribute reads, not a re-render). */
function syncTabVisibility() {
  const state = store.get();
  for (const tab of TABS) {
    const el = $(`.tab[data-route="${tab.route}"]`);
    if (el) el.hidden = Boolean(tab.hide?.(state));
  }
}

function renderTabs(active) {
  for (const tab of TABS) {
    const el = $(`.tab[data-route="${tab.route}"]`);
    if (!el) continue;
    setHtml(el, html`${tab.icon()}<span>${tab.label}</span>`);
    if (tab.route === active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  syncTabVisibility();
}

/** Name + group line, "People" (owners only) and Sign out — filled in each time the
    popover opens, so it never goes stale between a login and the next click. */
function renderAccountMenu() {
  const state = store.get();
  const { user, team } = state;
  const menu = $('#account-menu');
  if (!user || !menu) return;
  // A solo team is named after its one person, so its name would just repeat theirs.
  const group = isSolo(state) ? 'Solo' : team?.name || '';
  setHtml(
    menu,
    html`<div class="account-menu-head">
      <strong>${user.name || user.email}</strong>
      ${group ? html`<span class="small muted">${group}</span>` : ''}
    </div>
    <div class="account-menu-sep" role="separator"></div>
    ${isOwner(state) ? html`<button type="button" role="menuitem" data-account="people">People</button>` : ''}
    <button type="button" role="menuitem" data-account="logout">Sign out</button>`
  );
}

function renderHeader() {
  const { user } = store.get();

  const themeBtn = $('#theme-toggle');
  setHtml(themeBtn, isDark() ? icons.sun() : icons.moon());
  themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');

  const userBtn = $('#user-btn');
  userBtn.textContent = user ? (user.name || user.email).trim().charAt(0).toUpperCase() : '·';
  userBtn.setAttribute('aria-label', user ? `${user.name} — account menu` : 'Sign in');
  userBtn.hidden = !user;
  syncTabVisibility();
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
  // The People page (SPEC §17) is another agent's file — degrade the same way.
  people: () => loadOptional('./views/people.js', 'mountPeople', 'People page not available yet'),
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
      const state = store.get();
      if (!state.user && name !== 'login') {
        navigate('/login', { replace: true });
        return () => {};
      }
      // SPEC §17: the Agent page and People are the owners'; Shared needs a teammate to
      // share with. A friend who lands here anyway (a stale link, a typed hash) is bounced
      // home rather than shown a page that has nothing — or the wrong things — for them.
      if (state.user && ((name === 'agent' && !isOwner(state)) || (name === 'people' && !isOwner(state)) || (name === 'shared' && isSolo(state)))) {
        navigate('/', { replace: true });
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

// The account menu: a small popover under the user button — name, group, "People" (owners
// only), Sign out. Same open/close shape as Home's sort menu: outside tap or Escape closes it.
const accountMenu = $('#account-menu');
const userBtn = $('#user-btn');

function toggleAccountMenu(open = accountMenu.hidden) {
  if (open) renderAccountMenu();
  accountMenu.hidden = !open;
  userBtn.setAttribute('aria-expanded', String(open));
}

async function signOut() {
  try {
    await api.post('/api/logout');
  } catch {
    /* the cookie is cleared server-side or already gone */
  }
  store.set({ user: null, users: [], team: null });
  toast('Signed out');
  navigate('/login', { replace: true });
}

userBtn.addEventListener('click', () => {
  if (!store.get().user) return navigate('/login');
  toggleAccountMenu();
});

accountMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-account]');
  if (!button) return;
  toggleAccountMenu(false);
  if (button.dataset.account === 'people') navigate('/people');
  else if (button.dataset.account === 'logout') signOut();
});

document.addEventListener('click', (event) => {
  if (!accountMenu.hidden && !event.target.closest('#account-wrap')) toggleAccountMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !accountMenu.hidden) {
    toggleAccountMenu(false);
    userBtn.focus();
  }
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
    store.set({ user: me.user, users: me.users || [], team: me.team || null });
    const { areas } = await api.get('/api/areas');
    store.set({ areas });
  } catch {
    store.set({ user: null, users: [], team: null });
    if (!location.hash.startsWith('#/login')) navigate('/login', { replace: true });
  }
  renderHeader();
  await router.start();
}

boot();

export { store, api };
