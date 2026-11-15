// The pinned-values guard. Run: node --test scripts/pinned-identity.test.mjs
//
// A site that calls this deployment may pin what the server reports: its
// `serverInfo` name and version, and the argument schemas of its tools, as
// `mcpToolSchemaSha256` (scripts/mcp-tool-schema-sha256.mjs). This test holds the
// built server to the values committed in scripts/pinned-identity.json, so a pull
// request that moves one of them fails until that file is edited (PIN.md, "The
// pinned-values guard").
//
// Two layers:
//   - the pure layer needs no build: the hash copy against ADR-0039's worked
//     values, and `compareIdentity` against made-up answers and decoys;
//   - the live layer starts the built server (`node dist/index.js`) over stdio with
//     an empty environment, reads `initialize` and every page of `tools/list`, and
//     holds the answers to the committed file. It needs `npm ci` and `npm run build`
//     first. Without `dist/index.js` it FAILS, naming the missing build; it never
//     skips, so a run that lost its build step cannot pass on the pure layer alone.
//
// Run the pure layer alone with:
//   node --test --test-name-pattern="pure layer" scripts/pinned-identity.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  canonicalJsonValue,
  mcpToolSchemaSha256,
  mcpToolSchemaText,
  schemaWithoutAnnotations,
} from './mcp-tool-schema-sha256.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PINNED_PATH = fileURLToPath(new URL('./pinned-identity.json', import.meta.url));
const DIST_PATH = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const PIN_MD_PATH = fileURLToPath(new URL('../PIN.md', import.meta.url));

/** The order a change to a pinned value takes. PIN.md quotes these words. */
export const STAGED_ORDER =
  'A site that calls this deployment may pin these values. Where one does, the change is staged: ' +
  'the site accepts the new values first (a pack listing both pins, the site deployed); ' +
  'then scripts/pinned-identity.json is edited to the new values and the change merges ' +
  '(PIN.md, "The staged order").';

/** The live layer's failure when there is no build to read. */
export const MISSING_BUILD =
  'dist/index.js is absent: the live layer reads the built server, and there is no build. ' +
  'Run npm ci, then npm run build, then this test again. ' +
  'This layer fails rather than skips, so a run that lost its build step cannot pass on the pure layer alone.';

/** The committed values. */
export function readPinned(path = PINNED_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Every difference between the pinned values and what a server answered, by name.
 * `pinned` is { serverName, serverVersion, tools: { <name>: <mcpToolSchemaSha256> } };
 * `initializeResult` is the `result` of `initialize`; `toolsListResult` is a
 * `tools/list` result ({ tools: [...] }, every page's tools together). Each
 * difference is { member, kind, pinned, reported }: `member` is `serverName`,
 * `serverVersion` or `tools.<name>`; `kind` is `changed`, `hash moved`,
 * `pinned, not listed`, `listed, not pinned`, `listed twice` or `not hashable`.
 * An empty list means the server reports the pinned values. Only the schema
 * hashes are compared, so a reworded description is not a difference.
 */
export function compareIdentity(pinned, initializeResult, toolsListResult) {
  const differences = [];
  const serverInfo = initializeResult?.serverInfo ?? {};
  for (const [member, pinnedValue, reportedValue] of [
    ['serverName', pinned.serverName, serverInfo.name],
    ['serverVersion', pinned.serverVersion, serverInfo.version],
  ]) {
    if (pinnedValue !== reportedValue) {
      differences.push({ member, kind: 'changed', pinned: pinnedValue, reported: reportedValue });
    }
  }

  const listed = new Map();
  const tools = Array.isArray(toolsListResult?.tools) ? toolsListResult.tools : [];
  tools.forEach((tool, index) => {
    const name = typeof tool?.name === 'string' ? tool.name : `[${index}]`;
    let hash;
    try {
      hash = mcpToolSchemaSha256(tool);
    } catch (error) {
      differences.push({ member: `tools.${name}`, kind: 'not hashable', pinned: pinned.tools?.[name], reported: error.message });
      return;
    }
    if (listed.has(name)) {
      differences.push({ member: `tools.${name}`, kind: 'listed twice', pinned: pinned.tools?.[name], reported: hash });
      return;
    }
    listed.set(name, hash);
  });

  for (const [name, pinnedHash] of Object.entries(pinned.tools ?? {})) {
    if (!listed.has(name)) {
      differences.push({ member: `tools.${name}`, kind: 'pinned, not listed', pinned: pinnedHash, reported: undefined });
    } else if (listed.get(name) !== pinnedHash) {
      differences.push({ member: `tools.${name}`, kind: 'hash moved', pinned: pinnedHash, reported: listed.get(name) });
    }
  }
  for (const [name, hash] of listed) {
    if (!Object.hasOwn(pinned.tools ?? {}, name)) {
      differences.push({ member: `tools.${name}`, kind: 'listed, not pinned', pinned: undefined, reported: hash });
    }
  }
  return differences;
}

/** The failure text for a list of differences: each one by name, then the stage. */
export function describeDifferences(differences) {
  const show = (value) => (value === undefined ? '(none)' : JSON.stringify(value));
  return [
    `The built server does not report the values in scripts/pinned-identity.json (${differences.length} difference(s)):`,
    ...differences.map((d) => `  ${d.member}: ${d.kind}; pinned ${show(d.pinned)}, reported ${show(d.reported)}`),
    STAGED_ORDER,
  ].join('\n');
}

// ---- the pure layer ---------------------------------------------------------

// ADR-0039, section D, "The worked cases".
const CASE_1 = {
  name: 'v',
  inputSchema: {
    type: 'object',
    title: 'T',
    description: 'D',
    properties: {
      description: { type: 'string', description: 'an argument named description' },
      n: { type: 'integer', minimum: 1, description: 'x' },
      flag: { type: 'boolean', default: false },
      tags: { type: 'array', items: { type: 'string', description: 'y' } },
    },
    required: ['description'],
    additionalProperties: false,
  },
};
const CASE_1_TEXT =
  '{"inputSchema":{"additionalProperties":false,"properties":{"description":{"type":"string"},' +
  '"flag":{"default":false,"type":"boolean"},"n":{"minimum":1,"type":"integer"},' +
  '"tags":{"items":{"type":"string"},"type":"array"}},"required":["description"],"type":"object"},"name":"v"}';
const CASE_1_SHA256 = '7d059d0a5564530b86cd74e9c72269f9d507e1a93eb26979666a89eb8e8455eb';
const CASE_2_SHA256 = 'd79d93f1d11b85e4fc07d6c4b73fd7c4880bca58555c159bed96e30a57984852';
const WRONG_STRIPS_DEFAULT = '2ab850b0a2234575312daea5512685b5f2e620d47fa17723909f34cf390a792a';
const WRONG_SKIPS_ANYOF = '1aff7763977b498874f890f3ad91bd35e437c7c8a80d8812b8add338a06b15e7';

function case2() {
  const tool = structuredClone(CASE_1);
  tool.inputSchema.properties.opts = {
    type: 'object',
    description: 'z',
    default: { description: 'data, not a keyword' },
    anyOf: [{ type: 'object', title: "a subschema's title" }],
  };
  return tool;
}

const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Made-up answers for the comparison: three tools and a serverInfo.
function sampleAnswers() {
  const initializeResult = {
    protocolVersion: '2025-06-18',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'sample-server', version: '1.2.3' },
  };
  const toolsListResult = {
    tools: [
      structuredClone(CASE_1),
      {
        name: 'search',
        description: 'Search the catalogue.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'The query.' },
            rows: { type: 'number', default: 10, description: 'How many.' },
          },
          required: ['q'],
          additionalProperties: false,
        },
      },
      {
        name: 'status',
        title: 'Status',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ],
  };
  return { initializeResult, toolsListResult };
}

function samplePinned() {
  const { toolsListResult } = sampleAnswers();
  return {
    serverName: 'sample-server',
    serverVersion: '1.2.3',
    tools: {
      v: CASE_1_SHA256,
      search: mcpToolSchemaSha256(toolsListResult.tools[1]),
      status: mcpToolSchemaSha256(toolsListResult.tools[2]),
    },
  };
}

const members = (differences) => differences.map((d) => `${d.member}: ${d.kind}`);

describe('pure layer', () => {
  test('hash copy: ADR-0039 case 1, its canonical text and its hash', () => {
    assert.equal(mcpToolSchemaText(CASE_1), CASE_1_TEXT);
    assert.equal(mcpToolSchemaSha256(CASE_1), CASE_1_SHA256);
  });

  test('hash copy: ADR-0039 case 2', () => {
    assert.equal(mcpToolSchemaSha256(case2()), CASE_2_SHA256);
  });

  test('hash copy: the two wrong walks give the ADR values, and the copy gives neither', () => {
    // A walk that also strips inside `default`.
    const stripsDefault = schemaWithoutAnnotations(case2().inputSchema);
    stripsDefault.properties.opts.default = {};
    assert.equal(sha256Text(canonicalJsonValue({ name: 'v', inputSchema: stripsDefault })), WRONG_STRIPS_DEFAULT);
    // A walk that does not walk `anyOf`.
    const skipsAnyOf = schemaWithoutAnnotations(case2().inputSchema);
    skipsAnyOf.properties.opts.anyOf = case2().inputSchema.properties.opts.anyOf;
    assert.equal(sha256Text(canonicalJsonValue({ name: 'v', inputSchema: skipsAnyOf })), WRONG_SKIPS_ANYOF);

    const copy = mcpToolSchemaSha256(case2());
    assert.notEqual(copy, WRONG_STRIPS_DEFAULT);
    assert.notEqual(copy, WRONG_SKIPS_ANYOF);
  });

  test('hash copy: a reworded description hashes the same', () => {
    const reworded = structuredClone(CASE_1);
    reworded.description = 'a tool-level description, outside the hash';
    reworded.inputSchema.description = 'reworded';
    reworded.inputSchema.properties.n.description = 'reworded too';
    reworded.inputSchema.properties.tags.items.description = 'and this';
    assert.equal(mcpToolSchemaSha256(reworded), CASE_1_SHA256);
  });

  test('hash copy: a changed type hashes differently', () => {
    const changed = structuredClone(CASE_1);
    changed.inputSchema.properties.n.type = 'number';
    assert.notEqual(mcpToolSchemaSha256(changed), CASE_1_SHA256);
  });

  test('compareIdentity: the answers the values were taken from report no difference', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    assert.deepEqual(compareIdentity(samplePinned(), initializeResult, toolsListResult), []);
  });

  test("compareIdentity: decoy, one tool's argument type changed, is named", () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    toolsListResult.tools[1].inputSchema.properties.rows.type = 'integer';
    assert.deepEqual(members(compareIdentity(samplePinned(), initializeResult, toolsListResult)), [
      'tools.search: hash moved',
    ]);
  });

  test('compareIdentity: decoy, the version changed, is named', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    initializeResult.serverInfo.version = '1.2.4';
    const differences = compareIdentity(samplePinned(), initializeResult, toolsListResult);
    assert.deepEqual(differences, [{ member: 'serverVersion', kind: 'changed', pinned: '1.2.3', reported: '1.2.4' }]);
  });

  test('compareIdentity: decoy, the name changed, is named', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    initializeResult.serverInfo.name = 'another-server';
    assert.deepEqual(members(compareIdentity(samplePinned(), initializeResult, toolsListResult)), [
      'serverName: changed',
    ]);
  });

  test('compareIdentity: decoy, a tool removed from the list, is named', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    toolsListResult.tools.splice(2, 1);
    assert.deepEqual(members(compareIdentity(samplePinned(), initializeResult, toolsListResult)), [
      'tools.status: pinned, not listed',
    ]);
  });

  test('compareIdentity: decoy, a tool added to the list, is named', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    toolsListResult.tools.push({ name: 'extra', inputSchema: { type: 'object', properties: {} } });
    assert.deepEqual(members(compareIdentity(samplePinned(), initializeResult, toolsListResult)), [
      'tools.extra: listed, not pinned',
    ]);
  });

  test('compareIdentity: a tool listed twice is named', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    toolsListResult.tools.push(structuredClone(toolsListResult.tools[2]));
    assert.deepEqual(members(compareIdentity(samplePinned(), initializeResult, toolsListResult)), [
      'tools.status: listed twice',
    ]);
  });

  test('compareIdentity: a description-only change passes', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    toolsListResult.tools[1].description = 'Reworded.';
    toolsListResult.tools[1].inputSchema.properties.q.description = 'Reworded too.';
    assert.deepEqual(compareIdentity(samplePinned(), initializeResult, toolsListResult), []);
  });

  test('the failure text names each difference and the staged order', () => {
    const { initializeResult, toolsListResult } = sampleAnswers();
    initializeResult.serverInfo.version = '1.2.4';
    toolsListResult.tools.splice(2, 1);
    const text = describeDifferences(compareIdentity(samplePinned(), initializeResult, toolsListResult));
    assert.match(text, /serverVersion: changed; pinned "1\.2\.3", reported "1\.2\.4"/);
    assert.match(text, /tools\.status: pinned, not listed/);
    assert.ok(text.endsWith(STAGED_ORDER));
  });

  test('scripts/pinned-identity.json holds a name, a version and one hash per tool', () => {
    const pinned = readPinned();
    assert.equal(typeof pinned.serverName, 'string');
    assert.equal(typeof pinned.serverVersion, 'string');
    assert.ok(pinned.tools && typeof pinned.tools === 'object' && !Array.isArray(pinned.tools));
    const entries = Object.entries(pinned.tools);
    assert.ok(entries.length > 0, 'the file pins no tool');
    for (const [name, hash] of entries) assert.match(hash, /^[0-9a-f]{64}$/, `tools.${name}`);
    assert.match(pinned.capturedFrom?.commit ?? '', /^[0-9a-f]{40}$/);
  });

  test('PIN.md states the staged order in these words', () => {
    const flat = (text) => text.replace(/\s+/g, ' ');
    assert.ok(flat(readFileSync(PIN_MD_PATH, 'utf8')).includes(flat(STAGED_ORDER)), 'PIN.md does not quote STAGED_ORDER');
  });
});

// ---- the live layer ---------------------------------------------------------

const ANSWER_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;

/** Start the built server over stdio with an empty environment, and talk to it. */
function startServer() {
  const child = spawn(process.execPath, [DIST_PATH], { cwd: REPO_ROOT, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const other = [];
  let stderr = '';
  let buffered = '';
  let exited = null;

  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        other.push(line);
        continue;
      }
      if (message && pending.has(message.id)) {
        const { resolve } = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      } else {
        other.push(line);
      }
    }
  });
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      failAll(new Error(`the server exited (code ${code}, signal ${signal}) before answering; its stderr:\n${stderr}`));
      resolve(exited);
    });
  });
  child.on('error', (error) => failAll(error));
  // A write after the server has gone fails on the pipe; the exit above reports it.
  child.stdin.on('error', () => {});

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error(`the server exited (code ${exited.code}) before ${method}; its stderr:\n${stderr}`));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to ${method} within ${ANSWER_TIMEOUT_MS} ms; the server's stderr:\n${stderr}`));
      }, ANSWER_TIMEOUT_MS);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${method} answered an error: ${JSON.stringify(message.error)}`));
          else resolve(message.result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const stop = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_TIMEOUT_MS);
    const result = await exit;
    clearTimeout(timer);
    return result;
  };
  return { request, send, stop, other, stderrText: () => stderr };
}

describe('live layer', () => {
  test('the built server reports the pinned name, version and tool schemas', { timeout: 120_000 }, async () => {
    assert.ok(existsSync(DIST_PATH), MISSING_BUILD);
    const pinned = readPinned();
    const server = startServer();
    try {
      const initializeResult = await server.request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pinned-identity-test', version: '1.0.0' },
      });
      server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const tools = [];
      let cursor;
      let id = 2;
      do {
        const page = await server.request(id++, 'tools/list', cursor === undefined ? {} : { cursor });
        assert.ok(Array.isArray(page?.tools), `tools/list page ${id - 2} holds no tools array`);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined && cursor !== null);

      const differences = compareIdentity(pinned, initializeResult, { tools });
      assert.deepEqual(differences, [], describeDifferences(differences));
    } finally {
      await server.stop();
    }
  });
});
