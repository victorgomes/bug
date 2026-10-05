import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { fetchIssue, fetchTestcaseDownloadUrls } from './fetch.js';
import { resolveCfTarget, resolveIssueUrl, testcaseDownloadUrl } from './url.js';

export const CLUSTERFUZZ_TESTCASE_RE =
  /https:\/\/clusterfuzz\.com\/(?:testcase-detail\/|testcase\?key=|download(?:\/[^\s?)]+)?\?testcase_id=)(\d+)/g;

export function findTestcaseKeysInMarkdown(markdown) {
  return [...new Set([...markdown.matchAll(CLUSTERFUZZ_TESTCASE_RE)].map((m) => m[1]))];
}

export function parseTargetList(text) {
  return text.split(/[\s,]+/).filter(Boolean);
}

export function readCfInputs(inputs, args, {
  read = readFileSync, stdinIsTTY = process.stdin.isTTY,
} = {}) {
  const positional = inputs.flatMap(parseTargetList);
  const fromFile = args.idsFile
    ? parseTargetList(read(args.idsFile === '-' ? 0 : args.idsFile, 'utf8')) : [];
  const needsStdin = positional.includes('-') ||
    (!positional.length && !args.idsFile && !stdinIsTTY);
  const fromStdin = needsStdin && args.idsFile !== '-'
    ? parseTargetList(read(0, 'utf8')) : [];
  return [...positional.filter((input) => input !== '-'), ...fromFile, ...fromStdin];
}

function downloadFilename(disposition, key, variant) {
  const match = disposition?.match(/filename="([^"]+)"|filename=([^;\s]+)/i);
  const name = match?.[1] || match?.[2];
  if (name && name === basename(name) && name !== '.' && name !== '..' &&
      !/[\x00-\x1f\\]/.test(name)) return name;
  return `clusterfuzz-testcase-${variant}-${key}`;
}

export async function downloadTestcases(session, inputs, args) {
  mkdirSync(args.download, { recursive: true });
  const targets = new Map();
  const errors = [];
  const issues = new Map();
  for (const input of new Set(inputs)) {
    try {
      const target = resolveCfTarget(input);
      let keys;
      if (target.kind === 'testcase') {
        keys = [target.key];
      } else {
        const url = resolveIssueUrl(target.issue);
        if (!issues.has(url)) {
          issues.set(url, fetchIssue(session, url, args).then((issue) => {
            if (issue.markdown.includes('Access is denied to this issue')) {
              throw new Error(`Access denied to ${url}. Run bnz login and retry with --refresh.`);
            }
            return findTestcaseKeysInMarkdown(issue.markdown);
          }));
        }
        keys = await issues.get(url);
        if (!keys.length) throw new Error('No ClusterFuzz testcase link found.');
      }
      for (const key of keys) {
        if (!targets.has(key)) targets.set(key, []);
        targets.get(key).push(input);
      }
    } catch (err) {
      errors.push({ ok: false, input, error: String(err.message || err) });
    }
  }

  const variants = args.variant === 'both' ? ['minimized', 'original'] : [args.variant];
  const tasks = [];
  for (const [key, sources] of targets) {
    let urls = { minimized: testcaseDownloadUrl(key) };
    let metadataError;
    if (variants.includes('original')) {
      try {
        urls = { ...urls, ...await fetchTestcaseDownloadUrls(session, key, args) };
      } catch (err) {
        metadataError = String(err.message || err);
      }
    }
    for (const variant of variants) {
      tasks.push({ key, inputs: sources, variant, url: urls[variant],
        error: variant === 'original' ? metadataError : undefined });
    }
  }

  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(args.jobs, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      try {
        if (task.error) throw new Error(task.error);
        if (!task.url) throw new Error(`${task.variant} testcase is unavailable.`);
        const r = await session.downloadBytes(task.url);
        if (!r.ok) throw new Error(r.error || `HTTP ${r.status}`);
        if (/text\/html/i.test(r.contentType) && !r.contentDisposition) {
          throw new Error('Received an HTML page instead of a testcase; check ClusterFuzz login.');
        }
        const dir = join(args.download, task.key, task.variant);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, downloadFilename(r.contentDisposition, task.key, task.variant));
        writeFileSync(path, r.body, { flag: 'wx' });
        results[index] = { ...task, ok: true, path, bytes: r.body.length };
      } catch (err) {
        results[index] = { ...task, ok: false, error: String(err.message || err) };
      }
    }
  }));
  return [...errors, ...results];
}
