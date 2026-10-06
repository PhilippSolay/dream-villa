// Merge every archived Facebook harvest file in $HARVEST_DIR into one file per group, best entry
// per post: the text that is not cut at "See more" (then the longest), plus the largest photo any
// run captured. Output: $HARVEST_DIR/merged-<groupId>.json (gitignored), importable with
// bin/import.mjs. Useful to re-send a group's history in one go after an importer fix.
//
//   node harvest/bin/merge.mjs
import fs from 'node:fs';
import path from 'node:path';
import { HARVEST_DIR, filesIn } from './lib.mjs';

const dir = HARVEST_DIR;
const files = filesIn(dir, 'villa-fb-posts-');
const groups = new Map(); // groupId -> { group_name, posts: Map(post_id -> best) }
const truncated = (t) => /\bSee more\s*$/i.test(String(t || '').trim());
const stats = { files: files.length, entries: 0, posts: 0, upgradedText: 0, addedImage: 0 };

for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const gid = String(data.group_id);
  if (!groups.has(gid)) groups.set(gid, { group_name: data.group_name, posts: new Map() });
  const g = groups.get(gid);
  if (!g.group_name && data.group_name) g.group_name = data.group_name;
  for (const p of data.posts || []) {
    if (!p.post_id || !p.url || !p.text) continue;
    stats.entries += 1;
    const cur = g.posts.get(p.post_id);
    if (!cur) { g.posts.set(p.post_id, { ...p }); continue; }
    const better = (!truncated(p.text) && truncated(cur.text)) || (truncated(p.text) === truncated(cur.text) && p.text.length > cur.text.length);
    const image = [cur.image, p.image].filter((i) => i && i.data_base64).sort((a, b) => b.data_base64.length - a.data_base64.length)[0] || null;
    if (better) stats.upgradedText += 1;
    if (image && !(cur.image && cur.image.data_base64)) stats.addedImage += 1;
    g.posts.set(p.post_id, { ...(better ? p : cur), image, posted_at: cur.posted_at || p.posted_at });
  }
}

for (const [gid, g] of groups) {
  const posts = [...g.posts.values()];
  stats.posts += posts.length;
  fs.writeFileSync(path.join(dir, `merged-${gid}.json`), JSON.stringify({ group_id: gid, group_name: g.group_name, posts }));
  console.log(`merged-${gid}.json: ${posts.length} posts, ${posts.filter((p) => p.image && p.image.data_base64).length} with photo, ${posts.filter((p) => truncated(p.text)).length} still cut at See more`);
}
console.log(JSON.stringify(stats));
