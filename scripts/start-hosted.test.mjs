// Tests for scripts/start-hosted.mjs. Run: node --test scripts/start-hosted.test.mjs
// Needs no build, no server, no port and no network: the decision is a pure function,
// the filter is installed on a stand-in stream, never on this process's stderr, and
// the fatal-error cases that need a real process run in a child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FATAL_LINE,
  KNOWN_PREFIXES,
  WITHHELD_LINE,
  createFatalHandler,
  decideStderrWrite,
  installStderrFilter,
} from './start-hosted.mjs';

/** A stand-in for process.stderr (a Writable, as it is) that records what reaches it. */
function captureStream({ filter = true } = {}) {
  const written = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString('utf8'));
      callback();
    },
  });
  if (filter) installStderrFilter(stream);
  return { stream, written };
}

// The pinned server's lines, written as src/utils/http.ts writes them.
const AUDIT_Q =
  JSON.stringify({
    ts: '2026-11-12T00:00:00.000Z',
    server: 'https://data.boston.gov',
    action: 'package_search',
    cache_hit: false,
    q: 'probe-term-in-q',
    rows: 10,
  }) + '\n';
const AUDIT_FQ =
  JSON.stringify({
    ts: '2026-11-12T00:00:00.000Z',
    server: 'https://data.boston.gov',
    action: 'package_search',
    cache_hit: true,
    fq: 'organization:probe-term-in-fq',
  }) + '\n';
const AUDIT_SQL =
  JSON.stringify({
    ts: '2026-11-12T00:00:00.000Z',
    server: 'https://data.boston.gov',
    action: 'datastore_search_sql',
    cache_hit: false,
    sql: 'SELECT * FROM "probe-term-in-sql" LIMIT 5',
  }) + '\n';
const SUCCESS_FALSE =
  `[ckan] success=false action=package_show: ${JSON.stringify({
    success: false,
    error: { message: 'Not found: probe-term-in-portal-body' },
  })}\n`;

const START_LINE = 'CKAN MCP server running on http://0.0.0.0:10000/mcp\n';
const SECURITY_WARNING =
  '[SECURITY WARNING] HTTP transport is running WITHOUT a domain allowlist ' +
  '(CKAN_HTTP_ALLOW_ALL=true). Any client can drive requests to arbitrary hosts. ' +
  'Set CKAN_ALLOWED_DOMAINS to restrict which CKAN hosts can be queried.\n';

const WITHHELD = [
  ['an audit line carrying q', AUDIT_Q, 'probe-term-in-q'],
  ['an audit line carrying fq', AUDIT_FQ, 'probe-term-in-fq'],
  ['an audit line carrying sql', AUDIT_SQL, 'probe-term-in-sql'],
  ['the [ckan] success=false line', SUCCESS_FALSE, 'probe-term-in-portal-body'],
  ['an unknown line', 'some-dependency: a line this file does not know probe-term-unknown\n', 'probe-term-unknown'],
];

for (const [name, line, secret] of WITHHELD) {
  test(`${name} is withheld, and nothing of it is written`, () => {
    assert.equal(decideStderrWrite(line), 'withhold');
    const { stream, written } = captureStream();
    stream.write(line);
    assert.deepEqual(written, [WITHHELD_LINE]);
    const out = written.join('');
    assert.equal(out.includes(secret), false, `"${secret}" reached the stream`);
    assert.equal(out.includes('data.boston.gov'), false, 'the portal host reached the stream');
  });
}

test('a withheld write given as bytes is withheld too', () => {
  const { stream, written } = captureStream();
  stream.write(Buffer.from(AUDIT_Q, 'utf8'));
  assert.deepEqual(written, [WITHHELD_LINE]);
});

test('a write that is neither text nor bytes is withheld', () => {
  assert.equal(decideStderrWrite(undefined), 'withhold');
  assert.equal(decideStderrWrite(null), 'withhold');
});

test('the start line passes unchanged', () => {
  assert.equal(decideStderrWrite(START_LINE), 'pass');
  const { stream, written } = captureStream();
  stream.write(START_LINE);
  assert.deepEqual(written, [START_LINE]);
});

test('a [SECURITY WARNING] line passes unchanged', () => {
  assert.equal(decideStderrWrite(SECURITY_WARNING), 'pass');
  const { stream, written } = captureStream();
  stream.write(SECURITY_WARNING);
  assert.deepEqual(written, [SECURITY_WARNING]);
});

test('a Server error: write, made by console.error as src/index.ts makes it, passes unchanged as one write', () => {
  const { stream, written } = captureStream();
  const console_ = new Console({ stdout: stream, stderr: stream });
  const error = new Error('Refusing to start HTTP transport without a domain allowlist.');
  console_.error('Server error:', error);
  assert.equal(written.length, 1);
  assert.ok(written[0].startsWith('Server error: Error: Refusing to start HTTP transport'));
});

test('the callback of a withheld write is still called', async () => {
  const { stream, written } = captureStream();
  await new Promise((resolve) => stream.write(AUDIT_Q, resolve));
  await new Promise((resolve) => stream.write(AUDIT_FQ, 'utf8', resolve));
  assert.deepEqual(written, [WITHHELD_LINE, WITHHELD_LINE]);
});

test('the known lines are exactly the three operational prefixes and the allowlist line (an allowlist, not an audit pattern)', () => {
  assert.deepEqual([...KNOWN_PREFIXES], [
    'CKAN MCP server running on ',
    '[SECURITY WARNING] ',
    'Server error:',
    '[start-hosted] allowlist: ',
  ]);
  for (const prefix of KNOWN_PREFIXES) {
    assert.equal(prefix.startsWith('{'), false);
    assert.equal(prefix.startsWith('[ckan]'), false);
  }
});

test('the withheld line holds nothing of what it replaces', () => {
  assert.equal(WITHHELD_LINE, '[start-hosted] 1 log write withheld\n');
});

test('importing the file starts nothing and leaves process.stderr alone', async () => {
  const before = process.stderr.write;
  const listeners = process.listenerCount('uncaughtException');
  await import('./start-hosted.mjs');
  assert.equal(process.stderr.write, before);
  assert.equal(process.listenerCount('uncaughtException'), listeners);
});

// Fatal errors. Node prints an uncaught exception's report itself, outside
// process.stderr.write; the handler replaces it with one fixed line.
const MARKER = 'probe-term-in-fatal-error';

test('the fatal handler writes one fixed line holding nothing of the error, then exits 1', () => {
  // Unfiltered, as the entry point gives it the raw write: the handler alone must withhold.
  const { stream, written } = captureStream({ filter: false });
  const exits = [];
  const error = new Error(`portal answered for q=${MARKER}`);
  error.stack = `Error: ${MARKER}\n    at handler (file:///app/${MARKER}.js:1:1)`;
  createFatalHandler(stream, (code) => exits.push(code))(error);
  assert.deepEqual(written, [FATAL_LINE]);
  assert.equal(written.join('').includes(MARKER), false, 'the marker reached the stream');
  assert.equal(written.join('').includes('Error'), false, 'the error name reached the stream');
  assert.deepEqual(exits, [1]);
});

for (const [kind, body] of [
  ['an uncaught exception', `setTimeout(() => { throw new Error(${JSON.stringify(MARKER)}); }, 0);`],
  ['an unhandled rejection', `Promise.reject(new Error(${JSON.stringify(MARKER)}));`],
]) {
  test(`in a child process, ${kind} is withheld and the process exits 1`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'start-hosted-fatal-'));
    try {
      const script = join(dir, 'fatal.mjs');
      const moduleUrl = new URL('./start-hosted.mjs', import.meta.url).href;
      writeFileSync(
        script,
        `import { installHostedHandlers } from ${JSON.stringify(moduleUrl)};\ninstallHostedHandlers();\n${body}\n`
      );
      const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(child.error, undefined, `spawn failed: ${child.error}`);
      assert.equal(child.stderr.includes(FATAL_LINE), true, `stderr was: ${JSON.stringify(child.stderr)}`);
      assert.equal(child.stderr.includes(MARKER), false, 'the marker reached stderr');
      assert.equal(child.stdout.includes(MARKER), false, 'the marker reached stdout');
      assert.equal(child.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The allowlist. The entry point sets CKAN_ALLOWED_DOMAINS from
// scripts/allowed-domains.txt before it imports the server, and the file wins
// over a value already set on the host. These cases run the entry point itself
// in a child process: a copy of the start files in a temporary folder, beside a
// stand-in dist/index.js that records the variable it was loaded with. No build,
// no port, no network.
const ALLOWLIST_PREFIX = '[start-hosted] allowlist: ';
const SCRIPT_FILES = ['start-hosted.mjs', 'allowed-domains.mjs'];
const LIST_HOSTS = ['a.example', 'b.example', 'data.boston.gov'];
const LIST_TEXT = `# a comment line\n${LIST_HOSTS.join('\n')}\n`;

function runEntry({ list, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'start-hosted-allowlist-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    for (const name of SCRIPT_FILES) {
      const from = fileURLToPath(new URL(`./${name}`, import.meta.url));
      if (existsSync(from)) copyFileSync(from, join(dir, 'scripts', name));
    }
    if (list !== undefined) writeFileSync(join(dir, 'scripts', 'allowed-domains.txt'), list);
    const seenPath = join(dir, 'loaded.json');
    writeFileSync(
      join(dir, 'dist', 'index.js'),
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ CKAN_ALLOWED_DOMAINS: process.env.CKAN_ALLOWED_DOMAINS ?? null }));\n`
    );
    const child = spawnSync(process.execPath, [join(dir, 'scripts', 'start-hosted.mjs')], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    assert.equal(child.error, undefined, `spawn failed: ${child.error}`);
    const loaded = existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, 'utf8')) : null;
    const lines = child.stderr.split('\n').filter((line) => line !== '');
    return { child, loaded, lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The one allowlist line, holding no host from the file or the environment. */
function assertOneAllowlistLine(lines, hidden) {
  assert.equal(lines.length, 1, `stderr was: ${JSON.stringify(lines)}`);
  const [line] = lines;
  assert.ok(line.startsWith(ALLOWLIST_PREFIX), `not the allowlist line: ${JSON.stringify(line)}`);
  assert.equal(decideStderrWrite(`${line}\n`), 'pass', 'the filter withholds the allowlist line');
  for (const host of hidden) {
    assert.equal(line.includes(host), false, `the line prints "${host}"`);
  }
  return line;
}

test('with CKAN_ALLOWED_DOMAINS also set, the file wins: the server loads with the file\'s hosts, and one known line says so, printing no host', () => {
  const { child, loaded, lines } = runEntry({
    list: LIST_TEXT,
    env: { CKAN_ALLOWED_DOMAINS: 'dashboard-only.example' },
  });
  assert.deepEqual(loaded, { CKAN_ALLOWED_DOMAINS: LIST_HOSTS.join(',') });
  assert.equal(child.status, 0, `exit ${child.status}`);
  const line = assertOneAllowlistLine(lines, [...LIST_HOSTS, 'dashboard-only.example']);
  assert.match(line, /CKAN_ALLOWED_DOMAINS/);
  assert.match(line, /ignored/);
  assert.match(line, /\b3 hosts\b/);
});

test('without CKAN_ALLOWED_DOMAINS, the server loads with the file\'s hosts, and one known line says where they came from', () => {
  const { child, loaded, lines } = runEntry({ list: LIST_TEXT });
  assert.deepEqual(loaded, { CKAN_ALLOWED_DOMAINS: LIST_HOSTS.join(',') });
  assert.equal(child.status, 0, `exit ${child.status}`);
  const line = assertOneAllowlistLine(lines, LIST_HOSTS);
  assert.match(line, /\b3 hosts\b/);
  assert.equal(/ignored/.test(line), false, 'the line says a variable was ignored when none was set');
});

for (const [name, list] of [
  ['the file is missing', undefined],
  ['the file holds no host', '# only comments\n\n'],
  ['a line is not a host name', 'a.example\nhttps://secret-marker.example/path\n'],
]) {
  test(`when ${name}, it refuses to start: the server is never loaded, one known line says so, exit 1`, () => {
    const { child, loaded, lines } = runEntry({ list, env: { CKAN_ALLOWED_DOMAINS: 'data.boston.gov' } });
    assert.equal(loaded, null, 'the server was loaded');
    assert.equal(child.status, 1, `exit ${child.status}`);
    const line = assertOneAllowlistLine(lines, ['data.boston.gov', 'a.example', 'secret-marker']);
    assert.match(line, /refusing to start/);
  });
}

test('the committed list is what the entry point reads: it sets CKAN_ALLOWED_DOMAINS from it, every host once', async () => {
  const mod = await import('./start-hosted.mjs');
  assert.equal(typeof mod.applyAllowedDomains, 'function', 'start-hosted.mjs exports no applyAllowedDomains');
  const env = { CKAN_ALLOWED_DOMAINS: 'data.boston.gov' };
  const result = mod.applyAllowedDomains({ env });
  assert.equal(result.ok, true, result.line);
  const hosts = env.CKAN_ALLOWED_DOMAINS.split(',');
  assert.ok(hosts.length > 1, 'the committed list holds one host or none');
  assert.equal(new Set(hosts).size, hosts.length, 'a host is listed twice');
  assert.ok(hosts.includes('data.boston.gov'));
  assert.ok(result.line.startsWith(ALLOWLIST_PREFIX));
});

test('importing the file sets no variable', async () => {
  const before = process.env.CKAN_ALLOWED_DOMAINS;
  await import('./start-hosted.mjs');
  assert.equal(process.env.CKAN_ALLOWED_DOMAINS, before);
});
