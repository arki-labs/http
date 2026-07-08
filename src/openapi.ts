/**
 * OpenAPI generation — falls out of the contracts, doesn't bolt on.
 *
 * Contracts are static data carrying zod schemas, so the document is
 * produced without booting anything, deterministically: same contracts in
 * the same order → byte-identical output (DOT principle 3). No decorator
 * reconstruction, no annotations — the schema IS the validation IS the
 * documentation.
 */

import { z } from 'zod';

import type { ContractLike } from './contract.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';

export type OpenApiInfo = {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const HTTP_ACTION_META_SCHEMA = '@arki/http/action-meta@1';

/**
 * Convert a contract schema to JSON Schema. Schema erasure seam:
 * {@link ContractLike} types schemas as `parse`-only, but contracts built
 * via `route.*` always hold zod schemas (see `SchemaLike` docs) — the
 * cast re-attaches what the erased view dropped.
 */
function toJsonSchema(schema: { parse(input: unknown): unknown }): JsonObject {
  const json = z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
  // The dialect header is noise when embedding into OpenAPI 3.1.
  const { $schema: _dialect, ...rest } = json;
  return toJsonObject(rest);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) || isJsonPrimitive(right)) return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.hasOwn(right, key) || !jsonDeepEqual(value, right[key])) return false;
  }
  return true;
}

function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/:(\w+)/g)]
    .map(match => match[1])
    .filter((name): name is string => name !== undefined);
}

function openApiPath(path: string): string {
  return path.replaceAll(/:(\w+)/g, '{$1}');
}

function queryParametersFromSchemaObject(json: JsonObject): JsonObject[] {
  const properties = isJsonObject(json['properties']) ? json['properties'] : {};
  const required = Array.isArray(json['required'])
    ? new Set(json['required'].filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: propertySchema,
  }));
}

function queryParameters(schema: { parse(input: unknown): unknown }): JsonObject[] {
  return queryParametersFromSchemaObject(toJsonSchema(schema));
}

function buildOperation(contract: ContractLike): JsonObject {
  const parameters: JsonObject[] = pathParamNames(contract.path).map(name => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  if (contract.query !== undefined) parameters.push(...queryParameters(contract.query));

  const operation: JsonObject = { operationId: contract.id };
  if (contract.summary !== undefined) operation['summary'] = contract.summary;
  if (parameters.length > 0) operation['parameters'] = parameters;
  if (contract.body !== undefined) {
    operation['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: toJsonSchema(contract.body) } },
    };
  }

  if (contract.kind === 'sse') {
    operation['responses'] = {
      '200': {
        description: 'event stream',
        content: {
          'text/event-stream':
            contract.event === undefined ? {} : { schema: toJsonSchema(contract.event) },
        },
      },
    };
  } else if (contract.output === undefined) {
    operation['responses'] = { '200': { description: 'success' } };
  } else {
    operation['responses'] = {
      '200': {
        description: 'success',
        content: { 'application/json': { schema: toJsonSchema(contract.output) } },
      },
    };
  }

  return operation;
}

function buildOperationFromAction(action: HttpActionForProjection): JsonObject {
  const parameters: JsonObject[] = pathParamNames(action.path).map(name => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  if (action.input?.query !== undefined) parameters.push(...queryParametersFromSchemaObject(action.input.query));

  const operation: JsonObject = {
    operationId: action.id,
    tags: [action.plugin],
  };
  if (action.summary !== undefined) operation['summary'] = action.summary;
  if (parameters.length > 0) operation['parameters'] = parameters;
  if (action.input?.body !== undefined) {
    operation['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: action.input.body } },
    };
  }

  if (action.streaming === true) {
    operation['responses'] = {
      '200': {
        description: 'event stream',
        content: {
          'text/event-stream': action.output === undefined ? {} : { schema: action.output },
        },
      },
    };
  } else if (action.output === undefined) {
    operation['responses'] = { '200': { description: 'success' } };
  } else {
    operation['responses'] = {
      '200': {
        description: 'success',
        content: { 'application/json': { schema: action.output } },
      },
    };
  }

  return operation;
}

/**
 * Render an OpenAPI 3.1 document from contracts. Paths and operations
 * appear in contract order; duplicate method+path pairs fail loudly with
 * `ARKI_HTTP_E002` (the same collision `buildEngine` rejects at boot).
 */
export function toOpenApi(contracts: readonly ContractLike[], info: OpenApiInfo): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const contract of contracts) {
    const path = openApiPath(contract.path);
    const entry = (paths[path] ??= {});
    const method = contract.method.toLowerCase();
    if (entry[method] !== undefined) {
      throw new HttpConfigError({
        code: HTTP_ERROR_CODES.duplicateRoute,
        message: `[http] duplicate route ${contract.method} ${contract.path}: "${contract.id}" collides with an earlier contract.`,
        remediation: 'Two contracts claim the same method and path. Change one path, or drop the duplicate.',
      });
    }
    entry[method] = buildOperation(contract);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },
    paths,
  };
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
  readonly plugin: string;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly input?: { readonly query?: JsonObject; readonly body?: JsonObject };
  readonly output?: JsonObject;
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
 * per-event schema as `output`.
 */
export function contractMeta(contract: ContractLike): RouteMeta {
  const input: JsonObject = {};
  if (contract.query !== undefined) input.query = toJsonSchema(contract.query);
  if (contract.body !== undefined) input.body = toJsonSchema(contract.body);

  const outputSchema = contract.kind === 'sse' ? contract.event : contract.output;
  const meta: JsonObject = {
    method: contract.method,
    path: contract.path,
  };
  if (Object.keys(input).length > 0) meta['input'] = input;
  if (outputSchema !== undefined) meta['output'] = toJsonSchema(outputSchema);
  if (contract.kind === 'sse') meta['streaming'] = true;

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

function httpActionFromManifestAction(action: DotActionLike): HttpActionForProjection | null {
  if (action.binding !== 'http') return null;
  if (action.metaSchema !== undefined && action.metaSchema !== HTTP_ACTION_META_SCHEMA) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidActionMeta,
      message: `[http] action "${action.id}" uses unsupported meta schema "${action.metaSchema}".`,
      remediation: `HTTP projections require ${HTTP_ACTION_META_SCHEMA}; omit metaSchema only for legacy registerRoute shim output during the DOT 0.4 migration window.`,
    });
  }
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
  const input =
    isJsonObject(inputValue)
      ? {
          ...(isJsonObject(inputValue['query']) ? { query: inputValue['query'] } : {}),
          ...(isJsonObject(inputValue['body']) ? { body: inputValue['body'] } : {}),
        }
      : undefined;

  return {
    id: action.id,
    plugin: action.plugin,
    method,
    path,
    ...(action.summary === undefined ? {} : { summary: action.summary }),
    ...(input === undefined || Object.keys(input).length === 0 ? {} : { input }),
    ...(isJsonObject(outputValue) ? { output: outputValue } : {}),
    ...(typeof streamingValue === 'boolean' ? { streaming: streamingValue } : {}),
  };
}

export function toOpenApiFromManifest(manifest: DotManifestLike): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const manifestAction of manifest.actions) {
    const action = httpActionFromManifestAction(manifestAction);
    if (action === null) continue;
    const path = openApiPath(action.path);
    const entry = (paths[path] ??= {});
    const method = action.method.toLowerCase();
    if (entry[method] !== undefined) {
      throw new HttpConfigError({
        code: HTTP_ERROR_CODES.duplicateRoute,
        message: `[http] duplicate route ${action.method} ${action.path}: "${action.id}" collides with an earlier action.`,
        remediation: 'Two HTTP actions claim the same method and path. Change one path, or drop the duplicate.',
      });
    }
    entry[method] = buildOperationFromAction(action);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: manifest.app.name,
      version: manifest.app.version ?? '0.0.0',
    },
    paths,
  };
}
