// Shared search: each person's one-tap call on a listing (yes / maybe / no). Pure
// renderers plus one click binder that Home, Shared and Detail all reuse.

import { html, toast } from './ui.js';

export const VERDICTS = [
  ['yes', 'Yes'],
  ['maybe', 'Maybe'],
  ['no', 'No'],
];
export const VERDICT_LABELS = Object.fromEntries(VERDICTS);

/** The list filters GET /api/properties understands, with the other person's first name filled in. */
export function verdictFilterOptions(otherName) {
  const other = otherName || 'the other';
  return [
    ['match', 'Match'],
    ['waiting_me', 'My turn'],
    ['waiting_other', `Waiting for ${other}`],
    ['disagree', 'Disagree'],
    // Either of you said it — the trio reads together, so it stays in yes-maybe-no order.
    ['yes', 'Yes'],
    ['maybe', 'Maybe'],
    ['no', 'No'],
    // Everything neither of you ruled out, including what nobody has called yet.
    ['not_no', 'Exclude No'],
  ];
}

export function verdictOf(p, userId) {
  return (p.verdicts || []).find((v) => v.by === userId)?.verdict || null;
}

/** Both said yes. */
export function isMatch(p) {
  return (p.verdicts || []).filter((v) => v.verdict === 'yes').length >= 2;
}

export function initialOf(name) {
  return String(name || '?').trim().charAt(0).toUpperCase();
}

export function firstName(user) {
  return String(user?.name || '').trim().split(/\s+/)[0] || '';
}

/** Both people as small discs coloured by their call, plus "Match" when both said yes.
    A solo team (`users` holds only the viewer) shows just their own capsule and never a
    Match pill — a match takes two. */
export function verdictPairHtml(p, { user, users = [] } = {}) {
  const people = users.length ? users : user ? [user] : [];
  return html`<span class="verdict-pair" aria-label="Calls">
    ${people.map((u) => {
      const v = verdictOf(p, u.id);
      const label = v ? VERDICT_LABELS[v] : 'no call yet';
      return html`<span class="who who-${v || 'none'}" title="${u.name}: ${label}" aria-label="${u.name}: ${label}">${initialOf(u.name)}</span>`;
    })}
    ${people.length > 1 && isMatch(p) ? html`<span class="pill pill-match">Match</span>` : ''}
  </span>`;
}

/** The caller's own control: three pills, the current one pressed; tap it again to clear. */
export function verdictControlHtml(p, userId, { compact = false } = {}) {
  const mine = verdictOf(p, userId);
  return html`<span class="verdict-seg${compact ? ' verdict-seg-compact' : ''}" role="group" aria-label="Your call">
    ${VERDICTS.map(
      ([v, label]) => html`<button type="button" class="vbtn vbtn-${v}" data-verdict="${v}" data-id="${p.id}"
        aria-pressed="${String(mine === v)}">${label}</button>`
    )}
  </span>`;
}

/**
 * Delegated click handler for every `[data-verdict]` button under `root`. Posts the new
 * call (null when the pressed one is tapped again) and hands the fresh row to `onSaved`.
 * Returns the unbind function.
 */
export function bindVerdicts(root, { api, onSaved }) {
  async function onClick(event) {
    const button = event.target.closest('button[data-verdict]');
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    const id = Number(button.dataset.id);
    const next = button.getAttribute('aria-pressed') === 'true' ? null : button.dataset.verdict;
    const group = button.closest('.verdict-seg');
    group?.classList.add('is-busy');
    try {
      const row = await api.post(`/api/properties/${id}/verdict`, { verdict: next });
      onSaved?.(row, button);
    } catch (err) {
      toast(err.message || 'Could not save your call', 'error');
    } finally {
      group?.classList.remove('is-busy');
    }
  }
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
