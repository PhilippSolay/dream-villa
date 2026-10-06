// villa harvester v6 — paste into the Facebook tab (javascript_tool). Installs window.__villa.
// Usage after install: await __villa.start(groupId, groupName, {cutoff:'YYYY-MM-DD'}); __villa.status(); __villa.stop(); __villa.download(tag)
// v5 (2026-09-21): opts.minRounds / opts.minPosts override the depth guard (25 rounds, 150 posts) for an
// incremental "latest since last harvest" pass on a group already harvested: {cutoff:'2026-09-19', minRounds:6, minPosts:0}.
// Pair it with __villa.preload(<known ids>) so already-imported posts cost no text and no gallery.
// v6 (2026-10-04): the cutoff check reads a "frontier" date from the feed in scroll order, not the 5th-oldest date
// anywhere on the page. Each top-level post is counted once per run, in the order it first appears; pinned / featured /
// announcement posts and "shared a memory" items are left out; a post's date is the NEWEST of its own timestamp links
// (a reshare is never older than the original it embeds; comment links are ignored). frontier = the date that at least
// 70% of the last 20 counted posts are as old as or older than. The group ends once frontier < cutoff on 2 consecutive
// rounds (plus the minRounds / minPosts depth guard). status().oldest now reports the frontier (falls back to the old
// 5th-oldest value, kept as oldest5, until 5 posts are counted); new fields: frontier, frontierN, pastRounds, pinnedSkipped.
// v6.1 (2026-10-06): second, independent stop path for incremental runs. Counting top-level posts once per run in scroll
// order (pinned left out, same as the frontier), knownRun = how many in a row were ALREADY in memory when first seen
// (preloaded via __villa.preload, or held from earlier). knownRun >= KNOWN_RUN_K (25; opts.knownRun overrides, 0 = off)
// + minRounds + no deferred "See more" post waiting → stop, stopReason 'known-run' ("caught up"). Only armed when at
// least KNOWN_PRELOAD_MIN (50) ids were preloaded, so a first harvest still ends on the frontier. status() adds
// ver:'6.1', stopReason ('frontier' | 'known-run' | 'idle' | 'stalled' | 'manual' | 'error'), knownRun, knownRunMax,
// knownRunK, preloaded. Version string stays "installed v6".
window.__villa = window.__villa || {};
(() => {
const V = window.__villa;
V.version = 6; V.ver = '6.1';
V.KNOWN_RUN_K = 25; V.KNOWN_PRELOAD_MIN = 50;
V.FRONTIER_N = 20; V.FRONTIER_Q = 0.7; V.FRONTIER_MIN = 5; V.PAST_ROUNDS = 2;
V.POST_LINK_RE = /\/posts\/\d+|\/permalink\/\d+|story_fbid=/;
// pure: frontier of a window of ISO dates (scroll order) — the value at least FRONTIER_Q of them are <= to
V.frontierOf = (dates) => { const d = (dates || []).filter(Boolean).slice().sort(); if (d.length < V.FRONTIER_MIN) return null; return d[Math.max(0, Math.ceil(V.FRONTIER_Q * d.length) - 1)]; };
// pure: the stop rule
V.cutoffReached = (s, cutoff, minRounds, minPosts) => (s.pastRounds || 0) >= V.PAST_ROUNDS && (s.rounds || 0) >= minRounds && (s.total || 0) >= minPosts && !!s.frontier && s.frontier.slice(0, 10) < cutoff;
// pure (v6.1): the "caught up" rule — K known posts in a row in scroll order, depth guard met, nothing deferred
V.knownRunReached = (s, K, minRounds) => K > 0 && (s.knownRun || 0) >= K && (s.rounds || 0) >= minRounds && !(s.deferred > 0);
// pure (v6.1): which stop path fires after a round (frontier first, it is the stricter one), or null
V.stopReasonOf = (s, o) => V.cutoffReached(s, o.cutoff, o.minRounds, o.minPosts) ? 'frontier' : V.knownRunReached(s, o.knownRunK, o.minRounds) ? 'known-run' : null;
// pure: a header line that marks a post as outside the chronological order
V.PINNED_LINE_RE = /^(featured|featured post|pinned|pinned post|announcement|announcements|admin announcement|new announcement)$/i;
V.MEMORY_RE = /shared a memory/i;
V.isPinnedHead = (lines) => (lines || []).slice(0, 8).some((s) => V.PINNED_LINE_RE.test(String(s).trim()) || V.MEMORY_RE.test(String(s)));
V.isPinned = (a) => { try { if (a.querySelector('[aria-label="Pinned post" i], [aria-label^="Featured" i], [aria-label*="announcement" i]')) return true; } catch (e) { /* old selector engine */ }
  return V.isPinnedHead(String(a.innerText || '').split('\n')); };
V.ownDate = (a) => { let best = null; // newest of the post's own timestamp links: not comments, not nested articles
  for (const l of a.querySelectorAll('a[href]')) { if (!V.POST_LINK_RE.test(l.href) || /comment_id=/.test(l.href) || l.closest('[role="article"]') !== a) continue;
    const d = V.parseDate(l.innerText.trim()); if (d && (!best || d > best)) best = d; }
  return best; };
V.mem = V.mem || {};
V.seq = V.seq || 0;
V.FLUSH_AT = 100;
V.MAX_IMGS = 15;
V.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
V.parseDate = (t) => { const now = new Date(); let m; t = String(t || '').trim();
  if ((m = t.match(/^(\d+)\s*([mhdw])$/))) { const n = +m[1]; const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]]; return new Date(now - n * ms).toISOString(); }
  if (/^Yesterday/i.test(t)) { const d = new Date(now - 86400e3); const tm = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if (tm) { let h = +tm[1]; if (tm[3]) { if (/PM/i.test(tm[3]) && h < 12) h += 12; if (/AM/i.test(tm[3]) && h === 12) h = 0; } d.setHours(h, +tm[2], 0, 0); } return d.toISOString(); }
  // "September 12 at 11:04 PM", "September 12, 2025 at 9:00 AM", "Sep 12", "12 September at 10:20", "12 September 2025"
  m = t.match(/^(?:([A-Z][a-z]+)\.? (\d{1,2})|(\d{1,2}) ([A-Z][a-z]+)\.?)(?:,? (\d{4}))?(?: at (\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (m) { const mon = m[1] || m[4]; const day = +(m[2] || m[3]); const year = m[5] ? +m[5] : now.getFullYear();
    const d = new Date(`${mon} ${day}, ${year}`); if (isNaN(d)) return null;
    if (m[6]) { let h = +m[6]; if (m[8]) { if (/PM/i.test(m[8]) && h < 12) h += 12; if (/AM/i.test(m[8]) && h === 12) h = 0; } d.setHours(h, +m[7], 0, 0); }
    if (!m[5] && d > now) d.setFullYear(d.getFullYear() - 1); return d.toISOString(); }
  return null; };
V.expand = () => { let n = 0; for (const b of document.querySelectorAll('[role="article"] div[role="button"]')) { if (/^See more$/i.test(b.innerText.trim()) && !b.closest('a') && !b.closest('[role="link"]')) { b.click(); n++; } } return n; };
V.grabImages = async (article) => {
  const imgs = [...article.querySelectorAll('img[src*="scontent"]')].filter((i) => (i.naturalWidth || i.width) >= 200 && !i.closest('a[href*="/user/"]'));
  const seen = new Set(); const out = [];
  for (const img of imgs) { if (out.length >= V.MAX_IMGS) break; const src = img.src; if (seen.has(src)) continue; seen.add(src);
    try { const r = await fetch(src, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(15000) }); if (!r.ok) continue; const bmp = await createImageBitmap(await r.blob());
      const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); out.push({ data_base64: c.toDataURL('image/jpeg', 0.8).split(',')[1], w: c.width, h: c.height }); bmp.close && bmp.close(); c.width = 0; } catch (e) { /* skip */ } }
  return out; };
V.RENT_RE = /\b(rent|rental|lease|sewa|disewakan|kontrak|monthly|yearly|bulan|tahun|\/mo|\/yr|per month|per year|\/month|\/year)\b/i;
V.PRICE_RE = /(IDR|Rp|juta|jt|\bM\b|million|\d{2,3}[.,]\d{3}[.,]\d{3})/i;
V.WANTED_RE = /\b(looking for|wanted|dicari|mencari)\b/i;
V.encodeUrl = async (src) => { try { const r = await fetch(src, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(15000) }); if (!r.ok) return null; const bmp = await createImageBitmap(await r.blob());
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); const out = { data_base64: c.toDataURL('image/jpeg', 0.8).split(',')[1], w: c.width, h: c.height }; bmp.close && bmp.close(); c.width = 0; return out; } catch (e) { return null; } };
V.fullGallery = async (article, max = 15) => { // open Facebook's photo viewer on the post and step through every frame
  const imgs = [...article.querySelectorAll('img[src*="scontent"]')].filter((i) => (i.naturalWidth || i.width) >= 200 && !i.closest('a[href*="/user/"]'));
  if (!imgs.length) return null; if ([...article.querySelectorAll('a[href]')].some((l) => /commerce\/listing/.test(l.href))) return null;
  const tile = imgs[0].closest('a') || imgs[0]; V.inGallery = true; const out = []; const seenSrc = new Set();
  try { tile.click(); for (let i = 0; i < 6 && !document.querySelector('[role="dialog"] img[data-visualcompletion="media-vc-image"]'); i++) await V.sleep(500);
    const dlg = document.querySelector('[role="dialog"]'); if (!dlg) return null;
    const fbids = new Set(); let steps = 0;
    while (steps < max) { const fbid = (location.search.match(/fbid=(\d+)/) || [])[1]; if (fbid && fbids.has(fbid)) break; if (fbid) fbids.add(fbid);
      const big = dlg.querySelector('img[data-visualcompletion="media-vc-image"]'); if (big && big.src && !seenSrc.has(big.src)) { seenSrc.add(big.src); const enc = await V.encodeUrl(big.src); if (enc) out.push(enc); }
      const next = document.querySelector('[aria-label="Next photo"], [aria-label="Next"]'); if (!next) break; next.click(); steps++; await V.sleep(900); }
  } catch (e) { /* fall through */ }
  finally { const close = document.querySelector('[aria-label="Close"]'); if (close) close.click(); await V.sleep(800); V.inGallery = false; }
  return out.length ? out : null; };
V.collect = async (groupId, groupName) => {
  const store = V.mem; const feed = document.querySelector('[role="feed"]') || document; let added = 0, oldest = null, imgs = 0, deferred = 0;
  for (const a of feed.querySelectorAll('[role="article"]')) {
    const link = [...a.querySelectorAll('a[href]')].find((l) => /\/posts\/\d+|\/permalink\/\d+|story_fbid=/.test(l.href)); if (!link) continue;
    const m = link.href.match(/\/posts\/(\d+)|\/permalink\/(\d+)|story_fbid=(\d+)/); const id = m && (m[1] || m[2] || m[3]); if (!id) continue;
    const time = link.innerText.trim(); const posted = V.parseDate(time); if (posted && (!oldest || posted < oldest)) oldest = posted;
    // v6 frontier: each top-level post once per run, in the order it first shows up while scrolling
    V.runSeen = V.runSeen || new Set(); V.frontierDates = V.frontierDates || [];
    if (!V.runSeen.has(id) && !(a.parentElement && a.parentElement.closest('[role="article"]'))) { V.runSeen.add(id);
      if (V.isPinned(a)) V.state.pinnedSkipped = (V.state.pinnedSkipped || 0) + 1;
      else { const d = V.ownDate(a); if (d) V.frontierDates.push(d);
        V.state.knownRun = store[id] ? (V.state.knownRun || 0) + 1 : 0; // v6.1: known at first sight → extends the run, a new post resets it
        if (V.state.knownRun > (V.state.knownRunMax || 0)) V.state.knownRunMax = V.state.knownRun; } }
    if (!store[id]) {
      const truncated = /\bSee more\b/.test(a.innerText); V.tries = V.tries || {}; V.tries[id] = (V.tries[id] || 0) + 1;
      if (truncated && V.tries[id] < 4) { deferred++; continue; }            // wait for "See more" to expand, up to 3 rounds
      const posterA = [...a.querySelectorAll('a[href]')].find((l) => /\/user\/\d+|profile\.php/.test(l.href));
      const lines = a.innerText.split('\n').map((s) => s.trim());
      const poster = (lines.find((s) => s && !/friends are members|members$/i.test(s)) || '').slice(0, 80);
      let body = lines.slice(1); const ti = body.indexOf(time); if (ti >= 0) body = body.slice(ti + 1);
      body = body.filter((s) => s && s !== '·' && !/^See (more|less)$/i.test(s) && !/^\+\d+$/.test(s) && !/^Comment as /.test(s));
      while (body.length && /^\d+$/.test(body[body.length - 1])) body.pop();
      const text = body.join('\n').slice(0, 8000); const wa = (text.match(/wa\.me\/\+?(\d{8,15})/) || [])[1];
      store[id] = { post_id: id, url: link.href.split('?')[0], posted_at: posted, time, poster_name: poster || null, poster_url: posterA ? posterA.href.split('?')[0] : null, text, truncated: truncated || undefined, whatsapp: wa ? '+' + wa.replace(/^0/, '62') : undefined, group_id: groupId, group_name: groupName };
      added++;
    }
    const p = store[id];
    if (!p.exported && !p.images && !p.image_tried) { p.image_tried = true;
      const rentLike = V.RENT_RE.test(p.text || '') && V.PRICE_RE.test(p.text || '') && !V.WANTED_RE.test(p.text || '');
      let im = rentLike ? await V.fullGallery(a, V.MAX_IMGS) : null; if (!im) im = await V.grabImages(a);
      if (im.length) { p.images_b64 = im; p.images = im.length; imgs += im.length; if (rentLike) V.state.galleries = (V.state.galleries || 0) + 1; } }
  }
  // v5 metric, kept for the log only (oldest5): 5th-oldest date anywhere on the page — pinned posts and reshares fool it
  const dates = [...feed.querySelectorAll('[role="article"] a[href*="/posts/"], [role="article"] a[href*="/permalink/"]')].map((a) => V.parseDate(a.innerText.trim())).filter(Boolean).sort();
  const oldest5 = dates.length >= 5 ? dates[4] : (dates.length ? dates[dates.length - 1] : null);
  const win = (V.frontierDates || []).slice(-V.FRONTIER_N); const frontier = V.frontierOf(win);
  return { added, imgs, deferred, total: Object.keys(store).length, oldest: frontier || oldest5, oldest5, frontier, frontierN: win.length }; };
V.download = (tag) => {
  const posts = Object.values(V.mem).filter((p) => !p.exported).map((p) => { const { image_tried, exported, images, ...rest } = p; return rest; });
  if (!posts.length) return { posts: 0 };
  V.seq++; const name = `villa-fb-posts-${tag}-${String(V.seq).padStart(3, '0')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), group_id: V.state.groupId, group_name: V.state.groupName, posts })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  for (const p of posts) { const s = V.mem[p.post_id]; s.exported = true; delete s.images_b64; delete s.text; }
  return { file: name, posts: posts.length, with_images: posts.filter((p) => p.images_b64 && p.images_b64.length).length, bytes: blob.size }; };
V.lighten = () => { // blank images of posts far above the viewport so the renderer stays light
  let n = 0; const top = window.scrollY - 2500;
  for (const a of document.querySelectorAll('[role="feed"] [role="article"]')) { const r = a.getBoundingClientRect(); if (r.bottom + window.scrollY > top) continue;
    for (const img of a.querySelectorAll('img[src*="scontent"]')) { img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; n++; }
    for (const v of a.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load && v.load(); } }
  return n; };
V.preload = (ids) => { let n = 0; for (const id of ids || []) { if (!V.mem[id]) { V.mem[id] = { post_id: String(id), exported: true, image_tried: true, pre: true }; n++; } } return n; }; // already-imported posts: skip text + galleries
V.pending = () => Object.values(V.mem).filter((p) => !p.exported).length;
V.state = V.state || { running: false, rounds: 0, oldest: null, done: false, error: null, flushes: [] };
V.start = async (groupId, groupName, opts = {}) => {
  if (V.state.running) return 'already running';
  V.cutoff = opts.cutoff || V.cutoff || new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  V.minRounds = opts.minRounds ?? 25; V.minPosts = opts.minPosts ?? 150;
  const preloaded = Object.values(V.mem).filter((p) => p.pre).length; // v6.1: known-run path armed only for a real incremental run
  V.knownRunK = preloaded >= V.KNOWN_PRELOAD_MIN ? (opts.knownRun ?? V.KNOWN_RUN_K) : 0;
  const keep = V.state.flushes || [];
  V.state = { running: true, done: false, idleRounds: 0, stalled: false, error: null, groupId, groupName, paused: false, flushes: keep, backs: 0, imgs: 0, total: 0, rounds: 0, oldest: null, throttleWaits: 0, startedAt: new Date().toISOString(),
    frontier: null, frontierN: 0, pastRounds: 0, pinnedSkipped: 0, oldest5: null, stopReason: null, knownRun: 0, knownRunMax: 0, preloaded };
  V.runSeen = new Set(); V.frontierDates = []; // frontier is per run (a reinstall + restart re-reads from the top)
  (async () => { try {
    while (V.state.running) {
      if (!V.inGallery && ((!location.pathname.includes('/groups/' + groupId) && !location.pathname.includes('/' + groupId)) || location.pathname.includes('/photo'))) { V.state.backs++; history.back(); await V.sleep(4000); continue; }
      if (document.visibilityState !== 'visible') { V.state.paused = true; await V.sleep(3000); continue; }
      V.state.paused = false;
      window.scrollTo(0, document.body.scrollHeight); await V.sleep(4500 + Math.random() * 3000);
      V.expand(); await V.sleep(1800);
      const r = await V.collect(groupId, groupName);
      V.state.rounds++; V.state.lastAdded = r.added; V.state.imgs += r.imgs; V.state.total = r.total; V.state.oldest = r.oldest || V.state.oldest; V.state.deferred = r.deferred;
      V.state.oldest5 = r.oldest5; V.state.frontier = r.frontier; V.state.frontierN = r.frontierN;
      V.state.pastRounds = (r.frontier && r.frontier.slice(0, 10) < V.cutoff) ? V.state.pastRounds + 1 : 0;
      V.state.idleRounds = (r.added === 0 && r.deferred === 0) ? V.state.idleRounds + 1 : 0;
      if (V.pending() >= V.FLUSH_AT) V.state.flushes.push(V.download(groupId));
      if (V.state.rounds % 5 === 0) V.state.lightened = (V.state.lightened || 0) + V.lighten();
      // v6: frontier past cutoff 2 rounds running + real depth (default ≥25 rounds and ≥150 posts; incremental runs lower it)
      // v6.1: or K known posts in a row (incremental runs with a preload only)
      const why = V.stopReasonOf(V.state, { cutoff: V.cutoff, minRounds: V.minRounds, minPosts: V.minPosts, knownRunK: V.knownRunK });
      if (why) { V.state.done = true; V.state.running = false; V.state.stopReason = why; }
      if (V.state.running && V.state.idleRounds >= 15) { V.state.throttleWaits++; V.state.idleRounds = 0;
        if (V.state.throttleWaits > 3) { V.state.running = false; V.state.stalled = true; V.state.stopReason = 'stalled'; }
        else { V.state.waitingUntil = new Date(Date.now() + 600e3).toISOString(); await V.sleep(600e3); V.state.waitingUntil = null; } }
      if (!V.state.running && V.pending() > 0) V.state.flushes.push(V.download(groupId));
      if (V.state.rounds % 40 === 0) await V.sleep(20000);
    }
  } catch (e) { V.state.error = String(e); V.state.running = false; V.state.stopReason = V.state.stopReason || 'error'; try { V.state.flushes.push(V.download(groupId)); } catch (_) {} } })();
  return 'started'; };
V.stop = () => { if (V.state.running && !V.state.stopReason) V.state.stopReason = 'manual'; V.state.running = false; return V.state; };
V.status = () => ({ version: V.version, ver: V.ver, cutoff: V.cutoff, minRounds: V.minRounds, minPosts: V.minPosts, knownRunK: V.knownRunK, ...V.state, pending: V.pending(), visible: document.visibilityState, path: location.pathname });
})();
'installed v' + window.__villa.version;
