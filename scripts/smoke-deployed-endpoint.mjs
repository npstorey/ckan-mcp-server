#!/usr/bin/env node
/**
 * Deployed-endpoint smoke: does the LIVE hosted /mcp of this fork's deployment
 * still answer as the pinned server does?
 *
 * Two exchanges, each initialize → tools/list → tools/call ckan_status_show
 * against https://data.boston.gov (see EXCHANGES), then one refused call:
 *   1. the civic-ai-tools website's handshake: initialize at APP_PROTOCOL_VERSION
 *      and no MCP-Protocol-Version header on any request;
 *   2. a current client: initialize at PROTOCOL_VERSION, with
 *      MCP-Protocol-Version on every request;
 *   3. the refused call, in exchange 2's form: tools/call ckan_status_show
 *      against a portal outside the deployment's CKAN_ALLOWED_DOMAINS must come
 *      back as a tool error naming CKAN_ALLOWED_DOMAINS.
 *
 * WHAT IT CHECKS, and why each:
 *   - initialize answers the requested protocolVersion, and serverInfo is the
 *     pinned name and version (EXPECTED_SERVER_NAME, EXPECTED_SERVER_VERSION).
 *     The deployment builds from the `pin` branch; a serverInfo that moved means
 *     the deployed code is not the pinned release (see PIN.md).
 *   - tools/list returns exactly EXPECTED_TOOL_COUNT tools. The version gate of
 *     the SDK's HTTP transport fires on a non-initialize request carrying
 *     MCP-Protocol-Version, so exchange 2's tools/list is the protocol-skew probe.
 *   - ckan_status_show reaches the allowed portal and returns its status text.
 *     This needs data.boston.gov to be up. The tool answering isError: true for
 *     that portal is the one assertion that is retried (the same attempts and
 *     backoff as a transport flake), so one bad minute at the portal does not
 *     turn the monitor red; when every attempt answers it, the check FAILS and
 *     the log shows the tool's own error text.
 *   - the refused call proves the domain allowlist is set on the service. With
 *     the allowlist unset the HTTP transport refuses to start unless
 *     CKAN_HTTP_ALLOW_ALL=true, and then this call would succeed.
 *
 * THE SERVER IS STATELESS (src/transport/http.ts: `sessionIdGenerator:
 * undefined`, `enableJsonResponse: true`, a new server per request). There is no
 * mcp-session-id and nothing to close, so this script sends no session header
 * and no DELETE. Each request stands alone; initialize is sent because the
 * clients it imitates send it, and its answer is asserted.
 *
 * NO CREDENTIALS. The server requires no authentication; this script reads no
 * secret and the workflow that runs it needs none.
 *
 * ZERO DEPENDENCIES. Global fetch on Node 22, nothing imported. No `npm ci`, no
 * build, no port binding: a broken build or a registry outage can never turn
 * this monitor red for a reason that has nothing to do with the endpoint.
 *
 * Usage:
 *   node scripts/smoke-deployed-endpoint.mjs
 *   SMOKE_MCP_URL=https://ckan-mcp-server.onrender.com/mcp node scripts/smoke-deployed-endpoint.mjs
 *
 * Exit codes: 0 = every check passes. 1 = any one fails, or the endpoint could
 * not be reached. Every exchange runs and reports even when an earlier one
 * failed, unless the endpoint was unreachable (then the rest are reported as not
 * run). What was sent and what came back is printed to stdout on failure, so a
 * scheduled failure is readable from the log alone.
 *
 * Adapted from npstorey/socrata-mcp-server's scripts/smoke-deployed-endpoint.mjs
 * (structure, retries, reporting).
 */

/** The deployment. Override with SMOKE_MCP_URL to probe another one. */
const DEFAULT_ENDPOINT = 'https://ckan-mcp.civicaitools.org/mcp';

/**
 * LATEST_PROTOCOL_VERSION in @modelcontextprotocol/sdk 1.32.2, the version this
 * fork's refreshed package-lock.json installs (dist/esm/types.js; see PIN.md):
 * what a current client asks for. Exchange 2 negotiates it.
 */
const PROTOCOL_VERSION = '2025-11-25';

/**
 * The civic-ai-tools website's handshake: initialize at this revision, and never
 * an MCP-Protocol-Version header. Exchange 1 imitates it.
 */
const APP_PROTOCOL_VERSION = '2024-11-05';

/**
 * The pinned release's serverInfo (src/server.ts, createServer()). These move
 * with the pin: a pin-move PR changes EXPECTED_SERVER_VERSION to the new tag's
 * version, and the smoke at that PR's head is green only after its deploy.
 */
const EXPECTED_SERVER_NAME = 'ckan-mcp-server';
const EXPECTED_SERVER_VERSION = '0.4.139';

/** Tools the pinned release registers: 19 `ckan_*` tools and `sparql_query`. */
const EXPECTED_TOOL_COUNT = 20;

/** The portal the deployment allows (CKAN_ALLOWED_DOMAINS=data.boston.gov). */
const ALLOWED_PORTAL = 'https://data.boston.gov';

/** A real CKAN portal the deployment does not allow. */
const REFUSED_PORTAL = 'https://www.dati.gov.it/opendata';

/** A line of ckan_status_show's answer (src/tools/status.ts, formatStatusMarkdown). */
const STATUS_MARKER = '**CKAN Version**:';

/** In the allowlist refusal: `Domain "<host>" is not in the allowed list (CKAN_ALLOWED_DOMAINS).` */
const REFUSAL_MARKER = 'CKAN_ALLOWED_DOMAINS';

const REQUEST_TIMEOUT_MS = 30_000;
/** Whole-exchange attempts. Retries cover TRANSPORT flakes only — see runExchange(). */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5_000;
/** Cap on echoed response bodies, so one HTML error page can't bury the log. */
const MAX_BODY_CHARS = 2_000;

const USER_AGENT = 'ckan-mcp-deployed-smoke/1 (+https://github.com/npstorey/ckan-mcp-server)';

const endpoint = (process.env.SMOKE_MCP_URL ?? '').trim() || DEFAULT_ENDPOINT;

/**
 * A failure with the evidence attached. `retryable` marks transport-level
 * failures (connection refused, DNS, timeout, 5xx, 429) and exactly one
 * assertion: ckan_status_show answering isError: true for the allowed portal,
 * which `portal` marks (the portal, not this service, may be having a bad
 * minute). Every other assertion failure is NEVER retryable: it is
 * deterministic, and retrying one only delays a red. A portal failure that
 * outlasts the attempts is still a FAIL, but it does not mark the endpoint
 * unreachable, so the later checks still run.
 */
class SmokeFailure extends Error {
  constructor(message, { retryable = false, portal = false, detail = [] } = {}) {
    super(message);
    this.name = 'SmokeFailure';
    this.retryable = retryable;
    this.portal = portal;
    this.detail = detail;
  }
}

function log(line = '') {
  console.log(line === '' ? '' : `[smoke] ${line}`);
}

function truncate(text) {
  if (typeof text !== 'string') return String(text);
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n… [truncated; ${text.length} chars total]`;
}

/** Header lines worth printing on failure. */
function describeHeaders(headers) {
  const interesting = [
    'content-type',
    'mcp-session-id',
    'mcp-protocol-version',
    'www-authenticate',
    'retry-after',
    'server',
    'x-render-routing',
    'rndr-id',
    'cf-ray',
  ];
  return interesting
    .map((name) => [name, headers.get(name)])
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `      ${name}: ${value}`);
}

/**
 * One HTTP POST. Returns the raw response plus timing; converts network errors
 * into a retryable SmokeFailure carrying the request that provoked them.
 */
async function post({ headers, body, label }) {
  const started = Date.now();
  const sentDetail = [
    '  sent:',
    `    POST ${endpoint}`,
    ...Object.entries(headers).map(([k, v]) => `      ${k}: ${v}`),
    '    body:',
    `      ${body}`,
  ];

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    throw new SmokeFailure(
      `${label}: could not reach the endpoint (${error?.name ?? 'Error'}: ${error?.message ?? error})`,
      {
        retryable: true,
        detail: [
          ...sentDetail,
          '  received:',
          `    nothing — the request failed after ${Date.now() - started}ms`,
          `    ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
          ...(error?.cause ? [`    cause: ${error.cause}`] : []),
        ],
      }
    );
  }

  const rawBody = await response.text();
  const ms = Date.now() - started;
  const receivedDetail = [
    '  received:',
    `    HTTP ${response.status} ${response.statusText} (${ms}ms)`,
    '    headers:',
    ...describeHeaders(response.headers),
    `    body (${rawBody.length} chars):`,
    ...truncate(rawBody)
      .split('\n')
      .map((line) => `      ${line}`),
  ];

  return { response, rawBody, ms, sentDetail, receivedDetail };
}

/**
 * Unwrap a JSON-RPC payload from a JSON body or an SSE-framed one. The pinned
 * server sets `enableJsonResponse: true`, so plain JSON is the normal path; SSE
 * is accepted too since the SDK may answer either.
 */
function parseRpcBody(rawBody, { label, sentDetail, receivedDetail }) {
  const dataLines = rawBody
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1] : rawBody;
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new SmokeFailure(`${label}: response body is not valid JSON-RPC (${error.message})`, {
      detail: [...sentDetail, ...receivedDetail],
    });
  }
}

/** Assert, attaching the full request and response so the log explains itself. */
function check(condition, message, round) {
  if (!condition) {
    throw new SmokeFailure(message, {
      detail: [...round.sentDetail, ...round.receivedDetail],
    });
  }
}

/** A non-2xx that is worth retrying (server or edge wobble) rather than failing on. */
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function requestHeaders(version) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(typeof version === 'string' ? { 'mcp-protocol-version': version } : {}),
    'user-agent': USER_AGENT,
  };
}

/**
 * One JSON-RPC request: POST, the transport checks (retryable 5xx/429, HTTP 200),
 * then the JSON-RPC envelope (version, id, no error). Returns { round, result }.
 */
async function rpc({ label, version, id, method, params }) {
  const round = await post({
    label,
    headers: requestHeaders(version),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (isRetryableStatus(round.response.status)) {
    throw new SmokeFailure(
      `${label}: HTTP ${round.response.status} ${round.response.statusText} (transport-level; retryable)`,
      { retryable: true, detail: [...round.sentDetail, ...round.receivedDetail] }
    );
  }
  check(
    round.response.status === 200,
    `${label}: expected HTTP 200, got ${round.response.status} ${round.response.statusText}. ` +
      'A 400 "Unsupported protocol version" here is protocol skew between the client and the deployed SDK; ' +
      'a 403 "Invalid Host header" is CKAN_HTTP_ALLOWED_HOSTS not listing the host this request used.',
    round
  );
  const message = parseRpcBody(round.rawBody, { label, ...round });
  check(message.jsonrpc === '2.0', `${label}: expected jsonrpc "2.0", got ${JSON.stringify(message.jsonrpc)}`, round);
  check(message.id === id, `${label}: response id ${JSON.stringify(message.id)} does not match request id ${id}`, round);
  check(
    message.error === undefined,
    `${label}: server returned a JSON-RPC error: ${JSON.stringify(message.error)}`,
    round
  );
  check(
    message.result !== null && typeof message.result === 'object',
    `${label}: response carries no result object`,
    round
  );
  return { round, result: message.result };
}

/** The text parts of a tool result, joined. */
function toolText(result) {
  return Array.isArray(result.content)
    ? result.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    : '';
}

function describeHeaderMode(version) {
  return version === undefined
    ? 'no MCP-Protocol-Version header on any request'
    : `MCP-Protocol-Version: ${version} on every request`;
}

/** tools/call ckan_status_show, as each exchange and the refused call send it. */
function callStatusShow(label, version, id, serverUrl) {
  log(`→ POST tools/call ckan_status_show (server_url=${serverUrl}; ${describeHeaderMode(version)})`);
  return rpc({
    label,
    version,
    id,
    method: 'tools/call',
    params: { name: 'ckan_status_show', arguments: { server_url: serverUrl } },
  });
}

/**
 * One attempt at an exchange: initialize → tools/list → tools/call. Returns a
 * summary line on success; throws SmokeFailure otherwise.
 */
async function attemptExchange(exchange) {
  const label = (step) => `${exchange.name}: ${step}`;
  const version = exchange.sendHeader ? exchange.requested : undefined;

  // ---- Step 1: initialize --------------------------------------------------
  log(`→ POST initialize (protocolVersion=${exchange.requested}; ${describeHeaderMode(version)})`);
  const init = await rpc({
    label: label('initialize'),
    version,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: exchange.requested,
      capabilities: {},
      clientInfo: { name: 'deployed-endpoint-smoke', version: '1.0.0' },
    },
  });
  const answered = init.result.protocolVersion;
  const serverInfo = init.result.serverInfo ?? {};
  log(`← 200 in ${init.round.ms}ms; protocolVersion answered = ${answered}`);
  log(`  serverInfo = ${serverInfo.name ?? '(no name)'} ${serverInfo.version ?? '(no version)'}`);
  check(
    answered === exchange.requested,
    `${label('initialize')}: sent protocolVersion ${exchange.requested}, got ${JSON.stringify(answered)} back. ` +
      `The SDK in this fork's package-lock.json supports ${exchange.requested} and agrees to a supported requested revision, ` +
      'so the deployed SDK is not the pinned one or no longer supports it.',
    init.round
  );
  check(
    serverInfo.name === EXPECTED_SERVER_NAME,
    `${label('initialize')}: serverInfo.name is ${JSON.stringify(serverInfo.name)}, expected ` +
      `${JSON.stringify(EXPECTED_SERVER_NAME)}: the endpoint is not this server.`,
    init.round
  );
  check(
    serverInfo.version === EXPECTED_SERVER_VERSION,
    `${label('initialize')}: serverInfo.version is ${JSON.stringify(serverInfo.version)}, expected ` +
      `${JSON.stringify(EXPECTED_SERVER_VERSION)}: the deployed code is not the pinned release (PIN.md), ` +
      'or the pin moved and this constant did not.',
    init.round
  );

  // ---- Step 2: tools/list --------------------------------------------------
  // At exchange 2 this request carries MCP-Protocol-Version, which is where the
  // SDK's HTTP transport refuses a revision it does not support.
  log(`→ POST tools/list (${describeHeaderMode(version)})`);
  const list = await rpc({ label: label('tools/list'), version, id: 2, method: 'tools/list', params: {} });
  const tools = list.result.tools;
  check(
    Array.isArray(tools),
    `${label('tools/list')}: expected a tools array, got ${JSON.stringify(list.result)?.slice(0, 300)}`,
    list.round
  );
  log(`← 200 in ${list.round.ms}ms; ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`);
  check(
    tools.length === EXPECTED_TOOL_COUNT,
    `${label('tools/list')}: expected exactly ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}. ` +
      'The pinned release registers 20; a different count means the deployed code is not the pinned release.',
    list.round
  );

  // ---- Step 3: tools/call ckan_status_show on the allowed portal -----------
  const status = await callStatusShow(label('tools/call ckan_status_show'), version, 3, ALLOWED_PORTAL);
  const statusText = toolText(status.result);
  if (status.result.isError === true) {
    // The one retryable assertion (see SmokeFailure).
    throw new SmokeFailure(
      `${label('tools/call ckan_status_show')}: the tool answered isError: true for ${ALLOWED_PORTAL}, ` +
        'the portal the deployment allows. Read its text below: the portal may be down, or ' +
        'CKAN_ALLOWED_DOMAINS may no longer list it.',
      { retryable: true, portal: true, detail: [...status.round.sentDetail, ...status.round.receivedDetail] }
    );
  }
  check(
    statusText.includes(STATUS_MARKER),
    `${label('tools/call ckan_status_show')}: the tool's text does not carry ${JSON.stringify(STATUS_MARKER)}.`,
    status.round
  );
  log(`← 200 in ${status.round.ms}ms; ${statusText.split('\n').find((l) => l.includes(STATUS_MARKER))}`);

  return (
    `${exchange.name}: initialize at ${exchange.requested} answered ${answered}; ` +
    `serverInfo ${serverInfo.name} ${serverInfo.version}; tools/list ${tools.length} tools; ` +
    `ckan_status_show on ${ALLOWED_PORTAL} answered`
  );
}

/** The refused call: one tools/call in exchange 2's form, to a portal outside the allowlist. */
async function attemptRefusal(refusal) {
  const label = `${refusal.name}: tools/call ckan_status_show`;
  const refused = await callStatusShow(label, refusal.version, 1, REFUSED_PORTAL);
  const text = toolText(refused.result);
  check(
    refused.result.isError === true,
    `${label}: ${REFUSED_PORTAL} is outside CKAN_ALLOWED_DOMAINS, so the tool must answer isError: true; ` +
      `it answered isError: ${JSON.stringify(refused.result.isError)}. The deployment's domain allowlist ` +
      'is not set as PIN.md records it.',
    refused.round
  );
  check(
    text.includes(REFUSAL_MARKER),
    `${label}: the tool error does not name ${REFUSAL_MARKER}; it is not the allowlist refusal.`,
    refused.round
  );
  log(`← 200 in ${refused.round.ms}ms; isError: true; ${text.split('\n').find((l) => l.includes(REFUSAL_MARKER))}`);
  return `${refusal.name}: ckan_status_show on ${REFUSED_PORTAL} refused (isError, ${REFUSAL_MARKER})`;
}

/**
 * The checks, in order. `sendHeader` says whether each request carries
 * MCP-Protocol-Version at the requested revision.
 */
const CHECKS = [
  {
    name: "the website's handshake",
    run: () => attemptExchange({ name: "the website's handshake", requested: APP_PROTOCOL_VERSION, sendHeader: false }),
  },
  {
    name: 'current client',
    run: () => attemptExchange({ name: 'current client', requested: PROTOCOL_VERSION, sendHeader: true }),
  },
  {
    name: 'refused call',
    run: () => attemptRefusal({ name: 'refused call', version: PROTOCOL_VERSION }),
  },
];

/**
 * One check with retries. Retries cover transport flakes and the allowed
 * portal's status failure only; any other assertion failure is returned at
 * once. Resolves to { ok, summary | failure }.
 */
async function runCheck(entry) {
  let lastFailure;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    log(`attempt ${n}/${MAX_ATTEMPTS}`);
    try {
      return { ok: true, summary: await entry.run() };
    } catch (error) {
      if (!(error instanceof SmokeFailure)) throw error;
      lastFailure = error;
      if (error.retryable && n < MAX_ATTEMPTS) {
        log(`attempt ${n} failed (retryable): ${error.message}`);
        log(`retrying in ${RETRY_BACKOFF_MS / 1000}s…`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
        log();
        continue;
      }
      break;
    }
  }
  return { ok: false, failure: lastFailure };
}

async function main() {
  log(`target   : ${endpoint}${endpoint === DEFAULT_ENDPOINT ? ' (default)' : ' (SMOKE_MCP_URL)'}`);
  log(`protocol : ${PROTOCOL_VERSION}; the website's ${APP_PROTOCOL_VERSION}`);
  log(`expects  : ${EXPECTED_SERVER_NAME} ${EXPECTED_SERVER_VERSION}, ${EXPECTED_TOOL_COUNT} tools`);
  log(`node     : ${process.version}`);
  log(`started  : ${new Date().toISOString()}`);

  const results = [];
  for (const [i, entry] of CHECKS.entries()) {
    log();
    log(`== ${i + 1}/${CHECKS.length}: ${entry.name} ==`);
    const result = await runCheck(entry);
    results.push({ entry, ...result });
    // Unreachable after its retries: the rest would only repeat the same wait.
    // A portal failure is not the endpoint being unreachable; the rest still run.
    if (!result.ok && result.failure.retryable && !result.failure.portal) {
      for (const skipped of CHECKS.slice(i + 1)) {
        results.push({ entry: skipped, ok: false, skipped: true });
      }
      break;
    }
  }

  log();
  for (const result of results) {
    const verdict = result.ok ? 'PASS' : result.skipped ? 'NOT RUN (endpoint unreachable)' : 'FAIL';
    log(`${verdict} — ${result.ok ? result.summary : result.entry.name}`);
  }

  if (results.every((result) => result.ok)) {
    log();
    log(`PASS — all ${CHECKS.length} checks`);
    return 0;
  }

  for (const { failure } of results.filter((result) => !result.ok && !result.skipped)) {
    log();
    log(`FAIL — ${failure.message}`);
    log();
    for (const line of failure.detail) log(line);
  }
  log();
  log(`endpoint  : ${endpoint}`);
  log('background: the deployment is recorded in PIN.md and render.yaml. Check the');
  log('            service in the host dashboard (its branch, NODE_VERSION and');
  log('            CKAN_* variables) before assuming a code problem.');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    log();
    log(`FAIL — unexpected error in the smoke itself: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
