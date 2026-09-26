// DOM, icon and formatting helpers. No emoji anywhere: icons are inline SVG (CLAUDE.md).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Mark a string as already-safe HTML. */
export function raw(value) {
  return { __raw: String(value ?? '') };
}

function part(value) {
  if (value == null || value === false || value === true) return '';
  if (Array.isArray(value)) return value.map(part).join('');
  if (typeof value === 'object' && '__raw' in value) return value.__raw;
  return esc(value);
}

/** Tagged template that escapes every interpolation unless it came from raw()/html(). */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s + (i < values.length ? part(values[i]) : '');
  });
  return raw(out);
}

export function toHtml(value) {
  return part(value);
}

export function setHtml(el, value) {
  el.innerHTML = part(value);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function on(root, type, selector, handler) {
  const listener = (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}

export function debounce(fn, ms = 250) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

// ---------------------------------------------------------------------------
// Icons — simple 20×20 line drawings, currentColor
// ---------------------------------------------------------------------------

const svg = (body, size = 20) =>
  raw(
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" ` +
      `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );

export const icons = {
  pin: () => svg('<path d="M10 17.5s5.5-5 5.5-9a5.5 5.5 0 0 0-11 0c0 4 5.5 9 5.5 9Z"/><circle cx="10" cy="8.4" r="2.1"/>'),
  phone: () => svg('<path d="M5 3.4h3l1.3 3.3-1.7 1.2a9.4 9.4 0 0 0 4.5 4.5l1.2-1.7 3.3 1.3v3a1.4 1.4 0 0 1-1.5 1.4C9.1 16 4 10.9 3.6 4.9A1.4 1.4 0 0 1 5 3.4Z"/>'),
  whatsapp: () => svg('<path d="M3.2 16.8 4.4 13.2A6.9 6.9 0 1 1 7 15.7l-3.8 1.1Z"/><path d="M7.7 7.6c.3 1.6 1.7 3 3.3 3.3l.7-1 1.5.7v1a.9.9 0 0 1-1 .9 6.6 6.6 0 0 1-5.1-5.1.9.9 0 0 1 .9-1h1l.6 1.5-.9.7"/>'),
  copy: () => svg('<rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13"/>'),
  filter: () => svg('<path d="M3 6h14M6 10h8M8.5 14h3"/>'),
  sort: () => svg('<path d="M6 4v12M6 16l-2.5-2.5M6 16l2.5-2.5M14 16V4M14 4l-2.5 2.5M14 4l2.5 2.5"/>'),
  sun: () => svg('<circle cx="10" cy="10" r="3.4"/><path d="M10 2.6v1.6M10 15.8v1.6M17.4 10h-1.6M4.2 10H2.6M15.2 4.8l-1.1 1.1M5.9 14.1l-1.1 1.1M15.2 15.2l-1.1-1.1M5.9 5.9 4.8 4.8"/>'),
  moon: () => svg('<path d="M16 11.7A6.4 6.4 0 0 1 8.3 4a6.6 6.6 0 1 0 7.7 7.7Z"/>'),
  external: () => svg('<path d="M11 4h5v5"/><path d="M16 4 9 11"/><path d="M14.5 12v3.5A1.5 1.5 0 0 1 13 17H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 6h3.5"/>'),
  back: () => svg('<path d="M12 4 6 10l6 6"/>'),
  forward: () => svg('<path d="m8 4 6 6-6 6"/>'),
  chevron: () => svg('<path d="m5 8 5 5 5-5"/>'),
  close: () => svg('<path d="M5 5l10 10M15 5 5 15"/>'),
  plus: () => svg('<path d="M10 4.5v11M4.5 10h11"/>'),
  check: () => svg('<path d="M4.5 10.5 8 14l7.5-8"/>'),
  flag: () => svg('<path d="M5 17V4.5h9l-1.8 3 1.8 3H5"/>'),
  home: () => svg('<path d="M3.5 9 10 3.8 16.5 9v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z"/>'),
  users: () => svg('<circle cx="7.5" cy="7" r="2.8"/><path d="M2.5 16.5c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6"/><circle cx="14" cy="8" r="2.3"/><path d="M13.4 12.3c2.2.3 3.7 1.8 4.2 4.2"/>'),
  map: () => svg('<path d="M3.5 5.6 7.5 4l5 1.8 4-1.6v10.2l-4 1.6-5-1.8-4 1.6Z"/><path d="M7.5 4v12.2M12.5 5.8V18"/>'),
  chart: () => svg('<path d="M3.5 16.5h13"/><path d="M6 13.5V9M10 13.5V5M14 13.5v-5"/>'),
  robot: () => svg('<rect x="4" y="7" width="12" height="8" rx="2.4"/><path d="M10 4v3"/><circle cx="7.8" cy="11" r=".9"/><circle cx="12.2" cy="11" r=".9"/>'),
  // An ID card: the People page, where the owners manage who has an account.
  idcard: () => svg('<rect x="2.8" y="4.5" width="14.4" height="11" rx="2"/><circle cx="7.4" cy="8.9" r="1.7"/><path d="M4.9 13.2c.4-1.3 1.3-2 2.5-2s2.1.7 2.5 2"/><path d="M11.8 8.6h3M11.8 11.4h3"/>'),
  archive: () => svg('<rect x="3.2" y="3.8" width="13.6" height="3.4" rx="1.1"/><path d="M4.6 7.2v7.9a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4V7.2"/><path d="M8.2 10.3h3.6"/>'),
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 44_000_000 → "44"; 38_500_000 → "38.5" (SPEC §5 price format). */
export function priceM(idr) {
  if (idr == null || Number.isNaN(Number(idr))) return null;
  const m = Math.round((Number(idr) / 1e6) * 10) / 10;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}

export function priceLabel(p) {
  const m = priceM(p?.price_month_idr);
  if (m == null) return 'Price on request';
  return p.term === 'yearly' ? `${m} M / mo · yearly` : `${m} M / mo`;
}

/**
 * A downloaded listing photo's card-sized cut: `/images/12/1.jpg` → `/thumbs/12/1.webp`
 * (720 px WebP, cut on first ask by src/thumbs.js). Cards, map pins and duplicate rows
 * show photos a few hundred pixels wide; the 1100–1600 px original is the gallery's.
 * A remote src_url or a viewing photo (`v3-1.jpg`) comes back unchanged.
 */
export function thumbUrl(url) {
  const m = /^\/images\/(\d+)\/(\d+)\.jpg$/.exec(url || '');
  return m ? `/thumbs/${m[1]}/${m[2]}.webp` : url;
}

/**
 * Where a photo that failed to load goes next: a cut falls back to the original it was
 * cut from (`/thumbs/12/1.webp` → `/images/12/1.jpg`); anything else has nowhere to go.
 * Takes a path or an absolute URL, since `img.src` is always absolute.
 */
export function photoFallback(src) {
  let pathname = src || '';
  try {
    pathname = new URL(pathname, 'http://x').pathname;
  } catch {
    return null;
  }
  const m = /^\/thumbs\/(\d+)\/(\d+)\.webp$/.exec(pathname);
  return m ? `/images/${m[1]}/${m[2]}.jpg` : null;
}

export function beachLabel(km) {
  if (km == null) return null;
  const n = Number(km);
  return n < 10 ? `${Math.round(n * 10) / 10} km` : `${Math.round(n)} km`;
}

export const STATUS_LABELS = {
  new: 'New',
  shortlist: 'Shortlist',
  contacted: 'Contacted',
  viewing_booked: 'Booked',
  viewed: 'Viewed',
  offer: 'Offer',
  rejected: 'Rejected',
  gone: 'Gone',
};

/** Why a listing left the market (SPEC §16 `removed_reason`), in plain words. */
export const REMOVAL_LABELS = {
  delisted: 'Page taken down',
  archived: 'Marked unavailable',
  unlisted: 'Dropped off the site',
  taken: 'Agent said taken',
  merged: 'Merged duplicate',
};

export const FEATURE_LABELS = {
  pool: 'Pool',
  garden: 'Garden',
  view: 'View',
  joglo: 'Joglo',
  aircon: 'Aircon',
  kitchen_full: 'Full kitchen',
  workspace: 'Workspace',
  airy: 'Airy / light',
  living_open: 'Open living',
};

export const STYLE_LABELS = {
  modern: 'Modern',
  tropical: 'Tropical',
  joglo: 'Joglo',
  balinese_old: 'Old Balinese',
  industrial: 'Industrial',
  bamboo: 'Bamboo',
};

export const RED_FLAG_LABELS = {
  construction: 'Construction',
  main_road: 'Main road',
  balinese_old: 'Old Balinese',
  over_budget: 'Over budget',
  quiet_low: 'Noisy',
  privacy_low: 'No privacy',
};

export function redFlagLabel(flag) {
  if (RED_FLAG_LABELS[flag]) return RED_FLAG_LABELS[flag];
  return String(flag).replace(/^custom:/, '').replace(/[_-]/g, ' ');
}

/** How long a listing wears its New badge. After a day it is simply a listing. */
const NEW_FOR_MS = 86_400_000;

/**
 * The stage pill. Pass `firstSeen` and the New badge expires with it: a listing is only
 * new for its first day, after which the card's age line ("3d") says all there is to say.
 */
export function statusPill(status, firstSeen = null) {
  if (status === 'new' && firstSeen) {
    const ms = Date.now() - new Date(firstSeen).getTime();
    if (Number.isFinite(ms) && ms >= NEW_FOR_MS) return '';
  }
  return html`<span class="pill pill-${raw(esc(status))}">${STATUS_LABELS[status] || status}</span>`;
}

/** Gold ring whose arc is the fit score (SPEC §5). */
export function fitRing(score, size = 40) {
  const value = score == null ? 0 : Math.max(0, Math.min(100, Number(score)));
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const dash = (value / 100) * c;
  const label = score == null ? '—' : Math.round(value);
  return html`<span class="ring" role="img" aria-label="Fit score ${label} of 100">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"></circle>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--gold)" stroke-width="3"
        stroke-linecap="round" stroke-dasharray="${dash} ${c - dash}"
        transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
    </svg>
    <span class="ring-value mono">${label}</span>
  </span>`;
}

// --- dates, in Asia/Makassar (the villas' clock) ---------------------------

const TZ = 'Asia/Makassar';

export function makassarDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

export function makassarTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
}

export function todayMakassar() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function dayLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d);
}

/** An elapsed span in the card's shorthand: "today", "3d ago", "5w ago", "4mo ago". */
export function agoLabel(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.max(1, Math.round(days / 7))}w ago`;
  return `${Math.max(1, Math.round(days / 30))}mo ago`;
}

export function durationLabel(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------------------
// Toasts, bottom sheet, clipboard
// ---------------------------------------------------------------------------

export function toast(message, kind = 'ok') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 300);
  }, 3200);
}

let sheetCloser = null;

export function closeSheet() {
  const sheet = document.getElementById('sheet');
  const backdrop = document.getElementById('backdrop');
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  backdrop.hidden = true;
  document.body.classList.remove('has-sheet');
  const restore = sheetCloser;
  sheetCloser = null;
  restore?.();
}

/** Opens the bottom sheet around `node` (which keeps its identity — state survives). */
export function openSheet(title, node, { onClose } = {}) {
  const sheet = document.getElementById('sheet');
  const backdrop = document.getElementById('backdrop');
  if (!sheet) return;
  setHtml(
    sheet,
    html`<div class="sheet-head">
      <h2 class="sheet-title">${title}</h2>
      <button type="button" class="icon-btn" data-sheet-close aria-label="Close">${icons.close()}</button>
    </div>
    <div class="sheet-body"></div>`
  );
  sheet.querySelector('.sheet-body').appendChild(node);
  sheet.hidden = false;
  backdrop.hidden = false;
  document.body.classList.add('has-sheet');
  sheetCloser = onClose || null;
  const close = sheet.querySelector('[data-sheet-close]');
  close?.addEventListener('click', closeSheet, { once: true });
  close?.focus();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
