// Who's who: solo vs teamed, owner vs member (SPEC §17). One place so every view reads
// the same rule instead of re-deriving it from `users.length` or `user.role` by hand.

/** A team of one sees no collaboration at all — no Shared tab, no teammate initials,
    no Match pill, no "Waiting for", no Shared filter group. `/api/me` says so directly;
    the `users` roster length is the fallback for a state snapshot taken before boot. */
export function isSolo(state) {
  const solo = state?.team?.solo;
  if (typeof solo === 'boolean') return solo;
  return (state?.users || []).length <= 1;
}

/** Owners run the brief and the scraper; members read it. */
export function isOwner(state) {
  return state?.user?.role === 'owner';
}
