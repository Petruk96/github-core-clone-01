/** Shared in-memory domain state used by every protocol surface built by app.ts. */

export interface GitObject {
  type: string;
  data: Buffer;
}

export interface CommitSnapshot {
  sha: string;
  treeSha: string;
  message: string;
  parentSha?: string;
  files: Map<string, Buffer>;
}

export interface LabelState {
  id: number;
  name: string;
  color: string;
}

export interface IssueCommentState {
  id: number;
  body: string;
  createdAt: string;
}

export type IssueStatus = 'open' | 'closed';

export interface IssueState {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueStatus;
  labels: LabelState[];
  comments: IssueCommentState[];
  createdAt: string;
  updatedAt: string;
}

export type PullRequestStatus = 'open' | 'closed';
export type PullRequestMergeability = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export interface PullRequestState {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullRequestStatus;
  merged: boolean;
  mergeable: PullRequestMergeability;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  baseSha: string;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

/** Branches and tags share Git's refs namespace; branches are refs/heads/* projections. */
export interface RepositoryState {
  id: number;
  name: string;
  owner: string | null;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  commits: Map<string, CommitSnapshot>;
  objects: Map<string, GitObject>;
  commitCount: number;
  labels: Map<string, LabelState>;
  issues: Map<number, IssueState>;
  pullRequests: Map<number, PullRequestState>;
  nextIssueNumber: number;
  nextPullRequestNumber: number;
}

export interface ForgeState {
  repositories: Map<string, RepositoryState>;
  accountOwner: string | null;
  nextRepositoryId: number;
  nextLabelId: number;
  nextIssueId: number;
  nextCommentId: number;
  nextPullRequestId: number;
  nowEpochMs: number;
  timestampSequence: number;
}

export interface NewRepository {
  name: string;
  owner: string | null;
  private: boolean;
  description: string;
  defaultBranch?: string;
}

export interface NewIssue {
  title: string;
  body?: string;
  labels?: readonly string[];
}

export interface NewPullRequest {
  title: string;
  body?: string;
  head: string;
  base: string;
}

const FIXED_FALLBACK_EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0, 0);
const MAX_DATE_MS = 8_640_000_000_000_000;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Parse the trial clock format (RFC 3339 or epoch milliseconds), without reading a wall clock. */
export function parseTrialNow(value: string): number {
  if (/^\d{1,16}$/.test(value)) {
    const epochMs = Number(value);
    if (Number.isSafeInteger(epochMs) && epochMs <= MAX_DATE_MS) return epochMs;
  }

  const match = RFC3339.exec(value);
  if (match === null) throw new TypeError('MAKEFUN_TRIAL_NOW must be RFC 3339 or epoch milliseconds');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = month === 2 && leapYear ? 29 : DAYS_IN_MONTH[month - 1];
  if (year < 1970 || month < 1 || month > 12 || maxDay === undefined || day < 1 || day > maxDay ||
      hour > 23 || minute > 59 || second > 59) {
    throw new TypeError('MAKEFUN_TRIAL_NOW must be RFC 3339 or epoch milliseconds');
  }

  const zone = match[8];
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) throw new TypeError('MAKEFUN_TRIAL_NOW must be RFC 3339 or epoch milliseconds');
  }
  const epochMs = Date.parse(value);
  if (!Number.isSafeInteger(epochMs) || Math.abs(epochMs) > MAX_DATE_MS) {
    throw new TypeError('MAKEFUN_TRIAL_NOW must be RFC 3339 or epoch milliseconds');
  }
  return epochMs;
}

/** Create fresh per-process state. An unset/empty trial clock uses a fixed epoch, never Date.now(). */
export function createForgeState(nowValue = process.env.MAKEFUN_TRIAL_NOW): ForgeState {
  const nowEpochMs = nowValue === undefined || nowValue === '' ? FIXED_FALLBACK_EPOCH_MS : parseTrialNow(nowValue);
  return {
    repositories: new Map(),
    accountOwner: null,
    nextRepositoryId: 1,
    nextLabelId: 1,
    nextIssueId: 1,
    nextCommentId: 1,
    nextPullRequestId: 1,
    nowEpochMs,
    timestampSequence: 0,
  };
}

/** Allocate strictly ordered, deterministic timestamps derived only from the fixed trial instant. */
export function nextStateTimestamp(state: ForgeState): string {
  const timestamp = state.nowEpochMs + state.timestampSequence;
  if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp) > MAX_DATE_MS) {
    throw new RangeError('deterministic state timestamp is outside the supported date range');
  }
  state.timestampSequence += 1;
  return new Date(timestamp).toISOString();
}

export function createRepositoryState(state: ForgeState, input: NewRepository): RepositoryState {
  return {
    id: state.nextRepositoryId++,
    name: input.name,
    owner: input.owner,
    private: input.private,
    description: input.description,
    defaultBranch: input.defaultBranch ?? 'main',
    refs: new Map(),
    commits: new Map(),
    objects: new Map(),
    commitCount: 0,
    labels: new Map(),
    issues: new Map(),
    pullRequests: new Map(),
    nextIssueNumber: 1,
    nextPullRequestNumber: 1,
  };
}

export function createLabel(state: ForgeState, repo: RepositoryState, name: string, color = 'ededed'): LabelState | null {
  const key = name.toLowerCase();
  if (repo.labels.has(key)) return null;
  const label = { id: state.nextLabelId++, name, color };
  repo.labels.set(key, label);
  return label;
}

/** Returns null for unknown labels; no ID or timestamp is consumed on a rejected creation. */
export function createIssue(state: ForgeState, repo: RepositoryState, input: NewIssue): IssueState | null {
  const labels: LabelState[] = [];
  for (const name of input.labels ?? []) {
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return null;
    if (!labels.includes(label)) labels.push(label);
  }
  const createdAt = nextStateTimestamp(state);
  const issue: IssueState = {
    id: state.nextIssueId++,
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    createdAt,
    updatedAt: createdAt,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function setIssueState(state: ForgeState, repo: RepositoryState, number: number, status: IssueStatus): IssueState | null {
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  if (issue.state !== status) {
    issue.state = status;
    issue.updatedAt = nextStateTimestamp(state);
  }
  return issue;
}

export function addIssueComment(state: ForgeState, repo: RepositoryState, number: number, body: string): IssueCommentState | null {
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  const comment = { id: state.nextCommentId++, body, createdAt: nextStateTimestamp(state) };
  issue.comments.push(comment);
  issue.updatedAt = comment.createdAt;
  return comment;
}

function branchRef(name: string): string {
  return name.startsWith('refs/heads/') ? name : `refs/heads/${name}`;
}

/** Capture both branch names and their current tips so all protocols see the same PR relation. */
export function createPullRequest(state: ForgeState, repo: RepositoryState, input: NewPullRequest): PullRequestState | null {
  const headRefName = input.head.replace(/^.*:/, '');
  const baseRefName = input.base.replace(/^.*:/, '');
  const headSha = repo.refs.get(branchRef(headRefName));
  const baseSha = repo.refs.get(branchRef(baseRefName));
  if (headSha === undefined || baseSha === undefined) return null;

  const createdAt = nextStateTimestamp(state);
  const pullRequest: PullRequestState = {
    id: state.nextPullRequestId++,
    number: repo.nextPullRequestNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergeable: 'MERGEABLE',
    headRefName,
    headSha,
    baseRefName,
    baseSha,
    mergeCommitSha: null,
    createdAt,
    updatedAt: createdAt,
    mergedAt: null,
  };
  repo.pullRequests.set(pullRequest.number, pullRequest);
  return pullRequest;
}
