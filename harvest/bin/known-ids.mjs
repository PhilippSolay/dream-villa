// Print a JSON array of the post ids already harvested for one Facebook group, read from the
// archived files in $HARVEST_DIR and any not yet imported in the downloads folder. Paste the
// output into __villa.preload([...]) in the tab, so a reinstall or an incremental run spends no
// time on posts it already has. The nightly coordinator writes it to known/<groupId>.json.
//
//   node harvest/bin/known-ids.mjs <groupId>
//
// Files are matched by name (villa-fb-posts-<groupId>-...); a file saved with another tag
// (e.g. __villa.download('final')) is matched by the group_id inside it.
import path from 'node:path';
import { HARVEST_DIR, DOWNLOADS, filesIn, readJson } from './lib.mjs';

const gid = process.argv[2];
if (!gid) {
  console.error('usage: node harvest/bin/known-ids.mjs <groupId>');
  process.exit(2);
}
const ids = new Set();
for (const dir of [HARVEST_DIR, DOWNLOADS]) {
  for (const f of filesIn(dir, 'villa-fb-posts-')) {
    const byName = f.startsWith('villa-fb-posts-' + gid + '-');
    // Another group's auto-flush file (its tag is that group's id) is never opened; only an
    // odd tag such as "final" is, to read its group_id.
    if (!byName && !f.startsWith('villa-fb-posts-final-')) continue;
    const data = readJson(path.join(dir, f));
    if (!data || (!byName && String(data.group_id) !== gid)) continue;
    for (const p of data.posts || []) if (p.post_id) ids.add(String(p.post_id));
  }
}
process.stdout.write(JSON.stringify([...ids]));
