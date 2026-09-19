// #/p/:id — five tabs (SPEC §5 "Detail"). The active tab lives in the hash query (?tab=).

import {
  $, $$, html, raw, setHtml, icons, toast, priceLabel, beachLabel, statusPill, fitRing, copyText,
  STATUS_LABELS, redFlagLabel, makassarDate,
} from '../lib/ui.js';
import { TEMPLATES, fill } from '../lib/templates.js';
import { PANELS, RATING_FEATURES, VIEWING_SCALES, INCLUDED_KEYS } from './detail-panels.js';
import { renderPriceBand } from './market.js';
import { filtersToQuery } from '../lib/filters.js';
import { verdictPairHtml, verdictControlHtml, bindVerdicts, initialOf, verdictOf } from '../lib/verdicts.js';
import { STAGES, isStage, loadStageIds, nextStage } from '../lib/flow.js';
import { valueBadgesHtml } from '../lib/value.js';

// Prev/next pager: property rows fetched ahead of need, keyed by id. Module-scoped so
// it survives the remount that happens when navigating from one listing to the next
// (SPEC §5 "Detail").
const PAGER_CACHE = new Map();
const PAGER_CACHE_MAX = 5;

function cachePut(pid, row) {
  PAGER_CACHE.delete(pid);
  PAGER_CACHE.set(pid, row);
  while (PAGER_CACHE.size > PAGER_CACHE_MAX) {
    const oldest = PAGER_CACHE.keys().next().value;
    PAGER_CACHE.delete(oldest);
  }
}

// Photos that get a src at render time; the rest wait until the strip brings them near.
const GALLERY_EAGER = 2;

const TABS = [
  ['listing', 'Listing'],
  ['contact', 'Contact'],
  ['agent', 'Agent'],
  ['viewing', 'Viewing'],
  ['ratings', 'Ratings'],
  ['messages', 'Messages'],
];

// The pipeline, in order, with Reject held back for its own danger button at the end.
const PIPELINE = Object.keys(STATUS_LABELS).filter((s) => s !== 'rejected');

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export async function mountDetail(el, ctx) {
  const { api, store, navigate } = ctx;
  const id = Number(ctx.params.id);
  const areas = store.get().areas || [];
  // Flow mode (?flow=sort|rate|contact|view): a fixed queue, a sticky action bar, and an
  // auto-advance once this listing has what the stage asks for. See lib/flow.js.
  const flow = isStage(ctx.query.flow) ? ctx.query.flow : null;
  let tab = PANELS[ctx.query.tab] ? ctx.query.tab : flow ? STAGES[flow].tab : 'listing';
  let p = null;
  let alive = true;
  let market = null; // /api/market, fetched once per mount for the area price band
  let miniMap = null; // Leaflet instance for the Location block; torn down on every re-render
  let galleryObserver = null; // loads the strip's photos as they come near; torn down with it
  let listIds = null; // ordered ids for the prev/next pager (SPEC §5); null hides it

  setHtml(el, html`<p class="loading">Loading…</p>`);

  function header() {
    const areaLabel = areas.find((a) => a.id === p.area)?.label || p.area;
    return html`<div class="detail-head">
      <h1 class="detail-title">${p.title}</h1>
      <div class="detail-facts">
        <span class="detail-price mono">${priceLabel(p)}</span>
        <span class="muted">${areaLabel}${p.sub_area ? ` · ${p.sub_area}` : ''}</span>
        ${p.beach_km != null ? html`<span class="mono muted">${beachLabel(p.beach_km)}</span>` : ''}
        ${p.bedrooms != null ? html`<span class="mono muted">${p.bedrooms} BR${p.extra_rooms ? ` +${p.extra_rooms}` : ''}</span>` : ''}
        ${statusPill(p.status)}
        ${p.flagged ? html`<span class="pill pill-flagged">Featured</span>` : ''}
        ${(p.red_flags || []).map((f) => html`<span class="pill pill-flag">${redFlagLabel(f)}</span>`)}
        ${fitRing(p.fit_score, 44)}
      </div>
      ${valueBadgesHtml(p, areaLabel)}
    </div>`;
  }

  /** The first scan: photos, then read, then tap a status. Lives above the tabs, so it
      is reachable from every tab. */
  function statusRow() {
    // The pressed button carries the initial of whoever set it (SPEC: everything attributed).
    const who = (status) =>
      p.status === status && p.status_by_name
        ? html`<span class="who who-set" title="Set by ${p.status_by_name}" aria-label="set by ${p.status_by_name}">${initialOf(p.status_by_name)}</span>`
        : '';
    const button = (status, label, extra = '') => html`<button type="button"
      class="status-btn${raw(extra)}" data-action="status" data-status="${status}"
      aria-pressed="${String(p.status === status)}">${label}${who(status)}</button>`;
    return html`<div class="status-row" role="group" aria-label="Status">
      ${PIPELINE.map((s) => button(s, STATUS_LABELS[s]))}
      ${button('rejected', 'Reject', ' status-btn-danger')}
    </div>`;
  }

  /** Shared search: both people's calls and the viewer's own Yes / Maybe / No, as a
      glass capsule on the photo's top right — one thumb-reach from the pager above it. */
  function verdictCapsule() {
    const viewer = { user: store.get().user, users: store.get().users || [] };
    if (!viewer.user) return '';
    return html`<div class="gallery-verdict">
      ${verdictPairHtml(p, viewer)}
      ${verdictControlHtml(p, viewer.user.id, { compact: true })}
    </div>`;
  }

  // --- prev/next pager ---------------------------------------------------
  // Source of truth is store.list_ids (home publishes the order it last rendered, in
  // filtered/sorted order). A deep link or reload has no list yet, so fetch the current
  // filters once and adopt that order instead.

  // A listing opened from the map, the market tables, the agent page or a shared link can
  // sit outside the current filters; then the pager walks the whole market instead, newest
  // first, so there is always a next/previous property to explore.
  const EVERYTHING_QUERY = 'scope=all&status=all&hide_gone=0&removed=show&sort=new&limit=500';

  async function ensureListIds() {
    if (flow) {
      const queue = store.get().flow;
      if (queue?.stage === flow && Array.isArray(queue.ids) && queue.ids.includes(id)) {
        listIds = queue.ids;
        return;
      }
      try {
        const fetched = await loadStageIds(api, flow, store.get().filters, store.get().user?.id);
        if (!alive) return;
        // A deep link into a stage: adopt its queue, with this listing at the front when
        // it is no longer waiting for the stage (already sorted, already rated, ...).
        const ids = fetched.includes(id) ? fetched : [id, ...fetched];
        store.set({ flow: { stage: flow, ids } });
        listIds = ids;
      } catch {
        listIds = [id];
      }
      return;
    }
    const ids = store.get().list_ids;
    if (Array.isArray(ids) && ids.includes(id)) {
      listIds = ids;
      return;
    }
    try {
      const fetched = await api.get(`/api/properties?${filtersToQuery(store.get().filters, { limit: 500 })}`);
      if (!alive) return;
      const fresh = fetched.map((r) => r.id);
      if (fresh.includes(id)) {
        store.set({ list_ids: fresh });
        listIds = fresh;
        return;
      }
      const everything = await api.get(`/api/properties?${EVERYTHING_QUERY}`);
      if (!alive) return;
      const all = everything.map((r) => r.id);
      listIds = all.includes(id) ? all : null;
    } catch {
      listIds = null; // a pager that fails to resolve is never worth a red box — just hide it
    }
  }

  function pagerInfo() {
    if (!listIds) return null;
    const idx = listIds.indexOf(id);
    if (idx === -1) return null;
    return {
      idx,
      total: listIds.length,
      prevId: idx > 0 ? listIds[idx - 1] : null,
      nextId: idx < listIds.length - 1 ? listIds[idx + 1] : null,
    };
  }

  function pager() {
    const info = pagerInfo();
    if (!info) return '';
    const { idx, total, prevId, nextId } = info;
    return html`<div class="pager">
      <button type="button" class="pager-btn" data-pager="prev" aria-label="Previous listing"${raw(prevId == null ? ' disabled' : '')}>${icons.back()}</button>
      <span class="pager-count mono">${idx + 1} / ${total}</span>
      <button type="button" class="pager-btn" data-pager="next" aria-label="Next listing"${raw(nextId == null ? ' disabled' : '')}>${icons.forward()}</button>
    </div>`;
  }

  /** Where a listing opens from here: in flow, the stage's own tab; otherwise this tab. */
  function hrefFor(targetId) {
    return flow ? `#/p/${targetId}?flow=${flow}` : `#/p/${targetId}?tab=${tab}`;
  }

  function goToPager(dir) {
    const info = pagerInfo();
    if (!info) return;
    const targetId = dir === 'prev' ? info.prevId : info.nextId;
    if (targetId == null) return;
    navigate(hrefFor(targetId));
  }

  // --- flow mode ---------------------------------------------------------

  /** Moves on to the next listing in the queue; at the end, hands over to the next stage. */
  function advance() {
    const info = pagerInfo();
    if (info?.nextId != null) {
      navigate(hrefFor(info.nextId));
      return;
    }
    const label = STAGES[flow].label;
    const following = nextStage(flow);
    toast(following ? `${label} done — next up: ${STAGES[following].label}` : `${label} done`);
    navigate('#/');
  }

  function flowActions() {
    const s = STAGES[flow];
    if (flow === 'sort') {
      const mine = verdictOf(p, store.get().user?.id);
      return html`<button type="button" class="flow-btn flow-btn-danger" data-flow="status" data-status="rejected"
          aria-pressed="${String(p.status === 'rejected')}">Reject</button>
        <button type="button" class="flow-btn" data-flow="status" data-status="maybe"
          aria-pressed="${String(mine === 'maybe' && p.status === 'new')}">Maybe</button>
        <button type="button" class="flow-btn flow-btn-primary" data-flow="status" data-status="shortlist"
          aria-pressed="${String(p.status === 'shortlist')}">Shortlist</button>`;
    }
    if (flow === 'rate') {
      const rated = new Set((p.ratings || []).map((r) => r.feature));
      const n = RATING_FEATURES.filter(([k]) => rated.has(k)).length;
      const done = s.done(p, store.get().user?.id);
      return html`<span class="flow-hint"><b class="mono">${n} / ${RATING_FEATURES.length}</b> rated${done ? '' : ' · Overall moves on'}</span>
        <button type="button" class="flow-btn${raw(done ? ' flow-btn-primary' : '')}" data-flow="next">${done ? 'Next' : 'Skip'}</button>`;
    }
    if (flow === 'contact') {
      const wa = (p.contacts || []).find((c) => String(c.whatsapp || '').replace(/\D/g, ''));
      const number = wa ? String(wa.whatsapp).replace(/\D/g, '') : '';
      const text = encodeURIComponent(fill(TEMPLATES.find((t) => t.key === 'A').body, p));
      return html`${wa
          ? html`<a class="flow-btn" href="https://wa.me/${number}?text=${raw(text)}" target="_blank" rel="noopener">${icons.whatsapp()} WhatsApp</a>`
          : html`<button type="button" class="flow-btn" data-flow="tab" data-tab="contact" data-focus="form-contact">${icons.plus()} Add contact</button>`}
        <button type="button" class="flow-btn flow-btn-primary" data-flow="status" data-status="contacted">Contacted</button>`;
    }
    // view
    return html`${p.status === 'contacted'
        ? html`<button type="button" class="flow-btn" data-flow="status" data-status="viewing_booked">Booked</button>`
        : ''}
      <button type="button" class="flow-btn flow-btn-primary" data-flow="tab" data-tab="viewing" data-focus="form-viewing">Log visit</button>`;
  }

  function flowBar() {
    if (!flow) return '';
    const s = STAGES[flow];
    const info = pagerInfo();
    return html`<div class="flow-bar" role="region" aria-label="${s.label} flow">
      <a class="flow-close" href="#/" aria-label="Leave ${s.label}">${icons.close()}</a>
      <div class="flow-meta">
        <span class="flow-stage">${s.label}</span>
        <span class="flow-count mono">${info ? `${info.idx + 1} / ${info.total}` : ''}</span>
      </div>
      <div class="flow-actions">${flowActions()}</div>
      <button type="button" class="flow-skip" data-flow="next"
        aria-label="${info?.nextId == null ? `Finish ${s.label}` : 'Skip to the next listing'}">${info?.nextId == null ? icons.check() : icons.forward()}</button>
    </div>`;
  }

  async function setStatus(status) {
    await api.post(`/api/properties/${id}/status`, { status });
    await afterWrite(`Status: ${STATUS_LABELS[status]} (${store.get().user?.name})`);
  }

  /** The Sort stage's one tap is also this person's call in the shared search:
      Shortlist says yes, Reject says no, Maybe says maybe and leaves the status alone.
      The verdict goes first so a failure there leaves the listing in the queue rather
      than sorted without a call. */
  async function sortCall(status) {
    const verdict = status === 'rejected' ? 'no' : status === 'maybe' ? 'maybe' : 'yes';
    await api.post(`/api/properties/${id}/verdict`, { verdict });
    if (status === 'maybe') await afterWrite(`Maybe (${store.get().user?.name})`);
    else await setStatus(status);
  }

  /** Switches tab and brings a form into view — "Log visit", "Add contact". */
  function jumpTo(nextTab, formId) {
    tab = nextTab;
    location.hash = `#/p/${id}?tab=${nextTab}${flow ? `&flow=${flow}` : ''}`;
    render();
    const form = formId ? $(`#${formId}`, el) : null;
    if (!form) return;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.querySelector('input:not([type=date]):not([type=file]), textarea')?.focus({ preventScroll: true });
  }

  /** Prefetches the next listing into PAGER_CACHE so tapping `>` feels instant. Runs once
      idle; on a slow connection this just means the tap fetches like normal. */
  function schedulePreload() {
    const info = pagerInfo();
    if (!info || info.nextId == null || PAGER_CACHE.has(info.nextId)) return;
    const nextId = info.nextId;
    const run = () => {
      if (!alive) return;
      api
        .get(`/api/properties/${nextId}`)
        .then((row) => {
          if (alive) cachePut(nextId, row);
        })
        .catch(() => {}); // best-effort — a failed prefetch just means load() fetches later
    };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 300);
  }

  /** ArrowLeft/ArrowRight move through the list, same as tapping the pager — but not while
      a form field has focus (typing "left" in a notes box must not navigate away). */
  function onKeydown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      goToPager(event.key === 'ArrowLeft' ? 'prev' : 'next');
      return;
    }
    if (!flow || !p) return;
    // Flow shortcuts on a keyboard: S shortlist, M maybe, X reject (sort stage), N skip.
    const key = event.key.toLowerCase();
    if (key === 'n') advance();
    else if (flow === 'sort' && key === 's') sortCall('shortlist').catch((err) => toast(err.message, 'error'));
    else if (flow === 'sort' && key === 'm') sortCall('maybe').catch((err) => toast(err.message, 'error'));
    else if (flow === 'sort' && key === 'x') sortCall('rejected').catch((err) => toast(err.message, 'error'));
  }

  /** Photos past the first GALLERY_EAGER get their src only once they come within a
      slide of view. Native loading="lazy" cannot do this: Safari re-evaluates lazy images
      on document scroll only, so a photo inside the horizontal strip never loads on a
      desktop where the page itself does not move (a blank frame at "3 / 12"). */
  function revealPhoto(img) {
    if (!img?.dataset.src) return;
    img.src = img.dataset.src;
    delete img.dataset.src;
  }

  /** The slide at `index` (0-based) and its two neighbours get their src. Driven by the
      strip's own scroll events, so it works even where the observer below does not fire. */
  function revealAround(strip, index) {
    const photos = strip.children;
    for (let i = index - 1; i <= index + 1; i += 1) revealPhoto(photos[i]);
  }

  function watchGallery(strip) {
    galleryObserver?.disconnect();
    galleryObserver = null;
    const pending = $$('img[data-src]', strip);
    if (!pending.length) return;
    if (typeof IntersectionObserver !== 'function') {
      pending.forEach(revealPhoto);
      return;
    }
    galleryObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          revealPhoto(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { root: strip, rootMargin: '0px 100% 0px 100%' }
    );
    pending.forEach((img) => galleryObserver.observe(img));
  }

  /** Moves the photo strip one frame; past the last photo it wraps to the first, so a
      tap on the picture always shows something new. */
  function stepGallery(direction) {
    const strip = $('#gallery', el);
    if (!strip) return;
    const width = Math.max(1, strip.clientWidth);
    const count = strip.children.length;
    const index = Math.round(strip.scrollLeft / width);
    const next = (index + direction + count) % count;
    revealAround(strip, next);
    strip.scrollTo({ left: next * width, behavior: 'smooth' });
  }

  function gallery() {
    const urls = p.image_urls || [];
    if (!urls.length) {
      return html`<div class="gallery-wrap"><div class="gallery-empty"><span class="placeholder">No photos</span></div>${verdictCapsule()}</div>`;
    }
    return html`<div class="gallery-wrap">
      <div class="gallery" id="gallery" tabindex="0" aria-label="Photos of ${p.title}, tap for the next one">
        ${urls.map((u, i) =>
          i < GALLERY_EAGER
            ? html`<img src="${u}" alt="" decoding="async" />`
            : html`<img data-src="${u}" alt="" decoding="async" />`
        )}
      </div>
      ${urls.length > 1
        ? html`<button type="button" class="gallery-nav gallery-prev" data-gallery="prev" aria-label="Previous photo">${icons.back()}</button>
            <button type="button" class="gallery-nav gallery-next" data-gallery="next" aria-label="Next photo">${icons.forward()}</button>`
        : ''}
      <div class="gallery-count mono" id="gallery-count" aria-live="off">1 / ${urls.length}</div>
      ${verdictCapsule()}
    </div>`;
  }

  function render() {
    setHtml(
      el,
      html`<div class="detail-page${raw(flow ? ' in-flow' : '')}">
        <div class="detail-top">
          <a class="btn btn-sm btn-ghost detail-back" href="#/">${icons.back()} Back</a>
          ${pager()}
        </div>
        ${gallery()}
        ${header()}
        ${statusRow()}
        <div class="tabs" role="tablist">
          ${TABS.map(
            ([key, label]) => html`<button type="button" class="tab-btn" role="tab" data-tab="${key}"
              aria-selected="${String(tab === key)}">${label}</button>`
          )}
        </div>
        <div id="tab-panel">${PANELS[tab](p, areas)}</div>
        ${flowBar()}
      </div>`
    );

    fillPriceBand();
    fillDuplicates();
    mountMiniMap();

    const strip = $('#gallery', el);
    if (strip) {
      watchGallery(strip);
      // A tap on the picture is the fastest "next photo" there is. A swipe never fires a
      // click, so scrolling by hand keeps working as before.
      strip.addEventListener('click', (event) => {
        if (event.target.tagName === 'IMG') stepGallery(1);
      });
      strip.addEventListener('scroll', () => {
        // A re-render replaces the counter; the old strip may still fire one last scroll.
        const counter = $('#gallery-count', el);
        if (!counter || !strip.isConnected) return;
        const total = p.image_urls.length;
        const index = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth)) + 1;
        counter.textContent = `${Math.min(index, total)} / ${total}`;
        revealAround(strip, index - 1);
      });
    }
  }

  /** Leaflet mini map in the Location block. Google's embed is blocked in some webviews,
      so we draw the pin ourselves with the Leaflet that index.html already loads. */
  function mountMiniMap() {
    miniMap?.remove();
    miniMap = null;
    const node = $('#mini-map', el);
    if (!node || !window.L) return;
    const lat = Number(node.dataset.lat);
    const lng = Number(node.dataset.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    miniMap = window.L.map(node, { scrollWheelZoom: false, dragging: true }).setView([lat, lng], 15);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(miniMap);
    window.L.marker([lat, lng]).addTo(miniMap);
  }

  /** The area's p25–median–p75 band with this villa's price on it (Listing tab). */
  async function fillPriceBand() {
    const slot = $('#price-band', el);
    if (!slot || !p) return;
    try {
      if (!market) market = await api.get('/api/market');
      if (!alive || !slot.isConnected) return;
      const row = (market.by_area || []).find((r) => r.area === p.area);
      slot.innerHTML = renderPriceBand(row, p.price_month_idr, { chartWidth: slot.clientWidth });
    } catch (err) {
      slot.innerHTML = `<p class="muted">Area prices unavailable (${err.status || err.message})</p>`;
    }
  }

  // --- possible duplicates (Listing tab) ------------------------------------
  // The automatic dedupe (SPEC §6) only merges what it is sure of; these are the near
  // misses, scored and explained, for a person to settle. Merging keeps THIS listing.

  function duplicateRow(c) {
    const o = c.property;
    const pct = Math.round(c.score * 100);
    return html`<div class="dup" data-dup="${o.id}">
      <a class="dup-thumb" href="#/p/${o.id}" aria-label="Open ${o.title}">
        ${o.hero_url
          ? html`<img src="${o.hero_url}" alt="" loading="lazy" decoding="async" />`
          : html`<span class="placeholder small">No photo</span>`}
      </a>
      <div class="dup-main">
        <div class="dup-head">
          <a href="#/p/${o.id}">${o.title}</a>
          <span class="pill">${o.source}${o.ref ? ` · ${o.ref}` : ''}</span>
        </div>
        <p class="small mono muted">${priceLabel(o)}${o.bedrooms != null ? ` · ${o.bedrooms} BR` : ''}${o.sub_area ? ` · ${o.sub_area}` : ''}</p>
        <div class="dup-score">
          <span class="dup-bar" role="img" aria-label="Match ${pct} of 100">
            <span class="dup-bar-fill" style="width:${pct}%"></span>
          </span>
          <span class="mono small">${c.score.toFixed(2)}</span>
        </div>
        <p class="small muted">${c.reasons.join(' · ')}</p>
        <div class="dup-actions">
          <button type="button" class="btn btn-sm" data-dup-action="merge" data-other="${o.id}">Merge into this</button>
          <button type="button" class="btn btn-sm btn-ghost" data-dup-action="dismiss" data-other="${o.id}">Not a duplicate</button>
        </div>
      </div>
    </div>`;
  }

  async function fillDuplicates() {
    const block = $('#duplicates-block', el);
    const list = $('#duplicates-list', el);
    if (!block || !list) return;
    try {
      const res = await api.get(`/api/properties/${id}/duplicates`);
      if (!alive || !list.isConnected) return;
      const candidates = res.candidates || [];
      block.hidden = candidates.length === 0;
      setHtml(list, candidates.map(duplicateRow));
    } catch {
      block.hidden = true; // a duplicate check that fails is never worth a red box
    }
  }

  /** Merging is hard to undo, so the button asks a second time in place. */
  function resetMergeConfirms() {
    for (const b of $$('button[data-dup-action="merge"][data-confirm]', el)) {
      delete b.dataset.confirm;
      b.textContent = 'Merge into this';
      b.classList.remove('btn-confirm');
    }
  }

  async function onDuplicateClick(event) {
    const button = event.target.closest('button[data-dup-action]');
    if (!button) return;
    const other = Number(button.dataset.other);
    const action = button.dataset.dupAction;

    if (action === 'merge' && button.dataset.confirm !== '1') {
      resetMergeConfirms();
      button.dataset.confirm = '1';
      button.textContent = 'Confirm merge';
      button.classList.add('btn-confirm');
      return;
    }

    button.disabled = true;
    try {
      if (action === 'merge') {
        await api.post('/api/duplicates/merge', { keep_id: id, merge_id: other });
        await afterWrite('Merged — this listing kept, the other marked gone');
      } else {
        await api.post('/api/duplicates/dismiss', { a: id, b: other });
        toast('Marked as not a duplicate');
        await fillDuplicates();
      }
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  }

  async function load({ skipCache = false } = {}) {
    const idsTask = ensureListIds();
    const cached = skipCache ? null : PAGER_CACHE.get(id);

    if (cached) {
      p = cached;
      await idsTask;
      if (!alive) return;
      render();
      schedulePreload();
      try {
        const fresh = await api.get(`/api/properties/${id}`);
        if (!alive) return;
        p = fresh;
        cachePut(id, fresh);
        render();
      } catch {
        /* a background refresh failing just leaves the cached view up — never a red box */
      }
      return;
    }

    try {
      const [fetched] = await Promise.all([api.get(`/api/properties/${id}`), idsTask]);
      if (!alive) return;
      p = fetched;
      cachePut(id, p);
      render();
      schedulePreload();
    } catch (err) {
      if (!alive) return;
      setHtml(el, html`<p class="empty">Could not load this listing: ${err.message}</p>`);
    }
  }

  /** Every write re-reads the row: assessed, flags and the fit score can all move. */
  async function afterWrite(message) {
    toast(message);
    await load({ skipCache: true });
    ctx.refreshCounts?.();
    // The point of flow mode: the moment this listing has what the stage needs, move on.
    if (alive && flow && p && STAGES[flow].done(p, store.get().user?.id)) advance();
  }

  function fieldValue(form, name) {
    const v = form.elements[name]?.value?.trim();
    return v ? v : null;
  }

  async function onActionClick(event) {
    const button = event.target.closest('button, a[data-tab]');
    if (!button) return;
    const { action, tab: nextTab, feature, status, flag, key, gallery: step, pager: pagerDir, flow: flowAction } = button.dataset;

    if (pagerDir) {
      goToPager(pagerDir);
      return;
    }
    if (flowAction) {
      try {
        if (flowAction === 'next') advance();
        else if (flowAction === 'status') await (flow === 'sort' ? sortCall(status) : setStatus(status));
        else if (flowAction === 'tab') jumpTo(nextTab, button.dataset.focus);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    if (step) {
      stepGallery(step === 'prev' ? -1 : 1);
      return;
    }
    if (nextTab) {
      jumpTo(nextTab);
      return;
    }
    if (button.dataset.scale || button.parentElement?.dataset.role) return; // handled by the form logic

    try {
      if (action === 'rate') {
        await api.post(`/api/properties/${id}/ratings`, { feature, score: Number(button.value) });
        const label = RATING_FEATURES.find(([key]) => key === feature)?.[1] || feature;
        await afterWrite(`${label} rated ${button.value} by ${store.get().user?.name}`);
      } else if (action === 'status') {
        await setStatus(status);
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
  el.addEventListener('click', onDuplicateClick);
  el.addEventListener('submit', onSubmit);
  window.addEventListener('keydown', onKeydown);
  const unbindVerdicts = bindVerdicts(el, { api, onSaved: () => load({ skipCache: true }) });

  await load();

  const unmount = () => {
    alive = false;
    unbindVerdicts();
    miniMap?.remove();
    miniMap = null;
    galleryObserver?.disconnect();
    galleryObserver = null;
    el.removeEventListener('click', onActionClick);
    el.removeEventListener('click', onToggleClick);
    el.removeEventListener('click', onDuplicateClick);
    el.removeEventListener('submit', onSubmit);
    window.removeEventListener('keydown', onKeydown);
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
