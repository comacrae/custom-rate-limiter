import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as cheerio from 'cheerio';

import { parseMenuPage, parsePrice, tidyMenu, type MenuItemDraft } from './menu-parsers.ts';

const item = (name: string, price: number | null): MenuItemDraft => ({
  section: null,
  name,
  description: null,
  price,
  priceText: price === null ? null : String(price),
  dietary: [],
});

test('tidyMenu splits dot-leader prices out of names and drops $0', () => {
  const menu = tidyMenu({
    name: 'Dinner',
    items: [item('SPICY SCALLOPS TEMPURA..........$25.90', null), item('Quail Egg', 0)],
  });
  assert.deepEqual(
    menu?.items.map((i) => [i.name, i.price]),
    [
      ['SPICY SCALLOPS TEMPURA', 25.9],
      ['Quail Egg', null],
    ],
  );
});

test('tidyMenu drops letter-spaced names it cannot read', () => {
  const menu = tidyMenu({
    name: '',
    items: [item('K i d s B r e a k f a s t P l a t e', 10), item('Pancakes', 9), item('BLT', 11)],
  });
  assert.deepEqual(
    menu?.items.map((i) => i.name),
    ['Pancakes', 'BLT'],
  );
});

test('tidyMenu moves text after dot leaders into the description', () => {
  const menu = tidyMenu({ name: '', items: [item('Tofu.............. Add', 1.25)] });
  assert.equal(menu?.items[0].name, 'Tofu');
  assert.equal(menu?.items[0].description, 'Add');
});

test('tidyMenu clears prices far above the rest of the menu', () => {
  const beers = ['Corona', 'Modelo', 'Stella', 'Goose IPA'].map((n) => item(n, 6));
  const menu = tidyMenu({ name: '', items: [...beers, item('Miller Lite', 550)] });
  assert.equal(menu?.items[4].price, null);
  assert.equal(menu?.items[4].priceText, '550');
});

test('tidyMenu drops calorie sheets', () => {
  const sheet = {
    name: '',
    items: [item('Harvest Salad', 519), item('Cobb Salad', 878), item('Soup', 240)],
  };
  assert.equal(tidyMenu(sheet), null);
});

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

test('unpriced heading menus parse only on known menu pages', () => {
  const html = `<main><h2>Appetizers</h2>
    ${repeat(8, (i) => `<div class="box"><h3>Dish ${i}</h3><p>with sauce ${i}</p></div>`)}
  </main>`;
  assert.equal(parseMenuPage(cheerio.load(html)), null);
  const result = parseMenuPage(cheerio.load(html), { knownMenuPage: true });
  assert.equal(result?.parser, 'headings');
  assert.deepEqual(result?.menus[0].items[2], {
    section: 'Appetizers',
    name: 'Dish 2',
    description: 'with sauce 2',
    price: null,
    priceText: null,
    dietary: [],
  });
});

test('menu index pages are not read as unpriced menus', () => {
  const titles = [
    'Breakfast',
    'Lunch',
    'Dinner',
    'Wine List',
    'Brunch',
    'Desserts',
    'Drinks',
    'Happy Hour',
  ];
  const html = `<main>${titles.map((t) => `<h3>${t}</h3>`).join('')}</main>`;
  assert.equal(parseMenuPage(cheerio.load(html), { knownMenuPage: true }), null);
});

test('bare heading lists without descriptions are not menus', () => {
  const states = [
    'Arizona',
    'Arkansas',
    'California',
    'Colorado',
    'Delaware',
    'Florida',
    'Georgia',
    'Idaho',
  ];
  const html = `<main>${states.map((s) => `<h3>${s}</h3>`).join('')}</main>`;
  assert.equal(parseMenuPage(cheerio.load(html), { knownMenuPage: true }), null);
});

test('items repeated by responsive layouts are kept once', () => {
  const block = repeat(5, (i) => `<div><b>Dish ${i}</b><span>$1${i}</span></div>`);
  const { items: parsed } = items(
    `<main><section>${block}</section><section>${block}</section></main>`,
  );
  assert.equal(parsed.length, 5);
});

test('online store labels are not dish names', () => {
  const html = `<main>${repeat(5, (i) => `<div><span>Regular price</span><span>$2${i}.00</span></div>`)}</main>`;
  assert.equal(parseMenuPage(cheerio.load(html)), null);
});

test('Squarespace price fields holding text become descriptions', () => {
  const html = `<div class="menu-block"><div class="menu"><div class="menu-section">
    ${repeat(5, (i) => `<div class="menu-item"><div class="menu-item-title">Cava ${'ABCDE'[i]}</div><span class="menu-item-price-top">white pears, green apple</span></div>`)}
  </div></div></div>`;
  const item = parseMenuPage(cheerio.load(html))?.menus[0].items[0];
  assert.equal(item?.description, 'white pears, green apple');
  assert.equal(item?.priceText, null);
});

test('pages with only a few prices are not menus', () => {
  assert.equal(
    parseMenuPage(cheerio.load('<p>Gift cards</p><span>$25</span><span>$50</span>')),
    null,
  );
});
