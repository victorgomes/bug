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
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import TurndownService from 'turndown';
import gfm from '@joplin/turndown-plugin-gfm';

import { pageToFlatHtml } from './dom.js';

export const PROFILE_DIR = join(homedir(), '.config', 'bnz', 'profile');

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
  constructor(url) {
    super(`Not logged in (redirected to accounts.google.com when fetching ${url}). ` +
      `Run \`bnz login\` (issuetracker) or \`bnz cf login\` (clusterfuzz).`);
    this.name = 'AuthRequiredError';
  }
}

export async function openSession({ headless = true } = {}) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
  });
  let page = ctx.pages()[0] || await ctx.newPage();

  async function navigate(url, { settleSelector, waitForIdle = true } = {}) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) {
      throw new AuthRequiredError(url);
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
    return { finalUrl, pages };
  }

  async function downloadBytes(url) {
    try {
      const resp = await ctx.request.get(url);
      try {
        if (new URL(resp.url()).hostname === 'accounts.google.com') {
          return { ok: false, error: new AuthRequiredError(url).message };
        }
        if (!resp.ok()) return { ok: false, status: resp.status() };
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
    async close() { await ctx.close(); },
  };
}

// Open a headed browser so the user can complete Google SSO. Resolves when
// the user closes the window.
export async function loginInteractive(startUrl) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(startUrl);
  await new Promise((resolve) => ctx.on('close', resolve));
}
