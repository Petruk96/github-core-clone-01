import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.ts';

const TOKEN = 'pulls-rest-test-token-only';
const OWNER = 'pulls-rest-owner';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
process.env.MAKEFUN_TRIAL_NOW = '2026-11-15T13:00:00Z';

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

async function request(path, { method = 'GET', body } = {}) {
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
  const response = await request('/api/v3/user/repos', { method: 'POST', body: { name } });
  assertRest(response, 201);
}

async function writeFile(repo, filePath, content, branch, sha) {
  const response = await request(`/api/v3/repos/${OWNER}/${repo}/contents/${filePath}`, {
    method: 'PUT',
    body: { message: `write ${filePath}`, content: Buffer.from(content).toString('base64'), branch, ...(sha === undefined ? {} : { sha }) },
  });
  assertRest(response, sha === undefined ? 201 : 200);
  return response.json();
}

async function branchAt(repo, branch, sha) {
  const response = await request(`/api/v3/repos/${OWNER}/${repo}/git/refs`, {
    method: 'POST', body: { ref: `refs/heads/${branch}`, sha },
  });
  assertRest(response, 201);
  assert.equal((await response.json()).object.sha, sha);
}

async function openPull(repo, { head, base = 'main', title = `PR ${head}`, body = 'pull body' }) {
  const response = await request(`/api/v3/repos/${OWNER}/${repo}/pulls`, {
    method: 'POST', body: { head, base, title, body },
  });
  assertRest(response, 201);
  return response.json();
}

test('creates, reads, and lists a PR with branch tip snapshots and changed file details', async () => {
  const repo = 'pulls-roundtrip';
  await createRepo(repo);
  const seed = await writeFile(repo, 'README.md', 'base line\n', 'main');
  const baseSha = seed.commit.sha;
  await branchAt(repo, 'feature', baseSha);
  const headCommit = await writeFile(repo, 'docs/new.txt', 'new line\n', 'feature');

  const pull = await openPull(repo, { head: 'feature', title: 'Add a file' });
  assert.equal(pull.number, 1);
  assert.equal(pull.state, 'open');
  assert.equal(pull.title, 'Add a file');
  assert.equal(pull.body, 'pull body');
  assert.deepEqual(pull.head, { ref: 'feature', sha: headCommit.commit.sha });
  assert.deepEqual(pull.base, { ref: 'main', sha: baseSha });
  assert.equal(typeof pull.created_at, 'string');

  const read = await request(`/api/v3/repos/${OWNER}/${repo}/pulls/${pull.number}`);
  assertRest(read, 200);
  assert.deepEqual(await read.json(), pull);
  const listed = await request(`/api/v3/repos/${OWNER}/${repo}/pulls`);
  assertRest(listed, 200);
  assert.deepEqual((await listed.json()).map(({ number }) => number), [1]);
  const filesResponse = await request(`/api/v3/repos/${OWNER}/${repo}/pulls/${pull.number}/files`);
  assertRest(filesResponse, 200);
  assert.deepEqual(await filesResponse.json(), [{ filename: 'docs/new.txt', status: 'added', additions: 1, deletions: 0, changes: 1 }]);
});

test('squash merge closes the PR, updates the base branch, content view, and commit list', async () => {
  const repo = 'pulls-merge';
  await createRepo(repo);
  const seed = await writeFile(repo, 'README.md', 'base\n', 'main');
  await branchAt(repo, 'feature', seed.commit.sha);
  const changed = await writeFile(repo, 'merged.txt', 'merged bytes\n', 'feature');
  const pull = await openPull(repo, { head: 'feature', title: 'Merge feature' });

  const merged = await request(`/api/v3/repos/${OWNER}/${repo}/pulls/${pull.number}/merge`, {
    method: 'PUT', body: { merge_method: 'squash' },
  });
  assertRest(merged, 200);
  const mergeBody = await merged.json();
  assert.equal(mergeBody.merged, true);
  assert.match(mergeBody.sha, /^[0-9a-f]{40}$/);

  const after = await request(`/api/v3/repos/${OWNER}/${repo}/pulls/${pull.number}`);
  const mergedPull = await after.json();
  assert.equal(mergedPull.state, 'closed');
  assert.equal(mergedPull.merged, true);
  assert.equal(mergedPull.merge_commit_sha, mergeBody.sha);
  assert.ok(mergedPull.merged_at);

  const content = await request(`/api/v3/repos/${OWNER}/${repo}/contents/merged.txt?ref=main`);
  assertRest(content, 200);
  assert.equal(Buffer.from((await content.json()).content, 'base64').toString(), 'merged bytes\n');
  const commits = await request(`/api/v3/repos/${OWNER}/${repo}/commits?sha=main`);
  assert.ok((await commits.json()).some(({ sha }) => sha === mergeBody.sha));
  const openList = await request(`/api/v3/repos/${OWNER}/${repo}/pulls`);
  assert.deepEqual(await openList.json(), []);
  const allList = await request(`/api/v3/repos/${OWNER}/${repo}/pulls?state=all`);
  assert.deepEqual((await allList.json()).map(({ number }) => number), [1]);
});

test('merge rejects an unknown PR and detects a file conflict after another PR merges', async () => {
  const repo = 'pulls-conflict';
  await createRepo(repo);
  const seed = await writeFile(repo, 'same.txt', 'base value\n', 'main');
  await branchAt(repo, 'feature-a', seed.commit.sha);
  await branchAt(repo, 'feature-b', seed.commit.sha);
  await writeFile(repo, 'same.txt', 'from branch A\n', 'feature-a', seed.content.sha);
  await writeFile(repo, 'same.txt', 'from branch B\n', 'feature-b', seed.content.sha);
  const first = await openPull(repo, { head: 'feature-a' });
  const second = await openPull(repo, { head: 'feature-b' });

  const missing = await request(`/api/v3/repos/${OWNER}/${repo}/pulls/999/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  assertRest(missing, 404);
  const firstMerge = await request(`/api/v3/repos/${OWNER}/${repo}/pulls/${first.number}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  assertRest(firstMerge, 200);
  const conflict = await request(`/api/v3/repos/${OWNER}/${repo}/pulls/${second.number}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  assertRest(conflict, 405);
  assert.equal(typeof (await conflict.json()).message, 'string');
});
