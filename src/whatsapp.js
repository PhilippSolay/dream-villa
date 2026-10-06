// WhatsApp "Export chat" → posts for POST /api/import/posts (source 'wa').
//
// An export is a folder (or the zip WhatsApp shares) holding one chat text file —
// `_chat.txt` on iOS, `WhatsApp Chat with <group>.txt` on Android — plus the media
// files when the person chose "Attach media". Only the text file and the image
// files are read here; videos, voice notes, documents and contact cards are ignored.
//
// Line shapes seen in real exports (2026-09, iOS 26; Android from memory):
//   iOS:     ‎[16/9/26, 08:24:52] Aaqib: ‎<attached: 00000017-PHOTO-2026-09-16-08-24-52.jpg>
//            [9/9/26, 11:53:10] Nik Toth - Bali: My gorgeous 2 bedroom ...   (text continues
//            on the following lines, which carry no timestamp)
//            ‎[14/6/26, 13:19:19] Aaqib: ‎image omitted                        (media not exported)
//            [14/6/26, 17:36:06] ‎+48 692 351 001‎: heeey ... ‎<This message was edited>
//            [18/10/25, 10:32:39] Aaqib: ‎Aaqib created this group               (system: text
//            starts with a left-to-right mark)
//            [10/9/26, 08:03:22] ~ Shaiden Valentine:                            (empty message
//            WhatsApp emits right before an attachment)
//   Android: 16/09/26, 08:24 - Aaqib: IMG-20260916-WA0017.jpg (file attached)
//            16/09/26, 08:24 - Aaqib: <Media omitted>
//            16/09/26, 08:24 - Aaqib added +62 812 ...                          (system: no "Name: ")
// Invisible bidi marks (U+200E/F, U+202A–E, U+2066–9) wrap names, numbers and system
// text; narrow no-break spaces sit before AM/PM and inside numbers. Both are
// normalised away before anything is matched.
//
// A WhatsApp "post" is rarely one message: people send the text, then the photos,
// one message each, within seconds. bundlePosts joins a sender's consecutive
// messages (nothing from anyone else in between, each within `gapMinutes` of the
// previous) into one post whose gallery is the attached images, in order.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const MARKS_RE = /[‎‏‪-‮⁦-⁩]/g;
const ODD_SPACES_RE = /[   ]/g;
const ODD_HYPHENS_RE = /[‐‑‒–]/g;

// [d/m/yy, HH:MM:SS] rest   |   [d/m/yy, h:MM:SS PM] rest   (iOS)
const IOS_HEADER_RE =
  /^\[(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s?([AaPp]\.?\s?[Mm]\.?)?\]\s?(.*)$/;
// d/m/yy, HH:MM - rest   |   d/m/yy, h:MM PM - rest   (Android)
const ANDROID_HEADER_RE =
  /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s?([AaPp]\.?\s?[Mm]\.?)?\s[-–—]\s(.*)$/;

const ATTACHED_IOS_RE = /<attached:\s*([^>]+?)\s*>/g;
const ATTACHED_ANDROID_RE = /(?:^|\s)(\S+\.[A-Za-z0-9]{2,5})\s\(file attached\)/g;
const OMITTED_RE = /(?:^|\s)(?:image|video|audio|sticker|document|GIF|Contact card|Media)\s+omitted\.?(?=\s|$)|<Media omitted>/gi;
const EDITED_RE = /\s*<This message was edited>\s*/g;
const DELETED_RE = /^(?:This message was deleted\.?|You deleted this message\.?)$/i;

const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp)$/i;
const PHONE_SENDER_RE = /^\+?[\d\s\-().]{7,}$/;

export const DEFAULT_GAP_MINUTES = 3;
export const DEFAULT_TZ_OFFSET = '+08:00'; // the phones live in Asia/Makassar
const MAX_TEXT_LENGTH = 8000; // POST /api/import/posts schema
const MAX_IMAGES_PER_POST = 15; // same route's images_b64 cap
const MAX_IMAGE_BYTES = 600 * 1024; // same route's decoded-size cap

// ---------------------------------------------------------------------------
// Lines → messages
// ---------------------------------------------------------------------------

function cleanLine(line) {
  return line.replace(/\r$/, '').replace(ODD_SPACES_RE, ' ');
}

function stripMarks(s) {
  return String(s || '').replace(MARKS_RE, '');
}

function matchHeader(line) {
  // iOS puts a mark BEFORE the bracket on attachment/system lines.
  const bare = line.replace(/^[‎‏]+/, '');
  let m = IOS_HEADER_RE.exec(bare);
  if (m) return { m, style: 'ios' };
  m = ANDROID_HEADER_RE.exec(bare);
  if (m) return { m, style: 'android' };
  return null;
}

function toMinutes(offset) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(offset || '').trim());
  if (!m) throw new Error(`bad tz offset: ${offset}`);
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** Local wall-clock parts (phone time) → ISO string in UTC. */
function toIso({ year, month, day, hour, minute, second }, tzMinutes) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second) - tzMinutes * 60_000;
  const d = new Date(utc);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function hour24(h, ampm) {
  let hour = Number(h);
  if (!ampm) return hour;
  const pm = /p/i.test(ampm);
  if (pm && hour < 12) hour += 12;
  if (!pm && hour === 12) hour = 0;
  return hour;
}

/** "d/m" unless some header only makes sense as "m/d" (second field over 12 and never the first). */
function detectDayFirst(headers) {
  let firstOver12 = false;
  let secondOver12 = false;
  for (const { m } of headers) {
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (firstOver12) return true;
  if (secondOver12) return false;
  return true;
}

/** Sender name as a person would write it: no marks, no "~ " non-contact prefix, plain hyphens. */
function cleanSender(raw) {
  return stripMarks(raw)
    .replace(ODD_HYPHENS_RE, '-')
    .replace(/^~\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Digits of a phone-number sender ("+62 821-4607-9766" → "6282146079766"), else null. */
export function phoneFromSender(sender) {
  const s = String(sender || '').trim();
  if (!PHONE_SENDER_RE.test(s)) return null;
  const digits = s.replace(/\D+/g, '');
  return digits.length >= 8 ? digits : null;
}

function splitSenderText(rest) {
  // "Sender: text", "Sender:" (empty message) — the first ": " (or a trailing ":") ends the name.
  const m = /^(.*?):(?: |$)([\s\S]*)$/.exec(rest);
  if (!m) return null;
  return { sender: m[1], text: m[2] };
}

function finishMessage(msg) {
  const rawText = msg.text;
  // iOS marks system text ("Aaqib created this group") with a leading mark; attachment
  // and "omitted" messages carry one too, so those are told apart below.
  const leadingMark = /^[\u200e\u200f]/.test(rawText);
  const attachments = [];
  let text = stripMarks(rawText);
  text = text.replace(ATTACHED_IOS_RE, (_, name) => {
    attachments.push(name.trim());
    return ' ';
  });
  text = text.replace(ATTACHED_ANDROID_RE, (_, name) => {
    attachments.push(name.trim());
    return ' ';
  });
  let omitted = false;
  text = text.replace(OMITTED_RE, () => {
    omitted = true;
    return ' ';
  });
  let edited = false;
  text = text.replace(EDITED_RE, () => {
    edited = true;
    return ' ';
  });
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const deleted = DELETED_RE.test(text);
  let system = msg.system;
  if (!system && !attachments.length && !omitted && !deleted && leadingMark && text) system = true;

  return {
    ts: msg.ts,
    sender: msg.sender,
    text,
    attachments,
    omitted,
    edited,
    deleted,
    system,
  };
}

/**
 * Parse a chat export's text into messages, in file order.
 * @param {string} content the whole text file
 * @param {{tzOffset?: string}} [opts] the phone's UTC offset, default +08:00
 * @returns {Array<{ts: string, sender: string|null, text: string, attachments: string[], omitted: boolean, edited: boolean, deleted: boolean, system: boolean}>}
 */
export function parseChat(content, { tzOffset = DEFAULT_TZ_OFFSET } = {}) {
  const tzMinutes = toMinutes(tzOffset);
  const lines = String(content || '').replace(/^﻿/, '').split('\n').map(cleanLine);

  const headers = [];
  for (const line of lines) {
    const h = matchHeader(line);
    if (h) headers.push(h);
  }
  const dayFirst = detectDayFirst(headers);

  const messages = [];
  let current = null;
  for (const line of lines) {
    const h = matchHeader(line);
    if (!h) {
      if (current) current.text += `\n${line}`;
      continue;
    }
    if (current) messages.push(finishMessage(current));

    const { m, style } = h;
    const a = Number(m[1]);
    const b = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const parts = {
      year,
      month: dayFirst ? b : a,
      day: dayFirst ? a : b,
      hour: hour24(m[4], m[7]),
      minute: Number(m[5]),
      second: m[6] ? Number(m[6]) : 0,
    };
    const ts = toIso(parts, tzMinutes);
    const rest = m[8];
    const split = splitSenderText(rest);
    if (!ts) {
      current = null;
      continue;
    }
    if (!split) {
      // No "Name: " — a system line (Android style, "Aaqib added +62 …").
      current = { ts, sender: null, text: rest, system: true, style };
    } else {
      current = { ts, sender: cleanSender(split.sender), text: split.text, system: false, style };
    }
  }
  if (current) messages.push(finishMessage(current));
  return messages;
}

// ---------------------------------------------------------------------------
// Messages → bundles (one person's burst) → posts
// ---------------------------------------------------------------------------

/**
 * Join each sender's consecutive burst of messages into one bundle. System and
 * deleted messages are dropped and do not break a burst.
 * @returns {Array<{ts: string, sender: string, texts: string[], images: string[], files: string[], count: number}>}
 */
export function bundlePosts(messages, { gapMinutes = DEFAULT_GAP_MINUTES } = {}) {
  const gapMs = gapMinutes * 60_000;
  const bundles = [];
  let current = null;
  let lastMs = 0;
  for (const msg of messages) {
    if (msg.system || msg.deleted || !msg.sender) continue;
    const ms = Date.parse(msg.ts);
    const continues = current && current.sender === msg.sender && Math.abs(ms - lastMs) <= gapMs;
    if (!continues) {
      current = { ts: msg.ts, sender: msg.sender, texts: [], images: [], files: [], count: 0 };
      bundles.push(current);
    }
    current.count += 1;
    if (msg.text) current.texts.push(msg.text);
    for (const name of msg.attachments) {
      if (IMAGE_EXT_RE.test(name)) current.images.push(name);
      else current.files.push(name);
    }
    lastMs = ms;
  }
  return bundles;
}

export function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function compactTs(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Bundles → the post shape POST /api/import/posts takes (images still as file
 * names under `image_files`; attachImages fills images_b64 from the export dir).
 *
 * Skips bundles older than `since` and bundles with no text at all (a photo-only
 * burst says nothing the classifier could read). Stats count what was dropped.
 *
 * post_id is stable across re-exports of the same chat (group id + first
 * message time + sender), so a re-import updates the row rather than duplicating it.
 */
export function postsFromBundles(bundles, { groupId, groupName = null, since = null } = {}) {
  if (!groupId) throw new Error('groupId is required');
  const sinceMs = since ? Date.parse(since) : null;
  const stats = { bundles: bundles.length, before_cutoff: 0, no_text: 0, posts: 0 };
  const posts = [];
  for (const b of bundles) {
    if (sinceMs != null && Date.parse(b.ts) < sinceMs) {
      stats.before_cutoff += 1;
      continue;
    }
    const text = b.texts.join('\n\n').trim();
    if (!text) {
      stats.no_text += 1;
      continue;
    }
    const phone = phoneFromSender(b.sender);
    const senderSlug = phone || slug(b.sender) || 'unknown';
    const postId = `${groupId}:${compactTs(b.ts)}:${senderSlug}`;
    posts.push({
      post_id: postId,
      // A WhatsApp message has no permalink. A number-only sender at least gets a
      // tap-to-chat link; a named one gets a `wa:` locator the UI shows as text.
      url: phone ? `https://wa.me/${phone}` : `wa:${postId}`,
      posted_at: b.ts,
      text: text.slice(0, MAX_TEXT_LENGTH),
      poster_name: b.sender,
      whatsapp: phone ? `+${phone}` : null,
      group_name: groupName,
      image_files: b.images.slice(0, MAX_IMAGES_PER_POST),
      message_count: b.count,
    });
  }
  stats.posts = posts.length;
  return { posts, stats };
}

// ---------------------------------------------------------------------------
// Images — the same 1600 px JPEG the gallery step makes, shrunk further only
// when the route's 600 KB decoded cap would otherwise reject it.
// ---------------------------------------------------------------------------

const IMAGE_STEPS = [
  [1600, 82],
  [1400, 72],
  [1200, 62],
  [1000, 55],
];

/** @returns {Promise<{data_base64: string, w: number, h: number}|null>} null when unreadable. */
export async function imageToBase64(file) {
  let input;
  try {
    input = fs.readFileSync(file);
  } catch {
    return null;
  }
  for (const [side, quality] of IMAGE_STEPS) {
    try {
      const { data, info } = await sharp(input)
        .rotate()
        .resize(side, side, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= MAX_IMAGE_BYTES) return { data_base64: data.toString('base64'), w: info.width, h: info.height };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fill `images_b64` on every post from the files named in `image_files`.
 * @returns {Promise<{attached: number, missing: number}>}
 */
export async function attachImages(posts, dir) {
  let attached = 0;
  let missing = 0;
  for (const post of posts) {
    const images = [];
    for (const name of post.image_files || []) {
      const img = await imageToBase64(path.join(dir, name));
      if (img) {
        images.push(img);
        attached += 1;
      } else {
        missing += 1;
      }
    }
    if (images.length) post.images_b64 = images;
  }
  return { attached, missing };
}

/** The post as the route's strict schema accepts it (no helper fields, no nulls it rejects). */
export function toApiPost(post) {
  const out = {
    post_id: post.post_id,
    url: post.url,
    posted_at: post.posted_at,
    text: post.text,
    poster_name: post.poster_name || null,
    group_name: post.group_name || null,
  };
  if (post.whatsapp) out.whatsapp = post.whatsapp;
  if (Array.isArray(post.images_b64) && post.images_b64.length) out.images_b64 = post.images_b64;
  return out;
}

// ---------------------------------------------------------------------------
// Opening an export
// ---------------------------------------------------------------------------

/** "WhatsApp Chat - Seseh x Cemagi_ Social Community 🤝🏽.zip" → "Seseh x Cemagi Social Community". */
export function groupNameFromFile(file) {
  let name = path.basename(file).replace(/\.zip$/i, '').replace(/\.txt$/i, '');
  name = name.replace(/^WhatsApp Chat (?:with|-)\s*/i, '').replace(/^_chat$/i, '');
  name = name.replace(/_/g, ' ');
  // Drop emoji and other symbols; keep letters (any script), digits and basic punctuation.
  name = name.replace(/[^\p{L}\p{N}\s.,'&()-]/gu, '');
  return name.replace(/\s+/g, ' ').trim() || null;
}

function findChatFile(dir) {
  const entries = fs.readdirSync(dir);
  if (entries.includes('_chat.txt')) return path.join(dir, '_chat.txt');
  const txt = entries.filter((e) => /\.txt$/i.test(e)).sort();
  if (txt.length) return path.join(dir, txt[0]);
  // A zip made of a folder unpacks to one nested directory.
  const dirs = entries.filter((e) => !e.startsWith('__MACOSX') && fs.statSync(path.join(dir, e)).isDirectory());
  if (dirs.length === 1) return findChatFile(path.join(dir, dirs[0]));
  throw new Error(`no chat text file found in ${dir}`);
}

/**
 * A zip is unpacked (with the system `unzip`) into a temp dir; a folder is used in
 * place. Returns the directory holding the media and the chat file, plus a cleanup.
 * @returns {{dir: string, chatFile: string, name: string|null, cleanup: () => void}}
 */
export function openExport(input) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    const chatFile = findChatFile(input);
    return { dir: path.dirname(chatFile), chatFile, name: groupNameFromFile(input) || groupNameFromFile(chatFile), cleanup() {} };
  }
  if (/\.zip$/i.test(input)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-wa-'));
    execFileSync('unzip', ['-o', '-q', input, '-d', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    const chatFile = findChatFile(tmp);
    return {
      dir: path.dirname(chatFile),
      chatFile,
      name: groupNameFromFile(input),
      cleanup() {
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }
  if (/\.txt$/i.test(input)) {
    return { dir: path.dirname(input), chatFile: input, name: groupNameFromFile(input), cleanup() {} };
  }
  throw new Error(`not a WhatsApp export (zip, folder or .txt): ${input}`);
}

/**
 * The whole pipeline minus network: export → posts (with images_b64 when
 * `images` is on). Cleans up any temp dir before returning.
 */
export async function postsFromExport(input, { groupId, groupName, since, gapMinutes, tzOffset, images = true } = {}) {
  const opened = openExport(input);
  try {
    const content = fs.readFileSync(opened.chatFile, 'utf8');
    const messages = parseChat(content, { tzOffset });
    const bundles = bundlePosts(messages, { gapMinutes });
    const name = groupName || opened.name;
    const id = groupId || slug(name);
    const { posts, stats } = postsFromBundles(bundles, { groupId: id, groupName: name, since });
    const imageStats = images ? await attachImages(posts, opened.dir) : { attached: 0, missing: 0 };
    return {
      posts,
      groupId: id,
      groupName: name,
      stats: {
        messages: messages.length,
        system: messages.filter((m) => m.system).length,
        deleted: messages.filter((m) => m.deleted).length,
        ...stats,
        images_attached: imageStats.attached,
        images_missing: imageStats.missing,
      },
    };
  } finally {
    opened.cleanup();
  }
}
