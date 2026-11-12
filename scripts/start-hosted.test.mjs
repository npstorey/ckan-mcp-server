// Tests for scripts/start-hosted.mjs. Run: node --test scripts/start-hosted.test.mjs
// Needs no build, no server, no port and no network: the decision is a pure function,
// the filter is installed on a stand-in stream, never on this process's stderr, and
// the fatal-error cases that need a real process run in a child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('the known lines are exactly the three operational prefixes (an allowlist, not an audit pattern)', () => {
  assert.deepEqual([...KNOWN_PREFIXES], ['CKAN MCP server running on ', '[SECURITY WARNING] ', 'Server error:']);
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
