// The duplicate scorer's fast paths must give the answers the plain helpers give:
// hashWords/hammingWords vs hamming, diceProfiles vs diceTrigram, countSharedImages vs
// sharedImages, and the pruned all-pairs pass vs scorePair over every pair.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { diceTrigram, trigramProfile, diceProfiles } from '../src/scrape/dedupe.js';
import { hamming, hashWords, hammingWords, sharedImages, imageKeys, countSharedImages } from '../src/scrape/image-hash.js';
import { allCandidates, allCandidatesAsync, candidatesFor, loadContext, scorePair } from '../src/scrape/duplicates.js';

// mulberry32: the same numbers on every run.
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(7);
const hex16 = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
/** A hash `bits` flips away from `h`. */
function flip(h, bits) {
  const words = [...h].map((c) => parseInt(c, 16));
  for (let k = 0; k < bits; k++) {
    const i = Math.floor(rnd() * 16);
    words[i] ^= 1 << Math.floor(rnd() * 4);
  }
  return words.map((w) => w.toString(16)).join('');
}

test('hammingWords agrees with hamming, malformed hashes included', () => {
  for (let k = 0; k < 2000; k++) {
    const a = hex16();
    const b = k % 3 ? flip(a, Math.floor(rnd() * 10)) : hex16();
    assert.equal(hammingWords(hashWords(a), hashWords(b)), hamming(a, b), `${a} ${b}`);
  }
  assert.equal(hashWords('ABCDEF0123456789')?.length, 2);
  assert.equal(hammingWords(hashWords('ABCDEF0123456789'), hashWords('abcdef0123456789')), 0);
  for (const bad of [null, '', 'abc', 'zzzzzzzzzzzzzzzz', '0123456789abcdef0']) assert.equal(hashWords(bad), null);
});

test('diceProfiles agrees with diceTrigram', () => {
  const titles = [
    '', 'A', 'ab', 'abc', 'Modern 2 Bedroom Villa in Cemagi', 'modern 2-bedroom villa, Cemagi!',
    'Joglo with rice field view', 'JOGLO — rice-field view', 'aaaa aaaa', 'aaa', '  ', 'Villa Ümit 3BR',
    'Tropical 3 Bedroom Villa in Pererenan', 'Tropical Three Bedroom Villa Pererenan',
  ];
  for (const a of titles) {
    for (const b of titles) {
      assert.equal(diceProfiles(trigramProfile(a), trigramProfile(b)), diceTrigram(a, b), `${a} | ${b}`);
    }
  }
});

test('countSharedImages agrees with sharedImages(...).count', () => {
  for (let k = 0; k < 300; k++) {
    const base = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => ({ src_url: `https://x.test/${Math.floor(rnd() * 40)}.jpg`, hash: hex16() }));
    const other = base
      .filter(() => rnd() < 0.5)
      .map((im) => ({ src_url: rnd() < 0.3 ? im.src_url : `https://y.test/${Math.floor(rnd() * 1e6)}.jpg`, hash: rnd() < 0.2 ? null : flip(im.hash, Math.floor(rnd() * 9)) }))
      .concat(Array.from({ length: Math.floor(rnd() * 6) }, () => ({ src_url: null, hash: hex16() })));
    assert.equal(countSharedImages(imageKeys(base), imageKeys(other)), sharedImages(base, other).count);
  }
});

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-dupfast-'));
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('the pruned all-pairs pass finds exactly what scorePair finds over every pair', (t) => {
  const db = tmpDb(t);
  const areas = ['cemagi', 'seseh', 'pererenan'];
  const ins = db.prepare(`INSERT INTO properties (key, ref, source, url, title, description, area, bedrooms,
      price_month_idr, land_m2, build_m2, lat, lng, availability, first_seen, last_seen, images, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const originals = [];
  for (let i = 0; i < 160; i++) {
    const copy = originals.length && rnd() < 0.35 ? originals[Math.floor(rnd() * originals.length)] : null;
    const hashes = copy ? copy.hashes.map((h) => flip(h, Math.floor(rnd() * 5))) : Array.from({ length: 4 }, hex16);
    const title = copy && rnd() < 0.6 ? copy.title : `Villa ${['Sunset', 'Padi', 'Tropis', 'Joglo'][i % 4]} ${i % 7} ${areas[i % 3]}`;
    const desc = copy && rnd() < 0.5 ? copy.desc : `Listing ${i} with a pool and a garden ${rnd()}`;
    const row = {
      beds: copy ? copy.beds : 1 + (i % 3),
      area: copy && rnd() < 0.7 ? copy.area : areas[Math.floor(rnd() * 3)],
      price: copy ? Math.round(copy.price * (0.93 + rnd() * 0.14)) : Math.round(30e6 + rnd() * 20e6),
      land: copy && rnd() < 0.5 ? copy.land : 200 + Math.floor(rnd() * 5),
      lat: copy && rnd() < 0.5 ? copy.lat : -8.65 + rnd() * 0.01,
      lng: copy && rnd() < 0.5 ? copy.lng : 115.1 + rnd() * 0.01,
      hashes, title, desc,
    };
    // Same source, same stem, other letter now and then: the complex-unit rule must bite too.
    ins.run(`s:${i}`, `RF${100 + (i % 50)}${'AB'[Math.floor(i / 2) % 2]}`, i % 2 ? 'bhi' : 'fb', `https://s.test/${i}`, title, desc,
      row.area, row.beds, row.price, row.land, null, row.lat, row.lng, 'available', '2026-09-01', '2026-09-01',
      JSON.stringify(hashes.map((h, n) => ({ src_url: `https://s.test/${i}/${n}.jpg`, hash: h }))), '{}');
    if (!copy) originals.push(row);
  }

  const ctx = loadContext(db);
  for (const minScore of [0.3, 0.5, 0.6]) {
    const brute = [];
    for (let i = 0; i < ctx.rows.length; i++) {
      for (let j = i + 1; j < ctx.rows.length; j++) {
        const s = scorePair(ctx.rows[i], ctx.rows[j], ctx);
        const pa = ctx.rows[i].price_month_idr;
        const pb = ctx.rows[j].price_month_idr;
        const inBand = Math.abs(pa - pb) / Math.max(pa, pb) <= 0.15; // allCandidates' ±15 % prefilter
        if (s && s.score >= minScore && inBand) brute.push({ a: ctx.rows[i].id, b: ctx.rows[j].id, score: s.score, reasons: s.reasons });
      }
    }
    brute.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
    assert.ok(brute.length > 5, `the fixture should produce pairs at ${minScore}`);
    assert.deepEqual(allCandidates(db, { limit: 1e6, minScore, ctx }), brute, `minScore ${minScore}`);

    const id = brute[0].a;
    const mine = brute
      .filter((p) => p.a === id || p.b === id)
      .map((p) => ({ a: id, b: p.a === id ? p.b : p.a, score: p.score, reasons: p.reasons }))
      .sort((x, y) => y.score - x.score || x.b - y.b);
    // candidatesFor orders reasons from `id`'s side; compare the pairs and scores.
    assert.deepEqual(
      candidatesFor(db, id, { limit: 1e6, minScore, ctx }).map(({ b, score }) => [b, score]),
      mine.map(({ b, score }) => [b, score])
    );
  }
});

test('allCandidates scores a context once: a higher bar is answered from the lower list', (t) => {
  const db = tmpDb(t);
  const images = JSON.stringify([{ src_url: 'https://cdn.test/same.jpg' }]);
  const ins = db.prepare(`INSERT INTO properties (key, ref, source, url, title, area, bedrooms, price_month_idr,
      availability, first_seen, last_seen, images, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('a:1', 'A1', 'bhi', 'https://a.test/1', 'Villa One', 'cemagi', 2, 40e6, 'available', '2026-09-01', '2026-09-01', images, '{}');
  ins.run('b:2', 'B2', 'fb', 'https://b.test/2', 'Villa One', 'cemagi', 2, 40e6, 'available', '2026-09-01', '2026-09-01', images, '{}');
  const ctx = loadContext(db);

  const low = allCandidates(db, { minScore: 0.3, ctx });
  assert.equal(low.length, 1);
  // A pair nobody would score again: the memo, not a second pass, answers these.
  ctx.rows.length = 0;
  assert.deepEqual(allCandidates(db, { minScore: 0.3, ctx }), low);
  assert.deepEqual(allCandidates(db, { minScore: 0.6, ctx }), low.filter((p) => p.score >= 0.6));
  assert.deepEqual(allCandidates(db, { minScore: 0.2, ctx }), [], 'a lower bar than any list scored runs a new pass');
});

test('allCandidatesAsync: the same list, other work runs mid-pass, and callers share one pass', async (t) => {
  const db = tmpDb(t);
  const ins = db.prepare(`INSERT INTO properties (key, ref, source, url, title, description, area, bedrooms,
      price_month_idr, availability, first_seen, last_seen, images, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // 700 two-bedroom listings inside one price band: ~245 000 pairs, well past one slice.
  for (let i = 0; i < 700; i++) {
    const twin = i % 50 === 1; // every 50th listing re-posts the one before it
    const n = twin ? i - 1 : i;
    ins.run(`s:${i}`, `R${i}`, i % 2 ? 'bhi' : 'fb', `https://s.test/${i}`, `Villa ${n} Cemagi ${n * 7}`,
      `Listing ${n}`, 'cemagi', 2, 40e6 + (i % 13) * 1e5, 'available', '2026-09-01', '2026-09-01',
      JSON.stringify([{ src_url: `https://s.test/${n}.jpg` }]), '{}');
  }
  const expected = allCandidates(db, { limit: 1e6, minScore: 0.6, ctx: loadContext(db) });
  assert.ok(expected.length >= 10);

  const ctx = loadContext(db);
  let ranMidPass = false;
  let done = false;
  const timer = new Promise((resolve) => setImmediate(() => { ranMidPass = !done; resolve(); }));
  const [first, second] = await Promise.all([
    allCandidatesAsync(db, { limit: 1e6, minScore: 0.6, ctx }).then((r) => { done = true; return r; }),
    allCandidatesAsync(db, { limit: 1e6, minScore: 0.7, ctx }),
    timer,
  ]);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected.filter((p) => p.score >= 0.7), 'a higher bar joins the running pass');
  assert.ok(ranMidPass, 'a callback queued at the start ran before the pass finished');

  ctx.rows.length = 0; // remembered: no second pass
  assert.deepEqual(await allCandidatesAsync(db, { limit: 5, minScore: 0.6, ctx }), expected.slice(0, 5));
});
