// mcp.ts — Model Context Protocol server over JSON-RPC 2.0 (POST /mcp).
// Modern era 2026-07-28 preferred, legacy initialize supported. Six tools
// that mirror the forge's REST surface. Node stdlib only. Written fresh
// for v2.
import { VIEWER, VIEWER_NUM, stampOf, mergeConflicts, squashPr } from './store.ts';
import type { Repo, Vault } from './store.ts';
import { repoObj, issueObj, pullObj } from './serial.ts';

export const SERVER_NAME = 'github-core-clone-01-forge';
export const SERVER_VERSION = '2.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Frozen at module load so tools/list returns byte-identical arrays.
export const TOOLS_JSON = JSON.stringify(TOOLS);

interface CallOut {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
  isError?: boolean;
}

function okOut(value: unknown): CallOut {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errOut(message: string): CallOut {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

// The suite maps each argument onto the schema's nearest property name and
// also fills a full_name property (owner/repo). Accept either form.
function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      if (!owner) owner = args.full_name.slice(0, slash);
      if (!repo) repo = args.full_name.slice(slash + 1);
    }
  }
  return { owner, repo };
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
}

export function callTool(vault: Vault, name: string, args: Record<string, unknown>): CallOut {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw { code: -32601, message: `unknown tool: ${name}` };
  // Normalise owner/repo from full_name before the required check, so a
  // caller that only sends full_name still passes it.
  const { owner, repo: repoName } = ownerRepoOf(args);
  const norm: Record<string, unknown> = { ...args, owner, repo: repoName };
  const missing = missingRequired(tool, norm);
  if (missing.length) {
    throw { code: -32602, message: `missing required arguments: ${missing.join(', ')}` };
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(norm.name);
      const repo = vault.newRepo(VIEWER, repoName, String(norm.description ?? ''), Boolean(norm.private ?? false));
      if (!repo) return errOut(`Repository already exists: ${VIEWER}/${repoName}`);
      return okOut(repoObj(repo));
    }
    case 'get_repo': {
      const repo = vault.repo(owner, repoName);
      if (!repo) return errOut(`Repository not found: ${owner}/${repoName}`);
      return okOut(repoObj(repo));
    }
    case 'create_issue': {
      const repo = vault.repo(owner, repoName);
      if (!repo) return errOut(`Repository not found: ${owner}/${repoName}`);
      const n = ++repo.issueSeq;
      const seq = vault.nextOrder();
      const issue = {
        id: vault.nextGlobal(), number: n, title: String(norm.title),
        body: String(norm.body ?? ''), state: 'open' as const, labels: [] as string[],
        seq, createdSeq: seq,
      };
      repo.issues.set(n, issue);
      return okOut(issueObj(repo, issue));
    }
    case 'list_issues': {
      const repo = vault.repo(owner, repoName);
      if (!repo) return errOut(`Repository not found: ${owner}/${repoName}`);
      const state = String(norm.state ?? 'open').toLowerCase();
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return okOut(list.map((i) => issueObj(repo, i)));
    }
    case 'create_pull_request': {
      const repo = vault.repo(owner, repoName);
      if (!repo) return errOut(`Repository not found: ${owner}/${repoName}`);
      const head = String(norm.head);
      const base = String(norm.base);
      if (!repo.tipOfBranch(head) || !repo.tipOfBranch(base)) return errOut(`Branch not found: ${head} or ${base}`);
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headBranch === head && p.baseBranch === base) {
          return errOut('A pull request already exists for this head and base');
        }
      }
      const n = ++repo.issueSeq;
      const seq = vault.nextOrder();
      const pr = {
        id: vault.nextGlobal(), number: n, title: String(norm.title),
        body: String(norm.body ?? ''), state: 'open' as const, merged: false,
        mergedAt: null as string | null, mergeSha: null as string | null,
        headBranch: head, baseBranch: base, seq, createdSeq: seq,
      };
      repo.pulls.set(n, pr);
      return okOut(pullObj(repo, pr));
    }
    case 'merge_pull_request': {
      const repo = vault.repo(owner, repoName);
      if (!repo) return errOut(`Repository not found: ${owner}/${repoName}`);
      const pr = repo.pulls.get(Number(norm.pull_number));
      if (!pr) return errOut(`Pull request not found: ${norm.pull_number}`);
      if (pr.state !== 'open' || pr.merged) return errOut('Pull request is not open');
      const baseTip = repo.tipOfBranch(pr.baseBranch);
      const headTip = repo.tipOfBranch(pr.headBranch);
      if (!baseTip || !headTip) return errOut('Branch not found');
      if (mergeConflicts(repo, baseTip, headTip)) return errOut('Merge conflict');
      const sha = squashPr(repo, pr);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = stampOf(vault.nextOrder());
      pr.mergeSha = sha;
      return okOut({ merged: true, sha, number: pr.number });
    }
    default:
      throw { code: -32601, message: `unknown tool: ${name}` };
  }
}

// Handle one JSON-RPC request object. Returns { status, body } where body is
// null for a 202 notification acknowledgement.
export function handleMcpRequest(
  vault: Vault,
  req: unknown,
  protocolVersionHeader?: string,
): { status: number; body: unknown } {
  const fail = (id: unknown, code: number, message: string, data?: unknown) => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return fail(null, -32600, 'invalid request');
  }
  const r = req as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const hasId = r.id !== undefined && r.id !== null;
  const id = r.id ?? null;
  if (typeof r.method !== 'string') return fail(id, -32600, 'invalid request: missing method');
  // Notification (no id): only notifications/initialized is expected.
  if (!hasId) {
    return { status: 202, body: null };
  }
  switch (r.method) {
    case 'server/discover': {
      if (protocolVersionHeader && !SUPPORTED_VERSIONS.includes(protocolVersionHeader)) {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32022, message: 'unsupported protocol version', data: { supported: SUPPORTED_VERSIONS } },
          },
        };
      }
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: SUPPORTED_VERSIONS,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {} },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
          },
        },
      };
    }
    case 'initialize': {
      const params = (r.params ?? {}) as { protocolVersion?: string };
      const requested = String(params.protocolVersion ?? '');
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        },
      };
    }
    case 'ping': {
      return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
    }
    case 'tools/list': {
      return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
    }
    case 'tools/call': {
      const params = (r.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (typeof params.name !== 'string') return fail(id, -32602, 'missing tool name');
      try {
        const result = callTool(vault, params.name, params.arguments ?? {});
        return { status: 200, body: { jsonrpc: '2.0', id, result } };
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err) {
          const e = err as { code: number; message: string };
          return fail(id, e.code, e.message);
        }
        return fail(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }
    default:
      return fail(id, -32601, `method not found: ${r.method}`);
  }
}
