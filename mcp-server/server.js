#!/usr/bin/env node
// bnz-mcp — MCP server exposing bnz's Buganizer + ClusterFuzz fetchers as
// tools. Reuses the JS implementation directly; the one new capability is a
// long-lived Chromium session shared across tool calls, which removes the
// browser-launch latency that dominates per-call cost in the CLI.
//
// Transport: stdio. Do NOT write to stdout — it is reserved for JSON-RPC.
// All logging goes to stderr.

import { writeFile } from 'node:fs/promises';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { AuthRequiredError, openSession } from '../lib/browser.js';
import {
  fetchIssue, fetchTestcase, searchIssues,
} from '../lib/fetch.js';
import { sanitizeDeep } from '../lib/render.js';
import { resolveCfTarget, resolveIssueUrl } from '../lib/url.js';
import {
  findTestcaseKeyInMarkdown, renderIssueMarkdown,
  renderListMarkdown, renderTestcaseMarkdown,
} from '../bnz.js';

import {
  batchFetch, formatEntries, maybeWriteAndSummarize,
} from './batch.js';
import { Mutex, SessionManager } from './session-manager.js';

const IDLE_MS = parseIdleMs(process.env.BNZ_MCP_IDLE_MS);

function parseIdleMs(raw) {
  if (raw === undefined || raw === '') return 5 * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5 * 60_000;
  return n;  // 0 is honored and disables teardown in SessionManager.
}

const sessions = new SessionManager({ openSession, idleMs: IDLE_MS });
const mutex = new Mutex();

const AUTH_HELP_MSG =
  'Not signed in. Run `bnz login` (issuetracker) or `bnz cf login` (clusterfuzz) on the host to complete Google SSO, then retry.';

// ---------- tool definitions ----------

const FORMAT_PROP = {
  type: 'string',
  enum: ['markdown', 'json'],
  default: 'markdown',
  description: 'Output shape. markdown for human/agent reading; json for the raw structured object.',
};
const FULL_PROP = {
  type: 'boolean',
  default: false,
  description: 'Skip the page-chrome filter and dump the full page (sidebar, top bar, etc.). Default keeps only the focused content.',
};
const REFRESH_PROP = {
  type: 'boolean',
  default: false,
  description: 'Bypass the on-disk cache for this fetch. The result is still written back.',
};
const OUTPUT_FILE_PROP = {
  type: 'string',
  description: 'If set, write the rendered output to this absolute path and return only a short summary (path, byte count, per-item status). Useful for large batches to keep the context light.',
};

const TOOLS = [
  {
    name: 'bnz_list',
    description:
      'Search issuetracker (Buganizer) and return matching issues. Accepts raw Buganizer query syntax (e.g. "reporter:me status:open componentid:1457111"). Paginates automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Buganizer search query.' },
        since: {
          type: 'string',
          description: 'Drop hits not modified within this window. Accepts durations (7d, 1w, 24h, 1m) or ISO dates (2026-05-01).',
        },
        max_pages: {
          type: 'integer',
          minimum: 1,
          default: 30,
          description: 'Cap pagination at this many pages of ~50 hits each.',
        },
        full: FULL_PROP,
        refresh: REFRESH_PROP,
        format: FORMAT_PROP,
        output_file: OUTPUT_FILE_PROP,
      },
      required: ['query'],
    },
  },
  {
    name: 'bnz_issue',
    description:
      'Fetch one or more Buganizer issues and return them as markdown (default) or JSON. Each id may be a bare numeric id, a "b/<id>" shortcut, or a full URL (issuetracker.google.com, issues.chromium.org, crbug.com, b.corp.google.com). Always prefer one batched call over N single-id calls. Per-item errors are reported inline; an auth failure aborts the whole batch.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Issue ids, b/<id> shortcuts, or URLs. Fetched in order.',
        },
        full: FULL_PROP,
        refresh: REFRESH_PROP,
        format: FORMAT_PROP,
        output_file: OUTPUT_FILE_PROP,
      },
      required: ['ids'],
    },
  },
  {
    name: 'bnz_cf',
    description:
      'Fetch one or more ClusterFuzz testcases including the minimized reproducer text. Each input may be a testcase key (numeric, 14+ digits), a ClusterFuzz URL, or a Buganizer issue id — in the issue case the testcase link is extracted from the issue body. Always prefer one batched call over N single-input calls. Per-item errors are reported inline; an auth failure aborts the whole batch.',
    inputSchema: {
      type: 'object',
      properties: {
        inputs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Testcase keys, ClusterFuzz URLs, or Buganizer issue ids that reference a testcase. Fetched in order.',
        },
        full: FULL_PROP,
        refresh: REFRESH_PROP,
        format: FORMAT_PROP,
        output_file: OUTPUT_FILE_PROP,
      },
      required: ['inputs'],
    },
  },
];

// ---------- validation ----------

// The MCP SDK doesn't enforce inputSchema, so defend against shape drift at
// the tool boundary. A string in `ids` would otherwise iterate per character.
function requireString(name, value) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Tool argument \`${name}\` must be a non-empty string.`);
  }
}

function requireStringArray(name, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Tool argument \`${name}\` must be a non-empty array of strings.`);
  }
  for (const v of value) {
    if (typeof v !== 'string' || v === '') {
      throw new Error(`Tool argument \`${name}\` must contain only non-empty strings.`);
    }
  }
}

function optionalString(name, value) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Tool argument \`${name}\` must be a non-empty string when provided.`);
  }
}

// ---------- tool implementations ----------

function fetchArgs(input) {
  return {
    full: !!input.full,
    refresh: !!input.refresh,
    useCache: true,
    maxPages: input.max_pages,
    since: input.since,
  };
}

function asTextResult(text) {
  return { content: [{ type: 'text', text }] };
}

async function runList(session, input) {
  requireString('query', input.query);
  optionalString('output_file', input.output_file);
  const args = fetchArgs(input);
  const result = await searchIssues(session, input.query, args);
  const text = input.format === 'json'
    ? JSON.stringify(sanitizeDeep(result), null, 2)
    : renderListMarkdown(result, args, false);
  if (!input.output_file) return asTextResult(text);
  await writeFile(input.output_file, text);
  return asTextResult(
    `Wrote search results for "${input.query}" to ${input.output_file} ` +
    `(${Buffer.byteLength(text)} bytes, ${result.hits.length} hits).`,
  );
}

async function runIssue(session, input) {
  requireStringArray('ids', input.ids);
  optionalString('output_file', input.output_file);
  const args = fetchArgs(input);
  const entries = await batchFetch({
    items: input.ids,
    fetchOne: async (id) => {
      const url = resolveIssueUrl(id);
      const issue = await fetchIssue(session, url, args);
      issue.id = url.match(/(\d+)/)[1];
      return issue;
    },
  });
  const text = formatEntries({
    entries,
    render: (issue) => renderIssueMarkdown(issue, args, false),
    format: input.format,
  });
  return asTextResult(await maybeWriteAndSummarize({
    text, entries, outputFile: input.output_file, label: 'issue',
  }));
}

async function runCf(session, input) {
  requireStringArray('inputs', input.inputs);
  optionalString('output_file', input.output_file);
  const args = fetchArgs(input);
  const entries = await batchFetch({
    items: input.inputs,
    fetchOne: async (raw) => {
      const target = resolveCfTarget(raw);
      let key;
      if (target.kind === 'testcase') {
        key = target.key;
      } else {
        const issueUrl = resolveIssueUrl(target.issue);
        const issue = await fetchIssue(session, issueUrl, args);
        key = findTestcaseKeyInMarkdown(issue.markdown);
        if (!key) {
          throw new Error(`No clusterfuzz testcase link found in issue ${target.issue}.`);
        }
      }
      return fetchTestcase(session, key, args);
    },
  });
  const text = formatEntries({
    entries,
    render: (tc) => renderTestcaseMarkdown(tc, args, false),
    format: input.format,
  });
  return asTextResult(await maybeWriteAndSummarize({
    text, entries, outputFile: input.output_file, label: 'testcase',
  }));
}

const HANDLERS = {
  bnz_list: runList,
  bnz_issue: runIssue,
  bnz_cf: runCf,
};

// ---------- server wiring ----------

const server = new Server(
  { name: 'bnz', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input = {} } = req.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await mutex.run(() =>
      sessions.withSession((session) => handler(session, input)),
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      // The user must run `bnz login` / `bnz cf login` on the host to refresh
      // cookies on disk. Tear our session down so the next call re-launches
      // and picks up the freshly-written profile — otherwise the in-memory
      // browser would keep its pre-login state and the next call would fail
      // the same way.
      sessions.close().catch(() => {});
      return {
        content: [{ type: 'text', text: AUTH_HELP_MSG }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: String(err.message || err) }],
      isError: true,
    };
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[bnz-mcp] received ${signal}, shutting down\n`);
  try { await server.close(); } catch { /* ignored */ }
  try { await sessions.close(); } catch { /* ignored */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `[bnz-mcp] ready (idle teardown ${IDLE_MS === 0 ? 'disabled' : `${IDLE_MS}ms`})\n`,
);
