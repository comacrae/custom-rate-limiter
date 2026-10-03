// Turns a menu page into structured menus. Each parser returns [] when it doesn't apply.
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

export type MenuItemDraft = {
  section: string | null;
  name: string;
  description: string | null;
  price: number | null;
  priceText: string | null;
  dietary: string[];
};

export type MenuDraft = { name: string; items: MenuItemDraft[] };

export type ParseResult = { parser: string; menus: MenuDraft[] };

// Postgres text can't hold NUL characters, which some PDFs contain
export const stripNul = (text: string) => text.replace(/\x00/g, '');

const clean = (text: string | undefined | null) =>
  stripNul(text ?? '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function parsePrice(text: string): { price: number | null; priceText: string | null } {
  const priceText = clean(text) || null;
  // A comma before exactly two digits is a decimal point ("3,75"); "1,200" is not
  const match = priceText?.match(/\d{1,4}(?:\.\d{1,2}|,\d{2}(?!\d))?/);
  // "$0" is nearly always a split fragment ("14," + "00") or a placeholder, not a real price
  const price = match ? Number(match[0].replace(',', '.')) : null;
  return { price: price ? price : null, priceText };
}

// Dot leaders inside a name: "SCALLOPS TEMPURA......$25.90" or "Tofu........ Add"
const DOT_LEADER = /\s*[.…·_]{3,}\s*/;

// A price far above the rest of its menu is usually a lost decimal ("5⁵⁰" read as 550)
const OUTLIER_FACTOR = 20;
const OUTLIER_MIN_PRICE = 100;

// Calorie and nutrition sheets list numbers that look like prices but run in the hundreds
const MAX_PLAUSIBLE_MEDIAN_PRICE = 200;

// Some PDFs store text with a space after every letter and no wider gap between words
// ("K i d s B r e a k f a s t"), so the words can't be recovered
const LETTER_SPACED = /^(?:\S ){4,}\S/;

const MIN_MEDIAN_NAME_LENGTH = 4;

// Final tidy-up applied to every menu before it's stored, whichever parser produced it.
// Returns null for menus that turn out not to be menus (e.g. calorie sheets).
export function tidyMenu(menu: MenuDraft): MenuDraft | null {
  const items = menu.items.flatMap((item) => {
    let { name, price, priceText, description } = item;
    const [before, ...rest] = name.split(DOT_LEADER);
    if (rest.length) {
      name = before;
      const remainder = rest
        .join(' ')
        .replace(/^\$?\s*$/, '')
        .trim();
      if (remainder && price === null && /\d/.test(remainder)) {
        ({ price, priceText } = parsePrice(remainder));
      } else if (remainder) {
        description = [remainder, description].filter(Boolean).join(' ');
      }
    }
    if (price === 0) price = null;
    // Separators left over from "RIVERSIDE NACHOS | 13" or "Cheese only: 14"
    name = name.replace(/[\s|:–-]+$/, '');
    return isPlausibleName(name) && !LETTER_SPACED.test(name)
      ? [{ ...item, name, price, priceText, description }]
      : [];
  });
  const prices = items
    .map((i) => i.price)
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  if (median > MAX_PLAUSIBLE_MEDIAN_PRICE) return null;
  // Codes and fragments ("CQ", "SV", "Live") instead of dish names mean a misread page
  const nameLengths = items.map((i) => i.name.length).sort((a, b) => a - b);
  if (nameLengths[Math.floor(nameLengths.length / 2)] < MIN_MEDIAN_NAME_LENGTH) return null;
  for (const item of items) {
    // Keep the printed price text; only the numeric price is unreliable
    if (
      item.price !== null &&
      item.price >= OUTLIER_MIN_PRICE &&
      item.price > median * OUTLIER_FACTOR
    ) {
      item.price = null;
    }
  }
  return items.length ? { ...menu, items } : null;
}

// Rejects buttons, legal copy, and other non-dish text that sits next to prices
export function isPlausibleName(name: string) {
  return (
    name.length >= 2 &&
    name.length <= 90 &&
    /[a-z]/i.test(name) &&
    !/^(add|order|buy|view|select|choose|subtotal|total|tax|tip|delivery)\b/i.test(name) &&
    // Online store labels on cafés' and wine shops' product grids
    !/^((regular|sale|special|unit|original) price|sold out|quick (view|shop)|in stock)\b/i.test(
      name,
    ) &&
    // Calorie labels ("cal 400-") and size headers ("personal big family") aren't dishes
    !/^(cal|calories)\b/i.test(name) &&
    !/^((personal|small|medium|large|big|family|regular|half|full|single|double|sm|md|lg|xl)\s*){2,}$/i.test(
      name,
    ) &&
    !PAGE_BOILERPLATE.test(name)
  );
}

// Footer, banner, and contact text that ends up next to menus
const PAGE_BOILERPLATE =
  /@|https?:|www\.|cookie (policy|settings|preferences)|accept (all )?cookies|copyright|©|all rights reserved|powered by|privacy policy|post views|our location|follow us|sign up|newsletter|subscribe|website uses|call us|gift card|^serves\b|\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/i;

function countItems(menus: MenuDraft[]) {
  return menus.reduce((n, m) => n + m.items.length, 0);
}

// schema.org Menu / MenuSection / MenuItem in JSON-LD (BentoBox and others)
export function parseJsonLd($: CheerioAPI): MenuDraft[] {
  const menus = new Map<string, MenuItemDraft[]>();
  const walk = (node: unknown, menu: string, section: string | null) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, menu, section);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const types = [obj['@type']].flat();
    if (types.includes('Menu')) menu = clean(String(obj.name ?? ''));
    if (types.includes('MenuSection')) section = clean(String(obj.name ?? '')) || null;
    if (types.includes('MenuItem')) {
      const name = clean(String(obj.name ?? ''));
      if (!isPlausibleName(name)) return;
      const offer = [obj.offers].flat()[0] as Record<string, unknown> | undefined;
      const rawPrice = offer?.price ?? offer?.lowPrice;
      const diets = [obj.suitableForDiet].flat().filter((d): d is string => typeof d === 'string');
      const items = menus.get(menu) ?? [];
      items.push({
        section,
        name,
        description: clean(String(obj.description ?? '')) || null,
        ...(rawPrice == null ? { price: null, priceText: null } : parsePrice(String(rawPrice))),
        dietary: diets.map((d) =>
          d
            .replace(/^https?:\/\/schema\.org\//, '')
            .replace(/Diet$/, '')
            .toLowerCase(),
        ),
      });
      menus.set(menu, items);
      return;
    }
    for (const value of Object.values(obj)) walk(value, menu, section);
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).text()), '', null);
    } catch {
      // Malformed JSON-LD is common; skip it
    }
  });
  return [...menus].map(([name, items]) => ({ name, items }));
}

// Squarespace's built-in menu block; prices often have no "$"
export function parseSquarespace($: CheerioAPI): MenuDraft[] {
  const menus: MenuDraft[] = [];
  $('.menu-block').each((_, block) => {
    // Tab labels are listed in the same order as the menus they switch between
    const labels = $(block)
      .find('.menu-select-labels')
      .map((_, el) => clean($(el).text()))
      .get();
    $(block)
      .find('.menu')
      .each((index, menuEl) => {
        const items: MenuItemDraft[] = [];
        $(menuEl)
          .find('.menu-section')
          .each((_, sectionEl) => {
            const section = clean($(sectionEl).find('.menu-section-title').first().text()) || null;
            $(sectionEl)
              .find('.menu-item')
              .each((_, itemEl) => {
                const title = clean($(itemEl).find('.menu-item-title').first().text());
                const priceEl = $(itemEl).find('.menu-item-price-top, .menu-item-price-bottom');
                let price = parsePrice(priceEl.first().text());
                let description = clean($(itemEl).find('.menu-item-description').text()) || null;
                // Some sites put tasting notes in the price field; keep "MP"-style short labels
                if (price.priceText && !/\d/.test(price.priceText) && price.priceText.length > 12) {
                  description ??= price.priceText;
                  price = { price: null, priceText: null };
                }
                const fromTitle = price.priceText ? null : splitTrailingPrice(title);
                const name = fromTitle?.name ?? title;
                if (!isPlausibleName(name)) return;
                items.push({
                  section,
                  name,
                  description,
                  price: fromTitle?.price ?? price.price,
                  priceText: fromTitle?.priceText ?? price.priceText,
                  dietary: [],
                });
              });
          });
        if (items.length) menus.push({ name: labels[index] ?? '', items });
      });
  });
  return menus;
}

const PRICE_ONLY =
  /^\$\s?\d{1,3}(?:[.,]\d{2})?(?:\s*(?:\/|\||-|–)\s*\$?\s?\d{1,3}(?:[.,]\d{2})?)*\+?$/;
const HEADING = 'h1, h2, h3, h4, h5, h6';

function ownText($: CheerioAPI, el: Element) {
  return clean(
    $(el)
      .contents()
      .filter((_, c) => c.type === 'text')
      .text(),
  );
}

// Fallback for any layout: anchor on elements whose own text is just a "$" price, then take
// the largest ancestor that holds no other price as the menu item
export function parseGeneric($: CheerioAPI): MenuDraft[] {
  $('script, style, noscript, svg, nav, header, footer, form, select, button').remove();
  const root = $('main').first().length ? $('main').first() : $('body');

  const priceEls = root
    .find('*')
    .toArray()
    .filter((el): el is Element => el.type === 'tag' && PRICE_ONLY.test(ownText($, el)));
  // How many price elements each ancestor contains
  const priceCount = new Map<AnyNode, number>();
  for (const priceEl of priceEls) {
    for (let node: AnyNode | null = priceEl; node; node = node.parent) {
      priceCount.set(node, (priceCount.get(node) ?? 0) + 1);
    }
  }

  const rootEl = root.get(0);
  const itemOf = new Map<Element, Element>();
  for (const priceEl of priceEls) {
    let item: Element = priceEl;
    for (let parent = priceEl.parent; parent && parent.type === 'tag'; parent = parent.parent) {
      if ((priceCount.get(parent) ?? 0) > 1 || parent === rootEl) break;
      item = parent;
    }
    itemOf.set(item, priceEl);
  }

  // Walk the page in order; headings outside any item mark the current section
  const items: MenuItemDraft[] = [];
  let section: string | null = null;
  const visit = (node: AnyNode) => {
    if (node.type !== 'tag') return;
    const priceEl = itemOf.get(node);
    if (priceEl) {
      const item = toMenuItem($, node, ownText($, priceEl), section);
      if (item) items.push(item);
      return;
    }
    if (/^h[1-6]$/.test(node.name)) {
      section = clean($(node).text()) || section;
      return;
    }
    node.children.forEach(visit);
  };
  if (rootEl) visit(rootEl);
  return items.length ? [{ name: '', items: mergeSizeVariants(items) }] : [];
}

const SIZE_LABEL =
  /^(sm|small|md|med|medium|lg|large|xl|half|full|whole|regular|single|double|glass|bottle|carafe|pitcher|pint|cup|bowl|slice|pie|dozen|half dozen|tray|half tray|full tray|\d+(\.\d+)?\s?(oz|l|ml|in|"|pc|pcs|piece|pieces))$/i;

// "Lg $47.95" listed under a dish is a price option of that dish, not a dish of its own
export function mergeSizeVariants(items: MenuItemDraft[]): MenuItemDraft[] {
  const merged: MenuItemDraft[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    if (previous && SIZE_LABEL.test(item.name)) {
      const option = `${item.name} ${item.priceText ?? ''}`.trim();
      previous.priceText = previous.priceText ? `${previous.priceText} / ${option}` : option;
      previous.price ??= item.price;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

// Squarespace titles like "Homemade Chips 6" carry the price when the price field is empty
function splitTrailingPrice(title: string) {
  const match = title.match(/^(.*\D)\s+\$?(\d{1,3}(?:\.\d{2})?)$/);
  return match ? { name: match[1].trim(), ...parsePrice(match[2]) } : null;
}

// Short badges that sit beside dish names; kept as dietary tags instead of names
const DIET_BADGE =
  /^(v|vg|gf|df|vegan|vegetarian|gluten[- ]free|dairy[- ]free|spicy|halal|kosher|new|popular)$/i;

function toMenuItem(
  $: CheerioAPI,
  item: Element,
  priceText: string,
  section: string | null,
): MenuItemDraft | null {
  const dietary: string[] = [];
  const blocks: string[] = [];
  const heading = clean($(item).find(HEADING).first().text());
  for (const el of $(item).find('*').toArray()) {
    if (el.type !== 'tag') continue;
    const text = ownText($, el);
    if (!text || text === priceText) continue;
    if (DIET_BADGE.test(text)) dietary.push(text.toLowerCase());
    else blocks.push(text);
  }
  // Without a heading, the name is the first text block that isn't the price or a badge
  const name = heading && !DIET_BADGE.test(heading) ? heading : (blocks[0] ?? '');
  if (!isPlausibleName(name)) return null;
  const description = clean(
    blocks
      .filter((t) => t !== name)
      .join(' ')
      .replace(priceText, ''),
  );
  return {
    section,
    name,
    description: description && description.length <= 600 ? description : null,
    ...parsePrice(priceText),
    dietary,
  };
}

const MIN_HEADING_ITEMS = 8;

// Unpriced text menus: the most common heading level holds dish names, the paragraphs after
// each one describe it, and higher-level headings are sections. Only safe on pages already
// known to be menus, since any heading-heavy page would otherwise match.
export function parseHeadingMenu($: CheerioAPI): MenuDraft[] {
  $('script, style, noscript, svg, nav, header, footer, form, aside').remove();
  const root = $('main').first().length ? $('main').first() : $('body');
  const levels = ['h2', 'h3', 'h4', 'h5', 'h6'];
  const counts = levels.map((level) => root.find(level).length);
  const best = Math.max(...counts);
  if (best < MIN_HEADING_ITEMS) return [];
  // Deepest level wins ties: dish names sit below section headings
  const itemLevel = levels[counts.lastIndexOf(best)];
  const itemRank = Number(itemLevel[1]);

  const items: MenuItemDraft[] = [];
  let section: string | null = null;
  root.find(HEADING).each((_, el) => {
    const rank = Number(el.tagName[1]);
    const text = clean($(el).text());
    if (rank < itemRank) {
      section = text || section;
      return;
    }
    if (
      rank !== itemRank ||
      text.length > 70 ||
      !isPlausibleName(text) ||
      /:$/.test(text) ||
      MENU_TITLE.test(text)
    ) {
      return;
    }
    // Page builders wrap each heading in its own box; widen to the largest ancestor that still
    // holds only this dish, then the rest of its text is the description
    let box: Element = el;
    for (let parent = el.parent; parent?.type === 'tag'; parent = parent.parent) {
      if ($(parent).find(itemLevel).length > 1 || parent === root.get(0)) break;
      box = parent;
    }
    const description = clean(
      box === el
        ? $(el)
            .nextUntil(HEADING)
            .map((_, sib) => $(sib).text())
            .get()
            .join(' ')
        : $(box).text().replace($(el).text(), ''),
    );
    items.push({
      section,
      name: text,
      description: description && description.length <= 400 ? description : null,
      price: null,
      priceText: null,
      dietary: [],
    });
  });
  const uniqueNames = new Set(items.map((i) => i.name.toLowerCase()));
  // Bare heading lists without descriptions are usually category indexes or state lists
  const described = items.filter((i) => i.description).length;
  return uniqueNames.size >= MIN_HEADING_ITEMS && described >= items.length * 0.4
    ? [{ name: '', items }]
    : [];
}

// Responsive layouts often render the same menu twice; drop exact repeats
function dropDuplicateItems(menus: MenuDraft[]): MenuDraft[] {
  return menus.map((menu) => {
    const seen = new Set<string>();
    const items = menu.items.filter((item) => {
      const key = [item.section, item.name, item.description, item.priceText].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...menu, items };
  });
}

// Headings that name a menu rather than a dish, as on menu index pages
const MENU_TITLE =
  /^(breakfast|brunch|lunch|dinner|dessert|desserts|drinks?|wine( list)?|wines|beer|cocktails|happy hour|catering|specials|kids|menu)( menu)?s?$/i;

export const GENERIC_LABEL = /^(our |view |see |full |the )?menus?$/i;

// "dinner-menu" → "Dinner Menu"; used when a page or PDF doesn't name its menu. Drops dates
// and ID-like tokens such as Wix file hashes.
export function labelFromUrl(url: URL) {
  let slug = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Keep the raw slug
  }
  const words = slug
    .replace(/\.\w+$/, '')
    .split(/[-_\s]+/)
    .filter((w) => w && !/\d/.test(w) && w.toLowerCase() !== 'pdf')
    .join(' ');
  return words && !GENERIC_LABEL.test(words) ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

// Same menu shown on two pages (e.g. homepage and /menu) should only be stored once
export function menuSignature(menu: MenuDraft) {
  return menu.items
    .slice(0, 8)
    .map((i) => `${i.name.toLowerCase()}|${i.price}`)
    .join(';');
}

// A run of text on one line; x is its horizontal position (0 for HTML text)
export type Segment = { x: number; text: string };

// The name must end in a non-digit so "est. 1955" isn't read as "est. 1" at $955
const LINE_PRICE_AT_END = /^(.*?\D)[\s.·…_–-]*\$?\s?(\d{1,3}(?:[.,]\d{2})?)\+?$/;
const LINE_PRICE_ONLY = /^\$?\s?\d{1,3}(?:[.,]\d{2})?\+?$/;

// Two-letter "headings" are usually OCR or PDF fragments ("AD" from "SALAD")
const isHeading = (text: string) =>
  text.length >= 3 &&
  text.length <= 40 &&
  /[A-Z]/.test(text) &&
  text === text.toUpperCase() &&
  !/\d/.test(text);

// Reads "name … price" lines with descriptions on the lines below. Shared by PDF menus and
// HTML text menus whose prices have no "$" or sit in the same text as the name.
export function parseSegmentLines(lines: Segment[][]): MenuItemDraft[] {
  const items: (MenuItemDraft & { x: number })[] = [];
  let section: string | null = null;
  let pendingName: Segment | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    for (let i = 0; i < line.length; i++) {
      const seg = line[i];
      const next = line[i + 1];
      const nextLineStart = i === line.length - 1 ? lines[lineIndex + 1]?.[0] : undefined;
      // "Name" segment followed by a separate price segment on the same line
      if (next && LINE_PRICE_ONLY.test(next.text) && isPlausibleName(seg.text)) {
        items.push({
          x: seg.x,
          section,
          name: seg.text,
          description: null,
          ...parsePrice(next.text),
          dietary: [],
        });
        i++;
        pendingName = null;
        continue;
      }
      // A price on its own line closes a name from the line above
      if (LINE_PRICE_ONLY.test(seg.text)) {
        if (pendingName) {
          items.push({
            x: pendingName.x,
            section,
            name: pendingName.text,
            description: null,
            ...parsePrice(seg.text),
            dietary: [],
          });
          pendingName = null;
        }
        continue;
      }
      const match = seg.text.match(LINE_PRICE_AT_END);
      if (match && isPlausibleName(match[1])) {
        items.push({
          x: seg.x,
          section,
          name: match[1].trim(),
          description: null,
          ...parsePrice(match[2]),
          dietary: [],
        });
        pendingName = null;
        continue;
      }
      if (isHeading(seg.text) && isPlausibleName(seg.text)) {
        section = seg.text;
        pendingName = seg;
        continue;
      }
      // A name whose price is alone on the next line starts a new item, not a description
      if (
        nextLineStart &&
        LINE_PRICE_ONLY.test(nextLineStart.text) &&
        Math.abs(nextLineStart.x - seg.x) <= 400 &&
        isPlausibleName(seg.text)
      ) {
        pendingName = seg;
        continue;
      }
      // Unpriced text describes the latest item in the same column
      const owner = items.findLast((item) => Math.abs(item.x - seg.x) <= 15);
      if (owner)
        owner.description = owner.description ? `${owner.description} ${seg.text}` : seg.text;
      pendingName = isPlausibleName(seg.text) ? seg : null;
    }
  }
  return mergeSizeVariants(
    items.map(({ x: _x, ...item }) => ({
      ...item,
      description: item.description && item.description.length <= 600 ? item.description : null,
    })),
  );
}

const BLOCK = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, dt, dd';

// Text menus whose prices have no "$" ("French Fries 4.50") or share the name's text
// ("Tony Soprano $15"): split the page into lines at block elements and <br>, then read
// them like a PDF. Only safe on pages already known to be menus.
export function parseTextLines($: CheerioAPI): MenuDraft[] {
  $('script, style, noscript, svg, nav, header, footer, form, aside, select, button').remove();
  const root = $('main').first().length ? $('main').first() : $('body');
  root.find('br').replaceWith('\n');
  root.find(BLOCK).each((_, el) => {
    $(el).prepend('\n').append('\n');
  });
  const lines = root
    .text()
    .split('\n')
    .map((line) => clean(line))
    .filter(Boolean)
    .map((text) => [{ x: 0, text }]);
  const items = parseSegmentLines(lines);
  const share = (test: (i: MenuItemDraft) => boolean) =>
    items.filter(test).length / Math.max(items.length, 1);
  // Misread pages produce lowercase fragments ("from") and ingredient lists as names
  const looksLikeMenu =
    items.length >= MIN_ITEMS &&
    share((i) => i.price !== null) >= 0.6 &&
    share((i) => /^[A-Z0-9*"'(]/.test(i.name)) >= 0.7 &&
    share((i) => i.name.includes(',')) <= 0.2;
  return looksLikeMenu ? [{ name: '', items }] : [];
}

// Most specific parser first; a page needs at least this many items to count as a menu
export const MIN_ITEMS = 5;

// knownMenuPage: the page was reached through a menu link, so unpriced heading lists count
export function parseMenuPage($: CheerioAPI, { knownMenuPage = false } = {}): ParseResult | null {
  for (const [parser, parse] of [
    ['jsonld', parseJsonLd],
    ['squarespace', parseSquarespace],
    ['generic', parseGeneric],
  ] as const) {
    const menus = dropDuplicateItems(parse($));
    if (countItems(menus) >= MIN_ITEMS) return { parser, menus };
  }
  if (knownMenuPage) {
    // Priced text lines first; unpriced heading lists are the last resort
    const fromText = dropDuplicateItems(parseTextLines($));
    if (fromText.length) return { parser: 'text', menus: fromText };
    const menus = dropDuplicateItems(parseHeadingMenu($));
    if (menus.length) return { parser: 'headings', menus };
  }
  return null;
}
