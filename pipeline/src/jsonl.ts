// Append-as-you-go JSONL output, so a crash late in a long crawl keeps the finished work
import { appendFile, writeFile } from 'node:fs/promises';

import { OUT_DIR } from './config.ts';

export async function jsonlWriter<T>(file: string) {
  const url = new URL(file, OUT_DIR);
  await writeFile(url, '');
  return (row: T) => appendFile(url, `${JSON.stringify(row)}\n`);
}
