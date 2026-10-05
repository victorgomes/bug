import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { parseArgs } from '../bnz.js';
import { downloadTestcases, findTestcaseKeysInMarkdown, parseTargetList, readCfInputs } from '../lib/cf-download.js';
import { fetchTestcase } from '../lib/fetch.js';
import { CACHE_DIR, cacheKey } from '../lib/cache.js';
import { testcasePageUrl } from '../lib/url.js';

function downloadArgs(t, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), 'bnz-cf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return parseArgs(['cf', `--download=${dir}`, '--no-cache', ...flags]);
}

test('download arguments and target lists', () => {
  const a = parseArgs(['cf', '--download', '--download-original', '--ids-file=-', '--jobs=2']);
  assert.equal(a.download, '.');
  assert.equal(a.variant, 'both');
  assert.equal(a.idsFile, '-');
  assert.equal(a.jobs, 2);
  assert.equal(parseArgs(['cf', '--download', '--variant=original']).variant, 'original');
  for (const value of ['0', '-1', '1.5', 'NaN', '17']) {
    assert.throws(() => parseArgs(['cf', `--jobs=${value}`]), /--jobs/);
  }
  assert.throws(() => parseArgs(['cf', '--variant=bad']), /--variant/);
  assert.throws(() => parseArgs(['cf', '--download=']), /nonempty/);
  assert.throws(() => parseArgs(['123', '--download']), /require cf/);
  assert.deepEqual(parseTargetList('123, b/456\nhttps://crbug.com/789\t123\n'),
    ['123', 'b/456', 'https://crbug.com/789', '123']);
});

test('extracts all testcase links, deduplicating URL variants', () => {
  assert.deepEqual(findTestcaseKeysInMarkdown(`
https://clusterfuzz.com/testcase-detail/6005188368302080
https://clusterfuzz.com/testcase?key=6005188368302080
https://clusterfuzz.com/download/blob?testcase_id=5009280990216192
https://clusterfuzz.com.evil.test/testcase?key=123
`), ['6005188368302080', '5009280990216192']);
});

test('batch resolves each issue once, downloads all unique keys, and preserves binary bytes', async (t) => {
  const args = downloadArgs(t, ['--jobs=2']);
  const dumped = [];
  const downloads = [];
  let active = 0;
  let peak = 0;
  const body = Buffer.from([0, 255, 27, 128]);
  const session = {
    async dump(url) {
      dumped.push(url);
      return { markdown: 'https://clusterfuzz.com/testcase-detail/6005188368302080\n' +
        'https://clusterfuzz.com/testcase?key=5009280990216192\n' +
        'https://clusterfuzz.com/testcase-detail/5009280990216193' };
    },
    async downloadBytes(url) {
      downloads.push(url);
      peak = Math.max(peak, ++active);
      await setImmediate();
      active--;
      return { ok: true, body, contentType: 'application/octet-stream' };
    },
  };
  const results = await downloadTestcases(session,
    ['123', 'b/123', '6005188368302080', '123'], args);
  assert.equal(dumped.length, 1);
  assert.equal(downloads.length, 3);
  assert.equal(peak, 2);
  assert.equal(results.length, 3);
  assert.deepEqual(results[0].inputs, ['123', 'b/123', '6005188368302080']);
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.deepEqual(readFileSync(r.path), body);
  }
});

test('minimized download skips metadata; original uses the actual blob URL', async (t) => {
  const args = downloadArgs(t, ['--variant=both']);
  const urls = [];
  const session = {
    async testcaseDownloads(url) {
      assert.equal(url, 'https://clusterfuzz.com/testcase-detail/6005188368302080');
      return { minimized: 'small', original: 'large/blob' };
    },
    async downloadBytes(url) {
      urls.push(url);
      return { ok: true, body: Buffer.from(url) };
    },
  };
  const results = await downloadTestcases(session, ['6005188368302080'], args);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(urls, [
    'https://clusterfuzz.com/download/small?testcase_id=6005188368302080',
    'https://clusterfuzz.com/download/large%2Fblob?testcase_id=6005188368302080',
  ]);
  const minimizedArgs = downloadArgs(t);
  session.testcaseDownloads = () => { throw new Error('Must not load testcase page'); };
  const minimized = await downloadTestcases(session, ['6005188368302080'], minimizedArgs);
  assert.equal(minimized[0].ok, true);
});

test('batch continues after failures, rejects login HTML and refuses overwrites', async (t) => {
  const args = downloadArgs(t);
  const body = Buffer.from('fixture');
  const session = {
    async dump() { return { markdown: 'no testcase' }; },
    async downloadBytes(url) {
      if (url.includes('5009280990216192')) return { ok: false, status: 403 };
      if (url.includes('5009280990216193')) {
        return { ok: true, body: Buffer.from('<html>login</html>'), contentType: 'text/html' };
      }
      return { ok: true, body, contentDisposition: 'attachment; filename="../../bad.js"' };
    },
  };
  const results = await downloadTestcases(session,
    ['bad', '123', '5009280990216192', '5009280990216193', '6005188368302080'], args);
  assert.deepEqual(results.map((r) => r.ok), [false, false, false, false, true]);
  assert.match(results[2].error, /403/);
  assert.match(results[3].error, /HTML/);
  assert.ok(results[4].path.startsWith(args.download + '/'));
  const again = await downloadTestcases(session, ['6005188368302080'], args);
  assert.equal(again[0].ok, false);
  assert.match(again[0].error, /EEXIST/);
  assert.deepEqual(readFileSync(results[4].path), body);
});

test('missing original is reported while minimized still downloads', async (t) => {
  const args = downloadArgs(t, ['--variant=both']);
  const results = await downloadTestcases({
    async testcaseDownloads() { return { minimized: 'small', original: 'NA' }; },
    async downloadBytes() { return { ok: true, body: Buffer.from('fixture') }; },
  }, ['6005188368302080'], args);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /unavailable/);
});

test('inaccessible issues report the login problem', async (t) => {
  let calls = 0;
  const results = await downloadTestcases({
    async dump() {
      calls++;
      return { markdown: '### Access is denied to this issue' };
    },
  }, ['123', 'b/123'], downloadArgs(t));
  assert.equal(calls, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /Access denied.*bnz login.*--refresh/);
});

test('preserves server filenames and extensions', async (t) => {
  const args = downloadArgs(t);
  const results = await downloadTestcases({
    async downloadBytes() {
      return { ok: true, body: Buffer.from('fixture'),
        contentDisposition: 'attachment; filename=sample.js' };
    },
  }, ['6005188368302080'], args);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].path, join(args.download, '6005188368302080', 'minimized', 'sample.js'));
});

const BUG_IDS = ['569549307', '569314507', '569018757', '568915773', '569089596'];

test('accepts comma-separated positional IDs and automatic here-string stdin', () => {
  const text = BUG_IDS.join(', ');
  const noRead = { read() { throw new Error('Unexpected stdin read'); }, stdinIsTTY: false };
  assert.deepEqual(readCfInputs([text], {}, noRead), BUG_IDS);
  assert.deepEqual(readCfInputs(text.split(' '), {}, noRead), BUG_IDS);
  let reads = 0;
  const stdin = { stdinIsTTY: false, read(fd, encoding) {
    assert.equal(fd, 0);
    assert.equal(encoding, 'utf8');
    reads++;
    return text + '\n';
  } };
  assert.deepEqual(readCfInputs([], {}, stdin), BUG_IDS);
  assert.deepEqual(readCfInputs(['-'], { idsFile: '-' }, stdin), BUG_IDS);
  assert.equal(reads, 2);
  assert.deepEqual(readCfInputs([], {}, { ...noRead, stdinIsTTY: true }), []);
});

test('resolves the supplied bug ID list and organizes downloads by CF key and variant', async (t) => {
  const args = downloadArgs(t, ['--variant=both']);
  const fetched = [];
  const keys = BUG_IDS.map((_, i) => String(6005188368302080n + BigInt(i)));
  const results = await downloadTestcases({
    async dump(url) {
      const id = url.split('/').at(-1);
      fetched.push(id);
      return { markdown: `https://clusterfuzz.com/testcase-detail/${keys[BUG_IDS.indexOf(id)]}` };
    },
    async testcaseDownloads() { return { minimized: 'small', original: 'large' }; },
    async downloadBytes() {
      return { ok: true, body: Buffer.from('fixture'), contentDisposition: 'attachment; filename=test.js' };
    },
  }, readCfInputs([BUG_IDS.join(', ')], args), args);
  assert.deepEqual(fetched, BUG_IDS);
  assert.equal(results.length, 10);
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.equal(r.path, join(args.download, r.key, r.variant, 'test.js'));
    assert.deepEqual(r.inputs, [BUG_IDS[keys.indexOf(r.key)]]);
    assert.equal(readFileSync(r.path, 'utf8'), 'fixture');
  }
});

test('requesting original after a cached minimized page fetches the original blob', async (t) => {
  const key = String(Date.now()) + '1234';
  const pageUrl = testcasePageUrl(key);
  t.after(() => {
    for (const url of [pageUrl, pageUrl + '#original', pageUrl + '#downloads']) {
      rmSync(join(CACHE_DIR, cacheKey(url) + '.json'), { force: true });
    }
  });
  const downloads = [];
  const session = {
    async dump() { return { markdown: 'fixture' }; },
    async testcaseDownloads() { return { minimized: 'small', original: 'large' }; },
    async downloadText(url) { downloads.push(url); return { ok: true, body: 'fixture' }; },
  };
  await fetchTestcase(session, key, { useCache: true });
  const tc = await fetchTestcase(session, key, { useCache: true, downloadOriginal: true });
  assert.equal(tc.reproducerOriginal.ok, true);
  assert.equal(tc.reproducerOriginal.url, `https://clusterfuzz.com/download/large?testcase_id=${key}`);
  assert.ok(downloads.includes(tc.reproducerOriginal.url));
});
