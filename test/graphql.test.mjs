import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.ts';

const TOKEN = 'graphql-test-isolated-token-only';
const OWNER = 'graphql-test-owner';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
process.env.MAKEFUN_TRIAL_NOW = '2026-11-15T15:00:00Z';

const server = createApp();
let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function graphql(query, variables = {}, { token = TOKEN, rawBody } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/api/graphql`, {
    method: 'POST', headers,
    body: rawBody ?? JSON.stringify({ query, variables }),
  });
}

async function rest(path, { method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function assertRest(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.ok(response.headers.get('x-github-request-id'));
}

async function createRepo(name) {
  const created = await rest('/api/v3/user/repos', { method: 'POST', body: { name } });
  assertRest(created, 201);
  const loaded = await rest(`/api/v3/repos/${OWNER}/${name}`);
  assertRest(loaded, 200);
  return loaded.json();
}

test('GraphQL bearer authentication returns 401 when missing or invalid', async () => {
  const missing = await graphql('{ viewer { login } }', {}, { token: null });
  assert.equal(missing.status, 401);
  const invalid = await graphql('{ viewer { login } }', {}, { token: 'not-the-test-token' });
  assert.equal(invalid.status, 401);
});

test('viewer, repository fields, opaque node IDs, and required introspection resolve', async () => {
  const repo = await createRepo('graphql-queries');
  const response = await graphql(`query Repo($owner: String!, $name: String!, $id: ID!) {
    viewer { login }
    repository(owner: $owner, name: $name) { id databaseId name nameWithOwner owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled }
    node(id: $id) { id ... on Repository { name nameWithOwner } }
  }`, { owner: OWNER, name: repo.name, id: Buffer.from(`Repository:${repo.id}`).toString('base64') });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.errors, undefined);
  assert.equal(body.data.viewer.login, OWNER);
  assert.equal(body.data.repository.id, Buffer.from(`Repository:${repo.id}`).toString('base64'));
  assert.equal(body.data.repository.databaseId, repo.id);
  assert.equal(body.data.repository.nameWithOwner, `${OWNER}/${repo.name}`);
  assert.equal(body.data.repository.owner.login, OWNER);
  assert.equal(body.data.repository.viewerPermission, 'ADMIN');
  assert.equal(body.data.repository.hasIssuesEnabled, true);
  assert.equal(body.data.node.name, repo.name);

  const introspection = await graphql(`query {
    Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } }
    PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } }
    Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } }
    SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } }
  }`);
  const types = (await introspection.json()).data;
  for (const name of ['id', 'number', 'title', 'state', 'body']) assert.ok(types.Issue.fields.some((field) => field.name === name));
  for (const name of ['headRefName', 'baseRefName', 'mergeable', 'merged', 'files']) assert.ok(types.PullRequest.fields.some((field) => field.name === name));
  for (const name of ['databaseId', 'nameWithOwner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']) assert.ok(types.Repository.fields.some((field) => field.name === name));
  assert.ok(types.SearchType.enumValues.some((entry) => entry.name === 'ISSUE'));
});

test('GraphQL issue creation, close, and comment mutations share REST and MCP IDs/timestamps', async () => {
  const repoName = 'graphql-shared-issues';
  const repo = await createRepo(repoName);
  const repositoryId = Buffer.from(`Repository:${repo.id}`).toString('base64');
  const createdResponse = await graphql(`mutation Create($input: CreateIssueInput!) {
    createIssue(input: $input) { issue { id number title state body createdAt updatedAt } }
  }`, { input: { repositoryId, title: 'created by GraphQL', body: 'shared text' } });
  const created = (await createdResponse.json()).data.createIssue.issue;
  assert.equal(created.state, 'OPEN');
  assert.equal(created.number, 1);
  assert.equal(created.id, Buffer.from('Issue:1').toString('base64'));

  const restIssueResponse = await rest(`/api/v3/repos/${OWNER}/${repoName}/issues/${created.number}`);
  assertRest(restIssueResponse, 200);
  const restIssue = await restIssueResponse.json();
  assert.equal(restIssue.id, 1);
  assert.equal(restIssue.title, created.title);
  assert.equal(restIssue.created_at, created.createdAt);

  const mcpResponse = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'create_issue' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 80, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: OWNER, repo: repoName, title: 'created by MCP', body: 'also shared' }, _meta: { protocolVersion: '2026-07-28' } } }),
  });
  const mcpRpc = await mcpResponse.json();
  const mcpIssue = JSON.parse(mcpRpc.result.content[0].text);
  assert.equal(mcpIssue.id, 2);
  const graphRead = await graphql(`query Read($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { issue(number: $number) { id number title createdAt updatedAt } }
  }`, { owner: OWNER, name: repoName, number: mcpIssue.number });
  const graphIssue = (await graphRead.json()).data.repository.issue;
  const mcpRestResponse = await rest(`/api/v3/repos/${OWNER}/${repoName}/issues/${mcpIssue.number}`);
  const mcpRestIssue = await mcpRestResponse.json();
  assert.equal(graphIssue.id, Buffer.from(`Issue:${mcpIssue.id}`).toString('base64'));
  assert.equal(graphIssue.createdAt, mcpRestIssue.created_at);
  assert.equal(graphIssue.updatedAt, mcpRestIssue.updated_at);

  const closedResponse = await graphql(`mutation Close($input: CloseIssueInput!) {
    closeIssue(input: $input) { issue { id number state } }
  }`, { input: { issueId: created.id } });
  assert.equal((await closedResponse.json()).data.closeIssue.issue.state, 'CLOSED');
  const afterClose = await rest(`/api/v3/repos/${OWNER}/${repoName}/issues/1`);
  assert.equal((await afterClose.json()).state, 'closed');

  const commentResponse = await graphql(`mutation Add($input: AddCommentInput!) {
    addComment(input: $input) { commentEdge { node { id body } } }
  }`, { input: { subjectId: created.id, body: 'comment from GraphQL' } });
  assert.equal((await commentResponse.json()).data.addComment.commentEdge.node.body, 'comment from GraphQL');
  const comments = await rest(`/api/v3/repos/${OWNER}/${repoName}/issues/1/comments`);
  assert.ok((await comments.json()).some((comment) => comment.body === 'comment from GraphQL'));
});

test('defaultBranchRef.name resolves and repository and issue global IDs stay stable across reads', async () => {
  const repoName = 'graphql-ref-and-stable-ids';
  const repo = await createRepo(repoName);
  const file = await rest(`/api/v3/repos/${OWNER}/${repoName}/contents/base.txt`, {
    method: 'PUT', body: { message: 'seed main', content: Buffer.from('base').toString('base64') },
  });
  assertRest(file, 201);
  const issueResponse = await rest(`/api/v3/repos/${OWNER}/${repoName}/issues`, {
    method: 'POST', body: { title: 'stable global ID' },
  });
  assertRest(issueResponse, 201);
  const issue = await issueResponse.json();

  const query = `query Repo($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { id databaseId defaultBranchRef { name } issue(number: 1) { id } }
  }`;
  const variables = { owner: OWNER, name: repoName };
  const firstResponse = await graphql(query, variables);
  const firstBody = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.errors, undefined);
  assert.equal(firstBody.data.repository.defaultBranchRef.name, 'main');
  const secondBody = await (await graphql(query, variables)).json();
  assert.equal(secondBody.errors, undefined);
  assert.equal(firstBody.data.repository.id, secondBody.data.repository.id);
  assert.notEqual(firstBody.data.repository.id, String(repo.id));
  assert.equal(firstBody.data.repository.issue.id, Buffer.from(`Issue:${issue.id}`).toString('base64'));
  assert.equal(firstBody.data.repository.issue.id, secondBody.data.repository.issue.id);
});

test('GraphQL pull request creation, file listing, and squash merge update the shared REST PR', async () => {
  const repoName = 'graphql-shared-pulls';
  const repo = await createRepo(repoName);
  const base = await rest(`/api/v3/repos/${OWNER}/${repoName}/contents/base.txt`, {
    method: 'PUT', body: { message: 'seed', content: Buffer.from('base\n').toString('base64') },
  });
  const baseCommit = (await base.json()).commit.sha;
  const branch = await rest(`/api/v3/repos/${OWNER}/${repoName}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/feature', sha: baseCommit } });
  assertRest(branch, 201);
  await rest(`/api/v3/repos/${OWNER}/${repoName}/contents/feature.txt`, {
    method: 'PUT', body: { message: 'feature', content: Buffer.from('feature\n').toString('base64'), branch: 'feature' },
  });
  const created = await graphql(`mutation CreatePull($input: CreatePullRequestInput!) {
    createPullRequest(input: $input) { pullRequest { id number state headRefName baseRefName } }
  }`, { input: { repositoryId: Buffer.from(`Repository:${repo.id}`).toString('base64'), baseRefName: 'main', headRefName: 'feature', title: 'GraphQL PR' } });
  const pull = (await created.json()).data.createPullRequest.pullRequest;
  assert.equal(pull.state, 'OPEN');
  assert.equal(pull.headRefName, 'feature');
  const restPull = await rest(`/api/v3/repos/${OWNER}/${repoName}/pulls/${pull.number}`);
  assert.equal((await restPull.json()).id, pull.number);

  const files = await graphql(`query Files($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 10) { nodes { path } } } }
  }`, { owner: OWNER, name: repoName, number: pull.number });
  assert.ok((await files.json()).data.repository.pullRequest.files.nodes.some((file) => file.path === 'feature.txt'));

  const merged = await graphql(`mutation Merge($input: MergePullRequestInput!) {
    mergePullRequest(input: $input) { pullRequest { number merged state } }
  }`, { input: { pullRequestId: pull.id, mergeMethod: 'SQUASH' } });
  assert.equal((await merged.json()).data.mergePullRequest.pullRequest.merged, true);
  const after = await rest(`/api/v3/repos/${OWNER}/${repoName}/pulls/${pull.number}`);
  const finalPull = await after.json();
  assert.equal(finalPull.state, 'closed');
  assert.equal(finalPull.merged, true);
});

test('GraphQL issue filters, deterministic sorting, and cursor pages return unique shared issues', async () => {
  const repoName = 'graphql-issue-pages';
  const repo = await createRepo(repoName);
  for (let index = 1; index <= 7; index += 1) {
    const created = await rest(`/api/v3/repos/${OWNER}/${repoName}/issues`, { method: 'POST', body: { title: `issue ${index}` } });
    assertRest(created, 201);
  }
  await rest(`/api/v3/repos/${OWNER}/${repoName}/issues/1`, { method: 'PATCH', body: { state: 'closed' } });
  const query = `query Page($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } }
  }`;
  const variables = { owner: OWNER, name: repoName, first: 5, after: null };
  const first = (await (await graphql(query, variables)).json()).data.repository.issues;
  assert.equal(first.nodes.length, 5);
  assert.equal(first.pageInfo.hasNextPage, true);
  const second = (await (await graphql(query, { ...variables, after: first.pageInfo.endCursor })).json()).data.repository.issues;
  assert.equal(second.nodes.length, 2);
  assert.equal(second.pageInfo.hasNextPage, false);
  const all = [...first.nodes, ...second.nodes].map(({ number }) => number);
  assert.equal(new Set(all).size, 7);

  const filtered = await graphql(`query Ordered($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number state } } }
  }`, { owner: OWNER, name: repoName, first: 10 });
  const open = (await filtered.json()).data.repository.issues.nodes;
  assert.equal(open.length, 6);
  assert.ok(open.every((issue) => issue.state === 'OPEN'));
  assert.equal(open[0].number, 7);
});

test('GraphQL syntax and unknown-field errors are returned in GraphQL response format', async () => {
  const invalidSyntax = await graphql('query { viewer { login }');
  assert.equal(invalidSyntax.status, 200);
  assert.match((await invalidSyntax.json()).errors[0].message, /Syntax Error/);

  const invalidJson = await graphql('', {}, { rawBody: '{bad-json' });
  assert.equal(invalidJson.status, 400);
  assert.equal(typeof (await invalidJson.json()).errors[0].message, 'string');

  const invalidField = await graphql('{ viewer { noSuchFieldOnViewer } }');
  assert.equal(invalidField.status, 200);
  assert.match((await invalidField.json()).errors[0].message, /noSuchFieldOnViewer/);

  const invalidArgument = await graphql('{ repository(owner: 5, name: "x") { name } }');
  assert.equal(invalidArgument.status, 200);
  assert.match((await invalidArgument.json()).errors[0].message, /requires owner and name arguments/);

  const unknownRepo = await graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){name}}', { owner: OWNER, name: 'missing-graphql-repository' });
  assert.deepEqual((await unknownRepo.json()), { data: { repository: null } });

  const batch = await graphql('', {}, { rawBody: JSON.stringify([{ query: '{ viewer { login } }' }, { query: '{ __type(name: "Issue") { fields { name } } }' }]) });
  assert.equal(batch.status, 200);
  const batchResults = await batch.json();
  assert.equal(batchResults.length, 2);
  assert.equal(batchResults[0].data.viewer.login, OWNER);
  assert.ok(batchResults[1].data.__type.fields.length > 0);
});
