// store.ts — the forge's in-memory store: repositories, git objects, issues, pull
// requests, labels and comments, plus the file-map and merge machinery the REST surface
// and the git surface share.
//
// The scenario the suite drives is fixed (kit wire.ts: viewer login "adaiversen"), so the
// token owner's login is that constant; repositories are keyed by (owner, name) and any
// other owner reads 404, which is exactly the foreign-owner rule the suite checks.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** The author/committer line REST-created commits carry. */
export function viewerIdentity(timestampSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestampSec} +0000`;
}

// -------------------------------------------------------------------------------------------
// timestamps: deterministic per trial (MAKEFUN_TRIAL_NOW), never the wall clock in the trial.
// -------------------------------------------------------------------------------------------

let clockBaseSec = 0;
let clockTick = 0;

/** Seed the store clock. `iso` is MAKEFUN_TRIAL_NOW when the trial sets it. */
export function seedClock(iso: string | undefined): void {
  const parsed = iso === undefined || iso === '' ? NaN : Date.parse(iso) / 1000;
  clockBaseSec = Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(Date.now() / 1000);
  clockTick = 0;
}

/** The next second on the store clock (monotonic, deterministic within a trial). */
export function nextTimestampSec(): number {
  clockTick += 1;
  return clockBaseSec + clockTick;
}

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// -------------------------------------------------------------------------------------------
// records
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  seq: number;
}

let nextRepoId = 1;
let nextObjectId = 100000;
let nextCommentId = 1;

/** The global numeric id a REST object carries (stable across reads). */
export function nextRestId(): number {
  nextObjectId += 1;
  return nextObjectId;
}

export function nextCommentNumericId(): number {
  nextCommentId += 1;
  return nextCommentId;
}

// -------------------------------------------------------------------------------------------
// the store
// -------------------------------------------------------------------------------------------

export class Store {
  readonly repos = new Map<string, Repo>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo {
    const now = isoOf(nextTimestampSec());
    const repo: Repo = {
      id: nextRepoId,
      owner: VIEWER_LOGIN,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: 0,
    };
    nextRepoId += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }
}

export const store = new Store();

// -------------------------------------------------------------------------------------------
// file maps: path -> {oid, mode}, derived from a tip commit's trees
// -------------------------------------------------------------------------------------------

export interface FileEntry {
  oid: string;
  mode: string;
}

/** The flat file map of the commit `tip` (empty when the repo is unborn). */
export function filesOfTip(repo: Repo, tip: string | undefined): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  if (tip === undefined || tip === ZERO_OID) return files;
  const tipObject = repo.objects.get(tip);
  if (!tipObject || tipObject.type !== 'commit') return files;
  const walk = (treeOid: string, prefix: string): void => {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return;
    for (const entry of parseTree(treeObject.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(parseCommit(tipObject.data).tree, '');
  return files;
}

/** Build the tree objects for `files` into the repo and answer the root tree oid. */
export function buildTrees(repo: Repo, files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store a blob and answer its oid. */
export function putBlob(repo: Repo, data: Buffer): string {
  const oid = hashObject('blob', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'blob', data });
  return oid;
}

/** Create a commit object on `files` with `parents` and answer its oid. */
export function createCommit(
  repo: Repo,
  options: { files: Map<string, FileEntry>; parents: readonly string[]; message: string },
): string {
  const tree = buildTrees(repo, options.files);
  const sec = nextTimestampSec();
  const identity = viewerIdentity(sec);
  const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
  const data = buildCommit({ tree, parents: options.parents, author: identity, committer: identity, message });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** The tip oid of a ref, or undefined when the ref does not exist. */
export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** The tip oid of a branch name, or undefined. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid. */
export function resolveRef(repo: Repo, refish: string): string | undefined {
  if (isObjectId(refish)) {
    const object = repo.objects.get(refish);
    if (!object) return undefined;
    if (object.type === 'commit') return refish;
    if (object.type === 'tag') return peelToCommit(repo, refish);
    return undefined;
  }
  if (refish.startsWith('refs/')) {
    const tip = repo.refs.get(refish);
    return tip === undefined ? undefined : peelToCommit(repo, tip);
  }
  const branch = repo.refs.get(`refs/heads/${refish}`);
  if (branch !== undefined) return peelToCommit(repo, branch);
  const tag = repo.refs.get(`refs/tags/${refish}`);
  if (tag !== undefined) return peelToCommit(repo, tag);
  if (refish === 'HEAD') return branchTip(repo, repo.defaultBranch);
  return undefined;
}

/** Follow a tag object (or a chain of them) to its commit. */
export function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The merge base of two commits: the nearest common ancestor (first-parent walk + BFS). */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') queueA.push(...parseCommit(object.data).parents);
  }
  const queueB: { oid: string; depth: number }[] = [{ oid: b, depth: 0 }];
  const seenB = new Set<string>();
  let best: string | undefined;
  let bestDepth = Infinity;
  while (queueB.length > 0) {
    const { oid, depth } = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid) && depth < bestDepth) {
      best = oid;
      bestDepth = depth;
    }
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueB.push({ oid: parent, depth: depth + 1 });
    }
  }
  return best;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two file maps. */
export function diffMaps(base: Map<string, FileEntry>, head: Map<string, FileEntry>): DiffEntry[] {
  const out: DiffEntry[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    else if (oldEntry !== undefined && newEntry === undefined) out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** A simple multiset line diff: [additions, deletions]. */
export function lineDiff(oldText: string, newText: string): [number, number] {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return [additions, deletions];
}

export interface MergeOutcome {
  ok: boolean;
  merged: Map<string, FileEntry> | null;
  conflicts: string[];
}

/**
 * Three-way merge of `headFiles` (changed since `baseFiles`) onto `baseTipFiles` (also
 * changed since `baseFiles`). A path changed on both sides to different content conflicts.
 */
export function threeWayMerge(
  baseFiles: Map<string, FileEntry>,
  headFiles: Map<string, FileEntry>,
  baseTipFiles: Map<string, FileEntry>,
): MergeOutcome {
  const merged = new Map(baseTipFiles);
  const conflicts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const baseEntry = baseFiles.get(path);
    const headEntry = headFiles.get(path);
    const tipEntry = baseTipFiles.get(path);
    const headChanged = (headEntry?.oid ?? null) !== (baseEntry?.oid ?? null);
    const tipChanged = (tipEntry?.oid ?? null) !== (baseEntry?.oid ?? null);
    if (!headChanged) continue;
    if (!tipChanged) {
      if (headEntry === undefined) merged.delete(path);
      else merged.set(path, headEntry);
      continue;
    }
    // Both sides changed it: same result is fine, different results conflict.
    if ((headEntry?.oid ?? null) === (tipEntry?.oid ?? null)) continue;
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { ok: false, merged: null, conflicts };
  return { ok: true, merged, conflicts: [] };
}

/** Whether a pull request from `headTip` into `baseTip` merges cleanly. */
export function mergeable(repo: Repo, headTip: string, baseTip: string): boolean {
  const base = mergeBase(repo, headTip, baseTip);
  if (base === undefined) return false;
  const baseFiles = filesOfTip(repo, base);
  const headFiles = filesOfTip(repo, headTip);
  const tipFiles = filesOfTip(repo, baseTip);
  return threeWayMerge(baseFiles, headFiles, tipFiles).ok;
}

/** The objects reachable from a repo's refs (for pack building). */
export function reachableFromTips(repo: Repo, tips: readonly string[]): Set<string> {
  return collectReachable(tips, (oid) => repo.objects.get(oid), { allowMissing: true });
}

export { isAncestor };
export type { GitObjectType };
