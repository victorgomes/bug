import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractSearchHits, extractSearchRows, findTestcaseKeyInMarkdown,
  parseArgs, parseSince, sanitizeFilename,
} from '../bnz.js';
import {
  exportSessionState, importSessionState, pushSessionOverSsh,
} from '../lib/browser.js';
import { sanitizeDeep, sanitizeTerminalText } from '../lib/render.js';

test('parseArgs picks up flags and positional targets', () => {
  const a = parseArgs(['1', '2', '--format=json', '--refresh']);
  assert.deepEqual(a._, ['1', '2']);
  assert.equal(a.format, 'json');
  assert.equal(a.refresh, true);
  assert.equal(a.useCache, true);

  const b = parseArgs(['cf', '5009280990216192', '--download-original', '--no-cache']);
  assert.deepEqual(b._, ['cf', '5009280990216192']);
  assert.equal(b.downloadOriginal, true);
  assert.equal(b.useCache, false);

  const c = parseArgs(['1', '--download-attachments']);
  assert.equal(c.downloadAttachments, '.');
  const d = parseArgs(['1', '--download-attachments=/tmp/foo']);
  assert.equal(d.downloadAttachments, '/tmp/foo');
});

test('parseArgs rejects unknown formats', () => {
  assert.throws(() => parseArgs(['1', '--format=html']), /Unknown --format/);
});

test('findTestcaseKeyInMarkdown picks up both URL shapes', () => {
  assert.equal(
    findTestcaseKeyInMarkdown('See https://clusterfuzz.com/testcase?key=5009280990216192 for details.'),
    '5009280990216192',
  );
  assert.equal(
    findTestcaseKeyInMarkdown('Repro: https://clusterfuzz.com/download?testcase_id=4242 .'),
    '4242',
  );
  assert.equal(findTestcaseKeyInMarkdown('no links here'), null);
});

test('extractSearchHits dedupes by id, keeping first title', () => {
  const md = `
- [crash on startup](https://issuetracker.google.com/issues/123) status: New
- [crash on startup (linked)](https://issuetracker.google.com/issues/123) Status: Assigned
- [another bug](https://issuetracker.google.com/issues/456?pli=1) status: New
`;
  const hits = extractSearchHits(md);
  assert.deepEqual(hits, [
    { id: '123', title: 'crash on startup', url: 'https://issuetracker.google.com/issues/123' },
    { id: '456', title: 'another bug', url: 'https://issuetracker.google.com/issues/456' },
  ]);
});

test('sanitizeFilename strips control + path chars', () => {
  assert.equal(sanitizeFilename('foo/bar:baz<qux>.txt'), 'foo_bar_baz_qux_.txt');
  assert.equal(sanitizeFilename('  spaced out  '), 'spaced out');
  assert.equal(sanitizeFilename('a'.repeat(300)).length, 200);
});

test('sanitizeTerminalText strips ANSI + control', () => {
  const dirty = 'safe\x1b[31mred\x1b[0m\x1b]0;title\x07done\x08';
  assert.equal(sanitizeTerminalText(dirty), 'safereddone');
});

test('extractSearchRows parses the rich result table', () => {
  const md = `## Issue search results

**1 - 2** of **2**

|     |     |     | P   | TYPE | TITLE | ASSIGNEE | STATUS | 7D VIEWS | ID  | LAST MODIFIED |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|     |     |     | P1  | Vulnerability | [Stale cache hits in Maglev](https://issuetracker.google.com/issues/513350759) | verwaest@chromium.org | Assigned | 10  | [513350759](https://issuetracker.google.com/issues/513350759) | 2026-05-15 10:36 |
|     |     |     | P2  | Bug | [Some other issue](https://issuetracker.google.com/issues/999) | \\-- | New | 0   | [999](https://issuetracker.google.com/issues/999) | 2026-04-01 09:00 |
`;
  const rows = extractSearchRows(md);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '513350759');
  assert.equal(rows[0].priority, 'P1');
  assert.equal(rows[0].type, 'Vulnerability');
  assert.equal(rows[0].title, 'Stale cache hits in Maglev');
  assert.equal(rows[0].assignee, 'verwaest@chromium.org');
  assert.equal(rows[0].status, 'Assigned');
  assert.equal(rows[0].views7d, 10);
  assert.equal(rows[0].modified, '2026-05-15 10:36');
  // Second row has the escaped \-- assignee which we normalize to empty.
  assert.equal(rows[1].assignee, '');
  assert.equal(rows[1].views7d, 0);
});

test('parseSince accepts durations and ISO dates', () => {
  const now = Date.now();
  const sevenDays = parseSince('7d');
  assert.ok(sevenDays <= now && sevenDays >= now - 8 * 86400_000);
  const oneWeek = parseSince('1w');
  assert.ok(oneWeek <= now && oneWeek >= now - 8 * 86400_000);
  assert.equal(parseSince('2026-05-01'), Date.parse('2026-05-01'));
  assert.throws(() => parseSince('garbage'), /Cannot parse --since/);
});

test('sanitizeDeep recurses', () => {
  const dirty = { a: 'foo\x1b[31mbar', b: [{ c: 'baz\x07' }] };
  assert.deepEqual(sanitizeDeep(dirty), { a: 'foobar', b: [{ c: 'baz' }] });
});

test('parseArgs handles login --export and --import flags and errors', () => {
  assert.equal(parseArgs(['login', '--export']).export, '-');
  assert.equal(parseArgs(['login', '--export=corp']).export, 'corp');
  assert.equal(parseArgs(['cf', 'login', '--export=user@corp']).export, 'user@corp');
  assert.equal(parseArgs(['login', '--import']).import, '-');
  assert.equal(parseArgs(['login', '--import=/tmp/s.json']).import, '/tmp/s.json');

  assert.throws(() => parseArgs(['login', '--export=']), /Expected an SSH host/);
  assert.throws(() => parseArgs(['login', '--export=-oProxyCommand=evil']), /Invalid SSH host/);
  assert.throws(() => parseArgs(['login', '--export=bad host']), /Invalid SSH host/);
  assert.throws(() => parseArgs(['login', '--import=']), /Expected a file path/);
  assert.throws(() => parseArgs(['login', '--export=corp', '--import']), /Cannot combine/);
  assert.throws(() => parseArgs(['12345', '--export=corp']), /require login/);
  assert.throws(() => parseArgs(['login', 'corp']), /Unexpected argument to login/);
});

test('exportSessionState, importSessionState, and pushSessionOverSsh round-trip cookies', async () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'bnz-test-src-'));
  const dstDir = mkdtempSync(join(tmpdir(), 'bnz-test-dst-'));
  const fakeSsh = join(srcDir, 'fake-ssh.mjs');
  try {
    const expires = Math.floor(Date.now() / 1000) + 86400;
    await importSessionState({
      cookies: [
        {
          name: '__Secure-1PSID',
          value: 'tok_new',
          domain: '.google.com',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: '__Host-GAPS',
          value: 'gaps_val',
          domain: 'accounts.google.com',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
    }, { profileDir: srcDir });

    const exported = await exportSessionState({ profileDir: srcDir });
    assert.equal(exported.cookies.length, 2);

    // Seed dstDir with a stale cookie first to verify import replaces it cleanly.
    await importSessionState({
      cookies: [{
        name: 'STALE',
        value: 'old',
        domain: '.google.com',
        path: '/',
        expires,
        secure: true,
        sameSite: 'Lax',
      }],
    }, { profileDir: dstDir });

    // Simulate ssh piping stdin into remote importSessionState on dstDir.
    writeFileSync(fakeSsh, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { importSessionState } from ${JSON.stringify(new URL('../lib/browser.js', import.meta.url).href)};
const args = process.argv.slice(2);
if (args[0] !== '--' || args[1] !== 'corp') process.exit(2);
const raw = readFileSync(0, 'utf8');
await importSessionState(raw, { profileDir: ${JSON.stringify(dstDir)} });
`, { mode: 0o755 });

    await pushSessionOverSsh('corp', exported, { sshBin: fakeSsh });

    const imported = await exportSessionState({ profileDir: dstDir });
    assert.deepEqual(
      imported.cookies.map((c) => `${c.name}=${c.value}`).sort(),
      ['__Host-GAPS=gaps_val', '__Secure-1PSID=tok_new'],
    );
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(dstDir, { recursive: true, force: true });
  }
});
