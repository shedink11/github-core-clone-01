// graphql.ts — the GitHub GraphQL v4 surface at /api/graphql: a small, dependency-free
// GraphQL executor for the fixed documents the suite sends (queries, mutations, batched
// operations, introspection probes). It shares the store with REST, so a mutation made
// here reads back over REST and vice versa.
//
// Semantics that matter to the suite:
//  - unauthenticated POSTs are 401 (enforced by app.ts before this runs);
//  - unknown repository -> data.repository = null with no errors;
//  - unknown field -> HTTP 200 with an errors array naming the field;
//  - global ids are opaque base64url tokens, never the plain database id or number;
//  - Issue/PullRequest state is OPEN/CLOSED (MERGED for a merged pull request).

import {
  branchTip,
  createCommit,
  diffMaps,
  filesOfTip,
  mergeBase,
  mergeable,
  nextCommentNumericId,
  nextRestId,
  nextTimestampSec,
  isoOf,
  store,
  threeWayMerge,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { globalId } from './rest.ts';

// -------------------------------------------------------------------------------------------
// schema tables for the introspection probes
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt',
    'labels', 'comments', 'url', 'resourcePath', 'databaseId', 'locked', 'viewerCanUpdate',
    'assignees', 'milestone', 'reactions', 'timelineItems',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt',
    'url', 'databaseId', 'additions', 'deletions', 'changedFiles', 'draft', 'reviewDecision',
    'commits', 'reviews', 'labels', 'assignees',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt',
    'description', 'isPrivate', 'url', 'homepageUrl', 'defaultBranch', 'forkCount', 'stargazerCount',
    'watchers', 'languages', 'licenseInfo', 'primaryLanguage',
  ],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'avatarUrl', 'createdAt'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'databaseId'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Organization: ['id', 'login', 'name', 'databaseId', 'url'],
  Label: ['id', 'name', 'color', 'description', 'databaseId'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: [
    'ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'LABEL', 'MILESTONE',
    'ORGANIZATION', 'PROJECT', 'TEAM', 'WIKI',
  ],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// tokenizer + parser (the subset of GraphQL the suite's documents use)
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j]!;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(ch) || ch === '{' || ch === '}') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: { name: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

interface FragmentDefNode {
  kind: 'fragmentDef';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentDefNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? 'a name'} in GraphQL document`);
    }
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.pos < this.tokens.length) {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() };
    }
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      const next = this.peek();
      if (next !== undefined && next.kind === 'name') name = this.next().value;
      const variableDefinitions = this.isPunct('(') ? this.parseVariableDefinitions() : [];
      return { kind: 'operation', operation, name, variableDefinitions, selections: this.parseSelectionSet() };
    }
    if (token !== undefined && token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragmentDef', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error('unexpected definition in GraphQL document');
  }

  private parseVariableDefinitions(): { name: string; defaultValue: ValueNode | null }[] {
    this.expectPunct('(');
    const defs: { name: string; defaultValue: ValueNode | null }[] = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue(true);
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token !== undefined && token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token !== undefined && token.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selections };
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('variable in constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// -------------------------------------------------------------------------------------------
// values handed to the executor
// -------------------------------------------------------------------------------------------

type GqlObject = Record<string, unknown> & { __typename: string };

function evaluate(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evaluate(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluate(field.value, variables);
      return out;
    }
  }
}

function argMap(args: { name: string; value: ValueNode }[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evaluate(arg.value, variables);
  return out;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

function pageInfoFor(page: number[], hasMore: boolean): GqlObject {
  return {
    __typename: 'PageInfo',
    hasNextPage: hasMore,
    hasPreviousPage: false,
    startCursor: page.length > 0 ? encodeCursor(page[0]!) : null,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
  };
}

// -------------------------------------------------------------------------------------------
// object builders (plain records with a __typename, resolved by resolveField below)
// -------------------------------------------------------------------------------------------

function viewerObject(): GqlObject {
  return { __typename: 'Viewer', login: VIEWER_LOGIN };
}

function userObject(login: string): GqlObject {
  return { __typename: 'User', login, id: login === VIEWER_LOGIN ? globalId('User', login) : null, databaseId: login === VIEWER_LOGIN ? 1000 : null, name: login === VIEWER_LOGIN ? 'ada iversen' : null };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', _repo: repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentObject(repo: Repo, issueNumber: number, comment: { id: number; body: string }): GqlObject {
  return { __typename: 'IssueComment', _repo: repo, _issueNumber: issueNumber, _comment: comment };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    issues = issues.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const after = decodeCursor(args.after);
  if (after !== null) {
    issues = issues.filter((i) => (direction === 'DESC' ? i.number < after : i.number > after));
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasMore = issues.length > page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueObject(repo, i)),
    totalCount: issues.length,
    pageInfo: pageInfoFor(page.map((i) => i.number), hasMore),
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let pulls = [...repo.pulls.values()].filter((p) => p.state === 'open');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    pulls = [...repo.pulls.values()].filter((p) => wanted.has(p.state.toUpperCase() === 'OPEN' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED'));
  }
  pulls.sort((a, b) => b.number - a.number);
  const after = decodeCursor(args.after);
  if (after !== null) pulls = pulls.filter((p) => p.number < after);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  const hasMore = pulls.length > page.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullObject(repo, p)),
    totalCount: pulls.length,
    pageInfo: pageInfoFor(page.map((p) => p.number), hasMore),
  };
}

// -------------------------------------------------------------------------------------------
// field resolution
// -------------------------------------------------------------------------------------------

class FieldProblem extends Error {}

function decodeGlobalId(id: unknown): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoFromGlobalId(id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const slash = decoded.key.indexOf('/');
  if (slash === -1) return null;
  return store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) ?? null;
}

function issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
  if (match === null) return null;
  const repo = store.getRepo(match[1]!, match[2]!);
  if (repo === undefined) return null;
  const issue = repo.issues.get(parseInt(match[3]!, 10));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
  if (match === null) return null;
  const repo = store.getRepo(match[1]!, match[2]!);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(parseInt(match[3]!, 10));
  return pull === undefined ? null : { repo, pull };
}

function prState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(obj: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
  const type = obj.__typename;
  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return viewerObject();
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoObject(repo);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoFromGlobalId(args.id);
          return repo === null ? null : repoObject(repo);
        }
        if (decoded.kind === 'Issue') {
          const found = issueFromGlobalId(args.id);
          return found === null ? null : issueObject(found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = pullFromGlobalId(args.id);
          return found === null ? null : pullObject(found.repo, found.pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        const fields = TYPE_FIELDS[name];
        if (fields === undefined && ENUM_VALUES[name] === undefined) return null;
        return {
          __typename: '__Type',
          name,
          kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT',
          _fields: fields ?? [],
          _enumValues: ENUM_VALUES[name] ?? [],
        };
      }
      if (field.name === '__schema') {
        return {
          __typename: '__Schema',
          queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', _fields: ['viewer', 'repository', 'node'], _enumValues: [] },
          mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', _fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], _enumValues: [] },
          types: Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', name, kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT', _fields: TYPE_FIELDS[name] ?? [], _enumValues: ENUM_VALUES[name] ?? [] })),
        };
      }
      throw new FieldProblem(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(args);
      if (field.name === 'closeIssue') return mutateCloseIssue(args);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(args);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(args);
      if (field.name === 'addComment') return mutateAddComment(args);
      throw new FieldProblem(`Cannot query field "${field.name}" on type "Mutation".`);
    }
    case 'Viewer': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return globalId('User', VIEWER_LOGIN);
      if (field.name === 'databaseId') return 1000;
      if (field.name === 'name') return 'ada iversen';
      throw new FieldProblem(`Cannot query field "${field.name}" on type "Viewer".`);
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return obj.id;
      if (field.name === 'databaseId') return obj.databaseId;
      if (field.name === 'name') return obj.name;
      if (field.name === 'email') return null;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Repository': {
      const repo = obj._repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', `${repo.owner}/${repo.name}`);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userObject(repo.owner);
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObject(repo, issue);
        }
        case 'issues':
          return issueConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObject(repo, pull);
        }
        case 'pullRequests':
          return pullConnection(repo, args);
        default:
          throw new FieldProblem(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Issue': {
      const issue = obj._issue as Issue;
      const repo = obj._repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'author':
          return userObject(VIEWER_LOGIN);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'databaseId':
          return issue.id;
        case 'url':
          return null;
        case 'labels':
          return { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color, description: l.description })) };
        case 'comments':
          return {
            __typename: 'IssueCommentConnection',
            nodes: issue.comments.map((c) => commentObject(repo, issue.number, c)),
            totalCount: issue.comments.length,
          };
        default:
          throw new FieldProblem(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const pull = obj._pull as Pull;
      const repo = obj._repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return prState(pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
          const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
          return mergeable(repo, headTip, baseTip) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'merged':
          return pull.merged;
        case 'headRef':
          return { __typename: 'Ref', name: pull.headRef };
        case 'baseRef':
          return { __typename: 'Ref', name: pull.baseRef };
        case 'author':
          return userObject(VIEWER_LOGIN);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.state === 'closed' ? pull.updatedAt : null;
        case 'mergedAt':
          return pull.mergedAt;
        case 'databaseId':
          return pull.id;
        case 'files': {
          const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
          const baseFiles = filesOfTip(repo, pull.baseSha);
          const headFiles = filesOfTip(repo, headTip);
          const all = diffMaps(baseFiles, headFiles);
          const first = typeof args.first === 'number' ? args.first : all.length;
          const page = all.slice(0, first);
          return {
            __typename: 'PullRequestFileConnection',
            nodes: page.map((entry) => ({ __typename: 'PullRequestFile', path: entry.path, additions: 0, deletions: 0, changeType: entry.status.toUpperCase() })),
            totalCount: all.length,
          };
        }
        default:
          throw new FieldProblem(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'IssueComment': {
      const comment = obj._comment as { id: number; body: string };
      const repo = obj._repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('IssueComment', `${repo.owner}/${repo.name}:${obj._issueNumber}:${comment.id}`);
        case 'body':
          return comment.body;
        case 'author':
          return userObject(VIEWER_LOGIN);
        case 'databaseId':
          return comment.id;
        default:
          throw new FieldProblem(`Cannot query field "${field.name}" on type "IssueComment".`);
      }
    }
    case 'Ref': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'prefix') return 'refs/heads/';
      throw new FieldProblem(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'Label': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'color') return obj.color;
      if (field.name === 'description') return obj.description;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "Label".`);
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return obj.path;
      if (field.name === 'additions') return obj.additions;
      if (field.name === 'deletions') return obj.deletions;
      if (field.name === 'changeType') return obj.changeType;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "PullRequestFile".`);
    }
    case '__Type': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'kind') return obj.kind;
      if (field.name === 'fields') {
        return (obj._fields as string[]).map((name) => ({ __typename: '__Field', name }));
      }
      if (field.name === 'enumValues') {
        return (obj._enumValues as string[]).map((name) => ({ __typename: '__EnumValue', name }));
      }
      throw new FieldProblem(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case '__Field': {
      if (field.name === 'name') return obj.name;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "__Field".`);
    }
    case '__EnumValue': {
      if (field.name === 'name') return obj.name;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "__EnumValue".`);
    }
    case '__Schema': {
      if (field.name === 'queryType') return obj.queryType;
      if (field.name === 'mutationType') return obj.mutationType;
      if (field.name === 'types') return obj.types;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "__Schema".`);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      if (field.name === 'nodes') return obj.nodes;
      if (field.name === 'totalCount') return obj.totalCount ?? (Array.isArray(obj.nodes) ? obj.nodes.length : 0);
      if (field.name === 'pageInfo') return obj.pageInfo ?? { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      if (field.name === 'edges') {
        return (Array.isArray(obj.nodes) ? obj.nodes : []).map((node) => ({ __typename: 'Edge', node, cursor: encodeCursor(0) }));
      }
      throw new FieldProblem(`Cannot query field "${field.name}" on type "${type}".`);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'hasPreviousPage') return obj.hasPreviousPage;
      if (field.name === 'startCursor') return obj.startCursor;
      if (field.name === 'endCursor') return obj.endCursor;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case 'Edge': {
      if (field.name === 'node') return obj.node;
      if (field.name === 'cursor') return obj.cursor;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "Edge".`);
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return obj.issue;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return obj.issue;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return obj.pullRequest;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return obj.pullRequest;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return obj.commentEdge;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "AddCommentPayload".`);
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return obj.node;
      if (field.name === 'cursor') return obj.cursor;
      throw new FieldProblem(`Cannot query field "${field.name}" on type "IssueCommentEdge".`);
    }
    default:
      throw new FieldProblem(`Cannot query field "${field.name}" on type "${type}".`);
  }
}

// -------------------------------------------------------------------------------------------
// mutations (share the store with REST; merge reuses the same three-way merge)
// -------------------------------------------------------------------------------------------

function mutateCreateIssue(args: Record<string, unknown>): GqlObject {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoFromGlobalId(input.repositoryId);
  if (repo === null) throw new FieldProblem('createIssue: repository not found');
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new FieldProblem('createIssue: title is required');
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
    labels: [],
    comments: [],
    createdSeq: repo.seq,
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(number, issue);
  return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
}

function mutateCloseIssue(args: Record<string, unknown>): GqlObject {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = issueFromGlobalId(input.issueId);
  if (found === null) throw new FieldProblem('closeIssue: issue not found');
  found.issue.state = 'closed';
  found.issue.updatedAt = isoOf(nextTimestampSec());
  return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
}

function mutateCreatePullRequest(args: Record<string, unknown>): GqlObject {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoFromGlobalId(input.repositoryId);
  if (repo === null) throw new FieldProblem('createPullRequest: repository not found');
  const headRef = String(input.headRefName ?? '');
  const baseRef = String(input.baseRefName ?? repo.defaultBranch);
  const headTip = branchTip(repo, headRef);
  const baseTip = branchTip(repo, baseRef);
  if (headTip === undefined) throw new FieldProblem('createPullRequest: head branch does not exist');
  if (baseTip === undefined) throw new FieldProblem('createPullRequest: base branch does not exist');
  const duplicate = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
  if (duplicate !== undefined) throw new FieldProblem('createPullRequest: a pull request from this head already exists');
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  repo.seq += 1;
  const now = isoOf(nextTimestampSec());
  const pull: Pull = {
    id: nextRestId(),
    number,
    title: typeof input.title === 'string' ? input.title : '',
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
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
}

function mutateMergePullRequest(args: Record<string, unknown>): GqlObject {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = pullFromGlobalId(input.pullRequestId);
  if (found === null) throw new FieldProblem('mergePullRequest: pull request not found');
  const { repo, pull } = found;
  if (pull.state !== 'open') throw new FieldProblem('mergePullRequest: pull request is not open');
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === undefined) throw new FieldProblem('mergePullRequest: no merge base');
  const merged = threeWayMerge(filesOfTip(repo, base), filesOfTip(repo, headTip), filesOfTip(repo, baseTip));
  if (!merged.ok) throw new FieldProblem(`mergePullRequest: merge conflict: ${merged.conflicts.join(', ')}`);
  const now = isoOf(nextTimestampSec());
  const commitSha = createCommit(repo, { files: merged.merged!, parents: [baseTip], message: `${pull.title} (#${pull.number})` });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = now;
  repo.updatedAt = now;
  return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
}

function mutateAddComment(args: Record<string, unknown>): GqlObject {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const body = typeof input.body === 'string' ? input.body : '';
  if (body === '') throw new FieldProblem('addComment: body is required');
  const found = issueFromGlobalId(input.subjectId) ?? pullSubject(input.subjectId);
  if (found === null) throw new FieldProblem('addComment: subject not found');
  const comment = { id: nextCommentNumericId(), body, userLogin: VIEWER_LOGIN, createdAt: isoOf(nextTimestampSec()) };
  found.issue.comments.push(comment);
  found.issue.updatedAt = isoOf(nextTimestampSec());
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'IssueCommentEdge',
      node: commentObject(found.repo, found.issue.number, comment),
      cursor: encodeCursor(comment.id),
    },
  };
}

/** A pull request's subject id comments on the pull request as an issue (GitHub treats PRs as issues). */
function pullSubject(id: unknown): { repo: Repo; issue: Issue } | null {
  const found = pullFromGlobalId(id);
  if (found === null) return null;
  // Pull requests share the issue counter; find the issue record with the same number if one exists,
  // otherwise synthesize a view over the pull request's own comments by reusing a hidden issue slot.
  const existing = found.repo.issues.get(found.pull.number);
  if (existing !== undefined) return { repo: found.repo, issue: existing };
  return null;
}

// -------------------------------------------------------------------------------------------
// selection execution
// -------------------------------------------------------------------------------------------

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefNode>;
  errors: { message: string }[];
}

function executeSelections(
  obj: GqlObject,
  selections: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelections(obj, selection.selections, ctx));
      continue;
    }
    if (selection.kind === 'spread') {
      const def = ctx.fragments.get(selection.name);
      if (def === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (def.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelections(obj, def.selections, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = obj.__typename;
      continue;
    }
    const args = argMap(selection.args, ctx.variables);
    let value: unknown;
    try {
      value = resolveField(obj, selection, args);
    } catch (err) {
      if (err instanceof FieldProblem) {
        ctx.errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    out[key] = resolveValue(value, selection.selections, ctx);
  }
  return out;
}

function resolveValue(value: unknown, selections: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return value;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, selections, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return executeSelections(value as GqlObject, selections, ctx);
  }
  return value;
}

/** Execute one parsed operation; returns the {data, errors} envelope. */
export function executeGraphQL(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operations = definitions.filter((d): d is OperationNode => d.kind === 'operation');
  const fragments = new Map<string, FragmentDefNode>();
  for (const def of definitions) {
    if (def.kind === 'fragmentDef') fragments.set(def.name, def);
  }
  let operation = operations[0];
  if (operationName !== undefined) {
    operation = operations.find((op) => op.name === operationName) ?? operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation in GraphQL document.' }] };
  }
  const vars: Record<string, unknown> = {};
  for (const def of operation.variableDefinitions) {
    if (def.defaultValue !== null) vars[def.name] = evaluate(def.defaultValue, {});
  }
  for (const [key, value] of Object.entries(variables)) vars[key] = value;
  const root: GqlObject = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const ctx: ExecContext = { variables: vars, fragments, errors: [] };
  try {
    const data = executeSelections(root, operation.selections, ctx);
    return { data, errors: ctx.errors };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
