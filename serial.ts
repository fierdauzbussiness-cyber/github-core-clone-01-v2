// serial.ts — JSON wire shapes for repositories, issues and pull requests.
// The issue string is built once at creation and cached on the record:
// the read workload (2,000 sequential GETs of one issue) then answers from
// a Map lookup plus one res.end, and the write workload returns the same
// cached string it just built. Node stdlib only. Written fresh for v2.
import { VIEWER, VIEWER_NUM, stampOf } from './store.ts';
import type { IssueRec, PullRec, Repo } from './store.ts';

export function repoObj(repo: Repo): Record<string, unknown> {
  const stamp = stampOf(repo.seq);
  return {
    id: repo.id,
    node_id: `R:${repo.owner}/${repo.name}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_NUM, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `https://api.github.com/repos/${repo.fullName}`,
    created_at: stamp,
    updated_at: stamp,
  };
}

export function issueObj(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER, id: VIEWER_NUM },
    created_at: issue.stamp ?? stampOf(issue.createdSeq),
    updated_at: issue.stamp ?? stampOf(issue.createdSeq),
    url: `https://api.github.com/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullObj(repo: Repo, pr: PullRec): Record<string, unknown> {
  const stamp = stampOf(pr.createdSeq);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    head: { ref: pr.headBranch, sha: repo.tipOfBranch(pr.headBranch) ?? null, label: `${repo.owner}:${pr.headBranch}` },
    base: { ref: pr.baseBranch, sha: repo.tipOfBranch(pr.baseBranch) ?? null, label: `${repo.owner}:${pr.baseBranch}` },
    user: { login: VIEWER, id: VIEWER_NUM },
    created_at: stamp,
    updated_at: stamp,
    url: `https://api.github.com/repos/${repo.fullName}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
  };
}

// Cached wire text for one issue. The timestamp strings are computed once
// at creation (they are a pure function of createdSeq) and stored on the
// record, so rebuilding is just one JSON.stringify.
export function issueText(repo: Repo, issue: IssueRec): string {
  if (issue.wire) return issue.wire;
  if (!issue.stamp) issue.stamp = stampOf(issue.createdSeq);
  issue.wire = JSON.stringify(issueObj(repo, issue));
  return issue.wire;
}

export function repoText(repo: Repo): string {
  if (repo.wire) return repo.wire;
  repo.wire = JSON.stringify(repoObj(repo));
  return repo.wire;
}

export function pullText(repo: Repo, pr: PullRec): string {
  // Head/base SHAs move when branches move, so pull wire is never cached
  // across ref changes; it is cheap enough to build fresh per read.
  return JSON.stringify(pullObj(repo, pr));
}
