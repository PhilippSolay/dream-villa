// SPEC §2 — the brief. Seeded into the `config` table on first boot; editable from the Agent page.

export const DEFAULT_WEIGHTS = {
  living_open: 15,
  airy: 12,
  pool: 12,
  garden: 10,
  view: 14,
  land: 12,
  style: 10,
  beach: 10,
  kitchen_full: 10,
  aircon: 8,
  furniture: 8,
  workspace: 8,
  joglo: 7,
};

export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS);

export const DEFAULT_CONFIG = {
  weights: DEFAULT_WEIGHTS,
  flag_threshold: 65,
  budget_min: 20_000_000,
  budget_max: 80_000_000,
  beach_km_max: 4,
  // Aggregation band: what the scraper keeps at all.
  band: { bedrooms_min: 1, bedrooms_max: 4, price_min: 15_000_000, price_max: 80_000_000 },
  // West coast, then the Canggu belt (added 2026-09-22), then the Bukit — west to east,
  // the order the filter drawer shows them in.
  areas: [
    'tegallalang', 'payangan', 'ubud', 'pejeng', 'lodtunduh',
    'mengwi', 'buwit', 'kedungu', 'nyanyi', 'tanah_lot', 'munggu', 'cemagi', 'seseh',
    'pererenan', 'padonan', 'canggu', 'tibubeneng', 'babakan', 'berawa', 'umalas',
    'balangan', 'bingin', 'padang_padang', 'uluwatu', 'ungasan', 'pandawa',
  ],
  red_flag_keywords: {
    construction: ['construction', 'under construction', 'building site'],
    main_road: ['main road', 'roadside', 'busy road', 'on the road'],
  },
  low_priority_pockets: [],
};

export const RED_FLAGS = ['construction', 'main_road', 'balinese_old', 'over_budget', 'quiet_low', 'privacy_low'];
// `gone` is the person-set end state (the agent says it is taken); the scraper's own
// detection lives in `availability`. Lists hide both unless asked (removed=).
export const STATUSES = ['new', 'shortlist', 'contacted', 'viewing_booked', 'viewed', 'offer', 'rejected', 'gone'];
export const ACTIVE_STATUSES = ['shortlist', 'contacted', 'viewing_booked', 'viewed', 'offer'];

// Why a listing left the market, stored in `removed_reason` alongside `removed_at`
// (migration 006). Kept so the archive can say what happened, not just that it went.
export const REMOVAL_REASONS = ['delisted', 'archived', 'unlisted', 'taken', 'merged'];
