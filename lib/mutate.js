// Authenticated write and field-inspection primitives for Buganizer issues:
// commenting, closing, assigning, editing standard & custom fields (including
// "Code Changes" Gerrit/Critique CLs and component custom fields like "OS"),
// and listing an issue's available fields + allowed enum choices.
//
// Uses Buganizer's in-page `/action/issues/...` JSON/JSPB endpoints via the
// authenticated Playwright session rather than clicking Angular Material menus:
//   - Duplicate targets work even when already closed, >365d old, or in a
//     different component (the UI picker scopes searches by default).
//   - Field updates + assignee + optional comment execute in one atomic
//     ModifyIssueRequest event (one history entry, one notification email).
//   - Local disk cache for the mutated issue is invalidated immediately.

import { deleteCache } from './cache.js';
import {
  ISSUE_PRIORITIES, ISSUE_SEVERITIES, ISSUE_STATUSES, ISSUE_TYPES,
} from './fetch.js';
import {
  canonicalIssueUrl, extractIssueIdFromUrl, resolveIssueUrl,
} from './url.js';

export const CUSTOM_FIELD_TYPES = {
  1: 'TEXT',
  2: 'DATE',
  3: 'ENUM',
  4: 'NUMERIC',
  5: 'REPEATED_TEXT',
  6: 'REPEATED_DATE',
  7: 'REPEATED_ENUM',
  8: 'REPEATED_NUMERIC',
  9: 'TEAM',
  10: 'PRODUCT',
  11: 'USER',
  12: 'REPEATED_TEAM',
  13: 'REPEATED_PRODUCT',
  14: 'REPEATED_USER',
  15: 'SYSTEM',
  16: 'REPEATED_SYSTEM',
};

const REPEATED_CUSTOM_FIELD_TYPES = new Set([
  'REPEATED_TEXT',
  'REPEATED_DATE',
  'REPEATED_ENUM',
  'REPEATED_NUMERIC',
  'REPEATED_TEAM',
  'REPEATED_PRODUCT',
  'REPEATED_USER',
  'REPEATED_SYSTEM',
]);

// Matches Buganizer's frontend `PAa` Gerrit URL regex:
// https://<host>-review.googlesource.com/c/<repo>/+/<changeNumber>[/...]
export const GERRIT_CHANGE_URL_RE =
  /^(?:https?:\/\/)?([\w-]+)-review\.(googlesource|git\.corp\.google)\.com\/c\/([\w\-/.]+)\/\+\/(\d{1,20})(?:[^\d].*)?$/i;

const CRITIQUE_URL_RE =
  /^(?:https?:\/\/)?(?:(?:cl|cr)\/([1-9]\d{0,19})|critique(?:-ng)?\.corp\.google\.com\/cl\/([1-9]\d{0,19})(?:[/?#].*)?)$/i;

export const OPEN_STATUS_DEFS = {
  new: {
    key: 'new',
    statusId: 1,
    label: 'New',
  },
  assigned: {
    key: 'assigned',
    statusId: 2,
    label: 'Assigned',
  },
  in_progress: {
    key: 'in_progress',
    statusId: 3,
    label: 'In Progress',
  },
};

export const CLOSE_STATUS_DEFS = {
  fixed: {
    key: 'fixed',
    statusId: 4,
    label: 'Fixed',
  },
  verified: {
    key: 'verified',
    statusId: 5,
    label: 'Fixed (Verified)',
  },
  duplicate: {
    key: 'duplicate',
    statusId: 10,
    label: 'Duplicate',
  },
  infeasible: {
    key: 'infeasible',
    statusId: 9,
    label: "Won't fix (Infeasible)",
  },
  intended_behavior: {
    key: 'intended_behavior',
    statusId: 7,
    label: "Won't fix (Intended behavior)",
  },
  not_reproducible: {
    key: 'not_reproducible',
    statusId: 6,
    label: "Won't fix (Not reproducible)",
  },
  obsolete: {
    key: 'obsolete',
    statusId: 8,
    label: "Won't fix (Obsolete)",
  },
  inactive: {
    key: 'inactive',
    statusId: 11,
    label: 'Inactive',
  },
};

export const ALL_STATUS_DEFS = {
  ...OPEN_STATUS_DEFS,
  ...CLOSE_STATUS_DEFS,
};

const CLOSE_STATUS_ALIASES = new Map([
  ['fixed', 'fixed'],
  ['fix', 'fixed'],

  ['verified', 'verified'],
  ['fixed-verified', 'verified'],
  ['fixed-(verified)', 'verified'],

  ['duplicate', 'duplicate'],
  ['dup', 'duplicate'],
  ['dupe', 'duplicate'],

  ['infeasible', 'infeasible'],
  ['wontfix', 'infeasible'],
  ['wont-fix', 'infeasible'],
  ['wontfix:infeasible', 'infeasible'],
  ['wont-fix:infeasible', 'infeasible'],
  ['wont-fix-infeasible', 'infeasible'],
  ['wont-fix-(infeasible)', 'infeasible'],

  ['intended-behavior', 'intended_behavior'],
  ['intended', 'intended_behavior'],
  ['wai', 'intended_behavior'],
  ['working-as-intended', 'intended_behavior'],
  ['works-as-intended', 'intended_behavior'],
  ['wontfix:intended-behavior', 'intended_behavior'],
  ['wont-fix:intended-behavior', 'intended_behavior'],
  ['wontfix:intended', 'intended_behavior'],
  ['wont-fix:intended', 'intended_behavior'],
  ['wontfix:wai', 'intended_behavior'],
  ['wont-fix:wai', 'intended_behavior'],
  ['wont-fix-intended-behavior', 'intended_behavior'],
  ['wont-fix-(intended-behavior)', 'intended_behavior'],

  ['not-reproducible', 'not_reproducible'],
  ['not-repro', 'not_reproducible'],
  ['norepro', 'not_reproducible'],
  ['no-repro', 'not_reproducible'],
  ['cant-repro', 'not_reproducible'],
  ['cannot-reproduce', 'not_reproducible'],
  ['unreproducible', 'not_reproducible'],
  ['wontfix:not-reproducible', 'not_reproducible'],
  ['wont-fix:not-reproducible', 'not_reproducible'],
  ['wontfix:not-repro', 'not_reproducible'],
  ['wont-fix:not-repro', 'not_reproducible'],
  ['wontfix:norepro', 'not_reproducible'],
  ['wont-fix:norepro', 'not_reproducible'],
  ['wontfix:cant-repro', 'not_reproducible'],
  ['wont-fix:cant-repro', 'not_reproducible'],
  ['wont-fix-not-reproducible', 'not_reproducible'],
  ['wont-fix-(not-reproducible)', 'not_reproducible'],

  ['obsolete', 'obsolete'],
  ['wontfix:obsolete', 'obsolete'],
  ['wont-fix:obsolete', 'obsolete'],
  ['wont-fix-obsolete', 'obsolete'],
  ['wont-fix-(obsolete)', 'obsolete'],

  ['inactive', 'inactive'],
]);

const OPEN_STATUS_ALIASES = new Map([
  ['new', 'new'],
  ['unassigned', 'new'],
  ['assigned', 'assigned'],
  ['in-progress', 'in_progress'],
  ['inprogress', 'in_progress'],
  ['accepted', 'in_progress'],
  ['started', 'in_progress'],
]);

const PRIORITY_BY_TOKEN = new Map([
  ['p0', 1], ['0', 1],
  ['p1', 2], ['1', 2],
  ['p2', 3], ['2', 3],
  ['p3', 4], ['3', 4],
  ['p4', 5], ['4', 5],
]);

const SEVERITY_BY_TOKEN = new Map([
  ['s0', 1], ['0', 1],
  ['s1', 2], ['1', 2],
  ['s2', 3], ['2', 3],
  ['s3', 4], ['3', 4],
  ['s4', 5], ['4', 5],
]);

// Chromium's public/security issue tracker ID in Buganizer (`d0a.PROD[157]`).
const CHROMIUM_TRACKER_ID = '157';
const CHROMIUM_VULNERABILITY_COLLABORATORS = ['security@chromium.org'];

// Matches Buganizer's `uPa` Issue.Type enum values.
export const ISSUE_TYPE_DEFS = [
  { id: 1, label: 'Bug', aliases: ['bug'] },
  { id: 2, label: 'Feature Request', aliases: ['feature-request', 'featurerequest', 'fr'] },
  { id: 3, label: 'Customer Issue', aliases: ['customer-issue', 'customerissue'] },
  { id: 4, label: 'Internal Cleanup', aliases: ['internal-cleanup', 'internalcleanup', 'cleanup'] },
  { id: 5, label: 'Process', aliases: ['process'] },
  { id: 6, label: 'Vulnerability', aliases: ['vulnerability', 'vuln'] },
  { id: 7, label: 'Privacy Issue', aliases: ['privacy-issue', 'privacyissue', 'privacy'] },
  { id: 8, label: 'Portfolio', aliases: ['portfolio'] },
  { id: 9, label: 'Program', aliases: ['program'] },
  { id: 10, label: 'Project', aliases: ['project'] },
  { id: 11, label: 'Feature', aliases: ['feature'] },
  { id: 12, label: 'Milestone', aliases: ['milestone'] },
  { id: 13, label: 'Epic', aliases: ['epic'] },
  { id: 14, label: 'Story', aliases: ['story'] },
  { id: 15, label: 'Task', aliases: ['task'] },
];

const ISSUE_TYPE_BY_TOKEN = new Map();
for (const def of ISSUE_TYPE_DEFS) {
  for (const a of def.aliases) ISSUE_TYPE_BY_TOKEN.set(a, def);
}

// Statuses where Buganizer enforces an assignee (`REQUIRED`) vs forbids one (`FORBIDDEN`).
const STATUS_REQUIRES_ASSIGNEE = new Set([2, 3, 4, 5]);
const STATUS_FORBIDS_ASSIGNEE = new Set([1]);

export function normalizeStatusToken(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

export function normalizeFieldKey(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[\s_-]+/g, ' ');
}

export function resolveCloseStatus(statusInput, duplicateOfInput) {
  const hasDupTarget = duplicateOfInput !== undefined &&
    duplicateOfInput !== null &&
    String(duplicateOfInput).trim() !== '';

  let resolved;
  if (statusInput === undefined || statusInput === null || String(statusInput).trim() === '') {
    resolved = hasDupTarget ? CLOSE_STATUS_DEFS.duplicate : CLOSE_STATUS_DEFS.fixed;
  } else {
    const norm = normalizeStatusToken(statusInput);
    const key = CLOSE_STATUS_ALIASES.get(norm);
    if (!key) {
      throw new Error(
        `Unknown close status "${statusInput}". Expected one of: ` +
        `fixed, verified, duplicate, wontfix (infeasible), ` +
        `intended-behavior (wai), not-reproducible (norepro), obsolete, inactive.`,
      );
    }
    resolved = CLOSE_STATUS_DEFS[key];
    if (hasDupTarget && resolved.key !== 'duplicate') {
      throw new Error(
        `Cannot combine duplicate target (${duplicateOfInput}) with status "${statusInput}".`,
      );
    }
  }

  if (resolved.key === 'duplicate' && !hasDupTarget) {
    throw new Error(
      'Closing as duplicate requires a target issue (pass --duplicate=<id|url> or --duplicate-of=<id|url>).',
    );
  }

  return resolved;
}

export function resolveIssueStatus(statusInput) {
  const norm = normalizeStatusToken(statusInput);
  const openKey = OPEN_STATUS_ALIASES.get(norm);
  if (openKey) return OPEN_STATUS_DEFS[openKey];
  const closeKey = CLOSE_STATUS_ALIASES.get(norm);
  if (closeKey) {
    if (closeKey === 'duplicate') {
      throw new Error(
        'To mark an issue as Duplicate, use `bnz close <id> --duplicate=<target>` (or `bnz_close`).',
      );
    }
    return CLOSE_STATUS_DEFS[closeKey];
  }
  throw new Error(
    `Unknown status "${statusInput}". Expected one of: new, assigned, in-progress, ` +
    `fixed, verified, wontfix (infeasible), intended-behavior (wai), ` +
    `not-reproducible (norepro), obsolete, inactive.`,
  );
}

export function resolvePriority(raw) {
  const id = PRIORITY_BY_TOKEN.get(normalizeStatusToken(raw));
  if (!id) {
    throw new Error(`Invalid priority "${raw}" (expected P0, P1, P2, P3, P4, or 0..4).`);
  }
  return { id, label: ISSUE_PRIORITIES[id] };
}

export function resolveSeverity(raw) {
  const id = SEVERITY_BY_TOKEN.get(normalizeStatusToken(raw));
  if (!id) {
    throw new Error(`Invalid severity "${raw}" (expected S0, S1, S2, S3, S4, or 0..4).`);
  }
  return { id, label: ISSUE_SEVERITIES[id] };
}

export function tryResolveIssueType(raw) {
  if (raw === undefined || raw === null) return null;
  return ISSUE_TYPE_BY_TOKEN.get(normalizeStatusToken(raw)) || null;
}

export function resolveIssueType(raw) {
  const def = tryResolveIssueType(raw);
  if (!def) {
    const names = ISSUE_TYPE_DEFS.map((d) => d.label).join(', ');
    throw new Error(`Unknown issue type "${raw}". Expected one of: ${names}.`);
  }
  return def;
}

export function formatGerritChangeUrl(g) {
  const domain = g.domain || 'googlesource';
  return `https://${g.host}-review.${domain}.com/c/${g.repo}/+/${g.changeNumber}`;
}

export function parseCodeChangeEntry(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error('Code Changes entry must not be empty.');
  }
  const gerritMatch = trimmed.match(GERRIT_CHANGE_URL_RE);
  if (gerritMatch) {
    const host = gerritMatch[1].toLowerCase();
    const domain = gerritMatch[2].toLowerCase();
    const repo = gerritMatch[3].replace(/\/+$/, '');
    const changeNumber = Number(gerritMatch[4]);
    return {
      kind: 'gerrit',
      host,
      domain,
      repo,
      changeNumber,
      stateId: 2, // MERGED
      display: formatGerritChangeUrl({ host, domain, repo, changeNumber }),
    };
  }
  if (
    /crrev\.com/i.test(trimmed) ||
    /-review\.(?:googlesource|git\.corp\.google)\.com/i.test(trimmed)
  ) {
    throw new Error(
      `Invalid Code Changes URL "${trimmed}". Buganizer requires a full Gerrit URL ` +
      `including the repository path, e.g. ` +
      `https://chromium-review.googlesource.com/c/v8/v8/+/8691333 ` +
      `(not crrev.com or a shortened URL without /c/<repo>/+/).`,
    );
  }
  const critiqueMatch = trimmed.match(CRITIQUE_URL_RE);
  if (critiqueMatch) {
    const cl = critiqueMatch[1] || critiqueMatch[2];
    return { kind: 'changelist', changeNumber: cl, display: cl };
  }
  if (/^[1-9]\d{0,19}$/.test(trimmed)) {
    return { kind: 'changelist', changeNumber: trimmed, display: trimmed };
  }
  throw new Error(
    `Invalid Code Changes value "${trimmed}". Expected a full Gerrit URL ` +
    `(https://<host>-review.googlesource.com/c/<repo>/+/<cl>) or a Critique CL number.`,
  );
}

export function stripXssiPrefix(rawText) {
  return String(rawText ?? '').replace(/^\)\]\}'\s*/, '');
}

export function extractRpcErrorMessage(rawText, httpStatus) {
  const body = stripXssiPrefix(rawText).trim();
  if (!body) return `HTTP ${httpStatus}`;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }
    const found = findErrorStringInJspb(parsed, 0);
    if (found) return found;
  } catch {
    // Fall through to plain-text snippet.
  }
  return body.replace(/\s+/g, ' ').slice(0, 300);
}

function findErrorStringInJspb(node, depth) {
  if (depth > 6 || node == null) return null;
  if (typeof node === 'string') {
    const t = node.trim();
    if (t && !/^b\.[A-Z]/.test(t) && t.length < 400) return t;
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const m = findErrorStringInJspb(item, depth + 1);
      if (m) return m;
    }
  }
  return null;
}

function formatIsoDateTuple(tuple) {
  if (!Array.isArray(tuple) || tuple.length < 3) return null;
  const [y, m, d] = tuple;
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseIsoDateToTuple(raw, fieldLabel) {
  const m = String(raw ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    throw new Error(`Invalid date "${raw}" for "${fieldLabel}" (expected YYYY-MM-DD).`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Out-of-range date "${raw}" for "${fieldLabel}" (expected YYYY-MM-DD).`);
  }
  return [year, month, day];
}

function parseCustomFieldValueTuple(cfv, typeName) {
  if (!Array.isArray(cfv)) return null;
  switch (typeName) {
    case 'TEXT':
      return typeof cfv[1] === 'string' ? cfv[1] : null;
    case 'DATE':
      return formatIsoDateTuple(cfv[2]);
    case 'ENUM':
      return typeof cfv[3] === 'string' ? cfv[3] : null;
    case 'NUMERIC':
      return typeof cfv[4] === 'number' ? cfv[4] : null;
    case 'REPEATED_TEXT':
      return Array.isArray(cfv[5]?.[0]) ? cfv[5][0].map(String) : [];
    case 'REPEATED_DATE':
      return Array.isArray(cfv[6]?.[0]) ? cfv[6][0].map(formatIsoDateTuple).filter(Boolean) : [];
    case 'REPEATED_ENUM':
      return Array.isArray(cfv[7]?.[0]) ? cfv[7][0].map(String) : [];
    case 'REPEATED_NUMERIC':
      return Array.isArray(cfv[8]?.[0]) ? cfv[8][0].map(Number) : [];
    case 'TEAM':
      return cfv[11] != null ? String(cfv[11]) : null;
    case 'PRODUCT':
      return cfv[12] != null ? String(cfv[12]) : null;
    case 'USER':
      return typeof cfv[13]?.[0] === 'string' ? cfv[13][0] : null;
    case 'REPEATED_TEAM':
      return Array.isArray(cfv[14]?.[0]) ? cfv[14][0].map(String) : [];
    case 'REPEATED_PRODUCT':
      return Array.isArray(cfv[15]?.[0]) ? cfv[15][0].map(String) : [];
    case 'REPEATED_USER':
      return Array.isArray(cfv[16]?.[0]) ? cfv[16][0].map((u) => u?.[0]).filter(Boolean) : [];
    case 'SYSTEM':
      return cfv[17] != null ? String(cfv[17]) : null;
    case 'REPEATED_SYSTEM':
      return Array.isArray(cfv[18]?.[0]) ? cfv[18][0].map(String) : [];
    default:
      return typeof cfv[9] === 'string' ? cfv[9] : null;
  }
}

export function parseIssueFetchResponse(rawText, expectedId) {
  let parsed;
  try {
    parsed = JSON.parse(stripXssiPrefix(rawText));
  } catch {
    return null;
  }
  const container = parsed?.[0]?.[1];
  if (!Array.isArray(container)) return null;

  const matchesIssue = (entry) =>
    Array.isArray(entry) &&
    entry[1] != null &&
    Array.isArray(entry[2]) &&
    (!expectedId || String(entry[1]) === String(expectedId));

  let issueTuple = matchesIssue(container[22]) ? container[22] : null;
  if (!issueTuple) {
    issueTuple = container.find(matchesIssue) || null;
  }
  if (!issueTuple) return null;

  const id = String(issueTuple[1]);
  const core = issueTuple[2];

  const extractEmails = (arr) =>
    Array.isArray(arr)
      ? arr.map((u) => (typeof u?.[0] === 'string' ? u[0] : '')).filter(Boolean)
      : [];

  const changelists = Array.isArray(core[15]) ? core[15].map(String) : [];
  const gerritChanges = Array.isArray(core[34])
    ? core[34]
        .filter((g) => Array.isArray(g) && g[0] && g[1] && g[2] != null)
        .map((g) => ({
          host: String(g[0]),
          repo: String(g[1]),
          changeNumber: Number(g[2]),
          stateId: typeof g[3] === 'number' ? g[3] : 0,
          state: g[3] === 1 ? 'PENDING' : g[3] === 2 ? 'MERGED' : 'UNSPECIFIED',
          branch: typeof g[4] === 'string' && g[4] ? g[4] : null,
          url: formatGerritChangeUrl({
            host: String(g[0]),
            repo: String(g[1]),
            changeNumber: Number(g[2]),
          }),
        }))
    : [];

  const codeChanges = [
    ...changelists,
    ...gerritChanges.filter((g) => g.stateId !== 1).map((g) => g.url),
  ];
  const pendingCodeChanges = gerritChanges
    .filter((g) => g.stateId === 1)
    .map((g) => g.url);

  const visibleCustomIds = new Set(
    (Array.isArray(issueTuple[33]) ? issueTuple[33] : [])
      .map((entry) => (Array.isArray(entry) && entry[0] != null ? String(entry[0]) : null))
      .filter(Boolean),
  );

  const rawValueById = new Map();
  for (const cfv of Array.isArray(core[14]) ? core[14] : []) {
    if (Array.isArray(cfv) && cfv[0] != null) {
      rawValueById.set(String(cfv[0]), cfv);
    }
  }

  const customFields = [];
  const seenCustomIds = new Set();
  for (const def of Array.isArray(issueTuple[14]) ? issueTuple[14] : []) {
    if (!Array.isArray(def) || def[0] == null) continue;
    const cfId = String(def[0]);
    seenCustomIds.add(cfId);
    const typeName = CUSTOM_FIELD_TYPES[def[2]] || 'TEXT';
    const isRepeated = REPEATED_CUSTOM_FIELD_TYPES.has(typeName);
    const rawCfv = rawValueById.get(cfId);
    const value = rawCfv
      ? parseCustomFieldValueTuple(rawCfv, typeName)
      : (isRepeated ? [] : null);
    const displayString = typeof rawCfv?.[9] === 'string'
      ? rawCfv[9]
      : (Array.isArray(value) ? value.join(', ') : (value != null ? String(value) : ''));
    customFields.push({
      id: cfId,
      componentId: def[1] != null ? String(def[1]) : null,
      typeId: def[2] ?? null,
      type: typeName,
      isRepeated,
      required: Boolean(def[3]),
      name: typeof def[4] === 'string' ? def[4] : cfId,
      description: typeof def[5] === 'string' ? def[5] : '',
      allowedValues: Array.isArray(def[7]) ? def[7].map(String) : null,
      visible: visibleCustomIds.has(cfId),
      value,
      displayValue: displayString,
    });
  }

  // Include any populated custom field values whose definition wasn't in issueTuple[14].
  for (const [cfId, rawCfv] of rawValueById.entries()) {
    if (seenCustomIds.has(cfId)) continue;
    const displayString = typeof rawCfv?.[9] === 'string' ? rawCfv[9] : '';
    customFields.push({
      id: cfId,
      componentId: null,
      typeId: null,
      type: 'TEXT',
      isRepeated: false,
      required: false,
      name: cfId,
      description: '',
      allowedValues: null,
      visible: false,
      value: displayString || null,
      displayValue: displayString,
    });
  }

  const typeLabel = ISSUE_TYPES[core[1]] ||
    ISSUE_TYPE_DEFS.find((d) => d.id === core[1])?.label ||
    '';

  return {
    id,
    url: canonicalIssueUrl(id),
    trackerId: issueTuple[41] != null ? String(issueTuple[41]) : null,
    componentId: core[0] != null ? String(core[0]) : null,
    typeId: core[1] ?? null,
    type: typeLabel,
    statusId: core[2] ?? null,
    status: ISSUE_STATUSES[core[2]] || '',
    priorityId: core[3] ?? null,
    priority: ISSUE_PRIORITIES[core[3]] || '',
    severityId: core[4] ?? null,
    severity: ISSUE_SEVERITIES[core[4]] || '',
    title: typeof core[5] === 'string' ? core[5] : id,
    reporter: typeof core[6]?.[0] === 'string' ? core[6][0] : '',
    assignee: typeof core[7]?.[0] === 'string' ? core[7][0] : '',
    verifier: typeof core[8]?.[0] === 'string' ? core[8][0] : '',
    ccs: extractEmails(core[9]),
    canonicalIssueId: core[10] != null ? String(core[10]) : null,
    blockedByIssueIds: Array.isArray(core[11]) ? core[11].map(String) : [],
    blockingIssueIds: Array.isArray(core[12]) ? core[12].map(String) : [],
    hotlistIds: Array.isArray(core[13]) ? core[13].map(String) : [],
    changelists,
    gerritChanges,
    codeChanges,
    pendingCodeChanges,
    foundInVersions: Array.isArray(core[16]) ? core[16].map(String) : [],
    targetedToVersions: Array.isArray(core[17]) ? core[17].map(String) : [],
    verifiedInVersions: Array.isArray(core[18]) ? core[18].map(String) : [],
    collaborators: extractEmails(core[30]),
    customFields,
  };
}

export async function fetchIssueBasic(session, issueId) {
  const numId = Number(issueId);
  const res = await session.buganizerRpc(
    `/action/issues/${issueId}/getIssue`,
    [numId, 1, 1],
  );
  if (!res.ok) {
    throw new Error(`Issue ${issueId}: ${extractRpcErrorMessage(res.text, res.status)}`);
  }
  const issue = parseIssueFetchResponse(res.text, issueId);
  if (!issue) {
    throw new Error(`Issue ${issueId}: unexpected response from getIssue.`);
  }
  return { ...issue, userEmail: res.userEmail || '' };
}

export async function fetchIssueFields(session, input, { full = false } = {}) {
  const url = resolveIssueUrl(input);
  const id = extractIssueIdFromUrl(url);
  const issue = await fetchIssueBasic(session, id);

  const hasValue = (cf) =>
    cf.isRepeated ? Array.isArray(cf.value) && cf.value.length > 0 : cf.value != null && cf.value !== '';

  const shownCustomFields = full
    ? issue.customFields
    : issue.customFields.filter((cf) => cf.visible || hasValue(cf));
  const hiddenCustomFieldCount = issue.customFields.length - shownCustomFields.length;

  return {
    id: issue.id,
    url: issue.url,
    title: issue.title,
    standardFields: {
      status: issue.status,
      type: issue.type,
      priority: issue.priority,
      severity: issue.severity,
      componentId: issue.componentId,
      assignee: issue.assignee || null,
      reporter: issue.reporter || null,
      verifier: issue.verifier || null,
      collaborators: issue.collaborators,
      cc: issue.ccs,
      codeChanges: issue.codeChanges,
      pendingCodeChanges: issue.pendingCodeChanges,
      foundIn: issue.foundInVersions,
      targetedTo: issue.targetedToVersions,
      verifiedIn: issue.verifiedInVersions,
      hotlists: issue.hotlistIds,
      blockedBy: issue.blockedByIssueIds,
      blocking: issue.blockingIssueIds,
    },
    customFields: shownCustomFields.map((cf) => ({
      id: cf.id,
      name: cf.name,
      type: cf.type,
      required: cf.required,
      visible: cf.visible,
      value: cf.value,
      allowedValues: cf.allowedValues,
      description: cf.description || undefined,
    })),
    hiddenCustomFieldCount,
  };
}

export function invalidateIssueCache(issueUrl) {
  deleteCache(issueUrl);
  deleteCache(issueUrl + '#full');
}

function setProtoField(arr, protoFieldNum, value) {
  const idx = protoFieldNum - 1;
  for (let i = 0; i < idx; i++) {
    if (arr[i] === undefined) arr[i] = null;
  }
  arr[idx] = value;
  return arr;
}

function buildCommentJspb(commentText, useMarkdown) {
  const formattingMode = useMarkdown ? 2 : 1; // 2 = MARKDOWN, 1 = PLAIN
  return [commentText, null, null, null, null, null, null, null, formattingMode];
}

export function buildCreateCommentPayload(issueId, commentText, { markdown = true } = {}) {
  return [
    null, null, null, null,
    [Number(issueId), buildCommentJspb(commentText, markdown)],
  ];
}

export function buildCustomFieldValueJspb(customFieldId, typeName, value) {
  const arr = [Number(customFieldId)];
  if (value === null || value === undefined) return arr;
  switch (typeName) {
    case 'TEXT':
      return setProtoField(arr, 2, String(value));
    case 'DATE':
      return setProtoField(arr, 3, Array.isArray(value) ? value : parseIsoDateToTuple(value, customFieldId));
    case 'ENUM':
      return setProtoField(arr, 4, String(value));
    case 'NUMERIC':
      return setProtoField(arr, 5, Number(value));
    case 'REPEATED_TEXT':
      return setProtoField(arr, 6, [value.map(String)]);
    case 'REPEATED_DATE':
      return setProtoField(arr, 7, [value.map((v) => Array.isArray(v) ? v : parseIsoDateToTuple(v, customFieldId))]);
    case 'REPEATED_ENUM':
      return setProtoField(arr, 8, [value.map(String)]);
    case 'REPEATED_NUMERIC':
      return setProtoField(arr, 9, [value.map(Number)]);
    case 'TEAM':
      return setProtoField(arr, 12, Number(value));
    case 'PRODUCT':
      return setProtoField(arr, 13, Number(value));
    case 'USER':
      return setProtoField(arr, 14, [String(value)]);
    case 'REPEATED_TEAM':
      return setProtoField(arr, 15, [value.map(Number)]);
    case 'REPEATED_PRODUCT':
      return setProtoField(arr, 16, [value.map(Number)]);
    case 'REPEATED_USER':
      return setProtoField(arr, 17, [value.map((u) => [String(u)])]);
    case 'SYSTEM':
      return setProtoField(arr, 18, Number(value));
    case 'REPEATED_SYSTEM':
      return setProtoField(arr, 19, [value.map(Number)]);
    default:
      throw new Error(`Unsupported custom field type "${typeName}".`);
  }
}

export function buildCustomFieldClearJspb(customFieldId) {
  // Matches Buganizer's `__.Ko(customFieldId, "TEXT", "")` for REMOVE actions.
  return [Number(customFieldId), ''];
}

export function buildGerritChangeJspb(g) {
  const arr = [g.host, g.repo, Number(g.changeNumber), g.stateId ?? 2];
  if (g.branch) arr.push(g.branch);
  return arr;
}

export function buildMarkAsVulnerabilityPayload(
  issueId,
  collaborators = CHROMIUM_VULNERABILITY_COLLABORATORS,
) {
  const inner = [Number(issueId)];
  if (collaborators?.length) {
    inner.push(collaborators.map((e) => [e]));
  }
  return ['b.MarkAsVulnerabilityRequest', null, null, inner];
}

export function buildModifyIssuePayload(issueId, {
  statusId,
  assignee,
  clearAssignee = false,
  priorityId,
  severityId,
  typeId,
  title,
  componentId,
  verifier,
  clearVerifier = false,
  addCcs,
  removeCcs,
  addCollaborators,
  removeCollaborators,
  addCodeChanges,
  removeCodeChanges,
  addGerritChanges,
  removeGerritChanges,
  addFoundIn,
  removeFoundIn,
  addTargetedTo,
  removeTargetedTo,
  addVerifiedIn,
  removeVerifiedIn,
  addHotlistIds,
  removeHotlistIds,
  addBlockedByIds,
  removeBlockedByIds,
  addBlockingIds,
  removeBlockingIds,
  addCustomFields,
  removeCustomFields,
  comment,
  markdown = true,
} = {}) {
  const addMask = [];
  const removeMask = [];
  const stateAdd = [];
  const stateRemove = [];

  if (componentId !== undefined && componentId !== null) {
    addMask.push('component_id');
    setProtoField(stateAdd, 1, Number(componentId));
  }
  if (typeId !== undefined && typeId !== null) {
    addMask.push('type');
    setProtoField(stateAdd, 2, typeId);
  }
  if (statusId !== undefined && statusId !== null) {
    addMask.push('status');
    setProtoField(stateAdd, 3, statusId);
  }
  if (priorityId !== undefined && priorityId !== null) {
    addMask.push('priority');
    setProtoField(stateAdd, 4, priorityId);
  }
  if (severityId !== undefined && severityId !== null) {
    addMask.push('severity');
    setProtoField(stateAdd, 5, severityId);
  }
  if (title !== undefined && title !== null) {
    addMask.push('title');
    setProtoField(stateAdd, 6, String(title));
  }
  if (assignee) {
    addMask.push('assignee');
    setProtoField(stateAdd, 8, [assignee]);
  } else if (clearAssignee) {
    removeMask.push('assignee');
    setProtoField(stateRemove, 8, []);
  }
  if (verifier) {
    addMask.push('verifier');
    setProtoField(stateAdd, 9, [verifier]);
  } else if (clearVerifier) {
    removeMask.push('verifier');
    setProtoField(stateRemove, 9, []);
  }
  if (addCcs?.length) {
    addMask.push('ccs');
    setProtoField(stateAdd, 10, addCcs.map((e) => [e]));
  }
  if (removeCcs?.length) {
    removeMask.push('ccs');
    setProtoField(stateRemove, 10, removeCcs.map((e) => [e]));
  }
  if (addBlockedByIds?.length) {
    addMask.push('blocked_by_issue_ids');
    setProtoField(stateAdd, 12, addBlockedByIds.map(Number));
  }
  if (removeBlockedByIds?.length) {
    removeMask.push('blocked_by_issue_ids');
    setProtoField(stateRemove, 12, removeBlockedByIds.map(Number));
  }
  if (addBlockingIds?.length) {
    addMask.push('blocking_issue_ids');
    setProtoField(stateAdd, 13, addBlockingIds.map(Number));
  }
  if (removeBlockingIds?.length) {
    removeMask.push('blocking_issue_ids');
    setProtoField(stateRemove, 13, removeBlockingIds.map(Number));
  }
  if (addHotlistIds?.length) {
    addMask.push('hotlist_ids');
    setProtoField(stateAdd, 14, addHotlistIds.map(Number));
  }
  if (removeHotlistIds?.length) {
    removeMask.push('hotlist_ids');
    setProtoField(stateRemove, 14, removeHotlistIds.map(Number));
  }
  if (addCustomFields?.length) {
    addMask.push('custom_fields');
    setProtoField(stateAdd, 15, addCustomFields);
  }
  if (removeCustomFields?.length) {
    removeMask.push('custom_fields');
    setProtoField(stateRemove, 15, removeCustomFields);
  }
  if (addCodeChanges?.length) {
    addMask.push('code_changes');
    setProtoField(stateAdd, 16, addCodeChanges.map(String));
  }
  if (removeCodeChanges?.length) {
    removeMask.push('code_changes');
    setProtoField(stateRemove, 16, removeCodeChanges.map(String));
  }
  if (addFoundIn?.length) {
    addMask.push('found_in_versions');
    setProtoField(stateAdd, 17, addFoundIn.map(String));
  }
  if (removeFoundIn?.length) {
    removeMask.push('found_in_versions');
    setProtoField(stateRemove, 17, removeFoundIn.map(String));
  }
  if (addTargetedTo?.length) {
    addMask.push('targeted_to_versions');
    setProtoField(stateAdd, 18, addTargetedTo.map(String));
  }
  if (removeTargetedTo?.length) {
    removeMask.push('targeted_to_versions');
    setProtoField(stateRemove, 18, removeTargetedTo.map(String));
  }
  if (addVerifiedIn?.length) {
    addMask.push('verified_in_versions');
    setProtoField(stateAdd, 19, addVerifiedIn.map(String));
  }
  if (removeVerifiedIn?.length) {
    removeMask.push('verified_in_versions');
    setProtoField(stateRemove, 19, removeVerifiedIn.map(String));
  }
  if (addCollaborators?.length) {
    addMask.push('collaborators');
    setProtoField(stateAdd, 31, addCollaborators.map((e) => [e]));
  }
  if (removeCollaborators?.length) {
    removeMask.push('collaborators');
    setProtoField(stateRemove, 31, removeCollaborators.map((e) => [e]));
  }
  if (addGerritChanges?.length) {
    addMask.push('gerrit_changes');
    setProtoField(stateAdd, 35, addGerritChanges.map(buildGerritChangeJspb));
  }
  if (removeGerritChanges?.length) {
    removeMask.push('gerrit_changes');
    setProtoField(stateRemove, 35, removeGerritChanges.map(buildGerritChangeJspb));
  }

  const modifyReq = [
    Number(issueId),
    addMask.length ? [addMask] : [],
    stateAdd,
    removeMask.length ? [removeMask] : [],
    stateRemove,
  ];
  if (comment) {
    modifyReq.push(buildCommentJspb(comment, markdown));
  }
  return [null, null, null, null, null, null, modifyReq];
}

const CLEAR_USER_TOKENS = new Set(['none', 'null', 'unassigned', 'clear', '-']);

function resolveUserSpec(raw, sessionUserEmail, label = 'assignee') {
  if (raw === undefined) return { specified: false };
  if (raw === null || raw === '') return { specified: true, clear: true, email: '' };
  const trimmed = String(raw).trim();
  if (!trimmed || CLEAR_USER_TOKENS.has(trimmed.toLowerCase())) {
    return { specified: true, clear: true, email: '' };
  }
  if (trimmed.toLowerCase() === 'me') {
    if (!sessionUserEmail) {
      throw new Error(`Cannot resolve ${label}="me": current session user email is unavailable.`);
    }
    return { specified: true, clear: false, email: sessionUserEmail };
  }
  if (!trimmed.includes('@') || /\s/.test(trimmed)) {
    throw new Error(`Invalid ${label} "${raw}" (expected an email address, "me", or "none").`);
  }
  return { specified: true, clear: false, email: trimmed };
}

function normalizeAssigneeInput(rawAssignee, sessionUserEmail) {
  const spec = resolveUserSpec(rawAssignee, sessionUserEmail, 'assignee');
  if (!spec.specified) return null;
  if (spec.clear) {
    throw new Error('Cannot clear assignee when closing an issue.');
  }
  return spec.email;
}

function splitMultiValues(raw) {
  if (Array.isArray(raw)) {
    return raw
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]))
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== '' && v !== null && v !== undefined);
  }
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'number') return [raw];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isClearScalarToken(raw) {
  if (raw === null || raw === '') return true;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    return t === '' || t === 'none' || t === 'null';
  }
  return false;
}

function resolveEmailList(raw, sessionUserEmail, label) {
  const tokens = splitMultiValues(raw);
  return tokens.map((tok) => {
    const spec = resolveUserSpec(tok, sessionUserEmail, label);
    if (!spec.specified || spec.clear) {
      throw new Error(`Invalid email "${tok}" in ${label}.`);
    }
    return spec.email;
  });
}

function resolveNumericIdList(raw, label) {
  return splitMultiValues(raw).map((tok) => {
    const s = String(tok).trim().replace(/^b\//, '');
    if (!/^\d+$/.test(s)) {
      throw new Error(`Invalid numeric ID "${tok}" in ${label}.`);
    }
    return s;
  });
}

function computeSetDelta(currentList, desiredList) {
  const curSet = new Set(currentList);
  const desSet = new Set(desiredList);
  const added = [];
  for (const item of desiredList) {
    if (!curSet.has(item) && !added.includes(item)) added.push(item);
  }
  const removed = [];
  for (const item of currentList) {
    if (!desSet.has(item) && !removed.includes(item)) removed.push(item);
  }
  return { added, removed };
}

function applyListOperation(currentList, { set, add = [], remove = [], clear = false }) {
  let next;
  if (clear) {
    next = [];
  } else if (set !== undefined) {
    next = [...new Set(set)];
  } else {
    next = [...currentList];
  }
  for (const item of add) {
    if (!next.includes(item)) next.push(item);
  }
  if (remove.length) {
    const remSet = new Set(remove);
    next = next.filter((item) => !remSet.has(item));
  }
  return {
    next,
    ...computeSetDelta(currentList, next),
  };
}

function matchEnumChoice(rawItem, cf) {
  const s = String(rawItem).trim();
  if (!cf.allowedValues || cf.allowedValues.length === 0) return s;
  const exact = cf.allowedValues.find((v) => v === s);
  if (exact !== undefined) return exact;
  const lower = s.toLowerCase();
  const ci = cf.allowedValues.find((v) => v.toLowerCase() === lower);
  if (ci !== undefined) return ci;
  const norm = normalizeFieldKey(s);
  const fuzzy = cf.allowedValues.find((v) => normalizeFieldKey(v) === norm);
  if (fuzzy !== undefined) return fuzzy;
  throw new Error(
    `Invalid value "${s}" for custom field "${cf.name}" (${cf.id}). ` +
    `Allowed values: ${cf.allowedValues.join(', ')}.`,
  );
}

function coerceSingleCustomItem(rawItem, cf, sessionUserEmail) {
  switch (cf.type) {
    case 'TEXT':
    case 'REPEATED_TEXT':
      return String(rawItem);
    case 'ENUM':
    case 'REPEATED_ENUM':
      return matchEnumChoice(rawItem, cf);
    case 'NUMERIC':
    case 'REPEATED_NUMERIC': {
      const n = typeof rawItem === 'number' ? rawItem : Number(String(rawItem).trim());
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid numeric value "${rawItem}" for custom field "${cf.name}" (${cf.id}).`);
      }
      return n;
    }
    case 'DATE':
    case 'REPEATED_DATE': {
      const tuple = parseIsoDateToTuple(rawItem, cf.name);
      return formatIsoDateTuple(tuple);
    }
    case 'USER':
    case 'REPEATED_USER': {
      const spec = resolveUserSpec(rawItem, sessionUserEmail, cf.name);
      if (!spec.specified || spec.clear) {
        throw new Error(`Invalid user email "${rawItem}" for custom field "${cf.name}" (${cf.id}).`);
      }
      return spec.email;
    }
    case 'TEAM':
    case 'REPEATED_TEAM':
    case 'PRODUCT':
    case 'REPEATED_PRODUCT':
    case 'SYSTEM':
    case 'REPEATED_SYSTEM': {
      const s = String(rawItem).trim();
      if (!/^\d+$/.test(s)) {
        throw new Error(`Invalid numeric ID "${rawItem}" for custom field "${cf.name}" (${cf.id}).`);
      }
      return s;
    }
    default:
      return String(rawItem);
  }
}

const STANDARD_FIELD_ALIASES = new Map([
  ['assignee', 'assignee'],
  ['owner', 'assignee'],
  ['status', 'status'],
  ['priority', 'priority'],
  ['pri', 'priority'],
  ['severity', 'severity'],
  ['sev', 'severity'],
  ['type', 'type'],
  ['issue type', 'type'],
  ['title', 'title'],
  ['summary', 'title'],
  ['component', 'componentId'],
  ['component id', 'componentId'],
  ['componentid', 'componentId'],
  ['verifier', 'verifier'],
  ['cc', 'cc'],
  ['ccs', 'cc'],
  ['collaborator', 'collaborators'],
  ['collaborators', 'collaborators'],
  ['code change', 'codeChanges'],
  ['code changes', 'codeChanges'],
  ['codechange', 'codeChanges'],
  ['codechanges', 'codeChanges'],
  ['changelist', 'codeChanges'],
  ['changelists', 'codeChanges'],
  ['gerrit change', 'codeChanges'],
  ['gerrit changes', 'codeChanges'],
  ['found in', 'foundIn'],
  ['foundin', 'foundIn'],
  ['found in version', 'foundIn'],
  ['found in versions', 'foundIn'],
  ['targeted to', 'targetedTo'],
  ['targetedto', 'targetedTo'],
  ['targeted to version', 'targetedTo'],
  ['targeted to versions', 'targetedTo'],
  ['verified in', 'verifiedIn'],
  ['verifiedin', 'verifiedIn'],
  ['verified in version', 'verifiedIn'],
  ['verified in versions', 'verifiedIn'],
  ['hotlist', 'hotlists'],
  ['hotlists', 'hotlists'],
  ['hotlist ids', 'hotlists'],
  ['blocked by', 'blockedBy'],
  ['blockedby', 'blockedBy'],
  ['blocking', 'blocking'],
]);

function findCustomFieldOnIssue(issue, rawName) {
  const trimmed = String(rawName ?? '').trim();
  if (/^\d+$/.test(trimmed)) {
    const byId = issue.customFields.find((cf) => cf.id === trimmed);
    if (byId) return byId;
  }
  const exact = issue.customFields.find((cf) => cf.name === trimmed);
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  const ci = issue.customFields.find((cf) => cf.name.toLowerCase() === lower);
  if (ci) return ci;
  const norm = normalizeFieldKey(trimmed);
  const fuzzy = issue.customFields.find((cf) => normalizeFieldKey(cf.name) === norm);
  if (fuzzy) return fuzzy;
  return null;
}

export async function commentIssue(session, input, {
  comment,
  markdown = true,
  dryRun = false,
} = {}) {
  const url = resolveIssueUrl(input);
  const id = extractIssueIdFromUrl(url);
  if (typeof comment !== 'string' || !comment.trim()) {
    throw new Error('Comment text must be a non-empty string.');
  }
  const useMarkdown = markdown !== false;

  if (dryRun) {
    const before = await fetchIssueBasic(session, id);
    return {
      id,
      url,
      title: before.title,
      status: before.status,
      action: 'comment',
      markdown: useMarkdown,
      comment,
      dryRun: true,
    };
  }

  const payload = buildCreateCommentPayload(id, comment, { markdown: useMarkdown });
  const res = await session.buganizerRpc(`/action/issues/${id}/comment`, payload);
  if (!res.ok) {
    throw new Error(`Failed to comment on issue ${id}: ${extractRpcErrorMessage(res.text, res.status)}`);
  }
  invalidateIssueCache(url);

  return {
    id,
    url,
    action: 'comment',
    markdown: useMarkdown,
    comment,
    dryRun: false,
  };
}

export async function editIssue(session, input, {
  assignee,
  status,
  priority,
  severity,
  type,
  title,
  componentId,
  verifier,
  cc,
  addCc,
  removeCc,
  collaborators,
  addCollaborators,
  removeCollaborators,
  codeChanges,
  addCodeChanges,
  removeCodeChanges,
  foundIn,
  addFoundIn,
  removeFoundIn,
  targetedTo,
  addTargetedTo,
  removeTargetedTo,
  verifiedIn,
  addVerifiedIn,
  removeVerifiedIn,
  hotlists,
  addHotlists,
  removeHotlists,
  blockedBy,
  addBlockedBy,
  removeBlockedBy,
  blocking,
  addBlocking,
  removeBlocking,
  fieldOps = [],
  comment,
  markdown = true,
  dryRun = false,
} = {}) {
  const url = resolveIssueUrl(input);
  const id = extractIssueIdFromUrl(url);
  const useMarkdown = markdown !== false;

  let commentText = null;
  if (comment !== undefined && comment !== null && comment !== '') {
    if (typeof comment !== 'string' || !comment.trim()) {
      throw new Error('Comment must not be whitespace-only.');
    }
    commentText = comment;
  }

  const before = await fetchIssueBasic(session, id);
  const sessionEmail = before.userEmail;

  // Fold explicit options + generic `fieldOps` into a unified intent structure.
  let desiredAssigneeSpec = assignee !== undefined
    ? resolveUserSpec(assignee, sessionEmail, 'assignee')
    : { specified: false };
  let desiredVerifierSpec = verifier !== undefined
    ? resolveUserSpec(verifier, sessionEmail, 'verifier')
    : { specified: false };
  let desiredStatus = status !== undefined ? resolveIssueStatus(status) : null;
  let desiredPriority = priority !== undefined ? resolvePriority(priority) : null;
  let desiredSeverity = severity !== undefined ? resolveSeverity(severity) : null;
  let desiredType = type !== undefined ? resolveIssueType(type) : null;
  let desiredTitle = title !== undefined ? String(title) : null;
  let desiredComponentId = componentId !== undefined ? String(componentId).trim() : null;

  const listIntents = {
    cc: {
      set: cc !== undefined ? (isClearScalarToken(cc) ? [] : resolveEmailList(cc, sessionEmail, 'CC')) : undefined,
      add: addCc !== undefined ? resolveEmailList(addCc, sessionEmail, 'CC') : [],
      remove: removeCc !== undefined ? resolveEmailList(removeCc, sessionEmail, 'CC') : [],
      clear: false,
    },
    collaborators: {
      set: collaborators !== undefined
        ? (isClearScalarToken(collaborators) ? [] : resolveEmailList(collaborators, sessionEmail, 'Collaborators'))
        : undefined,
      add: addCollaborators !== undefined ? resolveEmailList(addCollaborators, sessionEmail, 'Collaborators') : [],
      remove: removeCollaborators !== undefined ? resolveEmailList(removeCollaborators, sessionEmail, 'Collaborators') : [],
      clear: false,
    },
    codeChanges: {
      set: codeChanges !== undefined
        ? (isClearScalarToken(codeChanges) ? [] : splitMultiValues(codeChanges).map(parseCodeChangeEntry))
        : undefined,
      add: addCodeChanges !== undefined ? splitMultiValues(addCodeChanges).map(parseCodeChangeEntry) : [],
      remove: removeCodeChanges !== undefined ? splitMultiValues(removeCodeChanges).map(parseCodeChangeEntry) : [],
      clear: false,
    },
    foundIn: {
      set: foundIn !== undefined ? (isClearScalarToken(foundIn) ? [] : splitMultiValues(foundIn).map(String)) : undefined,
      add: addFoundIn !== undefined ? splitMultiValues(addFoundIn).map(String) : [],
      remove: removeFoundIn !== undefined ? splitMultiValues(removeFoundIn).map(String) : [],
      clear: false,
    },
    targetedTo: {
      set: targetedTo !== undefined ? (isClearScalarToken(targetedTo) ? [] : splitMultiValues(targetedTo).map(String)) : undefined,
      add: addTargetedTo !== undefined ? splitMultiValues(addTargetedTo).map(String) : [],
      remove: removeTargetedTo !== undefined ? splitMultiValues(removeTargetedTo).map(String) : [],
      clear: false,
    },
    verifiedIn: {
      set: verifiedIn !== undefined ? (isClearScalarToken(verifiedIn) ? [] : splitMultiValues(verifiedIn).map(String)) : undefined,
      add: addVerifiedIn !== undefined ? splitMultiValues(addVerifiedIn).map(String) : [],
      remove: removeVerifiedIn !== undefined ? splitMultiValues(removeVerifiedIn).map(String) : [],
      clear: false,
    },
    hotlists: {
      set: hotlists !== undefined ? (isClearScalarToken(hotlists) ? [] : resolveNumericIdList(hotlists, 'Hotlists')) : undefined,
      add: addHotlists !== undefined ? resolveNumericIdList(addHotlists, 'Hotlists') : [],
      remove: removeHotlists !== undefined ? resolveNumericIdList(removeHotlists, 'Hotlists') : [],
      clear: false,
    },
    blockedBy: {
      set: blockedBy !== undefined ? (isClearScalarToken(blockedBy) ? [] : resolveNumericIdList(blockedBy, 'Blocked By')) : undefined,
      add: addBlockedBy !== undefined ? resolveNumericIdList(addBlockedBy, 'Blocked By') : [],
      remove: removeBlockedBy !== undefined ? resolveNumericIdList(removeBlockedBy, 'Blocked By') : [],
      clear: false,
    },
    blocking: {
      set: blocking !== undefined ? (isClearScalarToken(blocking) ? [] : resolveNumericIdList(blocking, 'Blocking')) : undefined,
      add: addBlocking !== undefined ? resolveNumericIdList(addBlocking, 'Blocking') : [],
      remove: removeBlocking !== undefined ? resolveNumericIdList(removeBlocking, 'Blocking') : [],
      clear: false,
    },
  };

  // Track per-custom-field operations in order so `--field OS=Linux --add-field OS=Mac` composes cleanly.
  const customFieldStates = new Map();
  const getWorkingCustomValue = (cf) => {
    if (customFieldStates.has(cf.id)) return customFieldStates.get(cf.id);
    return cf.isRepeated
      ? [...(Array.isArray(cf.value) ? cf.value : [])]
      : cf.value;
  };

  for (const rawOp of fieldOps) {
    const fieldName = String(rawOp.name ?? '').trim();
    const op = rawOp.op || 'set';
    const rawVal = rawOp.value;
    if (!fieldName) {
      throw new Error('Field name must not be empty.');
    }

    // Prefer matching a custom field if passed by numeric ID; otherwise check
    // custom fields and standard fields. Note: "Code Changes" is a standard field!
    const normKey = normalizeFieldKey(fieldName);
    const stdKey = /^\d+$/.test(fieldName) ? null : STANDARD_FIELD_ALIASES.get(normKey);
    const cf = stdKey ? null : findCustomFieldOnIssue(before, fieldName);

    if (stdKey) {
      if (stdKey === 'assignee') {
        if (op === 'add' || op === 'remove') {
          throw new Error('"Assignee" is a single-value field; use set or clear.');
        }
        desiredAssigneeSpec = op === 'clear'
          ? { specified: true, clear: true, email: '' }
          : resolveUserSpec(rawVal, sessionEmail, 'assignee');
      } else if (stdKey === 'verifier') {
        if (op === 'add' || op === 'remove') {
          throw new Error('"Verifier" is a single-value field; use set or clear.');
        }
        desiredVerifierSpec = op === 'clear'
          ? { specified: true, clear: true, email: '' }
          : resolveUserSpec(rawVal, sessionEmail, 'verifier');
      } else if (stdKey === 'status') {
        if (op !== 'set') throw new Error('"Status" cannot be cleared or appended; set a valid status.');
        desiredStatus = resolveIssueStatus(rawVal);
      } else if (stdKey === 'priority') {
        if (op !== 'set') throw new Error('"Priority" cannot be cleared or appended; set P0..P4.');
        desiredPriority = resolvePriority(rawVal);
      } else if (stdKey === 'severity') {
        if (op !== 'set') throw new Error('"Severity" cannot be cleared or appended; set S0..S4.');
        desiredSeverity = resolveSeverity(rawVal);
      } else if (stdKey === 'type') {
        if (op !== 'set') throw new Error('"Type" cannot be cleared or appended; set a valid issue type.');
        desiredType = resolveIssueType(rawVal);
      } else if (stdKey === 'title') {
        if (op !== 'set' || !String(rawVal ?? '').trim()) {
          throw new Error('"Title" must be set to a non-empty string.');
        }
        desiredTitle = String(rawVal);
      } else if (stdKey === 'componentId') {
        if (op !== 'set') throw new Error('"Component" cannot be cleared or appended; set a component ID.');
        desiredComponentId = String(rawVal ?? '').trim();
      } else if (stdKey === 'codeChanges') {
        if (op === 'clear' || (op === 'set' && isClearScalarToken(rawVal))) {
          listIntents.codeChanges.clear = true;
          listIntents.codeChanges.set = undefined;
          listIntents.codeChanges.add = [];
          listIntents.codeChanges.remove = [];
        } else if (op === 'set') {
          listIntents.codeChanges.clear = false;
          listIntents.codeChanges.set = splitMultiValues(rawVal).map(parseCodeChangeEntry);
        } else if (op === 'add') {
          listIntents.codeChanges.add.push(...splitMultiValues(rawVal).map(parseCodeChangeEntry));
        } else if (op === 'remove') {
          listIntents.codeChanges.remove.push(...splitMultiValues(rawVal).map(parseCodeChangeEntry));
        }
      } else if (stdKey === 'cc' || stdKey === 'collaborators') {
        const label = stdKey === 'cc' ? 'CC' : 'Collaborators';
        const intent = listIntents[stdKey];
        if (op === 'clear' || (op === 'set' && isClearScalarToken(rawVal))) {
          intent.clear = true;
          intent.set = undefined;
          intent.add = [];
          intent.remove = [];
        } else if (op === 'set') {
          intent.clear = false;
          intent.set = resolveEmailList(rawVal, sessionEmail, label);
        } else if (op === 'add') {
          intent.add.push(...resolveEmailList(rawVal, sessionEmail, label));
        } else if (op === 'remove') {
          intent.remove.push(...resolveEmailList(rawVal, sessionEmail, label));
        }
      } else if (stdKey === 'foundIn' || stdKey === 'targetedTo' || stdKey === 'verifiedIn') {
        const intent = listIntents[stdKey];
        if (op === 'clear' || (op === 'set' && isClearScalarToken(rawVal))) {
          intent.clear = true;
          intent.set = undefined;
          intent.add = [];
          intent.remove = [];
        } else if (op === 'set') {
          intent.clear = false;
          intent.set = splitMultiValues(rawVal).map(String);
        } else if (op === 'add') {
          intent.add.push(...splitMultiValues(rawVal).map(String));
        } else if (op === 'remove') {
          intent.remove.push(...splitMultiValues(rawVal).map(String));
        }
      } else if (stdKey === 'hotlists' || stdKey === 'blockedBy' || stdKey === 'blocking') {
        const intent = listIntents[stdKey];
        if (op === 'clear' || (op === 'set' && isClearScalarToken(rawVal))) {
          intent.clear = true;
          intent.set = undefined;
          intent.add = [];
          intent.remove = [];
        } else if (op === 'set') {
          intent.clear = false;
          intent.set = resolveNumericIdList(rawVal, stdKey);
        } else if (op === 'add') {
          intent.add.push(...resolveNumericIdList(rawVal, stdKey));
        } else if (op === 'remove') {
          intent.remove.push(...resolveNumericIdList(rawVal, stdKey));
        }
      }
      continue;
    }

    if (!cf) {
      const visibleNames = before.customFields
        .filter((f) => f.visible)
        .map((f) => f.name);
      const otherNames = before.customFields
        .filter((f) => !f.visible)
        .map((f) => f.name);
      const hintNames = [...visibleNames, ...otherNames].slice(0, 20);
      throw new Error(
        `Unknown field "${fieldName}" on issue ${id}. ` +
        `Standard fields: Assignee, Status, Priority, Severity, Type, Title, Component, Verifier, CC, Collaborators, Code Changes, Found In, Targeted To, Verified In. ` +
        (hintNames.length ? `Custom fields on this issue: ${hintNames.join(', ')}.` : ''),
      );
    }

    if (cf.isRepeated) {
      let cur = [...getWorkingCustomValue(cf)];
      if (op === 'clear' || (op === 'set' && (Array.isArray(rawVal) ? rawVal.length === 0 : isClearScalarToken(rawVal)))) {
        cur = [];
      } else if (op === 'set') {
        const items = splitMultiValues(rawVal).map((item) => coerceSingleCustomItem(item, cf, sessionEmail));
        cur = [...new Set(items)];
      } else if (op === 'add') {
        const items = splitMultiValues(rawVal).map((item) => coerceSingleCustomItem(item, cf, sessionEmail));
        for (const item of items) {
          if (!cur.includes(item)) cur.push(item);
        }
      } else if (op === 'remove') {
        const items = splitMultiValues(rawVal).map((item) => coerceSingleCustomItem(item, cf, sessionEmail));
        const remSet = new Set(items);
        cur = cur.filter((item) => !remSet.has(item));
      } else {
        throw new Error(`Unsupported field operation "${op}" on "${cf.name}".`);
      }
      customFieldStates.set(cf.id, cur);
    } else {
      if (op === 'add' || op === 'remove') {
        throw new Error(
          `Custom field "${cf.name}" (${cf.id}, type ${cf.type}) is single-valued; ` +
          `use --field "${cf.name}=<value>" or --clear-field "${cf.name}".`,
        );
      }
      if (op === 'clear' || isClearScalarToken(rawVal)) {
        customFieldStates.set(cf.id, null);
      } else {
        customFieldStates.set(cf.id, coerceSingleCustomItem(rawVal, cf, sessionEmail));
      }
    }
  }

  if (desiredTitle !== null && !desiredTitle.trim()) {
    throw new Error('Title must not be empty.');
  }
  if (desiredComponentId !== null && !/^\d+$/.test(desiredComponentId)) {
    throw new Error(`Invalid component ID "${desiredComponentId}" (expected a numeric component ID).`);
  }

  // Reconcile Buganizer's status <-> assignee invariants (matching `eGc` in Buganizer UI).
  let autoStatus = false;
  let autoAssigned = false;

  if (desiredAssigneeSpec.specified && !desiredStatus) {
    if (!desiredAssigneeSpec.clear && before.statusId === 1) {
      desiredStatus = OPEN_STATUS_DEFS.assigned;
      autoStatus = true;
    } else if (desiredAssigneeSpec.clear && (before.statusId === 2 || before.statusId === 3)) {
      desiredStatus = OPEN_STATUS_DEFS.new;
      autoStatus = true;
    }
  }

  if (desiredStatus && !desiredAssigneeSpec.specified) {
    if (STATUS_FORBIDS_ASSIGNEE.has(desiredStatus.statusId) && before.assignee) {
      desiredAssigneeSpec = { specified: true, clear: true, email: '' };
    } else if (
      STATUS_REQUIRES_ASSIGNEE.has(desiredStatus.statusId) &&
      !before.assignee &&
      sessionEmail
    ) {
      desiredAssigneeSpec = { specified: true, clear: false, email: sessionEmail };
      autoAssigned = true;
    }
  }

  // Compute actual diffs against `before` so unchanged fields aren't touched.
  const changes = [];
  const modOpts = { comment: commentText, markdown: useMarkdown };

  if (desiredComponentId !== null && desiredComponentId !== before.componentId) {
    modOpts.componentId = desiredComponentId;
    changes.push({ field: 'Component', before: before.componentId, after: desiredComponentId });
  }
  if (desiredType && desiredType.id !== before.typeId) {
    modOpts.typeId = desiredType.id;
    changes.push({ field: 'Type', before: before.type || null, after: desiredType.label });
  }
  if (desiredStatus && desiredStatus.statusId !== before.statusId) {
    modOpts.statusId = desiredStatus.statusId;
    changes.push({
      field: 'Status',
      before: before.status || null,
      after: desiredStatus.label,
      auto: autoStatus || undefined,
    });
  }
  if (desiredPriority && desiredPriority.id !== before.priorityId) {
    modOpts.priorityId = desiredPriority.id;
    changes.push({ field: 'Priority', before: before.priority || null, after: desiredPriority.label });
  }
  if (desiredSeverity && desiredSeverity.id !== before.severityId) {
    modOpts.severityId = desiredSeverity.id;
    changes.push({ field: 'Severity', before: before.severity || null, after: desiredSeverity.label });
  }
  if (desiredTitle !== null && desiredTitle !== before.title) {
    modOpts.title = desiredTitle;
    changes.push({ field: 'Title', before: before.title, after: desiredTitle });
  }
  if (desiredAssigneeSpec.specified) {
    if (desiredAssigneeSpec.clear && before.assignee) {
      modOpts.clearAssignee = true;
      changes.push({ field: 'Assignee', before: before.assignee, after: null });
    } else if (!desiredAssigneeSpec.clear && desiredAssigneeSpec.email !== before.assignee) {
      modOpts.assignee = desiredAssigneeSpec.email;
      changes.push({
        field: 'Assignee',
        before: before.assignee || null,
        after: desiredAssigneeSpec.email,
        auto: autoAssigned || undefined,
      });
    }
  }
  if (desiredVerifierSpec.specified) {
    if (desiredVerifierSpec.clear && before.verifier) {
      modOpts.clearVerifier = true;
      changes.push({ field: 'Verifier', before: before.verifier, after: null });
    } else if (!desiredVerifierSpec.clear && desiredVerifierSpec.email !== before.verifier) {
      modOpts.verifier = desiredVerifierSpec.email;
      changes.push({ field: 'Verifier', before: before.verifier || null, after: desiredVerifierSpec.email });
    }
  }

  // Repeated standard list fields (except Code Changes, handled below).
  const simpleListConfigs = [
    ['cc', 'CC', before.ccs, 'addCcs', 'removeCcs'],
    ['collaborators', 'Collaborators', before.collaborators, 'addCollaborators', 'removeCollaborators'],
    ['foundIn', 'Found In', before.foundInVersions, 'addFoundIn', 'removeFoundIn'],
    ['targetedTo', 'Targeted To', before.targetedToVersions, 'addTargetedTo', 'removeTargetedTo'],
    ['verifiedIn', 'Verified In', before.verifiedInVersions, 'addVerifiedIn', 'removeVerifiedIn'],
    ['hotlists', 'Hotlists', before.hotlistIds, 'addHotlistIds', 'removeHotlistIds'],
    ['blockedBy', 'Blocked By', before.blockedByIssueIds, 'addBlockedByIds', 'removeBlockedByIds'],
    ['blocking', 'Blocking', before.blockingIssueIds, 'addBlockingIds', 'removeBlockingIds'],
  ];
  for (const [key, label, currentVals, addProp, removeProp] of simpleListConfigs) {
    const intent = listIntents[key];
    if (!intent.clear && intent.set === undefined && !intent.add.length && !intent.remove.length) {
      continue;
    }
    const { next, added, removed } = applyListOperation(currentVals, intent);
    if (added.length || removed.length) {
      if (added.length) modOpts[addProp] = added;
      if (removed.length) modOpts[removeProp] = removed;
      changes.push({ field: label, before: currentVals, after: next });
    }
  }

  // Code Changes (`code_changes` Critique CLs + `gerrit_changes` Gerrit CLs).
  const ccIntent = listIntents.codeChanges;
  if (ccIntent.clear || ccIntent.set !== undefined || ccIntent.add.length || ccIntent.remove.length) {
    const existingChangelists = before.changelists;
    const existingMergedGerrit = before.gerritChanges.filter((g) => g.stateId !== 1);
    const gerritKey = (g) => `${g.host.toLowerCase()},${g.repo},${Number(g.changeNumber)}`;

    let nextChangelists;
    let nextGerritMap;
    if (ccIntent.clear) {
      nextChangelists = [];
      nextGerritMap = new Map();
    } else if (ccIntent.set !== undefined) {
      nextChangelists = [];
      nextGerritMap = new Map();
      for (const entry of ccIntent.set) {
        if (entry.kind === 'changelist') {
          if (!nextChangelists.includes(entry.changeNumber)) nextChangelists.push(entry.changeNumber);
        } else {
          const k = gerritKey(entry);
          const existing = existingMergedGerrit.find((g) => gerritKey(g) === k);
          nextGerritMap.set(k, existing || entry);
        }
      }
    } else {
      nextChangelists = [...existingChangelists];
      nextGerritMap = new Map(existingMergedGerrit.map((g) => [gerritKey(g), g]));
    }

    for (const entry of ccIntent.add) {
      if (entry.kind === 'changelist') {
        if (!nextChangelists.includes(entry.changeNumber)) nextChangelists.push(entry.changeNumber);
      } else {
        const k = gerritKey(entry);
        if (!nextGerritMap.has(k)) nextGerritMap.set(k, entry);
      }
    }
    for (const entry of ccIntent.remove) {
      if (entry.kind === 'changelist') {
        nextChangelists = nextChangelists.filter((cl) => cl !== entry.changeNumber);
      } else {
        nextGerritMap.delete(gerritKey(entry));
      }
    }

    const clDelta = computeSetDelta(existingChangelists, nextChangelists);
    const existingGerritKeys = new Set(existingMergedGerrit.map(gerritKey));
    const addedGerrit = [...nextGerritMap.entries()]
      .filter(([k]) => !existingGerritKeys.has(k))
      .map(([, g]) => g);
    const removedGerrit = existingMergedGerrit.filter((g) => !nextGerritMap.has(gerritKey(g)));

    if (clDelta.added.length || clDelta.removed.length || addedGerrit.length || removedGerrit.length) {
      if (clDelta.added.length) modOpts.addCodeChanges = clDelta.added;
      if (clDelta.removed.length) modOpts.removeCodeChanges = clDelta.removed;
      if (addedGerrit.length) modOpts.addGerritChanges = addedGerrit;
      if (removedGerrit.length) modOpts.removeGerritChanges = removedGerrit;
      const afterDisplay = [
        ...nextChangelists,
        ...[...nextGerritMap.values()].map((g) => g.url || g.display || formatGerritChangeUrl(g)),
      ];
      changes.push({ field: 'Code Changes', before: before.codeChanges, after: afterDisplay });
    }
  }

  // Custom fields (`custom_fields` in stateAdd for non-empty values, stateRemove for clearing).
  const addCustomFields = [];
  const removeCustomFields = [];
  for (const [cfId, nextVal] of customFieldStates.entries()) {
    const cf = before.customFields.find((f) => f.id === cfId);
    const prevVal = cf.isRepeated
      ? (Array.isArray(cf.value) ? cf.value : [])
      : cf.value;
    const unchanged = cf.isRepeated
      ? (prevVal.length === nextVal.length && prevVal.every((v, idx) => v === nextVal[idx]))
      : prevVal === nextVal;
    if (unchanged) continue;

    const isClearing = cf.isRepeated ? nextVal.length === 0 : nextVal === null;
    if (isClearing) {
      removeCustomFields.push(buildCustomFieldClearJspb(cfId));
    } else {
      addCustomFields.push(buildCustomFieldValueJspb(cfId, cf.type, nextVal));
    }
    changes.push({
      field: cf.name,
      customFieldId: cf.id,
      before: prevVal,
      after: nextVal,
    });
  }
  if (addCustomFields.length) modOpts.addCustomFields = addCustomFields;
  if (removeCustomFields.length) modOpts.removeCustomFields = removeCustomFields;

  const hasListDelta = (v) =>
    v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== '');

  const hasAnyRequestedMutation =
    assignee !== undefined ||
    status !== undefined ||
    priority !== undefined ||
    severity !== undefined ||
    type !== undefined ||
    title !== undefined ||
    componentId !== undefined ||
    verifier !== undefined ||
    cc !== undefined || hasListDelta(addCc) || hasListDelta(removeCc) ||
    collaborators !== undefined || hasListDelta(addCollaborators) || hasListDelta(removeCollaborators) ||
    codeChanges !== undefined || hasListDelta(addCodeChanges) || hasListDelta(removeCodeChanges) ||
    foundIn !== undefined || hasListDelta(addFoundIn) || hasListDelta(removeFoundIn) ||
    targetedTo !== undefined || hasListDelta(addTargetedTo) || hasListDelta(removeTargetedTo) ||
    verifiedIn !== undefined || hasListDelta(addVerifiedIn) || hasListDelta(removeVerifiedIn) ||
    hotlists !== undefined || hasListDelta(addHotlists) || hasListDelta(removeHotlists) ||
    blockedBy !== undefined || hasListDelta(addBlockedBy) || hasListDelta(removeBlockedBy) ||
    blocking !== undefined || hasListDelta(addBlocking) || hasListDelta(removeBlocking) ||
    fieldOps.length > 0 ||
    commentText !== null;

  if (!hasAnyRequestedMutation) {
    throw new Error('No field updates or comment specified.');
  }

  const noOp = changes.length === 0 && !commentText;
  const useMarkAsVulnerability = Boolean(
    desiredType &&
    desiredType.id === 6 &&
    before.typeId !== 6 &&
    before.trackerId === CHROMIUM_TRACKER_ID,
  );

  if (dryRun || noOp) {
    return {
      id,
      url,
      title: desiredTitle ?? before.title,
      type: desiredType?.label || before.type,
      status: desiredStatus?.label || before.status,
      priority: desiredPriority?.label || before.priority,
      severity: desiredSeverity?.label || before.severity,
      assignee: desiredAssigneeSpec.specified
        ? (desiredAssigneeSpec.clear ? null : desiredAssigneeSpec.email)
        : (before.assignee || null),
      changes,
      comment: commentText,
      markdown: commentText ? useMarkdown : undefined,
      noOp,
      action: 'edit',
      dryRun: !!dryRun,
    };
  }

  // If only a comment was provided (all field values already matched), post via /comment.
  let updated = null;
  if (changes.length === 0 && commentText) {
    const commentPayload = buildCreateCommentPayload(id, commentText, { markdown: useMarkdown });
    const commentRes = await session.buganizerRpc(`/action/issues/${id}/comment`, commentPayload);
    if (!commentRes.ok) {
      throw new Error(
        `Failed to comment on issue ${id}: ${extractRpcErrorMessage(commentRes.text, commentRes.status)}`,
      );
    }
    invalidateIssueCache(url);
  } else if (useMarkAsVulnerability) {
    // Mirrors Buganizer UI (`LHc` / `markAsVulnerability` on Chromium tracker 157):
    // promotes to Vulnerability, applies security view restriction, and adds
    // security@chromium.org to Collaborators.
    const vulnPayload = buildMarkAsVulnerabilityPayload(id, CHROMIUM_VULNERABILITY_COLLABORATORS);
    const vulnRes = await session.buganizerRpc(
      `/action/issues/${id}/markAsVulnerability`,
      vulnPayload,
    );
    if (!vulnRes.ok) {
      throw new Error(
        `Failed to mark issue ${id} as Vulnerability: ` +
        extractRpcErrorMessage(vulnRes.text, vulnRes.status),
      );
    }
    updated = parseIssueFetchResponse(vulnRes.text, id);
    invalidateIssueCache(url);

    const { typeId: _omitType, ...restModOpts } = modOpts;
    const hasRemainingChanges = changes.some((ch) => ch.field !== 'Type');
    if (hasRemainingChanges) {
      const payload = buildModifyIssuePayload(id, restModOpts);
      const modRes = await session.buganizerRpc(`/action/issues/${id}`, payload);
      if (!modRes.ok) {
        throw new Error(
          `Marked issue ${id} as Vulnerability, but follow-up update failed: ` +
          extractRpcErrorMessage(modRes.text, modRes.status),
        );
      }
      updated = parseIssueFetchResponse(modRes.text, id) || updated;
      invalidateIssueCache(url);
    } else if (commentText) {
      const commentPayload = buildCreateCommentPayload(id, commentText, { markdown: useMarkdown });
      const commentRes = await session.buganizerRpc(`/action/issues/${id}/comment`, commentPayload);
      if (!commentRes.ok) {
        throw new Error(
          `Marked issue ${id} as Vulnerability, but posting comment failed: ` +
          extractRpcErrorMessage(commentRes.text, commentRes.status),
        );
      }
      invalidateIssueCache(url);
    }
  } else {
    const payload = buildModifyIssuePayload(id, modOpts);
    const modRes = await session.buganizerRpc(`/action/issues/${id}`, payload);
    if (!modRes.ok) {
      throw new Error(
        `Failed to update issue ${id}: ${extractRpcErrorMessage(modRes.text, modRes.status)}`,
      );
    }
    updated = parseIssueFetchResponse(modRes.text, id);
    invalidateIssueCache(url);
  }

  return {
    id,
    url,
    title: updated?.title || desiredTitle || before.title,
    type: updated?.type || desiredType?.label || before.type,
    status: updated?.status || desiredStatus?.label || before.status,
    priority: updated?.priority || desiredPriority?.label || before.priority,
    severity: updated?.severity || desiredSeverity?.label || before.severity,
    assignee: updated
      ? (updated.assignee || null)
      : (desiredAssigneeSpec.specified
          ? (desiredAssigneeSpec.clear ? null : desiredAssigneeSpec.email)
          : (before.assignee || null)),
    changes,
    comment: commentText,
    markdown: commentText ? useMarkdown : undefined,
    noOp: false,
    action: 'edit',
    dryRun: false,
  };
}

export async function assignIssue(session, input, {
  assignee,
  comment,
  markdown = true,
  dryRun = false,
} = {}) {
  const res = await editIssue(session, input, {
    assignee,
    comment,
    markdown,
    dryRun,
  });
  return { ...res, action: 'assign' };
}

export async function closeIssue(session, input, {
  status,
  duplicateOf,
  comment,
  markdown = true,
  assignee,
  dryRun = false,
} = {}) {
  const url = resolveIssueUrl(input);
  const id = extractIssueIdFromUrl(url);
  const resolved = resolveCloseStatus(status, duplicateOf);
  const useMarkdown = markdown !== false;

  let commentText = null;
  if (comment !== undefined && comment !== null && comment !== '') {
    if (typeof comment !== 'string' || !comment.trim()) {
      throw new Error('Closing comment must not be whitespace-only.');
    }
    commentText = comment;
  }

  let duplicateOfId = null;
  let duplicateOfUrl = null;
  if (resolved.key === 'duplicate') {
    duplicateOfUrl = resolveIssueUrl(String(duplicateOf).trim());
    duplicateOfId = extractIssueIdFromUrl(duplicateOfUrl);
    if (duplicateOfId === id) {
      throw new Error(`Issue ${id} cannot be marked as a duplicate of itself.`);
    }
  }

  const before = await fetchIssueBasic(session, id);
  let targetIssue = null;
  if (duplicateOfId) {
    targetIssue = await fetchIssueBasic(session, duplicateOfId);
  }

  let assigneeToSet = normalizeAssigneeInput(assignee, before.userEmail);
  let autoAssigned = false;
  if (
    !assigneeToSet &&
    (resolved.statusId === 4 || resolved.statusId === 5) &&
    !before.assignee &&
    before.userEmail
  ) {
    assigneeToSet = before.userEmail;
    autoAssigned = true;
  }

  if (dryRun) {
    return {
      id,
      url,
      title: before.title,
      previousStatus: before.status,
      status: resolved.label,
      statusKey: resolved.key,
      duplicateOf: duplicateOfId,
      duplicateOfUrl,
      duplicateOfTitle: targetIssue?.title || null,
      assignee: assigneeToSet || before.assignee || null,
      autoAssigned,
      comment: commentText,
      markdown: commentText ? useMarkdown : undefined,
      action: 'close',
      dryRun: true,
    };
  }

  let updated = null;
  if (resolved.key === 'duplicate') {
    const dupRes = await session.buganizerRpc(
      `/action/issues/${id}/mark_as_duplicate`,
      [Number(id), Number(duplicateOfId)],
    );
    if (!dupRes.ok) {
      throw new Error(
        `Failed to mark issue ${id} as duplicate of ${duplicateOfId}: ` +
        extractRpcErrorMessage(dupRes.text, dupRes.status),
      );
    }
    updated = parseIssueFetchResponse(dupRes.text, id);
    invalidateIssueCache(url);

    if (assigneeToSet) {
      const modPayload = buildModifyIssuePayload(id, {
        assignee: assigneeToSet,
        comment: commentText,
        markdown: useMarkdown,
      });
      const modRes = await session.buganizerRpc(`/action/issues/${id}`, modPayload);
      if (!modRes.ok) {
        throw new Error(
          `Marked issue ${id} as duplicate of ${duplicateOfId}, but follow-up update failed: ` +
          extractRpcErrorMessage(modRes.text, modRes.status),
        );
      }
      updated = parseIssueFetchResponse(modRes.text, id) || updated;
      invalidateIssueCache(url);
    } else if (commentText) {
      const commentPayload = buildCreateCommentPayload(id, commentText, { markdown: useMarkdown });
      const commentRes = await session.buganizerRpc(`/action/issues/${id}/comment`, commentPayload);
      if (!commentRes.ok) {
        throw new Error(
          `Marked issue ${id} as duplicate of ${duplicateOfId}, but posting comment failed: ` +
          extractRpcErrorMessage(commentRes.text, commentRes.status),
        );
      }
      invalidateIssueCache(url);
    }
  } else {
    const modPayload = buildModifyIssuePayload(id, {
      statusId: resolved.statusId,
      assignee: assigneeToSet,
      comment: commentText,
      markdown: useMarkdown,
    });
    const modRes = await session.buganizerRpc(`/action/issues/${id}`, modPayload);
    if (!modRes.ok) {
      throw new Error(
        `Failed to close issue ${id} as ${resolved.label}: ` +
        extractRpcErrorMessage(modRes.text, modRes.status),
      );
    }
    updated = parseIssueFetchResponse(modRes.text, id);
    invalidateIssueCache(url);
  }

  const finalStatus = updated?.statusId && updated.statusId !== resolved.statusId
    ? (updated.status || resolved.label)
    : resolved.label;

  return {
    id,
    url,
    title: updated?.title || before.title,
    previousStatus: before.status,
    status: finalStatus,
    statusKey: resolved.key,
    duplicateOf: duplicateOfId,
    duplicateOfUrl,
    duplicateOfTitle: targetIssue?.title || null,
    assignee: updated?.assignee || assigneeToSet || before.assignee || null,
    autoAssigned,
    comment: commentText,
    markdown: commentText ? useMarkdown : undefined,
    action: 'close',
    dryRun: false,
  };
}
