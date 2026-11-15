import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.ts';

const TOKEN = 'mcp-rest-parity-test-token-only';
const OWNER = 'mcp-rest-owner';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
process.env.MAKEFUN_TRIAL_NOW = '2026-11-15T14:00:00Z';

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

async function postMcp(method, params = {}, { token = TOKEN, id = 1, rawBody } = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-method': method,
    'mcp-protocol-version': '2026-07-28',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (method === 'tools/call' && typeof params.name === 'string') headers['mcp-name'] = params.name;
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers,
    body: rawBody ?? JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', protocolVersion: '2026-07-28' } } }),
  });
}

async function rest(path, { method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function callTool(name, args, id = 20) {
  const response = await postMcp('tools/call', { name, arguments: args }, { id });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.equal(rpc.id, id);
  assert.equal(rpc.jsonrpc, '2.0');
  return rpc.result;
}

function assertRest(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.ok(response.headers.get('x-github-request-id'));
}

test('discover and tools/list advertise stable required tools with schemas', async () => {
  const discoverResponse = await postMcp('server/discover');
  assert.equal(discoverResponse.status, 200);
  const discover = await discoverResponse.json();
  assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'github-core-clone-01');
  assert.ok(discover.result.capabilities.tools);

  const first = await postMcp('tools/list');
  const second = await postMcp('tools/list', {}, { id: 2 });
  const tools = (await first.json()).result.tools;
  assert.deepEqual((await second.json()).result.tools, tools);
  assert.deepEqual(tools.map(({ name }) => name), [
    'create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request',
  ]);
  for (const tool of tools) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('MCP authentication rejects missing and invalid bearer credentials', async () => {
  const missing = await postMcp('tools/call', { name: 'get_repo', arguments: {} }, { token: null });
  assert.equal(missing.status, 401);
  const invalid = await postMcp('tools/list', {}, { token: 'wrong-isolated-test-token' });
  assert.equal(invalid.status, 401);
});

test('MCP JSON parse errors, unknown tools, and missing arguments use protocol errors', async () => {
  const malformed = await postMcp('tools/list', {}, { rawBody: '{not-json' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);

  const unknownRpc = await postMcp('tools/call', { name: 'unknown_tool', arguments: {} });
  assert.equal((await unknownRpc.json()).error.code, -32601);

  const missing = await postMcp('tools/call', { name: 'create_issue', arguments: {} });
  assert.equal((await missing.json()).error.code, -32602);
});

test('MCP-created repository and issue are the exact shared objects REST reads', async () => {
  const repoName = 'mcp-parity-repo';
  const createdRepo = await callTool('create_repo', { owner: OWNER, name: repoName, description: 'created over MCP', private: true });
  assert.equal(createdRepo.isError, undefined);
  const repo = JSON.parse(createdRepo.content[0].text);
  assert.equal(repo.id, 1);

  const issueResult = await callTool('create_issue', { owner: OWNER, repo: repoName, title: 'MCP issue', body: 'shared body' });
  const issue = JSON.parse(issueResult.content[0].text);
  assert.equal(issue.id, 1);
  assert.equal(issue.number, 1);

  const repoResponse = await rest(`/api/v3/repos/${OWNER}/${repoName}`);
  assertRest(repoResponse, 200);
  assert.equal((await repoResponse.json()).id, repo.id);
  const issueResponse = await rest(`/api/v3/repos/${OWNER}/${repoName}/issues/1`);
  assertRest(issueResponse, 200);
  const issueRead = await issueResponse.json();
  assert.equal(issueRead.id, issue.id);
  assert.equal(issueRead.title, 'MCP issue');
  assert.equal(issueRead.created_at, issue.created_at);

  const listed = await callTool('list_issues', { owner: OWNER, repo: repoName, state: 'open' });
  assert.equal(JSON.parse(listed.content[0].text)[0].id, issue.id);
  const readRepo = await callTool('get_repo', { owner: OWNER, repo: repoName });
  assert.equal(JSON.parse(readRepo.content[0].text).id, repo.id);
});

test('concurrent MCP calls echo their own request IDs and independent repository results', async () => {
  await rest('/api/v3/user/repos', { method: 'POST', body: { name: 'mcp-concurrent-a' } });
  await rest('/api/v3/user/repos', { method: 'POST', body: { name: 'mcp-concurrent-b' } });
  const [left, right] = await Promise.all([
    postMcp('tools/call', { name: 'get_repo', arguments: { owner: OWNER, repo: 'mcp-concurrent-a' } }, { id: 'left-call' }),
    postMcp('tools/call', { name: 'get_repo', arguments: { owner: OWNER, repo: 'mcp-concurrent-b' } }, { id: 'right-call' }),
  ]);
  const leftRpc = await left.json();
  const rightRpc = await right.json();
  assert.equal(leftRpc.id, 'left-call');
  assert.equal(rightRpc.id, 'right-call');
  assert.match(leftRpc.result.content[0].text, /mcp-concurrent-a/);
  assert.match(rightRpc.result.content[0].text, /mcp-concurrent-b/);
});

test('MCP pull creation and merge update the PR that REST reads', async () => {
  const repo = 'mcp-pr-parity';
  const created = await rest('/api/v3/user/repos', { method: 'POST', body: { name: repo } });
  assertRest(created, 201);
  const seedResponse = await rest(`/api/v3/repos/${OWNER}/${repo}/contents/base.txt`, {
    method: 'PUT', body: { message: 'seed base', content: Buffer.from('base\n').toString('base64') },
  });
  assertRest(seedResponse, 201);
  const seed = await seedResponse.json();
  const branch = await rest(`/api/v3/repos/${OWNER}/${repo}/git/refs`, {
    method: 'POST', body: { ref: 'refs/heads/feature', sha: seed.commit.sha },
  });
  assertRest(branch, 201);
  const feature = await rest(`/api/v3/repos/${OWNER}/${repo}/contents/change.txt`, {
    method: 'PUT', body: { message: 'add feature', content: Buffer.from('feature\n').toString('base64'), branch: 'feature' },
  });
  assertRest(feature, 201);

  const createdPull = await callTool('create_pull_request', {
    owner: OWNER, repo, title: 'MCP pull', body: 'from MCP', head: 'feature', base: 'main',
  });
  const pull = JSON.parse(createdPull.content[0].text);
  assert.equal(pull.head.ref, 'feature');
  const restPull = await rest(`/api/v3/repos/${OWNER}/${repo}/pulls/${pull.number}`);
  assert.equal((await restPull.json()).id, pull.id);

  const merged = await callTool('merge_pull_request', { owner: OWNER, repo, pull_number: pull.number });
  assert.equal(JSON.parse(merged.content[0].text).merged, true);
  const after = await rest(`/api/v3/repos/${OWNER}/${repo}/pulls/${pull.number}`);
  const pullAfter = await after.json();
  assert.equal(pullAfter.id, pull.id);
  assert.equal(pullAfter.merged, true);
  assert.equal(pullAfter.state, 'closed');
});

test('legacy initialize handshake is accepted and notifications return no body', async () => {
  const init = await postMcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-test', version: '1' } });
  assert.equal((await init.json()).result.protocolVersion, '2025-11-25');
  const notification = await postMcp('notifications/initialized', {}, {
    rawBody: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: { protocolVersion: '2025-11-25' } } }),
  });
  assert.equal(notification.status, 202);
});
