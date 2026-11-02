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
  const cacheUrl = pageUrl + (args.full ? '#full' : '') +
    (args.downloadOriginal ? '#original' : '');
  return withCache(cacheUrl, args, async () => {
    const dumpOpts = {};
    if (!args.full) Object.assign(dumpOpts, CF_FOCUSED);
    const dump = await session.dump(pageUrl, dumpOpts);
    const downloadUrl = testcaseDownloadUrl(key);
    const minimized = await session.downloadText(downloadUrl);
    let original = null;
    if (args.downloadOriginal) {
      const urls = await fetchTestcaseDownloadUrls(session, key, args);
      original = urls.original
        ? { ...await session.downloadText(urls.original), url: urls.original }
        : { ok: false, error: 'Original testcase is unavailable.' };
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

export async function fetchTestcaseDownloadUrls(session, key, args) {
  const pageUrl = testcasePageUrl(key);
  const blobs = await withCache(pageUrl + '#downloads', args,
    () => session.testcaseDownloads(pageUrl));
  const url = (blob) => typeof blob === 'string' && blob && blob !== 'NA'
    ? testcaseDownloadUrl(key, { blob }) : null;
  return { minimized: url(blobs.minimized), original: url(blobs.original) };
}

// Extract issue links from a search-results dump (legacy / fallback for pages
// that don't render the table).
export const DEFAULT_LIST_QUERY = 'assignee:me status:open';

const unescapeMd = (s) => s.replace(/\\([\\[\]_*`|])/g, '$1');

export function extractSearchHits(markdown) {
  const re = /\[((?:\\.|[^\]])+)\]\((https:\/\/issuetracker\.google\.com\/issues\/(\d+)(?:[^)]*)?)\)/g;
  const hits = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const id = m[3];
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({ id, title: unescapeMd(m[1]), url: canonicalIssueUrl(id) });
  }
  return hits;
}

function splitTableRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) {
      cur += line[i] + line[i + 1];
      i++;
    } else if (line[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += line[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

// Parse the rich result table the search page renders. Internal b.corp tables
// include a "7D VIEWS" column while external issuetracker.google.com tables
// omit it, so locate columns dynamically from the header row.
export function extractSearchRows(markdown) {
  const rows = [];
  const unescape = (s) => (s === '\\--' || s === '--') ? '' : s;
  const linkRe = /^\[((?:\\.|[^\]])+)\]\((https:[^)]+)\)$/;
  let cols = null;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = splitTableRow(line);
    if (!cols) {
      const upper = cells.map((c) => c.toUpperCase());
      const titleIdx = upper.indexOf('TITLE');
      const idIdx = upper.indexOf('ID');
      if (titleIdx !== -1 && idIdx !== -1) {
        cols = {
          priority: upper.indexOf('P'),
          type: upper.indexOf('TYPE'),
          title: titleIdx,
          assignee: upper.indexOf('ASSIGNEE'),
          status: upper.indexOf('STATUS'),
          views7d: upper.indexOf('7D VIEWS'),
          id: idIdx,
          modified: upper.indexOf('LAST MODIFIED'),
        };
      }
      continue;
    }
    if (cells.length <= Math.max(cols.title, cols.id)) continue;
    const titleMatch = (cells[cols.title] || '').match(linkRe);
    const idMatch = (cells[cols.id] || '').match(/^\[(\d+)\]\((https:[^)]+)\)$/);
    if (!titleMatch || !idMatch) continue;
    rows.push({
      id: idMatch[1],
      url: idMatch[2],
      title: unescapeMd(titleMatch[1]),
      priority: cols.priority !== -1 ? unescape(cells[cols.priority] || '') : '',
      type: cols.type !== -1 ? unescape(cells[cols.type] || '') : '',
      assignee: cols.assignee !== -1 ? unescape(cells[cols.assignee] || '') : '',
      status: cols.status !== -1 ? unescape(cells[cols.status] || '') : '',
      views7d: cols.views7d !== -1 ? (parseInt(cells[cols.views7d], 10) || 0) : 0,
      modified: cols.modified !== -1 ? unescape(cells[cols.modified] || '') : '',
    });
  }
  return rows;
}

export const ISSUE_TYPES = {
  1: 'Bug',
  2: 'Feature Request',
  3: 'Customer Issue',
  4: 'Internal Cleanup',
  5: 'Process',
  6: 'Vulnerability',
  7: 'Privacy Issue',
  8: 'Portfolio',
  9: 'Program',
  10: 'Project',
  11: 'Feature',
  12: 'Milestone',
  13: 'Epic',
  14: 'Story',
  15: 'Task',
};

export const ISSUE_STATUSES = {
  1: 'New',
  2: 'Assigned',
  3: 'In Progress',
  4: 'Fixed',
  5: 'Fixed (Verified)',
  6: "Won't fix (Not reproducible)",
  7: "Won't fix (Intended behavior)",
  8: "Won't fix (Obsolete)",
  9: "Won't fix (Infeasible)",
  10: 'Duplicate',
  11: 'Inactive',
};

export const ISSUE_PRIORITIES = { 1: 'P0', 2: 'P1', 3: 'P2', 4: 'P3', 5: 'P4' };
export const ISSUE_SEVERITIES = { 1: 'S0', 2: 'S1', 3: 'S2', 4: 'S3', 5: 'S4' };

function isoDate(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

// Extract structured issue fields (including Severity, Created timestamp, and
// Chromium custom fields) from Buganizer's `/action/issues/list` XHR payload.
export function parseIssueSearchPayload(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawText).replace(/^\)\]\}'\s*/, ''));
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed?.[0]?.[6]?.[0]) ? parsed[0][6][0] : [];
  const out = [];
  for (const it of entries) {
    const id = it?.[1] != null ? String(it[1]) : null;
    const core = it?.[2];
    if (!id || !Array.isArray(core)) continue;
    const fieldDefs = Object.fromEntries(
      (Array.isArray(it[14]) ? it[14] : [])
        .filter((d) => Array.isArray(d) && d[0] != null && d[4])
        .map((d) => [d[0], d[4]]),
    );
    const customFields = {};
    for (const cv of Array.isArray(core[14]) ? core[14] : []) {
      const name = fieldDefs[cv?.[0]];
      if (name && typeof cv?.[9] === 'string' && cv[9]) customFields[name] = cv[9];
    }
    const createdMs = typeof it[4]?.[0] === 'number' ? it[4][0] * 1000 : null;
    const modifiedMs = typeof it[5]?.[0] === 'number' ? it[5][0] * 1000 : null;
    out.push({
      id,
      url: canonicalIssueUrl(id),
      title: typeof core[5] === 'string' ? core[5] : id,
      type: ISSUE_TYPES[core[1]] || '',
      status: ISSUE_STATUSES[core[2]] || '',
      priority: ISSUE_PRIORITIES[core[3]] || '',
      severity: ISSUE_SEVERITIES[core[4]] || '',
      assignee: typeof core[7]?.[0] === 'string' ? core[7][0] : '',
      createdMs,
      created: isoDate(createdMs) || '',
      modifiedMs,
      modified: isoDate(modifiedMs) || '',
      customFields,
    });
  }
  return out;
}

const DAY_MS = 86_400_000;
const SLO_BUG_TYPES = new Set(['Bug', 'Vulnerability', 'Customer Issue', 'Privacy Issue']);

function parseTimestamp(ms, str) {
  if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
  if (!str) return null;
  const t = Date.parse(String(str).replace(/(\d)(AM|PM)/i, '$1 $2'));
  return Number.isFinite(t) ? t : null;
}

// Compute Chromium SLO deadlines from issue metadata (Priority, Severity, Type,
// ReleaseBlock, Merge, Created, and Last Modified), since Buganizer hides its
// internal `nearestslo` field from @chromium.org accounts on public trackers.
export function computeIssueSlo(hit, nowMs = Date.now()) {
  const type = hit.type || '';
  const pri = hit.priority || '';
  const sev = hit.severity || '';
  const title = hit.title || '';
  const custom = hit.customFields || {};
  const componentTags = custom['Component Tags'] || '';
  const releaseBlock = custom.ReleaseBlock || '';
  const merge = custom.Merge || '';

  let closureDays = null;
  let updateDays = null;
  let rule = 'No SLO';

  const hasReleaseBlock = releaseBlock && releaseBlock !== 'NA' && SLO_BUG_TYPES.has(type);
  const isSecMerge = type === 'Vulnerability' && (
    /^\[Merge M\d+\]/i.test(title) ||
    componentTags.includes('Merge Request') ||
    merge === 'Pending'
  );
  const isPostMortem = /^PostMortem\b/i.test(title) || componentTags.includes('Post Mortem');

  if (hasReleaseBlock) {
    if (pri === 'P0') {
      closureDays = 2;
      updateDays = 1;
      rule = 'ReleaseBlock Urgent (2d)';
    } else {
      closureDays = 5;
      updateDays = 2;
      rule = 'ReleaseBlock (5d)';
    }
  } else if (isSecMerge) {
    closureDays = 5;
    updateDays = 2;
    rule = 'Sec Merge (5d)';
  } else if (type === 'Vulnerability') {
    if (sev === 'S0') { closureDays = 7; rule = 'Vuln S0 (1w)'; }
    else if (sev === 'S1') { closureDays = 28; rule = 'Vuln S1 (4w)'; }
    else if (sev === 'S2') { closureDays = 84; rule = 'Vuln S2 (12w)'; }
    else if (pri === 'P0') { closureDays = 7; rule = 'Vuln P0 (1w)'; }
    else if (pri === 'P1') { closureDays = 28; rule = 'Vuln P1 (4w)'; }
    if (pri === 'P0') updateDays = 1;
    else if (pri === 'P1') updateDays = 7;
  } else if (SLO_BUG_TYPES.has(type)) {
    if (pri === 'P0') {
      closureDays = 7;
      updateDays = 1;
      rule = 'Bug P0 (1w)';
    } else if (pri === 'P1') {
      closureDays = 28;
      updateDays = 7;
      rule = isPostMortem ? 'PostMortem (4w)' : 'Bug P1 (4w)';
    }
  }

  const inScope = closureDays !== null;
  const createdMs = parseTimestamp(hit.createdMs, hit.created);
  const modifiedMs = parseTimestamp(hit.modifiedMs, hit.modified);
  const closureDueMs = inScope && createdMs !== null ? createdMs + closureDays * DAY_MS : null;
  const updateDueMs = updateDays !== null && modifiedMs !== null ? modifiedMs + updateDays * DAY_MS : null;
  const closureRemDays = closureDueMs !== null ? Math.round((closureDueMs - nowMs) / DAY_MS) : null;
  const updateRemDays = updateDueMs !== null ? Math.round((updateDueMs - nowMs) / DAY_MS) : null;

  let bucket = 'none';
  if (inScope) {
    if (closureRemDays !== null && closureRemDays < 0) bucket = 'overdue';
    else if (closureRemDays !== null && closureRemDays <= 7) bucket = 'due_soon';
    else bucket = 'in_slo';
  }

  return {
    inScope,
    bucket,
    rule,
    closureDue: isoDate(closureDueMs),
    closureDueMs,
    closureRemDays,
    updateDue: isoDate(updateDueMs),
    updateDueMs,
    updateRemDays,
  };
}

const BUCKET_RANK = { overdue: 0, due_soon: 1, in_slo: 2, none: 3 };
const PRI_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

export function sortHitsBySlo(hits, nowMs = Date.now()) {
  return hits
    .map((h) => ({ ...h, slo: computeIssueSlo(h, nowMs) }))
    .sort((a, b) => (
      (BUCKET_RANK[a.slo.bucket] - BUCKET_RANK[b.slo.bucket]) ||
      ((a.slo.closureDueMs ?? Infinity) - (b.slo.closureDueMs ?? Infinity)) ||
      ((a.slo.updateDueMs ?? Infinity) - (b.slo.updateDueMs ?? Infinity)) ||
      ((PRI_RANK[a.priority] ?? 9) - (PRI_RANK[b.priority] ?? 9))
    ));
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

export async function searchIssues(session, query = DEFAULT_LIST_QUERY, args = {}) {
  const effectiveQuery = query || DEFAULT_LIST_QUERY;
  const url = searchUrl(effectiveQuery);
  const cacheUrl = url + (args.full ? '#full' : '') + '#v2';

  const cached = await withCache(cacheUrl, args, async () => {
    const dumpOpts = { maxPages: args.maxPages || 30 };
    if (!args.full) Object.assign(dumpOpts, SEARCH_FOCUSED);
    const { pages, apiPayloads = [] } = await session.dumpPaginated(url, dumpOpts);
    const apiById = new Map();
    for (const raw of apiPayloads) {
      for (const item of parseIssueSearchPayload(raw)) {
        if (!apiById.has(item.id)) apiById.set(item.id, item);
      }
    }
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
        const api = apiById.get(r.id);
        hits.push(api ? {
          ...api,
          ...r,
          title: api.title || r.title,
          priority: r.priority || api.priority,
          type: r.type || api.type,
          status: r.status || api.status,
          assignee: r.assignee || api.assignee,
          modified: r.modified || api.modified,
        } : r);
      }
    }
    return { query: effectiveQuery, searchUrl: url, hits, pagesFetched: pages.length };
  });

  let hits = cached.hits;
  let filteredOut = 0;
  if (args.since) {
    const cutoff = parseSince(args.since);
    const before = hits.length;
    hits = hits.filter((h) => {
      const t = parseTimestamp(h.modifiedMs, h.modified);
      return t !== null && t >= cutoff;
    });
    filteredOut = before - hits.length;
  }
  if (args.slo) {
    hits = sortHitsBySlo(hits);
  }
  return { ...cached, hits, since: args.since || null, slo: !!args.slo, filteredOut };
}
