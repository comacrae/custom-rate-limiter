// Debug helper: npm run parse-url -- <url> — shows what the parsers extract from one page.
import * as cheerio from 'cheerio';

import { USER_AGENT } from './config.ts';
import { parseMenuPage } from './menu-parsers.ts';

const url = process.argv[2];
if (!url) throw new Error('Usage: npm run parse-url -- <url>');

const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
const result = parseMenuPage(cheerio.load(await res.text()));
if (!result) {
  console.log('No menu found');
} else {
  const items = result.menus.flatMap((m) => m.items.map((i) => ({ menu: m.name, ...i })));
  console.log(`parser: ${result.parser}, items: ${items.length}`);
  console.table(
    items.slice(0, Number(process.env.SHOW) || 12).map((i) => ({
      menu: i.menu.slice(0, 18),
      section: i.section?.slice(0, 22),
      name: i.name.slice(0, 40),
      price: i.priceText,
      description: i.description?.slice(0, 50),
    })),
  );
}
