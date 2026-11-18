// Tests for scripts/generate-allowed-domains.mjs, its parser scripts/allowed-domains.mjs,
// and the committed list scripts/allowed-domains.txt.
// Run: node --test scripts/generate-allowed-domains.test.mjs
// No network and no port: the generator reads a fixture directory from a file
// (--directory-file) and runs in a child process, as it is run by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR = fileURLToPath(new URL('./generate-allowed-domains.mjs', import.meta.url));
const PARSER_URL = new URL('./allowed-domains.mjs', import.meta.url).href;
const LIST_PATH = fileURLToPath(new URL('./allowed-domains.txt', import.meta.url));
const FAKE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

/**
 * A small directory in the website's shape: active rows and others; an API host
 * equal to the site host and one that differs; no API endpoint; a URL with a path;
 * an upper-case host with a port; two rows on one host.
 */
const FIXTURE_ROWS = [
  { id: 'same-host', status: 'active', url: 'https://data.example.org', api_endpoint: 'https://data.example.org/api/3' },
  { id: 'api-elsewhere', status: 'active', url: 'https://portal.example.net', api_endpoint: 'https://ckan.example.net/api/3' },
  { id: 'no-api', status: 'active', url: 'http://open.example.com', api_endpoint: '' },
  { id: 'url-with-path', status: 'active', url: 'https://www.example.it/opendata', api_endpoint: 'https://www.example.it/opendata/api/3' },
  { id: 'upper-case-and-port', status: 'active', url: 'HTTPS://Data.Example.EDU:8443/catalog', api_endpoint: '' },
  { id: 'second-row-same-host', status: 'active', url: 'https://data.example.org/other', api_endpoint: '' },
  { id: 'inactive', status: 'inactive', url: 'https://gone.example.org', api_endpoint: 'https://gone-api.example.org/api/3' },
  { id: 'deprecated', status: 'deprecated', url: 'https://old.example.org', api_endpoint: '' },
  { id: 'blank-status', status: '', url: 'https://unknown.example.org', api_endpoint: '' },
];

/** The hosts (a)'s rule gives for FIXTURE_ROWS, sorted. */
const FIXTURE_HOSTS = [
  'ckan.example.net',
  'data.example.edu',
  'data.example.org',
  'open.example.com',
  'portal.example.net',
  'www.example.it',
];

/** The test's own reading of a list file, independent of the parser under test. */
function hostsOf(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'allowed-domains-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function generate(args) {
  const child = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.error, undefined, `spawn failed: ${child.error}`);
  return child;
}

function writeFixture(dir, rows = FIXTURE_ROWS) {
  const path = join(dir, 'ckan.json');
  writeFileSync(path, JSON.stringify(rows, null, 2) + '\n');
  return path;
}

function generateFixture(dir, { rows, out = join(dir, 'list.txt'), extra = [] } = {}) {
  const directory = writeFixture(dir, rows);
  const child = generate(['--commit', FAKE_COMMIT, '--directory-file', directory, '--out', out, ...extra]);
  return { child, out, directory };
}

async function loadParser() {
  try {
    return await import(PARSER_URL);
  } catch (error) {
    assert.fail(`scripts/allowed-domains.mjs could not be imported (${error?.code ?? error?.name})`);
  }
}

test('the generator writes the hosts of the active rows: the site host, the API host where it differs, sorted, once each', () => {
  withTempDir((dir) => {
    const { child, out } = generateFixture(dir);
    assert.equal(child.status, 0, `the generator exited ${child.status}: ${child.stderr}`);
    assert.deepEqual(hostsOf(readFileSync(out, 'utf8')), FIXTURE_HOSTS);
  });
});

test('the file states the directory, its commit, blob and sha256, the rule and the counts', () => {
  withTempDir((dir) => {
    const { child, out, directory } = generateFixture(dir);
    assert.equal(child.status, 0, `the generator exited ${child.status}: ${child.stderr}`);
    const bytes = readFileSync(directory);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const text = readFileSync(out, 'utf8');
    for (const line of [
      '# Directory: data/portals/ckan.json in https://github.com/npstorey/civic-ai-tools-website',
      `# Commit:    ${FAKE_COMMIT}`,
      `# Blob:      ${blob}`,
      `# SHA-256:   ${sha256}`,
      '# Rule:      every row whose status is "active": the host of its url and,',
      '#            where api_endpoint is set, the host of api_endpoint.',
      '# Rows:      9, of which 6 active',
      '# Hosts:     6 from the directory, 0 extra',
    ]) {
      assert.ok(text.split('\n').includes(line), `missing line: ${line}`);
    }
    assert.ok(text.endsWith('\n'), 'the file ends with a newline');
    assert.equal(text.includes('\r'), false, 'the file has LF line ends only');
  });
});

test('two runs over the same directory write the same bytes', () => {
  withTempDir((dir) => {
    const first = generateFixture(dir, { out: join(dir, 'first.txt') });
    const second = generateFixture(dir, { out: join(dir, 'second.txt') });
    assert.equal(first.child.status, 0, first.child.stderr);
    assert.equal(second.child.status, 0, second.child.stderr);
    assert.equal(readFileSync(first.out, 'utf8'), readFileSync(second.out, 'utf8'));
  });
});

test('the extra hosts section is carried over from the file being replaced, and counted', () => {
  withTempDir((dir) => {
    const { child, out } = generateFixture(dir);
    assert.equal(child.status, 0, child.stderr);
    const block = '# Why: a listed portal redirects here (a measured example).\nextra.example.org\n';
    const edited = readFileSync(out, 'utf8').replace('# END EXTRA HOSTS\n', `${block}# END EXTRA HOSTS\n`);
    assert.notEqual(edited, readFileSync(out, 'utf8'), 'the fixture edit did not apply');
    writeFileSync(out, edited);
    const again = generateFixture(dir, { out });
    assert.equal(again.child.status, 0, again.child.stderr);
    const text = readFileSync(out, 'utf8');
    assert.ok(text.includes(`${block}# END EXTRA HOSTS\n`), 'the extra block was not carried over verbatim');
    assert.deepEqual([...hostsOf(text)].sort(), [...FIXTURE_HOSTS, 'extra.example.org'].sort());
    assert.ok(text.split('\n').includes('# Hosts:     6 from the directory, 1 extra'));
  });
});

test('an extra host that the directory also gives stops the generator, and the file is left as it was', () => {
  withTempDir((dir) => {
    const { child, out } = generateFixture(dir);
    assert.equal(child.status, 0, child.stderr);
    const edited = readFileSync(out, 'utf8').replace('# END EXTRA HOSTS\n', 'data.example.org\n# END EXTRA HOSTS\n');
    writeFileSync(out, edited);
    const again = generateFixture(dir, { out });
    assert.notEqual(again.child.status, 0, 'the generator accepted an extra host the directory gives');
    assert.match(again.child.stderr, /data\.example\.org/);
    assert.equal(readFileSync(out, 'utf8'), edited);
  });
});

test('an active row whose url is not an http(s) URL stops the generator, and nothing is written', () => {
  withTempDir((dir) => {
    const rows = [...FIXTURE_ROWS, { id: 'broken-row', status: 'active', url: 'not a url', api_endpoint: '' }];
    const out = join(dir, 'list.txt');
    const { child } = generateFixture(dir, { rows, out });
    assert.notEqual(child.status, 0, 'the generator accepted a row with no URL');
    assert.match(child.stderr, /broken-row/);
    assert.equal(existsSync(out), false, 'a file was written');
  });
});

test('--check exits 0 when the file is what the generator writes, 1 when it differs', () => {
  withTempDir((dir) => {
    const { child, out } = generateFixture(dir);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(generateFixture(dir, { out, extra: ['--check'] }).child.status, 0);
    writeFileSync(out, readFileSync(out, 'utf8').replace('open.example.com\n', ''));
    const changed = readFileSync(out, 'utf8');
    assert.equal(generateFixture(dir, { out, extra: ['--check'] }).child.status, 1);
    assert.equal(readFileSync(out, 'utf8'), changed, '--check wrote the file');
  });
});

test('the parser reads one host per line, skips comments, and refuses what the server would not compare equal', async () => {
  const { parseAllowedDomains } = await loadParser();
  assert.equal(typeof parseAllowedDomains, 'function');
  assert.deepEqual(parseAllowedDomains('# a comment\n\na.example\n  b.example  # tail\n128.199.41.97\n'), [
    'a.example',
    'b.example',
    '128.199.41.97',
  ]);
  for (const bad of ['https://a.example', 'A.example', 'a.example:8080', 'a.example,b.example', 'a.example/path', 'a b']) {
    assert.throws(() => parseAllowedDomains(`ok.example\n${bad}\n`), /line 2/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseAllowedDomains('a.example\na.example\n'), /line 2/, 'accepted a duplicate');
  assert.throws(
    () => parseAllowedDomains('ok.example\nhttps://secret-marker.example/x\n'),
    (error) => !String(error.message).includes('secret-marker'),
    'the error carries the line'
  );
});

test('the committed list: it parses, data.boston.gov is in it, www.dati.gov.it is not, and its header counts agree', async () => {
  assert.ok(existsSync(LIST_PATH), 'scripts/allowed-domains.txt is absent');
  const text = readFileSync(LIST_PATH, 'utf8');
  const { parseAllowedDomains } = await loadParser();
  const hosts = parseAllowedDomains(text);
  assert.deepEqual(hosts, hostsOf(text));
  assert.ok(hosts.includes('data.boston.gov'), 'data.boston.gov is not listed');
  assert.equal(hosts.includes('www.dati.gov.it'), false, 'www.dati.gov.it is listed');
  const counts = text.match(/^# Hosts: {5}(\d+) from the directory, (\d+) extra$/m);
  assert.ok(counts, 'the Hosts line is missing');
  assert.equal(Number(counts[1]) + Number(counts[2]), hosts.length);
  assert.match(text, /^# Commit: {4}[0-9a-f]{40}$/m);
});
