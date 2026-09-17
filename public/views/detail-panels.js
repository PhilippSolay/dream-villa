// The five detail tab panels (SPEC §5). detail.js owns the state and the writes;
// these functions only turn a property row into markup.

import {
  html, raw, icons, priceLabel, statusPill, redFlagLabel, dayLabel, makassarDate,
  STATUS_LABELS,
} from '../lib/ui.js';
import { TEMPLATES, fill } from '../lib/templates.js';

export const RATING_FEATURES = [
  ['quiet', 'Quiet'],
  ['privacy', 'Privacy'],
  ['living_room', 'Living room'],
  ['light', 'Light'],
  ['beach', 'Beach'],
  ['overall', 'Overall'],
];

export const VIEWING_SCALES = [
  ['quiet', 'Quiet'],
  ['privacy', 'Privacy'],
  ['living_room', 'Living room'],
  ['light', 'Light'],
  ['breeze', 'Breeze'],
  ['overlooked', 'Overlooked'],
  ['construction_nearby', 'Construction nearby'],
];

const TIMES_OF_DAY = ['morning', 'midday', 'afternoon', 'evening'];
const VERDICTS = [['no', 'No'], ['maybe', 'Maybe'], ['yes', 'Yes']];
export const INCLUDED_KEYS = [
  ['electricity', 'Electricity'],
  ['pool', 'Pool'],
  ['garden', 'Garden'],
  ['staff', 'Staff'],
  ['wifi', 'Wifi'],
  ['water', 'Water'],
];
const FIXED_RED_FLAGS = ['construction', 'main_road', 'balinese_old', 'over_budget', 'quiet_low', 'privacy_low'];
const STYLES = ['modern', 'tropical', 'joglo', 'balinese_old', 'industrial', 'bamboo'];

const dash = (v) => (v == null || v === '' ? '—' : v);

function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function digits(value) {
  return String(value || '').replace(/\D+/g, '');
}

/** Inline price sparkline; a single point renders as a dot with its price. */
function sparkline(history) {
  const points = (history || []).filter((p) => p && p.price_month_idr != null);
  if (!points.length) return html`<p class="small muted">No price history yet.</p>`;
  const w = 220;
  const h = 46;
  const values = points.map((p) => p.price_month_idr);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => (points.length === 1 ? w / 2 : (i / (points.length - 1)) * (w - 8) + 4);
  const y = (v) => h - 6 - ((v - min) / span) * (h - 14);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.price_month_idr).toFixed(1)}`).join(' ');
  const m = (v) => `${Math.round((v / 1e6) * 10) / 10} M`;
  return html`<div>
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
      aria-label="Price history from ${m(values[0])} to ${m(values[values.length - 1])}">
      <path d="${d}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      ${points.map((p, i) => raw(`<circle cx="${x(i).toFixed(1)}" cy="${y(p.price_month_idr).toFixed(1)}" r="2.5" fill="var(--gold)"></circle>`))}
    </svg>
    <div class="small muted mono">${points[0].date} ${m(min)} · ${points[points.length - 1].date} ${m(max)}</div>
  </div>`;
}

function scaleRow(name, label, value) {
  return html`<div class="scale-row">
    <span class="label"><span>${label}</span><span class="mono">${value ?? '—'}</span></span>
    <div class="scale" role="group" aria-label="${label}, 1 to 5">
      ${[1, 2, 3, 4, 5].map(
        (n) => html`<button type="button" data-scale="${name}" value="${n}" aria-pressed="${String(value === n)}">${n}</button>`
      )}
    </div>
  </div>`;
}

function bars(viewing) {
  return html`<div class="bars">
    ${VIEWING_SCALES.filter(([k]) => viewing[k] != null).map(
      ([k, label]) => html`<span class="bar"><span>${label}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(viewing[k] / 5) * 100}%"></span></span>
        <span class="mono">${viewing[k]}</span></span>`
    )}
  </div>`;
}

// ---------------------------------------------------------------------------
// Tab panels
// ---------------------------------------------------------------------------

function listingPanel(p, areas) {
  const areaLabel = areas.find((a) => a.id === p.area)?.label || p.area;
  const inclusions = p.inclusions && typeof p.inclusions === 'object' ? Object.entries(p.inclusions) : [];
  const facts = [
    ['Bedrooms', p.bedrooms == null ? null : `${p.bedrooms}${p.extra_rooms ? ` +${p.extra_rooms}` : ''}`],
    ['Bathrooms', p.bathrooms],
    ['Land', p.land_m2 ? `${p.land_m2} m²` : null],
    ['Build', p.build_m2 ? `${p.build_m2} m²` : null],
    ['Term', p.term],
    ['Minimum months', p.min_months],
    ['Available from', p.available_from || p.availability],
    ['First seen', makassarDate(p.first_seen)],
    ['Last seen', makassarDate(p.last_seen)],
    ['Source / ref', `${p.source}${p.ref ? ` · ${p.ref}` : ''}`],
    ['Pin source', p.pin_source],
    ['Beach', p.beach_name ? `${p.beach_name} (${p.beach_source || 'unknown'})` : p.beach_source],
    ['Area', areaLabel],
  ];

  return html`<div class="panel">
    ${p.description
      ? html`<section class="block"><h3>Description</h3>${paragraphs(p.description).map((t) => html`<p>${t}</p>`)}</section>`
      : ''}

    ${inclusions.length || p.terms
      ? html`<section class="block">
          <h3>Inclusions and terms</h3>
          ${inclusions.length ? html`<dl class="kv">${inclusions.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : ''}
          ${p.terms ? html`<p class="small muted" style="margin-top:8px">${p.terms}</p>` : ''}
        </section>`
      : ''}

    <section class="block">
      <h3>Location</h3>
      <div class="links">
        ${p.map_url ? html`<a href="${p.map_url}" target="_blank" rel="noopener">${icons.pin()} Open in Google Maps</a>` : ''}
        ${p.lat != null && p.lng != null
          ? html`<a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">
              ${icons.external()} Directions</a>`
          : ''}
      </div>
      <p class="small muted mono" style="margin-top:6px">
        ${p.lat != null ? `${p.lat}, ${p.lng}` : 'No pin yet'} ${p.address ? `· ${p.address}` : ''}
      </p>
    </section>

    <section class="block">
      <h3>Source</h3>
      <div class="links">
        <a href="${p.url}" target="_blank" rel="noopener">${icons.external()} ${p.url}</a>
        ${(p.alt_urls || []).map((u) => html`<a href="${u}" target="_blank" rel="noopener">${icons.external()} ${u}</a>`)}
      </div>
    </section>

    <section class="block">
      <h3>Scraper facts</h3>
      <dl class="kv">${facts.map(([k, v]) => html`<dt>${k}</dt><dd class="mono">${dash(v)}</dd>`)}</dl>
    </section>

    <section class="block"><h3>Price history</h3>${sparkline(p.price_history)}</section>
  </div>`;
}

function contactPanel(p) {
  const template = TEMPLATES.find((t) => t.key === 'A');
  const message = encodeURIComponent(fill(template.body, p));
  return html`<div class="panel">
    <section class="block">
      <h3>Contacts</h3>
      ${p.contacts.length
        ? p.contacts.map(
            (c) => html`<div class="entry">
              <div class="entry-head">
                <strong style="color:var(--ink)">${c.name || c.agency || c.whatsapp || 'Unnamed contact'}</strong>
                ${c.role ? html`<span class="pill">${c.role}</span>` : ''}
                ${c.agency ? html`<span>${c.agency}</span>` : ''}
              </div>
              <div class="links">
                ${c.phone ? html`<a href="tel:${digits(c.phone)}">${icons.phone()} ${c.phone}</a>` : ''}
                ${c.whatsapp
                  ? html`<a href="https://wa.me/${digits(c.whatsapp)}?text=${raw(message)}" target="_blank" rel="noopener">
                      ${icons.whatsapp()} WhatsApp ${c.whatsapp}</a>`
                  : ''}
                ${c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : ''}
              </div>
              <div class="entry-head" style="margin-top:6px">
                <span>Responsiveness</span>
                <span class="stars" data-contact="${c.id}" role="group" aria-label="Responsiveness for ${c.name || 'contact'}">
                  ${[1, 2, 3, 4, 5].map(
                    (n) => html`<button type="button" data-action="stars" data-contact="${c.id}" value="${n}"
                      data-on="${(c.responsiveness || 0) >= n ? 1 : 0}" aria-label="${n} of 5">★</button>`
                  )}
                </span>
              </div>
              ${c.notes ? html`<p class="small muted">${c.notes}</p>` : ''}
            </div>`
          )
        : html`<p class="empty">No contact yet — add the agent or owner below.</p>`}
    </section>

    <section class="block">
      <h3>Add contact</h3>
      <form id="form-contact">
        <label class="field"><span class="label">Name</span><input type="text" name="name" /></label>
        <label class="field"><span class="label">Role</span>
          <select name="role"><option value="">—</option><option value="owner">Owner</option>
            <option value="agent">Agent</option><option value="agency">Agency</option></select></label>
        <label class="field"><span class="label">Phone</span><input type="text" name="phone" inputmode="tel" /></label>
        <label class="field"><span class="label">WhatsApp</span><input type="text" name="whatsapp" inputmode="tel" /></label>
        <label class="field"><span class="label">Agency</span><input type="text" name="agency" /></label>
        <label class="field"><span class="label">Notes</span><textarea name="notes"></textarea></label>
        <button class="btn btn-primary" type="submit">Save contact</button>
      </form>
    </section>
  </div>`;
}

function agentPanel(p) {
  return html`<div class="panel">
    <section class="block">
      <h3>What the agent said</h3>
      ${p.agent_info.length
        ? p.agent_info.map(
            (a) => html`<div class="entry">
              <div class="entry-head"><strong style="color:var(--ink)">${dayLabel(a.date)}</strong><span>${a.by_name || 'someone'}</span></div>
              <dl class="kv">
                ${a.included && typeof a.included === 'object'
                  ? html`<dt>Included</dt><dd>${INCLUDED_KEYS.filter(([k]) => a.included[k]).map(([, l]) => l).join(', ') || '—'}
                      ${a.included.other ? html`<span class="muted"> · ${a.included.other}</span>` : ''}</dd>`
                  : ''}
                ${a.neighbours ? html`<dt>Neighbours</dt><dd>${a.neighbours}</dd>` : ''}
                ${a.planned_builds ? html`<dt>Planned builds</dt><dd>${a.planned_builds}</dd>` : ''}
                ${a.water_power ? html`<dt>Water / power</dt><dd>${a.water_power}</dd>` : ''}
                ${a.lease_terms ? html`<dt>Lease terms</dt><dd>${a.lease_terms}</dd>` : ''}
                ${a.deposit ? html`<dt>Deposit</dt><dd>${a.deposit}</dd>` : ''}
                ${a.payment_schedule ? html`<dt>Payment</dt><dd>${a.payment_schedule}</dd>` : ''}
                ${a.other ? html`<dt>Other</dt><dd>${a.other}</dd>` : ''}
              </dl>
            </div>`
          )
        : html`<p class="empty">Nothing from the agent yet.</p>`}
    </section>

    <section class="block">
      <h3>Add what you were told</h3>
      <form id="form-agent">
        <label class="field"><span class="label">Date</span><input type="date" name="date" value="${makassarDate(new Date().toISOString())}" /></label>
        <div class="field">
          <span class="label">Included in the rent</span>
          <div class="filter-cols">
            ${INCLUDED_KEYS.map(
              ([k, label]) => html`<label class="check"><input type="checkbox" name="included_${k}" /><span>${label}</span></label>`
            )}
          </div>
          <input type="text" name="included_other" placeholder="Anything else included" />
        </div>
        <label class="field"><span class="label">Neighbours</span><textarea name="neighbours"></textarea></label>
        <label class="field"><span class="label">Planned builds next door</span><textarea name="planned_builds"></textarea></label>
        <label class="field"><span class="label">Water and power</span><textarea name="water_power"></textarea></label>
        <label class="field"><span class="label">Lease terms and minimum months</span><textarea name="lease_terms"></textarea></label>
        <label class="field"><span class="label">Deposit</span><input type="text" name="deposit" /></label>
        <label class="field"><span class="label">Payment schedule</span><input type="text" name="payment_schedule" /></label>
        <label class="field"><span class="label">Other</span><textarea name="other"></textarea></label>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
    </section>
  </div>`;
}

function viewingPanel(p) {
  return html`<div class="panel">
    <section class="block">
      <h3>Visits</h3>
      ${p.viewings.length
        ? p.viewings.map(
            (v) => html`<div class="entry">
              <div class="entry-head">
                <strong style="color:var(--ink)">${dayLabel(v.date)}</strong>
                ${v.time_of_day ? html`<span>${v.time_of_day}</span>` : ''}
                <span>${v.by_name || 'someone'}</span>
                ${v.verdict ? html`<span class="pill pill-${v.verdict === 'yes' ? 'shortlist' : v.verdict === 'no' ? 'rejected' : 'contacted'}">${v.verdict}</span>` : ''}
                ${v.beach_minutes != null ? html`<span class="mono">${v.beach_minutes} min to beach</span>` : ''}
              </div>
              ${bars(v)}
              ${v.notes ? html`<p class="small">${v.notes}</p>` : ''}
              ${v.photo_urls?.length
                ? html`<div class="photo-row">${v.photo_urls.map((u) => html`<img src="${u}" alt="" loading="lazy" />`)}</div>`
                : ''}
            </div>`
          )
        : html`<p class="empty">No visit recorded yet.</p>`}
    </section>

    <section class="block">
      <h3>Add visit</h3>
      <form id="form-viewing">
        <label class="field"><span class="label">Date</span><input type="date" name="date" value="${makassarDate(new Date().toISOString())}" /></label>
        <div class="field">
          <span class="label">Time of day</span>
          <div class="seg" data-role="time_of_day" role="group" aria-label="Time of day">
            ${TIMES_OF_DAY.map((t, i) => html`<button type="button" value="${t}" aria-pressed="${String(i === 0)}">${t}</button>`)}
          </div>
        </div>
        ${VIEWING_SCALES.map(([k, label]) => scaleRow(`v_${k}`, label, null))}
        <label class="field"><span class="label">Minutes to the beach</span>
          <input type="number" name="beach_minutes" min="0" max="120" inputmode="numeric" /></label>
        <label class="field"><span class="label">Notes</span><textarea name="notes"></textarea></label>
        <label class="field"><span class="label">Photos</span>
          <input type="file" name="photos" accept="image/*" capture="environment" multiple /></label>
        <div class="field">
          <span class="label">Verdict</span>
          <div class="seg" data-role="verdict" role="group" aria-label="Verdict">
            ${VERDICTS.map(([v, label]) => html`<button type="button" value="${v}" aria-pressed="false">${label}</button>`)}
          </div>
        </div>
        <button class="btn btn-primary" type="submit">Save visit</button>
      </form>
    </section>
  </div>`;
}

function ratingsPanel(p) {
  const latest = new Map();
  for (const r of [...p.ratings].reverse()) latest.set(r.feature, r);

  return html`<div class="panel">
    <section class="block">
      <h3>Ratings before the visit</h3>
      ${RATING_FEATURES.map(([key, label]) => {
        const r = latest.get(key);
        return html`<div class="scale-row">
          <span class="label"><span>${label}</span>
            <span class="small muted">${r ? `${r.score} · ${r.by_name || 'someone'}` : 'not rated'}</span></span>
          <div class="scale" role="group" aria-label="${label}, 1 to 5">
            ${[1, 2, 3, 4, 5].map(
              (n) => html`<button type="button" data-action="rate" data-feature="${key}" value="${n}"
                aria-pressed="${String(r?.score === n)}">${n}</button>`
            )}
          </div>
        </div>`;
      })}
    </section>

    <section class="block">
      <h3>Status</h3>
      <div class="pipeline">
        ${Object.keys(STATUS_LABELS).map(
          (s) => html`<button type="button" class="chip" data-action="status" data-status="${s}"
            aria-pressed="${String(p.status === s)}">${STATUS_LABELS[s]}</button>`
        )}
      </div>
      <p class="small muted" style="margin-top:8px">
        ${p.status_at ? `Set ${dayLabel(p.status_at)}` : 'Never changed'} · assessed: ${p.assessed}
      </p>
    </section>

    <section class="block">
      <h3>Red flags</h3>
      <div class="chips">
        ${FIXED_RED_FLAGS.map(
          (f) => html`<button type="button" class="chip" data-action="flag" data-flag="${f}"
            aria-pressed="${String((p.red_flags || []).includes(f))}">${redFlagLabel(f)}</button>`
        )}
        ${(p.red_flags || []).filter((f) => !FIXED_RED_FLAGS.includes(f)).map(
          (f) => html`<button type="button" class="chip" data-action="flag" data-flag="${f}" aria-pressed="true">${redFlagLabel(f)}</button>`
        )}
      </div>
      <form id="form-flag" style="margin-top:10px;display:flex;gap:8px">
        <input type="text" name="flag" placeholder="Add your own flag" />
        <button class="btn btn-sm" type="submit">Add</button>
      </form>
    </section>

    <section class="block">
      <h3>What we know</h3>
      <form id="form-facts">
        <div class="filter-cols">
          <label class="check"><input type="checkbox" name="living_open" ${p.living_open === 1 ? raw('checked') : ''} /><span>Open living</span></label>
          <label class="check"><input type="checkbox" name="airy" ${p.airy === 1 ? raw('checked') : ''} /><span>Airy / light</span></label>
          <label class="check"><input type="checkbox" name="workspace" ${p.workspace === 1 ? raw('checked') : ''} /><span>Workspace</span></label>
        </div>
        <label class="field"><span class="label">Extra rooms</span>
          <input type="number" name="extra_rooms" min="0" max="20" value="${p.extra_rooms ?? 0}" /></label>
        <label class="field"><span class="label">Style</span>
          <select name="style"><option value="">—</option>
            ${STYLES.map((s) => html`<option value="${s}" ${p.style === s ? raw('selected') : ''}>${s.replace('_', ' ')}</option>`)}
          </select></label>
        <label class="field"><span class="label">Beach distance (km)</span>
          <input type="number" name="beach_km" min="0" max="50" step="0.1" value="${p.beach_km ?? ''}" /></label>
        <label class="field"><span class="label">Notes</span><textarea name="notes">${p.notes || ''}</textarea></label>
        <button class="btn btn-primary" type="submit">Save facts</button>
      </form>
    </section>

    <section class="block">
      <h3>Feedback</h3>
      <form id="form-feedback">
        <label class="field"><span class="label">What do you think?</span><textarea name="text" required></textarea></label>
        <button class="btn btn-primary" type="submit">Add feedback</button>
      </form>
      ${p.feedback.map(
        (f) => html`<div class="entry">
          <div class="entry-head"><span>${f.by_name || 'someone'}</span><span>${dayLabel(f.created_at)}</span>
            ${f.applied ? html`<span class="pill pill-shortlist">applied</span>` : ''}</div>
          <p class="small">${f.text}</p>
          ${f.applied_note ? html`<p class="small muted">${f.applied_note}</p>` : ''}
        </div>`
      )}
    </section>

    <section class="block">
      <h3>Message templates</h3>
      ${TEMPLATES.map(
        (t) => html`<div class="template">
          <div class="template-head">
            <strong>${t.key} · ${t.title}</strong>
            <button type="button" class="btn btn-sm" data-action="copy" data-key="${t.key}">${icons.copy()} Copy</button>
          </div>
          <pre>${fill(t.body, p)}</pre>
        </div>`
      )}
    </section>
  </div>`;
}


export const PANELS = {
  listing: listingPanel,
  contact: contactPanel,
  agent: agentPanel,
  viewing: viewingPanel,
  ratings: ratingsPanel,
};
