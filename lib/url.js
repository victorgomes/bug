// URL normalization for Buganizer issues and ClusterFuzz testcases.

export const ISSUE_HOSTS = new Set([
  'b.corp.google.com',
  'crbug.com',
  'issues.chromium.org',
  'issuetracker.google.com',
]);
export const CLUSTERFUZZ_HOST = 'clusterfuzz.com';

function parseHttpUrl(input, kind) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Cannot interpret as ${kind}: ${input}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Only https URLs are supported for ${kind}: ${input}`);
  }
  return url;
}

export function isIssueUrl(url) {
  return url.protocol === 'https:' && ISSUE_HOSTS.has(url.hostname);
}

export function canonicalIssueUrl(id) {
  return `https://issuetracker.google.com/issues/${id}`;
}

export function extractIssueIdFromPath(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(parts[i])) return parts[i];
  }
  return null;
}

export function extractIssueIdFromUrl(url) {
  return url.match(/\/(\d+)(?:[?#]|$)/)?.[1] ?? null;
}

export function resolveIssueUrl(input) {
  if (/^\d+$/.test(input)) return canonicalIssueUrl(input);
  if (/^b\/\d+$/.test(input)) return canonicalIssueUrl(input.slice(2));
  if (/^https?:\/\//.test(input)) {
    const url = parseHttpUrl(input, 'issue URL');
    if (!isIssueUrl(url)) {
      throw new Error(`Unsupported issue host: ${url.hostname}`);
    }
    const id = extractIssueIdFromPath(url);
    if (!id) throw new Error(`Cannot find issue id in url: ${input}`);
    return canonicalIssueUrl(id);
  }
  throw new Error(`Cannot interpret as issue id or url: ${input}`);
}

export function resolveTestcaseKey(input) {
  if (/^\d+$/.test(input)) return input;
  const url = parseHttpUrl(input, 'clusterfuzz testcase URL');
  if (url.hostname !== CLUSTERFUZZ_HOST) {
    throw new Error(`Unsupported ClusterFuzz host: ${url.hostname}`);
  }
  const key = url.pathname.match(/^\/testcase-detail\/(\d+)\/?$/)?.[1] ??
    url.searchParams.get('key') ?? url.searchParams.get('testcase_id');
  if (key && /^\d+$/.test(key)) return key;
  throw new Error(`Cannot interpret as clusterfuzz testcase key or url: ${input}`);
}

// Distinguish "this is a testcase key" from "this is an issue id" for bare
// numeric inputs. Testcase keys are 14+ digits; Buganizer ids are 9-13.
export function resolveCfTarget(input) {
  if (/^https?:\/\//.test(input)) {
    const url = parseHttpUrl(input, 'clusterfuzz target URL');
    if (url.hostname === CLUSTERFUZZ_HOST) {
      return { kind: 'testcase', key: resolveTestcaseKey(input) };
    }
    if (isIssueUrl(url)) {
      return { kind: 'issue', issue: resolveIssueUrl(input) };
    }
    throw new Error(`Unsupported ClusterFuzz target host: ${url.hostname}`);
  }
  if (/^b\/\d+$/.test(input)) {
    return { kind: 'issue', issue: input.slice(2) };
  }
  if (/^\d+$/.test(input)) {
    if (input.length >= 14) return { kind: 'testcase', key: input };
    return { kind: 'issue', issue: input };
  }
  throw new Error(`Cannot interpret cf target: ${input}`);
}

export function testcasePageUrl(key) {
  return `https://clusterfuzz.com/testcase-detail/${key}`;
}

export function testcaseDownloadUrl(key, { blob } = {}) {
  const path = blob ? `/download/${encodeURIComponent(blob)}` : '/download';
  return `https://clusterfuzz.com${path}?testcase_id=${key}`;
}

export function searchUrl(query) {
  return `https://issuetracker.google.com/issues?q=${encodeURIComponent(query)}`;
}

// Match attachment links in any of the URL shapes we've seen.
export const ATTACHMENT_URL_RE =
  /\/(?:action\/)?issues\/\d+\/(?:attachments|files)\//;
