// #/p/:id — five tabs (SPEC §5 "Detail"). The active tab lives in the hash query (?tab=).

import {
  $, $$, html, setHtml, icons, toast, priceLabel, beachLabel, statusPill, fitRing, copyText,
  STATUS_LABELS, redFlagLabel, makassarDate,
} from '../lib/ui.js';
import { TEMPLATES, fill } from '../lib/templates.js';
import { PANELS, RATING_FEATURES, VIEWING_SCALES, INCLUDED_KEYS } from './detail-panels.js';

const TABS = [
  ['listing', 'Listing'],
  ['contact', 'Contact'],
  ['agent', 'From the agent'],
  ['viewing', 'Viewing'],
  ['ratings', 'Ratings'],
];

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export async function mountDetail(el, ctx) {
  const { api, store } = ctx;
  const id = Number(ctx.params.id);
  const areas = store.get().areas || [];
  let tab = PANELS[ctx.query.tab] ? ctx.query.tab : 'listing';
  let p = null;
  let alive = true;

  setHtml(el, html`<p class="loading">Loading…</p>`);

  function header() {
    const areaLabel = areas.find((a) => a.id === p.area)?.label || p.area;
    return html`<div class="detail-head">
      <a class="btn btn-sm btn-ghost" href="#/" style="justify-self:start">${icons.back()} Back</a>
      <h1 class="detail-title">${p.title}</h1>
      <div class="detail-facts">
        <span class="detail-price mono">${priceLabel(p)}</span>
        <span class="muted">${areaLabel}${p.sub_area ? ` · ${p.sub_area}` : ''}</span>
        ${p.beach_km != null ? html`<span class="mono muted">${beachLabel(p.beach_km)}</span>` : ''}
        ${p.bedrooms != null ? html`<span class="mono muted">${p.bedrooms} BR${p.extra_rooms ? ` +${p.extra_rooms}` : ''}</span>` : ''}
        ${statusPill(p.status)}
        ${p.flagged ? html`<span class="pill pill-flagged">Flagged</span>` : ''}
        ${(p.red_flags || []).map((f) => html`<span class="pill pill-flag">${redFlagLabel(f)}</span>`)}
        ${fitRing(p.fit_score, 44)}
      </div>
    </div>`;
  }

  function gallery() {
    const urls = p.image_urls || [];
    if (!urls.length) return html`<div class="card-media" style="border-radius:var(--radius)"><span class="placeholder">No photos</span></div>`;
    return html`<div>
      <div class="gallery" id="gallery" tabindex="0" aria-label="Photos of ${p.title}">
        ${urls.map((u) => html`<img src="${u}" alt="" loading="lazy" decoding="async" />`)}
      </div>
      <div class="gallery-count" id="gallery-count">1 / ${urls.length}</div>
    </div>`;
  }

  function render() {
    setHtml(
      el,
      html`<div class="detail-layout">
        <div class="detail-left">${header()}${gallery()}</div>
        <div class="detail-right">
          <div class="tabs" role="tablist">
            ${TABS.map(
              ([key, label]) => html`<button type="button" class="tab-btn" role="tab" data-tab="${key}"
                aria-selected="${String(tab === key)}">${label}</button>`
            )}
          </div>
          <div id="tab-panel">${PANELS[tab](p, areas)}</div>
        </div>
      </div>`
    );

    const strip = $('#gallery', el);
    if (strip) {
      strip.addEventListener('scroll', () => {
        // A re-render replaces the counter; the old strip may still fire one last scroll.
        const counter = $('#gallery-count', el);
        if (!counter || !strip.isConnected) return;
        const total = p.image_urls.length;
        const index = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth)) + 1;
        counter.textContent = `${Math.min(index, total)} / ${total}`;
      });
    }
  }

  async function load() {
    try {
      p = await api.get(`/api/properties/${id}`);
      if (!alive) return;
      render();
    } catch (err) {
      setHtml(el, html`<p class="empty">Could not load this listing: ${err.message}</p>`);
    }
  }

  /** Every write re-reads the row: assessed, flags and the fit score can all move. */
  async function afterWrite(message) {
    toast(message);
    await load();
    ctx.refreshCounts?.();
  }

  function fieldValue(form, name) {
    const v = form.elements[name]?.value?.trim();
    return v ? v : null;
  }

  async function onActionClick(event) {
    const button = event.target.closest('button, a[data-tab]');
    if (!button) return;
    const { action, tab: nextTab, feature, status, flag, key } = button.dataset;

    if (nextTab) {
      tab = nextTab;
      location.hash = `#/p/${id}?tab=${nextTab}`;
      render();
      return;
    }
    if (button.dataset.scale || button.parentElement?.dataset.role) return; // handled by the form logic

    try {
      if (action === 'rate') {
        await api.post(`/api/properties/${id}/ratings`, { feature, score: Number(button.value) });
        const label = RATING_FEATURES.find(([key]) => key === feature)?.[1] || feature;
        await afterWrite(`${label} rated ${button.value} by ${store.get().user?.name}`);
      } else if (action === 'status') {
        await api.post(`/api/properties/${id}/status`, { status });
        await afterWrite(`Status: ${STATUS_LABELS[status]} (${store.get().user?.name})`);
      } else if (action === 'flag') {
        const current = p.red_flags || [];
        const next = current.includes(flag) ? current.filter((f) => f !== flag) : [...current, flag];
        await api.patch(`/api/properties/${id}`, { red_flags: next });
        await afterWrite(current.includes(flag) ? 'Red flag removed' : 'Red flag added');
      } else if (action === 'stars') {
        await api.patch(`/api/contacts/${button.dataset.contact}`, { responsiveness: Number(button.value) });
        await afterWrite('Responsiveness saved');
      } else if (action === 'copy') {
        const template = TEMPLATES.find((t) => t.key === key);
        const ok = await copyText(fill(template.body, p));
        toast(ok ? `Template ${key} copied` : 'Could not copy — select the text instead', ok ? 'ok' : 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Segmented controls and 1–5 scales inside the forms
  function onToggleClick(event) {
    const button = event.target.closest('button[data-scale], .seg[data-role] button');
    if (!button) return;
    event.preventDefault();
    const group = button.dataset.scale
      ? $$(`button[data-scale="${button.dataset.scale}"]`, el)
      : $$('button', button.parentElement);
    const wasOn = button.getAttribute('aria-pressed') === 'true';
    for (const b of group) b.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', String(!(wasOn && button.dataset.scale)));
    if (button.dataset.scale) {
      const row = button.closest('.scale-row');
      const readout = row?.querySelector('.label .mono');
      if (readout) readout.textContent = wasOn ? '—' : button.value;
    }
  }

  async function onSubmit(event) {
    const form = event.target;
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    if (button) button.disabled = true;

    try {
      if (form.id === 'form-contact') {
        await api.post(`/api/properties/${id}/contacts`, {
          name: fieldValue(form, 'name'),
          role: fieldValue(form, 'role'),
          phone: fieldValue(form, 'phone'),
          whatsapp: fieldValue(form, 'whatsapp'),
          agency: fieldValue(form, 'agency'),
          notes: fieldValue(form, 'notes'),
        });
        await afterWrite('Contact saved');
      } else if (form.id === 'form-agent') {
        const included = { other: fieldValue(form, 'included_other') };
        for (const [k] of INCLUDED_KEYS) included[k] = form.elements[`included_${k}`].checked;
        await api.post(`/api/properties/${id}/agent-info`, {
          date: fieldValue(form, 'date'),
          included,
          neighbours: fieldValue(form, 'neighbours'),
          planned_builds: fieldValue(form, 'planned_builds'),
          water_power: fieldValue(form, 'water_power'),
          lease_terms: fieldValue(form, 'lease_terms'),
          deposit: fieldValue(form, 'deposit'),
          payment_schedule: fieldValue(form, 'payment_schedule'),
          other: fieldValue(form, 'other'),
        });
        await afterWrite('Saved what the agent said');
      } else if (form.id === 'form-viewing') {
        const data = new FormData();
        data.set('date', fieldValue(form, 'date') || makassarDate(new Date().toISOString()));
        const timeButton = $('.seg[data-role="time_of_day"] button[aria-pressed="true"]', form);
        if (timeButton) data.set('time_of_day', timeButton.value);
        for (const [k] of VIEWING_SCALES) {
          const on = $(`button[data-scale="v_${k}"][aria-pressed="true"]`, form);
          if (on) data.set(k, on.value);
        }
        const minutes = fieldValue(form, 'beach_minutes');
        if (minutes) data.set('beach_minutes', minutes);
        const notes = fieldValue(form, 'notes');
        if (notes) data.set('notes', notes);
        const verdict = $('.seg[data-role="verdict"] button[aria-pressed="true"]', form);
        if (verdict) data.set('verdict', verdict.value);
        for (const file of form.elements.photos.files) data.append('photos', file, file.name);
        await api.upload(`/api/properties/${id}/viewings`, data);
        await afterWrite('Visit saved');
      } else if (form.id === 'form-feedback') {
        await api.post(`/api/properties/${id}/feedback`, { text: form.elements.text.value.trim() });
        await afterWrite('Feedback saved');
      } else if (form.id === 'form-flag') {
        const value = fieldValue(form, 'flag');
        if (!value) return;
        const slug = `custom:${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
        await api.patch(`/api/properties/${id}`, { red_flags: [...new Set([...(p.red_flags || []), slug])] });
        await afterWrite('Red flag added');
      } else if (form.id === 'form-facts') {
        const beach = fieldValue(form, 'beach_km');
        await api.patch(`/api/properties/${id}`, {
          living_open: form.elements.living_open.checked ? 1 : 0,
          airy: form.elements.airy.checked ? 1 : 0,
          workspace: form.elements.workspace.checked ? 1 : 0,
          extra_rooms: Number(form.elements.extra_rooms.value || 0),
          style: fieldValue(form, 'style'),
          beach_km: beach == null ? null : Number(beach),
          notes: fieldValue(form, 'notes'),
        });
        await afterWrite('Facts saved');
      }
    } catch (err) {
      toast(err.message, 'error');
      if (button) button.disabled = false;
    }
  }

  // #view outlives this view, so every listener it gets must come off again.
  el.addEventListener('click', onActionClick);
  el.addEventListener('click', onToggleClick);
  el.addEventListener('submit', onSubmit);

  await load();

  const unmount = () => {
    alive = false;
    el.removeEventListener('click', onActionClick);
    el.removeEventListener('click', onToggleClick);
    el.removeEventListener('submit', onSubmit);
  };
  unmount.onQuery = (query) => {
    const next = PANELS[query.tab] ? query.tab : 'listing';
    if (next !== tab) {
      tab = next;
      render();
    }
  };
  return unmount;
}

export default mountDetail;
