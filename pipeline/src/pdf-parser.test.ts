import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSegmentLines } from './menu-parsers.ts';
import { toSegmentLines, type TextPiece } from './pdf-parser.ts';

const piece = (x: number, y: number, text: string, width = text.length * 5): TextPiece => ({
  x,
  y,
  width,
  height: 10,
  text,
});

test('rebuilds lines, joins price fragments, and splits columns', () => {
  const lines = toSegmentLines([
    piece(40, 700, 'Vongole Gratinate'),
    piece(549, 699, '1', 5),
    piece(554, 699, '6', 5),
    piece(559, 699, '.95', 10),
    piece(40, 686, 'Baked clams stuffed with', 120),
    piece(160, 686, 'bread crumbs'),
  ]);
  assert.deepEqual(lines, [
    [
      { x: 40, text: 'Vongole Gratinate' },
      { x: 549, text: '16.95' },
    ],
    [{ x: 40, text: 'Baked clams stuffed with bread crumbs' }],
  ]);
});

test('drops text printed twice for a bold effect', () => {
  const lines = toSegmentLines([piece(40, 700, 'TACOS'), piece(40.5, 700.3, 'TACOS')]);
  assert.deepEqual(lines, [[{ x: 40, text: 'TACOS' }]]);
});

test('reads sections, items, descriptions, and trailing prices', () => {
  const items = parseSegmentLines([
    [{ x: 40, text: 'STARTERS' }],
    [
      { x: 40, text: 'Queso' },
      { x: 300, text: '$15.95' },
    ],
    [{ x: 40, text: 'chihuahua, cheddar' }],
    [{ x: 40, text: 'Chips & Salsa ..... 6' }],
    [{ x: 40, text: 'est. 1955' }],
  ]);
  assert.deepEqual(items, [
    {
      section: 'STARTERS',
      name: 'Queso',
      description: 'chihuahua, cheddar',
      price: 15.95,
      priceText: '$15.95',
      dietary: [],
    },
    {
      section: 'STARTERS',
      name: 'Chips & Salsa',
      description: 'est. 1955',
      price: 6,
      priceText: '6',
      dietary: [],
    },
  ]);
});
