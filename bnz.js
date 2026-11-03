#!/usr/bin/env node
// bnz — fetch authenticated content from issuetracker.google.com (Buganizer)
// and clusterfuzz.com via a persistent headless Chromium session.
//
// Page content is converted to faithful markdown by walking the rendered DOM
// (light + shadow) — we don't try to interpret the SPA's component structure
// beyond what's needed to act (extracting testcase links, command-line flags,
// attachment URLs, reproducer download endpoints).

import { realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AuthRequiredError, exportSessionState, importSessionState,
  loginInteractive, openSession, pushSessionOverSsh,
} from './lib/browser.js';
import {
  DEFAULT_LIST_QUERY, computeIssueSlo, extractSearchHits, extractSearchRows,
  fetchIssue, fetchTestcase, parseSince, searchIssues, sortHitsBySlo,
} from './lib/fetch.js';
import {
  assignIssue, closeIssue, commentIssue, editIssue, fetchIssueFields,
  normalizeStatusToken, parseCodeChangeEntry, resolveCloseStatus,
  resolveIssueStatus, resolveIssueType, resolvePriority, resolveSeverity,
  tryResolveIssueType,
} from './lib/mutate.js';
import {
  chromiumIssueUrl, chromiumSearchUrl, resolveCfTarget, resolveIssueUrl,
} from './lib/url.js';
import {
  appendix, header, makeColors, sanitizeDeep, sanitizeTerminalText,
} from './lib/render.js';
import {
  CLUSTERFUZZ_TESTCASE_RE, downloadTestcases, findTestcaseKeysInMarkdown, readCfInputs,
} from './lib/cf-download.js';

// ---------- arg parsing ----------

function usage() {
  console.error(`bnz — fetch Buganizer issues and ClusterFuzz testcases as markdown.

Usage:
  bnz login [--with-cf]                  Interactive Google SSO for issuetracker (and clusterfuzz).
  bnz login [--with-cf] --export[=HOST]  Mint an isolated remote session and push to SSH HOST (or stdout).
  bnz login --import[=FILE]              Import session cookies from stdin (or FILE).
  bnz cf login [--export[=HOST]]         Interactive Google SSO for clusterfuzz (local or isolated export).

  bnz <id|url> [<id|url>...]             Fetch one or more issues.
  bnz fields <id|url> [...] [--full]     List standard and custom fields + allowed values.
  bnz assign <id|url> [...] <email|me|none>  Assign (or unassign with "none") one or more issues.
  bnz unassign <id|url> [...]            Clear assignee on one or more issues.
  bnz type <id|url> [...] <bug|vuln|...> Change issue type (e.g. Vulnerability -> Bug).
  bnz priority <id|url> [...] <P0..P4>   Change priority (alias: bnz pri; accepts P0..P4 or 0..4).
  bnz severity <id|url> [...] <S0..S4>   Change severity (alias: bnz sev; accepts S0..S4 or 0..4).
  bnz edit <id|url> [...] [options]      Update standard or custom fields (alias: bnz set).
  bnz comment <id|url> "<text>"          Post a comment on an issue (Markdown by default).
  bnz comment <id|url> [...] -m "<text>" Post a comment on one or more issues (or -F <file>).
  bnz close <id|url> [...] [options]     Close one or more issues (default status: Fixed).
  bnz cf <key|url|issue-id> [...]        Fetch one or more clusterfuzz testcases.
                                         (Numeric input: 14+ digits = testcase key.)
                                         IDs may be comma-separated, quoted or unquoted.
  bnz list ["<query>"]                   Search issuetracker (default: "assignee:me status:open").

Edit & field options (for \`bnz edit\`, \`bnz type\`, \`bnz priority\`, \`bnz severity\`, \`bnz assign\`):
  --assignee=<email|me|none>             Set assignee, or pass "none" (or --unassign) to clear.
  -p, --priority=<P0..P4|0..4>           Set priority (or shorthand --p0 .. --p4; alias: --pri).
  -S, --severity=<S0..S4|0..4>           Set severity (or shorthand --s0 .. --s4; alias: --sev).
  -t, --type=<type>                      Set issue type (bug, vulnerability/vuln, feature-request, task, ...).
  --bug | --vulnerability (--vuln)       Shorthand flags for --type=bug or --type=vulnerability.
  -s, --status=<status>                  Set status (new, assigned, in-progress, or close status).
  --title=<text>                         Set issue title.
  --component=<id>                       Move issue to numeric component ID.
  --verifier=<email|me|none>             Set or clear verifier.
  --code-changes=<url|cl,...>            Replace Code Changes (full Gerrit /c/<repo>/+/<cl> URL or CL).
  --add-code-change=<url|cl,...>         Append to Code Changes without removing existing entries.
  --remove-code-change=<url|cl,...>      Remove entry from Code Changes.
  --os=<os,...> | --add-os | --remove-os Set, append, or remove values on the OS custom field.
  --cc=<emails> | --add-cc | --remove-cc Replace, add, or remove CC emails ("me" supported).
  --collaborators=<emails> | --add-collaborator | --remove-collaborator
  -f, --field "<Name>=<Value>"           Set any custom or standard field (repeatable; also supports
                                         "Name+=Val" to append and "Name-=Val" to remove).
  --add-field "<Name>=<Value>"           Append value(s) to a repeated custom or standard field.
  --remove-field "<Name>=<Value>"        Remove value(s) from a repeated custom or standard field.
  --clear-field "<Name>"                 Clear a custom or standard field.

Close options (for \`bnz close\`):
  -s, --status=<status>                  Close resolution (default: fixed):
                                           fixed              Fixed
                                           verified           Fixed (Verified)
                                           duplicate          Duplicate (requires --duplicate-of)
                                           wontfix|infeasible Won't fix (Infeasible)
                                           wai|intended-behavior  Won't fix (Intended behavior)
                                           norepro|not-reproducible  Won't fix (Not reproducible)
                                           obsolete           Won't fix (Obsolete)
                                           inactive           Inactive
  --fixed | --verified | --inactive      Shorthands for --status=...
  --wont-fix[=<reason>]                  Won't fix (default: infeasible; or wai, norepro, obsolete).
  --wai | --intended-behavior            Shorthand for Won't fix (Intended behavior).
  --norepro | --not-reproducible         Shorthand for Won't fix (Not reproducible).
  --obsolete | --infeasible              Shorthands for Won't fix (Obsolete / Infeasible).
  --duplicate=<id|url>                   Mark as Duplicate of target issue (alias: --duplicate-of).
  --assignee=<email|me>                  Set assignee when closing (auto-assigns to you if unassigned
                                         and closing as Fixed or Verified).

Comment & mutation flags (for \`bnz comment\`, \`bnz close\`, \`bnz assign\`, \`bnz edit\`):
  -m, --message=<text>                   Comment text (alias: --comment=<text>).
  -F, --file=<path>                      Read comment text from file (- for stdin).
  --plain                                Post comment as plain text instead of Markdown.
  -n, --dry-run                          Verify access and preview changes without mutating Buganizer.

Flags:
  --format=markdown|json                 Output format. markdown is the default; json emits a
                                         structured object (or array, for multiple targets).
  --download-original                    cf: also fetch the original (unminimized) reproducer.
  --download[=DIR]                       cf: save testcase files (default DIR: cwd), without a page dump.
  --variant=minimized|original|both      cf --download: select files (default: minimized).
  --ids-file=FILE                        cf: read whitespace/comma-separated IDs or URLs; - for stdin.
                                         A positional - also reads targets from stdin.
                                         With no targets, redirected stdin is read automatically.
  --jobs=N                              cf --download: concurrent downloads (default 4, maximum 16).
  --download-attachments[=DIR]           Download all attachment URLs found on the page(s).
                                         DIR defaults to the cwd. Filenames come from the link
                                         text where available, else the URL basename.
  --full                                 Skip the chrome filter — dump the entire page, including
                                         top bar, side nav, FABs, and interactive buttons. By
                                         default the output is the issue body only.
  --slo                                  list: group and sort issues by Chromium SLO deadlines.
  --since=<dur>                          list: keep only hits modified since the duration ago.
                                         e.g. --since=7d, --since=1w, --since=2026-05-01.
  --max-pages=N                          list: cap pagination at N pages of 50 hits (default 30).
  --refresh                              Bypass the cache for this fetch (still writes back).
  --no-cache                             Disable cache reads and writes.
  --debug                                Include raw HTML in json output.
  --with-cf                              login: open both issuetracker and clusterfuzz in one browser.
  --export[=SSH_HOST]                    login: mint an isolated remote session (never shares local
                                         profile) and push cookies to SSH_HOST (or JSON to stdout).
  --import[=FILE]                        login: import session JSON from stdin (or FILE).
  --no-color                             Disable ANSI color (also honors NO_COLOR).
  -h, --help                             Show this help.

Cache:
  Pages are cached at ~/.config/bnz/cache/ with a 5-minute TTL.
`);
}

function parseFieldSpec(raw, forcedOp = null) {
  const s = String(raw ?? '');
  const eqIdx = s.indexOf('=');
  if (eqIdx <= 0) {
    throw new Error(`Expected "<Field>=<Value>" (got "${s}")`);
  }
  let op = forcedOp || 'set';
  let namePart = s.slice(0, eqIdx);
  if (!forcedOp && eqIdx > 1 && s[eqIdx - 1] === '+') {
    op = 'add';
    namePart = s.slice(0, eqIdx - 1);
  } else if (!forcedOp && eqIdx > 1 && s[eqIdx - 1] === '-') {
    op = 'remove';
    namePart = s.slice(0, eqIdx - 1);
  }
  const name = namePart.trim();
  if (!name) throw new Error(`Expected non-empty field name before "=" in "${s}"`);
  return { name, op, value: s.slice(eqIdx + 1) };
}

function parseArgs(argv) {
  const args = {
    _: [],
    format: 'markdown',
    useCache: true,
    refresh: false,
    downloadOriginal: false,
    downloadAttachments: null,
    download: null,
    jobs: 4,
    status: null,
    statusFromShorthand: false,
    duplicateOf: null,
    assignee: null,
    priority: null,
    severity: null,
    type: null,
    title: null,
    componentId: null,
    verifier: null,
    cc: undefined,
    addCc: [],
    removeCc: [],
    collaborators: undefined,
    addCollaborators: [],
    removeCollaborators: [],
    codeChanges: undefined,
    addCodeChanges: [],
    removeCodeChanges: [],
    fieldOps: [],
    comment: null,
    commentFile: null,
    markdown: true,
    dryRun: false,
  };

  const setCloseStatus = (val, fromShorthand = false) => {
    if (!val) throw new Error('Expected a non-empty status');
    if (args.status && normalizeStatusToken(args.status) !== normalizeStatusToken(val)) {
      throw new Error(`Conflicting statuses: "${args.status}" and "${val}"`);
    }
    args.status = val;
    if (fromShorthand) args.statusFromShorthand = true;
  };
  const setComment = (val) => {
    if (args.comment !== null) throw new Error('Multiple -m/--message/--comment flags passed');
    args.comment = val;
  };
  const setCommentFile = (val) => {
    if (!val) throw new Error('Expected a file path after -F/--file');
    if (args.commentFile !== null) throw new Error('Multiple -F/--file flags passed');
    args.commentFile = val;
  };
  const setDuplicateOf = (val, flag) => {
    if (!val || val.startsWith('-')) {
      throw new Error(`Expected a target issue id or URL after ${flag}`);
    }
    if (args.duplicateOf && args.duplicateOf !== val) {
      throw new Error(`Conflicting duplicate targets: "${args.duplicateOf}" and "${val}"`);
    }
    args.duplicateOf = val;
  };
  const setPriority = (val) => {
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new Error('Expected a priority (P0..P4 or 0..4)');
    }
    if (args.priority !== null) {
      let same = normalizeStatusToken(args.priority) === normalizeStatusToken(val);
      if (!same) {
        try { same = resolvePriority(args.priority).id === resolvePriority(val).id; } catch {}
      }
      if (!same) throw new Error(`Conflicting priorities: "${args.priority}" and "${val}"`);
    }
    args.priority = String(val);
  };
  const setSeverity = (val) => {
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new Error('Expected a severity (S0..S4 or 0..4)');
    }
    if (args.severity !== null) {
      let same = normalizeStatusToken(args.severity) === normalizeStatusToken(val);
      if (!same) {
        try { same = resolveSeverity(args.severity).id === resolveSeverity(val).id; } catch {}
      }
      if (!same) throw new Error(`Conflicting severities: "${args.severity}" and "${val}"`);
    }
    args.severity = String(val);
  };
  const setType = (val) => {
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new Error('Expected an issue type (e.g. bug, vulnerability, feature-request, task)');
    }
    if (args.type !== null) {
      let same = normalizeStatusToken(args.type) === normalizeStatusToken(val);
      if (!same) {
        const a = tryResolveIssueType(args.type);
        const b = tryResolveIssueType(val);
        if (a && b) same = a.id === b.id;
      }
      if (!same) throw new Error(`Conflicting issue types: "${args.type}" and "${val}"`);
    }
    args.type = String(val);
  };
  const takeVal = (iRef, flag) => {
    const eq = flag.indexOf('=');
    if (eq !== -1) return flag.slice(eq + 1);
    if (iRef.i + 1 >= argv.length) throw new Error(`Expected a value after ${flag}`);
    return argv[++iRef.i];
  };

  const iRef = { i: 0 };
  for (; iRef.i < argv.length; iRef.i++) {
    const a = argv[iRef.i];
    if (a === '--') {
      args._.push(...argv.slice(iRef.i + 1));
      break;
    }
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-color') args.noColor = true;
    else if (a === '--debug') args.debug = true;
    else if (a === '--full') args.full = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--no-cache') args.useCache = false;
    else if (a === '--download-original') args.downloadOriginal = true;
    else if (a === '--download') args.download = '.';
    else if (a.startsWith('--download=')) args.download = a.slice('--download='.length);
    else if (a.startsWith('--variant=')) args.variant = a.slice('--variant='.length);
    else if (a.startsWith('--ids-file=')) args.idsFile = a.slice('--ids-file='.length);
    else if (a.startsWith('--jobs=')) args.jobs = Number(a.slice('--jobs='.length));
    else if (a === '--download-attachments') args.downloadAttachments = '.';
    else if (a.startsWith('--download-attachments=')) {
      args.downloadAttachments = a.slice('--download-attachments='.length);
    }
    else if (a === '--with-cf') args.withCf = true;
    else if (a === '--export') args.export = '-';
    else if (a.startsWith('--export=')) args.export = a.slice('--export='.length);
    else if (a === '--import') args.import = '-';
    else if (a.startsWith('--import=')) args.import = a.slice('--import='.length);
    else if (a.startsWith('--format=')) args.format = a.slice('--format='.length);
    else if (a === '--slo') args.slo = true;
    else if (a.startsWith('--since=')) args.since = a.slice('--since='.length);
    else if (a.startsWith('--max-pages=')) args.maxPages = parseInt(a.slice('--max-pages='.length), 10);
    else if (a === '--plain') args.markdown = false;
    else if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '-m' || a === '--message' || a === '--comment' ||
             a.startsWith('-m=') || a.startsWith('--message=') || a.startsWith('--comment=')) {
      setComment(takeVal(iRef, a));
    }
    else if (a === '-F' || a === '--file' || a === '--comment-file' ||
             a.startsWith('-F=') || a.startsWith('--file=') || a.startsWith('--comment-file=')) {
      setCommentFile(takeVal(iRef, a));
    }
    else if (a === '-s' || a === '--status' || a.startsWith('-s=') || a.startsWith('--status=')) {
      setCloseStatus(takeVal(iRef, a));
    }
    else if (a === '--fixed') setCloseStatus('fixed', true);
    else if (a === '--verified') setCloseStatus('verified', true);
    else if (a === '--inactive') setCloseStatus('inactive', true);
    else if (a === '--obsolete') setCloseStatus('obsolete', true);
    else if (a === '--infeasible') setCloseStatus('infeasible', true);
    else if (a === '--wai' || a === '--intended-behavior') setCloseStatus('intended-behavior', true);
    else if (a === '--norepro' || a === '--not-reproducible' || a === '--cant-repro') {
      setCloseStatus('not-reproducible', true);
    }
    else if (a === '--wont-fix' || a === '--wontfix') setCloseStatus('wontfix', true);
    else if (a.startsWith('--wont-fix=')) {
      const sub = a.slice('--wont-fix='.length);
      if (!sub) throw new Error('Expected a reason after --wont-fix=');
      setCloseStatus('wontfix:' + sub, true);
    }
    else if (a.startsWith('--wontfix=')) {
      const sub = a.slice('--wontfix='.length);
      if (!sub) throw new Error('Expected a reason after --wontfix=');
      setCloseStatus('wontfix:' + sub, true);
    }
    else if (a === '--duplicate' || a === '--duplicate-of' || a === '--dup' ||
             a.startsWith('--duplicate=') || a.startsWith('--duplicate-of=') || a.startsWith('--dup=')) {
      setDuplicateOf(takeVal(iRef, a), a.split('=')[0]);
    }
    else if (a === '--assignee' || a.startsWith('--assignee=')) {
      const val = takeVal(iRef, a);
      if (!val) throw new Error('Expected an email, "me", or "none" after --assignee');
      args.assignee = val;
    }
    else if (a === '--unassign') {
      args.assignee = 'none';
    }
    else if (a === '-p' || a === '--priority' || a === '--pri' ||
             a.startsWith('-p=') || a.startsWith('--priority=') || a.startsWith('--pri=')) {
      setPriority(takeVal(iRef, a));
    }
    else if (/^--p[0-4]$/i.test(a)) {
      setPriority(a.slice(2).toUpperCase());
    }
    else if (a === '-S' || a === '--severity' || a === '--sev' ||
             a.startsWith('-S=') || a.startsWith('--severity=') || a.startsWith('--sev=')) {
      setSeverity(takeVal(iRef, a));
    }
    else if (/^--s[0-4]$/i.test(a)) {
      setSeverity(a.slice(2).toUpperCase());
    }
    else if (a === '-t' || a === '--type' || a.startsWith('-t=') || a.startsWith('--type=')) {
      setType(takeVal(iRef, a));
    }
    else if (a === '--bug') {
      setType('bug');
    }
    else if (a === '--vulnerability' || a === '--vuln') {
      setType('vulnerability');
    }
    else if (a === '--feature-request') {
      setType('feature-request');
    }
    else if (a === '--title' || a.startsWith('--title=')) {
      args.title = takeVal(iRef, a);
    }
    else if (a === '--component' || a === '--component-id' ||
             a.startsWith('--component=') || a.startsWith('--component-id=')) {
      args.componentId = takeVal(iRef, a);
    }
    else if (a === '--verifier' || a.startsWith('--verifier=')) {
      args.verifier = takeVal(iRef, a);
    }
    else if (a === '--cc' || a.startsWith('--cc=')) {
      args.cc = takeVal(iRef, a);
    }
    else if (a === '--add-cc' || a.startsWith('--add-cc=')) {
      args.addCc.push(takeVal(iRef, a));
    }
    else if (a === '--remove-cc' || a.startsWith('--remove-cc=')) {
      args.removeCc.push(takeVal(iRef, a));
    }
    else if (a === '--collaborators' || a.startsWith('--collaborators=')) {
      args.collaborators = takeVal(iRef, a);
    }
    else if (a === '--add-collaborator' || a === '--add-collaborators' ||
             a.startsWith('--add-collaborator=') || a.startsWith('--add-collaborators=')) {
      args.addCollaborators.push(takeVal(iRef, a));
    }
    else if (a === '--remove-collaborator' || a === '--remove-collaborators' ||
             a.startsWith('--remove-collaborator=') || a.startsWith('--remove-collaborators=')) {
      args.removeCollaborators.push(takeVal(iRef, a));
    }
    else if (a === '--code-changes' || a === '--code-change' ||
             a.startsWith('--code-changes=') || a.startsWith('--code-change=')) {
      args.codeChanges = takeVal(iRef, a);
    }
    else if (a === '--add-code-change' || a === '--add-code-changes' ||
             a.startsWith('--add-code-change=') || a.startsWith('--add-code-changes=')) {
      args.addCodeChanges.push(takeVal(iRef, a));
    }
    else if (a === '--remove-code-change' || a === '--remove-code-changes' ||
             a.startsWith('--remove-code-change=') || a.startsWith('--remove-code-changes=')) {
      args.removeCodeChanges.push(takeVal(iRef, a));
    }
    else if (a === '--os' || a.startsWith('--os=')) {
      args.fieldOps.push({ name: 'OS', op: 'set', value: takeVal(iRef, a) });
    }
    else if (a === '--add-os' || a.startsWith('--add-os=')) {
      args.fieldOps.push({ name: 'OS', op: 'add', value: takeVal(iRef, a) });
    }
    else if (a === '--remove-os' || a.startsWith('--remove-os=')) {
      args.fieldOps.push({ name: 'OS', op: 'remove', value: takeVal(iRef, a) });
    }
    else if (a === '-f' || a === '--field' || a.startsWith('-f=') || a.startsWith('--field=')) {
      args.fieldOps.push(parseFieldSpec(takeVal(iRef, a)));
    }
    else if (a === '--add-field' || a.startsWith('--add-field=')) {
      args.fieldOps.push(parseFieldSpec(takeVal(iRef, a), 'add'));
    }
    else if (a === '--remove-field' || a.startsWith('--remove-field=')) {
      args.fieldOps.push(parseFieldSpec(takeVal(iRef, a), 'remove'));
    }
    else if (a === '--clear-field' || a.startsWith('--clear-field=')) {
      const name = takeVal(iRef, a).trim();
      if (!name) throw new Error('Expected a field name after --clear-field');
      args.fieldOps.push({ name, op: 'clear', value: null });
    }
    else args._.push(a);
  }
  if (!['markdown', 'json'].includes(args.format)) {
    throw new Error(`Unknown --format: ${args.format} (expected markdown or json)`);
  }
  args.variant ??= args.downloadOriginal ? 'both' : 'minimized';
  if (!['minimized', 'original', 'both'].includes(args.variant)) {
    throw new Error('Expected --variant=minimized|original|both');
  }
  if (!Number.isInteger(args.jobs) || args.jobs < 1 || args.jobs > 16) {
    throw new Error('--jobs must be an integer from 1 to 16');
  }
  if (args.download === '' || args.idsFile === '') throw new Error('Expected a nonempty path');
  if ((args.download || args.idsFile || args._.includes('-')) && args._[0] !== 'cf') {
    throw new Error('--download, --ids-file and stdin targets require cf');
  }
  if (args.export === '') throw new Error('Expected an SSH host after --export=');
  if (args.export && args.export !== '-' && (args.export.startsWith('-') || /\s/.test(args.export))) {
    throw new Error(`Invalid SSH host for --export: ${args.export}`);
  }
  if (args.import === '') throw new Error('Expected a file path after --import=');
  if (args.export && args.import) throw new Error('Cannot combine --export and --import');
  if (args.comment !== null && args.commentFile !== null) {
    throw new Error('Cannot combine -m/--message and -F/--file');
  }
  if (!args.help) {
    const cmd = args._[0];
    const isEdit =
      cmd === 'edit' || cmd === 'set' ||
      cmd === 'type' ||
      cmd === 'priority' || cmd === 'pri' ||
      cmd === 'severity' || cmd === 'sev';
    const isAssign = cmd === 'assign' || cmd === 'unassign';
    const isMutate = cmd === 'comment' || cmd === 'close' || isEdit || isAssign;
    const hasEditOnlyFlags =
      args.priority !== null ||
      args.severity !== null ||
      args.type !== null ||
      args.title !== null ||
      args.componentId !== null ||
      args.verifier !== null ||
      args.cc !== undefined || args.addCc.length > 0 || args.removeCc.length > 0 ||
      args.collaborators !== undefined || args.addCollaborators.length > 0 || args.removeCollaborators.length > 0 ||
      args.codeChanges !== undefined || args.addCodeChanges.length > 0 || args.removeCodeChanges.length > 0 ||
      args.fieldOps.length > 0;

    if (args.slo && cmd !== 'list') {
      throw new Error('--slo requires list');
    }
    if (args.duplicateOf && cmd !== 'close') {
      throw new Error('--duplicate requires `bnz close`');
    }
    if (args.status && cmd !== 'close' && !isEdit) {
      throw new Error('Status flags require `bnz close` or `bnz edit`');
    }
    if (args.assignee !== null && cmd !== 'close' && !isEdit && !isAssign) {
      throw new Error('--assignee and --unassign require `bnz assign`, `bnz edit`, or `bnz close`');
    }
    if (hasEditOnlyFlags && !isEdit) {
      throw new Error(
        'Field modification flags require `bnz edit`, `bnz type`, `bnz priority`, or `bnz severity` ' +
        '(e.g. `bnz edit <id> --bug -p P2 -S S4`)',
      );
    }
    if (
      (args.comment !== null || args.commentFile !== null || !args.markdown || args.dryRun) &&
      !isMutate
    ) {
      throw new Error(
        'Comment, --plain, and --dry-run flags require `bnz comment`, `bnz close`, `bnz assign`, `bnz edit`, `bnz type`, `bnz priority`, or `bnz severity`',
      );
    }
    const isLogin = cmd === 'login' || (cmd === 'cf' && args._[1] === 'login');
    if ((args.export || args.import) && !isLogin) {
      throw new Error('--export and --import require login');
    }
    if (args.withCf && cmd !== 'login') {
      throw new Error('--with-cf requires `bnz login`');
    }
    if (args.withCf && args.import) {
      throw new Error('Cannot combine --with-cf and --import');
    }
    if (isLogin) {
      const rest = cmd === 'cf' ? args._.slice(2) : args._.slice(1);
      if (rest.length) throw new Error(`Unexpected argument to login: ${rest[0]}`);
    }
  }
  return args;
}

// ---------- fetching ----------

function findTestcaseKeyInMarkdown(markdown) {
  return findTestcaseKeysInMarkdown(markdown)[0] ?? null;
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
  const displayUrl = data.id ? chromiumIssueUrl(data.id) : (data.finalUrl || data.url);
  out.push(header(c, `Issue ${data.id}`, displayUrl));
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

function formatSloDue(dateStr, remDays, c, colorEnabled) {
  if (!dateStr || remDays === null || remDays === undefined) return '—';
  const label = `${dateStr} (${remDays}d)`;
  if (remDays < 0) return colorEnabled ? c.red(label) : `**${label}**`;
  if (remDays <= 3) return colorEnabled ? c.yellow(label) : `**${label}**`;
  return label;
}

function renderSloTable(hits, c, colorEnabled) {
  const lines = [
    '| Issue | Pri/Sev | Rule | Closure Due | Update Due | Title |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const h of hits) {
    const slo = h.slo || computeIssueSlo(h);
    const priSev = [h.priority, h.severity].filter(Boolean).join('/') || '—';
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    const issueUrl = h.id ? chromiumIssueUrl(h.id) : h.url;
    const cells = [
      `[${esc(h.id)}](${issueUrl})`,
      esc(priSev),
      esc(slo.rule),
      esc(formatSloDue(slo.closureDue, slo.closureRemDays, c, colorEnabled)),
      esc(formatSloDue(slo.updateDue, slo.updateRemDays, c, colorEnabled)),
      esc(h.title),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

function renderSloListMarkdown(data, c, colorEnabled) {
  const out = [];
  const displaySearchUrl = data.query ? chromiumSearchUrl(data.query) : data.searchUrl;
  out.push(header(c, `Search (by SLO): ${data.query}`, displaySearchUrl));
  if (!data.hits.length) {
    out.push(c.dim('(no results)'));
    if (data.since && data.filteredOut) {
      out.push(c.dim(`(${data.filteredOut} hits were filtered out by --since=${data.since})`));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  const hits = data.hits.every((h) => h.slo) ? data.hits : sortHitsBySlo(data.hits);
  const overdue = hits.filter((h) => h.slo.bucket === 'overdue');
  const dueSoon = hits.filter((h) => h.slo.bucket === 'due_soon');
  const inSlo = hits.filter((h) => h.slo.bucket === 'in_slo');
  const outOfScope = hits.filter((h) => h.slo.bucket === 'none');

  const summaryBits = [`${hits.length} result(s)`];
  if (overdue.length) summaryBits.push(c.red(`${overdue.length} out of SLO`));
  if (dueSoon.length) summaryBits.push(c.yellow(`${dueSoon.length} due <=7d`));
  if (inSlo.length) summaryBits.push(c.green(`${inSlo.length} in SLO`));
  if (outOfScope.length) summaryBits.push(c.dim(`${outOfScope.length} out of scope`));
  if (data.pagesFetched > 1) summaryBits.push(`${data.pagesFetched} pages`);
  if (data.since) summaryBits.push(`since ${data.since}, ${data.filteredOut} filtered out`);
  out.push(summaryBits.join('  ·  '));

  const sections = [
    ['Out of SLO', overdue],
    ['Due Within 7 Days', dueSoon],
    ['In SLO', inSlo],
  ];
  for (const [title, group] of sections) {
    if (!group.length) continue;
    out.push('');
    out.push(c.bold(`## ${title} (${group.length})`));
    out.push('');
    out.push(...renderSloTable(group, c, colorEnabled));
  }

  if (outOfScope.length) {
    out.push('');
    out.push(c.bold(`## Out of SLO Scope (${outOfScope.length})`));
    out.push('');
    const byPri = new Map();
    for (const h of outOfScope) {
      const k = h.priority || 'Other';
      if (!byPri.has(k)) byPri.set(k, []);
      byPri.get(k).push(h);
    }
    for (const [pri, group] of byPri) {
      const links = group.map((h) => `[${h.id}](${h.id ? chromiumIssueUrl(h.id) : h.url})`).join(', ');
      out.push(`- **${pri}** (${group.length}): ${links}`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderListMarkdown(search, args, colorEnabled) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(search);
  if (args?.slo || data.slo) {
    return renderSloListMarkdown(data, c, colorEnabled);
  }
  const out = [];
  const displaySearchUrl = data.query ? chromiumSearchUrl(data.query) : data.searchUrl;
  out.push(header(c, `Search: ${data.query}`, displaySearchUrl));
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
      const issueUrl = h.id ? chromiumIssueUrl(h.id) : h.url;
      const cells = [
        h.priority || '',
        h.type || '',
        h.status || '',
        `[${h.title}](${issueUrl})`,
        h.assignee || '',
        h.modified || '',
      ].map((s) => String(s).replace(/\|/g, '\\|'));
      out.push(`| ${cells.join(' | ')} |`);
    }
  } else {
    for (const h of data.hits) {
      const issueUrl = h.id ? chromiumIssueUrl(h.id) : h.url;
      out.push(`- [${h.id}](${issueUrl}) - ${h.title}`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const MARKDOWN_SEPARATOR = '\n\n---\n\n';

function renderCommentMarkdown(result, colorEnabled) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(result);
  const title = data.dryRun
    ? `Dry run: Comment on Issue ${data.id}`
    : `Commented on Issue ${data.id}`;
  const out = [header(c, title, data.id ? chromiumIssueUrl(data.id) : data.url)];
  if (data.title) out.push(`- **Title**: ${data.title}`);
  if (data.status) out.push(`- **Status**: ${data.status}`);
  out.push(`- **Format**: ${data.markdown ? 'Markdown' : 'Plain text'}`);
  out.push('');
  out.push(data.comment.trim());
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderCloseMarkdown(result, colorEnabled) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(result);
  const title = data.dryRun
    ? `Dry run: Close Issue ${data.id}`
    : `Closed Issue ${data.id}`;
  const out = [header(c, title, data.id ? chromiumIssueUrl(data.id) : data.url)];
  if (data.title) out.push(`- **Title**: ${data.title}`);
  const styledStatus = /Fixed|Verified/i.test(data.status)
    ? c.green(data.status)
    : c.gray(data.status);
  const transition = data.previousStatus && data.previousStatus !== data.status
    ? `${data.previousStatus} -> ${styledStatus}`
    : styledStatus;
  out.push(`- **Status**: ${transition}`);
  if (data.duplicateOf) {
    const dupUrl = chromiumIssueUrl(data.duplicateOf);
    const dupSuffix = data.duplicateOfTitle ? ` — ${data.duplicateOfTitle}` : '';
    out.push(`- **Duplicate of**: [${data.duplicateOf}](${dupUrl})${dupSuffix}`);
  }
  if (data.assignee) {
    const note = data.autoAssigned ? ' (auto-assigned)' : '';
    out.push(`- **Assignee**: ${data.assignee}${note}`);
  }
  if (data.comment) {
    out.push('');
    out.push(c.bold('### Closing comment'));
    out.push('');
    out.push(data.comment.trim());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function formatFieldValue(val, emptyLabel = '<none>') {
  if (Array.isArray(val)) {
    return val.length ? val.map(String).join(', ') : emptyLabel;
  }
  if (val === null || val === undefined || val === '') return emptyLabel;
  return String(val);
}

function renderEditMarkdown(result, colorEnabled) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(result);
  let title;
  if (data.action === 'assign') {
    const verb = data.assignee ? 'Assign' : 'Unassign';
    const past = data.assignee ? 'Assigned' : 'Unassigned';
    title = data.dryRun
      ? `Dry run: ${verb} Issue ${data.id}`
      : `${past} Issue ${data.id}`;
  } else {
    title = data.dryRun
      ? `Dry run: Edit Issue ${data.id}`
      : `Updated Issue ${data.id}`;
  }
  const out = [header(c, title, data.id ? chromiumIssueUrl(data.id) : data.url)];
  if (data.title) out.push(`- **Title**: ${data.title}`);
  if (data.noOp) {
    out.push(`- **Changes**: ${c.dim('(no changes — requested values already match issue)')}`);
  } else if (Array.isArray(data.changes) && data.changes.length) {
    for (const ch of data.changes) {
      const beforeStr = formatFieldValue(ch.before);
      const afterStr = formatFieldValue(ch.after);
      const note = ch.auto ? ' (auto)' : '';
      out.push(`- **${ch.field}**: ${beforeStr} -> ${c.green(afterStr)}${note}`);
    }
  }
  if (data.comment) {
    out.push('');
    out.push(c.bold('### Comment'));
    out.push('');
    out.push(data.comment.trim());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderFieldsMarkdown(result, colorEnabled, { full = false } = {}) {
  const c = makeColors(colorEnabled);
  const data = sanitizeDeep(result);
  const out = [header(c, `Fields for Issue ${data.id}`, data.id ? chromiumIssueUrl(data.id) : data.url)];
  if (data.title) out.push(`- **Title**: ${data.title}`);
  out.push('');
  out.push(c.bold('## Standard Fields'));
  out.push('');
  const s = data.standardFields || {};
  const alwaysEntries = [
    ['Status', s.status],
    ['Type', s.type],
    ['Priority', s.priority],
    ['Severity', s.severity],
    ['Component', s.componentId],
    ['Assignee', s.assignee],
    ['Verifier', s.verifier],
    ['Reporter', s.reporter],
    ['Code Changes', s.codeChanges],
    ['CC', s.cc],
    ['Collaborators', s.collaborators],
  ];
  const optionalEntries = [
    ['Pending Code Changes', s.pendingCodeChanges],
    ['Found In', s.foundIn],
    ['Targeted To', s.targetedTo],
    ['Verified In', s.verifiedIn],
    ['Hotlists', s.hotlists],
    ['Blocked By', s.blockedBy],
    ['Blocking', s.blocking],
  ];
  for (const [label, val] of alwaysEntries) {
    out.push(`- **${label}**: ${formatFieldValue(val)}`);
  }
  for (const [label, val] of optionalEntries) {
    const hasVal = Array.isArray(val) ? val.length > 0 : Boolean(val);
    if (full || hasVal) {
      out.push(`- **${label}**: ${formatFieldValue(val)}`);
    }
  }

  out.push('');
  out.push(c.bold('## Custom Fields'));
  out.push('');
  const cfs = Array.isArray(data.customFields) ? data.customFields : [];
  if (!cfs.length) {
    out.push(c.dim('(no custom fields)'));
  } else {
    const escCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    out.push('| Field | ID | Type | Value | Allowed Values |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const cf of cfs) {
      const valStr = formatFieldValue(cf.value, '—');
      let allowedStr = '—';
      if (Array.isArray(cf.allowedValues) && cf.allowedValues.length) {
        if (!full && cf.allowedValues.length > 12) {
          allowedStr = `${cf.allowedValues.slice(0, 12).join(', ')}, … (+${cf.allowedValues.length - 12} more)`;
        } else {
          allowedStr = cf.allowedValues.join(', ');
        }
      }
      out.push(
        `| ${escCell(cf.name)} | ${escCell(cf.id)} | ${escCell(cf.type)} | ${escCell(valStr)} | ${escCell(allowedStr)} |`,
      );
    }
  }
  if (data.hiddenCustomFieldCount > 0) {
    out.push('');
    out.push(
      c.dim(`(${data.hiddenCustomFieldCount} unpopulated hidden tracker field(s) omitted; pass --full to show all.)`),
    );
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function renderMutationErrorMarkdown(input, errMsg, colorEnabled, verb = 'updating') {
  const c = makeColors(colorEnabled);
  return `${c.bold(c.red(`# Error ${verb} \`${sanitizeTerminalText(input)}\``))}\n\n${sanitizeTerminalText(errMsg)}\n`;
}

// ---------- mutation CLI preparation ----------

function readCommentFromArgs(args, readStdin) {
  if (args.comment !== null && args.comment !== undefined) {
    return args.comment;
  }
  if (args.commentFile !== null && args.commentFile !== undefined) {
    return args.commentFile === '-'
      ? readStdin()
      : readFileSync(args.commentFile, 'utf8');
  }
  return null;
}

function splitIssueTokens(rawItems) {
  return rawItems
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function prepareCommentInvocation(inputs, args, {
  stdinIsTTY = Boolean(process.stdin.isTTY),
  readStdin = () => readFileSync(0, 'utf8'),
} = {}) {
  let comment = readCommentFromArgs(args, readStdin);
  let targets;

  if (comment !== null) {
    targets = splitIssueTokens(inputs);
    if (targets.length === 0) {
      throw new Error('`bnz comment` requires at least one issue id or URL.');
    }
  } else if (inputs.length === 0) {
    throw new Error('`bnz comment` requires an issue id/URL and comment text.');
  } else if (inputs.length === 2) {
    targets = splitIssueTokens([inputs[0]]);
    comment = inputs[1];
  } else if (inputs.length === 1) {
    targets = splitIssueTokens([inputs[0]]);
    if (!stdinIsTTY) {
      comment = readStdin();
    } else {
      throw new Error(
        'Missing comment text. Pass `bnz comment <id> "<text>"`, `-m "<text>"`, `-F <file>`, or pipe stdin.',
      );
    }
  } else {
    throw new Error(
      'Too many positional arguments for `bnz comment`. Quote your comment text or pass `-m "<text>"` for multiple issues.',
    );
  }

  if (targets.length === 0) {
    throw new Error('`bnz comment` requires at least one issue id or URL.');
  }
  for (const t of targets) resolveIssueUrl(t);
  if (typeof comment !== 'string' || !comment.trim()) {
    throw new Error('Comment text must not be empty.');
  }

  return {
    targets,
    comment,
    markdown: args.markdown !== false,
    dryRun: !!args.dryRun,
  };
}

function prepareCloseInvocation(inputs, args, {
  readStdin = () => readFileSync(0, 'utf8'),
} = {}) {
  const comment = readCommentFromArgs(args, readStdin);
  if (comment !== null && !String(comment).trim()) {
    throw new Error('Closing comment must not be empty.');
  }

  let status = args.status;
  let duplicateOf = args.duplicateOf;
  const setStatus = (val) => {
    if (status && normalizeStatusToken(status) !== normalizeStatusToken(val)) {
      throw new Error(`Conflicting close statuses: "${status}" and "${val}"`);
    }
    status = val;
  };

  const targets = [];
  const tokens = splitIssueTokens(inputs);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^(?:\d+|b\/\d+|https?:\/\/)/i.test(tok)) {
      targets.push(tok);
      continue;
    }
    const norm = normalizeStatusToken(tok);
    if (['duplicate', 'dup', 'dupe'].includes(norm)) {
      setStatus('duplicate');
      if (!duplicateOf && targets.length > 0 && i + 1 < tokens.length) {
        let next = tokens[i + 1];
        if (next.toLowerCase() === 'of' && i + 2 < tokens.length) {
          i++;
          next = tokens[i + 1];
        }
        duplicateOf = next;
        i++;
      }
      continue;
    }
    resolveCloseStatus(tok, undefined);
    setStatus(tok);
  }

  if (targets.length === 0) {
    throw new Error('`bnz close` requires at least one issue id or URL.');
  }
  const targetIds = targets.map((t) => resolveIssueUrl(t).match(/(\d+)/)[1]);
  const resolved = resolveCloseStatus(status, duplicateOf);
  if (resolved.key === 'duplicate') {
    const dupId = resolveIssueUrl(String(duplicateOf).trim()).match(/(\d+)/)[1];
    for (const id of targetIds) {
      if (id === dupId) {
        throw new Error(`Issue ${id} cannot be marked as a duplicate of itself.`);
      }
    }
  }

  return {
    targets,
    status: status || undefined,
    duplicateOf: duplicateOf || undefined,
    comment: comment ?? undefined,
    markdown: args.markdown !== false,
    assignee: args.assignee ?? undefined,
    dryRun: !!args.dryRun,
  };
}

function validateCliUserToken(raw, label = 'assignee') {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error(`Expected an email address, "me", or "none" for ${label}.`);
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'me' || ['none', 'null', 'unassigned', 'clear', '-'].includes(lower)) {
    return trimmed;
  }
  if (!trimmed.includes('@') || /\s/.test(trimmed)) {
    throw new Error(`Invalid ${label} "${raw}" (expected an email address, "me", or "none").`);
  }
  return trimmed;
}

function prepareAssignInvocation(inputs, args, {
  isUnassign = false,
  readStdin = () => readFileSync(0, 'utf8'),
} = {}) {
  const comment = readCommentFromArgs(args, readStdin);
  if (comment !== null && !String(comment).trim()) {
    throw new Error('Comment must not be empty.');
  }

  if (isUnassign) {
    if (args.assignee !== null && !['none', 'null', 'unassigned', 'clear', '-'].includes(args.assignee.toLowerCase())) {
      throw new Error('Cannot combine --assignee with `bnz unassign`.');
    }
    const targets = splitIssueTokens(inputs);
    if (targets.length === 0) {
      throw new Error('`bnz unassign` requires at least one issue id or URL.');
    }
    for (const t of targets) resolveIssueUrl(t);
    return {
      targets,
      assignee: 'none',
      comment: comment ?? undefined,
      markdown: args.markdown !== false,
      dryRun: !!args.dryRun,
    };
  }

  let assignee = args.assignee;
  const targets = [];
  const tokens = splitIssueTokens(inputs);
  for (const tok of tokens) {
    if (assignee !== null) {
      targets.push(tok);
      continue;
    }
    if (/^(?:\d+|b\/\d+|https?:\/\/)/i.test(tok)) {
      targets.push(tok);
    } else if (assignee === null) {
      assignee = tok;
    } else {
      throw new Error(
        `Unexpected extra argument "${tok}". Pass a single assignee (<email>, "me", or "none").`,
      );
    }
  }

  if (targets.length === 0) {
    throw new Error('`bnz assign` requires at least one issue id or URL.');
  }
  for (const t of targets) resolveIssueUrl(t);
  if (assignee === null || !String(assignee).trim()) {
    throw new Error('`bnz assign` requires an assignee (<email>, "me", or "none").');
  }
  validateCliUserToken(assignee, 'assignee');

  return {
    targets,
    assignee: String(assignee).trim(),
    comment: comment ?? undefined,
    markdown: args.markdown !== false,
    dryRun: !!args.dryRun,
  };
}

function splitCommaEntries(rawList) {
  return rawList
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function prepareEditInvocation(inputs, args, {
  mode = 'edit',
  cmdName = null,
  readStdin = () => readFileSync(0, 'utf8'),
} = {}) {
  const labelCmd = cmdName || (mode === 'edit' ? 'edit' : mode);
  const comment = readCommentFromArgs(args, readStdin);
  if (comment !== null && !String(comment).trim()) {
    throw new Error('Comment must not be empty.');
  }

  let priority = args.priority;
  let severity = args.severity;
  let type = args.type;

  const assignPriority = (val) => {
    if (priority !== null && resolvePriority(priority).id !== resolvePriority(val).id) {
      throw new Error(`Conflicting priorities: "${priority}" and "${val}"`);
    }
    priority = String(val);
  };
  const assignSeverity = (val) => {
    if (severity !== null && resolveSeverity(severity).id !== resolveSeverity(val).id) {
      throw new Error(`Conflicting severities: "${severity}" and "${val}"`);
    }
    severity = String(val);
  };
  const assignType = (val) => {
    const resolved = resolveIssueType(val);
    if (type !== null && resolveIssueType(type).id !== resolved.id) {
      throw new Error(`Conflicting issue types: "${type}" and "${val}"`);
    }
    type = String(val);
  };

  const targets = [];
  const fieldOps = [...(args.fieldOps || [])];
  for (const raw of inputs) {
    const str = String(raw);
    if (!/^https?:\/\//i.test(str) && str.includes('=')) {
      fieldOps.push(parseFieldSpec(str));
      continue;
    }
    for (const tok of splitIssueTokens([str])) {
      if (mode === 'priority' && /^[0-4]$/.test(tok)) {
        assignPriority(tok);
      } else if (mode === 'severity' && /^[0-4]$/.test(tok)) {
        assignSeverity(tok);
      } else if (/^(?:\d+|b\/\d+|https?:\/\/)/i.test(tok)) {
        targets.push(tok);
      } else if (/^[pP][0-4]$/.test(tok)) {
        assignPriority(tok);
      } else if (/^[sS][0-4]$/.test(tok)) {
        assignSeverity(tok);
      } else if (tryResolveIssueType(tok)) {
        assignType(tok);
      } else if (mode === 'type') {
        assignType(tok); // throws Unknown issue type ...
      } else if (mode === 'priority') {
        resolvePriority(tok); // throws Invalid priority ...
      } else if (mode === 'severity') {
        resolveSeverity(tok); // throws Invalid severity ...
      } else {
        resolveIssueUrl(tok);
      }
    }
  }

  if (targets.length === 0) {
    throw new Error(`\`bnz ${labelCmd}\` requires at least one issue id or URL.`);
  }
  for (const t of targets) resolveIssueUrl(t);

  if (mode === 'type' && type === null) {
    throw new Error('`bnz type` requires an issue type (e.g. `bug`, `vulnerability`, `feature-request`, `task`).');
  }
  if (mode === 'priority' && priority === null) {
    throw new Error(`\`bnz ${labelCmd}\` requires a priority (\`P0\`..\`P4\` or \`0\`..\`4\`).`);
  }
  if (mode === 'severity' && severity === null) {
    throw new Error(`\`bnz ${labelCmd}\` requires a severity (\`S0\`..\`S4\` or \`0\`..\`4\`).`);
  }

  // Upfront validation so obvious typos fail before opening Chromium.
  if (args.assignee !== null) validateCliUserToken(args.assignee, 'assignee');
  if (args.verifier !== null) validateCliUserToken(args.verifier, 'verifier');
  if (args.status !== null) resolveIssueStatus(args.status);
  if (priority !== null) resolvePriority(priority);
  if (severity !== null) resolveSeverity(severity);
  if (type !== null) resolveIssueType(type);
  if (args.title !== null && !String(args.title).trim()) {
    throw new Error('Title must not be empty.');
  }
  if (args.componentId !== null && !/^\d+$/.test(String(args.componentId).trim())) {
    throw new Error(`Invalid component ID "${args.componentId}" (expected a numeric component ID).`);
  }
  if (args.codeChanges !== undefined) {
    const trimmed = String(args.codeChanges).trim().toLowerCase();
    if (trimmed !== '' && trimmed !== 'none' && trimmed !== 'null') {
      splitCommaEntries([args.codeChanges]).forEach(parseCodeChangeEntry);
    }
  }
  if (args.addCodeChanges?.length) {
    splitCommaEntries(args.addCodeChanges).forEach(parseCodeChangeEntry);
  }
  if (args.removeCodeChanges?.length) {
    splitCommaEntries(args.removeCodeChanges).forEach(parseCodeChangeEntry);
  }

  const addCc = args.addCc?.length ? args.addCc : undefined;
  const removeCc = args.removeCc?.length ? args.removeCc : undefined;
  const addCollaborators = args.addCollaborators?.length ? args.addCollaborators : undefined;
  const removeCollaborators = args.removeCollaborators?.length ? args.removeCollaborators : undefined;
  const addCodeChanges = args.addCodeChanges?.length ? args.addCodeChanges : undefined;
  const removeCodeChanges = args.removeCodeChanges?.length ? args.removeCodeChanges : undefined;

  const hasMutation =
    args.assignee !== null ||
    args.status !== null ||
    priority !== null ||
    severity !== null ||
    type !== null ||
    args.title !== null ||
    args.componentId !== null ||
    args.verifier !== null ||
    args.cc !== undefined || Boolean(addCc) || Boolean(removeCc) ||
    args.collaborators !== undefined || Boolean(addCollaborators) || Boolean(removeCollaborators) ||
    args.codeChanges !== undefined || Boolean(addCodeChanges) || Boolean(removeCodeChanges) ||
    fieldOps.length > 0 ||
    comment !== null;

  if (!hasMutation) {
    throw new Error(
      'No field updates specified for `bnz edit`. Pass flags like `--bug`, `-p P2`, `-S S4`, ' +
      '`--assignee=...`, `--os=...`, `--add-code-change=...`, or `-f "Field=Value"`.',
    );
  }

  return {
    targets,
    assignee: args.assignee ?? undefined,
    status: args.status ?? undefined,
    priority: priority ?? undefined,
    severity: severity ?? undefined,
    type: type ?? undefined,
    title: args.title ?? undefined,
    componentId: args.componentId ?? undefined,
    verifier: args.verifier ?? undefined,
    cc: args.cc,
    addCc,
    removeCc,
    collaborators: args.collaborators,
    addCollaborators,
    removeCollaborators,
    codeChanges: args.codeChanges,
    addCodeChanges,
    removeCodeChanges,
    fieldOps,
    comment: comment ?? undefined,
    markdown: args.markdown !== false,
    dryRun: !!args.dryRun,
  };
}

function prepareFieldsInvocation(inputs) {
  const targets = splitIssueTokens(inputs);
  if (targets.length === 0) {
    throw new Error('`bnz fields` requires at least one issue id or URL.');
  }
  for (const t of targets) resolveIssueUrl(t);
  return { targets };
}

// ---------- commands ----------

async function runBatchMutation(targets, fn, args, colorEnabled, renderOk, errorVerb = 'updating') {
  const entries = [];
  for (const target of targets) {
    try {
      entries.push({ ok: true, target, data: await fn(target) });
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      entries.push({ ok: false, target, error: String(err.message || err) });
    }
  }
  const anyFail = entries.some((e) => !e.ok);
  if (entries.length === 1 && anyFail) {
    throw new Error(entries[0].error);
  }
  if (anyFail) process.exitCode = 1;

  if (args.format === 'json') {
    const mapped = entries.map((e) =>
      e.ok ? e.data : { input: e.target, ok: false, error: e.error });
    const payload = mapped.length === 1 ? mapped[0] : mapped;
    console.log(JSON.stringify(sanitizeDeep(payload), null, 2));
    return;
  }
  console.log(
    entries
      .map((e) => e.ok
        ? renderOk(e.data)
        : renderMutationErrorMarkdown(e.target, e.error, colorEnabled, errorVerb))
      .join(MARKDOWN_SEPARATOR),
  );
}

async function commentCmd(session, plan, args, colorEnabled) {
  await runBatchMutation(
    plan.targets,
    (target) => commentIssue(session, target, {
      comment: plan.comment,
      markdown: plan.markdown,
      dryRun: plan.dryRun,
    }),
    args,
    colorEnabled,
    (r) => renderCommentMarkdown(r, colorEnabled),
  );
}

async function closeCmd(session, plan, args, colorEnabled) {
  await runBatchMutation(
    plan.targets,
    (target) => closeIssue(session, target, {
      status: plan.status,
      duplicateOf: plan.duplicateOf,
      comment: plan.comment,
      markdown: plan.markdown,
      assignee: plan.assignee,
      dryRun: plan.dryRun,
    }),
    args,
    colorEnabled,
    (r) => renderCloseMarkdown(r, colorEnabled),
  );
}

async function assignCmd(session, plan, args, colorEnabled) {
  await runBatchMutation(
    plan.targets,
    (target) => assignIssue(session, target, {
      assignee: plan.assignee,
      comment: plan.comment,
      markdown: plan.markdown,
      dryRun: plan.dryRun,
    }),
    args,
    colorEnabled,
    (r) => renderEditMarkdown(r, colorEnabled),
  );
}

async function editCmd(session, plan, args, colorEnabled) {
  const { targets, ...editOpts } = plan;
  await runBatchMutation(
    targets,
    (target) => editIssue(session, target, editOpts),
    args,
    colorEnabled,
    (r) => renderEditMarkdown(r, colorEnabled),
  );
}

async function fieldsCmd(session, plan, args, colorEnabled) {
  await runBatchMutation(
    plan.targets,
    (target) => fetchIssueFields(session, target, { full: !!args.full }),
    args,
    colorEnabled,
    (r) => renderFieldsMarkdown(r, colorEnabled, { full: !!args.full }),
    'fetching fields for',
  );
}

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
  inputs = readCfInputs(inputs, args);
  if (inputs.length === 0) { usage(); process.exit(1); }
  if (args.download) {
    const results = await downloadTestcases(session, inputs, args);
    if (args.format === 'json') console.log(JSON.stringify(sanitizeDeep(results), null, 2));
    else for (const r of results) {
      console.log(sanitizeTerminalText(r.ok
        ? `${r.path} (${r.bytes} bytes)`
        : `Failed ${r.input || r.key} ${r.variant || ''}: ${r.error}`));
    }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
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
  const query = inputs.length ? inputs.join(' ') : DEFAULT_LIST_QUERY;
  const result = await searchIssues(session, query, args);
  if (args.format === 'json') {
    console.log(JSON.stringify(sanitizeDeep(result), null, 2));
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

async function loginCmd(startUrls, args) {
  if (args.import) {
    const raw = args.import === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(args.import, 'utf8');
    const { count, profileDir } = await importSessionState(raw);
    console.error(`Imported ${count} cookies into ${profileDir}`);
    return;
  }
  if (args.export) {
    const state = await exportSessionState({ startUrls });
    if (args.export === '-') {
      process.stdout.write(JSON.stringify(state) + '\n');
    } else {
      console.error(`Exporting ${state.cookies.length} cookies to ${args.export} ...`);
      await pushSessionOverSsh(args.export, state);
    }
    return;
  }
  await loginInteractive(startUrls);
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
    const urls = args.withCf
      ? ['https://issuetracker.google.com/', 'https://clusterfuzz.com/']
      : ['https://issuetracker.google.com/'];
    await loginCmd(urls, args);
    return;
  }
  if (cmd === 'cf' && args._[1] === 'login') {
    await loginCmd(['https://clusterfuzz.com/'], args);
    return;
  }

  let commandPlan = null;
  const editModeByCmd = {
    edit: 'edit',
    set: 'edit',
    type: 'type',
    priority: 'priority',
    pri: 'priority',
    severity: 'severity',
    sev: 'severity',
  };
  if (cmd === 'comment') {
    commandPlan = prepareCommentInvocation(args._.slice(1), args);
  } else if (cmd === 'close') {
    commandPlan = prepareCloseInvocation(args._.slice(1), args);
  } else if (cmd === 'assign' || cmd === 'unassign') {
    commandPlan = prepareAssignInvocation(args._.slice(1), args, { isUnassign: cmd === 'unassign' });
  } else if (editModeByCmd[cmd]) {
    commandPlan = prepareEditInvocation(args._.slice(1), args, {
      mode: editModeByCmd[cmd],
      cmdName: cmd,
    });
  } else if (cmd === 'fields') {
    commandPlan = prepareFieldsInvocation(args._.slice(1));
  }

  const session = await openSession();
  try {
    if (cmd === 'cf') {
      await cfCmd(session, args._.slice(1), args, colorEnabled);
    } else if (cmd === 'list') {
      await listCmd(session, args._.slice(1), args, colorEnabled);
    } else if (cmd === 'comment') {
      await commentCmd(session, commandPlan, args, colorEnabled);
    } else if (cmd === 'close') {
      await closeCmd(session, commandPlan, args, colorEnabled);
    } else if (cmd === 'assign' || cmd === 'unassign') {
      await assignCmd(session, commandPlan, args, colorEnabled);
    } else if (editModeByCmd[cmd]) {
      await editCmd(session, commandPlan, args, colorEnabled);
    } else if (cmd === 'fields') {
      await fieldsCmd(session, commandPlan, args, colorEnabled);
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
  parseFieldSpec,
  parseSince,
  prepareAssignInvocation,
  prepareCloseInvocation,
  prepareCommentInvocation,
  prepareEditInvocation,
  prepareFieldsInvocation,
  renderCloseMarkdown,
  renderCommentMarkdown,
  renderEditMarkdown,
  renderFieldsMarkdown,
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
