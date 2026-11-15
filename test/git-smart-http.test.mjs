import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { createApp } from '../app.ts';

const TOKEN = 'git-smart-http-test-token';
const OWNER = 'git-test-owner';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
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

function hashObject(type, data) {
  return createHash('sha1').update(Buffer.from(`${type} ${data.length}\0`)).update(data).digest();
}

function pkt(payload) {
  const data = Buffer.from(payload);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}

function decodePktLines(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = Number.parseInt(buffer.toString('ascii', offset, offset + 4), 16);
    if (length === 0) { packets.push(null); offset += 4; continue; }
    if (length === 1) { packets.push('delim'); offset += 4; continue; }
    if (length === 2) { packets.push('response-end'); offset += 4; continue; }
    if (length < 4 || offset + length > buffer.length) throw new Error('invalid test packet response');
    packets.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  assert.equal(offset, buffer.length);
  return packets;
}

function packObject(type, data) {
  const codes = { commit: 1, tree: 2, blob: 3, tag: 4 };
  let size = data.length;
  const output = [];
  let first = (codes[type] << 4) | (size & 15);
  size >>>= 4;
  if (size) first |= 128;
  output.push(first);
  while (size) {
    let next = size & 127;
    size >>>= 7;
    if (size) next |= 128;
    output.push(next);
  }
  return Buffer.concat([Buffer.from(output), deflateSync(data)]);
}

function makePack(objects) {
  const body = Buffer.concat([
    Buffer.from('PACK'),
    Buffer.from([0, 0, 0, 2]),
    Buffer.from([objects.length >>> 24, objects.length >>> 16, objects.length >>> 8, objects.length]),
    ...objects.map(({ type, data }) => packObject(type, data)),
  ]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function makeInitialPack() {
  const blob = Buffer.from('hello from a packed push\n');
  const blobSha = hashObject('blob', blob);
  const tree = Buffer.concat([Buffer.from(`100644 hello.txt\0`), blobSha]);
  const treeSha = hashObject('tree', tree);
  const commit = Buffer.from(
    `tree ${treeSha.toString('hex')}\nauthor Test User <test@example.invalid> 1700000000 +0000\ncommitter Test User <test@example.invalid> 1700000000 +0000\n\ninitial commit\n`,
  );
  const commitSha = hashObject('commit', commit);
  return {
    pack: makePack([{ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: commit }]),
    commitSha: commitSha.toString('hex'),
    blobSha: blobSha.toString('hex'),
    commit,
  };
}

function makeSuccessor(parentSha, content, timestamp) {
  const blob = Buffer.from(content);
  const blobSha = hashObject('blob', blob);
  const tree = Buffer.concat([Buffer.from('100644 hello.txt\0'), blobSha]);
  const treeSha = hashObject('tree', tree);
  const commit = Buffer.from(
    `tree ${treeSha.toString('hex')}\nparent ${parentSha}\nauthor Test User <test@example.invalid> ${timestamp} +0000\ncommitter Test User <test@example.invalid> ${timestamp} +0000\n\nnext commit\n`,
  );
  const commitSha = hashObject('commit', commit).toString('hex');
  return {
    sha: commitSha,
    pack: makePack([{ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: commit }]),
    objectShas: [blobSha.toString('hex'), treeSha.toString('hex'), commitSha],
  };
}

function unpackPlainPackIds(pack) {
  assert.equal(pack.toString('ascii', 0, 4), 'PACK');
  const count = pack.readUInt32BE(8);
  const typeNames = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const ids = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    let byte = pack[offset++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 128) {
      byte = pack[offset++];
      size += (byte & 127) * 2 ** shift;
      shift += 7;
    }
    const inflated = inflateSync(pack.subarray(offset, pack.length - 20), { info: true });
    assert.equal(inflated.buffer.length, size);
    offset += inflated.engine.bytesWritten;
    ids.push(hashObject(typeNames[type], inflated.buffer).toString('hex'));
  }
  assert.equal(offset, pack.length - 20);
  assert.equal(pack.subarray(pack.length - 20).toString('hex'), createHash('sha1').update(pack.subarray(0, -20)).digest('hex'));
  return ids;
}

async function request(path, { method = 'GET', headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

async function createRepo(name) {
  const response = await request('/api/v3/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201);
}

async function pushInitialCommit(name) {
  await createRepo(name);
  const initial = makeInitialPack();
  const response = await request(`/${OWNER}/${name}.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.concat([
      pkt(`${'0'.repeat(40)} ${initial.commitSha} refs/heads/main\0report-status side-band-64k\n`),
      Buffer.from('0000'),
      initial.pack,
    ]),
  });
  assert.equal(response.status, 200);
  assert.match(Buffer.from(await response.arrayBuffer()).toString('utf8'), /ok refs\/heads\/main/);
  return initial;
}

async function pushCommitUpdate(name, oldSha, update) {
  const response = await request(`/${OWNER}/${name}.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.concat([
      pkt(`${oldSha} ${update.sha} refs/heads/main\0report-status side-band-64k\n`),
      Buffer.from('0000'),
      update.pack,
    ]),
  });
  assert.equal(response.status, 200);
  assert.match(Buffer.from(await response.arrayBuffer()).toString('utf8'), /ok refs\/heads\/main/);
}

async function fetchPack(name, want, have) {
  const response = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: Buffer.concat([
      pkt('command=fetch\n'),
      Buffer.from('0001'),
      pkt(`want ${want}\n`),
      ...have.map((sha) => pkt(`have ${sha}\n`)),
      pkt('done\n'),
      Buffer.from('0000'),
    ]),
  });
  assert.equal(response.status, 200);
  const packets = decodePktLines(Buffer.from(await response.arrayBuffer()));
  assert.equal(packets[0].toString('utf8'), 'packfile\n');
  return Buffer.concat(packets.slice(1).filter(Buffer.isBuffer).map((packet) => packet.subarray(1)));
}

async function fetchShallow(name, { want, have = [], shallow = [], depth }) {
  const response = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: Buffer.concat([
      pkt('command=fetch\n'),
      Buffer.from('0001'),
      pkt(`want ${want}\n`),
      ...have.map((sha) => pkt(`have ${sha}\n`)),
      ...shallow.map((sha) => pkt(`shallow ${sha}\n`)),
      pkt(`deepen ${depth}\n`),
      pkt('done\n'),
      Buffer.from('0000'),
    ]),
  });
  assert.equal(response.status, 200);
  const packets = decodePktLines(Buffer.from(await response.arrayBuffer()));
  const shallowInfo = [];
  let index = 0;
  assert.equal(packets[index++].toString('utf8'), 'shallow-info\n');
  while (packets[index] !== 'delim') shallowInfo.push(packets[index++].toString('utf8').trim());
  index += 1;
  assert.equal(packets[index++].toString('utf8'), 'packfile\n');
  const pack = Buffer.concat(packets.slice(index).filter(Buffer.isBuffer).map((packet) => packet.subarray(1)));
  return { pack, shallowInfo };
}

test('advertises receive-pack v0 with required capabilities and smart HTTP preamble', async () => {
  const name = 'receive-advertisement';
  await createRepo(name);
  const response = await request(`/${OWNER}/${name}.git/info/refs?service=git-receive-pack`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/x-git-receive-pack-advertisement/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.match(bytes.toString('ascii'), /# service=git-receive-pack\n/);
  assert.match(bytes.toString('utf8'), /report-status side-band-64k delete-refs/);
  assert.doesNotMatch(bytes.toString('utf8'), /ofs-delta/);
});

test('incremental fetch sends the new commit graph without objects reachable from have', async () => {
  const name = 'fetch-incremental-test';
  const initial = await pushInitialCommit(name);
  const update = makeSuccessor(initial.commitSha, 'incremental content\n', 1700000001);
  await pushCommitUpdate(name, initial.commitSha, update);

  const pack = await fetchPack(name, update.sha, [initial.commitSha]);
  assert.deepEqual(unpackPlainPackIds(pack).sort(), [...update.objectShas].sort());
  assert.equal(pack.readUInt32BE(8), 3);
});

test('fetch with no new objects returns a valid zero-object packfile', async () => {
  const name = 'fetch-no-new-objects-test';
  const initial = await pushInitialCommit(name);

  const pack = await fetchPack(name, initial.commitSha, [initial.commitSha]);
  assert.equal(pack.length, 32);
  assert.deepEqual(unpackPlainPackIds(pack), []);
  assert.equal(pack.readUInt32BE(8), 0);
});

test('depth-one shallow fetch sends only the tip commit and its tree contents', async () => {
  const name = 'fetch-shallow-depth1-test';
  const first = await pushInitialCommit(name);
  const second = makeSuccessor(first.commitSha, 'second shallow content\n', 1700000001);
  await pushCommitUpdate(name, first.commitSha, second);
  const third = makeSuccessor(second.sha, 'third shallow content\n', 1700000002);
  await pushCommitUpdate(name, second.sha, third);

  const { pack, shallowInfo } = await fetchShallow(name, { want: third.sha, depth: 1 });
  assert.deepEqual(unpackPlainPackIds(pack).sort(), third.objectShas.slice(0, 2).concat(third.sha).sort());
  assert.deepEqual(shallowInfo, [`shallow ${third.sha}`]);
  assert.equal(pack.readUInt32BE(8), 3);
});

test('deepen from a shallow tip sends its parent and moves the shallow boundary', async () => {
  const name = 'fetch-shallow-deepen-test';
  const first = await pushInitialCommit(name);
  const second = makeSuccessor(first.commitSha, 'second deepen content\n', 1700000001);
  await pushCommitUpdate(name, first.commitSha, second);
  const third = makeSuccessor(second.sha, 'third deepen content\n', 1700000002);
  await pushCommitUpdate(name, second.sha, third);

  const { pack, shallowInfo } = await fetchShallow(name, {
    want: third.sha,
    have: [third.sha],
    shallow: [third.sha],
    depth: 2,
  });
  assert.deepEqual(unpackPlainPackIds(pack).sort(), second.objectShas.slice(0, 2).concat(second.sha).sort());
  assert.deepEqual(shallowInfo.sort(), [`shallow ${second.sha}`, `unshallow ${third.sha}`].sort());
});

test('fetching a new tip from a shallow client excludes its existing boundary history', async () => {
  const name = 'fetch-shallow-new-tip-test';
  const first = await pushInitialCommit(name);
  const second = makeSuccessor(first.commitSha, 'second shallow client content\n', 1700000001);
  await pushCommitUpdate(name, first.commitSha, second);
  const third = makeSuccessor(second.sha, 'new tip shallow client content\n', 1700000002);
  await pushCommitUpdate(name, second.sha, third);

  const { pack, shallowInfo } = await fetchShallow(name, {
    want: third.sha,
    have: [second.sha],
    shallow: [second.sha],
    depth: 1,
  });
  assert.deepEqual(unpackPlainPackIds(pack).sort(), third.objectShas.slice(0, 2).concat(third.sha).sort());
  assert.deepEqual(shallowInfo, [`shallow ${third.sha}`]);
});

test('fetch rejects malformed, empty, zero, and negative deepen values', async () => {
  const name = 'fetch-invalid-deepen-test';
  const initial = await pushInitialCommit(name);

  for (const depth of ['2junk', 'abc', '-1', '0', '']) {
    const response = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
      body: Buffer.concat([
        pkt('command=fetch\n'),
        Buffer.from('0001'),
        pkt(`want ${initial.commitSha}\n`),
        pkt(`deepen ${depth}\n`),
        pkt('done\n'),
        Buffer.from('0000'),
      ]),
    });
    assert.equal(response.status, 400, `deepen ${JSON.stringify(depth)} should be rejected`);
  }
});

test('accepts an initial pack push, stores objects, and advertises the new main ref', async () => {
  const name = 'initial-packed-push';
  await createRepo(name);
  const { pack, commitSha } = makeInitialPack();
  const command = pkt(`${'0'.repeat(40)} ${commitSha} refs/heads/main\0report-status side-band-64k\n`);
  const body = Buffer.concat([command, Buffer.from('0000'), pack]);
  const pushed = await request(`/${OWNER}/${name}.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' },
    body,
  });
  assert.equal(pushed.status, 200);
  assert.match(pushed.headers.get('content-type') ?? '', /application\/x-git-receive-pack-result/);
  const report = Buffer.from(await pushed.arrayBuffer()).toString('utf8');
  assert.match(report, /unpack ok/);
  assert.match(report, new RegExp(`ok refs/heads/main`));

  const listed = await request(`/${OWNER}/${name}.git/info/refs?service=git-receive-pack`);
  const advertisement = Buffer.from(await listed.arrayBuffer()).toString('utf8');
  assert.ok(advertisement.includes(`${commitSha} refs/heads/main`));

  const lsRequest = Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001'), pkt('symrefs\n'), Buffer.from('0000')]);
  const ls = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: lsRequest,
  });
  assert.equal(ls.status, 200);
  const lsBody = Buffer.from(await ls.arrayBuffer()).toString('utf8');
  assert.ok(lsBody.includes(`${commitSha} HEAD symref-target:refs/heads/main\n`));
  assert.ok(lsBody.includes(`${commitSha} refs/heads/main\n`));

  const nextBlob = Buffer.from('updated content\n');
  const nextBlobSha = hashObject('blob', nextBlob);
  const nextTree = Buffer.concat([Buffer.from('100644 hello.txt\0'), nextBlobSha]);
  const nextTreeSha = hashObject('tree', nextTree);
  const nextCommit = Buffer.from(
    `tree ${nextTreeSha.toString('hex')}\nparent ${commitSha}\nauthor Test User <test@example.invalid> 1700000001 +0000\ncommitter Test User <test@example.invalid> 1700000001 +0000\n\nsecond commit\n`,
  );
  const nextCommitSha = hashObject('commit', nextCommit).toString('hex');
  const tag = Buffer.from(
    `object ${nextCommitSha}\ntype commit\ntag v1\ntagger Test User <test@example.invalid> 1700000002 +0000\n\nversion 1\n`,
  );
  const tagSha = hashObject('tag', tag).toString('hex');
  const updatePack = makePack([
    { type: 'blob', data: nextBlob },
    { type: 'tree', data: nextTree },
    { type: 'commit', data: nextCommit },
    { type: 'tag', data: tag },
  ]);
  const updateCommands = Buffer.concat([
    pkt(`${commitSha} ${nextCommitSha} refs/heads/main\0report-status side-band-64k\n`),
    pkt(`${'0'.repeat(40)} ${tagSha} refs/tags/v1\n`),
    Buffer.from('0000'),
    updatePack,
  ]);
  const updated = await request(`/${OWNER}/${name}.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: updateCommands,
  });
  assert.equal(updated.status, 200);
  const updateReport = Buffer.from(await updated.arrayBuffer()).toString('utf8');
  assert.match(updateReport, /ok refs\/heads\/main/);
  assert.match(updateReport, /ok refs\/tags\/v1/);

  const peelRequest = Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001'), pkt('peel\n'), pkt('symrefs\n'), Buffer.from('0000')]);
  const peeledResponse = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: peelRequest,
  });
  const peeled = Buffer.from(await peeledResponse.arrayBuffer()).toString('utf8');
  assert.ok(peeled.includes(`${nextCommitSha} HEAD symref-target:refs/heads/main\n`));
  assert.ok(peeled.includes(`${nextCommitSha} refs/heads/main\n`));
  assert.ok(peeled.includes(`${tagSha} refs/tags/v1 peeled:${nextCommitSha}\n`));

  const tagPrefixRequest = Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001'), pkt('ref-prefix refs/tags/\n'), Buffer.from('0000')]);
  const tagPrefixResponse = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: tagPrefixRequest,
  });
  const tagPrefix = Buffer.from(await tagPrefixResponse.arrayBuffer()).toString('utf8');
  assert.ok(tagPrefix.includes(`refs/tags/v1`));
  assert.ok(!tagPrefix.includes('refs/heads/main'));

  const siblingBlob = Buffer.from('non fast-forward sibling\n');
  const siblingBlobSha = hashObject('blob', siblingBlob);
  const siblingTree = Buffer.concat([Buffer.from('100644 hello.txt\0'), siblingBlobSha]);
  const siblingTreeSha = hashObject('tree', siblingTree);
  const siblingCommit = Buffer.from(
    `tree ${siblingTreeSha.toString('hex')}\nparent ${commitSha}\nauthor Test User <test@example.invalid> 1700000003 +0000\ncommitter Test User <test@example.invalid> 1700000003 +0000\n\nsibling commit\n`,
  );
  const siblingSha = hashObject('commit', siblingCommit).toString('hex');
  const nonFastForward = await request(`/${OWNER}/${name}.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.concat([
      pkt(`${nextCommitSha} ${siblingSha} refs/heads/main\0report-status side-band-64k\n`),
      Buffer.from('0000'),
      makePack([
        { type: 'blob', data: siblingBlob },
        { type: 'tree', data: siblingTree },
        { type: 'commit', data: siblingCommit },
      ]),
    ]),
  });
  const rejected = Buffer.from(await nonFastForward.arrayBuffer()).toString('utf8');
  assert.match(rejected, /ng refs\/heads\/main non-fast-forward/);
  const stillMain = await request(`/${OWNER}/${name}.git/info/refs?service=git-receive-pack`);
  assert.ok(Buffer.from(await stillMain.arrayBuffer()).toString('utf8').includes(`${nextCommitSha} refs/heads/main`));

  const deletedTag = await request(`/${OWNER}/${name}.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.concat([pkt(`${tagSha} ${'0'.repeat(40)} refs/tags/v1\0report-status side-band-64k\n`), Buffer.from('0000')]),
  });
  assert.match(Buffer.from(await deletedTag.arrayBuffer()).toString('utf8'), /ok refs\/tags\/v1/);
  const afterDelete = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: tagPrefixRequest,
  });
  assert.doesNotMatch(Buffer.from(await afterDelete.arrayBuffer()).toString('utf8'), /refs\/tags\/v1/);

  const fetchRequest = Buffer.concat([
    pkt('command=fetch\n'), Buffer.from('0001'), pkt(`want ${nextCommitSha}\n`), pkt('done\n'), Buffer.from('0000'),
  ]);
  const fetched = await request(`/${OWNER}/${name}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: fetchRequest,
  });
  assert.equal(fetched.status, 200);
  const packets = decodePktLines(Buffer.from(await fetched.arrayBuffer()));
  assert.equal(packets[0].toString('utf8'), 'packfile\n');
  const fetchedPack = Buffer.concat(packets.slice(1).filter(Buffer.isBuffer).map((packet) => packet.subarray(1)));
  assert.equal(fetchedPack.toString('ascii', 0, 4), 'PACK');
  assert.equal(fetchedPack.subarray(fetchedPack.length - 20).toString('hex'), createHash('sha1').update(fetchedPack.subarray(0, -20)).digest('hex'));
});

test('advertises upload-pack protocol v2 with fetch and ls-refs capabilities', async () => {
  const name = 'upload-advertisement';
  await createRepo(name);
  const response = await request(`/${OWNER}/${name}.git/info/refs?service=git-upload-pack`, {
    headers: { 'git-protocol': 'version=2' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/x-git-upload-pack-advertisement/);
  const bytes = Buffer.from(await response.arrayBuffer()).toString('utf8');
  assert.match(bytes, /version 2\n/);
  assert.match(bytes, /ls-refs\n/);
  assert.match(bytes, /fetch=shallow\n/);
  assert.match(bytes, /object-format=sha1\n/);
});
