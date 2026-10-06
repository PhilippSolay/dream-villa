// Print a JSON array of the Bali Villa Hub refs already harvested, read from the archived files in
// $HARVEST_DIR and the downloads folder. Paste the output into __bvh.preload([...]) before
// __bvh.run2, so a re-run skips every listing it already holds.
//
//   node harvest/bin/known-bvh-refs.mjs
import path from 'node:path';
import { HARVEST_DIR, DOWNLOADS, filesIn, readJson } from './lib.mjs';

const refs = new Set();
for (const dir of [HARVEST_DIR, DOWNLOADS]) {
  for (const f of filesIn(dir, 'villa-bvh-listings-')) {
    const data = readJson(path.join(dir, f));
    for (const l of (data && data.listings) || []) if (l.ref) refs.add(String(l.ref));
  }
}
process.stdout.write(JSON.stringify([...refs]));
