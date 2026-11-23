// Tests for scripts/smoke-deployed-endpoint.mjs, against a stand-in for the deployed
// server. Run: node --test scripts/smoke-deployed-endpoint.test.mjs
//
// No port and no network. Each case runs the smoke as it runs in its workflow, in a
// child process, from a copy of its files in a temporary folder (the list file and
// the server's portal table beside it), with `--import` of a module that replaces
// global fetch before the smoke starts. The stand-in answers initialize, tools/list
// and ckan_status_show as the pinned server does (src/tools/status.ts; the refusal
// text of validateServerUrl, src/utils/http.ts), refusing every host outside the
// set it is given, and counts the requests it receives. The endpoint is a `.invalid`
// name, which never resolves, so a request the stand-in did not catch cannot leave.
//
// Only the deployed run proves the refused call (F1) and the sample (F2) against
// the real service: the smoke workflow's dispatch after the deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const COMMITTED_LIST = join(SCRIPTS, 'allowed-domains.txt');
const COMMITTED_PORTALS = fileURLToPath(new URL('../src/portals.json', import.meta.url));

/** The smoke's sample and refused portal, as the smoke names them. */
const BOSTON = 'data.boston.gov';
const SAMPLE = [
  ['open.canada.ca', 'open.canada.ca'],
  ['data.stadt-zuerich.ch', 'data.stadt-zuerich.ch'],
  ['data.gov.ua', 'data.gov.ua'],
  ['dati.arpae.it', 'dati.arpae.it'],
];
const REFUSED_HOST = 'bdap-opendata.rgs.mef.gov.it';

const STUB_FETCH = `
import { appendFileSync } from 'node:fs';
const config = JSON.parse(process.env.SMOKE_STUB_CONFIG);
const allowed = new Set(config.allowed);
const down = new Set(config.down ?? []);
function result(message) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'ckan-mcp-server', version: '0.4.146' },
    };
  }
  if (message.method === 'tools/list') {
    return { tools: Array.from({ length: 20 }, (_, i) => ({ name: 'tool_' + i, inputSchema: { type: 'object' } })) };
  }
  const serverUrl = message.params.arguments.server_url;
  const host = new URL(serverUrl).hostname.toLowerCase();
  const offline = 'Server appears to be offline or not a valid CKAN instance:\\n';
  if (!allowed.has(host)) {
    return { content: [{ type: 'text', text: offline + 'Domain "' + host + '" is not in the allowed list (CKAN_ALLOWED_DOMAINS).' }], isError: true };
  }
  if (down.has(host)) {
    return { content: [{ type: 'text', text: offline + 'Request timeout connecting to ' + serverUrl + '\\n→ No CKAN API answered at this address.' }], isError: true };
  }
  return { content: [{ type: 'text', text: '# CKAN Server Status\\n\\n**Server**: ' + serverUrl + '\\n**Status**: ✅ Online\\n**CKAN Version**: 2.10.4\\n' }] };
}
globalThis.fetch = async (url, init) => {
  const message = JSON.parse(init.body);
  appendFileSync(config.calls, JSON.stringify({ url: String(url), method: message.method, server_url: message.params?.arguments?.server_url ?? null }) + '\\n');
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result(message) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
`;

/** The test's own reading of a list file, independent of the smoke's parser. */
function hostsOf(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

function committedListText() {
  assert.ok(existsSync(COMMITTED_LIST), 'scripts/allowed-domains.txt is absent');
  return readFileSync(COMMITTED_LIST, 'utf8');
}

/**
 * Run the smoke from a copy, with `list` as its list file and `portals` as the
 * server's portal table, against a stand-in that allows `allowed` and answers a
 * portal failure for `down`. Returns the exit status, stdout and the requests.
 */
function runSmoke({ list, portals = readFileSync(COMMITTED_PORTALS, 'utf8'), allowed, down = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-stub-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'src'));
    for (const name of ['smoke-deployed-endpoint.mjs', 'allowed-domains.mjs']) {
      if (existsSync(join(SCRIPTS, name))) copyFileSync(join(SCRIPTS, name), join(dir, 'scripts', name));
    }
    writeFileSync(join(dir, 'scripts', 'allowed-domains.txt'), list);
    writeFileSync(join(dir, 'src', 'portals.json'), portals);
    const stub = join(dir, 'stub-fetch.mjs');
    writeFileSync(stub, STUB_FETCH);
    const calls = join(dir, 'calls.jsonl');
    const child = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(stub).href, join(dir, 'scripts', 'smoke-deployed-endpoint.mjs')],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '',
          SMOKE_MCP_URL: 'https://smoke-stub.invalid/mcp',
          SMOKE_STUB_CONFIG: JSON.stringify({ allowed, down, calls }),
        },
      }
    );
    assert.equal(child.error, undefined, `spawn failed: ${child.error}`);
    const requests = existsSync(calls)
      ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, requests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function show(run) {
  return `exit ${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
}

test('at the committed list, the pre-flight passes and every check passes against a server that allows that list', () => {
  const list = committedListText();
  const run = runSmoke({ list, allowed: hostsOf(list) });
  assert.equal(run.status, 0, show(run));
  assert.match(run.stdout, /\[smoke\] pre-flight: pass/, show(run));
  assert.match(run.stdout, /\[smoke\] PASS — all 4 checks/, show(run));
  for (const [id, host] of SAMPLE) {
    assert.ok(
      run.stdout.includes(`${id} (${host}): answered`),
      `the sample line for ${id} is missing:\n${show(run)}`
    );
  }
  const sampled = run.requests.filter((r) => r.server_url && SAMPLE.some(([, host]) => r.server_url === `https://${host}`));
  assert.equal(sampled.length, SAMPLE.length, 'each sampled portal is called once');
  assert.ok(run.requests.some((r) => r.server_url === `https://${REFUSED_HOST}/SpodCkanApi`), 'the refused call was not sent');
});

test('the pre-flight fails, before any request, when the refused host is in the list file', () => {
  const list = `${committedListText()}${REFUSED_HOST}\n`;
  const run = runSmoke({ list, allowed: hostsOf(list) });
  assert.equal(run.status, 1, show(run));
  assert.deepEqual(run.requests, [], 'a request was sent after a failed pre-flight');
  assert.match(run.stdout, /pre-flight/, show(run));
  assert.ok(run.stdout.includes(REFUSED_HOST), show(run));
});

test('the pre-flight fails, before any request, when a sampled portal is not in the list file', () => {
  const list = committedListText().replace(/^open\.canada\.ca\n/m, '');
  assert.equal(hostsOf(list).includes('open.canada.ca'), false, 'the fixture edit did not apply');
  const run = runSmoke({ list, allowed: hostsOf(list) });
  assert.equal(run.status, 1, show(run));
  assert.deepEqual(run.requests, [], 'a request was sent after a failed pre-flight');
  assert.ok(run.stdout.includes('open.canada.ca'), show(run));
});

test('the pre-flight fails, before any request, when the server\'s portal table sends a listed host to the refused host', () => {
  const list = committedListText();
  const portals = JSON.parse(readFileSync(COMMITTED_PORTALS, 'utf8'));
  portals.portals.push({ id: 'decoy', name: 'decoy', api_url: `https://${REFUSED_HOST}/SpodCkanApi`, api_url_aliases: [`https://${BOSTON}`] });
  const run = runSmoke({ list, portals: JSON.stringify(portals), allowed: hostsOf(list) });
  assert.equal(run.status, 1, show(run));
  assert.deepEqual(run.requests, [], 'a request was sent after a failed pre-flight');
  assert.ok(run.stdout.includes(REFUSED_HOST), show(run));
});

test('F2 is red when the server refuses a sampled portal by the allowlist, and the failure names the portal\'s directory id', () => {
  const list = committedListText();
  const allowed = hostsOf(list).filter((host) => host !== 'data.gov.ua');
  const run = runSmoke({ list, allowed });
  assert.equal(run.status, 1, show(run));
  assert.match(run.stdout, /FAIL — .*data\.gov\.ua/, show(run));
  assert.match(run.stdout, /\[smoke\] PASS — refused call/, show(run));
});

test('F2 stays green when a sampled portal fails on its own, and the log reports the failure', () => {
  const list = committedListText();
  const run = runSmoke({ list, allowed: hostsOf(list), down: ['dati.arpae.it'] });
  assert.equal(run.status, 0, show(run));
  assert.match(run.stdout, /dati\.arpae\.it \(dati\.arpae\.it\): portal failure, reported/, show(run));
  assert.match(run.stdout, /\[smoke\] PASS — all 4 checks/, show(run));
});

test('F1 is red when the server does not refuse the refused portal', () => {
  const list = committedListText();
  const run = runSmoke({ list, allowed: [...hostsOf(list), REFUSED_HOST] });
  assert.equal(run.status, 1, show(run));
  assert.match(run.stdout, /FAIL — refused call/, show(run));
});

test('Boston must still answer: a server that refuses data.boston.gov turns both exchanges red', () => {
  const list = committedListText();
  const run = runSmoke({ list, allowed: hostsOf(list).filter((host) => host !== BOSTON) });
  assert.equal(run.status, 1, show(run));
  assert.match(run.stdout, /FAIL — the website's handshake/, show(run));
  assert.match(run.stdout, /FAIL — current client/, show(run));
});
