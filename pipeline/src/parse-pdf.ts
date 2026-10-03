// Debug helper: npm run parse-pdf -- <url> — shows what the PDF parser extracts from one menu.
import { USER_AGENT } from './config.ts';
import { parsePdfMenu } from './pdf-parser.ts';

const url = process.argv[2];
if (!url) throw new Error('Usage: npm run parse-pdf -- <url>');

const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
const items = await parsePdfMenu(new Uint8Array(await res.arrayBuffer()));
console.log(`items: ${items.length}`);
console.table(
  items.slice(0, Number(process.env.SHOW) || 12).map((i) => ({
    section: i.section?.slice(0, 22),
    name: i.name.slice(0, 40),
    price: i.priceText,
    description: i.description?.slice(0, 50),
  })),
);
