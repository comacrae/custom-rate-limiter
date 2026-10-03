// Reads menus from text-based PDFs. Scanned (image-only) PDFs have no text and return [].
import { getDocumentProxy } from 'unpdf';

import {
  MIN_ITEMS,
  parseSegmentLines,
  stripNul,
  type MenuItemDraft,
  type Segment,
} from './menu-parsers.ts';

export type TextPiece = { x: number; y: number; width: number; height: number; text: string };

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
