// The adapter registry (SPEC §6 "Adapters to build, in order"). One entry per source
// id; `src/scrape/index.js` runs whatever this returns, in insertion order.

import bhi from './bhi.js';
import kibarer from './kibarer.js';
import balirealty from './balirealty.js';
import balicoconutliving from './balicoconutliving.js';
import umadibali from './umadibali.js';
import apexbali from './apexbali.js';
import livuma from './livuma.js';
import rumah123 from './rumah123.js';

// Run order = SPEC §6 order: proven agency first, then agencies (umadibali, added
// 2026-09-26, then apexbali, added 2026-09-28, are the last of them), then portals (livuma, a sitemap-walked listing
// portal, runs before the rumah123 portal).
// Skipped (see adapters/*.md): exotiq (sales only), balivillahub (Vercel checkpoint),
// olx (Akamai), lamudi (401), 99co (Cloudflare), fbmarketplace (login shell).
export const adapters = { bhi, kibarer, balirealty, balicoconutliving, umadibali, apexbali, livuma, rumah123 };

/** Every adapter id the registry knows, in run order. */
export const ADAPTER_IDS = Object.keys(adapters);

/**
 * @param {string|string[]|null} [sourceFilter] `'bhi'`, `'bhi,kibarer'` or `['bhi']`;
 *   null/empty means every adapter.
 * @returns {object[]} adapter objects
 */
export function getAdapters(sourceFilter = null) {
  if (sourceFilter == null || sourceFilter === '' || sourceFilter === 'all') return ADAPTER_IDS.map((id) => adapters[id]);

  const wanted = (Array.isArray(sourceFilter) ? sourceFilter : String(sourceFilter).split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);

  const unknown = wanted.filter((id) => !adapters[id]);
  if (unknown.length) {
    throw new Error(`unknown source(s): ${unknown.join(', ')} — known: ${ADAPTER_IDS.join(', ')}`);
  }
  // De-duplicated, in registry order, so `--source=bhi,bhi` behaves.
  return ADAPTER_IDS.filter((id) => wanted.includes(id)).map((id) => adapters[id]);
}

export default { adapters, getAdapters, ADAPTER_IDS };
