// A stand-in adapter for test/jobs.test.js. Every card costs BUSY_MS of synchronous CPU —
// the shape of a real scrape (cheerio parsing, better-sqlite3 upserts, rescoring), which
// never yields the thread while it works. No network.

export const BUSY_MS = 500;
const PRICES_M = [30, 45, 60, 75]; // far enough apart that dedupe never folds two together
export const CARDS = PRICES_M.length;

function spin(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy */
  }
}

export default {
  id: 'slow',
  name: 'Slow test source',
  base: 'https://slow.test',
  async *list() {
    for (let i = 1; i <= CARDS; i++) {
      spin(BUSY_MS);
      yield {
        source: 'slow', ref: `SL${i}`, url: `https://slow.test/villa-sl${i}`,
        title: '2 Bedroom Villa in Seseh', location: 'Seseh - Beach Side',
        category: 'monthly/seseh', bedrooms: 2, price_month_idr: PRICES_M[i - 1] * 1_000_000, term: 'monthly',
      };
    }
  },
  async detail() {
    return null;
  },
};
