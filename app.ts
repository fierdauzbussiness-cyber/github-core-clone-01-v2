// app.ts — HTTP server: routes git smart-HTTP, REST v3, GraphQL and MCP
// onto one in-memory Vault, with the auth and wire rules the harness checks
// (application/json everywhere on the API, X-GitHub-Request-Id on every
// reply, 401 without a token, 400 on malformed JSON). Node stdlib only.
// Written fresh for v2, with fast paths for the two benchmark-hot routes
// (GET one issue, POST one issue) that skip URL parsing and dispatch.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Vault } from './store.ts';
import {
  advertUploadV0, advertUploadV2, advertReceiveV0,
  lsRefs, fetchV2, fetchV0, receivePack,
} from './git.ts';
import { handleRest, ApiError } from './rest.ts';
import { handleGraphQLRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

export interface Forge {
  vault: Vault;
  server: ReturnType<typeof createServer>;
}

let requestCounter = 0;

function nextReqId(): string {
  return `req-${(++requestCounter).toString(16)}`;
}

// body may be an object (stringified here) or a pre-built JSON string,
// which is sent verbatim — the read/write workloads' cached issue JSON.
function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body);
  if (status === 204) {
    res.writeHead(204, { 'X-GitHub-Request-Id': nextReqId() });
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(text)),
    'X-GitHub-Request-Id': nextReqId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextReqId(),
  });
  res.end(body);
}

// Single-chunk bodies (the common case) are used as-is, no Buffer.concat.
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (first === null && chunks.length === 0) first = c;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) resolve(first ?? Buffer.alloc(0));
      else resolve(Buffer.concat(first ? [first, ...chunks] : chunks));
    });
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/);
  return m ? m[1].trim() : null;
}

export function createForge(): Forge {
  const vault = new Vault();
  const server = createServer(async (req, res) => {
    try {
      await dispatch(vault, req, res);
    } catch (err) {
      // Never crash the server on a bad request: answer 500 JSON and stay up.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // Response already gone; nothing more to do.
      }
    }
  });
  return { vault, server };
}

// Fast path for the two benchmark-hot routes. Returns true when it handled
// the request. The path is matched by hand (no URL constructor, no decode)
// and must be plain ASCII with no percent-escapes; anything else falls
// through to the general dispatcher.
async function fastIssuePath(vault: Vault, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') return false;
  const q = rawUrl.indexOf('?');
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  if (!path.startsWith('/api/v3/repos/') || path.includes('%')) return false;
  const rest = path.slice('/api/v3/repos/'.length);
  const parts = rest.split('/');
  if (method === 'GET') {
    if (parts.length !== 4 || parts[2] !== 'issues' || !/^\d+$/.test(parts[3])) return false;
  } else {
    if (parts.length !== 3 || parts[2] !== 'issues') return false;
  }
  const token = bearerToken(req);
  if (!token) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let body: unknown;
  if (method === 'POST') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Invalid JSON in request body' });
        return true;
      }
    }
  }
  try {
    const result = handleRest({
      vault,
      method,
      segments: ['repos', parts[0], parts[1], 'issues', ...(method === 'GET' ? [parts[3]] : [])],
      query: new URLSearchParams(),
      body,
      host: req.headers.host ?? 'localhost',
    });
    sendJson(res, result.status, result.body, result.headers ?? {});
  } catch (err) {
    if (err instanceof ApiError) sendJson(res, err.status, { message: err.message });
    else throw err;
  }
  return true;
}

async function dispatch(vault: Vault, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // GET /healthz — no auth.
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (await fastIssuePath(vault, req, res)) return;

  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const segments = pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -4);
    const repo = vault.repo(owner, repoName);
    const gitPath = segments.slice(2).join('/');
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && gitPath === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        const body = v2 ? advertUploadV2(repo) : advertUploadV0(repo);
        sendBytes(res, 200, body, 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, advertReceiveV0(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'missing service parameter' });
      return;
    }
    if (method === 'POST' && gitPath === 'git-upload-pack') {
      const body = await readBody(req);
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      try {
        let out: Buffer;
        if (v2) {
          // ls-refs bodies start with a pkt-line 'command=ls-refs'.
          const text = body.toString('utf8');
          if (text.includes('command=ls-refs')) out = lsRefs(repo, body);
          else out = fetchV2(repo, body);
        } else {
          out = fetchV0(repo, body);
        }
        sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
      } catch (err) {
        console.error('git-upload-pack error:', err instanceof Error ? err.stack : err);
        sendJson(res, 400, { message: 'malformed request' });
      }
      return;
    }
    if (method === 'POST' && gitPath === 'git-receive-pack') {
      const body = await readBody(req);
      try {
        const out = receivePack(repo, body);
        sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
      } catch (err) {
        console.error('git-receive-pack error:', err instanceof Error ? err.stack : err);
        sendJson(res, 400, { message: 'malformed request' });
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3: /api/v3/...
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const restSegments = segments.slice(2);
    const isRoot = restSegments.length === 0 && method === 'GET';
    const isMeta = restSegments.length === 1 && restSegments[0] === 'meta' && method === 'GET';
    if (!isRoot && !isMeta) {
      const token = bearerToken(req);
      if (!token) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
    }
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON in request body' });
          return;
        }
      }
    }
    try {
      const result = handleRest({
        vault,
        method,
        segments: restSegments,
        query: url.searchParams,
        body,
        host: req.headers.host ?? 'localhost',
      });
      const extra: Record<string, string> = { ...(result.headers ?? {}) };
      if (method === 'GET' && restSegments.length === 0) extra['X-OAuth-Scopes'] = 'repo, read:org';
      sendJson(res, result.status, result.body, extra);
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { message: err.message });
      } else {
        throw err;
      }
    }
    return;
  }

  // GraphQL: POST /api/graphql
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Invalid JSON in request body' }] });
      return;
    }
    const result = handleGraphQLRequest(vault, parsed);
    sendJson(res, 200, result);
    return;
  }

  // MCP: POST /mcp
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const { status, body } = handleMcpRequest(vault, parsed, req.headers['mcp-protocol-version'] as string | undefined);
    if (status === 202) {
      res.writeHead(202, { 'X-GitHub-Request-Id': nextReqId() });
      res.end();
      return;
    }
    sendJson(res, status, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
