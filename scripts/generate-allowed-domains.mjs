#!/usr/bin/env node
/**
 * Writes scripts/allowed-domains.txt, the hosted server's CKAN allowlist, from the
 * website's CKAN directory (data/portals/ckan.json in
 * npstorey/civic-ai-tools-website) at a stated commit.
 *
 * THE RULE. For every row whose `status` is "active": the host of its `url` and,
 * where `api_endpoint` is set, the host of `api_endpoint`. A caller may pass either
 * as `server_url`, so both are listed where they differ. A host is written as the
 * server compares it (scripts/allowed-domains.mjs): `new URL(...).hostname`, lower
 * case, no port. The hosts are sorted and listed once each.
 *
 * THE EXTRA HOSTS. The file keeps a commented section, between `# BEGIN EXTRA
 * HOSTS` and `# END EXTRA HOSTS`, for hosts the directory does not give that a
 * listed portal needs (the other host of a measured redirect). The generator
 * carries that section over from the file it replaces, unchanged, and stops if a
 * host there is one the directory now gives.
 *
 * DETERMINISTIC. The file holds no date: the same directory bytes and the same
 * extra section give the same file, byte for byte. `--check` regenerates in memory
 * and compares, writing nothing.
 *
 * Usage:
 *   node scripts/generate-allowed-domains.mjs --commit <website commit>
 *   node scripts/generate-allowed-domains.mjs --commit <website commit> --check
 * Options:
 *   --directory-file <path>  read a saved copy of the directory instead of
 *                            fetching it (the commit is still recorded)
 *   --out <path>             the file to write (default scripts/allowed-domains.txt)
 *
 * Zero dependencies: `node:` modules and global fetch (Node 18 or later).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_DOMAINS_PATH, normalizedHost, parseAllowedDomains } from './allowed-domains.mjs';

export const DIRECTORY_REPOSITORY = 'npstorey/civic-ai-tools-website';
export const DIRECTORY_FILE = 'data/portals/ckan.json';

export const EXTRA_BEGIN = '# BEGIN EXTRA HOSTS';
export const EXTRA_END = '# END EXTRA HOSTS';

/** The extra section a new file starts with: an explanation and no host. */
const DEFAULT_EXTRA_LINES = [
  '# Hosts the directory does not give that a listed portal needs, such as the',
  '# other host of a measured redirect: one per line, under a comment saying why',
  '# and when it was measured. The generator carries this section over unchanged.',
];

/** The raw file at a commit: the URL the generator fetches. */
export function directoryUrl(commit) {
  return `https://raw.githubusercontent.com/${DIRECTORY_REPOSITORY}/${commit}/${DIRECTORY_FILE}`;
}

/** The host of an http(s) URL, in the server's form; throws naming the row and field. */
function hostOf(value, label, field) {
  if (typeof value !== 'string') throw new Error(`${label}: ${field} is not a string`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}: ${field} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}: ${field} is not an http(s) URL`);
  }
  const host = normalizedHost(url.hostname.toLowerCase());
  if (host === null) throw new Error(`${label}: ${field} has no host the server can compare`);
  return host;
}

/** (a)'s rule over the directory's rows: the counts and the sorted hosts. */
export function directoryHosts(rows) {
  if (!Array.isArray(rows)) throw new Error('the directory is not a JSON array');
  let active = 0;
  const hosts = new Set();
  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object') throw new Error(`row ${index}: not an object`);
    if (row.status !== 'active') return;
    active += 1;
    const label = typeof row.id === 'string' && row.id !== '' ? `row ${index} (${row.id})` : `row ${index}`;
    hosts.add(hostOf(row.url, label, 'url'));
    if (row.api_endpoint !== undefined && row.api_endpoint !== null && row.api_endpoint !== '') {
      hosts.add(hostOf(row.api_endpoint, label, 'api_endpoint'));
    }
  });
  return { rows: rows.length, active, hosts: [...hosts].sort() };
}

/** The extra section of the file being replaced, or the default when there is none. */
export function extraSection(previousText) {
  if (previousText === null) return { lines: DEFAULT_EXTRA_LINES, hosts: [] };
  const lines = previousText.split('\n');
  const begin = lines.indexOf(EXTRA_BEGIN);
  const end = lines.indexOf(EXTRA_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`the file being replaced has no "${EXTRA_BEGIN}" ... "${EXTRA_END}" section`);
  }
  const block = lines.slice(begin + 1, end);
  return { lines: block, hosts: parseAllowedDomains(block.join('\n')) };
}

/** The file's text. */
export function renderList({ commit, bytes, directory, extra }) {
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const given = new Set(directory.hosts);
  for (const host of extra.hosts) {
    if (given.has(host)) {
      throw new Error(`the extra host ${host} is one the directory gives: remove it from the extra section`);
    }
  }
  const text =
    [
      "# The hosted server's CKAN allowlist, one host per line. scripts/start-hosted.mjs",
      '# reads this file whole and sets CKAN_ALLOWED_DOMAINS from it before it loads',
      '# the server; the file wins over a CKAN_ALLOWED_DOMAINS set on the host (PIN.md,',
      '# "The allowlist").',
      '#',
      '# GENERATED by scripts/generate-allowed-domains.mjs from the website\'s CKAN',
      '# directory. Edit only between the EXTRA HOSTS markers; regenerate for the rest.',
      '#',
      `# Directory: ${DIRECTORY_FILE} in https://github.com/${DIRECTORY_REPOSITORY}`,
      `# Commit:    ${commit}`,
      `# Blob:      ${blob}`,
      `# SHA-256:   ${sha256}`,
      '# Rule:      every row whose status is "active": the host of its url and,',
      '#            where api_endpoint is set, the host of api_endpoint.',
      `# Rows:      ${directory.rows}, of which ${directory.active} active`,
      `# Hosts:     ${directory.hosts.length} from the directory, ${extra.hosts.length} extra`,
      '#',
      EXTRA_BEGIN,
      ...extra.lines,
      EXTRA_END,
      '#',
      '# BEGIN DIRECTORY HOSTS',
      ...directory.hosts,
      '# END DIRECTORY HOSTS',
    ].join('\n') + '\n';
  // The readers' own parser over the result: one form, every host once.
  parseAllowedDomains(text);
  return text;
}

function parseArgs(argv) {
  const args = { commit: null, directoryFile: null, out: ALLOWED_DOMAINS_PATH, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--check') args.check = true;
    else if (flag === '--commit' || flag === '--directory-file' || flag === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      if (flag === '--commit') args.commit = value;
      else if (flag === '--directory-file') args.directoryFile = value;
      else args.out = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (args.commit === null || !/^[0-9a-f]{40}$/.test(args.commit)) {
    throw new Error('--commit <the website commit, 40 lower-case hex digits> is required');
  }
  return args;
}

async function readDirectory({ commit, directoryFile }) {
  if (directoryFile !== null) return readFileSync(directoryFile);
  const url = directoryUrl(commit);
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const bytes = await readDirectory(args);
  let rows;
  try {
    rows = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`the directory is not JSON (${error.message})`);
  }
  const directory = directoryHosts(rows);
  const previous = existsSync(args.out) ? readFileSync(args.out, 'utf8') : null;
  const extra = extraSection(previous);
  const text = renderList({ commit: args.commit, bytes, directory, extra });
  const digest = createHash('sha256').update(text).digest('hex');
  const total = directory.hosts.length + extra.hosts.length;
  if (args.check) {
    const same = previous === text;
    console.log(`[generate] ${args.out} ${same ? 'matches' : 'differs from'} the directory at ${args.commit}`);
    return same ? 0 : 1;
  }
  writeFileSync(args.out, text);
  console.log(
    `[generate] wrote ${args.out}: ${total} hosts (${directory.hosts.length} from the directory at ` +
      `${args.commit}, ${extra.hosts.length} extra), sha256 ${digest}`
  );
  return 0;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[generate] ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
