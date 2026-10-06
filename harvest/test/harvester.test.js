// Tests for browser/harvester.js (v6.1). The harvester is an in-page script, so it is loaded
// here with stub window/document/location/history objects and only its pure functions plus
// V.collect over a stub feed are exercised: no browser, no Facebook.
//   node --test harvest/test
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const src = fs.readFileSync(new URL('../browser/harvester.js', import.meta.url), 'utf8');
const window = {};
const document = { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] };
const ret = new Function('window', 'document', 'location', 'history', src.replace(/\n'installed v'[^\n]*\s*$/, '') + "\nreturn 'installed v' + window.__villa.version;")(window, document, { pathname: '/', search: '' }, {});
const V = window.__villa;
const day = (n) => new Date(Date.UTC(2026, 9, 4) - n * 86400e3).toISOString();
const cut = day(9).slice(0, 10);

test('installs and returns the version string the runbooks check for', () => {
  assert.equal(ret, 'installed v6');
  assert.ok(src.trimEnd().endsWith("'installed v' + window.__villa.version;"));
  assert.equal(V.ver, '6.1');
});

test('frontierOf: 70% quantile of the window, robust to old pinned posts and reshares', () => {
  assert.equal(V.frontierOf([day(1), day(2)]), null, '<5 → null');
  // chronological window of 20, 2..21 days old: 70% quantile (14th oldest asc) = day(8)
  const chrono = Array.from({ length: 20 }, (_, i) => day(i + 2));
  assert.equal(V.frontierOf(chrono), day(8));
  // 5 old pinned/reshares (100+ days) among 15 recent → frontier stays recent
  const mixed = [day(120), day(110), day(1), day(1), day(100), day(2), day(2), day(3), day(90), day(3), day(4), day(80), day(4), day(5), day(5), day(6), day(6), day(7), day(7), day(8)];
  assert.ok(V.frontierOf(mixed) > day(9), 'old outliers do not drag frontier past a 9-day cutoff');
  // the v5 metric (5th-oldest) would have said ~day(80)
  assert.equal(mixed.slice().sort()[4], day(80));
});

test('cutoffReached: 2 rounds past the cutoff plus the depth guard', () => {
  const s = { pastRounds: 2, rounds: 6, total: 0, frontier: day(12) };
  assert.equal(V.cutoffReached(s, cut, 6, 0), true);
  assert.equal(V.cutoffReached({ ...s, pastRounds: 1 }, cut, 6, 0), false, 'needs 2 consecutive rounds');
  assert.equal(V.cutoffReached({ ...s, rounds: 5 }, cut, 6, 0), false, 'minRounds');
  assert.equal(V.cutoffReached({ ...s, total: 100 }, cut, 6, 150), false, 'minPosts');
  assert.equal(V.cutoffReached({ ...s, frontier: null }, cut, 6, 0), false, 'no frontier → no cutoff stop');
  assert.equal(V.cutoffReached({ ...s, frontier: day(3) }, cut, 6, 0), false);
});

test('isPinnedHead: featured / announcement / memory headers', () => {
  assert.equal(V.isPinnedHead(['A member', 'Featured', 'Sep 1']), true);
  assert.equal(V.isPinnedHead(['Admin announcement', 'x']), true);
  assert.equal(V.isPinnedHead(['Someone shared a memory.', 'x']), true);
  assert.equal(V.isPinnedHead(['Someone', '2d', 'Villa for rent, featured pool']), false);
});

test('a simulated scroll stops only once the chronological tail is past the cutoff', () => {
  // scroll order with old undetected reshares near the top, then chronological posts
  const scroll = [day(1), day(150), day(1), day(2), day(2), day(3), day(3), day(4), day(120), day(4), day(5), day(5), day(6), day(100), day(6), day(7), day(7), day(8), day(8), day(9), day(10), day(10), day(11), day(11), day(12), day(12), day(13), day(13), day(14), day(14), day(15), day(15), day(16), ...Array.from({ length: 30 }, (_, i) => day(16 + Math.floor(i / 2)))];
  const st = { pastRounds: 0, rounds: 0, total: 0 };
  let stoppedAt = null;
  const fd = [];
  for (let i = 0; i < scroll.length; i += 3) {
    fd.push(...scroll.slice(i, i + 3));
    st.rounds++;
    st.frontier = V.frontierOf(fd.slice(-20));
    st.pastRounds = st.frontier && st.frontier.slice(0, 10) < cut ? st.pastRounds + 1 : 0;
    if (V.cutoffReached(st, cut, 6, 0)) { stoppedAt = fd.length; break; }
  }
  assert.ok(stoppedAt && fd.slice(-6).every((d) => d < day(9)), 'stops only once the chronological tail is past cutoff');
});

test('ownDate uses the share date, ignoring comments and nested articles; isPinned reads aria labels', () => {
  // stub article: outer share "2d", embedded original "June 3", comment "1h", nested-article link
  const art = { innerText: 'A member\nshared a post\n2d', querySelector: () => null };
  const nested = {};
  const L = (href, t, owner = art) => ({ href, innerText: t, closest: () => owner });
  art.querySelectorAll = () => [L('https://www.facebook.com/groups/1/posts/111/', 'June 3'), L('https://www.facebook.com/groups/1/posts/222/', '2d'),
    L('https://www.facebook.com/groups/1/posts/222/?comment_id=9', '1h'), L('https://www.facebook.com/groups/1/posts/333/', '3h', nested), L('https://www.facebook.com/user/5', 'x')];
  const age = Date.now() - new Date(V.ownDate(art));
  assert.ok(age > 1.9 * 86400e3 && age < 2.1 * 86400e3);
  assert.equal(V.isPinned(art), false);
  assert.equal(V.isPinned({ innerText: 'x', querySelector: () => ({}) }), true);
});

test('knownRunReached (v6.1): K known in a row, depth guard, nothing deferred', () => {
  assert.equal(V.knownRunReached({ knownRun: 25, rounds: 6 }, 25, 6), true);
  assert.equal(V.knownRunReached({ knownRun: 24, rounds: 6 }, 25, 6), false, 'K not reached');
  assert.equal(V.knownRunReached({ knownRun: 30, rounds: 5 }, 25, 6), false, 'minRounds');
  assert.equal(V.knownRunReached({ knownRun: 30, rounds: 9, deferred: 1 }, 25, 6), false, 'a deferred See-more post waits');
  assert.equal(V.knownRunReached({ knownRun: 99, rounds: 99 }, 0, 6), false, 'K=0 disables');
});

// Drive the real V.collect over a stub feed, round by round, with the same stop decision start() uses.
const H = 3600e3;
const ago = (ms) => { const h = Math.round(ms / H); return h < 24 ? `${Math.max(1, h)}h` : `${Math.floor(h / 24)}d`; };
const mkArt = (id, ageMs, pinned = false) => {
  const a = { innerText: `Poster ${id}\n${pinned ? 'Featured\n' : ''}${ago(ageMs)}\nnice house in the rice fields`, parentElement: null, querySelector: () => null };
  const l = { href: `https://www.facebook.com/groups/1/posts/${id}/`, innerText: ago(ageMs), closest: () => a };
  a.querySelectorAll = (sel) => (sel === 'a[href]' ? [l] : []);
  return a;
};
const feedArts = [];
const feed = { querySelectorAll: (sel) => (sel === '[role="article"]' ? feedArts : []) };
document.querySelector = (sel) => (sel === '[role="feed"]' ? feed : null);
const runSim = async (scrollOrder, { preload = [], cutoff, minRounds = 6, minPosts = 0, perRound = 7, knownRun } = {}) => {
  V.mem = {}; V.tries = {}; feedArts.length = 0; V.preload(preload);
  const preloaded = Object.values(V.mem).filter((p) => p.pre).length;
  V.knownRunK = preloaded >= V.KNOWN_PRELOAD_MIN ? (knownRun ?? V.KNOWN_RUN_K) : 0;
  V.state = { rounds: 0, pastRounds: 0, knownRun: 0, knownRunMax: 0, total: 0, pinnedSkipped: 0, stopReason: null };
  V.runSeen = new Set(); V.frontierDates = [];
  for (let i = 0; i < scrollOrder.length; i += perRound) {
    feedArts.push(...scrollOrder.slice(i, i + perRound).map((p) => mkArt(p.id, p.age, p.pinned)));
    const r = await V.collect('1', 'g');
    const s = V.state;
    s.rounds++; s.total = r.total; s.deferred = r.deferred; s.frontier = r.frontier;
    s.pastRounds = r.frontier && r.frontier.slice(0, 10) < cutoff ? s.pastRounds + 1 : 0;
    const why = V.stopReasonOf(s, { cutoff, minRounds, minPosts, knownRunK: V.knownRunK });
    if (why) { s.stopReason = why; break; }
  }
  return { ...V.state, seen: V.runSeen.size };
};

// last_done yesterday minus 2 days, as runbooks/NIGHTLY.md builds the incremental cutoff
const cutoffInc = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
// Incremental, busy group: 2 pinned known posts on top, ~26 h of new posts (90, one every ~17 min) with every 4th slot a
// resurfaced OLD known post (8–60 days), then last night's harvest and older — all known — down to 5 days.
const known = [9001, 9002];
const order = [{ id: 9001, age: 40 * 86400e3, pinned: true }, { id: 9002, age: 90 * 86400e3, pinned: true }];
let nid = 5000, oid = 100, slot = 0;
for (let k = 0; k < 90; k++) {
  if (++slot % 4 === 0) { const id = 9100 + k; known.push(id); order.push({ id, age: (8 + (k % 50)) * 86400e3 }); }
  order.push({ id: nid++, age: (k + 1) * 17 * 60e3 });
}
const boundary = order.length;
for (let k = 0; k < 400; k++) { const id = oid++; known.push(id); order.push({ id, age: 26 * H + k * 15 * 60e3 }); } // 400 known, 26 h → ~126 h
for (let k = 0; k < 200; k++) known.push(20000 + k); // more preloaded ids not in view

test('incremental run stops on known-run soon after the caught-up boundary, with every new post collected', async () => {
  const inc = await runSim(order, { preload: known, cutoff: cutoffInc });
  assert.equal(inc.stopReason, 'known-run');
  assert.ok(inc.seen - boundary >= 25 && inc.seen - boundary <= 25 + 7, 'stops within one round of 25 known in a row');
  assert.ok(inc.rounds <= Math.ceil((boundary + 25) / 7) + 1, 'only a few rounds past the caught-up boundary');
  for (let k = 5000; k < 5090; k++) assert.ok(V.mem[k] && !V.mem[k].pre && V.mem[k].text, 'every new post collected before the stop');
  // the same feed on the frontier path alone (known-run off) needs far more rounds
  const incF = await runSim(order, { preload: known, cutoff: cutoffInc, knownRun: 0 });
  assert.equal(incF.stopReason, 'frontier');
  assert.ok(incF.rounds >= 2 * inc.rounds, 'known-run ends the catch-up much sooner');
});

test('resurfaced old known posts never chain into a premature known-run among new posts', async () => {
  const head = await runSim(order.slice(0, boundary), { preload: known, cutoff: cutoffInc });
  assert.equal(head.stopReason, null);
  assert.ok(head.knownRunMax < 3, 'interleaved old posts stay short runs');
});

test('a first harvest (no or small preload) keeps known-run disarmed', async () => {
  const first = await runSim(order.map((p) => ({ ...p })), { preload: [], cutoff: new Date(Date.now() - 4 * 86400e3).toISOString().slice(0, 10), minRounds: 25, minPosts: 150 });
  assert.equal(V.knownRunK, 0);
  assert.notEqual(first.stopReason, 'known-run');
  assert.equal(first.knownRunMax, 0);
  const small = await runSim(order, { preload: Array.from({ length: 40 }, (_, k) => 100 + k), cutoff: cutoffInc });
  assert.equal(V.knownRunK, 0);
  assert.ok(small.knownRunMax >= 40, 'the 40 small-preload posts were a run');
  assert.notEqual(small.stopReason, 'known-run', 'small preload (<50) keeps known-run off');
});

test('stop() and status() expose the fields the babysitter polls', () => {
  V.state = { ...V.state, running: true, stopReason: null };
  V.stop();
  assert.equal(V.state.stopReason, 'manual');
  const st = V.status();
  for (const k of ['version', 'ver', 'cutoff', 'minRounds', 'minPosts', 'rounds', 'total', 'frontier', 'pastRounds', 'pinnedSkipped', 'stopReason', 'knownRun', 'knownRunMax', 'knownRunK', 'pending', 'visible', 'path']) assert.ok(k in st, 'status has ' + k);
  assert.equal(st.version, 6);
  assert.equal(st.ver, '6.1');
});
