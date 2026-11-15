// git.ts — git smart HTTP: info/refs advertisements (v0 and v2), upload-pack
// (protocol v2 ls-refs/fetch, v0 fetch) and receive-pack (v0).
//
// The wire this implements is the one the suite's git client speaks (kit
// program/env/src/git-client.ts): v2 capability advertisement with ls-refs and fetch
// (shallow), v0 advertisements opening with "# service=...", side-band-64k framing on
// every pack, and report-status on every push. Packs are written without deltas.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktFlush,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitcore.ts';
import {
  DEFAULT_BRANCH,
  branchTip,
  peelToCommit,
  store,
  type Repo,
} from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

const AGENT = 'forge/1.0';

const UPLOAD_V2_CAPS: [string, string][] = [
  ['agent', AGENT],
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow wait-for-done'],
  ['object-format', 'sha1'],
];

const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** Refs of a repo, sorted, as [oid, name] pairs (HEAD first when present). */
function refList(repo: Repo): { oid: string; name: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ oid, name }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The peeled commit of an annotated tag ref, or undefined. */
function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  const target = parseTag(object.data).object;
  const peeled = peelToCommit(repo, target);
  return peeled === target ? target : peeled;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: GitService): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const allCaps = `${symref} ${caps}`;
  const lines: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = refList(repo);
  const headTip = branchTip(repo, repo.defaultBranch);
  if (refs.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${allCaps}\n`));
  } else {
    // HEAD first, carrying the capabilities after a NUL.
    const headOid = headTip ?? refs[0]!.oid;
    lines.push(encodePktLine(`${headOid} HEAD\0${allCaps}\n`));
    for (const ref of refs) {
      lines.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined) lines.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = ['version 2\n'];
  for (const [name, value] of UPLOAD_V2_CAPS) lines.push(`${name}=${value}\n`);
  lines.push('flush');
  return encodePktLines(lines);
}

// -------------------------------------------------------------------------------------------
// fetch computation
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in deterministic order. */
  objects: GitObject[];
  /** New shallow boundaries (commits whose parents were cut off). */
  shallow: string[];
  /** Formerly shallow commits whose parent is now included. */
  unshallow: string[];
  /** Wants the client already holds (for the acknowledgments section). */
  heldWants: string[];
}

/**
 * The objects a fetch sends. `wants` are the tips, `haves` the commits the client holds,
 * `heldShallow` its current shallow boundaries, `depth` the absolute depth (undefined for
 * a full fetch). The suite's deepen N is an absolute depth N from the wants.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  heldShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(heldShallow);

  // Wanted closure: commits within `depth` generations of a want (unlimited when no depth),
  // plus the full tree/blob closure of every included commit.
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  {
    const queue: { oid: string; gen: number }[] = wants.filter(isObjectId).map((oid) => ({ oid, gen: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (!seen.has(target)) queue.push({ oid: target, gen });
        includedCommits.add(oid);
        continue;
      }
      if (object.type !== 'commit') continue;
      includedCommits.add(oid);
      const parents = parseCommit(object.data).parents;
      if (depth !== undefined && gen + 1 >= depth) {
        if (parents.length > 0) boundary.add(oid);
        continue;
      }
      if (depth === undefined && shallowSet.has(oid)) {
        // A fetch without deepen never crosses an existing shallow boundary.
        if (parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  // Wanted closure: every included commit itself plus the full tree/blob closure of
  // its tree — never its parents (the depth limit already decided which commits count).
  // A wanted tag contributes itself; its target commit entered the BFS above.
  const wantClosure = new Set<string>();
  for (const oid of includedCommits) {
    const object = lookup(oid);
    if (!object) continue;
    wantClosure.add(oid);
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      for (const reached of collectReachable([tree], lookup, { allowMissing: true })) wantClosure.add(reached);
    }
  }
  for (const oid of wants) {
    const object = lookup(oid);
    if (object?.type === 'tag') wantClosure.add(oid);
  }

  // Held closure: everything the client already has. A shallow boundary stops the walk:
  // the client holds the boundary commit and its tree, but not its parents.
  const held = new Set<string>();
  {
    const queue: string[] = [...haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        for (const reached of collectReachable([parseCommit(object.data).tree], lookup, { allowMissing: true })) held.add(reached);
        if (shallowSet.has(oid)) continue;
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const reached of collectReachable([oid], lookup, { allowMissing: true })) held.add(reached);
      }
    }
  }

  const send = new Set<string>();
  for (const oid of wantClosure) if (!held.has(oid)) send.add(oid);

  // New shallow boundaries: the boundary commits that were actually sent (their parents cut).
  const shallow: string[] = [];
  for (const oid of boundary) if (send.has(oid)) shallow.push(oid);
  // Unshallow: a formerly shallow commit whose parent is now sent.
  const unshallow: string[] = [];
  for (const oid of heldShallow) {
    if (!includedCommits.has(oid)) continue;
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => send.has(parent))) unshallow.push(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  // Wants the client already holds: the acknowledgment section ACKs them.
  const heldWants = [...new Set(wants.filter(isObjectId))].filter((oid) => held.has(oid));
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort(), heldWants };
}

/** Chunk a pack into sideband band-1 pkt-lines (32 KiB of pack per packet). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const headTip = branchTip(repo, repo.defaultBranch);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (headTip === undefined) {
    if (args.unborn && keep('HEAD')) {
      lines.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else if (keep('HEAD')) {
    let line = `${headTip} HEAD`;
    if (args.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    lines.push(encodePktLine(`${line}\n`));
  }
  for (const ref of refList(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD') continue;
    if (args.peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(encodePktLine(`${line}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // Protocol v2 sends an acknowledgments section only when the client sent haves:
  // a fresh clone (no haves) reads the first section as the packfile, and an
  // acknowledgments section there is a fatal protocol error for real git clients.
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.heldWants.length > 0) {
      for (const oid of plan.heldWants) parts.push(encodePktLine(`ACK ${oid}\n`));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(pktFlush());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  if (plan.objects.length > 0) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(sidebandPack(writePack(plan.objects)));
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v2 command request: the command line, then args after the delim. */
function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (!sawDelim && lines.length > 0) {
    // A request with no delim: treat everything after the command as arguments.
    sawDelim = true;
  }
  const first = lines[0] ?? '';
  const match = /^command=([a-z-]+)\n?$/.exec(first.trim());
  if (!match) throw new Error(`expected a v2 command line, got ${JSON.stringify(first.slice(0, 60))}`);
  return { command: match[1]!, args: lines.slice(1).map((line) => line.replace(/\n$/, '')) };
}

/** Parse a v0 upload-pack request: wants (first may carry capabilities), shallow/deepen, flush, haves, done. */
function parseV0Fetch(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).split(' ')[0]!;
      args.wants.push(rest);
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      args.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (line === 'done') {
      // end of negotiation
    } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // accepted and ignored: the suite never sends these
    } else if (line === '') {
      // ignore
    } else {
      throw new Error(`unexpected v0 upload-pack line ${JSON.stringify(line.slice(0, 60))}`);
    }
  }
  return args;
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  // Walk the pkt-line stream by hand: the pack that follows the flush is raw binary,
  // not pkt-lines, so a whole-stream decode would choke on its 'PACK' header.
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const lenText = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len < 4 || offset + len > body.length) throw new Error('pkt-line payload is truncated');
    let line = body.toString('utf8', offset + 4, offset + len).replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    offset += len;
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');
  const pack = packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack: pack !== null && pack.length > 0 ? Buffer.from(pack) : null };
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parseReceivePack(body);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null) {
    try {
      if (!verifyPackChecksum(pack)) throw new Error('pack trailer checksum mismatch');
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${(err as Error).message}`;
    }
  }
  if (!unpackOk) {
    report.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpack error\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let failure: string | null = null;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) failure = 'remote ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) failure = 'non-fast-forward';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) failure = 'already exists';
        else if (!repo.objects.has(command.newOid)) failure = 'missing object';
        else if (command.ref === `refs/heads/${repo.defaultBranch}` && repo.refs.size === 0) {
          // first push to the default branch: fine
        }
      } else {
        // Update.
        if (current === undefined) failure = 'remote ref does not exist';
        else if (current !== command.oldOid) failure = 'non-fast-forward';
        else if (!repo.objects.has(command.newOid)) failure = 'missing object';
        else if (command.ref.startsWith('refs/tags/')) {
          if (command.newOid !== command.oldOid) failure = 'non-fast-forward';
        } else if (!isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) {
          failure = 'non-fast-forward';
        }
      }
      if (failure !== null) {
        report.push(`ng ${command.ref} ${failure}\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  }
  // The report-status stream is itself a pkt-line stream inside sideband band 1:
  // one pkt-line per report line, closed by an inner flush, and the whole band-1
  // payload is chunked into 32 KiB outer sideband packets, closed by an outer flush.
  // (A real receive-pack answers exactly this: `sideband< \1000eunpack ok0017ok ...0000`.)
  const innerParts: Buffer[] = [];
  for (const line of report) innerParts.push(encodePktLine(line));
  innerParts.push(pktFlush());
  const inner = Buffer.concat(innerParts);
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    const slice = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// entry points (called by app.ts with the raw request body already read)
// -------------------------------------------------------------------------------------------

export function gitRepo(owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name);
}

/** GET /{owner}/{repo}.git/info/refs?service=... — returns {status, contentType, body}. */
export function gitInfoRefs(
  owner: string,
  name: string,
  service: string,
  version2: boolean,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown service\n', 'utf8') };
  }
  const body = service === 'git-receive-pack' || !version2 ? v0Advertisement(repo, service as GitService) : v2Advertisement();
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

/** POST /{owner}/{repo}.git/git-upload-pack. */
export function gitUploadPack(
  owner: string,
  name: string,
  version2: boolean,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
  }
  try {
    if (version2) {
      const { command, args } = parseV2Command(body);
      if (command === 'ls-refs') {
        const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const arg of args) {
          if (arg === 'peel') parsed.peel = true;
          else if (arg === 'symrefs') parsed.symrefs = true;
          else if (arg === 'unborn') parsed.unborn = true;
          else if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice('ref-prefix '.length));
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, parsed) };
      }
      if (command === 'fetch') {
        const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
        for (const arg of args) {
          if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
          else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
          else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
          else if (arg.startsWith('deepen ')) {
            const n = parseInt(arg.slice(7).trim(), 10);
            if (Number.isFinite(n)) parsed.depth = n;
          }
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, parsed) };
      }
      throw new Error(`unsupported v2 command ${command}`);
    }
    const parsed = parseV0Fetch(body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, parsed) };
  } catch (err) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`bad request: ${(err as Error).message}\n`, 'utf8') };
  }
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function gitReceivePack(
  owner: string,
  name: string,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
  }
  try {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: handleReceivePack(repo, body) };
  } catch (err) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`bad request: ${(err as Error).message}\n`, 'utf8') };
  }
}

/** For tests: the objects a repo holds. */
export function repoObjectCount(repo: Repo): number {
  return repo.objects.size;
}

export { hashObject };
