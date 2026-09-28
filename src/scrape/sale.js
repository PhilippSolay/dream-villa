// SPEC §2 — "for sale": a listing that is also (or only) offered to buy — freehold or
// leasehold. Read from the text on every write and every rescore, so the Term filter can
// hide it. The title is trusted outright ("Villa for Sale and Rent in Umalas"); the
// description only on phrasings that offer the villa itself, because a bare "Freehold
// (SHM)" is the land certificate of a rental and agencies sign every page with "for more
// Bali villas for sale please browse this website".

const TITLE =
  /\b(?:for\s+(?:leasehold\s+)?sale|on\s+sale|sale\s*(?:&|and|\/|or)\s*(?:for\s+)?rent|rent(?:al)?\s*(?:&|and|\/|or)\s*(?:for\s+)?sale|leasehold|freehold|dijual|for\s+sell)\b/i;
/** A title that carries a purchase price: "2 Villas for IDR 1.575B", "– Rp2,869,952,000". */
const TITLE_PRICE = /\b(?:idr|rp)\.?\s*(?:\d[\d.,]*\s*(?:b|bn|billion|miliar|milyar)\b|\d{1,3}(?:[.,]\d{3}){3,})/i;

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
    // A post that states the lease it sells: "Leasehold: 25 Years", "25-Year Leasehold",
    // "Leasehold until March 2053", "Ownership: Leasehold – 30 years". Five years and up:
    // "Leasehold 2 tahun paling minim" is a rental's minimum term. Not "lease price" or
    // "asking price": rentals head their yearly rent with both.
    String.raw`lease\s?hold\s*[:\-–—(]*\s*(?:(?:[5-9]|[1-9]\d)\s*(?:years?|yrs?|tahun)|until|expir)`,
    String.raw`(?:[5-9]|[1-9]\d)[-\s]?(?:years?|yrs?|tahun)\s+lease\s?hold`,
    String.raw`ownership\s*:\s*(?:lease|free)\s?hold`,
    String.raw`(?:sale|selling|sell)\s+price\b`,
    String.raw`harga\s+jual\b`,
    String.raw`jual\s+cepat\b`,
  ].map((p) => `\\b${p}`).join('|'),
  'i'
);
/** "FOR SALE – BRAND-NEW 1 BEDROOM VILLA" opening a line of the text or a segment of a
 *  headline ("TUMBAK BAYUH | 2-BEDROOM VILLA | FOR SALE | REF ID: DR0400"). */
const LINE_FOR_SALE = /(?:^|\n|\|)[^\w\n]*(?:for\s+sale|urgent\s+sale|dijual|sale\s+(?:tanah|land|villa|rumah))\b/i;

/** 1 when the listing is offered for sale (freehold or leasehold), else 0. */
export function forSale(row) {
  const r = row || {};
  // Facebook posts set their headline in bold Unicode (𝗙𝗢𝗥 𝗦𝗔𝗟𝗘); NFKC reads it as plain text.
  const title = String(r.title || '').normalize('NFKC');
  if (TITLE.test(title) || TITLE_PRICE.test(title)) return 1;
  const text = String(r.description || '').normalize('NFKC');
  return TEXT.test(text) || LINE_FOR_SALE.test(text) ? 1 : 0;
}

export default { forSale };
