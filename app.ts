// app.ts — the HTTP server: routing, auth and body handling for the forge.
//
// Routes:
//   GET  /healthz                                   the env's boot check: 200 {"ok":true}
//   GET  /{owner}/{repo}.git/info/refs              git smart-HTTP advertisements (v0/v2)
//   POST /{owner}/{repo}.git/git-upload-pack        clone/fetch (v2 ls-refs/fetch, v0 fetch)
//   POST /{owner}/{repo}.git/git-receive-pack       push (v0, report-status)
//   *    /api/v3/...                                REST v3 (routeRest)
//   POST /api/graphql                              GraphQL v4 (executeGraphQL)
//   POST /mcp                                      MCP (handleMcp)
//
// Auth: every route except /healthz requires `Authorization: Bearer <token>` where the
// token is MAKEFUN_SHOP_TOKEN — unless that variable is empty/unset, in which case the
// client sends no header and auth is skipped. A request without the right bearer token
// is 401 with a JSON body. A repository under a different owner is 404, never 403.
//
// Every JSON reply carries application/json and a non-empty X-GitHub-Request-Id.
// Malformed JSON bodies are 400; unknown routes are JSON 404s.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { routeRest, MALFORMED } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './git.ts';
import { seedClock } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The deterministic clock's seed: the trial's "now", so created timestamps are stable. */
seedClock(process.env.MAKEFUN_TRIAL_NOW);

/** The bearer token the suite speaks with; empty means the client sends none and auth is skipped. */
function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Whether this request carries the right bearer token (or auth is skipped when the token is empty). */
function authorized(req: IncomingMessage): boolean {
  const token = shopToken();
  if (token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`,
    ...headers,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body, or MALFORMED when it does not parse (empty bodies parse as undefined). */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return MALFORMED;
  }
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const query = queryOf(req);

      // The env's boot check calls this twice: 200 {"ok":true}. No auth: the env has no token yet.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything else needs the bearer token (unless the token is empty, when auth is skipped).
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const name = decodeURIComponent(gitMatch[2]!);
        const endpoint = gitMatch[3]!;
        const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (endpoint === 'info/refs' && method === 'GET') {
          const service = query.get('service') ?? '';
          const answer = gitInfoRefs(owner, name, service, version2);
          sendRaw(res, answer.status, answer.body, answer.contentType);
          return;
        }
        if (endpoint === 'git-upload-pack' && method === 'POST') {
          const raw = await readBody(req);
          const answer = gitUploadPack(owner, name, version2, raw);
          sendRaw(res, answer.status, answer.body, answer.contentType);
          return;
        }
        if (endpoint === 'git-receive-pack' && method === 'POST') {
          const raw = await readBody(req);
          const answer = gitReceivePack(owner, name, raw);
          sendRaw(res, answer.status, answer.body, answer.contentType);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (parsed === MALFORMED) {
          sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          return;
        }
        if (Array.isArray(parsed)) {
          const results = parsed.map((entry) => {
            if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).query !== 'string') {
              return { data: null, errors: [{ message: 'Each batched operation needs a query string.' }] };
            }
            const op = entry as Record<string, unknown>;
            return executeGraphQL(op.query as string, (op.variables ?? {}) as Record<string, unknown>, typeof op.operationName === 'string' ? op.operationName : undefined);
          });
          sendJson(res, 200, results);
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).query !== 'string') {
          sendJson(res, 400, { errors: [{ message: 'A GraphQL request needs a query string.' }] });
          return;
        }
        const op = parsed as Record<string, unknown>;
        sendJson(
          res,
          200,
          executeGraphQL(op.query as string, (op.variables ?? {}) as Record<string, unknown>, typeof op.operationName === 'string' ? op.operationName : undefined),
        );
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method === 'DELETE') {
          // A legacy session close: nothing is held, so it is already gone.
          res.writeHead(204);
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        const answer = handleMcp(raw);
        if (answer.body === '') {
          res.writeHead(answer.status);
          res.end();
          return;
        }
        sendRaw(res, answer.status, Buffer.from(answer.body, 'utf8'), JSON_TYPE);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        const segments = path === '/api/v3' || path === '/api/v3/' ? [] : path.slice('/api/v3/'.length).split('/').map(decodeURIComponent);
        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const body = parseJsonBody(raw);
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
        const result = routeRest(method, segments, query, body, baseUrl);
        if (result.status === 204 || result.body === null) {
          requestCounter += 1;
          res.writeHead(result.status, { 'x-github-request-id': `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}` });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      // A request handler must never take the server down with it.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } catch {
        try {
          res.destroy();
        } catch {
          // The socket is already gone.
        }
      }
    });
  });
}
