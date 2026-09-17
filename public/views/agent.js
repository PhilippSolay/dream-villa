// #/agent — runs, notes, weights, flag threshold, what the learner changed, inbox, scrape.
// SPEC §5 "Agent".

import {
  $, $$, html, setHtml, icons, toast, makassarDate, makassarTime, dayLabel, durationLabel,
} from '../lib/ui.js';

const WEIGHT_LABELS = {
  living_open: 'Open living room',
  airy: 'Airy / light',
  pool: 'Pool',
  garden: 'Garden',
  view: 'View',
  beach: 'Beach distance',
  kitchen_full: 'Full kitchen',
  aircon: 'Aircon',
  furniture: 'Furniture',
  workspace: 'Workspace / shala',
  joglo: 'Joglo',
};

function runsTable(runs) {
  if (!runs.length) return html`<p class="empty">No runs yet.</p>`;
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr><th>Kind</th><th>Started</th><th>Took</th><th class="mono">seen</th><th class="mono">new</th>
          <th class="mono">upd</th><th class="mono">gone</th><th class="mono">flag</th><th class="mono">err</th></tr>
      </thead>
      <tbody>
        ${runs.map(
          (r) => html`<tr>
            <td>${r.kind}</td>
            <td class="mono">${makassarDate(r.started_at)} ${makassarTime(r.started_at)}</td>
            <td class="mono">${r.finished_at ? durationLabel(r.started_at, r.finished_at) : 'running'}</td>
            <td class="mono">${r.seen ?? '—'}</td><td class="mono">${r.new ?? '—'}</td>
            <td class="mono">${r.updated ?? '—'}</td><td class="mono">${r.gone ?? '—'}</td>
            <td class="mono">${r.flagged ?? '—'}</td>
            <td class="mono">${Array.isArray(r.errors) ? r.errors.length : r.errors ? 1 : 0}</td>
          </tr>`
        )}
      </tbody>
    </table>
  </div>`;
}

function changesList(runs) {
  const changes = runs
    .filter((r) => r.kind === 'learn' && Array.isArray(r.weight_changes) && r.weight_changes.length)
    .flatMap((r) => r.weight_changes.map((c) => ({ ...c, at: r.started_at })));
  if (!changes.length) return html`<p class="empty">The weights have not been changed yet.</p>`;
  return changes.map(
    (c) => html`<div class="entry">
      <div class="entry-head"><strong style="color:var(--ink)">${WEIGHT_LABELS[c.feature] || c.feature}</strong>
        <span class="mono">${c.from} → ${c.to}</span><span>${dayLabel(c.at)}</span></div>
      <p class="small muted">${c.because || 'no reason recorded'}</p>
    </div>`
  );
}

export async function mountAgent(el, ctx) {
  const { api } = ctx;
  let alive = true;

  setHtml(el, html`<p class="loading">Loading the agent desk…</p>`);

  let runs = [];
  let notes = [];
  let config = {};
  let inbox = [];
  try {
    [runs, notes, config, inbox] = await Promise.all([
      api.get('/api/runs?limit=14'),
      api.get('/api/notes?limit=14'),
      api.get('/api/config'),
      api.get('/api/inbox?status=pending'),
    ]);
  } catch (err) {
    setHtml(el, html`<p class="empty">Could not load the agent page: ${err.message}</p>`);
    return () => {};
  }
  if (!alive) return () => {};

  const weights = config.weights || {};

  setHtml(
    el,
    html`<h1>Agent</h1>

    <section class="block" style="margin-top:12px">
      <div class="section-head" style="margin:0 0 8px">
        <h3>Scraper</h3>
        <button type="button" class="btn btn-sm" id="run-scrape">Run scrape now</button>
      </div>
      ${runsTable(runs)}
    </section>

    <section class="block" style="margin-top:14px">
      <h3>Notes from the morning session</h3>
      ${notes.length
        ? notes.map(
            (n) => html`<div class="entry">
              <div class="entry-head"><strong style="color:var(--ink)">${dayLabel(n.date)}</strong></div>
              <p class="small">${n.text}</p>
            </div>`
          )
        : html`<p class="empty">No notes yet.</p>`}
    </section>

    <section class="block" style="margin-top:14px">
      <h3>Weights</h3>
      <form id="form-weights" class="weights">
        ${Object.keys(WEIGHT_LABELS)
          .filter((k) => k in weights)
          .map(
            (key) => html`<div class="weight-row">
              <span class="label"><span>${WEIGHT_LABELS[key]}</span><span class="mono" data-readout="${key}">${weights[key]}</span></span>
              <input type="range" name="${key}" min="0" max="20" step="1" value="${weights[key]}"
                aria-label="${WEIGHT_LABELS[key]} weight" />
            </div>`
          )}
        <label class="field" style="margin-top:8px"><span class="label">Flag threshold (0–100)</span>
          <input type="number" name="flag_threshold" min="0" max="100" value="${config.flag_threshold ?? 65}" /></label>
        <button class="btn btn-primary" type="submit">Save weights</button>
        <p class="small muted" id="rescored"></p>
      </form>
    </section>

    <section class="block" style="margin-top:14px">
      <h3>What changed and why</h3>
      ${changesList(runs)}
    </section>

    <section class="block" style="margin-top:14px">
      <h3>Inbox</h3>
      <form id="form-inbox" style="display:flex;gap:8px;margin-bottom:10px">
        <input type="url" name="url" placeholder="https://…" required />
        <button class="btn btn-sm" type="submit">${icons.plus()} Add</button>
      </form>
      <div id="inbox-list">
        ${inbox.length
          ? inbox.map(
              (i) => html`<div class="entry">
                <div class="entry-head"><span>${i.by || 'someone'}</span><span>${dayLabel(i.created_at)}</span>
                  <span class="pill">${i.status}</span></div>
                <a class="small" href="${i.url}" target="_blank" rel="noopener">${i.url}</a>
                ${i.note ? html`<p class="small muted">${i.note}</p>` : ''}
              </div>`
            )
          : html`<p class="empty">Nothing pending.</p>`}
      </div>
    </section>`
  );

  // Live readouts while dragging a weight slider.
  $('#form-weights', el).addEventListener('input', (event) => {
    const readout = $(`[data-readout="${event.target.name}"]`, el);
    if (readout) readout.textContent = event.target.value;
  });

  $('#form-weights', el).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    const next = {};
    for (const input of $$('input[type=range]', form)) next[input.name] = Number(input.value);
    try {
      const res = await api.patch('/api/config', {
        weights: next,
        flag_threshold: Number(form.elements.flag_threshold.value),
      });
      $('#rescored', el).textContent =
        `Rescored ${res.rescored.total}: ${res.rescored.in_filter} in filter, ${res.rescored.flagged} flagged.`;
      toast('Weights saved and everything rescored');
      ctx.refreshCounts?.();
    } catch (err) {
      toast(err.message, 'error');
    }
    button.disabled = false;
  });

  $('#form-inbox', el).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const url = form.elements.url.value.trim();
    if (!url) return;
    try {
      await api.post('/api/inbox', { url });
      form.reset();
      toast('URL queued for the scraper');
      const pending = await api.get('/api/inbox?status=pending');
      if (!alive) return;
      setHtml(
        $('#inbox-list', el),
        pending.map(
          (i) => html`<div class="entry">
            <div class="entry-head"><span>${i.by || 'someone'}</span><span>${dayLabel(i.created_at)}</span>
              <span class="pill">${i.status}</span></div>
            <a class="small" href="${i.url}" target="_blank" rel="noopener">${i.url}</a>
          </div>`
        )
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#run-scrape', el).addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api.post('/api/scrape', {});
      toast('Scrape started — it runs in the background');
    } catch (err) {
      toast(err.status === 409 ? 'A scrape is already running' : err.message, 'error');
    }
    setTimeout(() => {
      button.disabled = false;
    }, 4000);
  });

  return () => {
    alive = false;
  };
}

export default mountAgent;
