// SPEC §6 "Learn" — rule-based feedback/viewing mining that adjusts config.weights,
// property red_flags and config.low_priority_pockets, then rescores everything.
//
// Contract change (Philipp, 2026-09-17): beach distance is now a SOFT scored factor
// (src/defaults.js DEFAULT_WEIGHTS.beach, src/scrape/score.js). That makes `beach` an
// ordinary WEIGHT_KEYS entry here too — a negative "far from beach" reason raises
// weights.beach by 2 like any other feature, a positive by 1. `quiet` and `privacy` are
// NOT weight keys: they only ever produce an applied_note entry and, for `quiet`
// negatives tied to a property, the `quiet_low` red flag.

import { fetch } from 'undici';
import { nowIso, getConfig, setConfig } from '../db.js';
import { rescoreAll } from './store.js';
import { WEIGHT_KEYS } from '../defaults.js';
import { sameTeamSql } from '../teams.js';

// SPEC §17: a friend's feedback/viewing must never nudge the owners' weights or add a
// red flag on their behalf — only home-team rows are mined. `sameTeamSql(null, …)`
// reads "no user" as the home team (teams.js's teamIdOf), same trick as agent.js. Both
// `feedback` and `viewings` have their own unaliased `by` column, so one predicate serves
// either query.
const HOME_TEAM_BY_SQL = sameTeamSql(null, 'by');

const WEIGHT_KEY_SET = new Set(WEIGHT_KEYS);
const WEIGHT_CAP = 20;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_TIMEOUT_MS = 5000;

/**
 * Keyword → {feature, polarity} table (SPEC §6 "Learn"). `quiet` and `privacy` are valid
 * features here (drive a red flag / applied_note) even though they aren't in WEIGHT_KEYS;
 * every other feature must be a WEIGHT_KEYS entry.
 */
export const REASON_KEYWORDS = [
  { regex: /noise|noisy|loud|road|traffic|dogs|club|bar music/i, feature: 'quiet', polarity: 'negative' },
  { regex: /dark|no light|gloomy/i, feature: 'airy', polarity: 'negative' },
  { regex: /bright|light-filled|so much light/i, feature: 'airy', polarity: 'positive' },
  { regex: /small living|cramped|tiny living/i, feature: 'living_open', polarity: 'negative' },
  { regex: /huge living|big living|open living/i, feature: 'living_open', polarity: 'positive' },
  { regex: /far from (the )?beach|too far/i, feature: 'beach', polarity: 'negative' },
  { regex: /loved the garden|beautiful garden/i, feature: 'garden', polarity: 'positive' },
  { regex: /no pool|pool (was )?(tiny|dirty)/i, feature: 'pool', polarity: 'negative' },
  { regex: /great pool|loved the pool/i, feature: 'pool', polarity: 'positive' },
  { regex: /kitchen (was )?(tiny|useless)|no kitchen/i, feature: 'kitchen_full', polarity: 'negative' },
  { regex: /no ac|no aircon|hot/i, feature: 'aircon', polarity: 'negative' },
  { regex: /nowhere to work|no desk/i, feature: 'workspace', polarity: 'negative' },
];

/** Pure keyword-table extraction: each rule fires at most once per text. */
export function extractReasonsKeyword(text) {
  const t = String(text || '');
  const reasons = [];
  const seen = new Set();
  for (const { regex, feature, polarity } of REASON_KEYWORDS) {
    if (!regex.test(t)) continue;
    const key = `${feature}:${polarity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({ feature, polarity });
  }
  return reasons;
}

/** Optional LLM assist (SPEC §6): Haiku via raw undici fetch, tool-forced JSON, 5s timeout. */
async function extractReasonsWithLLM(text) {
  const allowedFeatures = [...WEIGHT_KEYS, 'quiet', 'privacy'];
  const tool = {
    name: 'extract_reasons',
    description: 'Extract feature/polarity reasons from free-text feedback about a rental villa listing.',
    input_schema: {
      type: 'object',
      properties: {
        reasons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              feature: { type: 'string', enum: allowedFeatures },
              polarity: { type: 'string', enum: ['positive', 'negative'] },
            },
            required: ['feature', 'polarity'],
            additionalProperties: false,
          },
        },
      },
      required: ['reasons'],
      additionalProperties: false,
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 512,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'extract_reasons' },
      messages: [
        {
          role: 'user',
          content: `Extract feature/polarity reasons from this feedback about a villa rental:\n\n"${text}"`,
        },
      ],
    }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find((b) => b.type === 'tool_use') : null;
  const reasons = block?.input?.reasons;
  if (!Array.isArray(reasons)) throw new Error('anthropic: unexpected response shape');
  return reasons.filter(
    (r) => r && allowedFeatures.includes(r.feature) && (r.polarity === 'positive' || r.polarity === 'negative')
  );
}

/**
 * Reasons for one feedback text. Uses Claude (Haiku) when ANTHROPIC_API_KEY is set, degrading
 * to the keyword table on any error or timeout; keyword-only otherwise (always the case in
 * tests, which run with the env var unset).
 */
export async function extractReasons(text) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await extractReasonsWithLLM(text);
    } catch {
      // degrade to the keyword table on any error/timeout
    }
  }
  return extractReasonsKeyword(text);
}

function safeParseArray(v) {
  if (Array.isArray(v)) return [...v];
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function truncate(s, n = 80) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/** Merge `flag` into a property's red_flags if it isn't already there. Returns whether it added it. */
function addRedFlag(db, propertyId, flag) {
  if (!propertyId) return false;
  const row = db.prepare('SELECT red_flags FROM properties WHERE id = ?').get(propertyId);
  if (!row) return false;
  const flags = safeParseArray(row.red_flags);
  if (flags.includes(flag)) return false;
  flags.push(flag);
  db.prepare('UPDATE properties SET red_flags = ? WHERE id = ?').run(JSON.stringify(flags), propertyId);
  return true;
}

/**
 * Rule-based learning pass (SPEC §6 "Learn"): applies unapplied feedback (weight nudges +
 * quiet_low flags), new viewings (quiet_low / privacy_low flags), and rejected/quiet_low
 * clustering (low_priority_pockets) — then rescores everything once if anything changed.
 */
export async function runLearn(db, { now = nowIso(), log = console } = {}) {
  const config = getConfig(db);
  const weights = { ...config.weights };
  const weight_changes = [];
  const red_flags_added = [];
  const pockets_added = [];
  let feedback_applied = 0;
  let anyChange = false;

  // 1. Feedback -----------------------------------------------------------
  const feedbackRows = db.prepare(`SELECT * FROM feedback WHERE applied = 0 AND ${HOME_TEAM_BY_SQL}`).all();
  const updateFeedback = db.prepare('UPDATE feedback SET applied = 1, applied_note = ? WHERE id = ?');

  for (const row of feedbackRows) {
    const reasons = await extractReasons(row.text || '');
    const notes = [];

    for (const { feature, polarity } of reasons) {
      notes.push({ feature, polarity });

      if (WEIGHT_KEY_SET.has(feature)) {
        const delta = polarity === 'negative' ? 2 : 1;
        const from = weights[feature] ?? 0;
        const to = Math.min(WEIGHT_CAP, from + delta);
        if (to !== from) {
          weights[feature] = to;
          weight_changes.push({
            feature,
            from,
            to,
            because: `feedback #${row.id}${row.property_id ? ` (property ${row.property_id})` : ''}: "${truncate(row.text)}"`,
          });
          anyChange = true;
        }
      } else if (feature === 'quiet' && polarity === 'negative' && row.property_id) {
        if (addRedFlag(db, row.property_id, 'quiet_low')) {
          red_flags_added.push({ property_id: row.property_id, flag: 'quiet_low' });
          anyChange = true;
        }
      }
    }

    updateFeedback.run(notes.length ? JSON.stringify(notes) : 'no reasons found', row.id);
    feedback_applied++;
  }

  // 2. Viewings -------------------------------------------------------------
  const lastViewingId = Number(config.learn_last_viewing_id || 0);
  const viewingRows = db
    .prepare(`SELECT * FROM viewings WHERE id > ? AND ${HOME_TEAM_BY_SQL} ORDER BY id ASC`)
    .all(lastViewingId);
  let maxViewingId = lastViewingId;

  for (const v of viewingRows) {
    if (v.id > maxViewingId) maxViewingId = v.id;

    if (v.quiet != null && v.quiet <= 2 && addRedFlag(db, v.property_id, 'quiet_low')) {
      red_flags_added.push({ property_id: v.property_id, flag: 'quiet_low' });
      anyChange = true;
    }
    if (v.privacy != null && v.privacy <= 2 && addRedFlag(db, v.property_id, 'privacy_low')) {
      red_flags_added.push({ property_id: v.property_id, flag: 'privacy_low' });
      anyChange = true;
    }
  }
  if (viewingRows.length) setConfig(db, 'learn_last_viewing_id', maxViewingId);

  // 3. Pockets --------------------------------------------------------------
  const existingPockets = new Set((config.low_priority_pockets || []).map((p) => String(p).toLowerCase()));
  const subAreaRows = db
    .prepare("SELECT sub_area, status, red_flags FROM properties WHERE sub_area IS NOT NULL AND sub_area != ''")
    .all();

  const groups = new Map(); // lowercased sub_area -> { original, count }
  for (const row of subAreaRows) {
    const flags = safeParseArray(row.red_flags);
    if (row.status !== 'rejected' && !flags.includes('quiet_low')) continue;
    const key = String(row.sub_area).trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { original: row.sub_area, count: 0 });
    groups.get(key).count++;
  }

  const newPockets = [];
  for (const [key, { original, count }] of groups) {
    if (count >= 2 && !existingPockets.has(key)) {
      newPockets.push(original);
      existingPockets.add(key);
    }
  }
  if (newPockets.length) {
    setConfig(db, 'low_priority_pockets', [...(config.low_priority_pockets || []), ...newPockets]);
    pockets_added.push(...newPockets);
    anyChange = true;
  }

  // Persist weights + rescore -----------------------------------------------
  if (weight_changes.length) setConfig(db, 'weights', weights);

  let run_id = null;
  if (anyChange) {
    rescoreAll(db);
    const info = db
      .prepare('INSERT INTO runs (started_at, finished_at, kind, weight_changes, notes) VALUES (?, ?, ?, ?, ?)')
      .run(
        now,
        now,
        'learn',
        JSON.stringify(weight_changes),
        JSON.stringify({ feedback_ids: feedbackRows.map((r) => r.id), red_flags_added, pockets_added })
      );
    run_id = Number(info.lastInsertRowid);
  }

  log?.info?.(
    `[learn] feedback_applied=${feedback_applied} weight_changes=${weight_changes.length} red_flags_added=${red_flags_added.length} pockets_added=${pockets_added.length}`
  );

  return { feedback_applied, weight_changes, red_flags_added, pockets_added, run_id };
}

export default { runLearn, extractReasons, extractReasonsKeyword, REASON_KEYWORDS };
