// #/agent — sources, runs, notes, weights, flag threshold, what the learner changed,
// inbox, scrape. SPEC §5 "Agent"; the Sources section is the intake settings
// (config.sources, see src/sources.js).

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

// Mirrors SOURCE_KINDS / KIND_LABELS in src/sources.js (no build step, so no shared module).
const KIND_ORDER = ['scraper', 'facebook_group', 'whatsapp_group', 'instagram', 'agent', 'website', 'other'];

const KIND_GROUPS = {
  scraper: 'Scrapers',
  facebook_group: 'Facebook groups',
  whatsapp_group: 'WhatsApp groups',
  instagram: 'Instagram',
  agent: 'Agents',
  website: 'Websites',
  other: 'Other',
};

const KIND_PILLS = {
  scraper: 'Scraper',
  facebook_group: 'Facebook',
  whatsapp_group: 'WhatsApp',
  instagram: 'Instagram',
  agent: 'Agent',
  website: 'Website',
  other: 'Other',
};

const MANUAL_KINDS = KIND_ORDER.filter((k) => k !== 'scraper');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "123 listings · 41 in filter · 5 flagged · last 18 Sep" / "3 URLs added · 1 pending". */
function statsLine(source) {
  const s = source.stats || {};
  const parts = [];
  if (source.kind === 'scraper' || s.listings) {
    parts.push(plural(s.listings || 0, 'listing'));
    if (s.listings) {
      parts.push(`${s.in_filter || 0} in filter`);
      parts.push(`${s.flagged || 0} flagged`);
      if (s.last_seen) parts.push(`last ${dayLabel(s.last_seen)}`);
    }
  }
  const added = (s.inbox_pending || 0) + (s.inbox_done || 0);
  if (source.kind !== 'scraper' || added) {
    parts.push(`${added} URL${added === 1 ? '' : 's'} added`);
    if (s.inbox_pending) parts.push(`${s.inbox_pending} pending`);
  }
  return parts.join(' · ');
}

function sourceRow(source) {
  const manual = source.kind !== 'scraper';
  const title = source.url
    ? html`<a href="${source.url}" target="_blank" rel="noopener">${source.name}</a>`
    : html`<span>${source.name}</span>`;
  return html`<div class="source-row" data-source="${source.id}">
    <div class="source-main">
      <div class="source-head">
        ${title}
        <span class="pill">${KIND_PILLS[source.kind] || source.kind}</span>
      </div>
      <p class="small mono muted source-stats">${statsLine(source)}</p>
      <button type="button" class="source-note${source.notes ? '' : ' is-empty'}" data-note="${source.id}"
        aria-label="Edit the note on ${source.name}">${source.notes || 'Add a note'}</button>
      ${manual
        ? html`<button type="button" class="btn btn-sm source-add-url" data-add-url="${source.id}">
            ${icons.plus()} Add URL from this source</button>`
        : ''}
    </div>
    <label class="switch" title="${source.enabled ? 'Enabled' : 'Disabled'}">
      <input type="checkbox" role="switch" data-toggle="${source.id}" ${source.enabled ? 'checked' : ''}
        aria-label="${source.name} enabled" />
      <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
    </label>
  </div>`;
}

function sourcesList(sources) {
  if (!sources.length) return html`<p class="empty">No sources yet.</p>`;
  return KIND_ORDER.filter((kind) => sources.some((s) => s.kind === kind)).map(
    (kind) => html`<div class="source-group">
      <h4 class="source-group-head">${KIND_GROUPS[kind]}</h4>
      ${sources.filter((s) => s.kind === kind).map(sourceRow)}
    </div>`
  );
}

function sourceOptions(sources) {
  const manual = sources.filter((s) => s.kind !== 'scraper' && s.enabled !== false);
  return html`<option value="">No source</option>
    ${manual.map((s) => html`<option value="${s.id}">${s.name}</option>`)}`;
}

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

// `[src:<id>] …` is how an inbox row remembers the channel it came from (src/sources.js).
const SRC_PREFIX = /^\[src:([A-Za-z0-9][A-Za-z0-9._-]*)\]\s*/;

function inboxList(rows, sources) {
  if (!rows.length) return html`<p class="empty">Nothing pending.</p>`;
  return rows.map((i) => {
    const match = SRC_PREFIX.exec(i.note || '');
    const from = match ? sources.find((s) => s.id === match[1]) : null;
    const note = match ? (i.note || '').replace(SRC_PREFIX, '') : i.note;
    return html`<div class="entry">
      <div class="entry-head"><span>${i.by || 'someone'}</span><span>${dayLabel(i.created_at)}</span>
        <span class="pill">${i.status}</span>
        ${match ? html`<span class="pill">${from ? from.name : match[1]}</span>` : ''}</div>
      <a class="small" href="${i.url}" target="_blank" rel="noopener">${i.url}</a>
      ${note ? html`<p class="small muted">${note}</p>` : ''}
    </div>`;
  });
}

export async function mountAgent(el, ctx) {
  const { api } = ctx;
  let alive = true;

  setHtml(el, html`<p class="loading">Loading the agent desk…</p>`);

  let runs = [];
  let notes = [];
  let config = {};
  let inbox = [];
  let sources = [];
  let contacts = [];
  try {
    [runs, notes, config, inbox, sources, contacts] = await Promise.all([
      api.get('/api/runs?limit=14'),
      api.get('/api/notes?limit=14'),
      api.get('/api/config'),
      api.get('/api/inbox?status=pending'),
      api.get('/api/sources').then((r) => r.sources || []),
      api.get('/api/contacts').catch(() => []),
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
        <h3>Sources</h3>
        <span class="small muted">Where listings come in</span>
      </div>
      <div id="sources-list">${sourcesList(sources)}</div>

      <details class="source-add">
        <summary>Add a source</summary>
        <form id="form-source">
          <label class="field"><span class="label">Kind</span>
            <select name="kind" required>
              ${MANUAL_KINDS.map((k) => html`<option value="${k}">${KIND_PILLS[k]}</option>`)}
            </select></label>
          <label class="field"><span class="label">Name</span>
            <input type="text" name="name" maxlength="120" placeholder="Bali Rentals Canggu" required /></label>
          <label class="field"><span class="label">Link (optional)</span>
            <input type="url" name="url" maxlength="500" placeholder="https://…" /></label>
          <label class="field"><span class="label">Notes (optional)</span>
            <input type="text" name="notes" maxlength="2000" placeholder="Abigaïl checks it on Sundays" /></label>
          <label class="field"><span class="label">Contact (optional)</span>
            <select name="contact_id">
              <option value="">No contact</option>
              ${contacts.map((c) => html`<option value="${c.id}">${c.name || c.agency || c.whatsapp || `#${c.id}`}</option>`)}
            </select></label>
          <button class="btn btn-primary" type="submit">Add source</button>
        </form>
      </details>
    </section>

    <section class="block" style="margin-top:14px">
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

    <section class="block" style="margin-top:14px" id="inbox-block">
      <h3>Inbox</h3>
      <form id="form-inbox">
        <div class="inbox-row">
          <input type="url" name="url" placeholder="https://…" required />
          <button class="btn btn-sm" type="submit">${icons.plus()} Add</button>
        </div>
        <label class="field" style="margin:8px 0 0"><span class="label">From which source</span>
          <select name="source_id" id="inbox-source">${sourceOptions(sources)}</select></label>
      </form>
      <div id="inbox-list" style="margin-top:10px">${inboxList(inbox, sources)}</div>
    </section>`
  );

  // --- sources -------------------------------------------------------------

  async function reloadSources() {
    const res = await api.get('/api/sources');
    if (!alive) return;
    sources = res.sources || [];
    setHtml($('#sources-list', el), sourcesList(sources));
    const select = $('#inbox-source', el);
    const keep = select.value;
    setHtml(select, sourceOptions(sources));
    if ([...select.options].some((o) => o.value === keep)) select.value = keep;
  }

  el.addEventListener('change', async (event) => {
    const input = event.target.closest('input[data-toggle]');
    if (!input) return;
    const id = input.dataset.toggle;
    const enabled = input.checked;
    input.disabled = true;
    try {
      await api.patch(`/api/sources/${encodeURIComponent(id)}`, { enabled });
      toast(enabled ? `${id} enabled` : `${id} disabled — the daily run will skip it`);
      await reloadSources();
    } catch (err) {
      input.checked = !enabled;
      toast(err.message, 'error');
    }
    input.disabled = false;
  });

  // Notes: tap the line, type, Enter or blur saves (Escape cancels).
  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-note]');
    if (!button) return;
    const id = button.dataset.note;
    const source = sources.find((s) => s.id === id);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'source-note-input';
    input.maxLength = 2000;
    input.value = source?.notes || '';
    input.setAttribute('aria-label', `Note on ${source?.name || id}`);
    button.replaceWith(input);
    input.focus();

    let settled = false;
    const save = async () => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (next === (source?.notes || '')) return reloadSources();
      try {
        await api.patch(`/api/sources/${encodeURIComponent(id)}`, { notes: next || null });
        toast('Note saved');
      } catch (err) {
        toast(err.message, 'error');
      }
      await reloadSources();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        settled = true;
        reloadSources();
      }
    });
    input.addEventListener('blur', save);
  });

  // "Add URL from this source" — preselect the channel, then jump to the inbox box.
  el.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-add-url]');
    if (!button) return;
    const select = $('#inbox-source', el);
    select.value = button.dataset.addUrl;
    const url = $('#form-inbox input[name=url]', el);
    $('#inbox-block', el).scrollIntoView({ behavior: 'smooth', block: 'start' });
    url.focus();
  });

  $('#form-source', el).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    const body = {
      kind: form.elements.kind.value,
      name: form.elements.name.value.trim(),
      url: form.elements.url.value.trim() || null,
      notes: form.elements.notes.value.trim() || null,
      contact_id: form.elements.contact_id.value ? Number(form.elements.contact_id.value) : null,
    };
    try {
      await api.post('/api/sources', body);
      form.reset();
      form.closest('details').open = false;
      toast(`${body.name} added`);
      await reloadSources();
    } catch (err) {
      toast(err.message, 'error');
    }
    button.disabled = false;
  });

  // --- weights -------------------------------------------------------------

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

  // --- inbox ---------------------------------------------------------------

  $('#form-inbox', el).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const url = form.elements.url.value.trim();
    if (!url) return;
    const sourceId = form.elements.source_id.value || null;
    try {
      await api.post('/api/inbox', { url, source_id: sourceId });
      form.elements.url.value = '';
      toast('URL queued for the scraper');
      const pending = await api.get('/api/inbox?status=pending');
      if (!alive) return;
      setHtml($('#inbox-list', el), inboxList(pending, sources));
      await reloadSources();
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
