import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AuthRequiredError } from '../lib/browser.js';
import {
  MARKDOWN_SEPARATOR, batchFetch, formatEntries, maybeWriteAndSummarize,
} from '../mcp-server/batch.js';

test('batchFetch returns one entry per item in order on success', async () => {
  const entries = await batchFetch({
    items: ['a', 'b', 'c'],
    fetchOne: async (x) => ({ value: x.toUpperCase() }),
  });
  assert.deepEqual(entries, [
    { ok: true, item: 'a', data: { value: 'A' } },
    { ok: true, item: 'b', data: { value: 'B' } },
    { ok: true, item: 'c', data: { value: 'C' } },
  ]);
});

test('batchFetch captures per-item errors and continues', async () => {
  const entries = await batchFetch({
    items: ['ok1', 'bad', 'ok2'],
    fetchOne: async (x) => {
      if (x === 'bad') throw new Error('nope');
      return { value: x };
    },
  });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].ok, true);
  assert.equal(entries[1].ok, false);
  assert.equal(entries[1].item, 'bad');
  assert.equal(entries[1].error, 'nope');
  assert.equal(entries[2].ok, true);
});

test('batchFetch aborts the whole batch on AuthRequiredError', async () => {
  let calls = 0;
  await assert.rejects(
    () => batchFetch({
      items: ['ok', 'auth', 'never'],
      fetchOne: async (x) => {
        calls++;
        if (x === 'auth') throw new AuthRequiredError('https://example/123');
        return { value: x };
      },
    }),
    AuthRequiredError,
  );
  assert.equal(calls, 2, 'must stop after the auth error, not call the third item');
});

test('formatEntries (markdown) joins per-item renders and inlines errors', () => {
  const entries = [
    { ok: true, item: '1', data: { body: 'first' } },
    { ok: false, item: '2', error: 'boom' },
    { ok: true, item: '3', data: { body: 'third' } },
  ];
  const text = formatEntries({
    entries,
    render: (d) => `## ${d.body}`,
    format: 'markdown',
  });
  const parts = text.split(MARKDOWN_SEPARATOR);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], '## first');
  assert.match(parts[1], /Error fetching `2`/);
  assert.match(parts[1], /boom/);
  assert.equal(parts[2], '## third');
});

test('formatEntries (json) returns array with error entries inline', () => {
  const entries = [
    { ok: true, item: '1', data: { id: 1, body: 'first' } },
    { ok: false, item: '2', error: 'boom' },
  ];
  const text = formatEntries({ entries, render: () => '', format: 'json' });
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, [
    { id: 1, body: 'first' },
    { input: '2', error: 'boom' },
  ]);
});

test('formatEntries (json) runs values through sanitizeDeep', () => {
  const entries = [{ ok: true, item: '1', data: { body: 'safe\x1b[31mred' } }];
  const parsed = JSON.parse(formatEntries({ entries, render: () => '', format: 'json' }));
  assert.equal(parsed[0].body, 'safered');
});

test('maybeWriteAndSummarize without outputFile is a pass-through', async () => {
  const out = await maybeWriteAndSummarize({
    text: 'hello',
    entries: [{ ok: true, item: 'x' }],
    outputFile: undefined,
    label: 'thing',
  });
  assert.equal(out, 'hello');
});

test('maybeWriteAndSummarize writes the file and returns a summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bnz-mcp-test-'));
  try {
    const file = join(dir, 'out.md');
    const text = 'one\n---\ntwo\n---\nthree';
    const entries = [
      { ok: true, item: 'a' },
      { ok: false, item: 'b', error: 'lost it' },
      { ok: true, item: 'c' },
    ];
    const summary = await maybeWriteAndSummarize({
      text, entries, outputFile: file, label: 'issue',
    });
    assert.equal(await readFile(file, 'utf8'), text);
    assert.match(summary, new RegExp(`Wrote 3 issues to ${file} \\(\\d+ bytes\\)`));
    assert.match(summary, /1 failed/);
    assert.match(summary, /- b: lost it/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maybeWriteAndSummarize singularizes the label for one item', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bnz-mcp-test-'));
  try {
    const file = join(dir, 'out.md');
    const summary = await maybeWriteAndSummarize({
      text: 'only',
      entries: [{ ok: true, item: 'sole' }],
      outputFile: file,
      label: 'issue',
    });
    assert.match(summary, /Wrote 1 issue to/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
