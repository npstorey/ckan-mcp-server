// mcpToolSchemaSha256: a server tool's argument schema, hashed. Zero dependencies
// (Node's own `node:crypto` only), so this fork takes no package for it.
//
// SOURCE. A copy of two files of `@typedstandards/civic-typed-router` 0.11.0 (MIT
// License; the package's LICENSE file holds the notice), as the npm registry
// serves them:
//   - `dist/core/mcp-tool-schema.js`
//     (sha256 293930f579966d44ce7a811f4e817a9274ef393397d8bbf7ec94849b170e6964);
//   - `dist/core/canonical-json-value.js`
//     (sha256 f71317ead2ccfd1ef6575fcd2e69e6a9195816b6d606286887d4bc0c7a4f6a6f).
// The walk and the canonicalizer are those files' code. One change: the router
// carries its own SHA-256 (`dist/core/sha256.js`) to stay browser-safe; this copy
// runs only under Node and uses `node:crypto`, which computes the same digest.
//
// THE RULE is ADR-0039, "Route identity conventions", section D ("The hash,
// exactly"), in npstorey/civic-ai-tools at
// `docs/adr/0039-route-identity-conventions.md`. This copy is held to its four
// worked values by `scripts/pinned-identity.test.mjs`.
//
// `mcpToolSchemaSha256(tool)` is the lowercase hex SHA-256 of the RFC 8785
// canonical JSON (`canonicalJsonValue`) of `{ name, inputSchema }`, as the
// server's own `tools/list` returned the tool, with the annotation keywords
// `title` and `description` removed from every schema object the walk reaches.
// Every other member of the tool (its `description`, `title`, `annotations`,
// `outputSchema`) is outside the hash. So the hash moves when an argument's name,
// type, enumeration, `required` or `additionalProperties` moves, and not when a
// description is reworded.
//
// The walk, which decides what is a schema object:
//
//   - `properties`, `patternProperties`, `$defs`, `definitions` and
//     `dependentSchemas` hold schemas by name: each member's value is walked, and
//     the names are kept (an argument named `description` or `title` stays);
//   - `items`, `additionalProperties`, `not`, `if`, `then`, `else`, `contains`
//     and `propertyNames` hold one schema, walked; `items` holding an array is a
//     list, each item walked;
//   - `anyOf`, `oneOf`, `allOf` and `prefixItems` hold a list of schemas, each
//     walked;
//   - every other member is kept whole and not walked: the data keywords
//     (`default`, `const`, `enum`, `examples`), and every keyword the rule does
//     not name (`additionalItems`, `unevaluatedProperties`, `unevaluatedItems`,
//     `dependencies`, `contentSchema` among them).
//
// A schema that is not a plain object (a boolean schema) is kept as it is.

import { createHash } from 'node:crypto';

// ---- canonical-json-value.js ------------------------------------------------
// Canonical JSON for whole JSON values: RFC 8785 (JCS). Object members are
// written in the order of their names' UTF-16 code units, with no whitespace;
// every string as `JSON.stringify` writes it; every number as ECMAScript writes
// it (`JSON.stringify` of a finite number, which is RFC 8785's rule, `-0` as
// `0`); `true`, `false` and `null` as themselves. A value JSON cannot carry is
// refused, never coerced: `undefined`, a function, a symbol, a bigint, a number
// that is not finite, an array hole, an object that is not a plain object, and a
// symbol-keyed member.

/** Thrown by `canonicalJsonValue` for a value JSON cannot carry. */
export class CanonicalJsonValueError extends Error {
  /** Where the value sits, from `$` (the root). */
  path;
  constructor(path, what) {
    super(`canonicalJsonValue: ${what} at ${path}; only JSON values are canonicalized.`);
    this.name = 'CanonicalJsonValueError';
    this.path = path;
  }
}

function describe(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `the number ${String(value)}`;
  return `a ${typeof value}`;
}

function encode(value, path) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonValueError(path, describe(value));
    // ECMAScript's Number-to-String, as RFC 8785 §3.2.2.3 states it; `-0` is `0`.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new CanonicalJsonValueError(`${path}[${i}]`, 'an array hole');
      items.push(encode(value[i], `${path}[${i}]`));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonValueError(path, 'an object that is not a plain object');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonValueError(path, 'a symbol-keyed member');
    }
    // `sort()` with no comparator orders strings by UTF-16 code units.
    const members = Object.keys(value)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${encode(value[name], `${path}.${name}`)}`);
    return `{${members.join(',')}}`;
  }
  throw new CanonicalJsonValueError(path, describe(value));
}

/** The RFC 8785 canonical JSON text of `value`, a JSON value. */
export function canonicalJsonValue(value) {
  return encode(value, '$');
}

// ---- mcp-tool-schema.js -----------------------------------------------------

/** The annotation keywords removed from every schema object. */
const ANNOTATIONS = ['title', 'description'];
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
/** Keywords whose value is one schema (`items` may also be a list). */
const SCHEMA_ONE = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'];
/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** `schema` with `title` and `description` removed from it and from every schema
 *  object the walk reaches. A new value; the input is not changed. */
export function schemaWithoutAnnotations(schema) {
  if (!isPlainObject(schema)) return schema;
  const out = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATIONS.includes(keyword)) continue;
    if (SCHEMA_MAPS.includes(keyword) && isPlainObject(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, member]) => [name, schemaWithoutAnnotations(member)]),
      );
    } else if (SCHEMA_ONE.includes(keyword)) {
      out[keyword] =
        keyword === 'items' && Array.isArray(value)
          ? value.map(schemaWithoutAnnotations)
          : schemaWithoutAnnotations(value);
    } else if (SCHEMA_LISTS.includes(keyword) && Array.isArray(value)) {
      out[keyword] = value.map(schemaWithoutAnnotations);
    } else {
      out[keyword] = value;
    }
  }
  return out;
}

/** The text `mcpToolSchemaSha256` hashes: the canonical JSON of
 *  `{ name, inputSchema }`, the schema's annotations removed. Throws `TypeError`
 *  for a tool with no string `name`, and `CanonicalJsonValueError` for a schema
 *  JSON cannot carry. */
export function mcpToolSchemaText(tool) {
  if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string') {
    throw new TypeError('mcpToolSchemaSha256: a tool is an object with a string name');
  }
  if (!Object.hasOwn(tool, 'inputSchema')) {
    throw new TypeError(`mcpToolSchemaSha256: the tool "${tool.name}" has no inputSchema`);
  }
  return canonicalJsonValue({ name: tool.name, inputSchema: schemaWithoutAnnotations(tool.inputSchema) });
}

/** A server tool's schema hash: the lowercase hex SHA-256 of the UTF-8 bytes of
 *  `mcpToolSchemaText(tool)`. */
export function mcpToolSchemaSha256(tool) {
  return createHash('sha256').update(mcpToolSchemaText(tool), 'utf8').digest('hex');
}
