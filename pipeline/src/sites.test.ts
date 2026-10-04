import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  coreName,
  isOwnLocationPage,
  isSisterDomain,
  nameTokens,
  normalizeName,
  siteHost,
} from './sites.ts';

test('names normalize across accents, ampersands, and "the"', () => {
  assert.equal(normalizeName('The Girl & the Goat'), normalizeName('Girl and The Goat'));
  assert.equal(normalizeName('Cariño'), 'carino');
  assert.equal(normalizeName("Boonie's Filipino"), 'boonies filipino');
});

test('core names also ignore generic words', () => {
  assert.equal(coreName('Gilt Bar'), coreName('Gilt'));
  assert.equal(coreName('Ever Restaurant'), 'ever');
});

test('siteHost drops scheme, www, path, and case', () => {
  assert.equal(siteHost('http://Www.ChicagoFalafel.com/menu/'), 'chicagofalafel.com');
  assert.equal(siteHost('smythchicago.com'), 'smythchicago.com');
});

test('nameTokens keeps distinctive words only', () => {
  assert.deepEqual(nameTokens('The Dining Room at Moody Tongue'), ['moody', 'tongue']);
  assert.deepEqual(nameTokens('Cariño'), ['carino']);
  assert.deepEqual(nameTokens('Girl & The Goat'), ['girl', 'goat']);
});

test('sister domains must carry the name and not be a platform', () => {
  assert.equal(isSisterDomain('smythchicago.com', nameTokens('Smyth')), true);
  assert.equal(isSisterDomain('exploretock.com', nameTokens('Smyth')), false);
  assert.equal(isSisterDomain('instagram.com', nameTokens('Instagram Grill')), false);
  assert.equal(isSisterDomain('alinearestaurant.com', nameTokens('Smyth')), false);
});

test('location pages: city hubs, /location/ paths, or the restaurant name', () => {
  const tokens = nameTokens('Moody Tongue');
  assert.equal(isOwnLocationPage('/location/the-dining-room-at-moody-tongue/', tokens), true);
  assert.equal(isOwnLocationPage('/chicago', nameTokens('Girl & The Goat')), true);
  assert.equal(isOwnLocationPage('/restaurants/topolobampo', nameTokens('Topolobampo')), true);
  assert.equal(isOwnLocationPage('/brewmaster-jared-rouben/', tokens), false);
});
