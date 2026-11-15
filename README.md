# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/shedink11/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/shedink11/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process, standard library only.
It serves its own store — no outside service, no proxy, no UI.

## What it serves

- **Git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch`, shallow) and v0
  fetch, receive-pack v0 with `report-status`, for real `git clone` / `fetch` / `push`
  round-trips. Packs are written without deltas; the trailer SHA-1 verifies.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels,
  issues, comments and pull requests, with GitHub's status codes (201 create, 409
  stale sha, 422 duplicate repo / unknown label, 405 conflicted merge).
- **GraphQL v4** at `/api/graphql` — viewer, repository, issue and pull-request reads,
  the `__type` introspection probes, Relay `node(id:)`, cursor pagination, and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations, sharing the store with REST.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern 2026-07-28 era
  (`server/discover`) with the legacy `initialize` handshake as a fallback, and eight
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`,
  `list_repos`, `create_pull_request`, `merge_pull_request`).

## Layout

| file | what it holds |
| --- | --- |
| `main.ts` | the entry <-> env lifecycle: ephemeral port, register, poll `/done`, exit 0 |
| `app.ts` | the HTTP server: routing, auth, body handling |
| `git.ts` | smart HTTP: advertisements, v2 ls-refs/fetch, v0 fetch, receive-pack |
| `gitcore.ts` | SHA-1 objects, commit/tree/tag parse+build, pkt-line codec, pack read/write |
| `store.ts` | the in-memory store: repos, refs, issues, pull requests, merges, clock |
| `rest.ts` | the REST v3 handlers |
| `graphql.ts` | the GraphQL tokenizer, parser and executor |
| `mcp.ts` | the MCP endpoint and its tools |

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the env to register with; without it the process exits 1.
`MAKEFUN_SHOP_TOKEN` is the bearer token the suite speaks with — when it is empty,
auth is skipped (the client then sends no header). `MAKEFUN_TRIAL_NOW` seeds the
deterministic clock the store timestamps from.

## Auth

A request without the right bearer token is 401 with a JSON body. A repository under a
different owner is 404, never 403. Every JSON reply is `application/json` with a
non-empty `X-GitHub-Request-Id`.

## Notes

- Issues and pull requests share one counter per repository, as GitHub does.
- Merges are three-way merges onto the base branch; a conflict is a 405.
- A merge commit's parents are the base tip (squash semantics, as the suite drives it).
