import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as cheerio from 'cheerio';

import { parseMenuPage, parsePrice } from './menu-parsers.ts';

const items = (html: string) => {
  const result = parseMenuPage(cheerio.load(html));
  assert.ok(result, 'expected a menu');
  return { parser: result.parser, items: result.menus.flatMap((m) => m.items) };
};

const repeat = (n: number, fn: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => fn(i)).join('');

test('parsePrice keeps the printed text and the first number', () => {
  assert.deepEqual(parsePrice(' $12 / $18 '), { price: 12, priceText: '$12 / $18' });
  assert.deepEqual(parsePrice('MP'), { price: null, priceText: 'MP' });
});

test('JSON-LD menus keep menu, section, price, and diet', () => {
  const menu = {
    '@type': 'Menu',
    name: 'Dinner',
    hasMenuSection: {
      '@type': 'MenuSection',
      name: 'Mains',
      hasMenuItem: Array.from({ length: 5 }, (_, i) => ({
        '@type': 'MenuItem',
        name: `Dish ${i}`,
        description: 'tasty',
        offers: { '@type': 'Offer', price: '14.50' },
        suitableForDiet: 'https://schema.org/VeganDiet',
      })),
    },
  };
  const { parser, items: parsed } = items(
    `<script type="application/ld+json">${JSON.stringify(menu)}</script>`,
  );
  assert.equal(parser, 'jsonld');
  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed[0], {
    section: 'Mains',
    name: 'Dish 0',
    description: 'tasty',
    price: 14.5,
    priceText: '14.50',
    dietary: ['vegan'],
  });
});

test('Squarespace menu blocks map tab labels to menus', () => {
  const html = `<div class="menu-block"><div class="menus">
    <div class="menu-select-labels">Dinner</div>
    <div class="menu"><div class="menu-section"><div class="menu-section-title">Pasta</div>
      ${repeat(5, (i) => `<div class="menu-item"><div class="menu-item-title">Pasta ${i}</div><div class="menu-item-description">fresh</div><span class="menu-item-price-top"><span class="currency-sign">$</span>2${i}</span></div>`)}
    </div></div></div></div>`;
  const result = parseMenuPage(cheerio.load(html));
  assert.equal(result?.parser, 'squarespace');
  assert.equal(result?.menus[0].name, 'Dinner');
  assert.deepEqual(result?.menus[0].items[1], {
    section: 'Pasta',
    name: 'Pasta 1',
    description: 'fresh',
    price: 21,
    priceText: '$21',
    dietary: [],
  });
});

test('generic parser finds items around prices and sections from outer headings', () => {
  const html = `<main>
    <h2>Starters</h2>
    ${repeat(3, (i) => `<div class="item"><h3>Starter ${i}</h3><span>$1${i}</span><p>crispy</p></div>`)}
    <h2>Mains</h2>
    ${repeat(3, (i) => `<div class="item"><span class="badge">VEGAN</span><div>Main ${i}</div><div>$2${i}.50</div></div>`)}
  </main>`;
  const { parser, items: parsed } = items(html);
  assert.equal(parser, 'generic');
  assert.equal(parsed.length, 6);
  assert.deepEqual(parsed[1], {
    section: 'Starters',
    name: 'Starter 1',
    description: 'crispy',
    price: 11,
    priceText: '$11',
    dietary: [],
  });
  assert.equal(parsed[4].section, 'Mains');
  assert.equal(parsed[4].name, 'Main 1');
  assert.deepEqual(parsed[4].dietary, ['vegan']);
});

test('size options fold into the dish above', () => {
  const html = `<main>${repeat(5, (i) => `<div><b>Dish ${i}</b><span>$1${i}</span></div>`)}
    <div><b>Lg</b><span>$30</span></div></main>`;
  const { items: parsed } = items(html);
  assert.equal(parsed.length, 5);
  assert.equal(parsed[4].priceText, '$14 / Lg $30');
});

test('Squarespace titles with a trailing price are split', () => {
  const html = `<div class="menu-block"><div class="menu"><div class="menu-section">
    ${repeat(5, (i) => `<div class="menu-item"><div class="menu-item-title">Chips ${i}A 6</div></div>`)}
  </div></div></div>`;
  const result = parseMenuPage(cheerio.load(html));
  assert.equal(result?.menus[0].items[0].name, 'Chips 0A');
  assert.equal(result?.menus[0].items[0].price, 6);
});

test('pages with only a few prices are not menus', () => {
  assert.equal(
    parseMenuPage(cheerio.load('<p>Gift cards</p><span>$25</span><span>$50</span>')),
    null,
  );
});
