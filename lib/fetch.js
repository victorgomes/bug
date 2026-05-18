// Cache-wrapped fetch primitives for Buganizer issues, ClusterFuzz testcases,
// and Buganizer search pages. Pure data — no console output, no rendering.

import { DEFAULT_TTL_MS, readCache, writeCache } from './cache.js';
import {
  ATTACHMENT_URL_RE, canonicalIssueUrl, searchUrl,
  testcaseDownloadUrl, testcasePageUrl,
} from './url.js';

// Focused-mode extraction options. Default behavior strips page chrome and
// interactive controls so the markdown is mostly Description + comments. Pass
// args.full to keep everything.
const ISSUE_FOCUSED = {
  rootSelector: 'issue-details-wrapper, main, [role="main"], body',
  settleSelector: 'onedev-edit-field, edit-issue-metadata',
  dropTags: [
    // Page chrome (outside issue-details-wrapper, but defensive). Note:
    // b-resizable-sidebar is also used as the issue-metadata sidebar wrapper,
    // and <button> wraps the user-picker chips in the sidebar — so don't
    // blanket-drop either; rely on Turndown rules to drop action buttons.
    'b-app-top-bar', 'b-app-logo', 'b-app-search-box', 'b-app-actions',
    'b-app-settings-menu', 'b-top-bar-outlet',
    'b-footer', 'b-sso-expired-callout-outlet', 'b-terms-of-service',
    'bug-screensaver-manager', 'theme-change-btn', 'app-logo',
    // Inside the issue body: interactive UI / overlays / empty placeholders.
    'b-tracker-banner', 'b-comment-box', 'b-post-comment',
    'b-event-stream-header', 'b-pagination-one-issue', 'b-fab-segmented',
    'llm-chat-open-button', 'b-attachment-uploader', 'b-notification-menu',
    'b-create-issue-button', 'b-async-data-placeholder',
    'b-attachment-selector',
    // Per-comment field-change rendering: redundant with the sidebar, and on
    // the bug-filing comment it dumps every field that was set at creation.
    // Real user comment bodies live in <b-formatted-comment-presenter>, not
    // here.
    'b-issue-event-details',
    // Issue-header noise that duplicates information already in our
    // synthesized header / sidebar: a "Copy issue number" widget that
    // renders the bare ID, and a visibility chip with no real text content.
    'b-issue-id-picker', 'issue-chip-indicators', 'b-access-limits-chip',
  ],
};

const CF_FOCUSED = {
  // CF chrome we don't want: top nav, footer. Keep most of the page since the
  // testcase metadata is what we're after.
  dropTags: ['button', 'paper-icon-button'],
};

const SEARCH_FOCUSED = {
  // Search results need the link list, not the chrome.
  dropTags: ['button', 'b-app-top-bar', 'b-resizable-sidebar', 'b-footer'],
};

export async function withCache(url, args, fn) {
  if (!args.useCache) return fn();
  if (!args.refresh) {
    const cached = readCache(url, { ttlMs: DEFAULT_TTL_MS });
    if (cached) return cached;
  }
  const value = await fn();
  writeCache(url, value);
  return value;
}

export async function fetchIssue(session, issueUrl, args) {
  const cacheUrl = args.full ? issueUrl + '#full' : issueUrl;
  return withCache(cacheUrl, args, async () => {
    const dumpOpts = { attachmentRe: ATTACHMENT_URL_RE };
    if (!args.full) Object.assign(dumpOpts, ISSUE_FOCUSED);
    return session.dump(issueUrl, dumpOpts);
  });
}

export async function fetchTestcase(session, key, args) {
  const pageUrl = testcasePageUrl(key);
  const cacheUrl = args.full ? pageUrl + '#full' : pageUrl;
  return withCache(cacheUrl, args, async () => {
    const dumpOpts = {};
    if (!args.full) Object.assign(dumpOpts, CF_FOCUSED);
    const dump = await session.dump(pageUrl, dumpOpts);
    const downloadUrl = testcaseDownloadUrl(key);
    const minimized = await session.downloadText(downloadUrl);
    let original = null;
    if (args.downloadOriginal) {
      const originalUrl = testcaseDownloadUrl(key, { original: true });
      original = await session.downloadText(originalUrl);
      original = { ...original, url: originalUrl };
    }
    return {
      ...dump,
      key,
      pageUrl,
      reproducer: { ...minimized, url: downloadUrl },
      reproducerOriginal: original,
    };
  });
}

// Extract issue links from a search-results dump (legacy / fallback for pages
// that don't render the table).
export function extractSearchHits(markdown) {
  const re = /\[([^\]]+)\]\((https:\/\/issuetracker\.google\.com\/issues\/(\d+)(?:[^)]*)?)\)/g;
  const hits = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const id = m[3];
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({ id, title: m[1], url: canonicalIssueUrl(id) });
  }
  return hits;
}

// Parse the rich result table the search page renders. Columns are:
//   _, _, _, P, TYPE, TITLE, ASSIGNEE, STATUS, 7D VIEWS, ID, LAST MODIFIED
// Turndown emits "\\--" for "--" (the literal dash needs escaping at the
// start of a markdown line); we strip that back to empty.
export function extractSearchRows(markdown) {
  const rows = [];
  const unescape = (s) => s === '\\--' ? '' : s;
  // Markdown link with possible escaped brackets in the link text:
  // [\[V8 Sandbox\] Potential ...](https://...)
  const linkRe = /^\[((?:\\.|[^\]])+)\]\((https:[^)]+)\)$/;
  const unescapeMd = (s) => s.replace(/\\([\\[\]_*`])/g, '$1');
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 12) continue;
    const titleMatch = cells[6].match(linkRe);
    const idMatch = cells[10].match(/^\[(\d+)\]\((https:[^)]+)\)$/);
    if (!titleMatch || !idMatch) continue;
    rows.push({
      id: idMatch[1],
      url: idMatch[2],
      title: unescapeMd(titleMatch[1]),
      priority: unescape(cells[4]),
      type: unescape(cells[5]),
      assignee: unescape(cells[7]),
      status: unescape(cells[8]),
      views7d: parseInt(cells[9], 10) || 0,
      modified: unescape(cells[11]),
    });
  }
  return rows;
}

// Parse --since=<duration|date> into an absolute millisecond timestamp.
export function parseSince(s) {
  const m = String(s).match(/^(\d+)\s*([hdwm])$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = { h: 3600_000, d: 86400_000, w: 604800_000, m: 2592000_000 };
    return Date.now() - n * unit[m[2].toLowerCase()];
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  throw new Error(`Cannot parse --since=${s} (expected e.g. 7d, 1w, 2026-05-01)`);
}

export async function searchIssues(session, query, args) {
  const url = searchUrl(query);
  const cacheUrl = args.full ? url + '#full' : url;

  const cached = await withCache(cacheUrl, args, async () => {
    const dumpOpts = { maxPages: args.maxPages || 30 };
    if (!args.full) Object.assign(dumpOpts, SEARCH_FOCUSED);
    const { pages } = await session.dumpPaginated(url, dumpOpts);
    const hits = [];
    const seen = new Set();
    for (const p of pages) {
      // Prefer rich-table parsing; fall back to bare-link parsing if the page
      // didn't render a table (empty results, error stub, etc.).
      const rows = extractSearchRows(p.markdown);
      const source = rows.length ? rows : extractSearchHits(p.markdown);
      for (const r of source) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        hits.push(r);
      }
    }
    return { query, searchUrl: url, hits, pagesFetched: pages.length };
  });

  let hits = cached.hits;
  let filteredOut = 0;
  if (args.since) {
    const cutoff = parseSince(args.since);
    const before = hits.length;
    hits = hits.filter((h) => {
      if (!h.modified) return false;
      const t = Date.parse(h.modified.replace(/(\d)(AM|PM)/i, '$1 $2'));
      return Number.isFinite(t) && t >= cutoff;
    });
    filteredOut = before - hits.length;
  }
  return { ...cached, hits, since: args.since || null, filteredOut };
}
