/**
 * The hosted server's CKAN allowlist file, scripts/allowed-domains.txt, and its
 * one parser. Three readers share it: scripts/start-hosted.mjs, which sets
 * CKAN_ALLOWED_DOMAINS from the file before it loads the server;
 * scripts/smoke-deployed-endpoint.mjs, whose pre-flight reads the file before any
 * request; and scripts/generate-allowed-domains.mjs, which writes the file.
 *
 * THE FORMAT. One host per line. `#` starts a comment, to the end of the line;
 * blank lines are skipped. A host is written exactly as the server compares it:
 * src/utils/http.ts (validateServerUrl) takes `new URL(server_url).hostname`,
 * lower-cased, and requires it to equal one entry of CKAN_ALLOWED_DOMAINS split on
 * commas. So a line is accepted only when it is already that form: no scheme,
 * port, path, upper case or comma, and listed once.
 *
 * Zero dependencies: `node:` modules only.
 */

import { fileURLToPath } from 'node:url';

/** Where the file is: beside this module. */
export const ALLOWED_DOMAINS_PATH = fileURLToPath(new URL('./allowed-domains.txt', import.meta.url));

/** The file as the logs and messages name it. */
export const ALLOWED_DOMAINS_NAME = 'scripts/allowed-domains.txt';

/**
 * The host as the server would compare it, or null when `token` is not already in
 * that form: `new URL('http://<token>/').hostname` must give `token` back unchanged.
 */
export function normalizedHost(token) {
  if (typeof token !== 'string' || token === '' || token.includes(',')) return null;
  let hostname;
  try {
    hostname = new URL(`http://${token}/`).hostname;
  } catch {
    return null;
  }
  return hostname === token ? hostname : null;
}

/**
 * The hosts of a list file, in file order. Throws on a line that is not a host in
 * the server's form, or a host listed twice; the error names the line's number,
 * never its text.
 */
export function parseAllowedDomains(text) {
  const hosts = [];
  const seen = new Set();
  text.split('\n').forEach((raw, index) => {
    const token = raw.replace(/#.*$/, '').trim();
    if (token === '') return;
    const host = normalizedHost(token);
    if (host === null) {
      throw new Error(`${ALLOWED_DOMAINS_NAME} line ${index + 1} is not a host name in the server's form`);
    }
    if (seen.has(host)) {
      throw new Error(`${ALLOWED_DOMAINS_NAME} line ${index + 1} lists a host already listed`);
    }
    seen.add(host);
    hosts.push(host);
  });
  return hosts;
}
