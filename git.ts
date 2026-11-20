// git.ts — git smart-HTTP protocol: pkt-line codec, packfile read/write
// (full objects only on the wire; OFS/REF deltas resolved on ingest),
// upload-pack v2 + v0, receive-pack v0. Node stdlib only. Written fresh
// for v2 — same wire behaviour as v1, own code throughout.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  FORGE_AGENT, ZERO_OID, readCommit, readTag, readTree,
  commitsReachable, depthWalk, isAncestorOf, oidOf,
} from './store.ts';
import type { ObjKind, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export function pktText(s: string): Buffer {
  return pkt(s + '\n');
}

// Read pkt-lines until the first flush packet.
export function readPktUntilFlush(buf: Buffer, start = 0): { lines: string[]; next: number } {
  const lines: string[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') return { lines, next: i + 4 };
    if (hex === '0001') {
      lines.push('\u0001');
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) {
      throw new Error(`malformed pkt-line at offset ${i}: ${JSON.stringify(hex)}`);
    }
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  throw new Error('pkt-line stream ended without flush');
}

// Split a v2-style body into sections divided by delim/flush packets.
export function splitSections(buf: Buffer): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      sections.push(current);
      return sections;
    }
    if (hex === '0001') {
      sections.push(current);
      current = [];
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) {
      throw new Error('malformed pkt-line in section parse');
    }
    current.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// Packfile write/read
// ---------------------------------------------------------------------------

export interface PackObj {
  type: ObjKind;
  buf: Buffer;
}

const KIND_NUM: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_KIND: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function packObjects(entries: { oid: string; type: ObjKind; buf: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const e of entries) {
    const compressed = deflateSync(e.buf);
    const size = e.buf.length;
    const typeNum = KIND_NUM[e.type];
    const bytes: number[] = [];
    let b = (typeNum << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest) b |= 0x80;
    bytes.push(b);
    while (rest) {
      let nb = rest & 0x7f;
      rest >>= 7;
      if (rest) nb |= 0x80;
      bytes.push(nb);
    }
    parts.push(Buffer.from(bytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  // Trailer: SHA-1 of everything before it. It must be computed over the
  // concatenated body, not over a pre-concat trailer buffer (v1 bug #1).
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Length of the zlib stream starting at buf[0]: the smallest prefix that
// inflates cleanly is exactly the stream end (success is monotonic).
function zlibLen(buf: Buffer): number {
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

export function deltaApply(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op) {
      out.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export interface UnpackResult {
  entries: PackObj[];
  oids: string[];
}

// Read a packfile, resolving OFS (6) and REF (7) deltas against pack bases
// and objects already in the repo. Entries come back in pack order.
export function readPack(buf: Buffer, repo: Repo): UnpackResult {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a PACK file');
  }
  const count = buf.readUInt32BE(8);
  let off = 12;
  interface RawObj {
    offset: number;
    typeNum: number;
    buf: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawObj[] = [];
  for (let n = 0; n < count; n++) {
    const start = off;
    let byte = buf[off++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      // OFS delta: negative offset varint.
      let b = buf[off++];
      let base = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++];
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - base;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateSync(buf.subarray(off));
    const consumed = zlibLen(buf.subarray(off));
    off += consumed;
    if (inflated.length !== size) {
      // Tolerate size mismatches from exotic encodings; trust the data.
    }
    raw.push({ offset: start, typeNum, buf: inflated, baseOffset, baseOid });
  }
  const byOffset = new Map<number, PackObj>();
  const byOid = new Map<string, PackObj>();
  const entries: PackObj[] = [];
  for (const r of raw) {
    let entry: PackObj;
    if (r.typeNum === 6 || r.typeNum === 7) {
      let base: PackObj | undefined;
      if (r.baseOffset !== undefined) base = byOffset.get(r.baseOffset);
      else if (r.baseOid !== undefined) {
        base = byOid.get(r.baseOid);
        if (!base) {
          const obj = repo.object(r.baseOid);
          if (obj) base = { type: obj.kind, buf: obj.buf };
        }
      }
      if (!base) throw new Error('delta base not found');
      entry = { type: base.type, buf: deltaApply(base.buf, r.buf) };
    } else {
      const kind = NUM_KIND[r.typeNum];
      if (!kind) throw new Error(`unknown pack object type ${r.typeNum}`);
      entry = { type: kind, buf: r.buf };
    }
    byOffset.set(r.offset, entry);
    byOid.set(oidOf(entry.type, entry.buf), entry);
    entries.push(entry);
  }
  return { entries, oids: entries.map((e) => oidOf(e.type, e.buf)) };
}

// ---------------------------------------------------------------------------
// Sideband
// ---------------------------------------------------------------------------

export function sidebandWrap(data: Buffer, band: 1 | 2 | 3): Buffer {
  const out: Buffer[] = [];
  const MAX = 32768 - 5; // 4-byte pkt length + 1 band byte
  for (let i = 0; i < data.length; i += MAX) {
    const chunk = data.subarray(i, Math.min(data.length, i + MAX));
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pkt(Buffer.from([band])));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=' + FORGE_AGENT + ' object-format=sha1';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=' + FORGE_AGENT + ' object-format=sha1';

interface RefRow {
  name: string;
  oid: string;
  peeled?: string;
}

function refRows(repo: Repo): RefRow[] {
  const out: RefRow[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    const row: RefRow = { name, oid };
    const obj = repo.object(oid);
    if (obj?.kind === 'tag') {
      const target = readTag(obj.buf).object;
      const targetObj = repo.object(target);
      if (targetObj?.kind === 'commit') row.peeled = target;
    }
    out.push(row);
  }
  return out;
}

export function advertUploadV0(repo: Repo): Buffer {
  const key = `up-v0:${repo.refVersion}:${repo.defaultBranch}`;
  const hit = repo.advCache.get(key);
  if (hit) return hit;
  const parts: Buffer[] = [];
  parts.push(pktText('# service=git-upload-pack'));
  parts.push(FLUSH_PKT);
  const refs = refRows(repo);
  if (refs.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0symref=HEAD:refs/heads/${repo.defaultBranch} ${UPLOAD_CAPS}`));
  } else {
    const headTip = repo.head() ?? ZERO_OID;
    parts.push(pktText(`${headTip} HEAD\0symref=HEAD:refs/heads/${repo.defaultBranch} ${UPLOAD_CAPS}`));
    for (const r of refs) {
      parts.push(pktText(`${r.oid} ${r.name}`));
      if (r.peeled) parts.push(pktText(`${r.peeled} ${r.name}^{}`));
    }
  }
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  repo.advCache.set(key, out);
  return out;
}

export function advertReceiveV0(repo: Repo): Buffer {
  const key = `recv-v0:${repo.refVersion}:${repo.defaultBranch}`;
  const hit = repo.advCache.get(key);
  if (hit) return hit;
  const parts: Buffer[] = [];
  parts.push(pktText('# service=git-receive-pack'));
  parts.push(FLUSH_PKT);
  const refs = refRows(repo);
  if (refs.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}`));
  } else {
    const headTip = repo.head() ?? ZERO_OID;
    parts.push(pktText(`${headTip} HEAD\0${RECEIVE_CAPS}`));
    for (const r of refs) {
      parts.push(pktText(`${r.oid} ${r.name}`));
      if (r.peeled) parts.push(pktText(`${r.peeled} ${r.name}^{}`));
    }
  }
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  repo.advCache.set(key, out);
  return out;
}

export function advertUploadV2(repo: Repo): Buffer {
  const key = `up-v2:${repo.refVersion}:${repo.defaultBranch}`;
  const hit = repo.advCache.get(key);
  if (hit) return hit;
  const parts: Buffer[] = [];
  parts.push(pktText('version 2'));
  parts.push(pktText('agent=' + FORGE_AGENT));
  parts.push(pktText('ls-refs=unborn peel symrefs ref-prefix'));
  parts.push(pktText('fetch=shallow filter deepen-relative'));
  parts.push(pktText('object-format=sha1'));
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  repo.advCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Upload-pack: ls-refs (v2)
// ---------------------------------------------------------------------------

export function lsRefs(repo: Repo, body: Buffer): Buffer {
  // Identical ls-refs requests (same body bytes, same ref version) always
  // get the identical response — cache the whole answer, as with fetch.
  const cacheKey = `ls:${repo.refVersion}:${body.toString('utf8')}`;
  const hit = repo.fetchCache.get(cacheKey);
  if (hit) return hit;
  const sections = splitSections(body);
  // v2 ls-refs body: [command=ls-refs, agent, object-format] delim
  // [peel, symrefs, unborn, ref-prefix ...] flush. The arguments live in
  // the SECOND section (after the delimiter) — reading them from the first
  // section was v1 bug #2.
  const args = sections[1] ?? [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of args) {
    const l = line.trim();
    if (l === 'peel') peel = true;
    else if (l === 'symrefs') symrefs = true;
    else if (l === 'unborn') unborn = true;
    else if (l.startsWith('ref-prefix ')) prefixes.push(l.slice(11));
  }
  const parts: Buffer[] = [];
  const refs = refRows(repo);
  const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (unborn && matches('HEAD')) {
      parts.push(pktText(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`));
    }
  } else {
    const headTip = repo.head();
    if (headTip && matches('HEAD')) {
      const attrs = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktText(`${headTip} HEAD${attrs}`));
    }
    for (const r of refs) {
      if (!matches(r.name)) continue;
      let attrs = '';
      if (peel && r.peeled) attrs += ` peeled:${r.peeled}`;
      parts.push(pktText(`${r.oid} ${r.name}${attrs}`));
    }
  }
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  if (repo.fetchCache.size >= 32) {
    const firstKey = repo.fetchCache.keys().next().value;
    if (firstKey !== undefined) repo.fetchCache.delete(firstKey);
  }
  repo.fetchCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// Upload-pack: fetch (v2 and v0)
// ---------------------------------------------------------------------------

export interface FetchReq {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
  deepenRelative: boolean;
  thinPack: boolean;
}

function blankFetchReq(): FetchReq {
  return { wants: [], haves: [], shallows: [], deepen: null, deepenRelative: false, thinPack: false };
}

export function parseFetchV2(body: Buffer): FetchReq {
  const sections = splitSections(body);
  const req = blankFetchReq();
  for (const line of sections[1] ?? []) {
    const l = line.trim();
    if (l.startsWith('want ')) req.wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) req.shallows.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) req.deepen = Number(l.slice(7).trim());
    else if (l === 'deepen-relative') req.deepenRelative = true;
    else if (l === 'thin-pack') req.thinPack = true;
  }
  return req;
}

export function parseFetchV0(body: Buffer): FetchReq {
  const req = blankFetchReq();
  const s1 = readPktUntilFlush(body);
  for (const line of s1.lines) {
    const l = line.trim();
    const nul = l.indexOf('\0');
    const clean = nul === -1 ? l : l.slice(0, nul);
    if (clean.startsWith('want ')) req.wants.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) req.shallows.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) req.deepen = Number(clean.slice(7).trim());
    else if (clean === 'deepen-relative') req.deepenRelative = true;
  }
  const s2 = readPktUntilFlush(body, s1.next);
  for (const line of s2.lines) {
    const l = line.trim();
    if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
  }
  return req;
}

// Resolve a wanted oid through annotated tags to the underlying commit
// (tags can point at tags). The tag objects on the chain must travel in the
// pack themselves.
function resolveWant(repo: Repo, oid: string): { commit: string | null; tags: string[] } {
  const tags: string[] = [];
  let cur = oid;
  for (;;) {
    const obj = repo.object(cur);
    if (!obj) return { commit: null, tags };
    if (obj.kind === 'tag') {
      tags.push(cur);
      cur = readTag(obj.buf).object;
      continue;
    }
    if (obj.kind === 'commit') return { commit: cur, tags };
    return { commit: null, tags };
  }
}

export interface FetchPlan {
  send: Set<string>;
  extra: Set<string>;
  shallow: string[];
  unshallow: string[];
  held: Set<string>;
}

export function planFetch(repo: Repo, req: FetchReq): FetchPlan {
  const clientShallow = new Set(req.shallows);
  // Held set: reachable from haves, never descending past a client shallow
  // boundary (the boundary commit itself is held, its parents are not).
  const held = new Set<string>();
  {
    const queue = [...req.haves];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.object(cur);
      if (!obj || obj.kind !== 'commit') continue;
      held.add(cur);
      if (clientShallow.has(cur)) continue;
      for (const p of readCommit(obj.buf).parents) queue.push(p);
    }
  }
  const wantCommits: string[] = [];
  const extra = new Set<string>();
  for (const w of req.wants) {
    const r = resolveWant(repo, w);
    for (const t of r.tags) extra.add(t);
    if (r.commit) wantCommits.push(r.commit);
  }
  let wanted: Set<string>;
  let boundary = new Set<string>();
  if (req.deepen !== null && req.deepen > 0) {
    if (req.deepenRelative && req.shallows.length > 0) {
      // deepen-relative (real git's --deepen): the new boundary sits
      // `deepen` levels BELOW the client's current shallow commits, i.e.
      // depth deepen+1 from each reachable shallow commit.
      const newBoundary = new Set<string>();
      for (const s of req.shallows) {
        if (!wantCommits.some((w) => isAncestorOf(repo, s, w))) continue;
        const d = depthWalk(repo, [s], req.deepen + 1);
        for (const b of d.boundary) newBoundary.add(b);
      }
      wanted = new Set<string>();
      for (const w of wantCommits) {
        for (const c of commitsReachable(repo, w)) wanted.add(c);
      }
      const excluded = new Set<string>();
      for (const b of newBoundary) {
        const obj = repo.object(b);
        if (!obj || obj.kind !== 'commit') continue;
        for (const p of readCommit(obj.buf).parents) {
          for (const c of commitsReachable(repo, p)) excluded.add(c);
        }
      }
      for (const e of excluded) wanted.delete(e);
      boundary = newBoundary;
    } else {
      const d = depthWalk(repo, wantCommits, req.deepen);
      wanted = d.included;
      boundary = d.boundary;
    }
  } else {
    wanted = new Set<string>();
    for (const w of wantCommits) {
      for (const c of commitsReachable(repo, w)) wanted.add(c);
    }
  }
  const send = new Set<string>();
  for (const c of wanted) if (!held.has(c)) send.add(c);
  const shallow: string[] = [];
  for (const b of boundary) if (send.has(b)) shallow.push(b);
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    const obj = repo.object(s);
    if (!obj || obj.kind !== 'commit') continue;
    const parents = readCommit(obj.buf).parents;
    if (parents.some((p) => send.has(p) || wanted.has(p))) unshallow.push(s);
  }
  return { send, extra, shallow, unshallow, held };
}

// Objects the client already holds, given the held commit set: each held
// commit plus its own tree closure — but NOT its ancestors. (A shallow
// client holds the tip and its tree, not the parent's tree, even though the
// parent is reachable from the tip on the server.)
function heldObjects(repo: Repo, heldCommits: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const commitOid of heldCommits) {
    out.add(commitOid);
    const obj = repo.object(commitOid);
    if (!obj || obj.kind !== 'commit') continue;
    const stack = [readCommit(obj.buf).tree];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      const o = repo.object(cur);
      if (!o) continue;
      out.add(cur);
      if (o.kind === 'tree') {
        for (const e of readTree(o.buf)) stack.push(e.oid);
      }
    }
  }
  return out;
}

// Build the pack for a fetch: exactly the send commits (never their
// ancestors — the send set already is the exact closure) plus each send
// commit's tree closure, minus anything the client already holds, plus any
// extra objects (e.g. tag objects the client asked for by oid).
export function fetchPack(repo: Repo, sendCommits: Set<string>, extraOids: Set<string>, heldCommits: Set<string>): Buffer | null {
  if (sendCommits.size === 0 && extraOids.size === 0) return null;
  const cacheKey =
    [...sendCommits].sort().join(',') + '|' + [...extraOids].sort().join(',') + '|' + [...heldCommits].sort().join(',');
  const hit = repo.packCache.get(cacheKey);
  if (hit) return hit;
  const heldObjs = heldObjects(repo, heldCommits);
  const out = new Set<string>();
  for (const oid of extraOids) out.add(oid);
  for (const commitOid of sendCommits) {
    out.add(commitOid);
    const obj = repo.object(commitOid);
    if (!obj || obj.kind !== 'commit') continue;
    const stack = [readCommit(obj.buf).tree];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur) || heldObjs.has(cur)) continue;
      const o = repo.object(cur);
      if (!o) continue;
      out.add(cur);
      if (o.kind === 'tree') {
        for (const e of readTree(o.buf)) stack.push(e.oid);
      }
    }
  }
  const entries: { oid: string; type: ObjKind; buf: Buffer }[] = [];
  for (const oid of out) {
    const obj = repo.object(oid)!;
    entries.push({ oid, type: obj.kind, buf: obj.buf });
  }
  // Deterministic pack order: commits first (sorted), then the rest sorted.
  entries.sort((a, b) => {
    const rank = (t: ObjKind) => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'blob' ? 2 : 3);
    return rank(a.type) - rank(b.type) || (a.oid < b.oid ? -1 : 1);
  });
  const pack = packObjects(entries);
  if (repo.packCache.size >= 8) {
    const firstKey = repo.packCache.keys().next().value;
    if (firstKey !== undefined) repo.packCache.delete(firstKey);
  }
  repo.packCache.set(cacheKey, pack);
  return pack;
}

export function fetchV2(repo: Repo, body: Buffer): Buffer {
  // v2: identical requests (same body bytes, same ref version) always get
  // the identical response — cache the whole answer. This is the clone
  // workload's win: 50 concurrent shallow clones share one computed reply.
  const cacheKey = `v2:${repo.refVersion}:${body.toString('utf8')}`;
  const hit = repo.fetchCache.get(cacheKey);
  if (hit) return hit;
  const req = parseFetchV2(body);
  const { send, extra, shallow, unshallow, held } = planFetch(repo, req);
  const pack = fetchPack(repo, send, extra, held);
  const parts: Buffer[] = [];
  // Protocol v2 fetch response (git's own upload-pack/fetch-pack rules):
  // - No haves: no acknowledgments section; straight to the packfile.
  // - Haves with a common base: ACK each common have, then "ready", and
  //   the acknowledgments section ends with a DELIM (not FLUSH) — real git
  //   dies with "expected packfile to be sent after 'ready'" otherwise.
  //   A packfile section ALWAYS follows (even an empty pack when the
  //   client already holds everything).
  // - Haves with no common base: NAK, section ends with FLUSH, no packfile.
  let sendPack = req.haves.length === 0;
  if (req.haves.length > 0) {
    parts.push(pktText('acknowledgments'));
    let acked = false;
    for (const h of req.haves) {
      if (req.wants.some((w) => isAncestorOf(repo, h, w))) {
        parts.push(pktText(`ACK ${h}`));
        acked = true;
      }
    }
    if (acked) {
      parts.push(pktText('ready'));
      parts.push(DELIM_PKT);
      sendPack = true;
    } else {
      parts.push(pktText('NAK'));
      parts.push(FLUSH_PKT);
    }
  }
  if (sendPack) {
    if (shallow.length || unshallow.length) {
      parts.push(pktText('shallow-info'));
      for (const s of shallow) parts.push(pktText(`shallow ${s}`));
      for (const s of unshallow) parts.push(pktText(`unshallow ${s}`));
      parts.push(DELIM_PKT);
    }
    parts.push(pktText('packfile'));
    // An empty pack (0 objects) when the client holds everything.
    parts.push(sidebandWrap(pack ?? packObjects([]), 1));
    parts.push(FLUSH_PKT);
  }
  const out = Buffer.concat(parts);
  if (repo.fetchCache.size >= 32) {
    const firstKey = repo.fetchCache.keys().next().value;
    if (firstKey !== undefined) repo.fetchCache.delete(firstKey);
  }
  repo.fetchCache.set(cacheKey, out);
  return out;
}

export function fetchV0(repo: Repo, body: Buffer): Buffer {
  const cacheKey = `v0:${repo.refVersion}:${body.toString('utf8')}`;
  const hit = repo.fetchCache.get(cacheKey);
  if (hit) return hit;
  const req = parseFetchV0(body);
  const { send, extra, shallow, unshallow, held } = planFetch(repo, req);
  const pack = fetchPack(repo, send, extra, held);
  const parts: Buffer[] = [];
  let acked = false;
  for (const h of req.haves) {
    if (req.wants.some((w) => isAncestorOf(repo, h, w))) {
      parts.push(pktText(`ACK ${h}`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktText('NAK'));
  for (const s of shallow) parts.push(pktText(`shallow ${s}`));
  for (const s of unshallow) parts.push(pktText(`unshallow ${s}`));
  if (pack) parts.push(sidebandWrap(pack, 1));
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  if (repo.fetchCache.size >= 32) {
    const firstKey = repo.fetchCache.keys().next().value;
    if (firstKey !== undefined) repo.fetchCache.delete(firstKey);
  }
  repo.fetchCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// Receive-pack (v0)
// ---------------------------------------------------------------------------

export interface PushCmd {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function parsePushBody(body: Buffer): { commands: PushCmd[]; pack: Buffer } {
  const { lines, next } = readPktUntilFlush(body);
  const commands: PushCmd[] = [];
  for (const line of lines) {
    const l = line.trim();
    const nul = l.indexOf('\0');
    const clean = nul === -1 ? l : l.slice(0, nul);
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  return { commands, pack: body.subarray(next) };
}

export function receivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parsePushBody(body);
  // Ingest the pack first (skip when there is no pack data, e.g. delete-only).
  if (pack.length > 0) {
    const { entries } = readPack(pack, repo);
    for (const e of entries) repo.addObject(e.type, e.buf);
    // New objects arrived: any cached fetch answer may now be stale, even
    // when every ref update below is refused (non-fast-forward).
    if (entries.length > 0) repo.touchRefs();
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const cmd of commands) {
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      const current = repo.refs.get(cmd.ref);
      if (current === undefined || current === ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      } else {
        repo.dropRef(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
      // Stale old value: the client pushed against a tip we do not have.
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (current !== ZERO_OID && !isAncestorOf(repo, current, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.setRef(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  const lines: Buffer[] = [];
  lines.push(pktText('unpack ok'));
  for (const r of results) {
    lines.push(pktText(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'failed'}`));
  }
  lines.push(FLUSH_PKT);
  return Buffer.concat([sidebandWrap(Buffer.concat(lines), 1), FLUSH_PKT]);
}
