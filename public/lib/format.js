// Listing descriptions arrive as scraped agency prose: markdown leftovers (`**bold**`,
// `* bullet`), HTML entities, and sentences glued together by a missing space. This module
// turns that into safe, readable HTML. Every string goes through esc() before it becomes
// markup — nothing the scraper wrote is ever trusted as HTML.

import { esc, raw } from './ui.js';

// Only the entities the agency CMSes actually emit; anything else is left alone.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '·', middot: '·', deg: '°',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç',
  ouml: 'ö', uuml: 'ü', auml: 'ä', ntilde: 'ñ', iuml: 'ï', euro: '€', pound: '£',
};

/** Decode the handful of entities we see. Safe: the result is escaped again before output. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#\d{1,6}|#[xX][0-9a-fA-F]{1,5}|[a-zA-Z][a-zA-Z0-9]{1,8});/g, (match, code) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff) return match;
      try {
        return String.fromCodePoint(point);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code];
    return named === undefined ? match : named;
  });
}

/** "beaches.Both" → "beaches. Both". A period with no space before a capital. */
function spaceGluedSentences(text) {
  return text.replace(/([a-z0-9])\.([A-Z])/g, '$1. $2');
}

/**
 * Keep matched `**bold**` pairs, drop every other asterisk (Kibarer ships
 * `**Property Highlights:***` and lone `*` bullets mid-line).
 */
function dropStrayAsterisks(text) {
  const pair = /\*\*([^*]+)\*\*/;
  let rest = text;
  let out = '';
  let match = pair.exec(rest);
  while (match) {
    out += `${rest.slice(0, match.index).replace(/\*/g, '')}**${match[1]}**`;
    rest = rest.slice(match.index + match[0].length);
    match = pair.exec(rest);
  }
  return out + rest.replace(/\*/g, '');
}

function clean(text) {
  return dropStrayAsterisks(spaceGluedSentences(text)).replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Pure: split a raw description into render-ready blocks.
 * Paragraph text and list items keep their `**bold**` pairs; everything else is cleaned.
 * @param {string} text
 * @returns {Array<{type:'p', text:string}|{type:'ul', items:string[]}>}
 */
export function descriptionBlocks(text) {
  const lines = decodeEntities(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let list = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const bullet = /^[*•-]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      const item = clean(bullet[1]);
      if (!item) continue;
      if (!list) {
        list = { type: 'ul', items: [] };
        blocks.push(list);
      }
      list.items.push(item);
      continue;
    }

    const paragraph = clean(trimmed);
    if (!paragraph) continue;
    list = null; // a paragraph closes the run of bullets; blank lines alone do not
    blocks.push({ type: 'p', text: paragraph });
  }

  return blocks;
}

/** Pure: escape, then turn the surviving `**pairs**` into <strong>. */
export function inlineHtml(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, (_, inner) => `<strong>${inner}</strong>`);
}

/** A scraped description as safe HTML, ready to drop into an html`` template. */
export function formatDescription(text) {
  const blocks = descriptionBlocks(text);
  if (!blocks.length) return raw('');
  return raw(
    blocks
      .map((b) =>
        b.type === 'ul'
          ? `<ul class="desc-list">${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`
          : `<p>${inlineHtml(b.text)}</p>`
      )
      .join('')
  );
}

export default { formatDescription, descriptionBlocks, inlineHtml, decodeEntities };
