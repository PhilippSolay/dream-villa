// A card's own photo arrows. A list row brings only its hero and `photo_count`; the first
// arrow tap fetches that listing's gallery (`/api/properties/:id/photos`) and later taps
// step through it without asking again. The place each card is at outlives a redraw, so
// a verdict tap or a filter change does not throw the card back to its hero.

import { thumbUrl } from './ui.js';

const photos = new Map(); // listing id → { urls, at }
const loading = new Map(); // listing id → Promise of the entry above

/** The photo a card should show: where its arrows left it, else the hero. */
export function cardPhotoUrl(p) {
  const seen = photos.get(p.id);
  return seen ? seen.urls[seen.at] : p.hero_url;
}

function load(id, api) {
  if (!loading.has(id)) {
    const pending = api
      .get(`/api/properties/${id}/photos`)
      .then(({ hero_url: hero, image_urls: list }) => {
        const urls = hero && !list.includes(hero) ? [hero, ...list] : [...list];
        const entry = { urls, at: Math.max(0, urls.indexOf(hero)) };
        photos.set(id, entry);
        return entry;
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return loading.get(id);
}

function paint(card, url) {
  const media = card.querySelector('.card-media');
  if (!media) return;
  let img = media.querySelector('img');
  if (!img) {
    // No photo yet, or the last one failed twice and stepped aside (app.js).
    media.querySelector('.placeholder')?.remove();
    img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    media.prepend(img);
  }
  delete img.dataset.fellBack;
  img.src = thumbUrl(url);
}

/** Click on a `[data-card-step]` button: -1 back, 1 on, wrapping at either end. */
export async function stepCardPhoto(button, api) {
  const card = button.closest('article.card[data-id]');
  if (!card) return;
  const id = Number(card.dataset.id);
  const step = Number(button.dataset.cardStep) || 1;
  let entry = photos.get(id);
  if (!entry) {
    try {
      entry = await load(id, api);
    } catch {
      return; // offline or gone: the card keeps its hero, the next tap tries again
    }
  }
  const count = entry.urls.length;
  if (count < 2) return;
  entry.at = (entry.at + step + count) % count;
  // Every card of this listing on screen, not just the tapped one: it may have been
  // redrawn while the list was loading, and the place is the listing's, not the card's.
  for (const live of document.querySelectorAll(`article.card[data-id="${id}"]`)) paint(live, entry.urls[entry.at]);
  // Warm the next one in the same direction, so a second tap lands on a loaded photo.
  new Image().src = thumbUrl(entry.urls[(entry.at + step + count) % count]);
}
