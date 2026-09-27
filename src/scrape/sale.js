// SPEC §2 — "for sale": a listing that is also (or only) offered to buy — freehold or
// leasehold. Read from the text on every write and every rescore, so the Term filter can
// hide it. The title is trusted outright ("Villa for Sale and Rent in Umalas"); the
// description only on phrasings that offer the villa itself, because a bare "Freehold
// (SHM)" is the land certificate of a rental and agencies sign every page with "for more
// Bali villas for sale please browse this website".

const TITLE =
  /\b(?:for\s+(?:leasehold\s+)?sale|on\s+sale|sale\s*(?:&|and|\/|or)\s*(?:for\s+)?rent|rent(?:al)?\s*(?:&|and|\/|or)\s*(?:for\s+)?sale|leasehold|freehold|dijual|for\s+sell)\b/i;

const TEXT = new RegExp(
  [
    String.raw`(?:also\s+)?available\s+(?:for|to)\s+(?:sale|purchase|buy)\b`,
    String.raw`for\s+(?:rent|rental|lease)\s*(?:&|and|\/|or)\s*(?:for\s+)?sale\b`,
    String.raw`(?:rent|rental)s?,?\s*(?:&|and|or|\/)\s*(?:for\s+)?(?:leasehold\s+|freehold\s+)?sale\b`,
    String.raw`(?:rent|rental)s?,?\s*(?:&|and|or|\/)\s*leasehold\b`,
    String.raw`sale\s*(?:&|and|\/|or)\s*(?:for\s+)?(?:rent|lease)\b`,
    String.raw`(?:leasehold|freehold)\s+(?:sale|price|for\s+sale|available|option)`,
    String.raw`freehold\s*[—–:-]\s*(?:rp|idr)`,
    String.raw`dijual\s*[:\-]`,
    String.raw`for\s+leasehold`,
  ].map((p) => `\\b${p}`).join('|'),
  'i'
);

/** 1 when the listing is offered for sale (freehold or leasehold), else 0. */
export function forSale(row) {
  const r = row || {};
  if (TITLE.test(String(r.title || ''))) return 1;
  return TEXT.test(String(r.description || '')) ? 1 : 0;
}

export default { forSale };
