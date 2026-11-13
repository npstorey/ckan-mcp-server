# PIN.md: what this fork deploys

The `pin` branch of `npstorey/ckan-mcp-server` (a fork of `ondata/ckan-mcp-server`) is the branch a hosted service
deploys from. It holds one upstream release, with the runtime entries of its lockfile refreshed (see
[The refreshed lock](#the-refreshed-lock)), plus this fork's own files:

- `PIN.md` (this file) and `render.yaml`, the record of the pin and of the service;
- `scripts/start-hosted.mjs` and its test `scripts/start-hosted.test.mjs`, the service's start command (see
  [Logging](#logging));
- `scripts/smoke-deployed-endpoint.mjs` and `.github/workflows/deployed-endpoint-smoke.yml`, the daily check on the
  deployed endpoint (see [The smoke](#the-smoke)).

The six workflow files the upstream ships are removed (see [Workflows](#workflows)). One upstream file is edited:
`package-lock.json`, whose runtime entries are refreshed; `package.json` is unchanged. No other upstream file is
edited, moved or deleted.

## The pin

| | |
|---|---|
| Upstream tag | `v0.4.139` |
| Commit | `d504359397aabb233e42bc25adec54c550ed4d62` |
| Released | `2026-11-09T10:42:32Z` (the GitHub release's publication time) |
| `serverInfo` | `ckan-mcp-server` `0.4.139` (`src/server.ts`) |
| MCP SDK | `@modelcontextprotocol/sdk` 1.32.2 (this fork's `package-lock.json`; the release's names 1.27.1); protocol revisions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` (1.32.2's `dist/esm/types.js`; 1.27.1 lists the same five) |
| Tools | 20: 19 `ckan_*` tools and `sparql_query` |
| Transport | Streamable HTTP, stateless (`src/transport/http.ts`): a server per request, no session id |

## The service

A Render web service, `ckan-mcp-server`, plan Starter, region Oregon, deploying `pin` on every commit. Hostname
`ckan-mcp-server.onrender.com`; domain `ckan-mcp.civicaitools.org`. First deployed 2026-11-12. `render.yaml` mirrors the
dashboard; it is documentation, not live configuration.

**Build.** The service runs `npm ci && npm run build` on Node 22. The build log at the pinned commit read `Running build
command 'npm ci && npm run build'` and `added 262 packages, and audited 263 packages`, on Node 22.23.5. The dashboard's
form pre-fills `npm install && npm run build`; the first deploy ran that, and the build command was then corrected to
`npm ci`, which installs exactly what the lockfile pins.

**Start.** `node scripts/start-hosted.mjs`. The dashboard read `npm start` when the service was created; the start
command changes to this file at the deploy gate that follows this PR.

**Variables** (none secret):

| Variable | Value | Why |
|---|---|---|
| `NODE_VERSION` | `22` | The upstream ships no `.node-version` and declares `engines.node: ">=18.17.0"`. |
| `TRANSPORT` | `http` | The default is stdio. |
| `CKAN_HTTP_HOST` | `0.0.0.0` | The server binds `127.0.0.1` unless this is set. |
| `CKAN_ALLOWED_DOMAINS` | `data.boston.gov` | The only CKAN portal the server queries. Over HTTP the server refuses to start without an allowlist unless `CKAN_HTTP_ALLOW_ALL=true`. |
| `CKAN_HTTP_ALLOWED_HOSTS` | `ckan-mcp-server.onrender.com,ckan-mcp.civicaitools.org` | The DNS-rebinding guard's `Host` allowlist. |

`CKAN_HTTP_ALLOW_ALL`, `CKAN_PRIVATE_HOSTS` and `PORT` are not set. `CKAN_PRIVATE_HOSTS` is new in 0.4.139 (absent at
`v0.4.138`); it lets listed hosts resolve to private addresses, and it stays unset on this deployment.

**The DNS-rebinding guard, as seen on the deployment.** With the domain routed by the host but not yet in
`CKAN_HTTP_ALLOWED_HOSTS`, a request to it was answered `403` with
`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host header: ckan-mcp.civicaitools.org"},"id":null}`. After
the variable gained the domain, the same request was answered `200` with the tool list. A hand-set foreign `Host` on
the Render hostname never reaches the service: the host's edge answers `403`.

## Outbound hosts

- `data.boston.gov`, the allowlist. Every CKAN request is checked against it (`validateServerUrl`, `src/utils/http.ts`).
- `datashades.info`, reached on its own by `ckan_find_portals` (`src/tools/portal-discovery.ts:11`, `:53`). That fetch is
  not checked against `CKAN_ALLOWED_DOMAINS`; a redirect it follows is. On the deployment, 2026-11-12, the tool listed
  three portals from a registry of 945 active ones, so the host is reachable from the service.
- `data.europa.eu`, never reached here. The MQA tools accept only `dati.gov.it`, and their first step is a CKAN request
  to that portal (`src/tools/quality.ts:703`), which the allowlist refuses.
- SPARQL endpoints: `sparql_query` checks its endpoint against the allowlist (`src/tools/sparql.ts:49`).

## Logging

**What the pinned server writes to stderr.** One JSON line per CKAN request (`auditLog`, `src/utils/http.ts:892-907`):
`ts`, `server`, `action`, `cache_hit` and, where present, `q`, `fq`, the first 200 characters of `sql`, `id`, `rows`,
`limit`. On a portal's `success=false`, the first 500 characters of the portal's answer (`[ckan] success=false
action=...`, `:1149-1151`). On the host, stderr is the service's log stream, which the host keeps. No setting of the
pinned release turns either line off.

**What `scripts/start-hosted.mjs` withholds.** It replaces `process.stderr.write` before it loads the built server
(`dist/index.js`), and passes on unchanged only a write that begins with one of three lines the server writes itself:

- `CKAN MCP server running on ` (the start line, `src/transport/http.ts:60`);
- `[SECURITY WARNING] ` (`src/utils/http.ts:651`, `:669`);
- `Server error:` (a failed start, before any request, `src/index.ts:17`, `:24`).

Every other write is withheld and replaced by the fixed line `[start-hosted] 1 log write withheld`, which holds no part
of it. **It fails closed:** the three lines are an allowlist, not a pattern for the audit line, so a line it does not
know (a new log line in a later release, a dependency's warning, a request error) is withheld too. Its test,
`node --test scripts/start-hosted.test.mjs`, needs no build.

**Fatal errors.** Node prints an uncaught exception's report itself, outside `process.stderr.write`, and routes an
unhandled rejection to the same place. The file registers one `uncaughtException` handler that writes the fixed line
`[start-hosted] fatal error withheld; exiting`, which holds nothing of the error, and exits with code 1, as Node's own
handler would. So uncaught exceptions and unhandled rejections are withheld the same way. Neither the pinned source nor
its runtime dependencies register such a handler of their own (read again 2026-11-12 for the entries the lock refresh
moved or added).

**Its limits.** What the runtime prints without running JavaScript still bypasses the filter: an out-of-memory abort
(measured: its heap report reached stderr with the filter and the handler in place) or a native crash (not measured).
It hides nothing from the portal: `data.boston.gov` still receives every query the server sends it.

**It comes out by a pin move** once the upstream ships its own switch for these lines: that pin-move PR deletes the file
and sets the start command back to `npm start`.

## The refreshed lock

**Why.** The service is a public, unauthenticated HTTP endpoint, and the runtime tree of the release's lockfile carried
advisories on request size and memory in the libraries that handle its HTTP requests (see
[Dependency audit](#dependency-audit)). The upstream had refreshed none of them: on 2026-11-12 its `main` was `v0.4.142`,
whose lockfile differs from the pinned release's only in the root entry's version.

**What was run.** On 2026-11-12, with npm 11.19.1, in a directory holding only the release's `package.json` and
`package-lock.json`:

```
npm audit fix --package-lock-only --omit=dev
```

No `--force`. It reads the registry and rewrites the lockfile; it installs nothing and runs no package's code. It exits
1, because one advisory's fix is a major version (see [After the refresh](#after-the-refresh)). It was run until the
lock stopped moving: the second run was the last to change it, and the third gave a byte-equal lock. One run is not
enough, because the first run moves `qs` only as far as the locked `express` allows (`express` 4.22.2 declares `qs`
`~6.15.1`, so `qs` went to 6.15.4), and the second run moves `express` to 4.22.3 and then `qs` to 6.16.2.

`package.json` is unchanged, byte for byte. 13 lockfile entries changed, all in the runtime tree: 12 moved and 1 was
added. No entry was removed, and no development-only entry moved: each of the 217 development entries is byte-equal to
the release's, compared as JSON.

| Entry (under `node_modules/`) | Release's lock | This fork's lock |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.27.1 | 1.32.2 |
| `@modelcontextprotocol/sdk/node_modules/body-parser` | 2.3.0 | 2.4.0 |
| `@modelcontextprotocol/sdk/node_modules/qs` | (absent) | 6.17.1 |
| `@hono/node-server` | 1.19.17 | 2.1.8 |
| `body-parser` | 1.20.6 | 1.20.9 |
| `express` | 4.22.2 | 4.22.3 |
| `fast-uri` | 3.1.7 | 3.1.9 |
| `follow-redirects` | 1.16.0 | 1.16.3 |
| `hono` | 4.13.7 | 4.13.18 |
| `ip-address` | 10.7.0 | 10.7.6 |
| `proxy-addr` | 2.0.7 | 2.0.8 |
| `qs` | 6.15.3 | 6.16.2 |
| `undici` | 6.28.0 | 6.29.1 |

The three direct dependencies among them stay inside `package.json`'s ranges (`@modelcontextprotocol/sdk` `^1.27.1`,
`express` `^4.19.2`, `undici` `^6.28.0`). `@hono/node-server` 2.1.8 declares `engines.node` `>=20`, above the
upstream's `>=18.17.0`; the service runs Node 22.

**What this file does not record.** The build and tests on the refreshed lock, and the DNS-rebinding guard on the
refreshed SDK, are read before the merge by the rule under [Moving the pin](#moving-the-pin), and their results are
recorded on the pull request.

## Dependency audit

Read with `npm audit --package-lock-only`, with and without `--omit=dev`. The date is the reading's: the advisory
database moves, and a later reading can differ.

### At the release's lockfile

Read 2026-11-12T19:37Z over the pinned release's `package.json` and `package-lock.json`. The lockfile of `v0.4.140` gives
the same counts.

**19 packages flagged: 1 critical, 9 high, 9 moderate.** 11 are in the runtime tree, 8 are development-only.

| Runtime package | Severity |
|---|---|
| `proxy-addr` | critical |
| `@modelcontextprotocol/sdk` | high |
| `body-parser` | high |
| `follow-redirects` | high |
| `undici` | high |
| `zod` | high |
| `@hono/node-server` | moderate |
| `fast-uri` | moderate |
| `hono` | moderate |
| `ip-address` | moderate |
| `qs` | moderate |

Development-only: `miniflare`, `sharp`, `source-map-js`, `vite` (high); `@vitest/coverage-v8`, `@vitest/mocker`,
`vitest`, `wrangler` (moderate).

The service is an unauthenticated HTTP endpoint, so three advisories about HTTP requests are named here by id:
`GHSA-46jr-4wx8-v453` and `GHSA-f897-62hf-6gxq` (the SDK: request size during validation, and request body size or
JSON-RPC batch length), and `GHSA-27r3-jxmh-p828` (`body-parser`: trailing bytes after a compressed request body). This
file does not assess whether any of them is exploitable on this deployment.

### After the refresh

Read 2026-11-12T22:20Z over the release's `package.json` and this fork's `package-lock.json`.

**1 runtime package flagged: `zod`, high, `GHSA-mrhx-c7xc-m3w5`; none critical.**

`zod`'s fix is 4.6.6 or later, a major version outside `package.json`'s `^3.23.8`. Taking it means changing the
manifest and the source written against zod 3, which is the upstream's to do; this fork changes no manifest and no
source.

**The development tree is unchanged.** Its entries are byte-equal to the release's, so `npm ci` installs the same
development packages as before, and the audit of the development tree is unchanged: it flags `miniflare`, `sharp`,
`source-map-js`, `vite` (high) and `@vitest/coverage-v8`, `@vitest/mocker`, `vitest`, `wrangler` (moderate), plus
`undici` at `node_modules/miniflare/node_modules/undici` (high, development-only), which the reading at the release's
lockfile counted under the runtime `undici` row. The whole tree: 10 packages flagged, 6 high, 4 moderate.

## Upstream advisories

The upstream's published security advisories were read 2026-11-11 (16 published) and again 2026-11-12 (still 16; the
newest published 2026-10-19). The two newest are `GHSA-279h-fmcr-4rwv` (patched in 0.4.128) and `GHSA-w3gp-3hrh-v465`
(patched in 0.4.130). None lists an affected version above 0.4.129.

## Workflows

The upstream's six workflow files (`claude-code-review.yml`, `claude.yml`, `deploy-website.yml`, `release.yml`,
`update-npm-downloads.yml`, `update-telemetry.yml`) automate the upstream's own repository and are removed here. Two of
them commit to the default branch on a schedule (`update-npm-downloads.yml:4-5`, `:26`; `update-telemetry.yml:4-6`,
`:47` at `d504359`); `pin` is this fork's default branch and the service deploys on every commit to it. GitHub registers
a fork's workflows only when Actions are acknowledged in its Actions tab, and that registers every workflow file on the
branch at once. So the six are removed before Actions are enabled, and `.github/workflows/` holds one file, the smoke's.

## The smoke

`.github/workflows/deployed-endpoint-smoke.yml` runs `scripts/smoke-deployed-endpoint.mjs` daily at 06:29 UTC and on
manual dispatch (an `endpoint` input probes another URL; the default is `https://ckan-mcp.civicaitools.org/mcp`). It
reads no secret and installs nothing. It checks, over the wire:

- the website's handshake (`initialize` at `2024-11-05`, no `MCP-Protocol-Version` header) and a current client's (at
  `2025-11-25`, the header on every request), each `initialize` → `tools/list` → `tools/call ckan_status_show` on
  `https://data.boston.gov`: the answered revision, `serverInfo` `ckan-mcp-server` `0.4.139`, exactly 20 tools, and a
  status answer;
- one refused call: `ckan_status_show` on `https://www.dati.gov.it/opendata` must come back `isError: true`, naming
  `CKAN_ALLOWED_DOMAINS`.

**A known limit.** GitHub disables scheduled workflows in a public repository after 60 days without repository
activity, and they start disabled in a fork. Re-enable it with:

```
gh workflow enable deployed-endpoint-smoke.yml -R npstorey/ckan-mcp-server
```

## Moving the pin

**Branches.** The fork's only long-lived branch is `pin`. The fork's `main`, a copy of the upstream's `main` as it stood
when the fork was made and with the upstream's six workflow files, and `ckan1/p1-deployment-record`, the merged branch
of the fork's first PR, are deleted at the deploy gate that follows the PR that refreshed the lock. A workflow file on
a branch other than the default one can still be run by an event on that branch (a push to `main`, for example),
which is why `main` is not kept. A pin move merges an upstream tag fetched from the upstream repository, `ondata/ckan-mcp-server`, never from a
branch of this fork.

The pin moves to the newest upstream release after that release's advisories (the upstream's, and `npm audit` over its
lockfile) are read. The move is a PR on `pin` that merges the upstream tag and touches only upstream files (with
`package-lock.json` refreshed as below), plus this file and the smoke's pinned version (`EXPECTED_SERVER_VERSION` in
`scripts/smoke-deployed-endpoint.mjs`, and `EXPECTED_TOOL_COUNT` beside it when a release changes the tool count). The
fork merges by merge commit only.

**The lockfile at a pin move.** This fork's `package-lock.json` differs from the upstream's, so merging an upstream tag
conflicts in `package-lock.json`. The conflict is resolved by this step, not by hand: take the upstream's lockfile from
the tag, run the same command (`npm audit fix --package-lock-only --omit=dev`, no `--force`) in a directory holding
only the tag's `package.json` and that lockfile until the lock stops moving (two consecutive runs give a byte-equal
lock; on 2026-11-12 the second run was the last to change it), commit that lock, and check three things before the
merge:

1. the manifest is unchanged: `package.json` is byte-equal to the tag's;
2. no development-only entry moved: every entry that changed or was added is a runtime entry, none was removed, and
   every development entry is byte-equal to the tag's, compared as JSON;
3. the runtime audit's remainder (`npm audit --package-lock-only --omit=dev`) is read and recorded in this file.

The same step applies when the lock is refreshed without a pin move.

**The build and the DNS-rebinding guard after a lock change.** The guard is the SDK's code, and a refreshed lock or a
pin move can move the SDK. So whenever the lock is refreshed or the pin moves, before the merge, a clean clone under
Node 22 runs `npm ci && npm run build && npm test -- --run`, and the guard is read again on the built server in a local
run: started over HTTP with `CKAN_HTTP_ALLOWED_HOSTS` set as on the host, a `tools/list` with a foreign `Host` is refused
(`403`, a body holding `Invalid Host header:` and that host) and one with a listed host is admitted (`200` and the tool
list). After the deploy, the smoke against the domain shows the listed host is still admitted. The results are recorded
on the pull request.

**Before the merge, check the PR's head tree holds no workflow but the smoke's:** a merge of an upstream tag can bring
a removed workflow back or add a new one.

```
git ls-tree --name-only <head-commit> .github/workflows/
# expected: .github/workflows/deployed-endpoint-smoke.yml, and nothing else
```

**The staged order.** A site that uses this deployment may pin the values the server reports (its name, its version,
its tools' argument schemas). Where one does, it accepts the new values first; then the pin-move PR merges. The smoke at a pin-move PR's head expects the new version, so it is green
only after the merge's deploy.

## Not here yet

The pinned-values guard (a committed file of the reported name, version and tool-schema hashes, with its test) lands in
a later PR. Until then, the smoke's `serverInfo` and tool-count checks are the only check on what the deployment
reports.
