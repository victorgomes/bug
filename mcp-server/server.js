#!/usr/bin/env node
// bnz-mcp — MCP server exposing bnz's Buganizer + ClusterFuzz fetchers as
// tools. Reuses the JS implementation directly; the one new capability is a
// long-lived Chromium session shared across tool calls, which removes the
// browser-launch latency that dominates per-call cost in the CLI.
//
// Transport: stdio. Do NOT write to stdout — it is reserved for JSON-RPC.
// All logging goes to stderr.

import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { AuthRequiredError, openSession } from '../lib/browser.js';
import {
  DEFAULT_LIST_QUERY, fetchIssue, fetchTestcase, searchIssues,
} from '../lib/fetch.js';
import {
  closeIssue, commentIssue, editIssue, fetchIssueFields, resolveCloseStatus,
} from '../lib/mutate.js';
import { sanitizeDeep } from '../lib/render.js';
import { resolveCfTarget, resolveIssueUrl } from '../lib/url.js';
import {
  findTestcaseKeyInMarkdown, renderCloseMarkdown, renderCommentMarkdown,
  renderEditMarkdown, renderFieldsMarkdown, renderIssueMarkdown,
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
      'Search issuetracker (Buganizer) and return matching issues. Accepts raw Buganizer query syntax (defaults to "assignee:me status:open" when omitted). Set `slo: true` to group and sort hits by Chromium SLO deadlines.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          default: DEFAULT_LIST_QUERY,
          description: 'Buganizer search query (defaults to "assignee:me status:open").',
        },
        slo: {
          type: 'boolean',
          default: false,
          description: 'Group and sort matching issues by Chromium SLO deadlines.',
        },
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
  {
    name: 'bnz_comment',
    description:
      'Post a comment on one or more Buganizer issues (formatted as Markdown by default) and invalidate the local issue cache.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Issue ids, b/<id> shortcuts, or URLs to comment on.',
        },
        comment: {
          type: 'string',
          description: 'Non-empty comment text to post.',
        },
        markdown: {
          type: 'boolean',
          default: true,
          description: 'Format the comment as Markdown (default: true). Set false for plain text.',
        },
        dry_run: {
          type: 'boolean',
          default: false,
          description: 'Verify issue access and preview the comment without posting it.',
        },
        format: FORMAT_PROP,
        output_file: OUTPUT_FILE_PROP,
      },
      required: ['ids', 'comment'],
    },
  },
  {
    name: 'bnz_close',
    description:
      'Close one or more Buganizer issues with a resolution status (`fixed`, `verified`, `duplicate`, `wontfix` / `infeasible`, `intended_behavior` / `wai`, `not_reproducible`, `obsolete`, or `inactive`), an optional closing comment, and optional `duplicate_of` / `assignee`. Automatically assigns unassigned (`New`) issues to the authenticated user when closing as `fixed` or `verified`. Invalidates the local issue cache.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Issue ids, b/<id> shortcuts, or URLs to close.',
        },
        status: {
          type: 'string',
          enum: [
            'fixed',
            'verified',
            'duplicate',
            'wontfix',
            'infeasible',
            'intended_behavior',
            'not_reproducible',
            'obsolete',
            'inactive',
          ],
          default: 'fixed',
          description:
            'Closing resolution: `fixed` (Fixed), `verified` (Fixed (Verified)), `duplicate` (Duplicate of `duplicate_of`), `wontfix` / `infeasible` (Won\'t fix (Infeasible)), `intended_behavior` (Won\'t fix (Intended behavior / WAI)), `not_reproducible` (Won\'t fix (Not reproducible)), `obsolete` (Won\'t fix (Obsolete)), or `inactive` (Inactive).',
        },
        duplicate_of: {
          type: 'string',
          description:
            'Canonical target issue id, b/<id>, or URL when closing as duplicate. Automatically sets `status` to `duplicate` if `status` was omitted.',
        },
        comment: {
          type: 'string',
          description: 'Optional closing comment to post atomically with the status change.',
        },
        markdown: {
          type: 'boolean',
          default: true,
          description: 'Format `comment` as Markdown (default: true). Set false for plain text.',
        },
        assignee: {
          type: 'string',
          description: 'Optional assignee email address or "me".',
        },
        dry_run: {
          type: 'boolean',
          default: false,
          description: 'Verify issue access and preview the status transition without mutating Buganizer.',
        },
        format: FORMAT_PROP,
        output_file: OUTPUT_FILE_PROP,
      },
      required: ['ids'],
    },
  },
  {
    name: 'bnz_fields',
    description:
      'Inspect all standard fields (assignee, status, priority, severity, Code Changes, CC, collaborators, etc.) and custom fields (e.g. OS, Merge-Request, Safe Merge, Found In, Milestone) with their current values, types, and allowed enum choices on one or more Buganizer issues.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Issue ids, b/<id> shortcuts, or URLs.',
        },
        full: {
          type: 'boolean',
          default: false,
          description: 'Include unpopulated hidden tracker custom fields (default shows visible or populated custom fields).',
        },
        format: FORMAT_PROP,
        output_file: OUTPUT_FILE_PROP,
      },
      required: ['ids'],
    },
  },
  {
    name: 'bnz_edit',
    description:
      'Update standard fields (assignee, priority, severity, status, type, title, component, verifier, Code Changes, CC, collaborators, Found In, Targeted To, Verified In) and/or custom fields (e.g. OS, Merge-Request, Safe Merge) on one or more Buganizer issues, with an optional comment. Invalidates the local issue cache.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Issue ids, b/<id> shortcuts, or URLs to update.',
        },
        assignee: {
          type: 'string',
          description:
            'Email address, "me", or "none" to unassign. Assigning a `New` bug automatically transitions status to `Assigned`; unassigning an `Assigned` or `In Progress` bug transitions status to `New`.',
        },
        status: {
          type: 'string',
          description:
            'Status to set (`new`, `assigned`, `in-progress`, `fixed`, `verified`, `wontfix` / `infeasible`, `intended-behavior` / `wai`, `not-reproducible` / `norepro`, `obsolete`, or `inactive`). For `duplicate`, use `bnz_close`.',
        },
        priority: {
          type: 'string',
          description: 'Priority (`P0`, `P1`, `P2`, `P3`, or `P4`).',
        },
        severity: {
          type: 'string',
          description: 'Severity (`S0`, `S1`, `S2`, `S3`, or `S4`).',
        },
        type: {
          type: 'string',
          description: 'Issue type (`bug`, `vulnerability`, `feature-request`, `task`, `customer-issue`, `internal-cleanup`, `privacy-issue`, etc.).',
        },
        title: {
          type: 'string',
          description: 'Issue title.',
        },
        component_id: {
          type: 'string',
          description: 'Numeric Buganizer component ID.',
        },
        verifier: {
          type: 'string',
          description: 'Verifier email address, "me", or "none" to clear.',
        },
        code_changes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Replace Buganizer `Code Changes` with these entries (full Gerrit `/c/<repo>/+/<cl>` URLs such as `https://chromium-review.googlesource.com/c/v8/v8/+/8691333`, or numeric Critique CLs). Pass `[]` to clear.',
        },
        add_code_changes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Append entries to `Code Changes` without removing existing ones (full Gerrit `/c/<repo>/+/<cl>` URLs or Critique CLs).',
        },
        remove_code_changes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove entries from `Code Changes`.',
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace CC list (emails or "me"; `[]` clears).',
        },
        add_cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Add emails (or "me") to CC.',
        },
        remove_cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove emails (or "me") from CC.',
        },
        collaborators: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace Collaborators list (emails or "me"; `[]` clears).',
        },
        add_collaborators: {
          type: 'array',
          items: { type: 'string' },
          description: 'Add emails (or "me") to Collaborators.',
        },
        remove_collaborators: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove emails (or "me") from Collaborators.',
        },
        found_in: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace `Found In` versions (`[]` clears).',
        },
        add_found_in: {
          type: 'array',
          items: { type: 'string' },
          description: 'Append `Found In` versions.',
        },
        remove_found_in: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove `Found In` versions.',
        },
        targeted_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace `Targeted To` versions (`[]` clears).',
        },
        add_targeted_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Append `Targeted To` versions.',
        },
        remove_targeted_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove `Targeted To` versions.',
        },
        verified_in: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace `Verified In` versions (`[]` clears).',
        },
        add_verified_in: {
          type: 'array',
          items: { type: 'string' },
          description: 'Append `Verified In` versions.',
        },
        remove_verified_in: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove `Verified In` versions.',
        },
        fields: {
          type: 'object',
          description:
            'Map of custom (or standard) field name or numeric customFieldId to value to set, e.g. `{"OS": ["Android", "Linux"], "Safe Merge": "Yes"}`. Pass `null` or `[]` for a field to clear it.',
        },
        add_fields: {
          type: 'object',
          description:
            'Map of repeated field name or customFieldId to value(s) to append without removing existing values, e.g. `{"OS": ["Mac"]}`.',
        },
        remove_fields: {
          type: 'object',
          description:
            'Map of repeated field name or customFieldId to value(s) to remove, e.g. `{"OS": ["Windows"]}`.',
        },
        clear_fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field names or numeric customFieldIds to clear.',
        },
        comment: {
          type: 'string',
          description: 'Optional comment to post atomically with the field updates.',
        },
        markdown: {
          type: 'boolean',
          default: true,
          description: 'Format `comment` as Markdown (default: true). Set false for plain text.',
        },
        dry_run: {
          type: 'boolean',
          default: false,
          description: 'Verify issue access, validate field names/choices, and preview exact `before -> after` diffs without mutating Buganizer.',
        },
        format: FORMAT_PROP,
        output_file: OUTPUT_FILE_PROP,
      },
      required: ['ids'],
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

function optionalBoolean(name, value) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'boolean') {
    throw new Error(`Tool argument \`${name}\` must be a boolean when provided.`);
  }
}

function optionalStringArray(name, value) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new Error(`Tool argument \`${name}\` must be an array of strings when provided.`);
  }
  for (const v of value) {
    if (typeof v !== 'string' || v === '') {
      throw new Error(`Tool argument \`${name}\` must contain only non-empty strings.`);
    }
  }
}

function optionalPlainObject(name, value) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Tool argument \`${name}\` must be a plain object when provided.`);
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
    slo: !!input.slo,
  };
}

function asTextResult(text) {
  return { content: [{ type: 'text', text }] };
}

async function runList(session, input) {
  optionalString('query', input.query);
  optionalString('output_file', input.output_file);
  const query = input.query || DEFAULT_LIST_QUERY;
  const args = fetchArgs(input);
  const result = await searchIssues(session, query, args);
  const text = input.format === 'json'
    ? JSON.stringify(sanitizeDeep(result), null, 2)
    : renderListMarkdown(result, args, false);
  if (!input.output_file) return asTextResult(text);
  await writeFile(input.output_file, text);
  return asTextResult(
    `Wrote search results for "${query}" to ${input.output_file} ` +
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

async function runComment(session, input) {
  requireStringArray('ids', input.ids);
  requireString('comment', input.comment);
  if (!input.comment.trim()) {
    throw new Error('Tool argument `comment` must not be whitespace-only.');
  }
  optionalBoolean('markdown', input.markdown);
  optionalBoolean('dry_run', input.dry_run);
  optionalString('output_file', input.output_file);
  const entries = await batchFetch({
    items: input.ids,
    fetchOne: (id) => commentIssue(session, id, {
      comment: input.comment,
      markdown: input.markdown !== false,
      dryRun: !!input.dry_run,
    }),
  });
  const text = formatEntries({
    entries,
    render: (res) => renderCommentMarkdown(res, false),
    format: input.format,
    errorVerb: 'updating',
  });
  const out = await maybeWriteAndSummarize({
    text, entries, outputFile: input.output_file, label: 'comment',
  });
  return entries.some((e) => !e.ok)
    ? { ...asTextResult(out), isError: true }
    : asTextResult(out);
}

async function runClose(session, input) {
  requireStringArray('ids', input.ids);
  optionalString('status', input.status);
  optionalString('duplicate_of', input.duplicate_of);
  optionalString('comment', input.comment);
  if (typeof input.comment === 'string' && !input.comment.trim()) {
    throw new Error('Tool argument `comment` must not be whitespace-only.');
  }
  optionalString('assignee', input.assignee);
  optionalBoolean('markdown', input.markdown);
  optionalBoolean('dry_run', input.dry_run);
  optionalString('output_file', input.output_file);
  resolveCloseStatus(input.status, input.duplicate_of);
  if (input.duplicate_of) resolveIssueUrl(input.duplicate_of);

  const entries = await batchFetch({
    items: input.ids,
    fetchOne: (id) => closeIssue(session, id, {
      status: input.status,
      duplicateOf: input.duplicate_of,
      comment: input.comment,
      markdown: input.markdown !== false,
      assignee: input.assignee,
      dryRun: !!input.dry_run,
    }),
  });
  const text = formatEntries({
    entries,
    render: (res) => renderCloseMarkdown(res, false),
    format: input.format,
    errorVerb: 'updating',
  });
  const out = await maybeWriteAndSummarize({
    text, entries, outputFile: input.output_file, label: 'issue',
  });
  return entries.some((e) => !e.ok)
    ? { ...asTextResult(out), isError: true }
    : asTextResult(out);
}

async function runFields(session, input) {
  requireStringArray('ids', input.ids);
  optionalBoolean('full', input.full);
  optionalString('output_file', input.output_file);
  const full = !!input.full;
  const entries = await batchFetch({
    items: input.ids,
    fetchOne: (id) => fetchIssueFields(session, id, { full }),
  });
  const text = formatEntries({
    entries,
    render: (res) => renderFieldsMarkdown(res, false, { full }),
    format: input.format,
  });
  const out = await maybeWriteAndSummarize({
    text, entries, outputFile: input.output_file, label: 'fields',
  });
  return entries.some((e) => !e.ok)
    ? { ...asTextResult(out), isError: true }
    : asTextResult(out);
}

async function runEdit(session, input) {
  requireStringArray('ids', input.ids);
  optionalString('assignee', input.assignee);
  optionalString('status', input.status);
  optionalString('priority', input.priority);
  optionalString('severity', input.severity);
  optionalString('type', input.type);
  optionalString('title', input.title);
  optionalString('component_id', input.component_id);
  optionalString('verifier', input.verifier);
  optionalStringArray('code_changes', input.code_changes);
  optionalStringArray('add_code_changes', input.add_code_changes);
  optionalStringArray('remove_code_changes', input.remove_code_changes);
  optionalStringArray('cc', input.cc);
  optionalStringArray('add_cc', input.add_cc);
  optionalStringArray('remove_cc', input.remove_cc);
  optionalStringArray('collaborators', input.collaborators);
  optionalStringArray('add_collaborators', input.add_collaborators);
  optionalStringArray('remove_collaborators', input.remove_collaborators);
  optionalStringArray('found_in', input.found_in);
  optionalStringArray('add_found_in', input.add_found_in);
  optionalStringArray('remove_found_in', input.remove_found_in);
  optionalStringArray('targeted_to', input.targeted_to);
  optionalStringArray('add_targeted_to', input.add_targeted_to);
  optionalStringArray('remove_targeted_to', input.remove_targeted_to);
  optionalStringArray('verified_in', input.verified_in);
  optionalStringArray('add_verified_in', input.add_verified_in);
  optionalStringArray('remove_verified_in', input.remove_verified_in);
  optionalPlainObject('fields', input.fields);
  optionalPlainObject('add_fields', input.add_fields);
  optionalPlainObject('remove_fields', input.remove_fields);
  optionalStringArray('clear_fields', input.clear_fields);
  optionalString('comment', input.comment);
  if (typeof input.comment === 'string' && !input.comment.trim()) {
    throw new Error('Tool argument `comment` must not be whitespace-only.');
  }
  optionalBoolean('markdown', input.markdown);
  optionalBoolean('dry_run', input.dry_run);
  optionalString('output_file', input.output_file);

  const fieldOps = [];
  if (input.fields) {
    for (const [name, value] of Object.entries(input.fields)) {
      if (value === null) {
        fieldOps.push({ name, op: 'clear', value: null });
      } else {
        fieldOps.push({ name, op: 'set', value });
      }
    }
  }
  if (input.add_fields) {
    for (const [name, value] of Object.entries(input.add_fields)) {
      fieldOps.push({ name, op: 'add', value });
    }
  }
  if (input.remove_fields) {
    for (const [name, value] of Object.entries(input.remove_fields)) {
      fieldOps.push({ name, op: 'remove', value });
    }
  }
  if (input.clear_fields) {
    for (const name of input.clear_fields) {
      fieldOps.push({ name, op: 'clear', value: null });
    }
  }

  const editOpts = {
    assignee: input.assignee,
    status: input.status ?? undefined,
    priority: input.priority ?? undefined,
    severity: input.severity ?? undefined,
    type: input.type ?? undefined,
    title: input.title ?? undefined,
    componentId: input.component_id ?? undefined,
    verifier: input.verifier,
    codeChanges: input.code_changes ?? undefined,
    addCodeChanges: input.add_code_changes ?? undefined,
    removeCodeChanges: input.remove_code_changes ?? undefined,
    cc: input.cc ?? undefined,
    addCc: input.add_cc ?? undefined,
    removeCc: input.remove_cc ?? undefined,
    collaborators: input.collaborators ?? undefined,
    addCollaborators: input.add_collaborators ?? undefined,
    removeCollaborators: input.remove_collaborators ?? undefined,
    foundIn: input.found_in ?? undefined,
    addFoundIn: input.add_found_in ?? undefined,
    removeFoundIn: input.remove_found_in ?? undefined,
    targetedTo: input.targeted_to ?? undefined,
    addTargetedTo: input.add_targeted_to ?? undefined,
    removeTargetedTo: input.remove_targeted_to ?? undefined,
    verifiedIn: input.verified_in ?? undefined,
    addVerifiedIn: input.add_verified_in ?? undefined,
    removeVerifiedIn: input.remove_verified_in ?? undefined,
    fieldOps,
    comment: input.comment ?? undefined,
    markdown: input.markdown !== false,
    dryRun: !!input.dry_run,
  };

  const entries = await batchFetch({
    items: input.ids,
    fetchOne: (id) => editIssue(session, id, editOpts),
  });
  const text = formatEntries({
    entries,
    render: (res) => renderEditMarkdown(res, false),
    format: input.format,
    errorVerb: 'updating',
  });
  const out = await maybeWriteAndSummarize({
    text, entries, outputFile: input.output_file, label: 'issue',
  });
  return entries.some((e) => !e.ok)
    ? { ...asTextResult(out), isError: true }
    : asTextResult(out);
}

const HANDLERS = {
  bnz_list: runList,
  bnz_issue: runIssue,
  bnz_cf: runCf,
  bnz_comment: runComment,
  bnz_close: runClose,
  bnz_fields: runFields,
  bnz_edit: runEdit,
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

export { HANDLERS, TOOLS };

function isMainModule() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
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
}
