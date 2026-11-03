import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractSearchHits, extractSearchRows, findTestcaseKeyInMarkdown,
  parseArgs, parseSince, renderListMarkdown, sanitizeFilename,
} from '../bnz.js';
import {
  AuthRequiredError, PROFILE_DIR, clearAuthInvalid, exportSessionState,
  importSessionState, isAnonymousBuganizerSession, markAuthInvalid,
  pushSessionOverSsh, readAuthInvalid,
} from '../lib/browser.js';
import {
  DEFAULT_LIST_QUERY, computeIssueSlo, parseIssueSearchPayload, sortHitsBySlo,
} from '../lib/fetch.js';
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
  assert.equal(parseArgs(['login', '--with-cf']).withCf, true);
  assert.equal(parseArgs(['login', '--with-cf', '--export=corp']).withCf, true);
  assert.equal(parseArgs(['cf', 'login', '--export=user@corp']).export, 'user@corp');
  assert.equal(parseArgs(['login', '--import']).import, '-');
  assert.equal(parseArgs(['login', '--import=/tmp/s.json']).import, '/tmp/s.json');

  assert.throws(() => parseArgs(['login', '--export=']), /Expected an SSH host/);
  assert.throws(() => parseArgs(['login', '--export=-oProxyCommand=evil']), /Invalid SSH host/);
  assert.throws(() => parseArgs(['login', '--export=bad host']), /Invalid SSH host/);
  assert.throws(() => parseArgs(['login', '--import=']), /Expected a file path/);
  assert.throws(() => parseArgs(['login', '--export=corp', '--import']), /Cannot combine/);
  assert.throws(() => parseArgs(['login', '--with-cf', '--import']), /Cannot combine --with-cf and --import/);
  assert.throws(() => parseArgs(['cf', 'login', '--with-cf']), /--with-cf requires `bnz login`/);
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

test('extractSearchRows handles issuetracker tables without 7D VIEWS column', () => {
  const md = `## Issue search results

**1 - 2** of **2**

|     |     |     | P   | TYPE | TITLE | ASSIGNEE | STATUS | ID  | LAST MODIFIED |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|     |     |     | P1  | Vulnerability | [\\[Merge M158\\] CHECK: a \\| b](https://issuetracker.google.com/issues/579236510) | victorgomes@chromium.org | Assigned | [579236510](https://issuetracker.google.com/issues/579236510) | Oct 29, 2026 03:19PM |
|     |     |     | P2  | Bug | [Some bug](https://issuetracker.google.com/issues/100) | -- | In Progress | [100](https://issuetracker.google.com/issues/100) | Oct 01, 2026 09:00AM |
`;
  const rows = extractSearchRows(md);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '579236510');
  assert.equal(rows[0].priority, 'P1');
  assert.equal(rows[0].type, 'Vulnerability');
  assert.equal(rows[0].title, '[Merge M158] CHECK: a | b');
  assert.equal(rows[0].status, 'Assigned');
  assert.equal(rows[0].views7d, 0);
  assert.equal(rows[1].assignee, '');
  assert.equal(rows[1].status, 'In Progress');
});

test('parseArgs accepts list --slo and rejects --slo on non-list commands', () => {
  assert.equal(DEFAULT_LIST_QUERY, 'assignee:me status:open');
  const a = parseArgs(['list', '--slo']);
  assert.deepEqual(a._, ['list']);
  assert.equal(a.slo, true);
  assert.throws(() => parseArgs(['12345', '--slo']), /--slo requires list/);
});

test('parseIssueSearchPayload, computeIssueSlo, and renderListMarkdown (--slo) group and sort by SLO', () => {
  const nowMs = Date.parse('2026-10-30T12:00:00Z');
  const day = 86_400;
  const nowSec = Math.floor(nowMs / 1000);
  const rawPayload = `)]}'\n` + JSON.stringify([[
    'b.IssueSearchResponse', null, null, null, null, null,
    [[
      [null, 10, [1, 1, 2, 2, 3, 'PostMortem for 999 - deopt bug', null, ['me@chromium.org'], null, null, null, null, null, null, []], null, [nowSec - 72 * day, 0], [nowSec - 56 * day, 0], null, null, [], null, null, null, null, null, []],
      [null, 20, [1, 6, 2, 2, 2, '[Merge M158] WriteBarrier', null, ['me@chromium.org'], null, null, null, null, null, null, [[1223087, null, null, null, null, null, null, null, null, 'Pending']]], null, [nowSec - 1 * day, 0], [nowSec - 1 * day, 0], null, null, [], null, null, null, null, null, [[1223087, 1, 1, null, 'Merge']]],
      [null, 30, [1, 6, 2, 2, 3, 'S2 vulnerability in Maglev', null, ['me@chromium.org'], null, null, null, null, null, null, []], null, [nowSec - 8 * day, 0], [nowSec, 0], null, null, [], null, null, null, null, null, []],
      [null, 40, [1, 1, 2, 3, 3, 'Normal P2 cleanup bug', null, ['me@chromium.org'], null, null, null, null, null, null, []], null, [nowSec - 10 * day, 0], [nowSec - 5 * day, 0], null, null, [], null, null, null, null, null, []],
    ]],
  ]]);

  const parsed = parseIssueSearchPayload(rawPayload);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[1].customFields.Merge, 'Pending');
  assert.equal(parsed[2].severity, 'S2');

  const sorted = sortHitsBySlo(parsed, nowMs);
  assert.deepEqual(sorted.map((h) => h.id), ['10', '20', '30', '40']);
  assert.equal(sorted[0].slo.bucket, 'overdue');
  assert.equal(sorted[0].slo.rule, 'PostMortem (4w)');
  assert.equal(sorted[1].slo.bucket, 'due_soon');
  assert.equal(sorted[1].slo.rule, 'Sec Merge (5d)');
  assert.equal(sorted[2].slo.bucket, 'in_slo');
  assert.equal(sorted[2].slo.rule, 'Vuln S2 (12w)');
  assert.equal(sorted[3].slo.bucket, 'none');

  const md = renderListMarkdown(
    { query: DEFAULT_LIST_QUERY, searchUrl: 'https://issuetracker.google.com/issues', hits: sorted, slo: true },
    { slo: true },
    false,
  );
  assert.match(md, /# Search \(by SLO\): assignee:me status:open/);
  assert.match(md, /1 out of SLO/);
  assert.match(md, /1 due <=7d/);
  assert.match(md, /1 in SLO/);
  assert.match(md, /1 out of scope/);
  assert.match(md, /## Out of SLO \(1\)/);
  assert.match(md, /## Due Within 7 Days \(1\)/);
  assert.match(md, /## In SLO \(1\)/);
  assert.match(md, /## Out of SLO Scope \(1\)/);
  assert.match(md, /\[10\]\(https:\/\/issues\.chromium\.org\/u\/1\/issues\/10\)/);
  assert.match(md, /\[40\]\(https:\/\/issues\.chromium\.org\/u\/1\/issues\/40\)/);
  assert.match(md, /https:\/\/issues\.chromium\.org\/u\/1\/issues\?q=assignee%3Ame%20status%3Aopen/);
});

test('isAnonymousBuganizerSession detects signed-out or expired Buganizer sessions', () => {
  // Anonymous / expired SSO payload from issuetracker.google.com
  const anonSession = [
    { toJSON: () => [null, null, '', true, 'ANONYMOUS'] },
    null,
    '',
  ];
  assert.equal(isAnonymousBuganizerSession(anonSession), true);

  // Missing XSRF token
  assert.equal(isAnonymousBuganizerSession([['victorgomes@chromium.org'], null, '']), true);

  // Authenticated session
  const authSession = [
    { toJSON: () => ['victorgomes@chromium.org', null, 'Victor Gomes', false] },
    null,
    'xsrf_tok_123',
  ];
  assert.equal(isAnonymousBuganizerSession(authSession), false);

  // Non-Buganizer page without buganizerSessionJspb
  assert.equal(isAnonymousBuganizerSession(undefined), false);

  const err = new AuthRequiredError(
    'https://issuetracker.google.com/issues?q=assignee%3Ame%20status%3Aopen',
    'anonymous Buganizer session / expired SSO',
  );
  assert.match(err.message, /anonymous Buganizer session \/ expired SSO/);
  assert.match(err.message, /Run `bnz login`/);
});

test('importSessionState preserves unrelated service cookies and clears auth-invalid markers', async () => {
  const dstDir = mkdtempSync(join(tmpdir(), 'bnz-test-scoped-'));
  const markerPath = join(dstDir, 'auth-invalid.json');
  try {
    const expires = Math.floor(Date.now() / 1000) + 86400;
    markAuthInvalid('bugs', { url: 'https://issuetracker.google.com/', reason: 'expired', markerPath });
    markAuthInvalid('cf', { url: 'https://clusterfuzz.com/', reason: 'expired', markerPath });
    assert.deepEqual(Object.keys(readAuthInvalid(markerPath)).sort(), ['bugs', 'cf']);

    // 1. Import ClusterFuzz cookie -> clears only 'cf' marker.
    await importSessionState({
      cookies: [{
        name: 'session',
        value: 'cf_sess_1',
        domain: 'clusterfuzz.com',
        path: '/',
        expires,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }],
    }, { profileDir: dstDir, authMarkerPath: markerPath });

    assert.deepEqual(Object.keys(readAuthInvalid(markerPath)), ['bugs']);

    // 2. Import Buganizer/Google cookies -> preserves ClusterFuzz cookie & clears 'bugs' marker.
    await importSessionState({
      cookies: [
        {
          name: '__Secure-1PSID',
          value: 'google_sid_1',
          domain: '.google.com',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'OSID',
          value: 'bugs_osid_1',
          domain: 'issuetracker.google.com',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
    }, { profileDir: dstDir, authMarkerPath: markerPath });

    assert.deepEqual(readAuthInvalid(markerPath), {});
    const afterBoth = await exportSessionState({ profileDir: dstDir });
    assert.deepEqual(
      afterBoth.cookies.map((c) => `${c.name}=${c.value}`).sort(),
      ['OSID=bugs_osid_1', '__Secure-1PSID=google_sid_1', 'session=cf_sess_1'],
    );

    // 3. Re-importing updated ClusterFuzz cookie preserves Buganizer/Google cookies.
    await importSessionState({
      cookies: [{
        name: 'session',
        value: 'cf_sess_2',
        domain: 'clusterfuzz.com',
        path: '/',
        expires,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }],
    }, { profileDir: dstDir, authMarkerPath: markerPath });

    const afterCfRefresh = await exportSessionState({ profileDir: dstDir });
    assert.deepEqual(
      afterCfRefresh.cookies.map((c) => `${c.name}=${c.value}`).sort(),
      ['OSID=bugs_osid_1', '__Secure-1PSID=google_sid_1', 'session=cf_sess_2'],
    );

    clearAuthInvalid(['bugs', 'cf'], { markerPath });
  } finally {
    rmSync(dstDir, { recursive: true, force: true });
  }
});

test('exportSessionState without profileDir uses an ephemeral isolated profile', async () => {
  let seenProfileDir = null;
  const expires = Math.floor(Date.now() / 1000) + 86400;
  // Pass a local data/about URL is not supported by verifyUrls, so test cf-only
  // filtering on an explicit temp dir AND verify ephemeral dir isolation when
  // loginFn cancels before SSO completes.
  await assert.rejects(
    exportSessionState({
      startUrls: ['https://issuetracker.google.com/'],
      loginFn: async (_urls, { profileDir }) => {
        seenProfileDir = profileDir;
      },
    }),
    /Browser closed before Google SSO completed/,
  );
  assert.ok(seenProfileDir, 'expected loginFn to be called with an ephemeral profileDir');
  assert.notEqual(seenProfileDir, PROFILE_DIR);
});
