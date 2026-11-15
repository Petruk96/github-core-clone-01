import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.ts';

const TEST_TOKEN = 'rest-slice-test-token-only';
const OWNER = 'milestone-owner';
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

async function request(path, { method = 'GET', body, rawBody } = {}) {
  const headers = { authorization: `Bearer ${TEST_TOKEN}` };
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}),
  });
}

function assertRest(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.ok(response.headers.get('x-github-request-id'));
}

async function createRepo(name) {
  const response = await request('/api/v3/user/repos', {
    method: 'POST',
    body: { name, private: true, description: `description for ${name}` },
  });
  assertRest(response, 201);
  const body = await response.json();
  assert.equal(body.name, name);
  assert.equal(body.private, true);
  return body;
}

test('creates a repository and reads its default branch back', async () => {
  const name = 'repo-roundtrip';
  await createRepo(name);

  const response = await request(`/api/v3/repos/${OWNER}/${name}`);
  assertRest(response, 200);
  const repo = await response.json();
  assert.equal(repo.name, name);
  assert.equal(repo.private, true);
  assert.equal(repo.description, `description for ${name}`);
  assert.equal(typeof repo.default_branch, 'string');
  assert.ok(repo.default_branch.length > 0);
});

test('writes the first content commit and reads the file back as base64', async () => {
  const name = 'content-roundtrip';
  await createRepo(name);
  const text = 'first file content\n';
  const response = await request(`/api/v3/repos/${OWNER}/${name}/contents/docs/readme.md`, {
    method: 'PUT',
    body: { message: 'add readme', content: Buffer.from(text).toString('base64') },
  });
  assertRest(response, 201);
  const created = await response.json();
  assert.match(created.content.sha, /^[0-9a-f]{40}$/);
  assert.equal(created.content.encoding, 'base64');
  assert.match(created.commit.sha, /^[0-9a-f]{40}$/);

  const read = await request(`/api/v3/repos/${OWNER}/${name}/contents/docs/readme.md`);
  assertRest(read, 200);
  const file = await read.json();
  assert.equal(file.content, Buffer.from(text).toString('base64'));
  assert.equal(Buffer.from(file.content, 'base64').toString('utf8'), text);
  assert.equal(file.sha, created.content.sha);
  assert.equal(file.size, Buffer.byteLength(text));
});

test('lists directory contents and updates files with SHA conflict protection', async () => {
  const name = 'content-directory';
  await createRepo(name);
  const path = `/api/v3/repos/${OWNER}/${name}/contents/docs/one.txt`;
  const first = await request(path, {
    method: 'PUT',
    body: { message: 'create file', content: Buffer.from('one').toString('base64') },
  });
  assertRest(first, 201);
  const firstBody = await first.json();

  const second = await request(path, {
    method: 'PUT',
    body: { message: 'update file', content: Buffer.from('two').toString('base64'), sha: firstBody.content.sha },
  });
  assertRest(second, 200);
  const secondBody = await second.json();
  assert.notEqual(secondBody.content.sha, firstBody.content.sha);

  const stale = await request(path, {
    method: 'PUT',
    body: { message: 'stale update', content: Buffer.from('three').toString('base64'), sha: firstBody.content.sha },
  });
  assertRest(stale, 409);
  assert.equal(typeof (await stale.json()).message, 'string');

  const directory = await request(`/api/v3/repos/${OWNER}/${name}/contents/docs`);
  assertRest(directory, 200);
  const entries = await directory.json();
  assert.ok(entries.some((entry) => entry.name === 'one.txt' && entry.type === 'file'));
});

test('repository owner mismatch and missing repositories return JSON 404', async () => {
  const name = 'owner-check';
  await createRepo(name);

  const foreign = await request(`/api/v3/repos/another-owner/${name}`);
  assertRest(foreign, 404);
  assert.equal(typeof (await foreign.json()).message, 'string');

  const missing = await request(`/api/v3/repos/${OWNER}/not-created`);
  assertRest(missing, 404);
  assert.equal(typeof (await missing.json()).message, 'string');
});

test('lists repositories through same-origin Link pagination', async () => {
  const names = Array.from({ length: 12 }, (_, index) => `repo-page-${String(index).padStart(2, '0')}`);
  for (const name of names) await createRepo(name);

  const listed = [];
  let next = `${baseUrl}/api/v3/user/repos?per_page=10`;
  let pages = 0;
  while (next !== null) {
    assert.equal(new URL(next).origin, baseUrl);
    const response = await fetch(next, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    assertRest(response, 200);
    listed.push(...(await response.json()).map((repo) => repo.name));
    const link = response.headers.get('link');
    next = link === null ? null : /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    pages += 1;
  }

  assert.ok(pages >= 2);
  for (const name of names) assert.ok(listed.includes(name), `${name} should appear in the repository list`);
});

test('patches a repository description and deletes a repository', async () => {
  const name = 'repo-patch-delete';
  await createRepo(name);

  const patched = await request(`/api/v3/repos/${OWNER}/${name}`, {
    method: 'PATCH', body: { description: 'updated description' },
  });
  assertRest(patched, 200);
  assert.equal((await patched.json()).description, 'updated description');

  const deleted = await request(`/api/v3/repos/${OWNER}/${name}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.ok(deleted.headers.get('x-github-request-id'));
  assert.equal(await deleted.text(), '');

  const after = await request(`/api/v3/repos/${OWNER}/${name}`);
  assertRest(after, 404);
  assert.equal(typeof (await after.json()).message, 'string');
});

test('deletes a content file by SHA and records a commit while preserving siblings', async () => {
  const name = 'content-delete-commit';
  await createRepo(name);
  const targetPath = `/api/v3/repos/${OWNER}/${name}/contents/docs/remove.txt`;
  const siblingPath = `/api/v3/repos/${OWNER}/${name}/contents/docs/keep.txt`;
  const targetCreated = await request(targetPath, {
    method: 'PUT', body: { message: 'add target', content: Buffer.from('remove me').toString('base64') },
  });
  assertRest(targetCreated, 201);
  const target = await targetCreated.json();
  const siblingCreated = await request(siblingPath, {
    method: 'PUT', body: { message: 'add sibling', content: Buffer.from('keep me').toString('base64') },
  });
  assertRest(siblingCreated, 201);

  const deleted = await request(targetPath, {
    method: 'DELETE', body: { message: 'remove target', sha: target.content.sha },
  });
  assertRest(deleted, 200);
  const deletion = await deleted.json();
  assert.match(deletion.commit.sha, /^[0-9a-f]{40}$/);

  const missing = await request(targetPath);
  assertRest(missing, 404);
  const sibling = await request(siblingPath);
  assertRest(sibling, 200);
  assert.equal(Buffer.from((await sibling.json()).content, 'base64').toString(), 'keep me');
  const commits = await request(`/api/v3/repos/${OWNER}/${name}/commits?sha=main`);
  assertRest(commits, 200);
  assert.ok((await commits.json()).some((commit) => commit.sha === deletion.commit.sha));
});

test('malformed repository JSON returns a request-ID-bearing 400', async () => {
  const response = await request('/api/v3/user/repos', { method: 'POST', rawBody: '{"name":' });
  assertRest(response, 400);
  assert.equal(typeof (await response.json()).message, 'string');
});
