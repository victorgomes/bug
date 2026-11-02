import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseArgs,
  parseFieldSpec,
  prepareAssignInvocation,
  prepareCloseInvocation,
  prepareCommentInvocation,
  prepareEditInvocation,
  prepareFieldsInvocation,
  renderCloseMarkdown,
  renderCommentMarkdown,
  renderEditMarkdown,
  renderFieldsMarkdown,
} from '../bnz.js';
import { AuthRequiredError } from '../lib/browser.js';
import { readCache, writeCache } from '../lib/cache.js';
import { ISSUE_STATUSES } from '../lib/fetch.js';
import {
  assignIssue,
  buildCreateCommentPayload,
  buildCustomFieldClearJspb,
  buildCustomFieldValueJspb,
  buildModifyIssuePayload,
  closeIssue,
  commentIssue,
  editIssue,
  extractRpcErrorMessage,
  fetchIssueFields,
  invalidateIssueCache,
  parseCodeChangeEntry,
  parseIssueFetchResponse,
  resolveCloseStatus,
} from '../lib/mutate.js';
import { HANDLERS, TOOLS } from '../mcp-server/server.js';

function makeIssueFetchJspb({
  id = 999000111,
  componentId = 1456355,
  statusId = 1,
  priorityId = 2,
  severityId = 3,
  typeId = 1,
  title = 'Sample crash in Maglev',
  reporter = 'reporter@chromium.org',
  assignee = '',
  verifier = '',
  ccs = [],
  collaborators = [],
  changelists = [],
  gerritChanges = [],
  customFieldValues = [],
  customFieldDefs = [],
  visibleCustomIds = [],
} = {}) {
  const core = [
    componentId,
    typeId,
    statusId,
    priorityId,
    severityId,
    title,
    reporter ? [reporter] : null,
    assignee ? [assignee] : null,
    verifier ? [verifier] : null,
    ccs.length ? ccs.map((e) => [e]) : null,
  ];
  if (customFieldValues.length) core[14] = customFieldValues;
  if (changelists.length) core[15] = changelists.map(String);
  if (collaborators.length) core[30] = collaborators.map((e) => [e]);
  if (gerritChanges.length) core[34] = gerritChanges;

  const issueTuple = [null, Number(id), core];
  if (customFieldDefs.length) issueTuple[14] = customFieldDefs;
  if (visibleCustomIds.length) issueTuple[33] = visibleCustomIds.map((cid) => [Number(cid)]);

  const container = [];
  container[22] = issueTuple;
  return `)]}'\n` + JSON.stringify([['b.IssueFetchResponse', container]]);
}

function makeMockSession(handler, { userEmail = 'victorgomes@chromium.org' } = {}) {
  const calls = [];
  return {
    calls,
    async buganizerRpc(path, body, opts) {
      calls.push({ path, body, opts });
      const res = await handler(path, body, opts);
      return {
        ok: true,
        status: 200,
        text: `)]}'\n[]`,
        userEmail,
        ...res,
      };
    },
  };
}

test('ISSUE_STATUSES maps all Buganizer open and closed sub-statuses accurately', () => {
  assert.equal(ISSUE_STATUSES[1], 'New');
  assert.equal(ISSUE_STATUSES[2], 'Assigned');
  assert.equal(ISSUE_STATUSES[3], 'In Progress');
  assert.equal(ISSUE_STATUSES[4], 'Fixed');
  assert.equal(ISSUE_STATUSES[5], 'Fixed (Verified)');
  assert.equal(ISSUE_STATUSES[6], "Won't fix (Not reproducible)");
  assert.equal(ISSUE_STATUSES[7], "Won't fix (Intended behavior)");
  assert.equal(ISSUE_STATUSES[8], "Won't fix (Obsolete)");
  assert.equal(ISSUE_STATUSES[9], "Won't fix (Infeasible)");
  assert.equal(ISSUE_STATUSES[10], 'Duplicate');
  assert.equal(ISSUE_STATUSES[11], 'Inactive');
});

test('resolveCloseStatus resolves defaults, aliases, duplicate targets, and conflicts', () => {
  assert.equal(resolveCloseStatus(undefined, undefined).statusId, 4);
  assert.equal(resolveCloseStatus(undefined, '555').statusId, 10);
  assert.equal(resolveCloseStatus('duplicate', 'b/555').label, 'Duplicate');
  assert.equal(resolveCloseStatus('dup', '555').key, 'duplicate');

  assert.equal(resolveCloseStatus('fixed').statusId, 4);
  assert.equal(resolveCloseStatus('verified').statusId, 5);
  assert.equal(resolveCloseStatus('wontfix').statusId, 9);
  assert.equal(resolveCloseStatus("Won't Fix").statusId, 9);
  assert.equal(resolveCloseStatus('infeasible').statusId, 9);
  assert.equal(resolveCloseStatus('wontfix:wai').statusId, 7);
  assert.equal(resolveCloseStatus('intended_behavior').statusId, 7);
  assert.equal(resolveCloseStatus('wai').label, "Won't fix (Intended behavior)");
  assert.equal(resolveCloseStatus('norepro').statusId, 6);
  assert.equal(resolveCloseStatus('not_reproducible').statusId, 6);
  assert.equal(resolveCloseStatus('wontfix:norepro').label, "Won't fix (Not reproducible)");
  assert.equal(resolveCloseStatus('obsolete').statusId, 8);
  assert.equal(resolveCloseStatus('wontfix:obsolete').statusId, 8);
  assert.equal(resolveCloseStatus('inactive').statusId, 11);

  assert.throws(
    () => resolveCloseStatus('duplicate', undefined),
    /requires a target issue/,
  );
  assert.throws(
    () => resolveCloseStatus('fixed', '555'),
    /Cannot combine duplicate target/,
  );
  assert.throws(
    () => resolveCloseStatus('bogus-status', undefined),
    /Unknown close status/,
  );
});

test('extractRpcErrorMessage and parseIssueFetchResponse handle XSSI responses', () => {
  assert.equal(
    extractRpcErrorMessage(`)]}'\n{"message":"Issue 999 does not exist."}`, 404),
    'Issue 999 does not exist.',
  );
  assert.equal(extractRpcErrorMessage('', 403), 'HTTP 403');

  const parsed = parseIssueFetchResponse(
    makeIssueFetchJspb({
      id: 123456,
      statusId: 2,
      title: 'Test bug',
      assignee: 'owner@chromium.org',
    }),
    '123456',
  );
  assert.equal(parsed.id, '123456');
  assert.equal(parsed.status, 'Assigned');
  assert.equal(parsed.title, 'Test bug');
  assert.equal(parsed.assignee, 'owner@chromium.org');
});

test('buildCreateCommentPayload and buildModifyIssuePayload build Buganizer JSPB arrays', () => {
  assert.deepEqual(
    buildCreateCommentPayload('123', 'Hello **world**', { markdown: true }),
    [null, null, null, null, [123, ['Hello **world**', null, null, null, null, null, null, null, 2]]],
  );
  assert.deepEqual(
    buildCreateCommentPayload('123', 'Plain text', { markdown: false }),
    [null, null, null, null, [123, ['Plain text', null, null, null, null, null, null, null, 1]]],
  );

  const mod = buildModifyIssuePayload('123', {
    statusId: 4,
    assignee: 'me@chromium.org',
    comment: 'Fixed in CL 1',
    markdown: true,
  });
  assert.deepEqual(mod, [
    null, null, null, null, null, null,
    [
      123,
      [['status', 'assignee']],
      [null, null, 4, null, null, null, null, ['me@chromium.org']],
      [],
      [],
      ['Fixed in CL 1', null, null, null, null, null, null, null, 2],
    ],
  ]);
});

test('commentIssue posts comment, supports dry-run, and invalidates local cache', async () => {
  const id = '999999999001';
  const url = `https://issuetracker.google.com/issues/${id}`;
  try {
    writeCache(url, { markdown: 'cached normal' });
    writeCache(url + '#full', { markdown: 'cached full' });
    assert.ok(readCache(url));
    assert.ok(readCache(url + '#full'));

    const drySession = makeMockSession(async (path) => {
      assert.equal(path, `/action/issues/${id}/getIssue`);
      return { text: makeIssueFetchJspb({ id, statusId: 2, title: 'Dry-run bug' }) };
    });
    const dryRes = await commentIssue(drySession, `b/${id}`, {
      comment: 'Preview note',
      dryRun: true,
    });
    assert.equal(drySession.calls.length, 1);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.title, 'Dry-run bug');
    // Dry run must NOT invalidate existing cache or post a comment.
    assert.ok(readCache(url));

    const liveSession = makeMockSession(async (path) => {
      assert.equal(path, `/action/issues/${id}/comment`);
      return { text: `)]}'\n[]` };
    });
    const liveRes = await commentIssue(liveSession, id, {
      comment: 'Posted comment',
      markdown: false,
    });
    assert.equal(liveSession.calls.length, 1);
    assert.equal(liveSession.calls[0].body[4][1][8], 1); // plain formattingMode
    assert.equal(liveRes.dryRun, false);
    assert.equal(liveRes.markdown, false);
    assert.equal(readCache(url), null);
    assert.equal(readCache(url + '#full'), null);
  } finally {
    invalidateIssueCache(url);
  }
});

test('closeIssue auto-assigns unassigned Fixed/Verified bugs, leaves WontFix unassigned, and sends atomic payload', async () => {
  const id = '999999999002';
  const url = `https://issuetracker.google.com/issues/${id}`;
  try {
    // 1. Unassigned "New" bug closed as Fixed -> auto-assigns to session userEmail.
    const sFixed = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return { text: makeIssueFetchJspb({ id, statusId: 1, assignee: '' }) };
      }
      assert.equal(path, `/action/issues/${id}`);
      return {
        text: makeIssueFetchJspb({
          id,
          statusId: 4,
          assignee: 'victorgomes@chromium.org',
        }),
      };
    });
    const rFixed = await closeIssue(sFixed, id, {
      status: 'fixed',
      comment: 'Landed fix.',
    });
    assert.equal(rFixed.status, 'Fixed');
    assert.equal(rFixed.previousStatus, 'New');
    assert.equal(rFixed.assignee, 'victorgomes@chromium.org');
    assert.equal(rFixed.autoAssigned, true);
    assert.deepEqual(sFixed.calls[1].body[6][1], [['status', 'assignee']]);
    assert.equal(sFixed.calls[1].body[6][2][2], 4);
    assert.deepEqual(sFixed.calls[1].body[6][2][7], ['victorgomes@chromium.org']);
    assert.equal(sFixed.calls[1].body[6][5][0], 'Landed fix.');

    // 2. Unassigned "New" bug closed as Won't fix (Intended behavior) -> no auto-assign.
    const sWai = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return { text: makeIssueFetchJspb({ id, statusId: 1, assignee: '' }) };
      }
      return { text: makeIssueFetchJspb({ id, statusId: 7, assignee: '' }) };
    });
    const rWai = await closeIssue(sWai, id, { status: 'wai' });
    assert.equal(rWai.status, "Won't fix (Intended behavior)");
    assert.equal(rWai.autoAssigned, false);
    assert.equal(rWai.assignee, null);
    assert.deepEqual(sWai.calls[1].body[6][1], [['status']]);
    assert.equal(sWai.calls[1].body[6][2][2], 7);
  } finally {
    invalidateIssueCache(url);
  }
});

test('closeIssue marks duplicate via /mark_as_duplicate, validates canonical target, and rejects self-duplicate', async () => {
  const srcId = '999999999003';
  const dstId = '999999999004';
  const srcUrl = `https://issuetracker.google.com/issues/${srcId}`;
  try {
    await assert.rejects(
      () => closeIssue(makeMockSession(async () => ({})), srcId, { duplicateOf: `b/${srcId}` }),
      /cannot be marked as a duplicate of itself/,
    );

    // Non-existent canonical target fails before any write call.
    const sMissing = makeMockSession(async (path) => {
      if (path === `/action/issues/${srcId}/getIssue`) {
        return { text: makeIssueFetchJspb({ id: srcId, statusId: 2 }) };
      }
      if (path === `/action/issues/${dstId}/getIssue`) {
        return {
          ok: false,
          status: 404,
          text: `)]}'\n{"message":"Issue ${dstId} does not exist."}`,
        };
      }
      assert.fail(`Unexpected write call: ${path}`);
    });
    await assert.rejects(
      () => closeIssue(sMissing, srcId, { duplicateOf: dstId }),
      new RegExp(`Issue ${dstId} does not exist`),
    );
    assert.equal(sMissing.calls.length, 2);

    // Valid duplicate with closing comment calls mark_as_duplicate + comment.
    const sDup = makeMockSession(async (path, body) => {
      if (path === `/action/issues/${srcId}/getIssue`) {
        return { text: makeIssueFetchJspb({ id: srcId, statusId: 2, title: 'Dup bug' }) };
      }
      if (path === `/action/issues/${dstId}/getIssue`) {
        return { text: makeIssueFetchJspb({ id: dstId, statusId: 4, title: 'Canonical closed bug' }) };
      }
      if (path === `/action/issues/${srcId}/mark_as_duplicate`) {
        assert.deepEqual(body, [Number(srcId), Number(dstId)]);
        return { text: makeIssueFetchJspb({ id: srcId, statusId: 10, title: 'Dup bug' }) };
      }
      if (path === `/action/issues/${srcId}/comment`) {
        assert.equal(body[4][1][0], 'Same root cause.');
        return { text: `)]}'\n[]` };
      }
      assert.fail(`Unexpected RPC path: ${path}`);
    });

    const res = await closeIssue(sDup, srcId, {
      duplicateOf: `https://crbug.com/${dstId}`,
      comment: 'Same root cause.',
    });
    assert.equal(res.status, 'Duplicate');
    assert.equal(res.duplicateOf, dstId);
    assert.equal(res.duplicateOfTitle, 'Canonical closed bug');
    assert.deepEqual(
      sDup.calls.map((c) => c.path),
      [
        `/action/issues/${srcId}/getIssue`,
        `/action/issues/${dstId}/getIssue`,
        `/action/issues/${srcId}/mark_as_duplicate`,
        `/action/issues/${srcId}/comment`,
      ],
    );
  } finally {
    invalidateIssueCache(srcUrl);
  }
});

test('CLI parseArgs, prepareCommentInvocation, prepareCloseInvocation, and markdown renderers', () => {
  // Comment CLI parsing
  const a1 = parseArgs(['comment', '12345', '- bullet point']);
  const p1 = prepareCommentInvocation(a1._.slice(1), a1, { stdinIsTTY: true });
  assert.deepEqual(p1.targets, ['12345']);
  assert.equal(p1.comment, '- bullet point');
  assert.equal(p1.markdown, true);

  const a2 = parseArgs(['comment', '123, b/456', '-m', 'Batch note', '--plain', '--dry-run']);
  const p2 = prepareCommentInvocation(a2._.slice(1), a2, { stdinIsTTY: true });
  assert.deepEqual(p2.targets, ['123', 'b/456']);
  assert.equal(p2.comment, 'Batch note');
  assert.equal(p2.markdown, false);
  assert.equal(p2.dryRun, true);

  // Stdin pipe for comment
  const a3 = parseArgs(['comment', '12345']);
  const p3 = prepareCommentInvocation(a3._.slice(1), a3, {
    stdinIsTTY: false,
    readStdin: () => 'Piped stdin body\n',
  });
  assert.equal(p3.comment, 'Piped stdin body\n');
  assert.throws(
    () => prepareCommentInvocation(a3._.slice(1), a3, { stdinIsTTY: true }),
    /Missing comment text/,
  );

  // Comment file
  const tmpDir = mkdtempSync(join(tmpdir(), 'bnz-comment-test-'));
  try {
    const file = join(tmpDir, 'msg.md');
    writeFileSync(file, 'From file\n');
    const af = parseArgs(['comment', '12345', '-F', file]);
    const pf = prepareCommentInvocation(af._.slice(1), af, { stdinIsTTY: true });
    assert.equal(pf.comment, 'From file\n');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Close CLI parsing (shorthand flags + positional statuses)
  const c1 = parseArgs(['close', '12345', '--wont-fix=wai', '-m', 'Expected behavior']);
  const pc1 = prepareCloseInvocation(c1._.slice(1), c1);
  assert.equal(resolveCloseStatus(pc1.status, pc1.duplicateOf).statusId, 7);
  assert.equal(pc1.comment, 'Expected behavior');

  const c2 = parseArgs(['close', '12345', 'duplicate', 'of', 'b/67890']);
  const pc2 = prepareCloseInvocation(c2._.slice(1), c2);
  assert.deepEqual(pc2.targets, ['12345']);
  assert.equal(pc2.status, 'duplicate');
  assert.equal(pc2.duplicateOf, 'b/67890');

  const c3 = parseArgs(['close', '12345', 'obsolete']);
  const pc3 = prepareCloseInvocation(c3._.slice(1), c3);
  assert.equal(resolveCloseStatus(pc3.status, pc3.duplicateOf).statusId, 8);

  // Rejections
  assert.throws(() => parseArgs(['close', '123', '--fixed', '--obsolete']), /Conflicting statuses/);
  assert.throws(() => parseArgs(['123', '--fixed']), /require `bnz close` or `bnz edit`/);
  assert.throws(() => parseArgs(['123', '-m', 'hi']), /require `bnz comment`, `bnz close`, `bnz assign`, or `bnz edit`/);
  assert.throws(() => parseArgs(['comment', '123', '-m', 'a', '-F', 'b']), /Cannot combine/);

  // Markdown rendering
  const commentMd = renderCommentMarkdown({
    id: '123',
    url: 'https://issuetracker.google.com/issues/123',
    title: 'Sample bug',
    status: 'Assigned',
    markdown: true,
    comment: 'Hello!',
    dryRun: true,
  }, false);
  assert.match(commentMd, /# Dry run: Comment on Issue 123/);
  assert.match(commentMd, /Hello!/);

  const closeMd = renderCloseMarkdown({
    id: '123',
    url: 'https://issuetracker.google.com/issues/123',
    title: 'Sample bug',
    previousStatus: 'New',
    status: 'Fixed',
    assignee: 'victorgomes@chromium.org',
    autoAssigned: true,
    comment: 'Done.',
    dryRun: false,
  }, false);
  assert.match(closeMd, /# Closed Issue 123/);
  assert.match(closeMd, /New -> Fixed/);
  assert.match(closeMd, /\(auto-assigned\)/);
  assert.match(closeMd, /### Closing comment/);
});

test('MCP bnz_comment and bnz_close handlers validate inputs, batch items, and flag partial failures', async () => {
  const toolNames = TOOLS.map((t) => t.name);
  assert.ok(toolNames.includes('bnz_comment'));
  assert.ok(toolNames.includes('bnz_close'));

  const session = makeMockSession(async (path) => {
    if (path.includes('999000999')) {
      return { ok: false, status: 404, text: `)]}'\n{"message":"Issue 999000999 does not exist."}` };
    }
    if (path.endsWith('/getIssue')) {
      const m = path.match(/issues\/(\d+)\//);
      return { text: makeIssueFetchJspb({ id: m[1], statusId: 2, assignee: 'victorgomes@chromium.org' }) };
    }
    return { text: makeIssueFetchJspb({ id: 999000100, statusId: 8, assignee: 'victorgomes@chromium.org' }) };
  });

  // Dry-run comment via MCP
  const commentRes = await HANDLERS.bnz_comment(session, {
    ids: ['999000100'],
    comment: 'MCP dry run comment',
    dry_run: true,
    format: 'json',
  });
  assert.equal(commentRes.isError, undefined);
  const commentJson = JSON.parse(commentRes.content[0].text);
  assert.equal(commentJson[0].id, '999000100');
  assert.equal(commentJson[0].dryRun, true);

  // Partial batch failure in bnz_close sets isError: true while returning both results
  const closeRes = await HANDLERS.bnz_close(session, {
    ids: ['999000100', '999000999'],
    status: 'obsolete',
    dry_run: true,
    format: 'json',
  });
  assert.equal(closeRes.isError, true);
  const closeJson = JSON.parse(closeRes.content[0].text);
  assert.equal(closeJson[0].status, "Won't fix (Obsolete)");
  assert.match(closeJson[1].error, /Issue 999000999 does not exist/);

  // AuthRequiredError propagates out of handler so server tears down stale session
  const unauthSession = {
    async buganizerRpc() {
      throw new AuthRequiredError('https://issuetracker.google.com/');
    },
  };
  await assert.rejects(
    () => HANDLERS.bnz_comment(unauthSession, { ids: ['999000100'], comment: 'hi' }),
    AuthRequiredError,
  );
});

const SAMPLE_CHROMIUM_CUSTOM_DEFS = [
  [1223084, 1363614, 7, false, 'OS', 'Operating system', null, ['Android', 'Fuchsia', 'Linux', 'Mac', 'Windows', 'iOS', 'ChromeOS']],
  [1491025, 1363614, 3, false, 'Safe Merge', 'Whether merge is safe', null, ['Yes', 'No']],
  [1223134, 1363614, 7, false, 'Merge-Request', 'Merge target milestones', null, ['156', '157', '158']],
  [1491024, 1363614, 4, false, 'Merge Milestone', 'Milestone number'],
  [1222905, 1363614, 2, false, 'NextAction', 'Next action date'],
  [1999999, 1363614, 1, false, 'HiddenInternalField', 'Hidden field'],
];
const SAMPLE_VISIBLE_CUSTOM_IDS = [1223084, 1491025, 1223134, 1491024, 1222905];

test('assignIssue handles New->Assigned, Assigned->New unassign, "me", and no-op', async () => {
  const id = '999999999010';
  const url = `https://issuetracker.google.com/issues/${id}`;
  try {
    // 1. Assigning a New (1) bug auto-transitions status to Assigned (2)
    const sAssign = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return { text: makeIssueFetchJspb({ id, statusId: 1, assignee: '' }) };
      }
      return { text: makeIssueFetchJspb({ id, statusId: 2, assignee: 'merges@chromium.org' }) };
    });
    const rAssign = await assignIssue(sAssign, id, { assignee: 'merges@chromium.org' });
    assert.equal(rAssign.action, 'assign');
    assert.equal(rAssign.assignee, 'merges@chromium.org');
    assert.equal(rAssign.status, 'Assigned');
    assert.deepEqual(sAssign.calls[1].body[6][1], [['status', 'assignee']]);
    assert.equal(sAssign.calls[1].body[6][2][2], 2);
    assert.deepEqual(sAssign.calls[1].body[6][2][7], ['merges@chromium.org']);

    // 2. Unassigning ("none") an Assigned (2) bug clears assignee in stateRemove + transitions to New (1)
    const sUnassign = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return { text: makeIssueFetchJspb({ id, statusId: 2, assignee: 'victorgomes@chromium.org' }) };
      }
      return { text: makeIssueFetchJspb({ id, statusId: 1, assignee: '' }) };
    });
    const rUnassign = await assignIssue(sUnassign, id, { assignee: 'none' });
    assert.equal(rUnassign.assignee, null);
    assert.equal(rUnassign.status, 'New');
    assert.deepEqual(sUnassign.calls[1].body[6][1], [['status']]);
    assert.equal(sUnassign.calls[1].body[6][2][2], 1);
    assert.deepEqual(sUnassign.calls[1].body[6][3], [['assignee']]);
    assert.deepEqual(sUnassign.calls[1].body[6][4][7], []);

    // 3. Assigning "me" on an already In Progress (3) bug updates assignee without altering status
    const sMe = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return { text: makeIssueFetchJspb({ id, statusId: 3, assignee: 'other@chromium.org' }) };
      }
      return { text: makeIssueFetchJspb({ id, statusId: 3, assignee: 'victorgomes@chromium.org' }) };
    });
    const rMe = await assignIssue(sMe, id, { assignee: 'me' });
    assert.equal(rMe.assignee, 'victorgomes@chromium.org');
    assert.equal(rMe.status, 'In Progress');
    assert.deepEqual(sMe.calls[1].body[6][1], [['assignee']]);

    // 4. Setting same assignee without comment is a clean no-op (no write RPC)
    const sNoop = makeMockSession(async () => ({
      text: makeIssueFetchJspb({ id, statusId: 2, assignee: 'victorgomes@chromium.org' }),
    }));
    const rNoop = await assignIssue(sNoop, id, { assignee: 'me' });
    assert.equal(rNoop.noOp, true);
    assert.equal(sNoop.calls.length, 1);
  } finally {
    invalidateIssueCache(url);
  }
});

test('parseCodeChangeEntry and editIssue handle Gerrit URLs, Critique CLs, and pending changes', async () => {
  const g1 = parseCodeChangeEntry('https://chromium-review.googlesource.com/c/v8/v8/+/8691333/3');
  assert.equal(g1.kind, 'gerrit');
  assert.equal(g1.host, 'chromium');
  assert.equal(g1.repo, 'v8/v8');
  assert.equal(g1.changeNumber, 8691333);
  assert.equal(g1.stateId, 2);

  const cl1 = parseCodeChangeEntry('cl/700111222');
  assert.deepEqual(cl1, { kind: 'changelist', changeNumber: '700111222', display: '700111222' });

  assert.throws(
    () => parseCodeChangeEntry('https://crrev.com/c/8691333'),
    /full Gerrit URL including the repository path/,
  );
  assert.throws(
    () => parseCodeChangeEntry('https://chromium-review.googlesource.com/8691333'),
    /full Gerrit URL including the repository path/,
  );

  const id = '999999999011';
  const url = `https://issuetracker.google.com/issues/${id}`;
  try {
    // Issue has one PENDING Gerrit change (stateId=1) and one existing MERGED Gerrit change (stateId=2).
    const sCode = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return {
          text: makeIssueFetchJspb({
            id,
            statusId: 2,
            assignee: 'victorgomes@chromium.org',
            gerritChanges: [
              ['chromium', 'v8/v8', 8000001, 1, 'main'], // PENDING (not in Code Changes)
              ['chromium', 'v8/v8', 8000002, 2, 'main'], // MERGED (in Code Changes)
            ],
          }),
        };
      }
      return {
        text: makeIssueFetchJspb({
          id,
          statusId: 2,
          assignee: 'victorgomes@chromium.org',
          changelists: ['700111222'],
          gerritChanges: [
            ['chromium', 'v8/v8', 8000001, 1, 'main'],
            ['chromium', 'v8/v8', 8691333, 2, 'main'],
          ],
        }),
      };
    });

    // Replace Code Changes with a new Gerrit URL + a Critique CL:
    // removes 8000002 (MERGED), leaves 8000001 (PENDING) untouched, adds 8691333 + CL 700111222.
    const res = await editIssue(sCode, id, {
      codeChanges: [
        'https://chromium-review.googlesource.com/c/v8/v8/+/8691333',
        '700111222',
      ],
    });
    assert.equal(res.noOp, false);
    const modReq = sCode.calls[1].body[6];
    assert.deepEqual(modReq[1], [['code_changes', 'gerrit_changes']]);
    assert.deepEqual(modReq[2][15], ['700111222']);
    assert.deepEqual(modReq[2][34], [['chromium', 'v8/v8', 8691333, 2]]);
    assert.deepEqual(modReq[3], [['gerrit_changes']]);
    assert.deepEqual(modReq[4][34], [['chromium', 'v8/v8', 8000002, 2, 'main']]);
  } finally {
    invalidateIssueCache(url);
  }
});

test('editIssue updates and clears OS and other custom fields using exact Buganizer JSPB slots', async () => {
  assert.deepEqual(
    buildCustomFieldValueJspb(1223084, 'REPEATED_ENUM', ['Android', 'Linux']),
    [1223084, null, null, null, null, null, null, [['Android', 'Linux']]],
  );
  assert.deepEqual(
    buildCustomFieldValueJspb(1491025, 'ENUM', 'Yes'),
    [1491025, null, null, 'Yes'],
  );
  assert.deepEqual(
    buildCustomFieldValueJspb(1491024, 'NUMERIC', 157),
    [1491024, null, null, null, 157],
  );
  assert.deepEqual(
    buildCustomFieldValueJspb(1222905, 'DATE', '2026-11-15'),
    [1222905, null, [2026, 11, 15]],
  );
  assert.deepEqual(buildCustomFieldClearJspb(1223084), [1223084, '']);

  const id = '999999999012';
  const url = `https://issuetracker.google.com/issues/${id}`;
  try {
    const existingCustomValues = [
      buildCustomFieldValueJspb(1223084, 'REPEATED_ENUM', ['Android', 'Windows', 'Linux']),
      buildCustomFieldValueJspb(1491025, 'ENUM', 'No'),
    ];

    // 1. Append "chromeos" (case-insensitive -> "ChromeOS"), remove "windows", set Safe Merge=Yes, clear Safe Merge? No, set Safe Merge=Yes + Merge Milestone=157
    const sEdit = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return {
          text: makeIssueFetchJspb({
            id,
            statusId: 2,
            assignee: 'victorgomes@chromium.org',
            customFieldDefs: SAMPLE_CHROMIUM_CUSTOM_DEFS,
            visibleCustomIds: SAMPLE_VISIBLE_CUSTOM_IDS,
            customFieldValues: existingCustomValues,
          }),
        };
      }
      return { text: makeIssueFetchJspb({ id, statusId: 2, assignee: 'merges@chromium.org' }) };
    });

    const rEdit = await editIssue(sEdit, id, {
      assignee: 'merges@chromium.org',
      addCodeChanges: ['https://chromium-review.googlesource.com/c/v8/v8/+/8691333'],
      fieldOps: [
        { name: 'OS', op: 'add', value: 'chromeos' },
        { name: 'OS', op: 'remove', value: 'windows' },
        { name: 'Safe Merge', op: 'set', value: 'yes' },
        { name: 'Merge Milestone', op: 'set', value: '157' },
      ],
    });
    assert.equal(rEdit.assignee, 'merges@chromium.org');
    const modReq = sEdit.calls[1].body[6];
    assert.deepEqual(modReq[1], [['assignee', 'custom_fields', 'gerrit_changes']]);
    assert.deepEqual(modReq[2][14], [
      [1223084, null, null, null, null, null, null, [['Android', 'Linux', 'ChromeOS']]],
      [1491025, null, null, 'Yes'],
      [1491024, null, null, null, 157],
    ]);

    // 2. Clearing OS + Safe Merge sends `[id, ""]` in stateRemove[14] (`removeMask: ["custom_fields"]`)
    const sClear = makeMockSession(async (path) => {
      if (path.endsWith('/getIssue')) {
        return {
          text: makeIssueFetchJspb({
            id,
            statusId: 2,
            assignee: 'victorgomes@chromium.org',
            customFieldDefs: SAMPLE_CHROMIUM_CUSTOM_DEFS,
            visibleCustomIds: SAMPLE_VISIBLE_CUSTOM_IDS,
            customFieldValues: existingCustomValues,
          }),
        };
      }
      return { text: makeIssueFetchJspb({ id, statusId: 2, assignee: 'victorgomes@chromium.org' }) };
    });
    await editIssue(sClear, id, {
      fieldOps: [
        { name: 'OS', op: 'clear', value: null },
        { name: 'Safe Merge', op: 'set', value: 'none' },
      ],
    });
    const clearReq = sClear.calls[1].body[6];
    assert.deepEqual(clearReq[1], []);
    assert.deepEqual(clearReq[3], [['custom_fields']]);
    assert.deepEqual(clearReq[4][14], [
      [1223084, ''],
      [1491025, ''],
    ]);

    // 3. Invalid enum choice lists allowed values
    await assert.rejects(
      () => editIssue(sClear, id, {
        fieldOps: [{ name: 'OS', op: 'set', value: 'Solaris' }],
        dryRun: true,
      }),
      /Invalid value "Solaris" for custom field "OS".*Allowed values: Android, Fuchsia, Linux/,
    );
  } finally {
    invalidateIssueCache(url);
  }
});

test('fetchIssueFields filters hidden unpopulated custom fields unless full=true', async () => {
  const id = '999999999013';
  const session = makeMockSession(async () => ({
    text: makeIssueFetchJspb({
      id,
      statusId: 2,
      assignee: 'victorgomes@chromium.org',
      customFieldDefs: SAMPLE_CHROMIUM_CUSTOM_DEFS,
      visibleCustomIds: SAMPLE_VISIBLE_CUSTOM_IDS,
      customFieldValues: [
        buildCustomFieldValueJspb(1223084, 'REPEATED_ENUM', ['Linux']),
      ],
    }),
  }));

  const defFields = await fetchIssueFields(session, id);
  assert.equal(defFields.customFields.length, 5);
  assert.equal(defFields.hiddenCustomFieldCount, 1);
  assert.deepEqual(defFields.customFields.find((f) => f.name === 'OS').value, ['Linux']);

  const allFields = await fetchIssueFields(session, id, { full: true });
  assert.equal(allFields.customFields.length, 6);
  assert.equal(allFields.hiddenCustomFieldCount, 0);
});

test('CLI prepareAssignInvocation, prepareEditInvocation, prepareFieldsInvocation, and renderers', () => {
  const aAssign = parseArgs(['assign', '579236924', 'merges@chromium.org', '--dry-run']);
  const pAssign = prepareAssignInvocation(aAssign._.slice(1), aAssign);
  assert.deepEqual(pAssign.targets, ['579236924']);
  assert.equal(pAssign.assignee, 'merges@chromium.org');
  assert.equal(pAssign.dryRun, true);

  const aUnassign = parseArgs(['unassign', 'b/579236924, 123456']);
  const pUnassign = prepareAssignInvocation(aUnassign._.slice(1), aUnassign, { isUnassign: true });
  assert.deepEqual(pUnassign.targets, ['b/579236924', '123456']);
  assert.equal(pUnassign.assignee, 'none');

  // Positional `OS=Android,Linux` must NOT be split on commas into separate targets!
  const aEdit = parseArgs([
    'edit',
    'https://issues.chromium.org/u/1/issues/579236924',
    'OS=Android,Linux',
    'Merge-Request+=157',
    '--add-code-change=https://chromium-review.googlesource.com/c/v8/v8/+/8691333',
    '--assignee=merges@chromium.org',
    '-f', 'Safe Merge=Yes',
  ]);
  const pEdit = prepareEditInvocation(aEdit._.slice(1), aEdit);
  assert.deepEqual(pEdit.targets, ['https://issues.chromium.org/u/1/issues/579236924']);
  assert.equal(pEdit.assignee, 'merges@chromium.org');
  assert.deepEqual(pEdit.addCodeChanges, ['https://chromium-review.googlesource.com/c/v8/v8/+/8691333']);
  assert.deepEqual(pEdit.fieldOps, [
    { name: 'Safe Merge', op: 'set', value: 'Yes' },
    { name: 'OS', op: 'set', value: 'Android,Linux' },
    { name: 'Merge-Request', op: 'add', value: '157' },
  ]);

  assert.deepEqual(parseFieldSpec('OS-=Windows'), { name: 'OS', op: 'remove', value: 'Windows' });
  assert.deepEqual(prepareFieldsInvocation(['579236924, b/123']).targets, ['579236924', 'b/123']);

  const editMd = renderEditMarkdown({
    id: '579236924',
    url: 'https://issuetracker.google.com/issues/579236924',
    title: '[Merge M157] Sample',
    assignee: 'merges@chromium.org',
    changes: [
      { field: 'Assignee', before: 'victorgomes@chromium.org', after: 'merges@chromium.org' },
      { field: 'Code Changes', before: [], after: ['https://chromium-review.googlesource.com/c/v8/v8/+/8691333'] },
      { field: 'OS', before: ['Linux'], after: ['Android', 'Linux'] },
    ],
    action: 'edit',
    dryRun: true,
  }, false);
  assert.match(editMd, /# Dry run: Edit Issue 579236924/);
  assert.match(editMd, /\*\*Code Changes\*\*: <none> -> https:\/\/chromium-review\.googlesource\.com\/c\/v8\/v8\/\+\/8691333/);
  assert.match(editMd, /\*\*OS\*\*: Linux -> Android, Linux/);

  const fieldsMd = renderFieldsMarkdown({
    id: '579236924',
    url: 'https://issuetracker.google.com/issues/579236924',
    title: '[Merge M157] Sample',
    standardFields: {
      status: 'Assigned',
      type: 'Bug',
      priority: 'P1',
      severity: 'S1',
      componentId: '1456355',
      assignee: 'victorgomes@chromium.org',
      verifier: null,
      reporter: 'chrome-Automated-process@google.com',
      codeChanges: [],
      cc: [],
      collaborators: [],
    },
    customFields: [
      {
        id: '1223084',
        name: 'OS',
        type: 'REPEATED_ENUM',
        value: ['Android', 'Linux'],
        allowedValues: ['Android', 'Linux', 'Mac'],
      },
    ],
    hiddenCustomFieldCount: 2,
  }, false);
  assert.match(fieldsMd, /# Fields for Issue 579236924/);
  assert.match(fieldsMd, /\| OS \| 1223084 \| REPEATED_ENUM \| Android, Linux \| Android, Linux, Mac \|/);
  assert.match(fieldsMd, /2 unpopulated hidden tracker field\(s\) omitted/);
});

test('MCP bnz_fields and bnz_edit handlers inspect and preview field updates', async () => {
  const toolNames = TOOLS.map((t) => t.name);
  assert.ok(toolNames.includes('bnz_fields'));
  assert.ok(toolNames.includes('bnz_edit'));

  const session = makeMockSession(async () => ({
    text: makeIssueFetchJspb({
      id: 579236924,
      statusId: 2,
      assignee: 'victorgomes@chromium.org',
      customFieldDefs: SAMPLE_CHROMIUM_CUSTOM_DEFS,
      visibleCustomIds: SAMPLE_VISIBLE_CUSTOM_IDS,
      customFieldValues: [
        buildCustomFieldValueJspb(1223084, 'REPEATED_ENUM', ['Android', 'Windows', 'Linux']),
      ],
    }),
  }));

  const fieldsRes = await HANDLERS.bnz_fields(session, {
    ids: ['579236924'],
    format: 'json',
  });
  assert.equal(fieldsRes.isError, undefined);
  const fieldsJson = JSON.parse(fieldsRes.content[0].text);
  assert.equal(fieldsJson[0].id, '579236924');
  assert.deepEqual(
    fieldsJson[0].customFields.find((f) => f.name === 'OS').value,
    ['Android', 'Windows', 'Linux'],
  );

  const editRes = await HANDLERS.bnz_edit(session, {
    ids: ['https://issues.chromium.org/u/1/issues/579236924'],
    assignee: 'merges@chromium.org',
    add_code_changes: ['https://chromium-review.googlesource.com/c/v8/v8/+/8691333'],
    fields: { 'Safe Merge': 'Yes' },
    remove_fields: { OS: ['Windows'] },
    dry_run: true,
    format: 'json',
  });
  assert.equal(editRes.isError, undefined);
  const editJson = JSON.parse(editRes.content[0].text);
  assert.equal(editJson[0].dryRun, true);
  assert.equal(editJson[0].assignee, 'merges@chromium.org');
  assert.deepEqual(
    editJson[0].changes.find((c) => c.field === 'OS').after,
    ['Android', 'Linux'],
  );
  assert.deepEqual(
    editJson[0].changes.find((c) => c.field === 'Code Changes').after,
    ['https://chromium-review.googlesource.com/c/v8/v8/+/8691333'],
  );
});
