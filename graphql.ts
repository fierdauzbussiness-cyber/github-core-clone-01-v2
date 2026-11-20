// graphql.ts — a small GraphQL parser + executor for the subset the
// harness uses: queries, mutations, variables, inline enum lists, inline
// input objects, null variables, aliases, inline fragments, batch arrays,
// and the __type / __schema introspection the checks rely on.
// Node stdlib only. Written fresh for v2.
import {
  VIEWER, VIEWER_NUM, stampOf, gid, ungid, diffOfTrees,
  mergeConflicts, commonBase, readCommit, squashPr,
} from './store.ts';
import type { IssueRec, PullRec, Repo, Vault } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { toks.push({ kind: 'punct', value: c }); i++; continue; }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

export type Val =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Val[] }
  | { kind: 'object'; fields: { name: string; value: Val }[] };

export interface FieldSel {
  kind: 'field';
  name: string;
  alias?: string;
  args: { name: string; value: Val }[];
  selection?: Sel[];
}

export interface FragSel {
  kind: 'inlineFragment';
  typeCondition?: string;
  selection: Sel[];
}

export interface SpreadSel {
  kind: 'spread';
  name: string;
}

export type Sel = FieldSel | FragSel | SpreadSel;

export interface OpDef {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: Val }[];
  selection: Sel[];
}

export interface FragDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: Sel[];
}

export type Def = OpDef | FragDef;

class DocParser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok { return this.toks[this.pos]; }
  private take(): Tok { return this.toks[this.pos++]; }
  private wantPunct(v: string): void {
    const t = this.take();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.kind} ${t.value}`);
  }
  private wantName(): string {
    const t = this.take();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.kind} ${t.value}`);
    return t.value;
  }

  parseDoc(): Def[] {
    const defs: Def[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDef());
    return defs;
  }

  private parseDef(): Def {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', variables: [], selection: this.parseSelSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const op = this.take().value as 'query' | 'mutation';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.take().value;
      const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVarDefs() : [];
      return { kind: 'operation', operation: op, name, variables, selection: this.parseSelSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.take();
      const name = this.wantName();
      const on = this.wantName();
      if (on !== 'on') throw new Error('expected on in fragment');
      const typeCondition = this.wantName();
      return { kind: 'fragment', name, typeCondition, selection: this.parseSelSet() };
    }
    throw new Error(`unexpected definition start ${t.kind} ${t.value}`);
  }

  private parseVarDefs(): { name: string; defaultValue?: Val }[] {
    this.wantPunct('(');
    const out: { name: string; defaultValue?: Val }[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.wantPunct('$');
      const name = this.wantName();
      this.wantPunct(':');
      this.parseType();
      let defaultValue: Val | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.take();
        defaultValue = this.parseVal();
      }
      out.push({ name, defaultValue });
    }
    this.wantPunct(')');
    return out;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.take();
      this.parseType();
      this.wantPunct(']');
    } else {
      this.wantName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.take();
  }

  parseSelSet(): Sel[] {
    this.wantPunct('{');
    const out: Sel[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      out.push(this.parseSel());
    }
    this.wantPunct('}');
    return out;
  }

  private parseSel(): Sel {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.take();
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.take();
        const typeCondition = this.wantName();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelSet() };
      }
      if (n.kind === 'name') {
        return { kind: 'spread', name: this.take().value };
      }
      return { kind: 'inlineFragment', selection: this.parseSelSet() };
    }
    const first = this.wantName();
    let name = first;
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.take();
      alias = first;
      name = this.wantName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArgs() : [];
    // Directives: skip @name(args?).
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.take();
      this.wantName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArgs();
    }
    const selection = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelSet() : undefined;
    return { kind: 'field', name, alias, args, selection };
  }

  private parseArgs(): { name: string; value: Val }[] {
    this.wantPunct('(');
    const out: { name: string; value: Val }[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.wantName();
      this.wantPunct(':');
      out.push({ name, value: this.parseVal() });
    }
    this.wantPunct(')');
    return out;
  }

  parseVal(): Val {
    const t = this.take();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.wantName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: Val[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseVal());
      this.wantPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: Val }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.wantName();
        this.wantPunct(':');
        fields.push({ name, value: this.parseVal() });
      }
      this.wantPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.kind} ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Field tables (for validation + introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'private', 'url', 'createdAt',
  ],
  Ref: ['name', 'target'],
  GitObject: ['oid'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'url', 'createdAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const ENUM_SETS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'COMMIT', 'DISCUSSION', 'LABEL', 'MILESTONE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Typed {
  __type: string;
  [key: string]: unknown;
}

interface ExecCtx {
  vault: Vault;
  errors: { message: string }[];
  variables: Record<string, unknown>;
  fragments: Map<string, FragDef>;
}

function evalVal(node: Val, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': return ctx.variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evalVal(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalVal(f.value, ctx);
      return out;
    }
  }
}

function argMap(field: FieldSel, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalVal(a.value, ctx);
  return out;
}

function issueTyped(repo: Repo, issue: IssueRec): Typed {
  return {
    __type: 'Issue',
    repo,
    issue,
    id: gid('I', `${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: stampOf(issue.createdSeq),
    updatedAt: stampOf(issue.createdSeq),
  };
}

function pullTyped(repo: Repo, pr: PullRec): Typed {
  const state = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __type: 'PullRequest',
    repo,
    pr,
    id: gid('P', `${repo.owner}/${repo.name}/${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state,
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    headRefName: pr.headBranch,
    baseRefName: pr.baseBranch,
    headRefOid: repo.tipOfBranch(pr.headBranch) ?? null,
    baseRefOid: repo.tipOfBranch(pr.baseBranch) ?? null,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    createdAt: stampOf(pr.createdSeq),
  };
}

function repoTyped(repo: Repo): Typed {
  return {
    __type: 'Repository',
    repo,
    id: gid('R', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    private: repo.priv,
    url: `https://github.com/${repo.fullName}`,
    createdAt: stampOf(repo.seq),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function cursorOf(seq: number): string {
  return Buffer.from(`c:${seq}`, 'utf8').toString('base64url');
}

function seqOfCursor(cursor: string): number | null {
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!s.startsWith('c:')) return null;
    const n = Number(s.slice(2));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveOne(typeName: string, field: FieldSel, value: unknown, ctx: ExecCtx): unknown {
  const v = value as Typed;
  const args = argMap(field, ctx);
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __type: 'User', login: VIEWER, id: gid('U', VIEWER), name: VIEWER, url: `https://github.com/${VIEWER}` };
      }
      if (field.name === 'repository') {
        const repo = ctx.vault.repo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoTyped(repo) : null;
      }
      if (field.name === 'node') {
        const decoded = ungid(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const [owner, name] = decoded.parts.split('/');
          const repo = ctx.vault.repo(owner, name);
          return repo ? repoTyped(repo) : null;
        }
        if (decoded.kind === 'I') {
          const [owner, name, num] = decoded.parts.split('/');
          const repo = ctx.vault.repo(owner, name);
          const issue = repo?.issues.get(Number(num));
          return repo && issue ? issueTyped(repo, issue) : null;
        }
        if (decoded.kind === 'P') {
          const [owner, name, num] = decoded.parts.split('/');
          const repo = ctx.vault.repo(owner, name);
          const pr = repo?.pulls.get(Number(num));
          return repo && pr ? pullTyped(repo, pr) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name]) {
          return { __type: '__Type', name, kind: 'OBJECT', fields: TYPE_FIELDS[name], enumValues: [] };
        }
        if (ENUM_SETS[name]) {
          return { __type: '__Type', name, kind: 'ENUM', fields: [], enumValues: ENUM_SETS[name] };
        }
        return null;
      }
      return undefined;
    }
    case 'Repository': {
      const repo = v.repo as Repo;
      if (field.name === 'owner') {
        return { __type: 'User', login: repo.owner, id: gid('U', repo.owner), name: repo.owner, url: `https://github.com/${repo.owner}` };
      }
      if (field.name === 'defaultBranchRef') {
        const tip = repo.head();
        if (!tip) return null;
        return { __type: 'Ref', name: repo.defaultBranch, target: { __type: 'GitObject', oid: tip } };
      }
      if (field.name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueTyped(repo, issue) : null;
      }
      if (field.name === 'issues') {
        const states = (args.states as string[] | undefined) ?? null;
        const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
        const first = Number(args.first ?? 30);
        const after = args.after as string | undefined;
        let list = [...repo.issues.values()];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const dir = String(orderBy.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        if (after) {
          const afterSeq = seqOfCursor(after);
          if (afterSeq !== null) list = list.filter((i) => (dir === 'ASC' ? i.seq > afterSeq : i.seq < afterSeq));
        }
        const page = list.slice(0, first);
        const hasNextPage = list.length > first;
        const endCursor = page.length ? cursorOf(page[page.length - 1].seq) : null;
        return {
          __type: 'IssueConnection',
          nodes: page.map((i) => issueTyped(repo, i)),
          pageInfo: { __type: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length ? cursorOf(page[0].seq) : null },
          totalCount: list.length,
        };
      }
      if (field.name === 'pullRequests') {
        const first = Number(args.first ?? 30);
        const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq).slice(0, first);
        return {
          __type: 'PullRequestConnection',
          nodes: list.map((p) => pullTyped(repo, p)),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
          totalCount: repo.pulls.size,
        };
      }
      if (field.name === 'pullRequest') {
        const pr = repo.pulls.get(Number(args.number));
        return pr ? pullTyped(repo, pr) : null;
      }
      return (v as Record<string, unknown>)[field.name];
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      return (v as Record<string, unknown>)[field.name];
    }
    case 'PageInfo': {
      return (v as Record<string, unknown>)[field.name];
    }
    case 'PullRequest': {
      const repo = v.repo as Repo;
      const pr = v.pr as PullRec;
      if (field.name === 'mergeable') {
        if (pr.merged || pr.state !== 'open') return 'UNKNOWN';
        const baseTip = repo.tipOfBranch(pr.baseBranch);
        const headTip = repo.tipOfBranch(pr.headBranch);
        if (!baseTip || !headTip) return 'UNKNOWN';
        return mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field.name === 'files') {
        const first = Number(args.first ?? 30);
        const headTip = repo.tipOfBranch(pr.headBranch);
        const baseTip = repo.tipOfBranch(pr.baseBranch);
        let files: { path: string }[] = [];
        if (headTip && baseTip) {
          const mb = commonBase(repo, baseTip, headTip);
          const mbTree = mb ? readCommit(repo.object(mb)!.buf).tree : null;
          const headTree = readCommit(repo.object(headTip)!.buf).tree;
          files = diffOfTrees(repo, mbTree, headTree).map((d) => ({ path: d.filename, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() }));
        }
        const nodes = files.slice(0, first).map((f) => ({ __type: 'PullRequestChangedFile', ...f }));
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes,
          pageInfo: { __type: 'PageInfo', hasNextPage: files.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
        };
      }
      return (v as Record<string, unknown>)[field.name];
    }
    case 'PullRequestChangedFile': {
      return (v as Record<string, unknown>)[field.name];
    }
    case '__Type': {
      if (field.name === 'fields') {
        return ((v.fields as string[]) ?? []).map((n) => ({ __type: '__Field', name: n, description: null, type: null }));
      }
      if (field.name === 'enumValues') {
        return ((v.enumValues as string[]) ?? []).map((n) => ({ __type: '__EnumValue', name: n, description: null, type: null }));
      }
      return (v as Record<string, unknown>)[field.name];
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
        const decoded = ungid(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'R') throw new Error('repository not found');
        const [owner, name] = decoded.parts.split('/');
        const repo = ctx.vault.repo(owner, name);
        if (!repo) throw new Error('repository not found');
        const n = ++repo.issueSeq;
        const seq = ctx.vault.nextOrder();
        const issue: IssueRec = {
          id: ctx.vault.nextGlobal(), number: n, title: String(input.title ?? ''),
          body: String(input.body ?? ''), state: 'open', labels: [],
          seq, createdSeq: seq,
        };
        repo.issues.set(n, issue);
        return { __type: 'CreateIssuePayload', issue: issueTyped(repo, issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as { issueId?: string };
        const decoded = ungid(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'I') throw new Error('issue not found');
        const [owner, name, num] = decoded.parts.split('/');
        const repo = ctx.vault.repo(owner, name);
        const issue = repo?.issues.get(Number(num));
        if (!repo || !issue) throw new Error('issue not found');
        issue.state = 'closed';
        issue.wire = undefined;
        return { __type: 'CloseIssuePayload', issue: issueTyped(repo, issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
        const decoded = ungid(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'R') throw new Error('repository not found');
        const [owner, name] = decoded.parts.split('/');
        const repo = ctx.vault.repo(owner, name);
        if (!repo) throw new Error('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!repo.tipOfBranch(head) || !repo.tipOfBranch(base)) throw new Error('branch not found');
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headBranch === head && p.baseBranch === base) {
            throw new Error('A pull request already exists for this head and base');
          }
        }
        const n = ++repo.issueSeq;
        const seq = ctx.vault.nextOrder();
        const pr: PullRec = {
          id: ctx.vault.nextGlobal(), number: n, title: String(input.title ?? ''),
          body: String(input.body ?? ''), state: 'open', merged: false, mergedAt: null,
          mergeSha: null, headBranch: head, baseBranch: base,
          seq, createdSeq: seq,
        };
        repo.pulls.set(n, pr);
        return { __type: 'CreatePullRequestPayload', pullRequest: pullTyped(repo, pr) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as { pullRequestId?: string; mergeMethod?: string };
        const decoded = ungid(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'P') throw new Error('pull request not found');
        const [owner, name, num] = decoded.parts.split('/');
        const repo = ctx.vault.repo(owner, name);
        const pr = repo?.pulls.get(Number(num));
        if (!repo || !pr) throw new Error('pull request not found');
        if (pr.state !== 'open' || pr.merged) throw new Error('pull request is not open');
        const baseTip = repo.tipOfBranch(pr.baseBranch);
        const headTip = repo.tipOfBranch(pr.headBranch);
        if (!baseTip || !headTip) throw new Error('branch not found');
        if (mergeConflicts(repo, baseTip, headTip)) throw new Error('merge conflict');
        const sha = squashPr(repo, pr);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = stampOf(ctx.vault.nextOrder());
        pr.mergeSha = sha;
        return { __type: 'MergePullRequestPayload', pullRequest: pullTyped(repo, pr) };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as { subjectId?: string; body?: string };
        const decoded = ungid(String(input.subjectId ?? ''));
        if (!decoded || (decoded.kind !== 'I' && decoded.kind !== 'P')) throw new Error('subject not found');
        const [owner, name, num] = decoded.parts.split('/');
        const repo = ctx.vault.repo(owner, name);
        if (!repo) throw new Error('subject not found');
        const number = Number(num);
        const commentId = ctx.vault.nextGlobal();
        const list = repo.comments.get(number) ?? [];
        list.push({ id: commentId, body: String(input.body ?? ''), seq: ctx.vault.nextOrder() });
        repo.comments.set(number, list);
        return {
          __type: 'AddCommentPayload',
          commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', id: gid('C', `${owner}/${name}/${number}/${commentId}`), body: String(input.body ?? '') } },
        };
      }
      return undefined;
    }
    default: {
      return (v as Record<string, unknown>)[field.name];
    }
  }
}

function runSelection(
  selections: Sel[],
  typeName: string,
  value: unknown,
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      const inner = runSelection(sel.selection, sel.typeCondition ?? typeName, value, ctx);
      Object.assign(out, inner);
      continue;
    }
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      const inner = runSelection(frag.selection, frag.typeCondition, value, ctx);
      Object.assign(out, inner);
      continue;
    }
    const field = sel;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const known = TYPE_FIELDS[typeName] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    let fieldValue: unknown;
    try {
      fieldValue = resolveOne(typeName, field, value, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (fieldValue === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (field.selection && fieldValue !== null && typeof fieldValue === 'object') {
      const childType = (fieldValue as Typed).__type;
      if (childType) {
        out[responseKey] = runSelection(field.selection, childType, fieldValue, ctx);
      } else if (Array.isArray(fieldValue)) {
        // Lists of typed values (e.g. __Type.fields): element type is
        // inferred from the first element.
        out[responseKey] = fieldValue.map((el) => {
          if (el !== null && typeof el === 'object' && (el as Typed).__type) {
            return runSelection(field.selection!, (el as Typed).__type, el, ctx);
          }
          return el;
        });
      } else {
        out[responseKey] = fieldValue;
      }
    } else {
      out[responseKey] = fieldValue;
    }
  }
  return out;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(vault: Vault, query: string, variables: Record<string, unknown> | null, operationName?: string | null): GraphQLResult {
  let defs: Def[];
  try {
    defs = new DocParser(lex(query)).parseDoc();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragDef>();
  const operations = defs.filter((d): d is OpDef => d.kind === 'operation');
  for (const d of defs) if (d.kind === 'fragment') fragments.set(d.name, d);
  const op = operationName
    ? operations.find((o) => o.name === operationName) ?? operations[0]
    : operations[0];
  if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
  const ctx: ExecCtx = { vault, errors: [], variables: { ...(variables ?? {}) }, fragments };
  for (const v of op.variables) {
    if (!(v.name in ctx.variables) && v.defaultValue) {
      ctx.variables[v.name] = evalVal(v.defaultValue, ctx);
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = runSelection(op.selection, rootType, {}, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

// Handle one request body (single document or a batch array). Returns the
// JSON-serialisable response body.
export function handleGraphQLRequest(vault: Vault, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => {
      const q = item as { query?: string; variables?: Record<string, unknown> | null; operationName?: string | null };
      return executeGraphQL(vault, String(q.query ?? ''), q.variables ?? null, q.operationName ?? null);
    });
  }
  const q = body as { query?: string; variables?: Record<string, unknown> | null; operationName?: string | null };
  return executeGraphQL(vault, String(q.query ?? ''), q.variables ?? null, q.operationName ?? null);
}
