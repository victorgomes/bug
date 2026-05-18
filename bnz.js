#!/usr/bin/env node
// bnz — fetch authenticated content from issuetracker.google.com (Buganizer)
// and clusterfuzz.com via a persistent headless Chromium session.
//
// Page content is converted to faithful markdown by walking the rendered DOM
// (light + shadow) — we don't try to interpret the SPA's component structure
// beyond what's needed to act (extracting testcase links, command-line flags,
// attachment URLs, reproducer download endpoints).

import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AuthRequiredError, openSession, loginInteractive,
} from './lib/browser.js';
import {
  extractSearchHits, extractSearchRows, fetchIssue, fetchTestcase,
  parseSince, searchIssues,
} from './lib/fetch.js';
import {
  resolveCfTarget, resolveIssueUrl,
} from './lib/url.js';
import {
  appendix, header, makeColors, sanitizeDeep, sanitizeTerminalText,
} from './lib/render.js';

const CLUSTERFUZZ_TESTCASE_RE =
  /clusterfuzz\.com\/(?:testcase\?key=|download\?testcase_id=)(\d+)/;

// ---------- arg parsing ----------

function usage() {
  console.error(`bnz — fetch Buganizer issues and ClusterFuzz testcases as markdown.

Usage:
  bnz login                              Interactive Google SSO for issuetracker (one-time).
  bnz cf login                           Interactive Google SSO for clusterfuzz (one-time).

  bnz <id|url> [<id|url>...]             Fetch one or more issues.
  bnz cf <key|url|issue-id> [...]        Fetch one or more clusterfuzz testcases.
                                         (Numeric input: 14+ digits = testcase key.)
  bnz list "<query>"                     Search issuetracker (raw Buganizer query syntax).

Flags:
  --format=markdown|json                 Output format. markdown is the default; json emits a
                                         structured object (or array, for multiple targets).
  --download-original                    cf: also fetch the original (unminimized) reproducer.
  --download-attachments[=DIR]           Download all attachment URLs found on the page(s).
                                         DIR defaults to the cwd. Filenames come from the link
                                         text where available, else the URL basename.
  --full                                 Skip the chrome filter — dump the entire page, including
                                         top bar, side nav, FABs, and interactive buttons. By
                                         default the output is the issue body only.
  --since=<dur>                          list: keep only hits modified since the duration ago.
                                         e.g. --since=7d, --since=1w, --since=2026-05-01.
  --max-pages=N                          list: cap pagination at N pages of 50 hits (default 30).
  --refresh                              Bypass the cache for this fetch (still writes back).
  --no-cache                             Disable cache reads and writes.
  --debug                                Include raw HTML in json output.
  --no-color                             Disable ANSI color (also honors NO_COLOR).
  -h, --help                             Show this help.

Cache:
  Pages are cached at ~/.config/bnz/cache/ with a 5-minute TTL.
`);
}

function parseArgs(argv) {
  const args = {
    _: [],
    format: 'markdown',
    useCache: true,
    refresh: false,
    downloadOriginal: false,
    downloadAttachments: null,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-color') args.noColor = true;
    else if (a === '--debug') args.debug = true;
    else if (a === '--full') args.full = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--no-cache') args.useCache = false;
    else if (a === '--download-original') args.downloadOriginal = true;
    else if (a === '--download-attachments') args.downloadAttachments = '.';
    else if (a.startsWith('--download-attachments=')) {
      args.downloadAttachments = a.slice('--download-attachments='.length);
    }
    else if (a.startsWith('--format=')) args.format = a.slice('--format='.length);
    else if (a.startsWith('--since=')) args.since = a.slice('--since='.length);
    else if (a.startsWith('--max-pages=')) args.maxPages = parseInt(a.slice('--max-pages='.length), 10);
    else args._.push(a);
  }
  if (!['markdown', 'json'].includes(args.format)) {
    throw new Error(`Unknown --format: ${args.format} (expected markdown or json)`);
  }
  return args;
}

// ---------- fetching ----------

function findTestcaseKeyInMarkdown(markdown) {
  const m = markdown.match(CLUSTERFUZZ_TESTCASE_RE);
  return m ? m[1] : null;
}

async function downloadAttachments(session, attachments, dir) {
  mkdirSync(dir, { recursive: true });
  const results = [];
  for (const a of attachments) {
    const r = await session.downloadBytes(a.url);
    if (!r.ok) { results.push({ ...a, ok: false, error: r }); continue; }
    const name = sanitizeFilename(a.name) || basename(new URL(a.url).pathname) || 'attachment';
    const path = join(dir, name);
    writeFileSync(path, r.body);
    results.push({ ...a, ok: true, path, bytes: r.body.length });
  }
  return results;
}

function sanitizeFilename(s) {
  return String(s)
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ---------- rendering ----------

// Extract Status/Type/Priority/Severity from the compacted sidebar so we can
// surface them in the synthesized header. Buganizer doesn't render a chip for
// "New" status, so the status would otherwise only appear at the bottom.
function summaryFromMarkdown(markdown) {
  const get = (label) => {
    const m = markdown.match(new RegExp('^- \\*\\*' + label + '\\*\\*:\\s*(.+)$', 'm'));
    return m ? m[1].trim() : null;
  };
  return {
    status: get('Status'),
    type: get('Type'),
    priority: get('Priority'),
    severity: get('Severity'),
  };
}

function renderIssueMarkdown(issue, args, colorEnabled) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(issue);
  const out = [];
  out.push(header(c, `Issue ${data.id}`, data.finalUrl || data.url));
  const s = summaryFromMarkdown(data.markdown);
  const summary = [
    s.status && `${c.bold('Status')}: ${
      /Fixed|Verified/i.test(s.status) ? c.green(s.status) :
      /Assigned|New/i.test(s.status) ? c.yellow(s.status) : c.gray(s.status)}`,
    s.type && `${c.bold('Type')}: ${s.type}`,
    s.priority && `${c.bold('Priority')}: ${
      /^P[01]$/.test(s.priority) ? c.red(s.priority) :
      /^P2$/.test(s.priority) ? c.yellow(s.priority) : c.green(s.priority)}`,
    s.severity && `${c.bold('Severity')}: ${
      /^S[01]$/.test(s.severity) ? c.red(s.severity) :
      /^S2$/.test(s.severity) ? c.yellow(s.severity) : c.green(s.severity)}`,
  ].filter(Boolean).join('  ·  ');
  if (summary) { out.push(summary); out.push(''); }
  out.push(data.markdown.trim());

  const apx = [];
  if (data.attachments?.length) {
    apx.push(['Attachments', data.attachments.map(
      (a) => `- [${a.name}](${a.url})`,
    )]);
  }
  if (data.downloadedAttachments?.length) {
    apx.push(['Downloaded attachments', data.downloadedAttachments.map((a) =>
      a.ok ? `- ${c.green('ok')} ${a.path} (${a.bytes} bytes)`
           : `- ${c.red('fail')} ${a.name} ${JSON.stringify(a.error)}`,
    )]);
  }
  out.push(appendix(c, apx));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderTestcaseMarkdown(tc, args, colorEnabled) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(tc);
  const out = [];
  out.push(header(c, `ClusterFuzz testcase ${data.key}`, data.pageUrl));
  if (data.markdown) out.push(data.markdown.trim());

  const apx = [];
  if (data.reproducer?.ok) {
    apx.push(['Reproducer (minimized)', [
      '```javascript',
      data.reproducer.body.trimEnd(),
      '```',
    ]]);
  } else if (data.reproducer) {
    apx.push(['Reproducer (minimized) download failed', [
      '```',
      JSON.stringify(data.reproducer, null, 2),
      '```',
    ]]);
  }
  if (data.reproducerOriginal?.ok) {
    apx.push(['Reproducer (original, unminimized)', [
      '```javascript',
      data.reproducerOriginal.body.trimEnd(),
      '```',
    ]]);
  } else if (data.reproducerOriginal) {
    apx.push(['Reproducer (original) download failed', [
      '```',
      JSON.stringify(data.reproducerOriginal, null, 2),
      '```',
    ]]);
  }
  if (data.attachments?.length) {
    apx.push(['Attachments', data.attachments.map(
      (a) => `- [${a.name}](${a.url})`,
    )]);
  }
  out.push(appendix(c, apx));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderListMarkdown(search, args, colorEnabled) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(search);
  const out = [];
  out.push(header(c, `Search: ${data.query}`, data.searchUrl));
  if (!data.hits.length) {
    out.push(c.dim('(no results)'));
    if (data.since && data.filteredOut) {
      out.push(c.dim(`(${data.filteredOut} hits were filtered out by --since=${data.since})`));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  const summaryBits = [`${data.hits.length} result(s)`];
  if (data.pagesFetched > 1) summaryBits.push(`${data.pagesFetched} pages`);
  if (data.since) summaryBits.push(`since ${data.since}, ${data.filteredOut} filtered out`);
  out.push(summaryBits.join('  ·  '));
  out.push('');

  // Detect whether we have the rich-row shape (anything beyond id/title/url).
  const rich = data.hits.some((h) => h.priority || h.status || h.modified);
  if (rich) {
    out.push('| Pri | Type | Status | Title | Assignee | Modified |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const h of data.hits) {
      const cells = [
        h.priority || '',
        h.type || '',
        h.status || '',
        `[${h.title}](${h.url})`,
        h.assignee || '',
        h.modified || '',
      ].map((s) => String(s).replace(/\|/g, '\\|'));
      out.push(`| ${cells.join(' | ')} |`);
    }
  } else {
    for (const h of data.hits) {
      out.push(`- [${h.id}](${h.url}) - ${h.title}`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const MARKDOWN_SEPARATOR = '\n\n---\n\n';

// ---------- commands ----------

async function issuesCmd(session, inputs, args, colorEnabled) {
  const targets = inputs.map(resolveIssueUrl);
  const results = [];
  for (const url of targets) {
    const issue = await fetchIssue(session, url, args);
    issue.id = url.match(/(\d+)/)[1];
    if (args.downloadAttachments && issue.attachments?.length) {
      issue.downloadedAttachments = await downloadAttachments(
        session, issue.attachments, args.downloadAttachments,
      );
    }
    if (args.debug) issue.rawHtml = await session.rawHtml(url);
    results.push(issue);
  }
  emit(results, args, colorEnabled, (r) => renderIssueMarkdown(r, args, colorEnabled));
}

async function cfCmd(session, inputs, args, colorEnabled) {
  if (inputs.length === 0) { usage(); process.exit(1); }
  const keys = [];
  for (const input of inputs) {
    const target = resolveCfTarget(input);
    if (target.kind === 'testcase') {
      keys.push(target.key);
      continue;
    }
    const issueUrl = resolveIssueUrl(target.issue);
    console.error(`resolving testcase via ${issueUrl} ...`);
    const issue = await fetchIssue(session, issueUrl, args);
    const key = findTestcaseKeyInMarkdown(issue.markdown);
    if (!key) {
      throw new Error(`No clusterfuzz testcase link found in issue ${target.issue}.`);
    }
    console.error(`  -> testcase ${key}`);
    keys.push(key);
  }
  const results = [];
  for (const key of keys) {
    const tc = await fetchTestcase(session, key, args);
    if (args.downloadAttachments && tc.attachments?.length) {
      tc.downloadedAttachments = await downloadAttachments(
        session, tc.attachments, args.downloadAttachments,
      );
    }
    if (args.debug) tc.rawHtml = await session.rawHtml(tc.pageUrl);
    results.push(tc);
  }
  emit(results, args, colorEnabled, (r) => renderTestcaseMarkdown(r, args, colorEnabled));
}

async function listCmd(session, inputs, args, colorEnabled) {
  if (inputs.length === 0) {
    throw new Error('list requires a query, e.g. `bug list "reporter:me status:open"`');
  }
  const result = await searchIssues(session, inputs.join(' '), args);
  if (args.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderListMarkdown(result, args, colorEnabled));
}

function emit(results, args, colorEnabled, mdFn) {
  if (args.format === 'json') {
    const payload = results.length === 1 ? results[0] : results;
    console.log(JSON.stringify(sanitizeDeep(payload), null, 2));
    return;
  }
  console.log(results.map(mdFn).join(MARKDOWN_SEPARATOR));
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const colorEnabled =
    !args.noColor && !process.env.NO_COLOR && process.stdout.isTTY;
  const cmd = args._[0];

  if (cmd === 'login') {
    await loginInteractive('https://issuetracker.google.com/');
    return;
  }
  if (cmd === 'cf' && args._[1] === 'login') {
    await loginInteractive('https://clusterfuzz.com/');
    return;
  }

  const session = await openSession();
  try {
    if (cmd === 'cf') {
      await cfCmd(session, args._.slice(1), args, colorEnabled);
    } else if (cmd === 'list') {
      await listCmd(session, args._.slice(1), args, colorEnabled);
    } else {
      await issuesCmd(session, args._, args, colorEnabled);
    }
  } finally {
    await session.close();
  }
}

export {
  CLUSTERFUZZ_TESTCASE_RE,
  extractSearchHits,
  extractSearchRows,
  findTestcaseKeyInMarkdown,
  parseArgs,
  parseSince,
  renderIssueMarkdown,
  renderListMarkdown,
  renderTestcaseMarkdown,
  sanitizeFilename,
};

function isMainModule() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch((err) => {
    if (err instanceof AuthRequiredError) {
      console.error(sanitizeTerminalText(err.message));
    } else {
      console.error(sanitizeTerminalText(err.message || err));
    }
    process.exit(1);
  });
}
