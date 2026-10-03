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

const clean = (text: string | undefined | null) =>
  (text ?? '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function parsePrice(text: string): { price: number | null; priceText: string | null } {
  const priceText = clean(text) || null;
  const match = priceText?.match(/\d{1,4}(?:\.\d{1,2})?/);
  return { price: match ? Number(match[0]) : null, priceText };
}

// Rejects buttons, legal copy, and other non-dish text that sits next to prices
export function isPlausibleName(name: string) {
  return (
    name.length >= 2 &&
    name.length <= 90 &&
    /[a-z]/i.test(name) &&
    !/^(add|order|buy|view|select|choose|subtotal|total|tax|tip|delivery)\b/i.test(name)
  );
}

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
                const price = parsePrice(priceEl.first().text());
                const fromTitle = price.priceText ? null : splitTrailingPrice(title);
                const name = fromTitle?.name ?? title;
                if (!isPlausibleName(name)) return;
                items.push({
                  section,
                  name,
                  description: clean($(itemEl).find('.menu-item-description').text()) || null,
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
  return uniqueNames.size >= MIN_HEADING_ITEMS ? [{ name: '', items }] : [];
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

// Most specific parser first; a page needs at least this many items to count as a menu
export const MIN_ITEMS = 5;

// knownMenuPage: the page was reached through a menu link, so unpriced heading lists count
export function parseMenuPage($: CheerioAPI, { knownMenuPage = false } = {}): ParseResult | null {
  for (const [parser, parse] of [
    ['jsonld', parseJsonLd],
    ['squarespace', parseSquarespace],
    ['generic', parseGeneric],
  ] as const) {
    const menus = parse($);
    if (countItems(menus) >= MIN_ITEMS) return { parser, menus };
  }
  if (knownMenuPage) {
    const menus = parseHeadingMenu($);
    if (menus.length) return { parser: 'headings', menus };
  }
  return null;
}
