// SPEC §2 — the brief. Seeded into the `config` table on first boot; editable from the Agent page.

export const DEFAULT_WEIGHTS = {
  living_open: 15,
  airy: 12,
  pool: 12,
  garden: 10,
  view: 10,
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
  budget_min: 25_000_000,
  budget_max: 50_000_000,
  beach_km_max: 4,
  // Aggregation band: what the scraper keeps at all.
  band: { bedrooms_min: 1, bedrooms_max: 4, price_min: 15_000_000, price_max: 80_000_000 },
  areas: [
    'seseh', 'cemagi', 'munggu', 'pererenan', 'nyanyi', 'kedungu', 'tanah_lot', 'buwit', 'mengwi',
    'bingin', 'padang_padang', 'uluwatu', 'balangan', 'ungasan', 'pandawa',
  ],
  red_flag_keywords: {
    construction: ['construction', 'under construction', 'building site'],
    main_road: ['main road', 'roadside', 'busy road', 'on the road'],
  },
  low_priority_pockets: [],
};

export const RED_FLAGS = ['construction', 'main_road', 'balinese_old', 'over_budget', 'quiet_low', 'privacy_low'];
export const STATUSES = ['new', 'shortlist', 'contacted', 'viewing_booked', 'viewed', 'offer', 'rejected'];
export const ACTIVE_STATUSES = ['shortlist', 'contacted', 'viewing_booked', 'viewed', 'offer'];
