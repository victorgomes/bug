// Batch fetch + format primitives shared by bnz_issue / bnz_cf handlers.
//
// batchFetch: iterate items, capturing per-item errors so one bad input
// doesn't lose the work done on the others. AuthRequiredError is re-thrown
// because every subsequent fetch in the same session would hit the same
// wall; the dispatcher uses it to abort the whole tool call.
//
// formatEntries / maybeWriteAndSummarize: render entries to markdown or JSON
// and optionally spill to a file, returning a short envelope instead of the
// full content so the model's context doesn't have to hold it.

import { writeFile } from 'node:fs/promises';

import { AuthRequiredError } from '../lib/browser.js';
import { sanitizeDeep } from '../lib/render.js';

export const MARKDOWN_SEPARATOR = '\n\n---\n\n';

export function renderItemError(item, err) {
  return `# Error fetching \`${item}\`\n\n${err}\n`;
}

export async function batchFetch({ items, fetchOne }) {
  const entries = [];
  for (const item of items) {
    try {
      entries.push({ ok: true, item, data: await fetchOne(item) });
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      entries.push({ ok: false, item, error: String(err.message || err) });
    }
  }
  return entries;
}

export function formatEntries({ entries, render, format }) {
  if (format === 'json') {
    return JSON.stringify(
      sanitizeDeep(entries.map((e) =>
        e.ok ? e.data : { input: e.item, error: e.error })),
      null, 2,
    );
  }
  return entries
    .map((e) => e.ok ? render(e.data) : renderItemError(e.item, e.error))
    .join(MARKDOWN_SEPARATOR);
}

export async function maybeWriteAndSummarize({ text, entries, outputFile, label }) {
  if (!outputFile) return text;
  await writeFile(outputFile, text);
  return summarizeWrite({ outputFile, text, entries, label });
}

function summarizeWrite({ outputFile, text, entries, label }) {
  const bytes = Buffer.byteLength(text);
  const total = entries.length;
  const ok = entries.filter((e) => e.ok).length;
  const fail = total - ok;
  const noun = total === 1 ? label : `${label}s`;
  const lines = [`Wrote ${total} ${noun} to ${outputFile} (${bytes} bytes).`];
  if (fail) {
    lines.push(`${fail} failed:`);
    for (const e of entries) {
      if (!e.ok) lines.push(`- ${e.item}: ${e.error}`);
    }
  }
  return lines.join('\n');
}
