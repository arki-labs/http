/**
 * OpenAPI generation — falls out of the contracts, doesn't bolt on.
 *
 * Contracts are static data carrying Standard Schemas, so the document is
 * produced without booting anything, deterministically: same contracts in
 * the same order → byte-identical output (DOT principle 3). No decorator
 * reconstruction, no annotations — the schema IS the validation IS the
 * documentation.
 */

import type { StandardSchemaV1 } from '@arki/schema';
import { hasJsonSchema, is, isStandardSchema, plainObjectSchema } from '@arki/schema';

import type { ContractLike } from './contract.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { openApiPaths, pathPlaceholders } from './path.js';
import { isRawOutput } from './raw.js';
import type { Fields, Wire } from './wire.js';
import { decoderOf, fieldParts } from './wire.js';

export type OpenApiInfo = {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const HTTP_ACTION_META_SCHEMA = '@arki/http/action-meta@1';

const JSON_SCHEMA_REMEDIATION =
  'Wrap the schema with withJsonSchema(schema, jsonSchema) from @arki/schema, or use a validator that converts itself (zod, arktype).';

/**
 * A schema's JSON Schema, read from its own `~standard.jsonSchema` converter
 * (`draft-2020-12`, the dialect OpenAPI 3.1 uses), without the `$schema`
 * header. A schema with no converter, or one whose conversion throws, fails
 * loudly naming the route and where the schema sits: never a silent `{}`.
 */
function jsonSchemaOf(id: string, where: string, schema: StandardSchemaV1, io: 'input' | 'output'): JsonObject {
  if (!hasJsonSchema(schema)) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.noJsonSchema,
      message: `[http] route "${id}": ${where} cannot describe itself as JSON Schema (its "${schema['~standard'].vendor}" schema has no ~standard.jsonSchema).`,
      remediation: JSON_SCHEMA_REMEDIATION,
    });
  }
  let json: Record<string, unknown>;
  try {
    json = schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });
  } catch (error) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.noJsonSchema,
      message: `[http] route "${id}": ${where} failed to convert to JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      remediation: JSON_SCHEMA_REMEDIATION,
      cause: error,
    });
  }
  const { $schema: _dialect, ...rest } = json;
  return toJsonObject(rest);
}

/**
 * The JSON Schema of what travels on the wire. A codec's wire side is its
 * `decode` input (the same text its `encode` writes, and the side a
 * converter can describe: `encode` usually ends in a transform). A bare
 * schema describes its input when the server receives it and its output
 * when the server sends it.
 */
function wireJson(id: string, where: string, wire: Wire, direction: 'received' | 'sent'): JsonObject {
  if (!isStandardSchema(wire)) return jsonSchemaOf(id, where, wire.decode, 'input');
  return jsonSchemaOf(id, where, wire, direction === 'sent' ? 'output' : 'input');
}

/**
 * A field record as one object schema: a property per field, `required`
 * for every field not marked `optional(...)`. Each field's `$defs` move to
 * the object's `$defs`.
 */
function fieldsJson(id: string, where: 'params' | 'query' | 'headers', fields: Fields): JsonObject {
  const defs: JsonObject = {};
  const properties: JsonObject = {};
  const required: JsonValue[] = [];
  for (const [key, field] of Object.entries(fields)) {
    const { wire, optional } = fieldParts(field);
    properties[key] = hoistDefs(jsonSchemaOf(id, `${where}.${key}`, decoderOf(wire), 'input'), defs, DEFS_PREFIX);
    if (!optional) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
  };
}

const DEFS_PREFIX = '#/$defs/';
const COMPONENTS_PREFIX = '#/components/schemas/';

/** `value` with every `#/$defs/<name>` reference pointing at `prefix` + its (renamed) name. */
function rewriteRefs(value: JsonValue, renames: ReadonlyMap<string, string>, prefix: string): JsonValue {
  if (Array.isArray(value)) return value.map(item => rewriteRefs(item, renames, prefix));
  if (typeof value !== 'object' || value === null) return value;
  return rewriteObject(value, renames, prefix);
}

function rewriteObject(value: JsonObject, renames: ReadonlyMap<string, string>, prefix: string): JsonObject {
  const rewritten: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '$ref' && typeof item === 'string' && item.startsWith(DEFS_PREFIX)) {
      // The def name is the one JSON Pointer segment after the prefix (`~1` is `/`, `~0` is `~`);
      // a suffix such as `/properties/v` stays.
      const rest = item.slice(DEFS_PREFIX.length);
      const slash = rest.indexOf('/');
      const segment = slash === -1 ? rest : rest.slice(0, slash);
      const renamed = renames.get(unescapePointer(segment));
      rewritten[key] =
        prefix + (renamed === undefined ? segment : escapePointer(renamed)) + (slash === -1 ? '' : rest.slice(slash));
    } else {
      rewritten[key] = rewriteRefs(item, renames, prefix);
    }
  }
  return rewritten;
}

/** One JSON Pointer segment as a plain name (RFC 6901: `~1` is `/`, then `~0` is `~`). */
function unescapePointer(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** A plain name as one JSON Pointer segment. */
function escapePointer(name: string): string {
  return name.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Move `json.$defs` into `pool` and point the references at `prefix`. A
 * definition the pool already holds with the same content is shared; when
 * any name clashes with different content, each clashing name gets a free
 * `_2`, `_3`… suffix, so every reference still resolves to what its schema
 * meant. Deterministic: same schemas in the same order, same names.
 */
function hoistDefs(json: JsonObject, pool: JsonObject, prefix: string): JsonObject {
  const { $defs: rawDefs, ...rest } = json;
  if (!isJsonObject(rawDefs)) return rewriteObject(rest, new Map(), prefix);
  const defs = Object.entries(rawDefs);
  const same = new Map<string, string>();
  const fits = defs.every(([name, def]) => {
    const held = pool[name];
    return held === undefined || jsonDeepEqual(held, rewriteRefs(def, same, prefix));
  });
  const renames = new Map<string, string>();
  if (!fits) {
    const taken = new Set([...Object.keys(pool), ...defs.map(([name]) => name)]);
    for (const [name] of defs) {
      if (pool[name] === undefined) continue;
      let suffix = 2;
      while (taken.has(`${name}_${suffix}`)) suffix += 1;
      const fresh = `${name}_${suffix}`;
      taken.add(fresh);
      renames.set(name, fresh);
    }
  }
  for (const [name, def] of defs) {
    const target = renames.get(name) ?? name;
    pool[target] ??= rewriteRefs(def, renames, prefix);
  }
  return rewriteObject(rest, renames, prefix);
}

function toJsonObject(value: unknown): JsonObject {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError('Value must be JSON-serializable manifest data.', { cause: error });
  }
  if (serialized === undefined) throw new TypeError('Value must be a JSON-serializable object.');
  const parsed = JSON.parse(serialized) as unknown;
  if (!isJsonObject(parsed) || !jsonDeepEqual(value, parsed)) {
    throw new TypeError('Value must be a JSON-serializable object without lossy coercions.');
  }
  return parsed;
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!is(value, plainObjectSchema)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return is(value, plainObjectSchema) && Object.values(value).every(isJsonValue);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) || isJsonPrimitive(right)) return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (!is(left, plainObjectSchema) || !is(right, plainObjectSchema)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.hasOwn(right, key) || !jsonDeepEqual(value, right[key])) return false;
  }
  return true;
}

/** The properties of an object schema (already hoisted: its references point at components). */
function propertiesOf(json: JsonObject): { readonly properties: JsonObject; readonly required: ReadonlySet<string> } {
  const properties = isJsonObject(json['properties']) ? json['properties'] : {};
  const required = Array.isArray(json['required'])
    ? new Set(json['required'].filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  return { properties, required };
}

function parametersFromSchemaObject(location: 'query' | 'header', json: JsonObject): JsonObject[] {
  const { properties, required } = propertiesOf(json);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: location,
    required: required.has(name),
    schema,
  }));
}

function buildResponses(action: HttpActionForProjection): JsonObject {
  if (action.streaming === true) {
    return {
      '200': {
        description: 'event stream',
        content: { 'text/event-stream': action.output === undefined ? {} : { schema: action.output } },
      },
    };
  }
  const responses: JsonObject = {};
  // A raw route documents its body only; the engine never checks it.
  const contentType = action.raw === undefined ? 'application/json' : (action.raw.contentType ?? '*/*');
  if (action.raw === undefined) {
    if (action.output === undefined) {
      responses['204'] = { description: 'no content' };
    } else {
      responses['200'] = { description: 'success', content: { 'application/json': { schema: action.output } } };
    }
  } else {
    responses['200'] = { description: 'success', content: { [contentType]: {} } };
  }
  for (const [status, schema] of Object.entries(action.responses ?? {})) {
    responses[status] = {
      description: Number(status) < 400 ? 'success' : 'error',
      content: { [contentType]: { schema } },
    };
  }
  return responses;
}

/** One operation, for one concrete path of the route (`omitted` is the optional placeholder this variant leaves out). */
function buildOperation(action: HttpActionForProjection, omitted: string | undefined): JsonObject {
  const parameters: JsonObject[] = pathPlaceholders(action.path)
    .filter(({ name }) => name !== omitted)
    .map(({ name }) => ({
      name,
      in: 'path',
      required: true,
      schema: action.input?.params === undefined ? { type: 'string' } : (propertiesOf(action.input.params).properties[name] ?? { type: 'string' }),
    }));
  if (action.input?.query !== undefined) parameters.push(...parametersFromSchemaObject('query', action.input.query));
  if (action.input?.headers !== undefined) parameters.push(...parametersFromSchemaObject('header', action.input.headers));

  const operation: JsonObject = {
    operationId: omitted === undefined ? action.id : `${action.id}.without-${omitted}`,
  };
  if (action.plugin !== undefined) operation['tags'] = [action.plugin];
  if (action.summary !== undefined) operation['summary'] = action.summary;
  if (parameters.length > 0) operation['parameters'] = parameters;
  if (action.input?.body !== undefined) {
    operation['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: action.input.body } },
    };
  }
  operation['responses'] = buildResponses(action);
  if (action.raw !== undefined) operation['x-arki-raw'] = true;
  return operation;
}

/** The action with every schema's `$defs` moved into `pool` (the document's `components.schemas`). */
function hoistAction(action: HttpActionForProjection, pool: JsonObject): HttpActionForProjection {
  const lift = (json: JsonObject): JsonObject => hoistDefs(json, pool, COMPONENTS_PREFIX);
  const { input, output, responses } = action;
  return {
    ...action,
    ...(input === undefined
      ? {}
      : {
          input: {
            ...(input.params === undefined ? {} : { params: lift(input.params) }),
            ...(input.query === undefined ? {} : { query: lift(input.query) }),
            ...(input.headers === undefined ? {} : { headers: lift(input.headers) }),
            ...(input.body === undefined ? {} : { body: lift(input.body) }),
          },
        }),
    ...(output === undefined ? {} : { output: lift(output) }),
    ...(responses === undefined
      ? {}
      : { responses: Object.fromEntries(Object.entries(responses).map(([status, json]) => [status, lift(json)])) }),
  };
}

/**
 * The document: paths and operations in action order, every schema's
 * `$defs` kept as `components.schemas`. Duplicate method+path pairs fail
 * loudly with `ARKI_HTTP_E002`, optional-placeholder variants included.
 */
function renderDocument(
  actions: Iterable<HttpActionForProjection>,
  info: JsonObject,
  collidesWith: 'contract' | 'action',
): JsonObject {
  const paths: Record<string, JsonObject> = {};
  const schemas: JsonObject = {};
  for (const declared of actions) {
    const action = hoistAction(declared, schemas);
    const method = action.method.toLowerCase();
    for (const { path, omitted } of openApiPaths(action.path)) {
      const entry = (paths[path] ??= {});
      if (entry[method] !== undefined) {
        throw new HttpConfigError({
          code: HTTP_ERROR_CODES.duplicateRoute,
          message: `[http] duplicate route ${action.method} ${action.path}: "${action.id}" collides with an earlier ${collidesWith}.`,
          remediation: `Two ${collidesWith}s claim the same method and path. Change one path, or drop the duplicate.`,
        });
      }
      entry[method] = buildOperation(action, omitted);
    }
  }
  return {
    openapi: '3.1.0',
    info,
    paths,
    ...(Object.keys(schemas).length === 0 ? {} : { components: { schemas } }),
  };
}

/**
 * Render an OpenAPI 3.1 document from contracts. Paths and operations
 * appear in contract order; duplicate method+path pairs fail loudly with
 * `ARKI_HTTP_E002` (the same collision `buildEngine` rejects at boot).
 */
export function toOpenApi(contracts: readonly ContractLike[], info: OpenApiInfo): JsonObject {
  const actions = contracts.map(contract => {
    const { id, summary, meta } = contractMeta(contract);
    return httpActionFromMeta({ id, plugin: undefined, summary, meta });
  });
  return renderDocument(
    actions,
    {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },
    'contract',
  );
}

type DotActionLike = {
  readonly id: string;
  readonly plugin: string;
  readonly binding: string;
  readonly direction: 'in' | 'out';
  readonly address?: string;
  readonly summary?: string;
  readonly meta?: JsonObject;
  readonly metaSchema?: string;
};

type DotManifestLike = {
  readonly app: { readonly name: string; readonly version?: string };
  readonly actions: readonly DotActionLike[];
};

type HttpActionForProjection = {
  readonly id: string;
  /** The owning plugin; absent when rendering contracts directly, so no `tags`. */
  readonly plugin: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly input?: {
    readonly params?: JsonObject;
    readonly query?: JsonObject;
    readonly headers?: JsonObject;
    readonly body?: JsonObject;
  };
  readonly output?: JsonObject;
  readonly raw?: { readonly contentType?: string };
  readonly responses?: Readonly<Record<string, JsonObject>>;
  readonly streaming?: boolean;
};

/** The DOT action declaration derived from a contract. */
export type RouteMeta = {
  readonly id: string;
  readonly binding: 'http';
  readonly direction: 'in';
  readonly address: string;
  readonly summary?: string;
  readonly metaSchema: typeof HTTP_ACTION_META_SCHEMA;
  readonly meta: JsonObject;
};

/**
 * Manifest metadata for a contract — what contract `toDotAction()` returns
 * for DOT plugins and what `registerRoutes` feeds into `ctx.registerAction`
 * during the shim window. SSE contracts mark `streaming` and carry the
 * per-event schema as `output`. A `raw()` route carries `raw` instead of
 * `output`, and `responses` holds one JSON Schema per declared status.
 */
export function contractMeta(contract: ContractLike): RouteMeta {
  const input: JsonObject = {};
  const { id } = contract;
  if (contract.params !== undefined) input['params'] = fieldsJson(id, 'params', contract.params);
  if (contract.query !== undefined) input['query'] = fieldsJson(id, 'query', contract.query);
  if (contract.headers !== undefined) input['headers'] = fieldsJson(id, 'headers', contract.headers);
  if (contract.body !== undefined) input['body'] = wireJson(id, 'body', contract.body, 'received');

  const meta: JsonObject = {
    method: contract.method,
    path: contract.path,
  };
  if (Object.keys(input).length > 0) meta['input'] = input;
  if (contract.kind === 'sse') {
    if (contract.event !== undefined) meta['output'] = wireJson(id, 'event', contract.event, 'sent');
    meta['streaming'] = true;
  } else if (isRawOutput(contract.output)) {
    meta['raw'] = contract.output.contentType === undefined ? {} : { contentType: contract.output.contentType };
  } else if (contract.output !== undefined) {
    meta['output'] = wireJson(id, 'output', contract.output, 'sent');
  }
  if (contract.responses !== undefined && Object.keys(contract.responses).length > 0) {
    const responses: JsonObject = {};
    for (const [status, wire] of Object.entries(contract.responses)) {
      responses[status] = wireJson(id, `responses.${status}`, wire, 'sent');
    }
    meta['responses'] = responses;
  }

  return {
    id: contract.id,
    binding: 'http',
    direction: 'in',
    address: `${contract.method} ${contract.path}`,
    ...(contract.summary === undefined ? {} : { summary: contract.summary }),
    metaSchema: HTTP_ACTION_META_SCHEMA,
    meta,
  };
}

/** Read an action's metadata back into the shape the renderer takes. */
function httpActionFromMeta(action: {
  readonly id: string;
  readonly plugin: string | undefined;
  readonly summary?: string;
  readonly meta?: JsonObject;
}): HttpActionForProjection {
  const meta = action.meta;
  if (meta === undefined) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidActionMeta,
      message: `[http] action "${action.id}" has no HTTP metadata.`,
      remediation: 'Register HTTP actions through route contracts or registerRoute during the migration window.',
    });
  }
  const method = meta['method'];
  const path = meta['path'];
  if (typeof method !== 'string' || typeof path !== 'string') {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidActionMeta,
      message: `[http] action "${action.id}" is missing string method/path metadata.`,
      remediation: 'HTTP action meta must include string `method` and `path` fields.',
    });
  }

  const inputValue = meta['input'];
  const outputValue = meta['output'];
  const streamingValue = meta['streaming'];
  const rawValue = meta['raw'];
  const responsesValue = meta['responses'];
  const input = isJsonObject(inputValue)
    ? {
        ...(isJsonObject(inputValue['params']) ? { params: inputValue['params'] } : {}),
        ...(isJsonObject(inputValue['query']) ? { query: inputValue['query'] } : {}),
        ...(isJsonObject(inputValue['headers']) ? { headers: inputValue['headers'] } : {}),
        ...(isJsonObject(inputValue['body']) ? { body: inputValue['body'] } : {}),
      }
    : undefined;
  const contentType = isJsonObject(rawValue) ? rawValue['contentType'] : undefined;
  const responses: Record<string, JsonObject> = {};
  if (isJsonObject(responsesValue)) {
    for (const [status, schema] of Object.entries(responsesValue)) {
      if (isJsonObject(schema)) responses[status] = schema;
    }
  }

  return {
    id: action.id,
    plugin: action.plugin,
    method,
    path,
    ...(action.summary === undefined ? {} : { summary: action.summary }),
    ...(input === undefined || Object.keys(input).length === 0 ? {} : { input }),
    ...(isJsonObject(outputValue) ? { output: outputValue } : {}),
    ...(isJsonObject(rawValue) ? { raw: typeof contentType === 'string' ? { contentType } : {} } : {}),
    ...(Object.keys(responses).length > 0 ? { responses } : {}),
    ...(typeof streamingValue === 'boolean' ? { streaming: streamingValue } : {}),
  };
}

function httpActionFromManifestAction(action: DotActionLike): HttpActionForProjection | null {
  if (action.binding !== 'http') return null;
  if (action.metaSchema !== undefined && action.metaSchema !== HTTP_ACTION_META_SCHEMA) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidActionMeta,
      message: `[http] action "${action.id}" uses unsupported meta schema "${action.metaSchema}".`,
      remediation: `HTTP projections require ${HTTP_ACTION_META_SCHEMA}; omit metaSchema only for legacy registerRoute shim output during the DOT 0.4 migration window.`,
    });
  }
  return httpActionFromMeta(action);
}

export function toOpenApiFromManifest(manifest: DotManifestLike): JsonObject {
  const actions = manifest.actions
    .map(action => httpActionFromManifestAction(action))
    .filter((action): action is HttpActionForProjection => action !== null);
  return renderDocument(actions, { title: manifest.app.name, version: manifest.app.version ?? '0.0.0' }, 'action');
}
