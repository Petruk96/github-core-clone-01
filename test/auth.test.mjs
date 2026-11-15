import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.ts';

const TEST_TOKEN = 'node-test-only-token-not-a-secret';
process.env.MAKEFUN_SHOP_TOKEN = TEST_TOKEN;

const server = createApp();
let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function assertJsonResponse(response) {
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
}

function assertRequestId(response) {
  assert.ok(response.headers.get('x-github-request-id'), 'REST response should carry a request ID');
}

async function assertUnauthorized(response) {
  assert.equal(response.status, 401);
  assertJsonResponse(response);
  assertRequestId(response);
  const body = await response.json();
  assert.equal(typeof body.message, 'string');
}

test('health probe remains unauthenticated', async () => {
  const response = await request('/healthz');
  assert.equal(response.status, 200);
  assertJsonResponse(response);
  assert.deepEqual(await response.json(), { ok: true });
});

test('REST rejects a missing credential with JSON, message, and request ID', async () => {
  await assertUnauthorized(await request('/api/v3/meta'));
});

test('REST rejects an invalid credential with JSON, message, and request ID', async () => {
  await assertUnauthorized(await request('/api/v3/meta', { token: 'wrong-test-token' }));
});

test('REST accepts the isolated test credential and returns meta with a request ID', async () => {
  const response = await request('/api/v3/meta', { token: TEST_TOKEN });
  assert.equal(response.status, 200);
  assertJsonResponse(response);
  assertRequestId(response);
  const body = await response.json();
  assert.equal(typeof body.installed_version, 'string');
  assert.ok(body.installed_version.length > 0);
});

test('REST API root retains scopes and request ID with valid credentials', async () => {
  const response = await request('/api/v3/', { token: TEST_TOKEN });
  assert.equal(response.status, 200);
  assertJsonResponse(response);
  assertRequestId(response);
  assert.match(response.headers.get('x-oauth-scopes') ?? '', /repo/);
  assert.match(response.headers.get('x-oauth-scopes') ?? '', /read:org/);
});

test('authenticated unknown REST routes return JSON 404 with a request ID', async () => {
  const response = await request('/api/v3/not-implemented', { token: TEST_TOKEN });
  assert.equal(response.status, 404);
  assertJsonResponse(response);
  assertRequestId(response);
  assert.equal(typeof (await response.json()).message, 'string');
});

test('GraphQL rejects missing credentials', async () => {
  await assertUnauthorized(await request('/api/graphql', {
    method: 'POST',
    body: { query: '{ __typename }' },
  }));
});

test('GraphQL rejects invalid credentials', async () => {
  await assertUnauthorized(await request('/api/graphql', {
    method: 'POST',
    token: 'wrong-test-token',
    body: { query: '{ __typename }' },
  }));
});

test('GraphQL accepts valid credentials past the authentication gate', async () => {
  const response = await request('/api/graphql', {
    method: 'POST',
    token: TEST_TOKEN,
    body: { query: '{ __typename }' },
  });
  assert.notEqual(response.status, 401);
});

test('MCP rejects calls without credentials', async () => {
  await assertUnauthorized(await request('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  }));
});

test('MCP rejects calls with invalid credentials', async () => {
  await assertUnauthorized(await request('/mcp', {
    method: 'POST',
    token: 'wrong-test-token',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  }));
});

test('MCP accepts valid credentials past the authentication gate', async () => {
  const response = await request('/mcp', {
    method: 'POST',
    token: TEST_TOKEN,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.notEqual(response.status, 401);
});

test('Git smart HTTP rejects missing credentials', async () => {
  await assertUnauthorized(await request('/owner/repo.git/info/refs?service=git-upload-pack'));
});

test('Git smart HTTP rejects invalid credentials', async () => {
  await assertUnauthorized(await request('/owner/repo.git/info/refs?service=git-upload-pack', {
    token: 'wrong-test-token',
  }));
});

test('Git smart HTTP accepts valid credentials past the authentication gate', async () => {
  const response = await request('/owner/repo.git/info/refs?service=git-upload-pack', { token: TEST_TOKEN });
  assert.notEqual(response.status, 401);
});

test('unrelated unknown paths retain 404 without credentials', async () => {
  const response = await request('/unrelated');
  assert.equal(response.status, 404);
  assertJsonResponse(response);
  assert.equal((await response.json()).message, 'Not Found');
});
