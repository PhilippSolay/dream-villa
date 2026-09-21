// #/gone — the archive. Every villa that left the market, kept so the two of them can
// see what they missed: how fast it went, whether either of them ever called it, and
// what this market does to a good listing. SPEC §16.
//
// Rows are never deleted (CLAUDE.md), so this view is a read of what is already there:
// GET /api/properties?removed=only, which leaves out rows folded away by dedupe — those
// are bookkeeping, not a villa that got away.

import { $, $$, html, setHtml, REMOVAL_LABELS, agoLabel } from '../lib/ui.js';
import { cardHtml } from './home.js';
import { bindVerdicts } from '../lib/verdicts.js';

const PAGE_SIZE = 60;

/** How far back the archive reaches: [value, button label, how the summary says it]. */
const WINDOWS = [
  ['30', '30 days', 'in the last 30 days'],
  ['90', '90 days', 'in the last 90 days'],
  ['365', 'A year', 'in the last year'],
  ['', 'All', 'on record'],
];
const spanOf = (value) => WINDOWS.find(([v]) => v === value)?.[2] || 'on record';

/** What to look at. `pick` runs over the fetched window, client-side. */
const LENSES = [
  { value: 'all', label: 'All', hint: 'Everything that left the market.' },
  {
    value: 'uncalled',
    label: 'Never called',
    hint: 'Neither of you said yes, maybe or no before it went — the ones that slipped past.',
    pick: (p) => !(p.verdicts || []).length,
  },
  {
    value: 'liked',
    label: 'We liked it',
    hint: 'One of you had said yes or maybe. These are the ones that actually got away.',
    pick: (p) => (p.verdicts || []).some((v) => v.verdict === 'yes' || v.verdict === 'maybe'),
  },
  {
    value: 'fast',
    label: 'Went fast',
    hint: 'Off the market inside a week. What this pocket does to a listing worth having.',
    pick: (p) => p.days_live != null && p.days_live <= 7,
  },
];

const lensOf = (value) => LENSES.find((l) => l.value === value) || LENSES[0];

/** Median of the days-live figures we have, or null when nothing is dated. */
export function medianDaysLive(rows) {
  const days = rows.map((r) => r.days_live).filter((d) => d != null).sort((a, b) => a - b);
  if (!days.length) return null;
  const mid = Math.floor(days.length / 2);
  return days.length % 2 ? days[mid] : Math.round((days[mid - 1] + days[mid]) / 2);
}

/** The line under the title: how many, how fast they go, when the last one went. */
function summaryHtml(rows, windowDays) {
  if (!rows.length) return '';
  const median = medianDaysLive(rows);
  const newest = rows.map((r) => r.removed_at).filter(Boolean).sort().at(-1);
  const bits = [`${rows.length} ${rows.length === 1 ? 'villa' : 'villas'} ${spanOf(windowDays)}`];
  if (median != null) bits.push(`typically live ${median} ${median === 1 ? 'day' : 'days'}`);
  if (newest) bits.push(`last one ${agoLabel(newest)}`);
  return html`<p class="gone-summary mono">${bits.join(' · ')}</p>`;
}

/** A count per reason, so "why do these go" is answerable at a glance. */
function reasonsHtml(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.removed_reason || 'delisted', (counts.get(r.removed_reason || 'delisted') || 0) + 1);
  const order = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (order.length < 2) return '';
  return html`<div class="gone-reasons">
    ${order.map(([reason, n]) => html`<span class="chip">${REMOVAL_LABELS[reason] || reason}<b class="mono">${n}</b></span>`)}
  </div>`;
}

export async function mountGone(el, ctx) {
  const { api, store } = ctx;
  const areas = store.get().areas || [];
  let alive = true;
  let windowDays = '30';
  let lens = 'all';
  let rows = []; // everything fetched for the current window
  let shown = PAGE_SIZE;

  setHtml(
    el,
    html`<div class="gone-page">
      <div class="section-head"><h1>Gone</h1></div>
      <p class="gone-intro muted">
        Villas that left the market. Nothing is ever deleted — a listing that 404s, drops off an
        agency site, or that an agent says is taken lands here, so you can see what you missed.
      </p>
      <div class="toolbar gone-toolbar">
        <div class="seg seg-tap" id="gone-window" role="group" aria-label="How far back">
          ${WINDOWS.map(([value, label]) => html`<button type="button" value="${value}" aria-pressed="false">${label}</button>`)}
        </div>
        <div class="seg seg-tap" id="gone-lens" role="group" aria-label="What to look at">
          ${LENSES.map((l) => html`<button type="button" value="${l.value}" aria-pressed="false">${l.label}</button>`)}
        </div>
      </div>
      <p class="small muted gone-hint" id="gone-hint"></p>
      <div id="gone-head"></div>
      <div class="grid" id="gone-grid"><p class="loading">Loading…</p></div>
      <div class="load-more" id="gone-more" hidden>
        <button type="button" class="btn" id="gone-more-btn">Load more</button>
      </div>
    </div>`
  );

  const grid = $('#gone-grid', el);
  const head = $('#gone-head', el);
  const more = $('#gone-more', el);
  const viewer = () => ({ user: store.get().user, users: store.get().users || [] });

  function pressed(container, value) {
    for (const btn of $$('button', container)) btn.setAttribute('aria-pressed', String(btn.value === value));
  }

  function render() {
    const l = lensOf(lens);
    $('#gone-hint', el).textContent = l.hint;
    const picked = l.pick ? rows.filter(l.pick) : rows;

    setHtml(head, html`${summaryHtml(picked, windowDays)}${reasonsHtml(picked)}`);

    if (!picked.length) {
      setHtml(
        grid,
        html`<p class="empty">
          ${rows.length
            ? 'Nothing here under this lens. Try another one.'
            : 'Nothing has gone in this window. When a listing disappears from a site it lands here instead of vanishing.'}
        </p>`
      );
      more.hidden = true;
      return;
    }

    setHtml(grid, picked.slice(0, shown).map((p) => cardHtml(p, areas, { removal: true, viewer: viewer() })));
    more.hidden = picked.length <= shown;
  }

  async function load() {
    shown = PAGE_SIZE;
    setHtml(grid, html`<p class="loading">Loading…</p>`);
    setHtml(head, '');
    const params = new URLSearchParams({ scope: 'all', status: 'all', removed: 'only', sort: 'removed', limit: '500' });
    if (windowDays) params.set('removed_days', windowDays);
    try {
      const fetched = await api.get(`/api/properties?${params}`);
      if (!alive) return;
      rows = fetched;
      render();
    } catch (err) {
      if (alive) setHtml(grid, html`<p class="empty">Could not load the archive: ${err.message}</p>`);
    }
  }

  const onWindow = (event) => {
    const btn = event.target.closest('button[value]');
    if (!btn) return;
    windowDays = btn.value;
    pressed($('#gone-window', el), windowDays);
    load();
  };

  const onLens = (event) => {
    const btn = event.target.closest('button[value]');
    if (!btn) return;
    lens = btn.value;
    shown = PAGE_SIZE;
    pressed($('#gone-lens', el), lens);
    render();
  };

  const onMore = () => {
    shown += PAGE_SIZE;
    render();
  };

  $('#gone-window', el).addEventListener('click', onWindow);
  $('#gone-lens', el).addEventListener('click', onLens);
  $('#gone-more-btn', el).addEventListener('click', onMore);
  pressed($('#gone-window', el), windowDays);
  pressed($('#gone-lens', el), lens);

  // A call can still be made on a gone listing — "we should have moved on this one" is
  // worth recording, and it teaches the weights like any other verdict.
  const unbind = bindVerdicts(el, {
    api,
    onSaved: (row) => {
      const i = rows.findIndex((r) => r.id === row.id);
      if (i !== -1) rows[i] = { ...rows[i], ...row };
      render();
      ctx.refreshCounts?.();
    },
  });

  await load();

  return () => {
    alive = false;
    unbind();
  };
}

export default mountGone;
