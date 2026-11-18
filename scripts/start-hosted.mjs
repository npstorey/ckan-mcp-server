#!/usr/bin/env node
/**
 * The hosted service's start command: `node scripts/start-hosted.mjs`.
 *
 * WHY. The pinned server writes one JSON line per CKAN request to stderr
 * (`auditLog` in src/utils/http.ts: `ts`, `server`, `action`, `cache_hit` and,
 * where present, `q`, `fq`, the first 200 characters of `sql`, `id`, `rows`,
 * `limit`), and on a portal's `success=false` the first 500 characters of the
 * portal's answer (`[ckan] success=false action=...`). On the host, stderr is the
 * service's log stream, which the host keeps. No setting of the pinned release
 * turns either line off.
 *
 * WHAT. This file replaces `process.stderr.write` before it loads the built
 * server, and decides per write: a write whose text begins with one of
 * KNOWN_PREFIXES is passed on unchanged; every other write is withheld and
 * replaced by WITHHELD_LINE, which holds no part of it.
 *
 * IT FAILS CLOSED. KNOWN_PREFIXES is an allowlist of the server's own operational
 * lines, each one `console.error` call and so one write. It is never a pattern
 * for the audit line: a line this file does not know (a new log line in a later
 * release, a dependency's warning, Express's error log) is withheld, not passed.
 *
 * FATAL ERRORS. Node prints an uncaught exception's report itself, outside
 * `process.stderr.write`, and on this file's Node an unhandled rejection is
 * routed to 'uncaughtException' too. So this file registers one 'uncaughtException'
 * handler (createFatalHandler) that writes FATAL_LINE, which holds nothing of the
 * error, and exits with code 1, the code Node's own handler gives. The pinned
 * source and its runtime dependencies register no such handler of their own.
 *
 * LIMITS. What the runtime prints without running JavaScript still bypasses the
 * filter: an out-of-memory abort (measured: its heap report reached stderr with
 * `process.stderr.write` replaced and the handler registered) or a native crash
 * (not measured). Nothing is done to stdout: the server writes nothing there
 * over HTTP (no `console.log` under src outside the Worker entry).
 *
 * THE ALLOWLIST. Before it loads the server, this file reads
 * scripts/allowed-domains.txt (generated from the website's CKAN directory; see
 * scripts/generate-allowed-domains.mjs) and sets CKAN_ALLOWED_DOMAINS from it,
 * every host, joined by commas. The server reads the variable on every check
 * (src/utils/http.ts, validateServerUrl). The file wins: a CKAN_ALLOWED_DOMAINS
 * already set on the host is replaced, and one ALLOWLIST_PREFIX line says so,
 * with the host count and the file's sha256 and no host. With the file missing,
 * unreadable, malformed or holding no host, the server is not loaded: one
 * ALLOWLIST_PREFIX line says so and the process exits 1.
 *
 * The log filter comes out by a pin move once the upstream ships its own switch
 * for these lines (PIN.md); the allowlist stays. This file imports only `node:`
 * modules, scripts/allowed-domains.mjs and the built server.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_DOMAINS_NAME, ALLOWED_DOMAINS_PATH, parseAllowedDomains } from './allowed-domains.mjs';

/** The prefix of this file's one allowlist line (see applyAllowedDomains). */
export const ALLOWLIST_PREFIX = '[start-hosted] allowlist: ';

/**
 * The lines passed on unchanged. The first three are each a prefix of one
 * `console.error` call in the pinned release (v0.4.139):
 *   - the start line: src/transport/http.ts:60;
 *   - the two security warnings: src/utils/http.ts:651, :669;
 *   - a failed start, before any request: src/index.ts:17, :24.
 * The fourth is this file's own allowlist line, which holds a count, a digest
 * and a fixed sentence, never a host.
 */
export const KNOWN_PREFIXES = Object.freeze([
  'CKAN MCP server running on ',
  '[SECURITY WARNING] ',
  'Server error:',
  ALLOWLIST_PREFIX,
]);

/** What a withheld write is replaced by. Fixed: it carries nothing of the write. */
export const WITHHELD_LINE = '[start-hosted] 1 log write withheld\n';

/** The text of a write's chunk, or null when it is neither a string nor bytes. */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
  }
  return null;
}

/**
 * The decision, as a pure function: 'pass' when the text begins with a known
 * line, 'withhold' for everything else (anything that is not text included).
 */
export function decideStderrWrite(text) {
  if (typeof text !== 'string') return 'withhold';
  return KNOWN_PREFIXES.some((prefix) => text.startsWith(prefix)) ? 'pass' : 'withhold';
}

/**
 * Replace `stream.write` with the filter. Returns the original write, bound to
 * the stream. `stream` defaults to process.stderr; the test passes its own.
 */
export function installStderrFilter(stream = process.stderr) {
  const original = stream.write.bind(stream);
  stream.write = function filteredWrite(chunk, encoding, callback) {
    if (decideStderrWrite(chunkText(chunk)) === 'pass') {
      return original(chunk, encoding, callback);
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    return original(WITHHELD_LINE, done);
  };
  return original;
}

/** What a fatal error is replaced by. Fixed: no message, no stack, no name. */
export const FATAL_LINE = '[start-hosted] fatal error withheld; exiting\n';

/**
 * The 'uncaughtException' handler: write FATAL_LINE to `stream`, then `exit(1)`.
 * It reads nothing of the error. The test passes its own stream and exit.
 */
export function createFatalHandler(stream, exit) {
  return function onFatal(_error) {
    try {
      stream.write(FATAL_LINE);
    } catch {
      // Nothing to do: the exit below still happens.
    }
    exit(1);
  };
}

/**
 * Everything the entry point installs before it loads the server: the stderr
 * filter, then the fatal handler, which writes through the unfiltered write
 * (the filter would replace FATAL_LINE with WITHHELD_LINE).
 */
export function installHostedHandlers() {
  const rawWrite = installStderrFilter(process.stderr);
  process.on('uncaughtException', createFatalHandler({ write: rawWrite }, (code) => process.exit(code)));
}

/** True when `value` names at least one host, as the server splits it (src/utils/http.ts). */
function namesAHost(value) {
  return typeof value === 'string' && value.split(',').some((part) => part.trim() !== '');
}

/**
 * Set `env.CKAN_ALLOWED_DOMAINS` from the list file, replacing any value already
 * there. Returns { ok, line }: `line` is the one ALLOWLIST_PREFIX line to write.
 * When `ok` is false the variable is left as it was and the server must not be
 * loaded. Neither line holds a host. `path` and `env` default to the real ones;
 * the test passes its own.
 */
export function applyAllowedDomains({ path = ALLOWED_DOMAINS_PATH, env = process.env } = {}) {
  const refuse = (why) => ({
    ok: false,
    line: `${ALLOWLIST_PREFIX}${ALLOWED_DOMAINS_NAME} ${why}; refusing to start\n`,
  });
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return refuse('is missing or unreadable');
  }
  let hosts;
  try {
    hosts = parseAllowedDomains(text);
  } catch (error) {
    // The parser's message names the line's number, never its text.
    return refuse(`is malformed (${error.message.replace(`${ALLOWED_DOMAINS_NAME} `, '')})`);
  }
  if (hosts.length === 0) return refuse('holds no host');
  const replaced = namesAHost(env.CKAN_ALLOWED_DOMAINS);
  env.CKAN_ALLOWED_DOMAINS = hosts.join(',');
  const digest = createHash('sha256').update(text).digest('hex');
  return {
    ok: true,
    line:
      `${ALLOWLIST_PREFIX}CKAN_ALLOWED_DOMAINS set from ${ALLOWED_DOMAINS_NAME}: ${hosts.length} hosts, ` +
      `file sha256 ${digest}` +
      (replaced ? '; the value already set on the host is ignored' : '') +
      '\n',
  };
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Started as `node scripts/start-hosted.mjs`: the filter and the fatal handler
// first, then the allowlist from its file, then the built server. The allowlist
// line goes through the filter, which passes it by its prefix. src/index.ts has
// no main-module guard, so the import starts it. Imported (the test does), this
// file starts nothing and changes nothing.
if (isEntryPoint()) {
  installHostedHandlers();
  const allowlist = applyAllowedDomains();
  process.stderr.write(allowlist.line);
  if (allowlist.ok) {
    await import('../dist/index.js');
  } else {
    process.exitCode = 1;
  }
}
