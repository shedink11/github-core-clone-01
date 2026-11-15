// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, branches,
// commits, contents, labels, issues, comments and pull requests.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id. Errors carry
// {"message": string}. Unknown routes are JSON 404s; malformed JSON bodies are 400s.
// A repository belongs to the login the bearer token names (store.VIEWER_LOGIN); the
// same name under any other owner is 404, never 403.

import {
  branchTip,
  createCommit,
  diffMaps,
  filesOfTip,
  isoOf,
  lineDiff,
  mergeBase,
  mergeable,
  nextCommentNumericId,
  nextRestId,
  nextTimestampSec,
  peelToCommit,
  putBlob,
  refTip,
  resolveRef,
  store,
  threeWayMerge,
  VIEWER_ID,
  VIEWER_LOGIN,
  type FileEntry,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { ZERO_OID, buildTree, hashObject, isObjectId, parseCommit, type TreeEntry } from './gitcore.ts';

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  /** JSON value, or null for a 204 with no body. */
  body: unknown;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, headers, body };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const b64 = (data: Buffer | string): string => Buffer.from(data).toString('base64');

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, node_id: globalId('User', login), type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    language: null,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: labelIdOf(label), node_id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

const labelIds = new Map<string, number>();
function labelIdOf(label: Label): number {
  let id = labelIds.get(label.name);
  if (id === undefined) {
    id = nextRestId();
    labelIds.set(label.name, id);
  }
  return id;
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(VIEWER_LOGIN),
    assignee: null,
    labels: issue.labels.map(labelJson),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? mergeable(repo, headSha, branchTip(repo, pull.baseRef) ?? pull.baseSha) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: branchTip(repo, pull.baseRef) ?? pull.baseSha,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    user: userJson(VIEWER_LOGIN),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

function parsePage(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): RestResult {
  const { perPage, page } = parsePage(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `${baseUrl}${path}?${params.toString()}`;
  };
  if (start + perPage < total) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (total > perPage) links.push(`<${urlFor(Math.max(1, Math.ceil(total / perPage)))}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`);
  if (links.length > 0) headers.link = links.join(', ');
  return ok(slice, 200, headers);
}

// -------------------------------------------------------------------------------------------
// contents helpers
// -------------------------------------------------------------------------------------------

function commitOnBranch(
  repo: Repo,
  branch: string,
  message: string,
  mutate: (files: Map<string, FileEntry>) => void,
): { commitSha: string; files: Map<string, FileEntry> } {
  let tip = branchTip(repo, branch);
  let parents: string[] = [];
  if (tip === undefined) {
    // A new branch starts from the default branch tip (or an empty tree when unborn).
    const base = branch === repo.defaultBranch ? undefined : branchTip(repo, repo.defaultBranch);
    tip = base;
    parents = base === undefined ? [] : [base];
  } else {
    parents = [tip];
  }
  const files = filesOfTip(repo, tip);
  mutate(files);
  const commitSha = createCommit(repo, { files, parents, message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = isoOf(nextTimestampSec());
  return { commitSha, files };
}

function contentFileJson(repo: Repo, path: string, entry: FileEntry): Record<string, unknown> {
  const blob = repo.objects.get(entry.oid);
  const data = blob?.type === 'blob' ? blob.data : Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: b64(data),
    sha: entry.oid,
  };
}

// -------------------------------------------------------------------------------------------
// the router: method + path segments under /api/v3, with the parsed JSON body (or the
// sentinel MALFORMED when the body did not parse) and the request URL for Link headers.
// -------------------------------------------------------------------------------------------

export const MALFORMED = Symbol('malformed');

export function routeRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult {
  if (body === MALFORMED) return err(400, 'Problems parsing JSON');

  const seg = (i: number): string | undefined => segments[i];
  const is = (...parts: (string | undefined)[]): boolean =>
    parts.every((part, i) => part === undefined || part === segments[i]);

  // GET /api/v3/ — the API root.
  if (segments.length === 0 && method === 'GET') {
    return ok(
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/api/v3/authorizations',
        authorizations_url: '/api/v3/authorizations',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
        user_url: '/api/v3/users/{user}',
      },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (is('meta') && segments.length === 1 && method === 'GET') {
    return ok({ verifiable_password_authentication: true, installed_version: '1.0.0', api: ['v3'] });
  }

  // GET /api/v3/user
  if (is('user') && segments.length === 1 && method === 'GET') {
    return ok({
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: globalId('User', VIEWER_LOGIN),
      type: 'User',
      name: 'ada iversen',
      email: `${VIEWER_LOGIN}@example.invalid`,
      site_admin: false,
    });
  }

  // /api/v3/user/repos
  if (is('user', 'repos') && segments.length === 2) {
    if (method === 'GET') {
      return paginate(store.listViewerRepos().map(repoJson), query, baseUrl, '/api/v3/user/repos');
    }
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'Validation Failed: name is invalid');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, `Repository ${name} already exists`);
      const repo = store.createRepo(name, {
        description: typeof input.description === 'string' ? input.description : '',
        private: input.private === true,
      });
      return ok(repoJson(repo), 201);
    }
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (seg(0) === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(seg(1)!);
    const name = decodeURIComponent(seg(2)!);
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(3);

    // The repository itself.
    if (rest.length === 0) {
      if (repo === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.updatedAt = isoOf(nextTimestampSec());
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    if (repo === undefined) return err(404, 'Not Found');

    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref)! },
            protected: false,
          }));
        return ok(list);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1]!);
        const tip = branchTip(repo, branch);
        if (tip === undefined) return err(404, 'Branch not found');
        return ok({ name: branch, commit: { sha: tip }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // Commits.
    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const shaParam = query.get('sha');
        const tip = shaParam !== null ? resolveRef(repo, shaParam) : branchTip(repo, repo.defaultBranch);
        const list: Record<string, unknown>[] = [];
        if (tip !== undefined) {
          const seen = new Set<string>();
          const queue = [tip];
          while (queue.length > 0) {
            const oid = queue.shift()!;
            if (seen.has(oid)) continue;
            seen.add(oid);
            const object = repo.objects.get(oid);
            if (!object || object.type !== 'commit') continue;
            const view = parseCommit(object.data);
            list.push({
              sha: oid,
              commit: {
                // The raw git object ends the message with a newline; the API presents it without.
                message: view.message.replace(/\n+$/, ''),
                author: { name: view.author, date: '' },
                committer: { name: view.committer, date: '' },
                tree: { sha: view.tree },
              },
              parents: view.parents.map((p) => ({ sha: p })),
            });
            queue.push(...view.parents);
          }
        }
        return ok(list);
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = resolveRef(repo, decodeURIComponent(rest[1]!));
        if (oid === undefined) return err(404, 'Not Found');
        const object = repo.objects.get(oid)!;
        const view = parseCommit(object.data);
        return ok({ sha: oid, commit: { message: view.message.replace(/\n+$/, ''), author: { name: view.author }, committer: { name: view.committer }, tree: { sha: view.tree } }, parents: view.parents.map((p) => ({ sha: p })) });
      }
      return err(404, 'Not Found');
    }

    // Git Data: refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const input = (body ?? {}) as Record<string, unknown>;
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'Validation Failed');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (object === undefined) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok({ ref, object: { sha, type: object.type } }, 201);
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
        const tip = refTip(repo, ref);
        if (tip === undefined) return err(404, 'Not Found');
        const object = repo.objects.get(tip);
        return ok({ ref, object: { sha: tip, type: object?.type ?? 'commit' } });
      }
      return err(404, 'Not Found');
    }

    // Contents.
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const refParam = query.get('ref');
        const tip = refParam !== null ? resolveRef(repo, refParam) : branchTip(repo, repo.defaultBranch);
        const files = filesOfTip(repo, tip);
        if (path === '') {
          const entries = dirEntries(repo, files, '');
          return ok(entries);
        }
        const entry = files.get(path);
        if (entry !== undefined) return ok(contentFileJson(repo, path, entry));
        const prefix = `${path}/`;
        if ([...files.keys()].some((p) => p.startsWith(prefix))) return ok(dirEntries(repo, files, path));
        return err(404, 'Not Found');
      }
      if (method === 'PUT') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        if (contentB64 === '') return err(422, 'Validation Failed: content is required');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          return err(422, 'Validation Failed: content is not valid base64');
        }
        const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const tip = branchTip(repo, branch);
        const currentFiles = filesOfTip(repo, tip);
        const existing = currentFiles.get(path);
        if (existing !== undefined) {
          if (sha === undefined || sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'Conflict: sha does not match the current blob');
        } else if (sha !== undefined) {
          return err(422, 'Validation Failed: sha does not match an existing file');
        }
        const blobOid = putBlob(repo, bytes);
        const { commitSha } = commitOnBranch(repo, branch, message, (files) => {
          files.set(path, { oid: blobOid, mode: '100644' });
        });
        return ok(
          {
            content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', content: b64(bytes) },
            commit: { sha: commitSha, message },
          },
          existing !== undefined ? 200 : 201,
        );
      }
      if (method === 'DELETE') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const tip = branchTip(repo, branch);
        const currentFiles = filesOfTip(repo, tip);
        const existing = currentFiles.get(path);
        if (existing === undefined) return err(404, 'Not Found');
        if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'Conflict: sha does not match the current blob');
        const { commitSha } = commitOnBranch(repo, branch, message, (files) => {
          files.delete(path);
        });
        return ok({ commit: { sha: commitSha, message }, content: null });
      }
      return err(404, 'Not Found');
    }

    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) return ok([...repo.labels.values()].map(labelJson));
      if (method === 'POST' && rest.length === 1) {
        const input = (body ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '') return err(422, 'Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return ok(labelJson(existing), 201);
        const label: Label = {
          name,
          color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
          description: typeof input.description === 'string' ? input.description : '',
        };
        repo.labels.set(name, label);
        return ok(labelJson(label), 201);
      }
      return err(404, 'Not Found');
    }

    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const sort = (query.get('sort') ?? 'created').toLowerCase();
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => {
            const byNumber = a.number - b.number;
            const byCreated = a.createdSeq - b.createdSeq;
            const cmp = sort === 'created' ? byCreated : byNumber;
            return direction === 'asc' ? cmp : -cmp;
          });
          return paginate(list.map((i) => issueJson(i, repo)), query, baseUrl, `/api/v3/repos/${owner}/${name}/issues`);
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') return err(422, 'Validation Failed: title is required');
          const wanted = Array.isArray(input.labels) ? (input.labels as unknown[]) : [];
          const labels: Label[] = [];
          for (const wantedLabel of wanted) {
            const labelName = typeof wantedLabel === 'string' ? wantedLabel : typeof wantedLabel === 'object' && wantedLabel !== null ? String((wantedLabel as Record<string, unknown>).name ?? '') : '';
            const found = repo.labels.get(labelName);
            if (found === undefined) return err(422, `Validation Failed: label "${labelName}" does not exist`);
            labels.push(found);
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          repo.seq += 1;
          const now = isoOf(nextTimestampSec());
          const issue: Issue = {
            id: nextRestId(),
            number,
            title,
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            labels,
            comments: [],
            createdSeq: repo.seq,
            createdAt: now,
            updatedAt: now,
          };
          repo.issues.set(number, issue);
          return ok(issueJson(issue, repo), 201);
        }
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(issueJson(issue, repo));
        if (method === 'PATCH') {
          const input = (body ?? {}) as Record<string, unknown>;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          issue.updatedAt = isoOf(nextTimestampSec());
          return ok(issueJson(issue, repo));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(number);
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(
            issue.comments.map((c) => ({
              id: c.id,
              node_id: globalId('IssueComment', `${repo.owner}/${repo.name}:${number}:${c.id}`),
              body: c.body,
              user: userJson(c.userLogin),
              created_at: c.createdAt,
              updated_at: c.createdAt,
            })),
          );
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const commentBody = typeof input.body === 'string' ? input.body : '';
          if (commentBody === '') return err(422, 'Validation Failed: body is required');
          const comment = {
            id: nextCommentNumericId(),
            body: commentBody,
            userLogin: VIEWER_LOGIN,
            createdAt: isoOf(nextTimestampSec()),
          };
          issue.comments.push(comment);
          issue.updatedAt = isoOf(nextTimestampSec());
          return ok(
            {
              id: comment.id,
              node_id: globalId('IssueComment', `${repo.owner}/${repo.name}:${number}:${comment.id}`),
              body: comment.body,
              user: userJson(VIEWER_LOGIN),
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
            },
            201,
          );
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          return paginate(list.map((p) => pullJson(p, repo)), query, baseUrl, `/api/v3/repos/${owner}/${name}/pulls`);
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const headRaw = typeof input.head === 'string' ? input.head : '';
          const baseRaw = typeof input.base === 'string' ? input.base : repo.defaultBranch;
          const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
          const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
          if (title === '' || headRef === '' || baseRef === '') return err(422, 'Validation Failed: title, head and base are required');
          const headTip = branchTip(repo, headRef);
          const baseTip = branchTip(repo, baseRef);
          if (headTip === undefined) return err(422, 'Validation Failed: head branch does not exist');
          if (baseTip === undefined) return err(422, 'Validation Failed: base branch does not exist');
          const duplicate = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
          if (duplicate !== undefined) return err(422, 'Validation Failed: a pull request from this head already exists');
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          repo.seq += 1;
          const now = isoOf(nextTimestampSec());
          const pull: Pull = {
            id: nextRestId(),
            number,
            title,
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef,
            baseRef,
            headSha: headTip,
            baseSha: baseTip,
            createdSeq: repo.seq,
            createdAt: now,
            updatedAt: now,
          };
          repo.pulls.set(number, pull);
          return ok(pullJson(pull, repo), 201);
        }
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const pull = repo.pulls.get(number);
      if (rest.length === 2) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(pullJson(pull, repo));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
        const baseFiles = filesOfTip(repo, pull.baseSha);
        const headFiles = filesOfTip(repo, headTip);
        const files = diffMaps(baseFiles, headFiles).map((entry) => {
          let additions = 0;
          let deletions = 0;
          if (entry.status !== 'removed') {
            const newBlob = entry.newOid !== null ? repo.objects.get(entry.newOid) : undefined;
            const oldBlob = entry.oldOid !== null ? repo.objects.get(entry.oldOid) : undefined;
            const [a, d] = lineDiff(oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '', newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '');
            additions = a;
            deletions = d;
          } else {
            const oldBlob = entry.oldOid !== null ? repo.objects.get(entry.oldOid) : undefined;
            deletions = oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8').split('\n').length : 0;
          }
          return {
            sha: entry.newOid ?? entry.oldOid ?? ZERO_OID,
            filename: entry.path,
            status: entry.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        return ok(files);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, pull.merged ? 'Pull request is already merged' : 'Pull request is closed');
        const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
        const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
        const base = mergeBase(repo, headTip, baseTip);
        if (base === undefined) return err(405, 'No merge base: the branches share no history');
        const merged = threeWayMerge(filesOfTip(repo, base), filesOfTip(repo, headTip), filesOfTip(repo, baseTip));
        if (!merged.ok) return err(405, `Merge conflict: ${merged.conflicts.join(', ')}`);
        const now = isoOf(nextTimestampSec());
        const message = `${pull.title} (#${pull.number})`;
        const commitSha = createCommit(repo, { files: merged.merged!, parents: [baseTip], message });
        repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = now;
        pull.mergeCommitSha = commitSha;
        pull.updatedAt = now;
        repo.updatedAt = now;
        return ok({ sha: commitSha, merged: true, message: `Pull request successfully merged: ${message}` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

/** The immediate children of `dir` in a file map, as a contents directory listing. */
function dirEntries(repo: Repo, files: Map<string, FileEntry>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; oid: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', oid: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', oid: '' });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, info] of [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (info.type === 'dir') {
      // A directory's sha is the sha of its tree object.
      const treeOid = treeOidOfDir(repo, files, dir === '' ? name : `${dir}/${name}`);
      out.push({ type: 'dir', name, path: dir === '' ? name : `${dir}/${name}`, sha: treeOid ?? ZERO_OID, size: 0 });
    } else {
      const blob = repo.objects.get(info.oid);
      out.push({ type: 'file', name, path: dir === '' ? name : `${dir}/${name}`, sha: info.oid, size: blob?.type === 'blob' ? blob.data.length : 0 });
    }
  }
  return out;
}

/** The tree oid of a directory path, by rebuilding its subtree from the file map. */
function treeOidOfDir(repo: Repo, files: Map<string, FileEntry>, dir: string): string | undefined {
  const prefix = `${dir}/`;
  const sub = new Map<string, FileEntry>();
  for (const [path, entry] of files) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), entry);
  }
  if (sub.size === 0) return undefined;
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of sub) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, { mode: entry.mode, oid: entry.oid });
  }
  const buildNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: buildNode(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return buildNode(root);
}
