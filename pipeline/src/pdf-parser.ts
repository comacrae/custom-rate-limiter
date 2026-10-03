// Reads menus from text-based PDFs. Scanned (image-only) PDFs have no text and return [].
import { getDocumentProxy } from 'unpdf';

import {
  isPlausibleName,
  mergeSizeVariants,
  MIN_ITEMS,
  parsePrice,
  stripNul,
  type MenuItemDraft,
} from './menu-parsers.ts';

export type TextPiece = { x: number; y: number; width: number; height: number; text: string };

type Segment = { x: number; text: string };

// The name must end in a non-digit so "est. 1955" isn't read as "est. 1" at $955
const PRICE_AT_END = /^(.*?\D)[\s.·…_–-]*\$?\s?(\d{1,3}(?:\.\d{2})?)\+?$/;
const PRICE_ONLY = /^\$?\s?\d{1,3}(?:\.\d{2})?\+?$/;

// Groups pieces into lines, then splits each line into segments at large horizontal gaps
export function toSegmentLines(pieces: TextPiece[]): Segment[][] {
  // Faux-bold PDFs print the same text twice at almost the same spot
  const unique = pieces.filter(
    (p, i) =>
      p.text.trim() &&
      !pieces
        .slice(0, i)
        .some((q) => q.text === p.text && Math.abs(q.x - p.x) < 2 && Math.abs(q.y - p.y) < 2),
  );
  const sorted = unique.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextPiece[][] = [];
  for (const piece of sorted) {
    const line = lines.at(-1);
    const tolerance = Math.max(2, piece.height * 0.4);
    if (line && Math.abs(line[0].y - piece.y) <= tolerance) line.push(piece);
    else lines.push([piece]);
  }

  return lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    let end = -Infinity;
    for (const piece of line) {
      const gap = piece.x - end;
      const current = segments.at(-1);
      // Column gaps are much wider than a space; touching pieces are fragments of one word
      if (current && gap < Math.max(piece.height, 6) * 2) {
        // Separate words often abut with no space character; digit fragments ("1","6",".95") don't get one
        const wordBreak =
          /[a-z,]$/i.test(current.text) &&
          /^[a-z(]/i.test(piece.text) &&
          (gap > 0.5 || piece.text.length > 3);
        current.text += gap > piece.height * 0.15 || wordBreak ? ` ${piece.text}` : piece.text;
      } else {
        segments.push({ x: piece.x, text: piece.text });
      }
      end = piece.x + piece.width;
    }
    return segments.map((s) => ({ x: s.x, text: stripNul(s.text).replace(/\s+/g, ' ').trim() }));
  });
}

// Two-letter "headings" are usually OCR fragments ("AD" from "SALAD")
const isHeading = (text: string) =>
  text.length >= 3 &&
  text.length <= 40 &&
  /[A-Z]/.test(text) &&
  text === text.toUpperCase() &&
  !/\d/.test(text);

export function parseSegmentLines(lines: Segment[][]): MenuItemDraft[] {
  const items: (MenuItemDraft & { x: number })[] = [];
  let section: string | null = null;
  let pendingName: Segment | null = null;

  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const seg = line[i];
      const next = line[i + 1];
      // "Name" segment followed by a separate price segment on the same line
      if (next && PRICE_ONLY.test(next.text) && isPlausibleName(seg.text)) {
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
      if (PRICE_ONLY.test(seg.text)) {
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
      const match = seg.text.match(PRICE_AT_END);
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

export async function parsePdfMenu(bytes: Uint8Array): Promise<MenuItemDraft[]> {
  const pdf = await getDocumentProxy(bytes);
  const items: MenuItemDraft[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 12); n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const pieces: TextPiece[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      pieces.push({
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height || Math.abs(item.transform[3]),
        text: item.str,
      });
    }
    items.push(...parseSegmentLines(toSegmentLines(pieces)));
  }
  await pdf.cleanup();
  return items.length >= MIN_ITEMS ? items : [];
}
