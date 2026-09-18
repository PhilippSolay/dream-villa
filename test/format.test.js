// The description formatter is pure string work — it must run under node:test without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';

import { descriptionBlocks, inlineHtml, decodeEntities, formatDescription } from '../public/lib/format.js';

test('descriptionBlocks: paragraphs split on newlines and blank lines', () => {
  assert.deepEqual(descriptionBlocks('One.\n\nTwo.\nThree.'), [
    { type: 'p', text: 'One.' },
    { type: 'p', text: 'Two.' },
    { type: 'p', text: 'Three.' },
  ]);
});

test('descriptionBlocks: empty, null and whitespace input give no blocks', () => {
  assert.deepEqual(descriptionBlocks(''), []);
  assert.deepEqual(descriptionBlocks(null), []);
  assert.deepEqual(descriptionBlocks('   \n\n \t '), []);
});

test('descriptionBlocks: consecutive * and - lines group into one list', () => {
  assert.deepEqual(descriptionBlocks('* Fully equipped kitchen\n* Private pool\n- Garden'), [
    { type: 'ul', items: ['Fully equipped kitchen', 'Private pool', 'Garden'] },
  ]);
});

test('descriptionBlocks: a blank line does not break a list, a paragraph does', () => {
  assert.deepEqual(descriptionBlocks('- Unit 1\n\n- Unit 2\n\nThe villa is new.\n- Pool'), [
    { type: 'ul', items: ['Unit 1', 'Unit 2'] },
    { type: 'p', text: 'The villa is new.' },
    { type: 'ul', items: ['Pool'] },
  ]);
});

test('descriptionBlocks: matched **bold** survives, stray asterisks are dropped', () => {
  assert.deepEqual(descriptionBlocks('A **two-bedroom villa** in Seseh.'), [
    { type: 'p', text: 'A **two-bedroom villa** in Seseh.' },
  ]);
  assert.deepEqual(descriptionBlocks('**Property Highlights:***'), [
    { type: 'p', text: '**Property Highlights:**' },
  ]);
  assert.deepEqual(descriptionBlocks('A *lone star and an **unclosed pair'), [
    { type: 'p', text: 'A lone star and an unclosed pair' },
  ]);
});

test('descriptionBlocks: a period glued to a capital gets its space back', () => {
  assert.deepEqual(descriptionBlocks('Close to both beaches.Both are quiet.'), [
    { type: 'p', text: 'Close to both beaches. Both are quiet.' },
  ]);
  // Abbreviations and decimals are left alone.
  assert.deepEqual(descriptionBlocks('Jl. Raya Seseh, 4.5 km away, e.g. by scooter.'), [
    { type: 'p', text: 'Jl. Raya Seseh, 4.5 km away, e.g. by scooter.' },
  ]);
});

test('decodeEntities: the entities agency CMSes emit, numeric and named', () => {
  assert.equal(decodeEntities('Caf&eacute; &amp; Bali&rsquo;s best'), "Café & Bali’s best");
  assert.equal(decodeEntities('4&#32;km &#x26; more'), '4 km & more');
  assert.equal(decodeEntities('&notanentity; stays'), '&notanentity; stays');
});

test('inlineHtml: escapes first, then applies bold — no scraper HTML gets through', () => {
  assert.equal(inlineHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(inlineHtml('a **b** c'), 'a <strong>b</strong> c');
  assert.equal(inlineHtml('**<b>x</b>**'), '<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
});

test('formatDescription: blocks become <p> and <ul>, and an empty description is empty', () => {
  assert.equal(
    formatDescription('**Highlights:***\n* Pool\n* Garden').__raw,
    '<p><strong>Highlights:</strong></p><ul class="desc-list"><li>Pool</li><li>Garden</li></ul>'
  );
  assert.equal(formatDescription('').__raw, '');
});
