import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.ts';

const TOKEN = 'issues-rest-test-token-only';
const OWNER = 'issues-rest-owner';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
process.env.MAKEFUN_TRIAL_NOW = '2026-11-15T12:00:00Z';

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

async function request(path, { method = 'GET', body } = {}, url = baseUrl) {
  return fetch(`${url}${path}`, {
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

async function createRepository(url = baseUrl, name = 'issues-repo') {
  const response = await request('/api/v3/user/repos', { method: 'POST', body: { name } }, url);
  assertRest(response, 201);
}

test('label CRUD stays linked to issues and deletion removes the issue relation', async () => {
  await createRepository();
  const collection = `/api/v3/repos/${OWNER}/issues-repo/labels`;
  const created = await request(collection, { method: 'POST', body: { name: 'bug', color: '#d73a4a' } });
  assertRest(created, 201);
  assert.deepEqual(await created.json(), { id: 1, name: 'bug', color: 'd73a4a' });

  const issueResponse = await request(`/api/v3/repos/${OWNER}/issues-repo/issues`, {
    method: 'POST', body: { title: 'linked issue', body: 'details', labels: ['BUG'] },
  });
  assertRest(issueResponse, 201);
  const issue = await issueResponse.json();
  assert.equal(issue.number, 1);
  assert.deepEqual(issue.labels.map(({ name }) => name), ['bug']);

  const listed = await request(collection);
  assertRest(listed, 200);
  assert.deepEqual((await listed.json()).map(({ name }) => name), ['bug']);

  const updated = await request(`${collection}/bug`, { method: 'PATCH', body: { name: 'defect', color: 'abcdef' } });
  assertRest(updated, 200);
  assert.deepEqual(await updated.json(), { id: 1, name: 'defect', color: 'abcdef' });
  const issueAfterRename = await request(`/api/v3/repos/${OWNER}/issues-repo/issues/1`);
  assert.deepEqual((await issueAfterRename.json()).labels.map(({ name }) => name), ['defect']);

  const deleted = await request(`${collection}/defect`, { method: 'DELETE' });
  assertRest(deleted, 204);
  const issueAfterDelete = await request(`/api/v3/repos/${OWNER}/issues-repo/issues/1`);
  assert.deepEqual((await issueAfterDelete.json()).labels, []);
});

test('issues create, list, get, update, close, filter, and sort through shared state', async () => {
  await createRepository(baseUrl, 'issue-operations');
  const collection = `/api/v3/repos/${OWNER}/issue-operations/issues`;
  const firstResponse = await request(collection, { method: 'POST', body: { title: 'first', body: 'one' } });
  assertRest(firstResponse, 201);
  const first = await firstResponse.json();
  const secondResponse = await request(collection, { method: 'POST', body: { title: 'second', body: 'two' } });
  assertRest(secondResponse, 201);
  const second = await secondResponse.json();
  assert.equal(first.number, 1);
  assert.equal(second.number, 2);
  assert.ok(first.id < second.id);
  assert.ok(first.created_at < second.created_at);

  const patched = await request(`${collection}/1`, { method: 'PATCH', body: { title: 'renamed', state: 'closed' } });
  assertRest(patched, 200);
  const updated = await patched.json();
  assert.equal(updated.title, 'renamed');
  assert.equal(updated.state, 'closed');
  assert.ok(updated.updated_at > first.updated_at);

  const read = await request(`${collection}/1`);
  assertRest(read, 200);
  assert.equal((await read.json()).state, 'closed');
  const open = await request(`${collection}?state=open&sort=created&direction=asc&per_page=100`);
  assertRest(open, 200);
  assert.deepEqual((await open.json()).map(({ number }) => number), [2]);
  const all = await request(`${collection}?state=all&sort=created&direction=desc`);
  assert.deepEqual((await all.json()).map(({ number }) => number), [2, 1]);
});

test('comments create and list retain deterministic IDs, timestamps, and issue relation', async () => {
  await createRepository(baseUrl, 'comment-operations');
  const issues = `/api/v3/repos/${OWNER}/comment-operations/issues`;
  const issueResponse = await request(issues, { method: 'POST', body: { title: 'comment target' } });
  const issue = await issueResponse.json();
  const comments = `${issues}/${issue.number}/comments`;

  const firstResponse = await request(comments, { method: 'POST', body: { body: 'first comment' } });
  assertRest(firstResponse, 201);
  const first = await firstResponse.json();
  const secondResponse = await request(comments, { method: 'POST', body: { body: 'second comment' } });
  assertRest(secondResponse, 201);
  const second = await secondResponse.json();
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.ok(first.created_at < second.created_at);

  const listed = await request(comments);
  assertRest(listed, 200);
  assert.deepEqual((await listed.json()).map(({ body }) => body), ['first comment', 'second comment']);
  const issueAfterComments = await request(`${issues}/${issue.number}`);
  assert.ok((await issueAfterComments.json()).updated_at > issue.updated_at);
});

test('same REST operation sequence yields deterministic issue IDs and timestamps in fresh apps', async () => {
  const app = createApp();
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    await createRepository(url, 'deterministic-issues');
    const response = await request(`/api/v3/repos/${OWNER}/deterministic-issues/issues`, {
      method: 'POST', body: { title: 'same input', body: 'same body' },
    }, url);
    const issue = await response.json();
    assert.equal(issue.id, 1);
    assert.equal(issue.number, 1);
    assert.equal(issue.created_at, '2026-11-15T12:00:00.000Z');
  } finally {
    await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  }
});
