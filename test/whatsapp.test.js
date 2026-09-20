// src/whatsapp.js — WhatsApp "Export chat" → posts for /api/import/posts.
// The iOS sample mirrors a real export (2026-09, marks and all); Android from memory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import {
  parseChat, bundlePosts, postsFromBundles, attachImages, toApiPost,
  groupNameFromFile, openExport, postsFromExport, phoneFromSender, slug,
} from '../src/whatsapp.js';

const LRM = '‎';
const NNBSP = ' ';
const NBSP = ' ';

const IOS = [
  `[18/10/25, 10:32:39] Aaqib: ${LRM}Aaqib created this group`,
  `${LRM}[14/6/26, 13:19:19] Aaqib: ${LRM}image omitted`,
  `[14/6/26, 17:36:06] ‪+48${NBSP}692${NBSP}351${NBSP}001‬: heeey! do U know ${LRM}<This message was edited>`,
  `[10/9/26, 08:03:22] ~${NNBSP}Shaiden Valentine:`,
  `${LRM}[10/9/26, 08:03:23] ~${NNBSP}Shaiden Valentine: Hey all, a house in Seseh.`,
  '',
  `Second line. ${LRM}<attached: 00000002-PHOTO-2026-09-10-08-03-23.jpg>`,
  `${LRM}[10/9/26, 08:03:23] ~${NNBSP}Shaiden Valentine: ${LRM}<attached: 00000003-PHOTO-2026-09-10-08-03-23.jpg>`,
  `[16/6/26, 13:13:48] ‪+47${NBSP}401${NBSP}67${NBSP}162‬: ${LRM}This message was deleted.`,
  '[16/9/26, 08:21:40] Jasmine Oh: I would love to eat your veggies!',
  '[16/9/26, 08:24:30] Aaqib: Villa 3 bedrooms Seseh IDR 45.000.000/month',
  `${LRM}[16/9/26, 08:24:52] Aaqib: ${LRM}<attached: 00000017-PHOTO-2026-09-16-08-24-52.jpg>`,
  `${LRM}[16/9/26, 08:24:53] Aaqib: ${LRM}<attached: -0003409-Yanti Custom Sofa.vcf>`,
  `${LRM}[16/9/26, 08:30:00] Aaqib: ${LRM}<attached: 00000018-PHOTO.jpg>`,
].join('\r\n');

test('parseChat reads iOS lines: marks, multi-line text, attachments, omitted, edited, deleted, system', () => {
  const msgs = parseChat(IOS);
  assert.equal(msgs.length, 12);

  assert.equal(msgs[0].system, true);
  assert.equal(msgs[0].text, 'Aaqib created this group');

  assert.equal(msgs[1].omitted, true);
  assert.equal(msgs[1].text, '');
  assert.equal(msgs[1].system, false);

  assert.equal(msgs[2].sender, '+48 692 351 001');
  assert.equal(msgs[2].edited, true);
  assert.equal(msgs[2].text, 'heeey! do U know');

  assert.equal(msgs[3].sender, 'Shaiden Valentine');
  assert.equal(msgs[3].text, '');

  assert.equal(msgs[4].text, 'Hey all, a house in Seseh.\n\nSecond line.');
  assert.deepEqual(msgs[4].attachments, ['00000002-PHOTO-2026-09-10-08-03-23.jpg']);

  assert.equal(msgs[6].deleted, true);

  // 08:24:30 Asia/Makassar → 00:24:30 UTC
  assert.equal(msgs[8].ts, '2026-09-16T00:24:30.000Z');
  assert.equal(msgs[8].system, false);
});

test('parseChat reads Android lines, and month-first dates when a second field passes 12', () => {
  const android = [
    '16/09/26, 08:24 - Aaqib added +62 812 3456 7890',
    '16/09/26, 08:24 - Aaqib: Villa for rent',
    'second line',
    '16/09/26, 08:25 - Aaqib: IMG-20260916-WA0017.jpg (file attached)',
    '16/09/26, 08:26 - Aaqib: <Media omitted>',
  ].join('\n');
  const msgs = parseChat(android);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].system, true);
  assert.equal(msgs[0].sender, null);
  assert.equal(msgs[1].text, 'Villa for rent\nsecond line');
  assert.deepEqual(msgs[2].attachments, ['IMG-20260916-WA0017.jpg']);
  assert.equal(msgs[2].text, '');
  assert.equal(msgs[3].omitted, true);
  assert.equal(msgs[1].ts, '2026-09-16T00:24:00.000Z');

  const us = parseChat('9/14/26, 8:26 PM - Bob: hi\n9/2/26, 12:05 AM - Bob: night');
  assert.equal(us[0].ts, '2026-09-14T12:26:00.000Z');
  assert.equal(us[1].ts, '2026-09-01T16:05:00.000Z');
});

test('parseChat honours a different phone offset', () => {
  const msgs = parseChat('[16/9/26, 08:24:30] A: x', { tzOffset: '+01:00' });
  assert.equal(msgs[0].ts, '2026-09-16T07:24:30.000Z');
});

test('bundlePosts joins one sender’s burst; other senders and long gaps break it; system/deleted are dropped', () => {
  const bundles = bundlePosts(parseChat(IOS));
  assert.deepEqual(
    bundles.map((b) => [b.sender, b.count, b.texts.length, b.images.length, b.files.length]),
    [
      ['Aaqib', 1, 0, 0, 0], // image omitted, alone
      ['+48 692 351 001', 1, 1, 0, 0],
      ['Shaiden Valentine', 3, 1, 2, 0], // empty + text/photo + photo
      ['Jasmine Oh', 1, 1, 0, 0],
      ['Aaqib', 3, 1, 1, 1], // text, photo, vcf within 3 min
      ['Aaqib', 1, 0, 1, 0], // 08:30 — past the gap
    ]
  );
  assert.equal(bundles[2].ts, '2026-09-10T00:03:22.000Z');
});

test('postsFromBundles applies the cutoff, drops photo-only bursts, and builds stable ids/urls', () => {
  const bundles = bundlePosts(parseChat(IOS));
  const { posts, stats } = postsFromBundles(bundles, { groupId: 'test-group', groupName: 'Test', since: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(stats, { bundles: 6, before_cutoff: 2, no_text: 1, posts: 3 });

  const [shaiden, jasmine, aaqib] = posts;
  assert.equal(jasmine.poster_name, 'Jasmine Oh');
  assert.equal(shaiden.post_id, 'test-group:20260910T000322Z:shaiden-valentine');
  assert.equal(shaiden.url, 'wa:test-group:20260910T000322Z:shaiden-valentine');
  assert.equal(shaiden.poster_name, 'Shaiden Valentine');
  assert.equal(shaiden.whatsapp, null);
  assert.deepEqual(shaiden.image_files, ['00000002-PHOTO-2026-09-10-08-03-23.jpg', '00000003-PHOTO-2026-09-10-08-03-23.jpg']);
  assert.equal(shaiden.group_name, 'Test');

  assert.equal(aaqib.post_id, 'test-group:20260916T002430Z:aaqib');
  assert.equal(aaqib.posted_at, '2026-09-16T00:24:30.000Z');
  assert.equal(aaqib.text, 'Villa 3 bedrooms Seseh IDR 45.000.000/month');
  assert.deepEqual(aaqib.image_files, ['00000017-PHOTO-2026-09-16-08-24-52.jpg']);

  // A number-only sender gets a tap-to-chat link and a whatsapp field.
  const phone = postsFromBundles(bundles, { groupId: 'g' }).posts.find((p) => p.poster_name === '+48 692 351 001');
  assert.equal(phone.url, 'https://wa.me/48692351001');
  assert.equal(phone.whatsapp, '+48692351001');
  assert.equal(phone.post_id, 'g:20260614T093606Z:48692351001');
});

test('toApiPost keeps only what the route schema accepts', () => {
  const p = toApiPost({ post_id: 'a', url: 'wa:a', posted_at: 't', text: 'x', poster_name: 'A', whatsapp: null, group_name: null, image_files: ['f'], message_count: 2, images_b64: [] });
  assert.deepEqual(p, { post_id: 'a', url: 'wa:a', posted_at: 't', text: 'x', poster_name: 'A', group_name: null });
});

test('helpers: phoneFromSender, slug, groupNameFromFile', () => {
  assert.equal(phoneFromSender('+62 821-4607-9766'), '6282146079766');
  assert.equal(phoneFromSender('Nik Toth - Bali'), null);
  assert.equal(slug('Seseh x Cemagi: Social Community 🤝🏽'), 'seseh-x-cemagi-social-community');
  assert.equal(groupNameFromFile('/x/WhatsApp Chat - Seseh x Cemagi_ Social Community 🤝🏽.zip'), 'Seseh x Cemagi Social Community');
  assert.equal(groupNameFromFile('WhatsApp Chat with Bali Villas.txt'), 'Bali Villas');
  assert.equal(groupNameFromFile('_chat.txt'), null);
});

test('attachImages reads the export’s photos as base64 JPEGs and counts missing ones; postsFromExport ties it together', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-wa-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jpg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#c9a227' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(dir, '00000017-PHOTO-2026-09-16-08-24-52.jpg'), jpg);
  fs.writeFileSync(path.join(dir, '_chat.txt'), IOS);

  const posts = [{ image_files: ['00000017-PHOTO-2026-09-16-08-24-52.jpg', 'missing.jpg'] }, { image_files: [] }];
  const stats = await attachImages(posts, dir);
  assert.deepEqual(stats, { attached: 1, missing: 1 });
  assert.equal(posts[0].images_b64.length, 1);
  assert.equal(posts[0].images_b64[0].w, 1600);
  assert.equal(posts[0].images_b64[0].h, 800);
  const decoded = Buffer.from(posts[0].images_b64[0].data_base64, 'base64');
  assert.ok(decoded.length > 0 && decoded.length <= 600 * 1024);
  assert.equal(posts[1].images_b64, undefined);

  const opened = openExport(dir);
  assert.equal(opened.chatFile, path.join(dir, '_chat.txt'));

  const result = await postsFromExport(dir, { groupId: 'g', groupName: 'G', since: '2026-09-01T00:00:00.000Z' });
  assert.equal(result.stats.messages, 12);
  assert.equal(result.stats.posts, 3);
  assert.equal(result.stats.images_attached, 1);
  assert.equal(result.stats.images_missing, 2);
  assert.equal(result.posts[2].images_b64.length, 1);
});
