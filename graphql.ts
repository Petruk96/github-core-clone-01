import {
  addIssueComment,
  createIssue,
  createPullRequest,
  setIssueState,
  type ForgeState,
  type IssueState,
  type PullRequestState,
  type RepositoryState,
} from './state.ts';

type GqlValue = null | boolean | number | string | GqlValue[] | { [key: string]: GqlValue } | { variable: string };
interface GqlField { name: string; alias: string; arguments: Record<string, GqlValue>; selections: GqlField[]; fragmentType?: string }
interface GqlOperation { kind: 'query' | 'mutation'; selections: GqlField[] }
interface Token { kind: 'name' | 'string' | 'number' | 'punct'; value: string }
type RepositoryLookup = (owner: string, name: string) => RepositoryState | undefined;
type PullMerger = (repo: RepositoryState, pull: PullRequestState, owner: string) => { sha: string; message: string } | null;

class GraphQLSyntaxError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s|,/.test(char)) { index += 1; continue; }
    if (char === '#') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (source.startsWith('...', index)) { tokens.push({ kind: 'punct', value: '...' }); index += 3; continue; }
    if (char === '"') {
      const start = index++;
      let escaped = false;
      while (index < source.length) {
        const current = source[index++];
        if (current === '"' && !escaped) break;
        if (current === '\\' && !escaped) escaped = true;
        else escaped = false;
      }
      const raw = source.slice(start, index);
      try { tokens.push({ kind: 'string', value: JSON.parse(raw) as string }); }
      catch { throw new GraphQLSyntaxError('Syntax Error: Unterminated or invalid string literal.'); }
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index += 1;
      tokens.push({ kind: 'name', value: source.slice(start, index) });
      continue;
    }
    if (/-|\d/.test(char)) {
      const start = index++;
      while (index < source.length && /[0-9.eE+-]/.test(source[index])) index += 1;
      tokens.push({ kind: 'number', value: source.slice(start, index) });
      continue;
    }
    if ('{}():$![]=@[]'.includes(char)) { tokens.push({ kind: 'punct', value: char }); index += 1; continue; }
    throw new GraphQLSyntaxError(`Syntax Error: Unexpected character ${JSON.stringify(char)}.`);
  }
  return tokens;
}

class GqlParser {
  private offset = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  private peek(value?: string): boolean {
    const token = this.tokens[this.offset];
    return value === undefined ? token !== undefined : token?.value === value;
  }
  private take(): Token { const token = this.tokens[this.offset++]; if (token === undefined) throw new GraphQLSyntaxError('Syntax Error: Unexpected end of input.'); return token; }
  private expect(value: string): void { if (!this.peek(value)) throw new GraphQLSyntaxError(`Syntax Error: Expected ${value}.`); this.offset += 1; }
  private name(): string { const token = this.take(); if (token.kind !== 'name') throw new GraphQLSyntaxError('Syntax Error: Expected a name.'); return token.value; }

  parse(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    if (!this.peek('{')) {
      const operation = this.name();
      if (operation !== 'query' && operation !== 'mutation') throw new GraphQLSyntaxError(`Syntax Error: Unsupported operation ${operation}.`);
      kind = operation;
      if (this.peek()) { // Optional operation name.
        const token = this.tokens[this.offset];
        if (token?.kind === 'name') this.offset += 1;
      }
      if (this.peek('(')) this.skipVariableDefinitions();
    }
    const selections = this.selectionSet();
    if (this.offset !== this.tokens.length) throw new GraphQLSyntaxError('Syntax Error: Unexpected token after the operation.');
    return { kind, selections };
  }

  private skipVariableDefinitions(): void {
    let depth = 0;
    do {
      const token = this.take();
      if (token.value === '(') depth += 1;
      else if (token.value === ')') depth -= 1;
    } while (depth > 0 && this.offset < this.tokens.length);
    if (depth !== 0) throw new GraphQLSyntaxError('Syntax Error: Unterminated variable definitions.');
  }

  private selectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (!this.peek('}')) {
      if (this.offset >= this.tokens.length) throw new GraphQLSyntaxError('Syntax Error: Unterminated selection set.');
      if (this.peek('...')) {
        this.offset += 1;
        this.expect('on');
        const fragmentType = this.name();
        fields.push({ name: '...', alias: '...', arguments: {}, selections: this.selectionSet(), fragmentType });
        continue;
      }
      const first = this.name();
      let name = first;
      let alias = first;
      if (this.peek(':')) { this.offset += 1; name = this.name(); }
      else alias = name;
      const args: Record<string, GqlValue> = {};
      if (this.peek('(')) {
        this.offset += 1;
        while (!this.peek(')')) {
          if (this.offset >= this.tokens.length) throw new GraphQLSyntaxError('Syntax Error: Unterminated arguments.');
          const key = this.name();
          this.expect(':');
          args[key] = this.value();
        }
        this.expect(')');
      }
      fields.push({ name, alias, arguments: args, selections: this.peek('{') ? this.selectionSet() : [] });
    }
    this.expect('}');
    return fields;
  }

  private value(): GqlValue {
    const token = this.take();
    if (token.value === '$') return { variable: this.name() };
    if (token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.peek(']')) values.push(this.value());
      this.expect(']');
      return values;
    }
    if (token.value === '{') {
      const object: Record<string, GqlValue> = {};
      while (!this.peek('}')) { const key = this.name(); this.expect(':'); object[key] = this.value(); }
      this.expect('}');
      return object;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    throw new GraphQLSyntaxError(`Syntax Error: Unexpected value ${token.value}.`);
  }
}

function opaqueId(kind: string, id: number): string { return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64'); }
function decodeId(value: unknown): { kind: string; id: number } | null {
  if (typeof value !== 'string') return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const match = /^(Repository|Issue|PullRequest|Comment):(\d+)$/.exec(decoded);
    return match === null ? null : { kind: match[1], id: Number(match[2]) };
  } catch { return null; }
}
function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if (value !== null && typeof value === 'object') {
    if ('variable' in value) return variables[value.variable];
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, variables)]));
  }
  return value;
}

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};
const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['login', '__typename'],
  Repository: INTROSPECTION_FIELDS.Repository,
  Ref: ['name', '__typename'],
  Issue: INTROSPECTION_FIELDS.Issue,
  PullRequest: INTROSPECTION_FIELDS.PullRequest,
  IssueConnection: ['nodes', 'pageInfo', '__typename'],
  PullRequestConnection: ['nodes', '__typename'],
  PullRequestChangedFileConnection: ['nodes', '__typename'],
  PullRequestChangedFile: ['path', '__typename'],
  PageInfo: ['hasNextPage', 'endCursor', '__typename'],
  __Type: ['name', 'kind', 'fields', 'enumValues', '__typename'],
  __Field: ['name', '__typename'],
  __EnumValue: ['name', '__typename'],
  __Node: ['id', '__typename'],
  Comment: ['id', 'body', '__typename'],
  CommentEdge: ['node', '__typename'],
  CreateIssuePayload: ['issue', '__typename'],
  CloseIssuePayload: ['issue', '__typename'],
  CreatePullRequestPayload: ['pullRequest', '__typename'],
  MergePullRequestPayload: ['pullRequest', '__typename'],
  AddCommentPayload: ['commentEdge', '__typename'],
};

interface GqlContext {
  state: ForgeState;
  viewer: string;
  lookupRepo: RepositoryLookup;
  mergePull: PullMerger;
  errors: Array<{ message: string }>;
}

function repositoryForId(state: ForgeState, id: unknown): RepositoryState | undefined {
  const decoded = decodeId(id);
  if (decoded?.kind !== 'Repository') return undefined;
  for (const repo of state.repositories.values()) if (repo.id === decoded.id) return repo;
  return undefined;
}
function findIssue(state: ForgeState, id: unknown): { repo: RepositoryState; issue: IssueState } | undefined {
  const decoded = decodeId(id);
  if (decoded?.kind !== 'Issue') return undefined;
  for (const repo of state.repositories.values()) {
    for (const issue of repo.issues.values()) if (issue.id === decoded.id) return { repo, issue };
  }
  return undefined;
}
function findPull(state: ForgeState, id: unknown): { repo: RepositoryState; pull: PullRequestState } | undefined {
  const decoded = decodeId(id);
  if (decoded?.kind !== 'PullRequest') return undefined;
  for (const repo of state.repositories.values()) {
    for (const pull of repo.pullRequests.values()) if (pull.id === decoded.id) return { repo, pull };
  }
  return undefined;
}
function cursor(offset: number): string { return Buffer.from(`issues:${offset}`).toString('base64'); }
function cursorOffset(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const match = /^issues:(\d+)$/.exec(decoded);
  return match === null ? 0 : Number(match[1]);
}

function fieldError(context: GqlContext, type: string, field: GqlField): void {
  context.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
}

function executeFields(type: string, value: any, fields: GqlField[], variables: Record<string, unknown>, context: GqlContext): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === '...') {
      if (field.fragmentType === value.__typename) Object.assign(result, executeFields(value.__typename, value, field.selections, variables, context));
      continue;
    }
    if (!TYPE_FIELDS[type]?.includes(field.name)) { fieldError(context, type, field); result[field.alias] = null; continue; }
    if (field.name === '__typename') { result[field.alias] = type; continue; }
    const args = Object.fromEntries(Object.entries(field.arguments).map(([key, val]) => [key, resolveValue(val, variables)]));
    try {
      const resolved = resolveField(type, value, field.name, args, context);
      if (field.selections.length === 0) result[field.alias] = resolved;
      else if (Array.isArray(resolved)) {
        result[field.alias] = resolved.map((entry) => executeFields(entry?.__typename ?? childType(type, field.name), entry, field.selections, variables, context));
      } else {
        result[field.alias] = executeFields(resolved?.__typename ?? childType(type, field.name), resolved, field.selections, variables, context);
      }
    } catch (error) {
      context.errors.push({ message: error instanceof Error ? error.message : String(error) });
      result[field.alias] = null;
    }
  }
  return result;
}

function childType(parent: string, field: string): string {
  if (field === 'viewer' || field === 'owner') return 'User';
  if (field === 'repository' || field === 'node') return 'Repository';
  if (field === 'issue' || field === 'createIssue' || field === 'closeIssue') return field === 'issue' ? 'Issue' : field === 'createIssue' ? 'CreateIssuePayload' : 'CloseIssuePayload';
  if (field === 'issues') return 'IssueConnection';
  if (field === 'pullRequests') return 'PullRequestConnection';
  if (field === 'pullRequest') return 'PullRequest';
  if (field === 'files') return 'PullRequestChangedFileConnection';
  if (field === 'pageInfo') return 'PageInfo';
  if (field === 'nodes') return parent === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFile' : parent === 'PullRequestConnection' ? 'PullRequest' : 'Issue';
  if (field === 'createPullRequest') return 'CreatePullRequestPayload';
  if (field === 'mergePullRequest') return 'MergePullRequestPayload';
  if (field === 'addComment') return 'AddCommentPayload';
  if (field === 'commentEdge') return 'CommentEdge';
  if (field === 'node') return 'Comment';
  if (field === '__type') return '__Type';
  return 'Query';
}

function issueView(issue: IssueState): Record<string, unknown> {
  return { __typename: 'Issue', id: opaqueId('Issue', issue.id), number: issue.number, title: issue.title, state: issue.state.toUpperCase(), body: issue.body, createdAt: issue.createdAt, updatedAt: issue.updatedAt };
}
function pullView(pull: PullRequestState): Record<string, unknown> {
  return { __typename: 'PullRequest', id: opaqueId('PullRequest', pull.id), number: pull.number, state: pull.merged ? 'MERGED' : pull.state.toUpperCase(), merged: pull.merged, headRefName: pull.headRefName, baseRefName: pull.baseRefName, mergeable: pull.mergeable };
}
function resolveField(type: string, value: any, field: string, args: Record<string, unknown>, context: GqlContext): any {
  const state = context.state;
  const checkFirst = (first: unknown, fieldName: string): void => {
    if (first !== undefined && first !== null && (!Number.isInteger(first) || (first as number) < 0)) {
      throw new Error(`Argument "first" on field "${fieldName}" must be a non-negative integer.`);
    }
  };
  if (field === '__type') {
    const name = args.name;
    return typeof name === 'string' ? { __typename: '__Type', typeName: name } : null;
  }
  if (field === 'fields') {
    const names = INTROSPECTION_FIELDS[value.typeName];
    return names?.map((name) => ({ __typename: '__Field', name })) ?? null;
  }
  if (field === 'enumValues') return INTROSPECTION_ENUMS[value.typeName]?.map((name) => ({ __typename: '__EnumValue', name })) ?? null;
  if (field === 'name' && type === '__Type') return value.typeName;
  if (field === 'kind' && type === '__Type') return INTROSPECTION_FIELDS[value.typeName] ? 'OBJECT' : INTROSPECTION_ENUMS[value.typeName] ? 'ENUM' : null;
  if (type === 'Query' && field === 'viewer') return { __typename: 'User', login: context.viewer };
  if (type === 'Query' && field === 'repository') {
    if (typeof args.owner !== 'string' || typeof args.name !== 'string') throw new Error('Field "repository" requires owner and name arguments.');
    const repo = context.lookupRepo(args.owner, args.name);
    return repo === undefined ? null : { __typename: 'Repository', repo };
  }
  if (type === 'Query' && field === 'node') {
    if (typeof args.id !== 'string') throw new Error('Field "node" requires an id string.');
    const repo = repositoryForId(state, args.id);
    return repo === undefined ? null : { __typename: 'Repository', repo };
  }
  if (type === 'Query' && field === '__typename') return 'Query';
  if (type === 'Mutation' && field === '__typename') return 'Mutation';
  if (type === 'User' && field === 'login') return value.login;
  if (type === 'Ref') return value[field];
  if (type === 'Repository') {
    const repo = value.repo as RepositoryState;
    if (field === 'id') return opaqueId('Repository', repo.id);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner ?? context.viewer}/${repo.name}`;
    if (field === 'owner') return { __typename: 'User', login: repo.owner ?? context.viewer };
    if (field === 'defaultBranchRef') return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      if (!Number.isInteger(args.number) || (args.number as number) < 1) throw new Error('Field "issue" requires a positive integer number.');
      return repo.issues.get(args.number as number) ? issueView(repo.issues.get(args.number as number)!) : null;
    }
    if (field === 'issues') {
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? args.states as string[] : undefined;
      checkFirst(args.first, 'issues');
      if (args.states !== undefined && args.states !== null && (!Array.isArray(args.states) || states?.some((entry) => entry !== 'OPEN' && entry !== 'CLOSED'))) {
        throw new Error('Argument "states" on field "issues" must contain OPEN or CLOSED.');
      }
      if (states !== undefined && states.length > 0) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = args.orderBy as Record<string, unknown> | null | undefined;
      if (orderBy != null && (orderBy.field !== 'CREATED_AT' && orderBy.field !== 'UPDATED_AT' && orderBy.field !== 'COMMENTS' || orderBy.direction !== 'ASC' && orderBy.direction !== 'DESC')) {
        throw new Error('Argument "orderBy" on field "issues" is invalid.');
      }
      const desc = orderBy?.direction === 'DESC' || (orderBy === undefined && args.after === undefined);
      issues.sort((a, b) => (desc ? -1 : 1) * (a.createdAt.localeCompare(b.createdAt) || a.number - b.number));
      const offset = cursorOffset(args.after);
      const first = Number.isInteger(args.first) && (args.first as number) >= 0 ? args.first as number : issues.length;
      const nodes = issues.slice(offset, offset + first).map(issueView);
      const end = offset + nodes.length;
      return { __typename: 'IssueConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: end < issues.length, endCursor: nodes.length === 0 ? null : cursor(end) } };
    }
    if (field === 'pullRequests') {
      checkFirst(args.first, 'pullRequests');
      const first = Number.isInteger(args.first) && (args.first as number) >= 0 ? args.first as number : 30;
      const nodes = [...repo.pullRequests.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number).slice(0, first).map(pullView);
      return { __typename: 'PullRequestConnection', nodes };
    }
    if (field === 'pullRequest') {
      if (!Number.isInteger(args.number) || (args.number as number) < 1) throw new Error('Field "pullRequest" requires a positive integer number.');
      const pull = repo.pullRequests.get(Number(args.number));
      return pull === undefined ? null : { ...pullView(pull), pull, repo };
    }
  }
  if (type === 'Issue') return value[field];
  if (type === 'PullRequest') {
    if (field !== 'files') return value[field];
    const wrapper = value as { pull?: PullRequestState; repo?: RepositoryState };
    const pull = wrapper.pull ?? value as PullRequestState;
    const repo = wrapper.repo;
    if (repo === undefined) return { __typename: 'PullRequestChangedFileConnection', nodes: [] };
    checkFirst(args.first, 'files');
    const base = repo.commits.get(pull.baseSha)?.files ?? new Map<string, Buffer>();
    const head = repo.commits.get(pull.headSha)?.files ?? new Map<string, Buffer>();
    const paths = [...new Set([...base.keys(), ...head.keys()])].filter((path) => {
      const left = base.get(path); const right = head.get(path);
      return left === undefined ? right !== undefined : right === undefined || !left.equals(right);
    }).sort();
    const first = Number.isInteger(args.first) && (args.first as number) >= 0 ? args.first as number : paths.length;
    return { __typename: 'PullRequestChangedFileConnection', nodes: paths.slice(0, first).map((path) => ({ __typename: 'PullRequestChangedFile', path })) };
  }
  if (type === '__Field' || type === '__EnumValue') return value[field];
  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestChangedFileConnection' || type === 'PageInfo' || type === 'PullRequestChangedFile' || type === 'Comment' || type === 'CommentEdge' || type.endsWith('Payload')) return value[field];

  if (type === 'Mutation') {
    const input = args.input as Record<string, unknown> | undefined;
    if (input === undefined || input === null || typeof input !== 'object') throw new Error(`Field "${field}" requires an input object.`);
    if (field === 'createIssue') {
      if (typeof input.repositoryId !== 'string' || typeof input.title !== 'string' || (input.body !== undefined && typeof input.body !== 'string')) {
        throw new Error('createIssue input requires repositoryId and title strings; body must be a string when provided.');
      }
      const repo = repositoryForId(state, input.repositoryId);
      if (repo === undefined) return null;
      const issue = createIssue(state, repo, { title: input.title, ...(typeof input.body === 'string' ? { body: input.body } : {}) });
      return issue === null ? null : { __typename: 'CreateIssuePayload', issue: issueView(issue) };
    }
    if (field === 'closeIssue') {
      if (typeof input.issueId !== 'string') throw new Error('closeIssue input requires an issueId string.');
      const found = findIssue(state, input.issueId);
      if (found === undefined) return null;
      const issue = setIssueState(state, found.repo, found.issue.number, 'closed');
      return issue === null ? null : { __typename: 'CloseIssuePayload', issue: issueView(issue) };
    }
    if (field === 'createPullRequest') {
      if (typeof input.repositoryId !== 'string' || typeof input.title !== 'string' || typeof input.headRefName !== 'string' || typeof input.baseRefName !== 'string') {
        throw new Error('createPullRequest input requires repositoryId, title, headRefName, and baseRefName strings.');
      }
      const repo = repositoryForId(state, input.repositoryId);
      if (repo === undefined) return null;
      const pull = createPullRequest(state, repo, { title: input.title, head: input.headRefName, base: input.baseRefName });
      return pull === null ? null : { __typename: 'CreatePullRequestPayload', pullRequest: pullView(pull) };
    }
    if (field === 'mergePullRequest') {
      if (typeof input.pullRequestId !== 'string' || !['MERGE', 'SQUASH', 'REBASE'].includes(String(input.mergeMethod))) {
        throw new Error('mergePullRequest input requires pullRequestId and a valid mergeMethod.');
      }
      const found = findPull(state, input.pullRequestId);
      if (found === undefined) return null;
      const merged = context.mergePull(found.repo, found.pull, context.viewer);
      return merged === null ? null : { __typename: 'MergePullRequestPayload', pullRequest: { ...pullView(found.pull), merged: true } };
    }
    if (field === 'addComment') {
      if (typeof input.subjectId !== 'string' || typeof input.body !== 'string') throw new Error('addComment input requires subjectId and body strings.');
      const found = findIssue(state, input.subjectId);
      if (found === undefined) return null;
      const comment = addIssueComment(state, found.repo, found.issue.number, input.body);
      return comment === null ? null : { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: opaqueId('Comment', comment.id), body: comment.body } } };
    }
  }
  return null;
}

function runDocument(query: string, variables: Record<string, unknown>, context: GqlContext): Record<string, unknown> {
  try {
    const operation = new GqlParser(tokenize(query)).parse();
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeFields(rootType, { __typename: rootType }, operation.selections, variables, context);
    return context.errors.length > 0 ? { data, errors: context.errors } : { data };
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

export function executeGraphQL(
  state: ForgeState,
  body: unknown,
  viewer: string,
  lookupRepo: RepositoryLookup,
  mergePull: PullMerger,
): { status: number; result: unknown } {
  const executeOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { data: null, errors: [{ message: 'GraphQL request must be an object.' }] };
    const request = entry as Record<string, unknown>;
    if (typeof request.query !== 'string') return { data: null, errors: [{ message: 'The query field must be a string.' }] };
    const variables = request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)
      ? request.variables as Record<string, unknown>
      : {};
    return runDocument(request.query, variables, { state, viewer, lookupRepo, mergePull, errors: [] });
  };
  if (Array.isArray(body)) return { status: 200, result: body.map(executeOne) };
  return { status: 200, result: executeOne(body) };
}
