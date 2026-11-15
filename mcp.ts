// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP,
// speaking the modern 2026-07-28 era (`server/discover`, no session) with the legacy
// `initialize` handshake as a fallback. Tools act on the same store as REST and GraphQL.
//
// The handler is pure: app.ts reads the raw body and enforces auth, then calls
// handleMcp(rawBody) and writes the {status, body} it returns.

import {
  branchTip,
  createCommit,
  filesOfTip,
  isoOf,
  mergeBase,
  mergeable,
  nextCommentNumericId,
  nextRestId,
  nextTimestampSec,
  store,
  threeWayMerge,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { issueJson, repoJson } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpResult {
  status: number;
  /** JSON text, or '' for a notification acknowledgement. */
  body: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200, data?: unknown): McpResult {
  const error: JsonRecord = { code, message };
  if (data !== undefined) error.data = data;
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error }) };
}

function toolText(structured: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

function toolError(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// -------------------------------------------------------------------------------------------
// tools
// -------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  run: (args: JsonRecord) => unknown;
}

function required(args: JsonRecord, names: string[]): string | null {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return `Missing required argument: ${name}`;
  }
  return null;
}

function repoOf(args: JsonRecord): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || name === '') return null;
  return store.getRepo(owner, name) ?? null;
}

function fullNameOf(args: JsonRecord): string | null {
  if (typeof args.full_name === 'string' && args.full_name !== '') return args.full_name;
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  return owner !== '' && name !== '' ? `${owner}/${name}` : null;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run(args) {
      const missing = required(args, ['name']);
      if (missing !== null) return toolError(missing);
      const name = String(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return toolError(`Invalid repository name: ${name}`);
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return toolError(`Repository ${name} already exists`);
      const repo = store.createRepo(name, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolText({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch });
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
    run(args) {
      let repo = repoOf(args);
      if (repo === null && typeof args.full_name === 'string') {
        const [owner, name] = args.full_name.split('/');
        if (owner !== undefined && name !== undefined) repo = store.getRepo(owner, name) ?? null;
      }
      if (repo === null) return toolError(`Repository not found: ${fullNameOf(args) ?? ''}`);
      return toolText(repoJson(repo));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run(args) {
      const missing = required(args, ['owner', 'repo', 'title']);
      if (missing !== null) return toolError(missing);
      const repo = repoOf(args);
      if (repo === null) return toolError(`Repository not found: ${fullNameOf(args) ?? ''}`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      repo.seq += 1;
      const now = isoOf(nextTimestampSec());
      const issue: Issue = {
        id: nextRestId(),
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: repo.seq,
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(number, issue);
      return toolText(issueJson(issue, repo));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run(args) {
      const missing = required(args, ['owner', 'repo']);
      if (missing !== null) return toolError(missing);
      const repo = repoOf(args);
      if (repo === null) return toolError(`Repository not found: ${fullNameOf(args) ?? ''}`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => b.number - a.number)
        .map((i) => issueJson(i, repo));
      return toolText({ issues });
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run(args) {
      const missing = required(args, ['owner', 'repo', 'issue_number']);
      if (missing !== null) return toolError(missing);
      const repo = repoOf(args);
      if (repo === null) return toolError(`Repository not found: ${fullNameOf(args) ?? ''}`);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError(`Issue not found: #${String(args.issue_number)}`);
      return toolText(issueJson(issue, repo));
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      return toolText({ repositories: store.listViewerRepos().map(repoJson) });
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run(args) {
      const missing = required(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return toolError(missing);
      const repo = repoOf(args);
      if (repo === null) return toolError(`Repository not found: ${fullNameOf(args) ?? ''}`);
      const headRef = String(args.head).includes(':') ? String(args.head).split(':').pop()! : String(args.head);
      const baseRef = String(args.base).includes(':') ? String(args.base).split(':').pop()! : String(args.base);
      const headTip = branchTip(repo, headRef);
      const baseTip = branchTip(repo, baseRef);
      if (headTip === undefined) return toolError(`Head branch does not exist: ${headRef}`);
      if (baseTip === undefined) return toolError(`Base branch does not exist: ${baseRef}`);
      const duplicate = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
      if (duplicate !== undefined) return toolError('A pull request from this head already exists');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      repo.seq += 1;
      const now = isoOf(nextTimestampSec());
      const pull: Pull = {
        id: nextRestId(),
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolText({ number, id: pull.id, title: pull.title, body: pull.body, state: 'open', head: headRef, base: baseRef, head_ref: headRef, base_ref: baseRef, merged: false });
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run(args) {
      const missing = required(args, ['owner', 'repo', 'pull_number']);
      if (missing !== null) return toolError(missing);
      const repo = repoOf(args);
      if (repo === null) return toolError(`Repository not found: ${fullNameOf(args) ?? ''}`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError(`Pull request not found: #${String(args.pull_number)}`);
      if (pull.state !== 'open') return toolError(`Pull request is not open: #${String(args.pull_number)}`);
      const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
      const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
      const base = mergeBase(repo, headTip, baseTip);
      if (base === undefined) return toolError('No merge base: the branches share no history');
      const merged = threeWayMerge(filesOfTip(repo, base), filesOfTip(repo, headTip), filesOfTip(repo, baseTip));
      if (!merged.ok) return toolError(`Merge conflict: ${merged.conflicts.join(', ')}`);
      const now = isoOf(nextTimestampSec());
      const commitSha = createCommit(repo, { files: merged.merged!, parents: [baseTip], message: `${pull.title} (#${pull.number})` });
      repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = now;
      pull.mergeCommitSha = commitSha;
      pull.updatedAt = now;
      repo.updatedAt = now;
      return toolText({ number: pull.number, pull_number: pull.number, merged: true, state: 'closed', sha: commitSha, merge_commit_sha: commitSha });
    },
  },
];

function toolsList(): { name: string; description: string; inputSchema: JsonRecord }[] {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

// -------------------------------------------------------------------------------------------
// the endpoint
// -------------------------------------------------------------------------------------------

/** Handle one POST /mcp body (already read, auth already checked by app.ts). */
export function handleMcp(rawBody: Buffer): McpResult {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(isRecord(request) ? request.id : null, -32600, 'Invalid Request', 400);
  }
  const id = request.id;
  const isNotification = id === undefined;
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};

  // Notifications are answered with 202 and no body.
  if (isNotification) {
    return { status: 202, body: '' };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: toolsList() });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      return rpcError(id, -32601, `Unknown tool: ${name}`);
    }
    try {
      const result = tool.run(args);
      return rpcResult(id, result);
    } catch (err) {
      return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
