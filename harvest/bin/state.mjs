// The nightly queue: harvest/groups.json (the curated channel list, checked in) joined with
// $HARVEST_DIR/nightly-state.json (last_done per group, local, gitignored). The coordinator
// (runbooks/NIGHTLY.md) uses it instead of editing JSON by hand.
//
//   node harvest/bin/state.mjs queue [--date=YYYY-MM-DD]   tonight's queue, one JSON object per line
//   node harvest/bin/state.mjs done <groupId> [YYYY-MM-DD]  record a finished harvest (default: today)
//   node harvest/bin/state.mjs ids                          ids that have a last_done (for known/ rebuilds)
//   node harvest/bin/state.mjs list                         every group: region, status, last_done, name
//
// "Today" is the local date in $HARVEST_TZ (default Asia/Makassar, where the villas are).
// nightly-state.json: { "last_done": { "<groupId>": "YYYY-MM-DD", ... } }. The kit's older shape
// ({ groups: [{ id, last_done }] }) is read too and rewritten in the new one on the next `done`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_DIR, HARVEST_DIR } from './lib.mjs';

export const GROUPS_FILE = path.join(KIT_DIR, 'groups.json');
export const STATE_FILE = path.join(HARVEST_DIR, 'nightly-state.json');
export const FIRST_HARVEST_DAYS = 30; // first harvest of a group reaches back 30 days
export const OVERLAP_DAYS = 2; // an incremental pass re-reads 2 days before last_done
const HARVESTED = new Set(['active', 'pending']);

/** YYYY-MM-DD in the given IANA zone. */
export function localDate(d = new Date(), tz = process.env.HARVEST_TZ || 'Asia/Makassar') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** YYYY-MM-DD shifted by `days` (calendar arithmetic, no time zone involved). */
export function addDays(ymd, days) {
  const t = Date.parse(ymd + 'T00:00:00Z') + days * 86400e3;
  return new Date(t).toISOString().slice(0, 10);
}

/** { groupId: 'YYYY-MM-DD' } from either state shape; an absent file is an empty state. */
export function lastDoneMap(state) {
  if (!state) return {};
  if (state.last_done && typeof state.last_done === 'object') return { ...state.last_done };
  const out = {};
  for (const g of state.groups || []) if (g && g.id && g.last_done) out[String(g.id)] = g.last_done;
  return out;
}

/**
 * Tonight's queue: every active/pending group, incremental ones (with a last_done) first, then
 * first harvests, each block in groups.json order. Deferred and skipped groups never run.
 * @returns {{n:number,id:string,name:string,url:string,region:string,mode:'incremental'|'first',options:object}[]}
 */
export function buildQueue(groupsDoc, lastDone, today) {
  const rows = (groupsDoc.groups || []).filter((g) => HARVESTED.has(g.status));
  const inc = rows.filter((g) => lastDone[g.id]);
  const first = rows.filter((g) => !lastDone[g.id]);
  const q = [
    ...inc.map((g) => ({ g, mode: 'incremental', options: { cutoff: addDays(lastDone[g.id], -OVERLAP_DAYS), minRounds: 6, minPosts: 0 } })),
    ...first.map((g) => ({ g, mode: 'first', options: { cutoff: addDays(today, -FIRST_HARVEST_DAYS) } })),
  ];
  return q.map(({ g, mode, options }, i) => ({ n: i + 1, id: g.id, name: g.name, url: g.url, region: g.region, mode, options }));
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const groupsDoc = readJsonFile(GROUPS_FILE);
  const lastDone = lastDoneMap(readJsonFile(STATE_FILE));
  const dateArg = (rest.find((a) => a.startsWith('--date=')) || '').slice(7);
  const today = dateArg || localDate();

  if (cmd === 'queue') {
    for (const row of buildQueue(groupsDoc, lastDone, today)) console.log(JSON.stringify(row));
    return 0;
  }
  if (cmd === 'ids') {
    const known = (groupsDoc.groups || []).filter((g) => HARVESTED.has(g.status) && lastDone[g.id]).map((g) => g.id);
    console.log(known.join('\n'));
    return 0;
  }
  if (cmd === 'list') {
    for (const g of groupsDoc.groups || []) console.log([g.id, g.region, g.status, lastDone[g.id] || '-', g.name].join('\t'));
    return 0;
  }
  if (cmd === 'done') {
    const [id, date] = rest;
    if (!id) throw new Error('usage: state.mjs done <groupId> [YYYY-MM-DD]');
    if (!(groupsDoc.groups || []).some((g) => g.id === id)) throw new Error(`unknown group id: ${id} (not in groups.json)`);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a date: ${date}`);
    lastDone[id] = date || today;
    const doc = {
      note: 'Nightly harvest state: last_done = local date (Asia/Makassar) of the last completed harvest per group. Written by bin/state.mjs; not checked in.',
      last_done: lastDone,
    };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(doc, null, 1) + '\n');
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    console.log(`${id} last_done=${lastDone[id]}`);
    return 0;
  }
  console.error('usage: node harvest/bin/state.mjs queue [--date=YYYY-MM-DD] | done <groupId> [date] | ids | list');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message || e));
    process.exitCode = 1;
  }
}
