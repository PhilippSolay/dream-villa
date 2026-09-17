// Message templates A–G (SPEC §5 names them; the wording is ours). English, short,
// WhatsApp-friendly. Placeholders: {title} {ref} {url} {price} {names}.

import { priceLabel } from './ui.js';

export const NAMES = 'Philipp and Abigaïl';

export const TEMPLATES = [
  {
    key: 'A',
    title: 'First contact',
    body:
      'Hi, we saw {title} ({ref}) — is it still available for a long-term rental, and from when?\n' +
      'We are {names}, a quiet couple moving within Bali, looking for a year or longer.\n' +
      '{url}',
  },
  {
    key: 'B',
    title: 'The six questions',
    body:
      'Thank you! A few questions about {title} ({ref}) before we visit:\n' +
      '1. What is included in {price}: electricity, pool and garden staff, wifi, water?\n' +
      '2. Who are the neighbours, and is anything being built next door or on the land around?\n' +
      '3. How reliable are water and power there — any well or generator?\n' +
      '4. What are the lease terms and the minimum number of months?\n' +
      '5. What deposit do you ask, and what is the payment schedule?\n' +
      '6. Could we come and see it this week?',
  },
  {
    key: 'C',
    title: 'Viewing request',
    body:
      'We would love to see {title} ({ref}).\n' +
      'Would tomorrow around 10:00 work, or otherwise Saturday around 16:00?\n' +
      'We can come to the villa — just send the pin. Thank you!',
  },
  {
    key: 'D',
    title: 'Price for a longer term',
    body:
      'Thank you for showing us {title} ({ref}) — we like it.\n' +
      'The asking price is {price}. We are ready to commit for a full year and pay on time, every time.\n' +
      'Would the owner consider a better rate for that longer commitment? We can decide quickly.',
  },
  {
    key: 'E',
    title: 'Follow-up after silence',
    body:
      'Hi, just following up on {title} ({ref}) — is it still available?\n' +
      'If it is taken, no problem at all; we would only ask you to keep us in mind for similar long-term rentals.',
  },
  {
    key: 'F',
    title: 'Polite decline',
    body:
      'Thank you for your time with {title} ({ref}).\n' +
      'It is not the right fit for us, so we will not continue with this one.\n' +
      'We are still looking in the area, so please do send us anything similar. Best, {names}',
  },
  {
    key: 'G',
    title: 'Offer / confirmation',
    body:
      'To confirm what we agreed on {title} ({ref}):\n' +
      '- Rent: {price}\n' +
      '- Term and start date:\n' +
      '- Deposit and payment schedule:\n' +
      '- Included: electricity, water, wifi, pool and garden staff:\n' +
      'If that is right, please send the contract and we will arrange the first payment. Thank you! {names}',
  },
];

/** Fill a template body from a property row. Unknown values degrade to a readable dash. */
export function fill(body, property = {}) {
  const values = {
    title: property.title || 'your villa',
    ref: property.ref || property.key || '—',
    url: property.url || '',
    price: priceLabel(property),
    names: NAMES,
  };
  return String(body).replace(/\{(title|ref|url|price|names)\}/g, (_, key) => values[key]);
}

export default { TEMPLATES, fill, NAMES };
