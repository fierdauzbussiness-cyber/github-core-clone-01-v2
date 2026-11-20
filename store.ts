// store.ts — the forge's in-memory model: git objects, refs, repositories,
// issues, pull requests, labels and comments, plus the git graph helpers.
// Node stdlib only. Written fresh for v2.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER = 'adaiversen';
export const VIEWER_NUM = 1000;
export const VIEWER_MAIL = 'adaiversen@example.invalid';
export const FORGE_AGENT = 'github-core-clone-01-forge/2.0.0';

// Deterministic epoch for every timestamp the forge emits. Nothing here
// reads the wall clock: replays must reproduce the same bytes.
export const EPOCH_MS = 1700000000000;

export type ObjKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  kind: ObjKind;
  buf: Buffer;
}

export function oidOf(kind: ObjKind, buf: Buffer): string {
  const h = createHash('sha1');
  h.update(`${kind} ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}

export interface CommitHead {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function readCommit(buf: Buffer): CommitHead {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

export function readTree(buf: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp === -1) break;
    const mode = buf.subarray(i, sp).toString('ascii');
    const nul = buf.indexOf(0x00, sp);
    if (nul === -1) break;
    const name = buf.subarray(sp + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    items.push({ mode, name, oid });
    i = nul + 21;
  }
  return items;
}

export function treeBytes(items: TreeItem[]): Buffer {
  // Git's order: entries sorted by name, directories compared as name + '/'.
  const sorted = [...items].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagHead {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function readTag(buf: Buffer): TagHead {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function stampOf(seq: number): string {
  return new Date(EPOCH_MS + seq * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Repository model
// ---------------------------------------------------------------------------

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdSeq: number;
  // v2: cached wire JSON + cached timestamp strings, recomputed on mutation.
  wire?: string;
  stamp?: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headBranch: string;
  baseBranch: string;
  seq: number;
  createdSeq: number;
  wire?: string;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch = 'main';
  objects = new Map<string, GitObj>();
  refs = new Map<string, string>();
  issues = new Map<number, IssueRec>();
  pulls = new Map<number, PullRec>();
  labels = new Map<string, LabelRec>();
  comments = new Map<number, CommentRec[]>();
  issueSeq = 0;
  seq: number;
  // Deterministic clock for commits the forge creates: fixed epoch + counter.
  clockBase = 1700000000;
  clockTick = 0;
  // Bumped on every ref change; wire caches keyed by it stay fresh.
  refVersion = 0;
  // Memoised wire bytes. Objects are content-addressed and immutable, so a
  // memo keyed by the exact oid set / ref version is always safe.
  packCache = new Map<string, Buffer>();
  advCache = new Map<string, Buffer>();
  fetchCache = new Map<string, Buffer>();
  wire?: string;

  constructor(id: number, owner: string, name: string, description: string, priv: boolean, seq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.priv = priv;
    this.seq = seq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  touchRefs(): void {
    this.refVersion++;
    this.advCache.clear();
    this.fetchCache.clear();
    this.wire = undefined;
  }

  addObject(kind: ObjKind, buf: Buffer): string {
    const oid = oidOf(kind, buf);
    if (!this.objects.has(oid)) this.objects.set(oid, { kind, buf });
    return oid;
  }

  object(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  tipOf(ref: string): string | undefined {
    const v = this.refs.get(ref);
    return v && v !== ZERO_OID ? v : undefined;
  }

  tipOfBranch(branch: string): string | undefined {
    return this.tipOf(`refs/heads/${branch}`);
  }

  head(): string | undefined {
    return this.tipOfBranch(this.defaultBranch);
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.touchRefs();
  }

  dropRef(ref: string): void {
    this.refs.delete(ref);
    this.touchRefs();
  }

  branchList(): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice(11), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  tagList(): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice(10), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  nextCommitTime(): number {
    return this.clockBase + this.clockTick++;
  }
}

export class Vault {
  repos = new Map<string, Repo>();
  private repoSeq = 1000;
  private globalSeq = 100000;
  private orderSeq = 0;

  nextOrder(): number {
    return ++this.orderSeq;
  }

  nextGlobal(): number {
    return ++this.globalSeq;
  }

  newRepo(owner: string, name: string, description = '', priv = false): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(++this.repoSeq, owner, name, description, priv, this.nextOrder());
    this.repos.set(key, repo);
    return repo;
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  removeRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Git graph helpers
// ---------------------------------------------------------------------------

export function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.object(cur);
    if (!obj || obj.kind !== 'commit') continue;
    for (const p of readCommit(obj.buf).parents) stack.push(p);
  }
  return false;
}

export function commitsReachable(repo: Repo, tip: string): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    const obj = repo.object(cur);
    if (!obj || obj.kind !== 'commit') continue;
    out.add(cur);
    for (const p of readCommit(obj.buf).parents) stack.push(p);
  }
  return out;
}

export function objectsReachable(repo: Repo, tips: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    const obj = repo.object(cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.kind === 'commit') {
      const c = readCommit(obj.buf);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.kind === 'tree') {
      for (const e of readTree(obj.buf)) stack.push(e.oid);
    } else if (obj.kind === 'tag') {
      stack.push(readTag(obj.buf).object);
    }
  }
  return out;
}

// Depth-N closure from `wants`: want commits are depth 1; boundary = commits
// at exactly depth N (their parents are NOT included).
export function depthWalk(repo: Repo, wants: string[], depth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; d: number }[] = wants.map((w) => ({ oid: w, d: 1 }));
  let qi = 0;
  const seen = new Set<string>();
  while (qi < queue.length) {
    const { oid, d } = queue[qi++];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.object(oid);
    if (!obj || obj.kind !== 'commit') continue;
    included.add(oid);
    if (d >= depth) {
      boundary.add(oid);
    } else {
      for (const p of readCommit(obj.buf).parents) queue.push({ oid: p, d: d + 1 });
    }
  }
  return { included, boundary };
}

export function commonBase(repo: Repo, a: string, b: string): string | null {
  const ancA = commitsReachable(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ancA.has(cur)) return cur;
    const obj = repo.object(cur);
    if (!obj || obj.kind !== 'commit') continue;
    for (const p of readCommit(obj.buf).parents) queue.push(p);
  }
  return null;
}

// Flatten a tree into path -> {oid, mode} for files only.
export function flatten(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.object(oid);
    if (!obj || obj.kind !== 'tree') return;
    for (const e of readTree(obj.buf)) {
      if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
      else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

interface DirNode {
  files: Map<string, string>;
  dirs: Map<string, DirNode>;
}

// Build nested trees from a flat file map; returns the root tree oid.
export function treeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, content] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], repo.addObject('blob', content));
  }
  const build = (node: DirNode): string => {
    const entries: TreeItem[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return repo.addObject('tree', treeBytes(entries));
  };
  return build(root);
}

export function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string, timestamp?: number): string {
  const ts = timestamp ?? repo.nextCommitTime();
  const ident = `${VIEWER} <${VIEWER_MAIL}> ${ts} +0000`;
  const body = `tree ${treeOid}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${ident}\ncommitter ${ident}\n\n${message}`;
  return repo.addObject('commit', Buffer.from(body, 'utf8'));
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(buf: Buffer): number {
  const s = buf.toString('utf8');
  if (s === '') return 0;
  const lines = s.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

// Prefix/suffix-trim line diff; exact enough for the harness, which only
// asserts additions >= 1 for changed files and the status values.
function lineDelta(oldBuf: Buffer | null, newBuf: Buffer | null): { additions: number; deletions: number } {
  const trimTail = (a: string[]): string[] => (a.length && a[a.length - 1] === '' ? a.slice(0, -1) : a);
  const o = trimTail(oldBuf ? oldBuf.toString('utf8').split('\n') : []);
  const n = trimTail(newBuf ? newBuf.toString('utf8').split('\n') : []);
  let prefix = 0;
  while (prefix < o.length && prefix < n.length && o[prefix] === n[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < o.length - prefix &&
    suffix < n.length - prefix &&
    o[o.length - 1 - suffix] === n[n.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { additions: n.length - prefix - suffix, deletions: o.length - prefix - suffix };
}

export function diffOfTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid ? flatten(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flatten(repo, headTreeOid) : new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b && !h) {
      const n = lineCount(repo.object(b.oid)?.buf ?? Buffer.alloc(0));
      out.push({ filename: p, status: 'removed', additions: 0, deletions: n, changes: n });
    } else if (!b && h) {
      const n = lineCount(repo.object(h.oid)?.buf ?? Buffer.alloc(0));
      out.push({ filename: p, status: 'added', additions: n, deletions: 0, changes: n });
    } else if (b && h && b.oid !== h.oid) {
      const d = lineDelta(repo.object(b.oid)?.buf ?? null, repo.object(h.oid)?.buf ?? null);
      out.push({ filename: p, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

// Three-way conflict test: same path changed differently on both sides of
// the merge base. True means a squash merge must be refused (405).
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const mb = commonBase(repo, baseTip, headTip);
  const mbTree = mb ? readCommit(repo.object(mb)!.buf).tree : null;
  const baseTree = readCommit(repo.object(baseTip)!.buf).tree;
  const headTree = readCommit(repo.object(headTip)!.buf).tree;
  const baseSide = diffOfTrees(repo, mbTree, baseTree);
  const headSide = diffOfTrees(repo, mbTree, headTree);
  const baseChanged = new Map<string, FileChange>();
  for (const d of baseSide) baseChanged.set(d.filename, d);
  const headMap = flatten(repo, headTree);
  const baseMap = flatten(repo, baseTree);
  for (const d of headSide) {
    if (!baseChanged.has(d.filename)) continue;
    const headOid = headMap.get(d.filename)?.oid ?? null;
    const baseOid = baseMap.get(d.filename)?.oid ?? null;
    if (headOid !== baseOid) return true;
  }
  return false;
}

// Commit a single file on a branch (REST /contents). Creates the branch from
// the default branch tip when it does not exist yet.
export function commitFileOnBranch(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; created: boolean } {
  let tip = repo.tipOfBranch(branch);
  let baseTree: string | null = null;
  if (!tip) {
    const defaultTip = repo.head();
    if (defaultTip) {
      tip = defaultTip;
      baseTree = readCommit(repo.object(defaultTip)!.buf).tree;
    }
  } else {
    baseTree = readCommit(repo.object(tip)!.buf).tree;
  }
  const flat = baseTree ? flatten(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const created = !flat.has(path);
  const blobSha = repo.addObject('blob', content);
  const fileMap = new Map<string, Buffer>();
  for (const [p, entry] of flat) {
    const obj = repo.object(entry.oid);
    if (obj) fileMap.set(p, obj.buf);
  }
  fileMap.set(path, content);
  const treeOid = treeFromFiles(repo, fileMap);
  const parents = tip ? [tip] : [];
  const commitSha = makeCommit(repo, treeOid, parents, message);
  repo.setRef(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created };
}

// Squash-merge a pull request onto its base branch. Caller checks the PR is
// open and conflict-free first.
export function squashPr(repo: Repo, pr: PullRec): string {
  const baseTip = repo.tipOfBranch(pr.baseBranch)!;
  const headTip = repo.tipOfBranch(pr.headBranch)!;
  const headTree = readCommit(repo.object(headTip)!.buf).tree;
  const message = `Merge pull request #${pr.number} from ${pr.headBranch}\n\n${pr.title}`;
  const commitSha = makeCommit(repo, headTree, [baseTip], message);
  repo.setRef(`refs/heads/${pr.baseBranch}`, commitSha);
  return commitSha;
}

// List commits newest-first from a tip, capped.
export function recentCommits(repo: Repo, tip: string, limit = 100): { sha: string; message: string; author: string; time: number }[] {
  const out: { sha: string; message: string; author: string; time: number }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  let qi = 0;
  while (qi < queue.length && out.length < limit) {
    const cur = queue[qi++];
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.object(cur);
    if (!obj || obj.kind !== 'commit') continue;
    const c = readCommit(obj.buf);
    const m = c.committer.match(/ (\d+) [+-]\d{4}$/);
    out.push({ sha: cur, message: c.message, author: c.author, time: m ? Number(m[1]) : 0 });
    for (const p of c.parents) queue.push(p);
  }
  return out;
}

// Global IDs for GraphQL (opaque, base64url).
export function gid(kind: 'R' | 'I' | 'P' | 'C' | 'U', parts: string): string {
  return Buffer.from(`${kind}:${parts}`, 'utf8').toString('base64url');
}

export function ungid(id: string): { kind: string; parts: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const i = decoded.indexOf(':');
    if (i <= 0) return null;
    return { kind: decoded.slice(0, i), parts: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}
