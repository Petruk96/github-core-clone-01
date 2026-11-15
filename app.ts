// The starter's HTTP surface, exactly as it ships: a health probe and an API root, and a JSON 404
// for everything else. The contest's real surface — git smart HTTP, REST v3 resources, GraphQL v4 and
// the MCP endpoint — is what you add (README.md names it, and the rules link below says what scores).
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is the
// entry <-> env lifecycle and should stay as it is.

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  addIssueComment,
  createForgeState,
  createIssue,
  createLabel,
  createRepositoryState,
  createPullRequest,
  nextStateTimestamp,
  setIssueState,
  type CommitSnapshot,
  type IssueState,
  type LabelState,
  type PullRequestState,
  type RepositoryState,
} from './state.ts';
import { executeGraphQL } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MCP_REVISION = '2026-07-28';
const MCP_SERVER_INFO = { name: 'github-core-clone-01', version: '1.0.0' };
const MCP_TOOLS = [
  { name: 'create_repo', description: 'Create a repository in the shared forge state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Read a repository from the shared forge state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in an existing repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in an existing repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request between existing repository branches.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Squash merge an open pull request into its base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
];

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Every REST response carries a request id, including authentication and not-found errors. */
function sendRestJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': randomUUID(), ...headers });
}

/** The suite's REST token is supplied by the environment for each trial. */
function hasValidBearerToken(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const authorization = req.headers.authorization;
  if (!token || typeof authorization !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match !== null && match[1] === token;
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Request body is too large');
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function storeGitObject(repo: RepositoryState, type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = createHash('sha1').update(header).update(data).digest('hex');
  repo.objects.set(sha, { type, data });
  return sha;
}

interface TreeDirectory {
  directories: Map<string, TreeDirectory>;
  files: Map<string, Buffer>;
}

function buildTree(repo: RepositoryState, files: Map<string, Buffer>): string {
  const root: TreeDirectory = { directories: new Map(), files: new Map() };
  for (const [path, content] of files) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      let child = directory.directories.get(part);
      if (child === undefined) {
        child = { directories: new Map(), files: new Map() };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.set(parts[parts.length - 1], content);
  }

  const writeDirectory = (directory: TreeDirectory): string => {
    const entries: { name: string; directory: boolean; sha: string }[] = [];
    for (const [name, child] of directory.directories) entries.push({ name, directory: true, sha: writeDirectory(child) });
    for (const [name, content] of directory.files) entries.push({ name, directory: false, sha: storeGitObject(repo, 'blob', content) });
    entries.sort((a, b) => Buffer.compare(
      Buffer.from(`${a.name}${a.directory ? '/' : ''}`),
      Buffer.from(`${b.name}${b.directory ? '/' : ''}`),
    ));
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      chunks.push(Buffer.from(`${entry.directory ? '40000' : '100644'} ${entry.name}\0`));
      chunks.push(Buffer.from(entry.sha, 'hex'));
    }
    return storeGitObject(repo, 'tree', Buffer.concat(chunks));
  };

  return writeDirectory(root);
}

function addContentCommit(repo: RepositoryState, owner: string, branch: string, message: string, files: Map<string, Buffer>, parentSha?: string): CommitSnapshot {
  const treeSha = buildTree(repo, files);
  const timestamp = 1_700_000_000 + repo.commitCount++;
  const identity = `${owner} <${owner}@example.invalid> ${timestamp} +0000`;
  const lines = [`tree ${treeSha}`];
  if (parentSha !== undefined) lines.push(`parent ${parentSha}`);
  lines.push(`author ${identity}`, `committer ${identity}`, '', message);
  const data = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const sha = storeGitObject(repo, 'commit', data);
  const commit: CommitSnapshot = { sha, treeSha, message, ...(parentSha === undefined ? {} : { parentSha }), files };
  repo.commits.set(sha, commit);
  repo.refs.set(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`, sha);
  return commit;
}

function repositoryResponse(repo: RepositoryState): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: repo.id,
    name: repo.name,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    open_issues_count: 0,
    forks_count: 0,
    watchers_count: 0,
  };
  if (repo.owner !== null) {
    result.full_name = `${repo.owner}/${repo.name}`;
    result.owner = { login: repo.owner, id: 1, type: 'User' };
  }
  return result;
}

function labelResponse(label: LabelState): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color };
}

function issueResponse(issue: IssueState): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelResponse),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function commentResponse(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, created_at: comment.createdAt };
}

function pullRequestResponse(pull: PullRequestState): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.headRefName, sha: pull.headSha },
    base: { ref: pull.baseRefName, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

function sameFileContent(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

function changedPullFiles(repo: RepositoryState, pull: PullRequestState): Record<string, unknown>[] {
  const base = repo.commits.get(pull.baseSha)?.files;
  const head = repo.commits.get(pull.headSha)?.files;
  if (base === undefined || head === undefined) throw new HttpError(422, 'Pull request references an unavailable commit');
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  const changed: Record<string, unknown>[] = [];
  for (const filename of paths) {
    const before = base.get(filename);
    const after = head.get(filename);
    if (sameFileContent(before, after)) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const oldLines = before === undefined ? [] : before.toString('utf8').split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
    const newLines = after === undefined ? [] : after.toString('utf8').split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
    let common = 0;
    while (common < oldLines.length && common < newLines.length && oldLines[common] === newLines[common]) common += 1;
    let oldTail = oldLines.length - 1;
    let newTail = newLines.length - 1;
    while (oldTail >= common && newTail >= common && oldLines[oldTail] === newLines[newTail]) {
      oldTail -= 1;
      newTail -= 1;
    }
    const additions = Math.max(0, newTail - common + 1);
    const deletions = Math.max(0, oldTail - common + 1);
    changed.push({ filename, status, additions, deletions, changes: additions + deletions });
  }
  return changed;
}

function pullMergePlan(repo: RepositoryState, pull: PullRequestState): { files: Map<string, Buffer>; parentSha: string } | null {
  const currentBaseSha = branchSha(repo, pull.baseRefName);
  const baseline = repo.commits.get(pull.baseSha)?.files;
  const currentBase = currentBaseSha === undefined ? undefined : repo.commits.get(currentBaseSha)?.files;
  const head = repo.commits.get(pull.headSha)?.files;
  if (currentBaseSha === undefined || baseline === undefined || currentBase === undefined || head === undefined) return null;

  const result = new Map(currentBase);
  for (const path of new Set([...baseline.keys(), ...head.keys()])) {
    const original = baseline.get(path);
    const proposed = head.get(path);
    if (sameFileContent(original, proposed)) continue;
    const current = currentBase.get(path);
    if (!sameFileContent(original, current) && !sameFileContent(current, proposed)) return null;
    if (proposed === undefined) result.delete(path);
    else result.set(path, proposed);
  }
  return { files: result, parentSha: currentBaseSha };
}

function mergePullRequest(state: ReturnType<typeof createForgeState>, repo: RepositoryState, pull: PullRequestState, author: string): { sha: string; message: string } | null {
  if (pull.merged || pull.state !== 'open') return null;
  const plan = pullMergePlan(repo, pull);
  if (plan === null) {
    pull.mergeable = 'CONFLICTING';
    return null;
  }
  const commit = addContentCommit(repo, repo.owner ?? author, pull.baseRefName, `${pull.title} (#${pull.number})`, plan.files, plan.parentSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeable = 'MERGEABLE';
  pull.mergeCommitSha = commit.sha;
  pull.mergedAt = nextStateTimestamp(state);
  pull.updatedAt = pull.mergedAt;
  return { sha: commit.sha, message: 'Pull Request successfully merged' };
}

function commitsFromRef(repo: RepositoryState, ref: string | null): CommitSnapshot[] {
  const sha = branchSha(repo, ref ?? repo.defaultBranch);
  const commits: CommitSnapshot[] = [];
  const seen = new Set<string>();
  let currentSha = sha;
  while (currentSha !== undefined && !seen.has(currentSha)) {
    seen.add(currentSha);
    const commit = repo.commits.get(currentSha);
    if (commit === undefined) break;
    commits.push(commit);
    currentSha = commit.parentSha;
  }
  return commits;
}

function commitForRef(repo: RepositoryState, ref: string | null): CommitSnapshot | undefined {
  const selected = ref ?? repo.defaultBranch;
  const direct = repo.commits.get(selected);
  if (direct !== undefined) return direct;
  const branchRef = selected.startsWith('refs/') ? selected : `refs/heads/${selected}`;
  const sha = repo.refs.get(selected) ?? repo.refs.get(branchRef);
  return sha === undefined ? undefined : repo.commits.get(sha);
}

function branchSha(repo: RepositoryState, branch: string): string | undefined {
  return repo.refs.get(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);
}

function contentsFileResponse(path: string, content: Buffer, sha: string): Record<string, unknown> {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { type: 'file', name, path, encoding: 'base64', content: content.toString('base64'), sha, size: content.length };
}

const ZERO_OID = '0'.repeat(40);

function gitPktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
}

function readGitPktLines(data: Buffer): { packets: Buffer[]; offset: number } {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const header = data.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) return { packets, offset: offset + 4 };
    if (length === 1) {
      packets.push(Buffer.alloc(0));
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > data.length) throw new HttpError(400, 'Malformed Git packet-line');
    packets.push(data.subarray(offset + 4, offset + length));
    offset += length;
  }
  throw new HttpError(400, 'Incomplete Git packet-line section');
}

async function readRequestBytes(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new HttpError(413, 'Git request is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseGitPack(repo: RepositoryState, pack: Buffer): string[] {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new HttpError(400, 'Invalid Git packfile');
  const expectedChecksum = pack.subarray(pack.length - 20);
  const actualChecksum = createHash('sha1').update(pack.subarray(0, -20)).digest();
  if (!actualChecksum.equals(expectedChecksum)) throw new HttpError(400, 'Git pack checksum mismatch');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new HttpError(400, 'Unsupported Git pack version');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const types: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const received: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset >= pack.length - 20) throw new HttpError(400, 'Truncated Git pack object header');
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while ((byte & 128) !== 0) {
      if (offset >= pack.length - 20 || shift > 53) throw new HttpError(400, 'Invalid Git pack object size');
      byte = pack[offset++];
      size += (byte & 127) * 2 ** shift;
      shift += 7;
    }
    const type = types[typeCode];
    if (type === undefined) throw new HttpError(400, 'Delta objects are not supported in this push');
    const inflated = inflateSync(pack.subarray(offset, pack.length - 20), { info: true });
    const consumed = inflated.engine.bytesWritten;
    const objectData = inflated.buffer;
    if (consumed <= 0 || objectData.length !== size) throw new HttpError(400, 'Invalid compressed Git object');
    offset += consumed;
    const sha = storeGitObject(repo, type, objectData);
    received.push(sha);
  }
  if (offset !== pack.length - 20) throw new HttpError(400, 'Unexpected bytes in Git packfile');
  return received;
}

function filesFromTree(repo: RepositoryState, treeSha: string, prefix = '', files = new Map<string, Buffer>()): Map<string, Buffer> {
  const tree = repo.objects.get(treeSha);
  if (tree?.type !== 'tree') throw new HttpError(400, 'Commit references a missing tree');
  let offset = 0;
  while (offset < tree.data.length) {
    const space = tree.data.indexOf(0x20, offset);
    const nul = tree.data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > tree.data.length) throw new HttpError(400, 'Malformed Git tree');
    const mode = tree.data.toString('ascii', offset, space);
    const name = tree.data.toString('utf8', space + 1, nul);
    const sha = tree.data.subarray(nul + 1, nul + 21).toString('hex');
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000' || mode === '040000') filesFromTree(repo, sha, path, files);
    else {
      const blob = repo.objects.get(sha);
      if (blob?.type !== 'blob') throw new HttpError(400, 'Tree references a missing blob');
      files.set(path, blob.data);
    }
    offset = nul + 21;
  }
  return files;
}

function rememberPushedCommit(repo: RepositoryState, sha: string): CommitSnapshot {
  const object = repo.objects.get(sha);
  if (object?.type !== 'commit') throw new HttpError(400, 'Pushed ref does not point to a commit');
  const text = object.data.toString('utf8');
  const header = text.split('\n\n', 1)[0];
  const treeSha = /^tree ([0-9a-f]{40})$/m.exec(header)?.[1];
  if (treeSha === undefined) throw new HttpError(400, 'Commit has no valid tree');
  const parentSha = /^parent ([0-9a-f]{40})$/m.exec(header)?.[1];
  const message = text.slice(header.length + 2).replace(/\n$/, '');
  const commit: CommitSnapshot = { sha, treeSha, message, ...(parentSha === undefined ? {} : { parentSha }), files: filesFromTree(repo, treeSha) };
  repo.commits.set(sha, commit);
  return commit;
}

function gitAdvertisement(repo: RepositoryState, owner: string, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): Buffer {
  const chunks: Buffer[] = [];
  if (service === 'git-upload-pack' && protocolV2) {
    chunks.push(gitPktLine('version 2\n'), gitPktLine('agent=github-core-clone-01\n'), gitPktLine('ls-refs\n'), gitPktLine('fetch=shallow\n'), gitPktLine('object-format=sha1\n'), Buffer.from('0000'));
    return Buffer.concat(chunks);
  }
  chunks.push(gitPktLine(`# service=${service}\n`), Buffer.from('0000'));
  const capabilities = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs agent=github-core-clone-01'
    : 'agent=github-core-clone-01';
  const refs = [...repo.refs].sort(([a], [b]) => a.localeCompare(b));
  if (refs.length === 0) chunks.push(gitPktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  else {
    let first = true;
    for (const [ref, sha] of refs) {
      const line = `${sha} ${ref}${first ? `\0${capabilities}` : ''}\n`;
      chunks.push(gitPktLine(line));
      first = false;
    }
  }
  chunks.push(Buffer.from('0000'));
  return Buffer.concat(chunks);
}

function handleLsRefs(repo: RepositoryState, request: Buffer): Buffer {
  const { packets } = readGitPktLines(request);
  const lines = packets.map((packet) => packet.toString('utf8').replace(/\n$/, ''));
  if (lines[0] !== 'command=ls-refs') throw new HttpError(400, 'Unsupported upload-pack command');
  const delimiter = lines.indexOf('');
  const args = delimiter < 0 ? [] : lines.slice(delimiter + 1);
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
  const wantsSymrefs = args.includes('symrefs');
  const wantsPeel = args.includes('peel');
  const out: Buffer[] = [];
  const mainSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (mainSha !== undefined && (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix)))) {
    out.push(gitPktLine(`${mainSha} HEAD${wantsSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  }
  for (const [ref, sha] of [...repo.refs].sort(([a], [b]) => a.localeCompare(b))) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
    const peeled = wantsPeel && ref.startsWith('refs/tags/') ? peelGitTag(repo, sha) : undefined;
    out.push(gitPktLine(`${sha} ${ref}${peeled === undefined ? '' : ` peeled:${peeled}`}\n`));
  }
  out.push(Buffer.from('0000'), Buffer.from('0002'));
  return Buffer.concat(out);
}

function peelGitTag(repo: RepositoryState, sha: string): string | undefined {
  let current = sha;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (object?.type !== 'tag') return current === sha ? undefined : current;
    const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
    if (target === undefined || repo.objects.get(target) === undefined) return undefined;
    current = target;
  }
  return undefined;
}

function isCommitAncestor(repo: RepositoryState, ancestor: string, descendant: string): boolean {
  const pending = [descendant];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const sha = pending.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object?.type !== 'commit') continue;
    const header = object.data.toString('utf8').split('\n\n', 1)[0];
    for (const match of header.matchAll(/^parent ([0-9a-f]{40})$/gm)) pending.push(match[1]);
  }
  return false;
}

function reachableObjectIds(repo: RepositoryState, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (sha: string): void => {
    if (seen.has(sha)) return;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined) throw new HttpError(400, `Requested object ${sha} is missing`);
    if (object.type === 'commit') {
      const text = object.data.toString('utf8').split('\n\n', 1)[0];
      for (const match of text.matchAll(/^(?:tree|parent) ([0-9a-f]{40})$/gm)) visit(match[1]);
    } else if (object.type === 'tree') {
      let offset = 0;
      while (offset < object.data.length) {
        const space = object.data.indexOf(0x20, offset);
        const nul = object.data.indexOf(0, space + 1);
        if (space < 0 || nul < 0 || nul + 21 > object.data.length) throw new HttpError(400, 'Malformed Git tree');
        visit(object.data.subarray(nul + 1, nul + 21).toString('hex'));
        offset = nul + 21;
      }
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
      if (target !== undefined) visit(target);
    }
  };
  for (const sha of roots) visit(sha);
  return seen;
}

function reachableObjects(repo: RepositoryState, wants: string[], haves: string[]): { type: string; data: Buffer }[] {
  const alreadyAvailable = new Set<string>();
  for (const sha of haves) {
    if (repo.objects.get(sha)?.type !== 'commit') continue;
    for (const reachable of reachableObjectIds(repo, [sha])) alreadyAvailable.add(reachable);
  }
  return [...reachableObjectIds(repo, wants)]
    .filter((sha) => !alreadyAvailable.has(sha))
    .map((sha) => repo.objects.get(sha)!);
}

function commitParents(repo: RepositoryState, sha: string): string[] {
  const commit = repo.objects.get(sha);
  if (commit?.type !== 'commit') return [];
  const header = commit.data.toString('utf8').split('\n\n', 1)[0];
  return [...header.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]);
}

function shallowFetchObjects(
  repo: RepositoryState,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number,
): { objects: { type: string; data: Buffer }[]; shallow: string[]; unshallow: string[] } {
  const oldBoundaries = new Set(shallow);
  const includedCommits = new Set<string>();
  const newBoundaries = new Set<string>();
  const pending = wants.map((sha) => ({ sha, generation: 0 }));
  const objectIds = new Set<string>();

  while (pending.length > 0) {
    const { sha, generation } = pending.shift()!;
    if (includedCommits.has(sha)) continue;
    const commit = repo.objects.get(sha);
    if (commit?.type !== 'commit') {
      for (const objectSha of reachableObjectIds(repo, [sha])) objectIds.add(objectSha);
      continue;
    }
    includedCommits.add(sha);
    objectIds.add(sha);
    const header = commit.data.toString('utf8').split('\n\n', 1)[0];
    const treeSha = /^tree ([0-9a-f]{40})$/m.exec(header)?.[1];
    if (treeSha === undefined) throw new HttpError(400, 'Commit has no valid tree');
    for (const objectSha of reachableObjectIds(repo, [treeSha])) objectIds.add(objectSha);

    const parents = commitParents(repo, sha);
    if (generation + 1 < depth) {
      for (const parent of parents) pending.push({ sha: parent, generation: generation + 1 });
    } else if (parents.length > 0) {
      newBoundaries.add(sha);
    }
  }

  const alreadyAvailable = new Set<string>();
  for (const sha of haves) {
    if (repo.objects.get(sha)?.type !== 'commit') continue;
    if (oldBoundaries.has(sha)) {
      alreadyAvailable.add(sha);
      const header = repo.objects.get(sha)!.data.toString('utf8').split('\n\n', 1)[0];
      const treeSha = /^tree ([0-9a-f]{40})$/m.exec(header)?.[1];
      if (treeSha !== undefined) {
        for (const objectSha of reachableObjectIds(repo, [treeSha])) alreadyAvailable.add(objectSha);
      }
    } else {
      for (const objectSha of reachableObjectIds(repo, [sha])) alreadyAvailable.add(objectSha);
    }
  }

  const objects = [...objectIds]
    .filter((sha) => !alreadyAvailable.has(sha))
    .map((sha) => {
      const object = repo.objects.get(sha);
      if (object === undefined) throw new HttpError(400, `Requested object ${sha} is missing`);
      return object;
    });
  const unshallow = [...oldBoundaries].filter((sha) => {
    if (!includedCommits.has(sha) || newBoundaries.has(sha)) return false;
    return commitParents(repo, sha).some((parent) => includedCommits.has(parent));
  });
  return { objects, shallow: [...newBoundaries], unshallow };
}

function writeGitPack(objects: { type: string; data: Buffer }[]): Buffer {
  const typeCode: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = typeCode[object.type];
    if (code === undefined) throw new HttpError(400, 'Unsupported Git object type');
    let size = object.data.length;
    let first = (code << 4) | (size & 15);
    size >>>= 4;
    const bytes: number[] = [];
    if (size > 0) first |= 128;
    bytes.push(first);
    while (size > 0) {
      let next = size & 127;
      size >>>= 7;
      if (size > 0) next |= 128;
      bytes.push(next);
    }
    parts.push(Buffer.from(bytes), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function handleFetch(repo: RepositoryState, request: Buffer): Buffer {
  const { packets } = readGitPktLines(request);
  const lines = packets.map((packet) => packet.toString('utf8').replace(/\n$/, ''));
  if (lines[0] !== 'command=fetch') throw new HttpError(400, 'Unsupported upload-pack command');
  const delimiter = lines.indexOf('');
  const args = delimiter < 0 ? [] : lines.slice(delimiter + 1);
  const wants = args.filter((line) => line.startsWith('want ')).map((line) => line.slice(5));
  const haves = args.filter((line) => line.startsWith('have ')).map((line) => line.slice(5));
  const shallow = args.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8));
  const depthLine = args.find((line) => line.startsWith('deepen '));
  const depthText = depthLine?.slice(7);
  if (depthText !== undefined && !/^\d+$/.test(depthText)) throw new HttpError(400, 'Invalid fetch depth');
  const depth = depthText === undefined ? undefined : Number(depthText);
  if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 1)) throw new HttpError(400, 'Invalid fetch depth');
  const shallowResult = depth === undefined
    ? null
    : shallowFetchObjects(repo, wants, haves, shallow, depth);
  const pack = writeGitPack(shallowResult?.objects ?? reachableObjects(repo, wants, haves));
  const chunks: Buffer[] = [];
  if (shallowResult !== null) {
    chunks.push(gitPktLine('shallow-info\n'));
    for (const sha of shallowResult.shallow) chunks.push(gitPktLine(`shallow ${sha}\n`));
    for (const sha of shallowResult.unshallow) chunks.push(gitPktLine(`unshallow ${sha}\n`));
    chunks.push(Buffer.from('0001'));
  }
  chunks.push(gitPktLine('packfile\n'));
  const maxPayload = 60 * 1024;
  for (let offset = 0; offset < pack.length; offset += maxPayload - 1) {
    chunks.push(gitPktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + maxPayload - 1)])));
  }
  chunks.push(Buffer.from('0000'));
  return Buffer.concat(chunks);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const state = createForgeState();
  const repositories = state.repositories;

  const respondToRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const isRestRoute = path === '/api/v3' || path.startsWith('/api/v3/');
    const isGraphqlRoute = path === '/api/graphql';
    const isMcpRoute = path === '/mcp';
    const isGitSmartHttpRoute = /^\/[^/]+\/[^/]+\.git(?:\/|$)/.test(path);
    const requiresAuthentication = isRestRoute || isGraphqlRoute || isMcpRoute || isGitSmartHttpRoute;
    if (requiresAuthentication && !hasValidBearerToken(req)) {
      sendRestJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    if (method === 'GET' && path === '/api/v3/meta') {
      sendRestJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendRestJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    const repositoryForOwner = (owner: string, name: string): RepositoryState | undefined => {
      const repo = repositories.get(name);
      if (repo === undefined) return undefined;
      if (repo.owner === null) {
        state.accountOwner ??= owner;
        repo.owner = state.accountOwner;
      }
      return repo.owner === owner ? repo : undefined;
    };

    if (path === '/api/graphql' && method === 'POST') {
      const bytes = await readRequestBytes(req);
      let body: unknown;
      try {
        body = JSON.parse(bytes.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
        return;
      }
      const execution = executeGraphQL(
        state,
        body,
        state.accountOwner ?? 'unknown-viewer',
        repositoryForOwner,
        (repo, pull, owner) => mergePullRequest(state, repo, pull, owner),
      );
      sendJson(res, execution.status, execution.result);
      return;
    }

    if (path === '/mcp' && method === 'POST') {
      const requestBytes = await readRequestBytes(req);
      let payload: unknown;
      try {
        payload = JSON.parse(requestBytes.toString('utf8'));
      } catch {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        return;
      }
      const rpc = payload as Record<string, unknown>;
      const id = rpc.id;
      if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
        sendJson(res, 400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
        return;
      }
      if (id === undefined) {
        res.writeHead(202, { 'content-type': JSON_TYPE });
        res.end();
        return;
      }
      const params = rpc.params !== null && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
        ? rpc.params as Record<string, unknown>
        : {};
      const reply = (body: Record<string, unknown>, status = 200): void => sendJson(res, status, body);
      const rpcError = (code: number, message: string, status = 200): void => reply({ jsonrpc: '2.0', id, error: { code, message } }, status);
      const requiredVersion = req.headers['mcp-protocol-version'];
      const meta = params._meta !== null && typeof params._meta === 'object' && !Array.isArray(params._meta)
        ? params._meta as Record<string, unknown>
        : {};
      const declaredVersion = meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion;
      if (rpc.method !== 'initialize' && rpc.method !== 'notifications/initialized' &&
          ((requiredVersion !== undefined && requiredVersion !== MCP_REVISION) || (declaredVersion !== undefined && declaredVersion !== MCP_REVISION))) {
        rpcError(-32022, 'Unsupported protocol version', 400);
        return;
      }

      if (rpc.method === 'server/discover') {
        reply({
          jsonrpc: '2.0', id,
          result: {
            supportedVersions: [MCP_REVISION],
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
          },
        });
        return;
      }
      if (rpc.method === 'initialize') {
        const requested = params.protocolVersion;
        reply({ jsonrpc: '2.0', id, result: {
          protocolVersion: typeof requested === 'string' ? requested : '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
        } });
        return;
      }
      if (rpc.method === 'tools/list') {
        reply({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
        return;
      }
      if (rpc.method !== 'tools/call') {
        rpcError(-32601, 'Method not found');
        return;
      }

      const toolName = typeof params.name === 'string' ? params.name.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
      const canonicalTool = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']
        .find((name) => toolName === name.replace(/_/g, '') || toolName.endsWith(name.replace(/_/g, '')));
      if (canonicalTool === undefined) {
        rpcError(-32601, `Unknown tool: ${String(params.name ?? '')}`);
        return;
      }
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      const requiredByTool: Record<string, string[]> = {
        create_repo: ['name'],
        get_repo: ['owner', 'repo'],
        create_issue: ['owner', 'repo', 'title'],
        list_issues: ['owner', 'repo'],
        create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
        merge_pull_request: ['owner', 'repo', 'pull_number'],
      };
      const required = requiredByTool[canonicalTool];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        rpcError(-32602, `Missing required arguments: ${missing.join(', ')}`);
        return;
      }

      let result: unknown;
      let failure: string | null = null;
      if (canonicalTool === 'create_repo') {
        if (typeof args.name !== 'string' || (args.description !== undefined && typeof args.description !== 'string') ||
            (args.private !== undefined && typeof args.private !== 'boolean') || (args.owner !== undefined && typeof args.owner !== 'string')) {
          rpcError(-32602, 'Invalid create_repo arguments');
          return;
        }
        if (repositories.has(args.name)) failure = 'Repository already exists';
        else {
          if (typeof args.owner === 'string') state.accountOwner ??= args.owner;
          const repo = createRepositoryState(state, {
            name: args.name,
            owner: state.accountOwner,
            private: typeof args.private === 'boolean' ? args.private : false,
            description: typeof args.description === 'string' ? args.description : '',
          });
          repositories.set(repo.name, repo);
          result = repositoryResponse(repo);
        }
      } else {
        if (typeof args.owner !== 'string' || typeof args.repo !== 'string') {
          rpcError(-32602, 'owner and repo must be strings');
          return;
        }
        const repo = repositoryForOwner(args.owner, args.repo);
        if (repo === undefined) failure = 'Repository not found';
        else if (canonicalTool === 'get_repo') result = repositoryResponse(repo);
        else if (canonicalTool === 'create_issue') {
          if (typeof args.title !== 'string' || (args.body !== undefined && typeof args.body !== 'string')) {
            rpcError(-32602, 'title must be a string and body must be a string when provided');
            return;
          }
          const issue = createIssue(state, repo, { title: args.title, ...(typeof args.body === 'string' ? { body: args.body } : {}) });
          if (issue === null) failure = 'Issue could not be created';
          else result = issueResponse(issue);
        } else if (canonicalTool === 'list_issues') {
          const selectedState = args.state === undefined ? 'open' : args.state;
          if (selectedState !== 'open' && selectedState !== 'closed' && selectedState !== 'all') {
            rpcError(-32602, 'state must be open, closed, or all');
            return;
          }
          result = [...repo.issues.values()]
            .filter((issue) => selectedState === 'all' || issue.state === selectedState)
            .sort((a, b) => b.number - a.number)
            .map(issueResponse);
        } else if (canonicalTool === 'create_pull_request') {
          if (typeof args.title !== 'string' || typeof args.head !== 'string' || typeof args.base !== 'string' ||
              (args.body !== undefined && typeof args.body !== 'string')) {
            rpcError(-32602, 'title, head, and base must be strings');
            return;
          }
          const pull = createPullRequest(state, repo, {
            title: args.title,
            head: args.head,
            base: args.base,
            ...(typeof args.body === 'string' ? { body: args.body } : {}),
          });
          if (pull === null) failure = 'Pull request branches were not found';
          else result = pullRequestResponse(pull);
        } else if (canonicalTool === 'merge_pull_request') {
          if (!Number.isInteger(args.pull_number) || (args.pull_number as number) < 1) {
            rpcError(-32602, 'pull_number must be a positive integer');
            return;
          }
          const pull = repo.pullRequests.get(args.pull_number as number);
          if (pull === undefined) failure = 'Pull request not found';
          else {
            const merged = mergePullRequest(state, repo, pull, args.owner);
            if (merged === null) failure = pull.mergeable === 'CONFLICTING' ? 'Pull request has merge conflicts' : 'Pull request is not open';
            else result = { ...merged, merged: true };
          }
        }
      }
      const toolResult = failure === null
        ? { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
        : { content: [{ type: 'text', text: failure }], isError: true };
      reply({ jsonrpc: '2.0', id, result: toolResult });
      return;
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch !== null) {
      let owner: string;
      let name: string;
      try {
        owner = decodeURIComponent(gitMatch[1]);
        name = decodeURIComponent(gitMatch[2]);
      } catch {
        throw new HttpError(400, 'Invalid Git repository path');
      }
      const repo = repositoryForOwner(owner, name);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const endpoint = gitMatch[3];
      if (method === 'GET' && endpoint === 'info/refs') {
        const service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'Unsupported Git service' });
          return;
        }
        const protocolV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
        const body = gitAdvertisement(repo, owner, service, protocolV2);
        res.writeHead(200, {
          'content-type': `application/x-${service}-advertisement`,
          'content-length': body.length,
          'cache-control': 'no-cache',
        });
        res.end(body);
        return;
      }
      if (method === 'POST' && endpoint === 'git-receive-pack') {
        const requestBody = await readRequestBytes(req);
        const commandSection = readGitPktLines(requestBody);
        const commands = commandSection.packets.map((packet) => {
          const line = packet.toString('utf8').replace(/\n$/, '');
          const nul = line.indexOf('\0');
          const command = nul < 0 ? line : line.slice(0, nul);
          const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(command);
          if (match === null) throw new HttpError(400, 'Malformed receive-pack command');
          return { oldSha: match[1], newSha: match[2], ref: match[3] };
        });
        if (commands.length === 0) throw new HttpError(400, 'receive-pack command list is empty');
        const pack = requestBody.subarray(commandSection.offset);
        let unpackOk = true;
        let unpackMessage = 'ok';
        try {
          if (pack.length > 0) parseGitPack(repo, pack);
          else if (commands.some((command) => command.newSha !== ZERO_OID)) throw new HttpError(400, 'Push has no packfile');
        } catch (error) {
          unpackOk = false;
          unpackMessage = error instanceof Error ? error.message : 'failed';
        }
        const report: Buffer[] = [gitPktLine(`\x01${unpackOk ? 'unpack ok' : `unpack ${unpackMessage}`}\n`)];
        for (const command of commands) {
          if (!unpackOk) {
            report.push(gitPktLine(`\x01ng ${command.ref} unpacker error\n`));
            continue;
          }
          const current = repo.refs.get(command.ref);
          const isCreate = command.oldSha === ZERO_OID && current === undefined;
          const isDelete = current !== undefined && current === command.oldSha && command.newSha === ZERO_OID;
          const isUpdate = current !== undefined && current === command.oldSha && command.newSha !== ZERO_OID;
          if (isDelete) {
            repo.refs.delete(command.ref);
            report.push(gitPktLine(`\x01ok ${command.ref}\n`));
            continue;
          }
          if (!isCreate && !isUpdate) {
            report.push(gitPktLine(`\x01ng ${command.ref} stale info\n`));
            continue;
          }
          const target = repo.objects.get(command.newSha);
          if (target === undefined || (command.ref.startsWith('refs/heads/') && target.type !== 'commit')) {
            report.push(gitPktLine(`\x01ng ${command.ref} missing object\n`));
            continue;
          }
          if (isUpdate && command.ref.startsWith('refs/heads/') && !isCommitAncestor(repo, current!, command.newSha)) {
            report.push(gitPktLine(`\x01ng ${command.ref} non-fast-forward\n`));
            continue;
          }
          if (target.type === 'commit' && !repo.commits.has(command.newSha)) {
            const commit = rememberPushedCommit(repo, command.newSha);
            repo.commits.set(commit.sha, commit);
            repo.commitCount += 1;
          }
          repo.refs.set(command.ref, command.newSha);
          report.push(gitPktLine(`\x01ok ${command.ref}\n`));
        }
        report.push(Buffer.from('0000'));
        const body = Buffer.concat(report);
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'content-length': body.length,
          'cache-control': 'no-cache',
        });
        res.end(body);
        return;
      }
      if (method === 'POST' && endpoint === 'git-upload-pack') {
        const requestBody = await readRequestBytes(req);
        const commandPackets = readGitPktLines(requestBody).packets;
        const command = commandPackets[0]?.toString('utf8').replace(/\n$/, '');
        const body = command === 'command=ls-refs'
          ? handleLsRefs(repo, requestBody)
          : command === 'command=fetch'
            ? handleFetch(repo, requestBody)
            : (() => { throw new HttpError(400, 'Unsupported upload-pack command'); })();
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'content-length': body.length,
          'cache-control': 'no-cache',
        });
        res.end(body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (method === 'GET' && path === '/api/v3/user/repos') {
      const requestUrl = new URL(req.url ?? '/api/v3/user/repos', `http://${req.headers.host ?? 'localhost'}`);
      const page = Math.max(1, Number(requestUrl.searchParams.get('page') ?? '1') || 1);
      const perPage = Math.min(100, Math.max(1, Number(requestUrl.searchParams.get('per_page') ?? '30') || 30));
      const ordered = [...repositories.values()].sort((a, b) => a.name.localeCompare(b.name));
      const start = (page - 1) * perPage;
      const headers: Record<string, string> = {};
      if (start + perPage < ordered.length) {
        const nextUrl = new URL(requestUrl);
        nextUrl.searchParams.set('page', String(page + 1));
        nextUrl.searchParams.set('per_page', String(perPage));
        headers.link = `<${nextUrl.toString()}>; rel="next"`;
      }
      sendRestJson(res, 200, ordered.slice(start, start + perPage).map(repositoryResponse), headers);
      return;
    }

    if (method === 'POST' && path === '/api/v3/user/repos') {
      const body = await readJsonObject(req);
      if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 100) {
        throw new HttpError(422, 'Repository name is required');
      }
      if (repositories.has(body.name)) throw new HttpError(422, 'Repository already exists');
      const repo = createRepositoryState(state, {
        name: body.name,
        owner: state.accountOwner,
        private: typeof body.private === 'boolean' ? body.private : false,
        description: typeof body.description === 'string' ? body.description : '',
      });
      repositories.set(repo.name, repo);
      sendRestJson(res, 201, repositoryResponse(repo));
      return;
    }

    const labelCollectionMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(path);
    const labelItemMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels\/([^/]+)$/.exec(path);
    const labelMatch = labelCollectionMatch ?? labelItemMatch;
    if (labelMatch !== null) {
      let owner: string;
      let name: string;
      let labelName: string | undefined;
      try {
        owner = decodeURIComponent(labelMatch[1]);
        name = decodeURIComponent(labelMatch[2]);
        if (labelItemMatch !== null) labelName = decodeURIComponent(labelItemMatch[3]);
      } catch {
        throw new HttpError(400, 'Invalid path encoding');
      }
      const repo = repositoryForOwner(owner, name);
      if (repo === undefined) throw new HttpError(404, 'Not Found');

      if (labelCollectionMatch !== null && method === 'GET') {
        sendRestJson(res, 200, [...repo.labels.values()].map(labelResponse));
        return;
      }
      if (labelCollectionMatch !== null && method === 'POST') {
        const body = await readJsonObject(req);
        if (typeof body.name !== 'string' || body.name.trim() === '') throw new HttpError(422, 'Label name is required');
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        if (!/^[0-9a-f]{6}$/i.test(color)) throw new HttpError(422, 'Label color must be six hexadecimal characters');
        const label = createLabel(state, repo, body.name, color);
        if (label === null) throw new HttpError(422, 'Label already exists');
        sendRestJson(res, 201, labelResponse(label));
        return;
      }
      if (labelItemMatch !== null && labelName !== undefined) {
        const key = labelName.toLowerCase();
        const label = repo.labels.get(key);
        if (label === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'PATCH') {
          const body = await readJsonObject(req);
          if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
            throw new HttpError(422, 'Label name must be a non-empty string');
          }
          if (body.color !== undefined && (typeof body.color !== 'string' || !/^[0-9a-f]{6}$/i.test(body.color.replace(/^#/, '')))) {
            throw new HttpError(422, 'Label color must be six hexadecimal characters');
          }
          const updatedName = typeof body.name === 'string' ? body.name : label.name;
          const updatedKey = updatedName.toLowerCase();
          if (updatedKey !== key && repo.labels.has(updatedKey)) throw new HttpError(422, 'Label already exists');
          if (updatedKey !== key) {
            repo.labels.delete(key);
            repo.labels.set(updatedKey, label);
          }
          label.name = updatedName;
          if (typeof body.color === 'string') label.color = body.color.replace(/^#/, '');
          sendRestJson(res, 200, labelResponse(label));
          return;
        }
        if (method === 'DELETE') {
          repo.labels.delete(key);
          for (const issue of repo.issues.values()) {
            const remainingLabels = issue.labels.filter((entry) => entry !== label);
            if (remainingLabels.length !== issue.labels.length) {
              issue.labels = remainingLabels;
              issue.updatedAt = nextStateTimestamp(state);
            }
          }
          res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': randomUUID() });
          res.end();
          return;
        }
      }
    }

    const issueRouteMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues(?:\/(\d+)(?:\/(comments))?)?$/.exec(path);
    if (issueRouteMatch !== null) {
      let owner: string;
      let name: string;
      try {
        owner = decodeURIComponent(issueRouteMatch[1]);
        name = decodeURIComponent(issueRouteMatch[2]);
      } catch {
        throw new HttpError(400, 'Invalid path encoding');
      }
      const repo = repositoryForOwner(owner, name);
      if (repo === undefined) throw new HttpError(404, 'Not Found');
      const issueNumber = issueRouteMatch[3] === undefined ? undefined : Number(issueRouteMatch[3]);
      const isComments = issueRouteMatch[4] === 'comments';

      if (issueNumber === undefined && method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://entry');
        const requestedState = url.searchParams.get('state') ?? 'open';
        if (!['open', 'closed', 'all'].includes(requestedState)) throw new HttpError(422, 'Invalid issue state');
        const sort = url.searchParams.get('sort') ?? 'created';
        if (!['created', 'updated'].includes(sort)) throw new HttpError(422, 'Invalid issue sort');
        const direction = url.searchParams.get('direction') ?? 'desc';
        if (!['asc', 'desc'].includes(direction)) throw new HttpError(422, 'Invalid issue sort direction');
        const sign = direction === 'asc' ? 1 : -1;
        const issues = [...repo.issues.values()]
          .filter((issue) => requestedState === 'all' || issue.state === requestedState)
          .sort((a, b) => sign * (sort === 'created'
            ? a.createdAt.localeCompare(b.createdAt) || a.number - b.number
            : a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number));
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
        sendRestJson(res, 200, issues.slice((page - 1) * perPage, page * perPage).map(issueResponse));
        return;
      }

      if (issueNumber === undefined && method === 'POST') {
        const body = await readJsonObject(req);
        if (typeof body.title !== 'string' || body.title.trim() === '') throw new HttpError(422, 'Issue title is required');
        if (body.body !== undefined && typeof body.body !== 'string') throw new HttpError(422, 'Issue body must be a string');
        if (body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.some((label) => typeof label !== 'string'))) {
          throw new HttpError(422, 'Issue labels must be an array of names');
        }
        const issue = createIssue(state, repo, {
          title: body.title,
          ...(typeof body.body === 'string' ? { body: body.body } : {}),
          ...(Array.isArray(body.labels) ? { labels: body.labels as string[] } : {}),
        });
        if (issue === null) throw new HttpError(422, 'One or more labels do not exist');
        sendRestJson(res, 201, issueResponse(issue));
        return;
      }

      if (issueNumber !== undefined && isComments) {
        const issue = repo.issues.get(issueNumber);
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          sendRestJson(res, 200, issue.comments.map(commentResponse));
          return;
        }
        if (method === 'POST') {
          const body = await readJsonObject(req);
          if (typeof body.body !== 'string' || body.body.trim() === '') throw new HttpError(422, 'Comment body is required');
          const comment = addIssueComment(state, repo, issueNumber, body.body);
          if (comment === null) throw new HttpError(404, 'Not Found');
          sendRestJson(res, 201, commentResponse(comment));
          return;
        }
      }

      if (issueNumber !== undefined && !isComments) {
        const issue = repo.issues.get(issueNumber);
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          sendRestJson(res, 200, issueResponse(issue));
          return;
        }
        if (method === 'PATCH') {
          const body = await readJsonObject(req);
          if (Object.keys(body).some((key) => !['title', 'body', 'state'].includes(key))) throw new HttpError(422, 'Unsupported issue update field');
          if (body.title !== undefined) {
            if (typeof body.title !== 'string' || body.title.trim() === '') throw new HttpError(422, 'Issue title must be a non-empty string');
          }
          if (body.body !== undefined) {
            if (typeof body.body !== 'string') throw new HttpError(422, 'Issue body must be a string');
          }
          if (body.state !== undefined) {
            if (body.state !== 'open' && body.state !== 'closed') throw new HttpError(422, 'Issue state must be open or closed');
          }
          const textChanged = (typeof body.title === 'string' && body.title !== issue.title) ||
            (typeof body.body === 'string' && body.body !== issue.body);
          const stateChanged = body.state !== undefined && body.state !== issue.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') setIssueState(state, repo, issueNumber, body.state);
          if (textChanged && !stateChanged) issue.updatedAt = nextStateTimestamp(state);
          sendRestJson(res, 200, issueResponse(issue));
          return;
        }
      }
    }

    const refCollectionMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(path);
    const branchListMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(path);
    const commitsMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(path);
    const refRouteMatch = refCollectionMatch ?? branchListMatch ?? commitsMatch;
    if (refRouteMatch !== null) {
      let owner: string;
      let name: string;
      try {
        owner = decodeURIComponent(refRouteMatch[1]);
        name = decodeURIComponent(refRouteMatch[2]);
      } catch {
        throw new HttpError(400, 'Invalid path encoding');
      }
      const repo = repositoryForOwner(owner, name);
      if (repo === undefined) throw new HttpError(404, 'Not Found');

      if (refCollectionMatch !== null && method === 'POST') {
        const body = await readJsonObject(req);
        if (typeof body.ref !== 'string' || !body.ref.startsWith('refs/heads/') || typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(body.sha)) {
          throw new HttpError(422, 'A branch ref and commit SHA are required');
        }
        const commit = repo.commits.get(body.sha);
        if (commit === undefined || repo.objects.get(body.sha)?.type !== 'commit') throw new HttpError(422, 'Reference target must be an existing commit');
        if (repo.refs.has(body.ref)) throw new HttpError(422, 'Reference already exists');
        repo.refs.set(body.ref, body.sha);
        const ref = body.ref.slice('refs/heads/'.length);
        sendRestJson(res, 201, { ref: body.ref, node_id: `REF_${body.sha}`, object: { sha: body.sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${body.sha}` }, name: ref });
        return;
      }
      if (branchListMatch !== null && method === 'GET') {
        const branches = [...repo.refs]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
        sendRestJson(res, 200, branches);
        return;
      }
      if (commitsMatch !== null && method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://entry');
        const selected = url.searchParams.get('sha');
        const commits = commitsFromRef(repo, selected);
        sendRestJson(res, 200, commits.map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })));
        return;
      }
    }

    const pullCollectionMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path);
    const pullItemMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\/(files|merge))?$/.exec(path);
    const pullRouteMatch = pullCollectionMatch ?? pullItemMatch;
    if (pullRouteMatch !== null) {
      let owner: string;
      let name: string;
      try {
        owner = decodeURIComponent(pullRouteMatch[1]);
        name = decodeURIComponent(pullRouteMatch[2]);
      } catch {
        throw new HttpError(400, 'Invalid path encoding');
      }
      const repo = repositoryForOwner(owner, name);
      if (repo === undefined) throw new HttpError(404, 'Not Found');

      if (pullCollectionMatch !== null && method === 'POST') {
        const body = await readJsonObject(req);
        if (typeof body.title !== 'string' || body.title.trim() === '' || typeof body.head !== 'string' || typeof body.base !== 'string') {
          throw new HttpError(422, 'Pull request title, head, and base are required');
        }
        if (body.body !== undefined && typeof body.body !== 'string') throw new HttpError(422, 'Pull request body must be a string');
        const pull = createPullRequest(state, repo, {
          title: body.title,
          head: body.head,
          base: body.base,
          ...(typeof body.body === 'string' ? { body: body.body } : {}),
        });
        if (pull === null) throw new HttpError(422, 'Pull request head and base must name existing branches');
        sendRestJson(res, 201, pullRequestResponse(pull));
        return;
      }
      if (pullCollectionMatch !== null && method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://entry');
        const selectedState = url.searchParams.get('state') ?? 'open';
        if (!['open', 'closed', 'all'].includes(selectedState)) throw new HttpError(422, 'Invalid pull request state');
        const pulls = [...repo.pullRequests.values()]
          .filter((pull) => selectedState === 'all' || pull.state === selectedState)
          .sort((a, b) => b.number - a.number);
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
        sendRestJson(res, 200, pulls.slice((page - 1) * perPage, page * perPage).map(pullRequestResponse));
        return;
      }
      if (pullItemMatch !== null) {
        const number = Number(pullItemMatch[3]);
        const action = pullItemMatch[4];
        const pull = repo.pullRequests.get(number);
        if (pull === undefined) {
          if (method === 'PUT' && action === 'merge') throw new HttpError(404, 'Pull request not found');
          throw new HttpError(404, 'Not Found');
        }
        if (method === 'GET' && action === undefined) {
          sendRestJson(res, 200, pullRequestResponse(pull));
          return;
        }
        if (method === 'GET' && action === 'files') {
          sendRestJson(res, 200, changedPullFiles(repo, pull));
          return;
        }
        if (method === 'PUT' && action === 'merge') {
          const merged = mergePullRequest(state, repo, pull, owner);
          if (merged === null) throw new HttpError(405, pull.mergeable === 'CONFLICTING' ? 'Pull request has merge conflicts' : 'Pull request is not open');
          sendRestJson(res, 200, { ...merged, merged: true });
          return;
        }
      }
    }

    const contentsMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path);
    if (contentsMatch !== null) {
      let owner: string;
      let name: string;
      let filePath: string;
      try {
        owner = decodeURIComponent(contentsMatch[1]);
        name = decodeURIComponent(contentsMatch[2]);
        filePath = decodeURIComponent(contentsMatch[3]).split('/').filter(Boolean).join('/');
      } catch {
        throw new HttpError(400, 'Invalid path encoding');
      }
      const repo = repositoryForOwner(owner, name);
      if (repo === undefined) throw new HttpError(404, 'Not Found');

      if (method === 'DELETE') {
        const body = await readJsonObject(req);
        if (typeof body.message !== 'string' || typeof body.sha !== 'string') {
          throw new HttpError(422, 'message and sha are required');
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const parentSha = branchSha(repo, branch);
        if (parentSha === undefined) throw new HttpError(422, 'Branch not found');
        const previous = repo.commits.get(parentSha);
        const files = new Map(previous?.files ?? []);
        const priorContent = files.get(filePath);
        if (priorContent === undefined) throw new HttpError(404, 'Not Found');
        const priorSha = storeGitObject(repo, 'blob', priorContent);
        if (body.sha !== priorSha) throw new HttpError(409, 'sha does not match the current file');
        files.delete(filePath);
        const commit = addContentCommit(repo, owner, branch, body.message, files, parentSha);
        sendRestJson(res, 200, {
          commit: {
            sha: commit.sha,
            message: commit.message,
            tree: { sha: commit.treeSha },
            parents: commit.parentSha === undefined ? [] : [{ sha: commit.parentSha }],
          },
        });
        return;
      }

      if (method === 'PUT') {
        const body = await readJsonObject(req);
        if (typeof body.content !== 'string' || typeof body.message !== 'string') {
          throw new HttpError(422, 'content and message are required');
        }
        const compactBase64 = body.content.replace(/\s+/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compactBase64)) {
          throw new HttpError(422, 'content must be base64');
        }
        const content = Buffer.from(compactBase64, 'base64');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const parentSha = branchSha(repo, branch);
        if (parentSha === undefined && branch !== repo.defaultBranch) throw new HttpError(422, 'Branch not found');
        const previous = parentSha === undefined ? undefined : repo.commits.get(parentSha);
        const files = new Map(previous?.files ?? []);
        const priorContent = files.get(filePath);
        const priorSha = priorContent === undefined ? undefined : storeGitObject(repo, 'blob', priorContent);
        if ((priorContent !== undefined && body.sha !== priorSha) || (priorContent === undefined && body.sha !== undefined)) {
          throw new HttpError(409, 'sha does not match the current file');
        }
        files.set(filePath, content);
        const commit = addContentCommit(repo, owner, branch, body.message, files, parentSha);
        const contentSha = storeGitObject(repo, 'blob', content);
        const responseBody = {
          content: { type: 'file', name: filePath.slice(filePath.lastIndexOf('/') + 1), path: filePath, sha: contentSha, size: content.length, encoding: 'base64' },
          commit: {
            sha: commit.sha,
            message: commit.message,
            tree: { sha: commit.treeSha },
            parents: commit.parentSha === undefined ? [] : [{ sha: commit.parentSha }],
          },
        };
        sendRestJson(res, priorContent === undefined ? 201 : 200, responseBody);
        return;
      }

      if (method === 'GET') {
        const requestUrl = new URL(req.url ?? '/', 'http://entry');
        const commit = commitForRef(repo, requestUrl.searchParams.get('ref'));
        const files = commit?.files ?? new Map<string, Buffer>();
        const content = files.get(filePath);
        if (content !== undefined) {
          const sha = storeGitObject(repo, 'blob', content);
          sendRestJson(res, 200, contentsFileResponse(filePath, content, sha));
          return;
        }
        const prefix = `${filePath}/`;
        const children = new Map<string, { directory: boolean; content?: Buffer }>();
        for (const [candidate, bytes] of files) {
          if (!candidate.startsWith(prefix)) continue;
          const remainder = candidate.slice(prefix.length);
          const slash = remainder.indexOf('/');
          const childName = slash < 0 ? remainder : remainder.slice(0, slash);
          if (childName !== '') children.set(childName, slash >= 0 ? { directory: true } : { directory: false, content: bytes });
        }
        if (children.size === 0) throw new HttpError(404, 'Not Found');
        const entries = [...children].sort(([a], [b]) => a.localeCompare(b)).map(([childName, child]) => {
          const childPath = `${filePath}/${childName}`;
          const sha = child.directory
            ? buildTree(repo, new Map([...files].filter(([candidate]) => candidate.startsWith(`${childPath}/`)).map(([candidate, bytes]) => [candidate.slice(childPath.length + 1), bytes])))
            : storeGitObject(repo, 'blob', child.content ?? Buffer.alloc(0));
          return { type: child.directory ? 'dir' : 'file', name: childName, path: childPath, sha, size: child.content?.length ?? 0 };
        });
        sendRestJson(res, 200, entries);
        return;
      }
    }

    const repositoryMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (repositoryMatch !== null) {
      let owner: string;
      let name: string;
      try {
        owner = decodeURIComponent(repositoryMatch[1]);
        name = decodeURIComponent(repositoryMatch[2]);
      } catch {
        throw new HttpError(400, 'Invalid path encoding');
      }
      const repo = repositoryForOwner(owner, name);
      if (repo === undefined) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        sendRestJson(res, 200, repositoryResponse(repo));
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonObject(req);
        if (typeof body.description !== 'string') throw new HttpError(422, 'Repository description must be a string');
        repo.description = body.description;
        sendRestJson(res, 200, repositoryResponse(repo));
        return;
      }
      if (method === 'DELETE') {
        repositories.delete(repo.name);
        res.writeHead(204, { 'x-github-request-id': randomUUID() });
        res.end();
        return;
      }
    }

    if (isRestRoute) {
      sendRestJson(res, 404, { message: 'Not Found' });
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' });
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void respondToRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Internal Server Error';
      const path = pathOf(req);
      if (path === '/api/v3' || path.startsWith('/api/v3/')) sendRestJson(res, status, { message });
      else sendJson(res, status, { message });
    });
  });
}
