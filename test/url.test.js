import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENT_URL_RE, isIssueUrl, resolveCfTarget, resolveIssueUrl,
  resolveTestcaseKey, searchUrl,
} from '../lib/url.js';

test('resolves only known https issue URLs', () => {
  assert.equal(
    resolveIssueUrl('505610970'),
    'https://issuetracker.google.com/issues/505610970',
  );
  assert.equal(
    resolveIssueUrl('b/505610970'),
    'https://issuetracker.google.com/issues/505610970',
  );
  assert.equal(
    resolveIssueUrl('https://issues.chromium.org/issues/505610970'),
    'https://issuetracker.google.com/issues/505610970',
  );
  assert.equal(
    resolveIssueUrl('https://issues.chromium.org/u/1/issues/506855825?pli=1'),
    'https://issuetracker.google.com/issues/506855825',
  );
  assert.equal(
    resolveIssueUrl('https://crbug.com/506855825'),
    'https://issuetracker.google.com/issues/506855825',
  );
  assert.throws(
    () => resolveIssueUrl('http://issuetracker.google.com/issues/505610970'),
    /Only https URLs are supported/,
  );
  assert.throws(
    () => resolveIssueUrl('https://example.com/issues/505610970'),
    /Unsupported issue host/,
  );
});

test('resolves ClusterFuzz targets without accepting lookalike hosts', () => {
  assert.deepEqual(
    resolveCfTarget('https://clusterfuzz.com/testcase-detail/6005188368302080'),
    { kind: 'testcase', key: '6005188368302080' },
  );
  assert.deepEqual(
    resolveCfTarget('https://clusterfuzz.com/testcase?key=5009280990216192'),
    { kind: 'testcase', key: '5009280990216192' },
  );
  assert.deepEqual(
    resolveCfTarget('https://issuetracker.google.com/issues/505610970'),
    { kind: 'issue', issue: 'https://issuetracker.google.com/issues/505610970' },
  );
  assert.deepEqual(
    resolveCfTarget('b/505610970'),
    { kind: 'issue', issue: '505610970' },
  );
  assert.deepEqual(
    resolveCfTarget('505610970'),
    { kind: 'issue', issue: '505610970' },
  );
  assert.deepEqual(
    resolveCfTarget('5009280990216192'),
    { kind: 'testcase', key: '5009280990216192' },
  );
  assert.equal(
    resolveTestcaseKey('https://clusterfuzz.com/download?testcase_id=5009280990216192'),
    '5009280990216192',
  );
  assert.throws(
    () => resolveCfTarget('https://clusterfuzz.com.evil.test/testcase?key=5009280990216192'),
    /Unsupported ClusterFuzz target host/,
  );
});

test('isIssueUrl gates by host', () => {
  assert.equal(isIssueUrl(new URL('https://crbug.com/1')), true);
  assert.equal(isIssueUrl(new URL('https://issuetracker.google.com/issues/1')), true);
  assert.equal(isIssueUrl(new URL('https://example.com/issues/1')), false);
});

test('attachment URL pattern matches known shapes', () => {
  assert.match(
    'https://issuetracker.google.com/action/issues/12345/attachments/67890?download=true',
    ATTACHMENT_URL_RE,
  );
  assert.match(
    'https://issuetracker.google.com/issues/12345/attachments/67890',
    ATTACHMENT_URL_RE,
  );
  assert.doesNotMatch(
    'https://issuetracker.google.com/issues/12345',
    ATTACHMENT_URL_RE,
  );
});

test('search URL encodes the query', () => {
  assert.equal(
    searchUrl('reporter:me status:open'),
    'https://issuetracker.google.com/issues?q=reporter%3Ame%20status%3Aopen',
  );
});
