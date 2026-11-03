// Persistent Playwright session for fetching authenticated pages.
//
// Designed for multi-target reuse: one Session instance owns one Chromium
// launch and can fetch many pages. Use openSession() in a try/finally so the
// browser is closed even on error.
//
// Markdown extraction pipeline:
//   1. In-page: pageToFlatHtml() walks the rendered DOM, projects slots, and
//      emits HTML mirroring what the browser paints.
//   2. In Node: Turndown converts that HTML to markdown with GFM tables.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import TurndownService from 'turndown';
import gfm from '@joplin/turndown-plugin-gfm';

import { clearCache } from './cache.js';
import { pageToFlatHtml } from './dom.js';

export const PROFILE_DIR = join(homedir(), '.config', 'bnz', 'profile');
export const AUTH_INVALID_PATH = join(homedir(), '.config', 'bnz', 'auth-invalid.json');

// Iterate a NodeList safely — domino (Turndown's HTML parser in Node) returns
// a NodeList without a Symbol.iterator, so `for...of` blows up.
function qsa(node, selector) {
  const out = [];
  const list = node.querySelectorAll(selector);
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
    linkStyle: 'inlined',
  });
  td.use(gfm.gfm);
  // Polymer pages are riddled with empty <a> elements (icon-only buttons with
  // no visible text). Drop links whose visible text is empty so Turndown
  // doesn't emit bare "[](url)" noise.
  td.addRule('drop-empty-anchors', {
    filter: (node) =>
      node.nodeName === 'A' &&
      !(node.textContent || '').trim() &&
      !node.querySelector('img'),
    replacement: () => '',
  });
  // Counter pills and other inline links nest blocks (e.g. <a><span>Label</span><span>(N)</span></a>),
  // which Turndown renders as multi-line link text. Collapse so they fit on one line.
  td.addRule('flatten-inline-links', {
    filter: (node) =>
      node.nodeName === 'A' &&
      (node.textContent || '').trim() &&
      !node.querySelector('img, pre'),
    replacement: (content, node) => {
      const href = node.getAttribute('href') || '';
      const flat = content.replace(/\s+/g, ' ').trim();
      if (!flat) return '';
      if (!href || href === '#') return flat;
      return '[' + flat + '](' + href + ')';
    },
  });
  // Decorative images (empty alt) carry no information for a markdown reader.
  // Drop avatar placeholders, status icons, etc.
  td.addRule('drop-decorative-images', {
    filter: (node) =>
      node.nodeName === 'IMG' && !(node.getAttribute('alt') || '').trim(),
    replacement: () => '',
  });
  // Buganizer renders one per-field-change event for each field set when the
  // bug was created, each prefixed with a redundant time-of-day stamp like
  // "07:13". The main comment header still carries the full timestamp.
  td.addRule('drop-time-only-stamps', {
    filter: (node) =>
      (node.nodeName === 'TIME' || node.nodeName === 'B-FORMATTED-DATE-TIME') &&
      /^\d{1,2}:\d{2}\s*(?:[ap]m)?$/i.test((node.textContent || '').trim()),
    replacement: () => '',
  });
  // Other <b-formatted-date-time> stamps (full timestamps) sit immediately
  // after the comment-number link in the DOM with no whitespace between, so
  // Turndown emits "[#2](url)2026-05-15 04:27". Pad with leading whitespace.
  td.addRule('space-formatted-date-time', {
    filter: 'b-formatted-date-time',
    replacement: (content) => content ? ' ' + content : '',
  });
  // The page renders an <h2>Issue <id></h2> at the top of issue-details-wrapper
  // that duplicates our synthesized "# Issue <id>" header.
  td.addRule('drop-redundant-issue-h2', {
    filter: (node) =>
      node.nodeName === 'H2' &&
      /^\s*Issue\s+\d+\s*$/.test((node.textContent || '').trim()),
    replacement: () => '',
  });
  // Attachments inside comments: filename + size + View/Download links flow
  // into one paragraph by default. Reshape as a single bullet per file.
  td.addRule('attachment-viewer', {
    filter: 'b-attachment-viewer',
    replacement: (content, node) => {
      // Walk descendant divs and read their first text-node child. The first
      // non-empty one is the filename; the first that looks like a file size
      // is the size. Anything else (action labels, link captions) ignored.
      let filename = '';
      let size = '';
      for (const d of qsa(node, 'div')) {
        const first = d.firstChild;
        if (!first || first.nodeType !== 3) continue;
        const t = (first.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (!size && /^\d+(?:\.\d+)?\s*[KMG]?B$/.test(t)) { size = t; continue; }
        if (!filename) filename = t;
      }
      const links = [];
      for (const a of qsa(node, 'a[href]')) {
        const href = a.getAttribute('href') || '';
        const label = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!href || !label) continue;
        if (/\/attachments\/\d+/.test(href)) links.push('[' + label + '](' + href + ')');
      }
      const parts = ['**' + (filename || 'attachment') + '**'];
      if (size) parts.push(size);
      if (links.length) parts.push(links.join(' '));
      return '\n- ' + parts.join(' — ') + '\n';
    },
  });
  // Drop common Buganizer action buttons whose text is a known verb. The
  // sidebar's user pickers are wrapped in <button> too, but their text is the
  // user's email — those don't match and are kept.
  const BUTTON_ACTION_TEXTS = new Set([
    'Edit', 'Add', 'Add me', 'Add Hotlist', 'CC me', 'Start work',
    'Expanded Access', 'Mark as Duplicate', 'Sign in',
    'Sign in with Google', 'Sign in with GitHub', 'Skip Navigation',
    'Hide all',
  ]);
  td.addRule('drop-action-buttons', {
    filter: (node) => {
      if (node.nodeName !== 'BUTTON') return false;
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (BUTTON_ACTION_TEXTS.has(txt)) return true;
      const a = node.getAttribute('aria-label') || '';
      if (a === 'collapsible panel') return true;
      return /^(?:Remove|Add) .* (?:from|to) /.test(a) ||
        /^Add item to /.test(a);
    },
    replacement: () => '',
  });
  // Drop action-only divs/spans in the sidebar (aria-labels like "Edit",
  // "Add me", "Show all 6 Chromium Labels items", "Add yourself to ...").
  td.addRule('drop-action-elements', {
    filter: (node) => {
      if (node.nodeName !== 'DIV' && node.nodeName !== 'SPAN') return false;
      const a = node.getAttribute('aria-label') || '';
      if (a) {
        if (BUTTON_ACTION_TEXTS.has(a)) return true;
        if (/^Show all \d+/.test(a) || /^Add yourself/.test(a)) return true;
      }
      // Bare action-verb spans (e.g. "Expanded Access" widget).
      if (node.nodeName === 'SPAN' && !a) {
        const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (BUTTON_ACTION_TEXTS.has(txt)) return true;
      }
      return false;
    },
    replacement: () => '',
  });
  // Sidebar fields with a structured aria-label ("Foo value is Bar",
  // "Foo is empty", "Foo has N items"). Compact each to a single bullet.
  // Skip empty sidebar fields in focused mode — they dominate the bullet list
  // for issues with most fields unset. The full-mode dump keeps everything.
  const fieldLine = (label, value) => {
    if (!label) return '';
    if (!value || value === '—' || value === '--') return '';
    return '\n- **' + label + '**: ' + value + '\n';
  };
  td.addRule('compact-sidebar-aria', {
    filter: (node) =>
      (node.nodeName === 'B-EDIT-FIELD' || node.nodeName === 'B-LIST-FIELD') &&
      node.querySelector('div[aria-label]'),
    replacement: (content, node) => {
      const wrap = node.querySelector('div[aria-label]');
      const a = wrap ? wrap.getAttribute('aria-label') || '' : '';
      let m;
      if (a.match(/^(.+?)\s+(?:value\s+)?is\s+empty$/)) return '';
      if ((m = a.match(/^(.+?)\s+value\s+is\s+(.+)$/))) {
        return fieldLine(m[1].trim(), m[2].trim());
      }
      if ((m = a.match(/^(.+?)\s+has\s+\d+\s+items?$/))) {
        const labelEl = node.querySelector('label');
        const labelTxt = labelEl ? (labelEl.textContent || '').trim() : m[1].trim();
        const items = [];
        for (const e of qsa(node, 'b-truncated-span, a[href]')) {
          const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !items.includes(t)) items.push(t);
        }
        return fieldLine(labelTxt, items.join(', '));
      }
      return content;
    },
  });
  // Stray onedev-edit-field (e.g. Story points) not wrapped in a b-*-control.
  td.addRule('compact-onedev-edit-field', {
    filter: 'onedev-edit-field',
    replacement: (content, node) => {
      const labelEl = node.querySelector('onedev-field-label, label');
      const label = labelEl ? (labelEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const valueEl = node.querySelector('onedev-field-value');
      const value = valueEl ? (valueEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return fieldLine(label, value);
    },
  });
  // Comment events with no user-written body (system-generated field-change
  // events) leave behind an empty author header. Drop those entirely; events
  // with real text bodies live in <b-formatted-comment-presenter>.
  td.addRule('drop-empty-history-events', {
    filter: (node) =>
      node.nodeName === 'B-HISTORY-EVENT' &&
      !node.querySelector('b-formatted-comment-presenter'),
    replacement: () => '',
  });
  // User picker sidebar fields (Reporter / Assignee / Verifier / CC /
  // Collaborators). No aria-label of the field pattern — extract from DOM.
  td.addRule('compact-user-field', {
    filter: (node) =>
      node.nodeName === 'B-SINGLE-USER-CONTROL' ||
      node.nodeName === 'B-MULTI-USER-CONTROL',
    replacement: (content, node) => {
      const labelEl = node.querySelector('onedev-field-label, label');
      const label = labelEl ? (labelEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const users = [];
      for (const e of qsa(node, 'b-user-membership-chip, b-person-hovercard')) {
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && !users.includes(t)) users.push(t);
      }
      return fieldLine(label, users.join(', '));
    },
  });
  return td;
}

const turndown = makeTurndown();

// After Turndown runs, anything inside the "### Issue metadata" section that
// isn't a bullet is by definition an unrecognized sidebar field — its label
// and value rendered as separate lines because no compaction rule matched.
// In focused mode we'd rather drop them than show a multi-line stub.
function compactSidebarTail(markdown) {
  const marker = '### Issue metadata';
  const idx = markdown.indexOf(marker);
  if (idx === -1) return markdown;
  const before = markdown.slice(0, idx + marker.length);
  const after = markdown.slice(idx + marker.length);
  const cleaned = after
    .split('\n')
    .filter((line) => line.startsWith('- ') || line.trim() === '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return before + '\n' + cleaned.replace(/^\n+/, '\n');
}

export class AuthRequiredError extends Error {
  constructor(url, reason = 'redirected to accounts.google.com') {
    super(`Not logged in (${reason} when fetching ${url}). ` +
      `Run \`bnz login\` (issuetracker) or \`bnz cf login\` (clusterfuzz).`);
    this.name = 'AuthRequiredError';
  }
}

const BUGANIZER_HOSTS = new Set([
  'issuetracker.google.com',
  'issues.chromium.org',
  'b.corp.google.com',
]);

function isBuganizerUrl(rawUrl) {
  try {
    return BUGANIZER_HOSTS.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

export function serviceForUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'clusterfuzz.com' || host.endsWith('.clusterfuzz.com')) return 'cf';
  } catch {}
  return 'bugs';
}

export function readAuthInvalid(markerPath = AUTH_INVALID_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAuthInvalid(data, markerPath = AUTH_INVALID_PATH) {
  try {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      rmSync(markerPath, { force: true });
      return;
    }
    const dir = dirname(markerPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.auth-invalid-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmpPath, markerPath);
  } catch {}
}

export function markAuthInvalid(service, {
  url = '',
  reason = 'redirected to accounts.google.com',
  markerPath = AUTH_INVALID_PATH,
} = {}) {
  if (service !== 'bugs' && service !== 'cf') return;
  const cur = readAuthInvalid(markerPath);
  cur[service] = {
    at: Math.floor(Date.now() / 1000),
    reason: String(reason || ''),
    url: String(url || ''),
  };
  writeAuthInvalid(cur, markerPath);
}

export function clearAuthInvalid(services, { markerPath = AUTH_INVALID_PATH } = {}) {
  const list = Array.isArray(services) ? services : [services];
  const cur = readAuthInvalid(markerPath);
  let changed = false;
  for (const s of list) {
    if (s in cur) {
      delete cur[s];
      changed = true;
    }
  }
  if (changed) writeAuthInvalid(cur, markerPath);
}

export function isAnonymousBuganizerSession(raw) {
  if (!Array.isArray(raw)) return false;
  const xsrf = typeof raw[2] === 'string' ? raw[2] : '';
  let email = '';
  let isAnon = false;
  try {
    const userEntry = JSON.parse(JSON.stringify(raw[0]));
    if (Array.isArray(userEntry)) {
      if (typeof userEntry[0] === 'string') email = userEntry[0];
      if (userEntry[3] === true || userEntry[3] === 1 || userEntry[4] === 'ANONYMOUS') {
        isAnon = true;
      }
    }
  } catch {}
  return isAnon || !email || !xsrf;
}

export async function openSession({
  headless = true,
  profileDir = PROFILE_DIR,
  authMarkerPath,
} = {}) {
  const markerPath = authMarkerPath !== undefined
    ? authMarkerPath
    : (profileDir === PROFILE_DIR ? AUTH_INVALID_PATH : null);

  const authError = (url, reason = 'redirected to accounts.google.com') => {
    if (markerPath) {
      markAuthInvalid(serviceForUrl(url), { url, reason, markerPath });
    }
    return new AuthRequiredError(url, reason);
  };

  mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
  });
  let page = ctx.pages()[0] || await ctx.newPage();

  async function checkBuganizerAuth(requestedUrl) {
    if (!isBuganizerUrl(page.url())) return;
    await page.waitForFunction(
      () => Array.isArray(window.buganizerSessionJspb),
      null,
      { timeout: 5_000 },
    ).catch(() => {});
    if (/accounts\.google\.com/.test(page.url())) {
      throw authError(requestedUrl);
    }
    const authState = await page.evaluate(() => {
      const raw = window.buganizerSessionJspb;
      if (!Array.isArray(raw)) return { hasJspb: false, isAnon: false };
      const xsrf = typeof raw[2] === 'string' ? raw[2] : '';
      let email = '';
      let anon = false;
      try {
        const userEntry = JSON.parse(JSON.stringify(raw[0]));
        if (Array.isArray(userEntry)) {
          if (typeof userEntry[0] === 'string') email = userEntry[0];
          if (userEntry[3] === true || userEntry[3] === 1 || userEntry[4] === 'ANONYMOUS') {
            anon = true;
          }
        }
      } catch {}
      return { hasJspb: true, isAnon: anon || !email || !xsrf };
    }).catch(() => ({ hasJspb: false, isAnon: false }));
    if (authState.isAnon) {
      throw authError(requestedUrl, 'anonymous Buganizer session / expired SSO');
    }
    if (authState.hasJspb && markerPath) {
      clearAuthInvalid('bugs', { markerPath });
    }
  }

  async function navigate(url, { settleSelector, waitForIdle = true } = {}) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) {
      throw authError(url);
    }
    await checkBuganizerAuth(url);
    if (serviceForUrl(url) === 'cf' && markerPath) {
      clearAuthInvalid('cf', { markerPath });
    }
    if (waitForIdle) {
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    }
    if (settleSelector) {
      // Wait up to 5s for a known lazy-loaded element. Best-effort: some pages
      // (auth gates, errors) won't ever have it.
      await page.waitForSelector(settleSelector, { timeout: 5_000 }).catch(() => {});
    }
    if (waitForIdle) await page.waitForTimeout(400);
    return page.url();
  }

  async function dump(url, { rootSelector, attachmentRe, dropTags, settleSelector } = {}) {
    const finalUrl = await navigate(url, { settleSelector });
    const payload = await page.evaluate(pageToFlatHtml, {
      rootSelector,
      attachmentRe: attachmentRe ? attachmentRe.source : null,
      dropTags: dropTags || null,
    });
    const markdown = compactSidebarTail(turndown.turndown(payload.html));
    return { ...payload, markdown, finalUrl };
  }

  async function rawHtml(url) {
    await navigate(url);
    return page.content();
  }

  async function testcaseDownloads(url) {
    await navigate(url, { waitForIdle: false });
    await page.waitForFunction(() => document.querySelector('#page')?.info?.testcase);
    return page.evaluate(() => {
      const tc = document.querySelector('#page').info.testcase;
      return { minimized: tc.minimized_keys, original: tc.fuzzed_keys };
    });
  }

  // Step through a Buganizer search result by clicking "Go to next page" until
  // the button is disabled. Returns an array of per-page dump objects.
  // Buganizer ignores URL pagination parameters, so this is the only way.
  async function dumpPaginated(url, { rootSelector, attachmentRe, dropTags, settleSelector, maxPages = 30 } = {}) {
    const apiPayloads = [];
    const pendingReads = [];
    const onResponse = (resp) => {
      if (!/\/action\/issues\/list(?:[?#]|$)/.test(resp.url())) return;
      pendingReads.push(
        resp.text().then((txt) => {
          if (txt.includes('b.IssueSearchResponse')) apiPayloads.push(txt);
        }).catch(() => {}),
      );
    };
    page.on('response', onResponse);
    try {
      const finalUrl = await navigate(url, { settleSelector });
      const pages = [];
      // The result table is inside a shadow root, so querySelector from document
      // can't see it. innerText is rendered text and DOES pierce shadow DOM, so
      // we use the "N - M of TOTAL" range string as the pagination signal.
      const getRange = () => page.evaluate(() =>
        (document.body.innerText.match(/\d+\s*-\s*\d+\s*of\s*\d+/) || [null])[0]);
      for (let i = 0; i < maxPages; i++) {
        const payload = await page.evaluate(pageToFlatHtml, {
          rootSelector,
          attachmentRe: attachmentRe ? attachmentRe.source : null,
          dropTags: dropTags || null,
        });
        const markdown = compactSidebarTail(turndown.turndown(payload.html));
        pages.push({ ...payload, markdown });
        const rangeBefore = await getRange();
        let clicked = true;
        try {
          await page.click('button[aria-label="Go to next page"]', { timeout: 3_000, force: true });
        } catch {
          clicked = false;
        }
        if (!clicked) break;
        const advanced = await page.waitForFunction(
          (prev) => {
            const m = document.body.innerText.match(/\d+\s*-\s*\d+\s*of\s*\d+/);
            return !!(m && m[0] !== prev);
          },
          rangeBefore,
          { timeout: 10_000 },
        ).catch(() => null);
        if (!advanced) {
          console.error(`[bug list] reached end after ${pages.length} page(s)`);
          break;
        }
        await page.waitForTimeout(300);
      }
      await Promise.allSettled(pendingReads);
      return { finalUrl, pages, apiPayloads };
    } finally {
      page.off('response', onResponse);
    }
  }

  async function downloadBytes(url) {
    try {
      const resp = await ctx.request.get(url);
      try {
        if (new URL(resp.url()).hostname === 'accounts.google.com') {
          return { ok: false, error: authError(url).message };
        }
        if (!resp.ok()) return { ok: false, status: resp.status() };
        if (serviceForUrl(url) === 'cf' && markerPath) {
          clearAuthInvalid('cf', { markerPath });
        }
        const buf = await resp.body();
        return {
          ok: true, body: buf, contentType: resp.headers()['content-type'] || '',
          contentDisposition: resp.headers()['content-disposition'] || '',
        };
      } finally {
        await resp.dispose();
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function downloadText(url) {
    const r = await downloadBytes(url);
    if (!r.ok) return r;
    return { ok: true, body: r.body.toString('utf8'), contentType: r.contentType };
  }

  async function readBuganizerSessionInfo() {
    return page.evaluate(() => {
      const raw = window.buganizerSessionJspb;
      if (!Array.isArray(raw) || typeof raw[2] !== 'string' || !raw[2]) return null;
      let userEmail = '';
      let isAnon = false;
      try {
        const userEntry = JSON.parse(JSON.stringify(raw[0]));
        if (Array.isArray(userEntry)) {
          if (typeof userEntry[0] === 'string') userEmail = userEntry[0];
          if (userEntry[3] === true || userEntry[3] === 1 || userEntry[4] === 'ANONYMOUS') {
            isAnon = true;
          }
        }
      } catch {}
      if (isAnon || !userEmail) return null;
      return { xsrfToken: raw[2], userEmail };
    }).catch(() => null);
  }

  async function ensureBuganizerSession({ origin = 'https://issuetracker.google.com', forceReload = false } = {}) {
    if (!forceReload && page.url().startsWith(origin + '/')) {
      const existing = await readBuganizerSessionInfo();
      if (existing?.userEmail) {
        if (markerPath) clearAuthInvalid('bugs', { markerPath });
        return existing;
      }
    }
    const startUrl = origin + '/';
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) {
      throw authError(startUrl);
    }
    await page.waitForFunction(
      () => Array.isArray(window.buganizerSessionJspb) &&
        typeof window.buganizerSessionJspb[2] === 'string' &&
        window.buganizerSessionJspb[2].length > 0,
      null,
      { timeout: 15_000 },
    ).catch(() => {});
    if (/accounts\.google\.com/.test(page.url())) {
      throw authError(startUrl);
    }
    const info = await readBuganizerSessionInfo();
    if (!info?.userEmail) {
      throw authError(startUrl, 'anonymous Buganizer session / expired SSO');
    }
    if (markerPath) clearAuthInvalid('bugs', { markerPath });
    return info;
  }

  // Execute an authenticated Buganizer `/action/...` RPC from inside the page
  // origin using its active session cookies and XSRF token.
  async function buganizerRpc(path, body, {
    method = 'POST',
    origin = 'https://issuetracker.google.com',
  } = {}) {
    const targetUrl = new URL(path, origin + '/').href;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const send = (xsrfToken) => page.evaluate(
      async ({ url, reqMethod, token, reqBody }) => {
        const headers = {
          accept: 'application/json, text/plain, */*',
          'x-xsrf-token': token,
        };
        if (reqBody !== undefined) headers['content-type'] = 'application/json';
        const resp = await fetch(url, {
          method: reqMethod,
          credentials: 'same-origin',
          headers,
          body: reqBody,
        });
        const text = await resp.text();
        return {
          ok: resp.ok,
          status: resp.status,
          redirectedUrl: resp.url || '',
          text,
        };
      },
      { url: targetUrl, reqMethod: method, token: xsrfToken, reqBody: payload },
    );

    let info = await ensureBuganizerSession({ origin });
    let res = await send(info.xsrfToken);
    if (/accounts\.google\.com/.test(res.redirectedUrl) || res.status === 401) {
      throw authError(targetUrl);
    }
    if (!res.ok && (res.status === 400 || res.status === 403) && /xsrf/i.test(res.text)) {
      info = await ensureBuganizerSession({ origin, forceReload: true });
      res = await send(info.xsrfToken);
      if (/accounts\.google\.com/.test(res.redirectedUrl) || res.status === 401) {
        throw authError(targetUrl);
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      text: res.text,
      userEmail: info.userEmail,
    };
  }

  return {
    ctx,
    page,
    dump,
    dumpPaginated,
    rawHtml,
    testcaseDownloads,
    navigate,
    downloadBytes,
    downloadText,
    buganizerRpc,
    async close() { await ctx.close(); },
  };
}

function wrapProfileLockError(err, profileDir) {
  if (/ProcessSingleton|SingletonLock|Opening in existing browser session|already in use by another instance/i.test(String(err?.message || err))) {
    throw new Error(
      `Profile at ${profileDir} is locked by another browser process. ` +
      `Close any open \`bnz login\` window on that machine and retry.`,
    );
  }
  throw err;
}

const AUTH_COOKIE_NAMES = new Set([
  'SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', 'OSID', 'SACSID', 'session',
]);

export function isClusterFuzzCookie(c) {
  const host = String(c?.domain || '').replace(/^\./, '').toLowerCase();
  if (host === 'clusterfuzz.com' || host.endsWith('.clusterfuzz.com')) return true;
  if (typeof c?.url === 'string') {
    try {
      const uHost = new URL(c.url).hostname.toLowerCase();
      return uHost === 'clusterfuzz.com' || uHost.endsWith('.clusterfuzz.com');
    } catch {}
  }
  return false;
}

function hasValidCfSessionCookie(cookies) {
  const nowSec = Date.now() / 1000;
  return cookies.some((c) =>
    isClusterFuzzCookie(c) &&
    c.name === 'session' &&
    (!c.expires || c.expires <= 0 || c.expires > nowSec),
  );
}

function hasGoogleAuthCookie(cookies) {
  return cookies.some((c) => !isClusterFuzzCookie(c) && AUTH_COOKIE_NAMES.has(c.name));
}

function normalizeUrlList(startUrl, startUrls) {
  if (Array.isArray(startUrls)) return startUrls.filter(Boolean);
  if (Array.isArray(startUrl)) return startUrl.filter(Boolean);
  return startUrl ? [startUrl] : [];
}

// Open a headed browser so the user can complete Google SSO. Resolves when
// the user closes the window (or closes all tabs on macOS).
export async function loginInteractive(startUrl, {
  profileDir = PROFILE_DIR,
  verifyOnClose = profileDir === PROFILE_DIR,
  authMarkerPath,
} = {}) {
  const urls = normalizeUrlList(startUrl);
  mkdirSync(profileDir, { recursive: true });
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
  } catch (err) {
    wrapProfileLockError(err, profileDir);
  }

  const firstPage = ctx.pages()[0] || await ctx.newPage();
  if (urls.length > 0) {
    await firstPage.goto(urls[0]);
    for (let i = 1; i < urls.length; i++) {
      const extraPage = await ctx.newPage();
      await extraPage.goto(urls[i]);
    }
    if (urls.length > 1) {
      await firstPage.bringToFront().catch(() => {});
    }
  }

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    ctx.on('close', done);
    const watchPageClose = (p) => {
      p.on('close', () => {
        setTimeout(() => {
          if (!settled && ctx.pages().length === 0) {
            ctx.close().catch(() => {}).finally(done);
          }
        }, 150);
      });
    };
    for (const p of ctx.pages()) watchPageClose(p);
    ctx.on('page', watchPageClose);
  });

  if (profileDir === PROFILE_DIR) clearCache();
  if (verifyOnClose && urls.length > 0) {
    const markerPath = authMarkerPath !== undefined
      ? authMarkerPath
      : (profileDir === PROFILE_DIR ? AUTH_INVALID_PATH : null);
    const { serviceStatus } = await readProfileState(profileDir, { verifyUrls: urls });
    for (const u of urls) {
      const svc = serviceForUrl(u);
      if (serviceStatus[svc]) {
        if (markerPath) clearAuthInvalid(svc, { markerPath });
      } else {
        if (markerPath) {
          markAuthInvalid(svc, {
            url: u,
            reason: 'login window closed before SSO completed',
            markerPath,
          });
        }
        const label = svc === 'cf' ? 'ClusterFuzz' : 'Buganizer';
        console.error(`Warning: ${label} session is still not signed in.`);
      }
    }
  }
}

async function readProfileState(profileDir, { verifyUrl, verifyUrls } = {}) {
  const urls = normalizeUrlList(verifyUrl, verifyUrls);
  mkdirSync(profileDir, { recursive: true });
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, { headless: true });
  } catch (err) {
    wrapProfileLockError(err, profileDir);
  }
  try {
    let state = await ctx.storageState();
    const serviceStatus = {};
    if (urls.length === 0) {
      const authenticated = state.cookies.some((c) => AUTH_COOKIE_NAMES.has(c.name));
      return { state, authenticated, serviceStatus };
    }

    const page = ctx.pages()[0] || await ctx.newPage();
    let allOk = true;
    for (const u of urls) {
      const svc = serviceForUrl(u);
      let ok = svc === 'cf'
        ? hasValidCfSessionCookie(state.cookies)
        : hasGoogleAuthCookie(state.cookies);
      if (ok) {
        await page.goto(u, { waitUntil: 'domcontentloaded' });
        if (/accounts\.google\.com/.test(page.url())) {
          ok = false;
        } else if (isBuganizerUrl(page.url())) {
          await page.waitForFunction(
            () => Array.isArray(window.buganizerSessionJspb),
            null,
            { timeout: 5_000 },
          ).catch(() => {});
          if (/accounts\.google\.com/.test(page.url())) {
            ok = false;
          } else {
            const isAnon = await page.evaluate(() => {
              const raw = window.buganizerSessionJspb;
              if (!Array.isArray(raw)) return false;
              const xsrf = typeof raw[2] === 'string' ? raw[2] : '';
              let email = '';
              let anon = false;
              try {
                const userEntry = JSON.parse(JSON.stringify(raw[0]));
                if (Array.isArray(userEntry)) {
                  if (typeof userEntry[0] === 'string') email = userEntry[0];
                  if (userEntry[3] === true || userEntry[3] === 1 || userEntry[4] === 'ANONYMOUS') {
                    anon = true;
                  }
                }
              } catch {}
              return anon || !email || !xsrf;
            }).catch(() => false);
            if (isAnon) ok = false;
          }
        }
        // Refresh storageState in case navigation rotated session cookies.
        state = await ctx.storageState();
        if (svc === 'cf' && !hasValidCfSessionCookie(state.cookies)) {
          ok = false;
        }
      }
      serviceStatus[svc] = ok;
      if (!ok) allOk = false;
    }
    return { state, authenticated: allOk, serviceStatus };
  } finally {
    await ctx.close();
  }
}

// Export authenticated cookies for a remote SSH host.
//
// IMPORTANT: When `profileDir` is omitted (standard CLI `bnz login --export`),
// this ALWAYS launches an isolated temporary Chromium profile rather than
// exporting `PROFILE_DIR`. Sharing one Google `SID` across two machines causes
// Google's `RotateCookies` (`__Secure-1PSIDTS`) on one machine to invalidate
// the other within ~15-60 minutes; minting a dedicated session in an ephemeral
// profile gives the remote host its own independent 14-day cookie chain.
export async function exportSessionState({
  startUrl,
  startUrls,
  profileDir,
  loginFn = loginInteractive,
} = {}) {
  const urls = normalizeUrlList(startUrl, startUrls);
  const cfOnly = urls.length > 0 && urls.every((u) => serviceForUrl(u) === 'cf');

  if (profileDir === undefined) {
    if (urls.length === 0) {
      throw new Error('startUrl or profileDir is required for exportSessionState.');
    }
    const ephemeralDir = mkdtempSync(join(tmpdir(), 'bnz-export-'));
    try {
      console.error(
        'Opening isolated browser profile to mint a dedicated remote session ' +
        '(keeps local bnz profile independent)...',
      );
      await loginFn(urls, { profileDir: ephemeralDir, verifyOnClose: false });
      const { state, authenticated } = await readProfileState(ephemeralDir, { verifyUrls: urls });
      if (!authenticated) {
        throw new Error('Browser closed before Google SSO completed; aborting session export.');
      }
      const cookies = cfOnly ? state.cookies.filter(isClusterFuzzCookie) : state.cookies;
      if (!cookies.length) {
        throw new Error('No session cookies captured in export profile.');
      }
      return { ...state, cookies };
    } finally {
      rmSync(ephemeralDir, { recursive: true, force: true });
    }
  }

  let { state, authenticated } = await readProfileState(profileDir, { verifyUrls: urls });
  if (!authenticated && urls.length > 0) {
    console.error('Session is signed out or expired; opening browser to sign in...');
    await loginFn(urls, { profileDir, verifyOnClose: false });
    ({ state, authenticated } = await readProfileState(profileDir, { verifyUrls: urls }));
    if (!authenticated) {
      throw new Error('Browser closed before Google SSO completed; aborting session export.');
    }
  }
  const cookies = cfOnly ? state.cookies.filter(isClusterFuzzCookie) : state.cookies;
  if (!cookies.length) {
    throw new Error('No cookies found in profile; complete `bnz login` first.');
  }
  return { ...state, cookies };
}

function normalizeCookie(c) {
  const out = { name: String(c.name), value: String(c.value) };
  if (typeof c.url === 'string') out.url = c.url;
  if (typeof c.domain === 'string') out.domain = c.domain;
  if (typeof c.path === 'string') out.path = c.path;
  if (typeof c.expires === 'number' && Number.isFinite(c.expires)) out.expires = c.expires;
  if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
  if (typeof c.secure === 'boolean') out.secure = c.secure;
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') {
    out.sameSite = c.sameSite;
  }
  if (typeof c.partitionKey === 'string') out.partitionKey = c.partitionKey;
  return out;
}

export async function importSessionState(rawState, {
  profileDir = PROFILE_DIR,
  authMarkerPath,
} = {}) {
  let state;
  try {
    state = typeof rawState === 'string' ? JSON.parse(rawState) : rawState;
  } catch {
    throw new Error('Invalid session JSON passed to `bnz login --import`.');
  }
  if (!Array.isArray(state?.cookies) || state.cookies.length === 0) {
    throw new Error('Session state contains no cookies to import.');
  }
  const incoming = state.cookies.map(normalizeCookie);
  const incomingHasCf = incoming.some(isClusterFuzzCookie);
  const incomingHasGoogle = incoming.some((c) => !isClusterFuzzCookie(c));

  mkdirSync(profileDir, { recursive: true });
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, { headless: true });
  } catch (err) {
    wrapProfileLockError(err, profileDir);
  }
  try {
    // Only replace cookies for the service families present in `incoming` so
    // importing Buganizer cookies preserves an existing ClusterFuzz session
    // (and vice versa).
    const existing = (await ctx.cookies()).map(normalizeCookie);
    const preserved = existing.filter((c) =>
      isClusterFuzzCookie(c) ? !incomingHasCf : !incomingHasGoogle,
    );
    await ctx.clearCookies();
    await ctx.addCookies([...preserved, ...incoming]);
  } finally {
    await ctx.close();
  }
  if (profileDir === PROFILE_DIR) clearCache();
  const markerPath = authMarkerPath !== undefined
    ? authMarkerPath
    : (profileDir === PROFILE_DIR ? AUTH_INVALID_PATH : null);
  if (markerPath) {
    const cleared = [];
    if (incomingHasGoogle) cleared.push('bugs');
    if (incomingHasCf) cleared.push('cf');
    if (cleared.length) clearAuthInvalid(cleared, { markerPath });
  }
  return { count: incoming.length, profileDir };
}

export async function pushSessionOverSsh(host, state, {
  sshBin = 'ssh',
  remoteCmd = 'env PATH="$PATH:/usr/local/bin:/opt/homebrew/bin" bnz login --import',
} = {}) {
  if (!host || host.startsWith('-') || /\s/.test(host)) {
    throw new Error(`Invalid SSH host for --export: ${host}`);
  }
  await new Promise((resolve, reject) => {
    const child = spawn(sshBin, ['--', host, remoteCmd], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Remote session import on ${host} failed (${code ?? signal}).`));
    });
    child.stdin.end(JSON.stringify(state));
  });
}
