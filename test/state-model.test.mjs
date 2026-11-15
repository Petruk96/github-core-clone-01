import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addIssueComment,
  createForgeState,
  createIssue,
  createLabel,
  createPullRequest,
  createRepositoryState,
  nextStateTimestamp,
  parseTrialNow,
  setIssueState,
} from '../state.ts';

const HEAD_SHA = '1'.repeat(40);
const BASE_SHA = '2'.repeat(40);

function exerciseState(now) {
  const state = createForgeState(now);
  const repo = createRepositoryState(state, {
    name: 'state-model',
    owner: 'state-owner',
    private: true,
    description: 'state model test',
  });
  repo.refs.set('refs/heads/main', BASE_SHA);
  repo.refs.set('refs/heads/feature', HEAD_SHA);
  repo.objects.set(HEAD_SHA, { type: 'commit', data: Buffer.from('head commit') });

  const label = createLabel(state, repo, 'bug', 'd73a4a');
  assert.ok(label);
  assert.equal(createLabel(state, repo, 'BUG', '000000'), null);
  assert.equal(createIssue(state, repo, { title: 'invalid', labels: ['missing'] }), null);

  const issue = createIssue(state, repo, { title: 'sample issue', body: 'body', labels: ['BUG'] });
  assert.ok(issue);
  const comment = addIssueComment(state, repo, issue.number, 'comment body');
  assert.ok(comment);
  const closed = setIssueState(state, repo, issue.number, 'closed');
  assert.ok(closed);

  const pull = createPullRequest(state, repo, {
    title: 'sample pull request',
    body: 'pull body',
    head: 'feature',
    base: 'main',
  });
  assert.ok(pull);
  assert.equal(createPullRequest(state, repo, {
    title: 'missing branch',
    head: 'not-a-branch',
    base: 'main',
  }), null);

  return {
    repository: { id: repo.id, refs: [...repo.refs], hasObjects: repo.objects.has(HEAD_SHA) },
    label: { id: label.id, name: label.name, color: label.color },
    issue: {
      id: issue.id,
      number: issue.number,
      state: issue.state,
      labelNames: issue.labels.map((entry) => entry.name),
      labelIds: issue.labels.map((entry) => entry.id),
      commentIds: issue.comments.map((entry) => entry.id),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    },
    comment: { id: comment.id, createdAt: comment.createdAt },
    pullRequest: {
      id: pull.id,
      number: pull.number,
      headRefName: pull.headRefName,
      headSha: pull.headSha,
      baseRefName: pull.baseRefName,
      baseSha: pull.baseSha,
      createdAt: pull.createdAt,
    },
  };
}

test('trial clock accepts RFC 3339 and epoch milliseconds', () => {
  assert.equal(parseTrialNow('2026-11-02T09:00:00+01:00'), Date.parse('2026-11-02T08:00:00Z'));
  assert.equal(parseTrialNow('1793606400000'), 1793606400000);
  assert.throws(() => parseTrialNow('not-a-date'), /MAKEFUN_TRIAL_NOW/);
});

test('an unset trial clock uses a fixed deterministic fallback', () => {
  const first = createForgeState('');
  const second = createForgeState('');
  assert.equal(first.nowEpochMs, Date.UTC(2025, 0, 1));
  assert.equal(nextStateTimestamp(first), nextStateTimestamp(second));
});

test('repository and related entity IDs, timestamps, and references repeat deterministically', () => {
  const now = '2026-11-02T09:00:00Z';
  const first = exerciseState(now);
  const second = exerciseState(now);

  assert.deepEqual(first, second);
  assert.equal(first.repository.id, 1);
  assert.equal(first.issue.id, 1);
  assert.equal(first.issue.number, 1);
  assert.equal(first.label.id, first.issue.labelIds[0]);
  assert.deepEqual(first.issue.labelNames, ['bug']);
  assert.equal(first.comment.id, first.issue.commentIds[0]);
  assert.equal(first.pullRequest.number, 1);
  assert.equal(first.pullRequest.headSha, HEAD_SHA);
  assert.equal(first.pullRequest.baseSha, BASE_SHA);
  assert.equal(first.issue.state, 'closed');
  assert.ok(first.issue.createdAt < first.comment.createdAt);
  assert.ok(first.comment.createdAt < first.issue.updatedAt);
  assert.ok(first.issue.updatedAt < first.pullRequest.createdAt);
});
