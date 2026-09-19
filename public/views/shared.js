// #/shared — the two-person view: matches, who is waiting on whom, disagreements, and
// featured listings neither has called yet. A verdict tap here refreshes every section.

import { $, html, setHtml } from '../lib/ui.js';
import { cardHtml } from './home.js';
import { bindVerdicts, firstName } from '../lib/verdicts.js';

const BASE = 'scope=all&status=all&removed=hide&sort=fit';
const LIMIT = 60;

function sections(otherName) {
  const other = otherName || 'the other';
  return [
    {
      key: 'match', title: 'Matches', query: 'verdict=match',
      hint: 'You both said yes.',
      empty: 'No matches yet. When you both tap Yes on a villa, it lands here.',
    },
    {
      key: 'waiting_me', title: 'Your turn', query: 'verdict=waiting_me',
      hint: `${other} has called these; you have not.`,
      empty: 'Nothing waiting on you.',
    },
    {
      key: 'waiting_other', title: `Waiting for ${other}`, query: 'verdict=waiting_other',
      hint: `You have called these; ${other} has not.`,
      empty: `${other} is all caught up.`,
    },
    {
      key: 'disagree', title: 'Disagree', query: 'verdict=disagree',
      hint: 'Different calls. Worth a conversation.',
      empty: 'You agree on everything so far.',
    },
    {
      key: 'maybe', title: 'Maybes', query: 'verdict=maybe',
      hint: 'One of you is on the fence.',
      empty: 'No maybes. Everything has a clear call.',
    },
    {
      key: 'fresh', title: 'Fresh picks', query: 'verdict=unvoted&flagged=1', limit: 12,
      hint: 'Featured listings neither of you has called yet.',
      empty: 'Every featured villa has a call.',
    },
  ];
}

export async function mountShared(el, ctx) {
  const { api, store } = ctx;
  const areas = store.get().areas || [];
  const me = store.get().user;
  const users = store.get().users || [];
  const other = users.find((u) => u.id !== me?.id);
  const secs = sections(firstName(other));
  let alive = true;

  setHtml(
    el,
    html`<div class="shared-page">
      <div class="section-head"><h1>Shared</h1></div>
      <p class="shared-intro muted">
        Tap Yes, Maybe or No on any villa. ${other ? `${firstName(other)} sees your call, you see theirs,` : 'Both of you see every call,'}
        and a double Yes is a match.
      </p>
      ${secs.map(
        (s) => html`<section class="shared-section" data-key="${s.key}">
          <div class="section-head"><h2>${s.title}</h2><span class="small muted mono" data-count></span></div>
          <p class="small muted shared-hint">${s.hint}</p>
          <div class="grid"><p class="loading">Loading…</p></div>
        </section>`
      )}
    </div>`
  );

  const viewer = () => ({ user: store.get().user, users: store.get().users || [] });

  async function loadSection(s) {
    const node = $(`.shared-section[data-key="${s.key}"]`, el);
    if (!node) return;
    try {
      const rows = await api.get(`/api/properties?${BASE}&limit=${s.limit || LIMIT}&${s.query}`);
      if (!alive) return;
      $('[data-count]', node).textContent = rows.length ? String(rows.length) : '';
      setHtml(
        $('.grid', node),
        rows.length ? rows.map((p) => cardHtml(p, areas, { viewer: viewer() })) : html`<p class="empty">${s.empty}</p>`
      );
    } catch (err) {
      if (alive) setHtml($('.grid', node), html`<p class="empty">Could not load: ${err.message}</p>`);
    }
  }

  const load = () => Promise.all(secs.map(loadSection));

  const unbind = bindVerdicts(el, {
    api,
    onSaved: () => {
      load();
      ctx.refreshCounts?.();
    },
  });

  await load();

  return () => {
    alive = false;
    unbind();
  };
}

export default mountShared;
