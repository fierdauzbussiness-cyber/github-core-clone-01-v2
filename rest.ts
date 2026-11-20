// rest.ts — GitHub REST v3 API (/api/v3): repos, branches, refs, commits,
// contents, issues, labels, pulls. Node stdlib only. Written fresh for v2.
import {
  VIEWER, VIEWER_NUM, stampOf, readCommit, readTree, flatten, diffOfTrees,
  commonBase, mergeConflicts, squashPr, commitFileOnBranch, recentCommits,
  treeFromFiles, makeCommit,
} from './store.ts';
import type { Repo, Vault } from './store.ts';
import { repoObj, issueObj, pullObj, issueText, repoText } from './serial.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestCtx {
  vault: Vault;
  method: string;
  segments: string[]; // decoded segments after /api/v3
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface RestOut {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (what = 'Not Found') => new ApiError(404, what);
const badInput = (msg: string) => new ApiError(422, msg);

function needRepo(ctx: RestCtx, owner: string, name: string): Repo {
  const repo = ctx.vault.repo(owner, name);
  if (!repo) throw notFound('Not Found');
  return repo;
}

function bodyObj(ctx: RestCtx): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  return ctx.body as Record<string, unknown>;
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// Pagination: page slice plus a Link header when more pages exist.
function paginate<T>(ctx: RestCtx, items: T[], path: string): { page: T[]; link?: string } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | undefined;
  if (start + perPage < items.length) {
    const base = `http://${ctx.host}${path}`;
    const next = `${base}?per_page=${perPage}&page=${pageNum + 1}`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = `${base}?per_page=${perPage}&page=${lastPage}`;
    const first = `${base}?per_page=${perPage}&page=1`;
    link = `<${next}>; rel="next", <${last}>; rel="last", <${first}>; rel="first"`;
  }
  return { page, link };
}

function linkHdr(link?: string): Record<string, string> | undefined {
  return link ? { Link: link } : undefined;
}

// Walk a tree to find a path: file (blob oid + size) or directory (tree oid).
function lookupPath(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string; size: number } | { kind: 'dir'; oid: string } | null {
  if (path === '') return { kind: 'dir', oid: treeOid };
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.object(current);
    if (!obj || obj.kind !== 'tree') return null;
    const entry = readTree(obj.buf).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') return { kind: 'dir', oid: entry.oid };
      const blob = repo.object(entry.oid);
      return { kind: 'file', oid: entry.oid, size: blob ? blob.buf.length : 0 };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = repo.object(treeOid);
  if (!obj || obj.kind !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const e of readTree(obj.buf)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      out.push({ type: 'dir', name: e.name, path, sha: e.oid, size: 0, url: '', html_url: '' });
    } else {
      const blob = repo.object(e.oid);
      out.push({ type: 'file', name: e.name, path, sha: e.oid, size: blob ? blob.buf.length : 0, url: '', html_url: '' });
    }
  }
  return out;
}

export function handleRest(ctx: RestCtx): RestOut {
  const { method, segments: s } = ctx;
  const vault = ctx.vault;

  // GET /api/v3/ — root.
  if (s.length === 0) {
    if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
    return {
      status: 200,
      body: {
        login: VIEWER,
        current_user_url: `http://${ctx.host}/api/v3/user`,
        repository_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}`,
      },
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
    };
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta') {
    if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
    return { status: 200, body: { installed_version: '2.0.0', verifiable_password_authentication: true } };
  }

  // /api/v3/user
  if (s.length === 1 && s[0] === 'user') {
    if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
    return {
      status: 200,
      body: { login: VIEWER, id: VIEWER_NUM, type: 'User', site_admin: false, name: VIEWER, url: `http://${ctx.host}/api/v3/users/${VIEWER}` },
    };
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const repos = vault.reposOf(VIEWER);
      const { page, link } = paginate(ctx, repos, '/api/v3/user/repos');
      return { status: 200, body: page.map((r) => repoObj(r)), headers: linkHdr(link) };
    }
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const name = asStr(b.name);
      if (!name) throw badInput('name is required');
      const repo = vault.newRepo(VIEWER, name, asStr(b.description), Boolean(b.private ?? false));
      if (!repo) throw badInput('Repository already exists');
      return { status: 201, body: repoText(repo) };
    }
    throw new ApiError(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1];
    const name = s[2];
    const rest = s.slice(3);

    // Repo itself: GET / PATCH / DELETE
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoText(needRepo(ctx, owner, name)) };
      if (method === 'DELETE') {
        if (!vault.removeRepo(owner, name)) throw notFound();
        return { status: 204 };
      }
      if (method === 'PATCH') {
        const repo = needRepo(ctx, owner, name);
        const b = bodyObj(ctx);
        if (typeof b.description === 'string') {
          repo.description = b.description;
          repo.wire = undefined;
        }
        if (typeof b.private === 'boolean') {
          repo.priv = b.private;
          repo.wire = undefined;
        }
        if (typeof b.default_branch === 'string' && b.default_branch !== repo.defaultBranch) {
          repo.defaultBranch = b.default_branch;
          repo.touchRefs();
        }
        return { status: 200, body: repoText(repo) };
      }
      throw new ApiError(405, 'Method Not Allowed');
    }

    const repo = needRepo(ctx, owner, name);

    // GET /branches, GET /branches/{branch}
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
        return {
          status: 200,
          body: repo.branchList().map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false })),
        };
      }
      if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
      const branch = rest.slice(1).join('/');
      const tip = repo.tipOfBranch(branch);
      if (!tip) throw notFound('Branch not found');
      return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
    }

    // GET /commits?sha=
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
      const shaParam = ctx.query.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = repo.tipOfBranch(shaParam) ?? (repo.object(shaParam)?.kind === 'commit' ? shaParam : undefined);
        if (!tip) throw notFound('No commit found for SHA: ' + shaParam);
      } else {
        tip = repo.head();
      }
      if (!tip) return { status: 200, body: [] };
      const commits = recentCommits(repo, tip, 100);
      return {
        status: 200,
        body: commits.map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message,
            author: { name: VIEWER, email: `${VIEWER}@example.invalid`, date: new Date(c.time * 1000).toISOString() },
            committer: { name: VIEWER, email: `${VIEWER}@example.invalid`, date: new Date(c.time * 1000).toISOString() },
          },
          author: { login: VIEWER, id: VIEWER_NUM },
          parents: [],
        })),
      };
    }

    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        // POST /git/refs
        if (method !== 'POST') throw new ApiError(405, 'Method Not Allowed');
        const b = bodyObj(ctx);
        const ref = asStr(b.ref);
        const sha = asStr(b.sha);
        if (!ref.startsWith('refs/')) throw badInput('ref must start with refs/');
        const obj = repo.object(sha);
        if (!obj) throw badInput('object not found: ' + sha);
        if (repo.refs.has(ref)) throw badInput('Reference already exists');
        repo.setRef(ref, sha);
        return { status: 201, body: { ref, object: { sha, type: obj.kind } } };
      }
      const ref = 'refs/' + rest.slice(2).join('/');
      if (method === 'GET') {
        const oid = repo.refs.get(ref);
        if (!oid) throw notFound('Reference does not exist');
        const obj = repo.object(oid);
        return { status: 200, body: { ref, object: { sha: oid, type: obj?.kind ?? 'commit' } } };
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(ref)) throw notFound('Reference does not exist');
        repo.dropRef(ref);
        return { status: 204 };
      }
      throw new ApiError(405, 'Method Not Allowed');
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const refParam = ctx.query.get('ref');
        const tip = refParam ? repo.tipOfBranch(refParam) : repo.head();
        if (!tip) throw notFound('Not Found');
        const treeOid = readCommit(repo.object(tip)!.buf).tree;
        const found = lookupPath(repo, treeOid, path);
        if (!found) throw notFound('Not Found');
        if (found.kind === 'dir') return { status: 200, body: dirListing(repo, found.oid, path) };
        const blob = repo.object(found.oid)!;
        return {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            size: found.size,
            name: path.split('/').pop() ?? path,
            path,
            content: blob.buf.toString('base64'),
            sha: found.oid,
          },
        };
      }
      if (method === 'PUT') {
        const b = bodyObj(ctx);
        const message = asStr(b.message, `Update ${path}`);
        const contentB64 = asStr(b.content);
        if (!contentB64) throw badInput('content is required');
        const content = Buffer.from(contentB64, 'base64');
        const branch = asStr(b.branch, repo.defaultBranch);
        const tip = repo.tipOfBranch(branch);
        let currentBlob: string | undefined;
        if (tip) {
          const treeOid = readCommit(repo.object(tip)!.buf).tree;
          const flat = flatten(repo, treeOid);
          currentBlob = flat.get(path)?.oid;
        }
        if (currentBlob) {
          const sha = asStr(b.sha);
          if (!sha) throw badInput('sha must be provided to update a file');
          if (sha !== currentBlob) throw new ApiError(409, 'sha does not match the current blob');
        }
        const { commitSha, blobSha, created } = commitFileOnBranch(repo, branch, path, content, message);
        return {
          status: created ? 201 : 200,
          body: {
            content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
            commit: { sha: commitSha, message },
          },
        };
      }
      if (method === 'DELETE') {
        const b = bodyObj(ctx);
        const message = asStr(b.message, `Delete ${path}`);
        const branch = asStr(b.branch, repo.defaultBranch);
        const tip = repo.tipOfBranch(branch);
        if (!tip) throw notFound('Not Found');
        const treeOid = readCommit(repo.object(tip)!.buf).tree;
        const flat = flatten(repo, treeOid);
        const entry = flat.get(path);
        if (!entry) throw notFound('Not Found');
        const sha = asStr(b.sha);
        if (sha && sha !== entry.oid) throw new ApiError(409, 'sha does not match the current blob');
        const files = new Map<string, Buffer>();
        for (const [p, e] of flat) {
          if (p === path) continue;
          const obj = repo.object(e.oid);
          if (obj) files.set(p, obj.buf);
        }
        const newTree = treeFromFiles(repo, files);
        const commitSha = makeCommit(repo, newTree, [tip], message);
        repo.setRef(`refs/heads/${branch}`, commitSha);
        return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
      }
      throw new ApiError(405, 'Method Not Allowed');
    }

    // /labels
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') {
          return { status: 200, body: [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description, url: '' })) };
        }
        if (method === 'POST') {
          const b = bodyObj(ctx);
          const name = asStr(b.name);
          if (!name) throw badInput('name is required');
          const existing = repo.labels.get(name);
          if (existing) return { status: 201, body: { name: existing.name, color: existing.color, description: existing.description, url: '' } };
          const label = { name, color: asStr(b.color, 'ededed'), description: asStr(b.description) };
          repo.labels.set(name, label);
          return { status: 201, body: { name: label.name, color: label.color, description: label.description, url: '' } };
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      throw notFound();
    }

    // /issues...
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (ctx.query.get('state') ?? 'open').toLowerCase();
          const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page, link } = paginate(ctx, list, `/api/v3/repos/${owner}/${name}/issues`);
          // Join the per-issue cached strings instead of re-stringifying.
          const bodyText = '[' + page.map((i) => issueText(repo, i)).join(',') + ']';
          return { status: 200, body: bodyText, headers: linkHdr(link) };
        }
        if (method === 'POST') {
          const b = bodyObj(ctx);
          const title = asStr(b.title);
          if (!title) throw badInput('title is required');
          const labelsRaw = Array.isArray(b.labels) ? b.labels : [];
          const labels: string[] = [];
          for (const l of labelsRaw) {
            const labelName = typeof l === 'string' ? l : typeof l === 'object' && l !== null ? asStr((l as Record<string, unknown>).name) : '';
            if (!repo.labels.has(labelName)) throw badInput(`Label does not exist: ${labelName}`);
            labels.push(labelName);
          }
          const n = ++repo.issueSeq;
          const seq = vault.nextOrder();
          const issue = {
            id: vault.nextGlobal(), number: n, title, body: asStr(b.body),
            state: 'open' as const, labels, seq, createdSeq: seq,
          };
          repo.issues.set(n, issue);
          return { status: 201, body: issueText(repo, issue) };
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      const n = Number(rest[1]);
      if (!Number.isInteger(n)) throw notFound();
      if (rest.length === 2) {
        const issue = repo.issues.get(n);
        if (!issue) throw notFound('Not Found');
        if (method === 'GET') return { status: 200, body: issueText(repo, issue) };
        if (method === 'PATCH') {
          const b = bodyObj(ctx);
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          issue.wire = undefined;
          return { status: 200, body: issueText(repo, issue) };
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(n);
        if (!issue) throw notFound('Not Found');
        if (method === 'GET') {
          const list = repo.comments.get(n) ?? [];
          return {
            status: 200,
            body: list.map((c) => ({
              id: c.id, body: c.body, user: { login: VIEWER, id: VIEWER_NUM },
              created_at: stampOf(c.seq),
              url: `https://api.github.com/repos/${owner}/${name}/issues/comments/${c.id}`,
            })),
          };
        }
        if (method === 'POST') {
          const b = bodyObj(ctx);
          const bodyText = asStr(b.body);
          if (!bodyText) throw badInput('body is required');
          const commentId = vault.nextGlobal();
          const list = repo.comments.get(n) ?? [];
          const seq = vault.nextOrder();
          list.push({ id: commentId, body: bodyText, seq });
          repo.comments.set(n, list);
          return {
            status: 201,
            body: {
              id: commentId, body: bodyText, user: { login: VIEWER, id: VIEWER_NUM },
              created_at: stampOf(seq),
              url: `https://api.github.com/repos/${owner}/${name}/issues/comments/${commentId}`,
            },
          };
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      throw notFound();
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (ctx.query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page, link } = paginate(ctx, list, `/api/v3/repos/${owner}/${name}/pulls`);
          return { status: 200, body: page.map((p) => pullObj(repo, p)), headers: linkHdr(link) };
        }
        if (method === 'POST') {
          const b = bodyObj(ctx);
          const headRaw = asStr(b.head);
          const baseRaw = asStr(b.base);
          const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
          if (!head || !base) throw badInput('head and base are required');
          if (!repo.tipOfBranch(head)) throw badInput(`head branch not found: ${head}`);
          if (!repo.tipOfBranch(base)) throw badInput(`base branch not found: ${base}`);
          for (const p of repo.pulls.values()) {
            if (p.state === 'open' && p.headBranch === head && p.baseBranch === base) {
              throw badInput('A pull request already exists for this head and base');
            }
          }
          const n = ++repo.issueSeq;
          const seq = vault.nextOrder();
          const pr = {
            id: vault.nextGlobal(), number: n, title: asStr(b.title),
            body: asStr(b.body), state: 'open' as const, merged: false,
            mergedAt: null as string | null, mergeSha: null as string | null,
            headBranch: head, baseBranch: base, seq, createdSeq: seq,
          };
          repo.pulls.set(n, pr);
          return { status: 201, body: pullObj(repo, pr) };
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      const n = Number(rest[1]);
      if (!Number.isInteger(n)) throw notFound();
      const pr = repo.pulls.get(n);
      if (!pr) throw notFound('Not Found');
      if (rest.length === 2) {
        if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
        return { status: 200, body: pullObj(repo, pr) };
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
        const headTip = repo.tipOfBranch(pr.headBranch);
        const baseTip = repo.tipOfBranch(pr.baseBranch);
        if (!headTip || !baseTip) return { status: 200, body: [] };
        const mb = commonBase(repo, baseTip, headTip);
        const mbTree = mb ? readCommit(repo.object(mb)!.buf).tree : null;
        const headTree = readCommit(repo.object(headTip)!.buf).tree;
        const files = diffOfTrees(repo, mbTree, headTree);
        return {
          status: 200,
          body: files.map((f) => ({
            filename: f.filename, status: f.status, additions: f.additions,
            deletions: f.deletions, changes: f.changes,
          })),
        };
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') throw new ApiError(405, 'Method Not Allowed');
        if (pr.state !== 'open' || pr.merged) throw new ApiError(405, 'Pull request is not open');
        const baseTip = repo.tipOfBranch(pr.baseBranch);
        const headTip = repo.tipOfBranch(pr.headBranch);
        if (!baseTip || !headTip) throw new ApiError(405, 'Pull request cannot be merged');
        if (mergeConflicts(repo, baseTip, headTip)) throw new ApiError(405, 'Merge conflict');
        const sha = squashPr(repo, pr);
        pr.state = 'closed';
        pr.merged = true;
        // Deterministic merge timestamp (v1 used the wall clock here).
        pr.mergedAt = stampOf(vault.nextOrder());
        pr.mergeSha = sha;
        return { status: 200, body: { sha, merged: true, message: `Pull request #${pr.number} merged` } };
      }
      throw notFound();
    }
  }

  throw notFound();
}
