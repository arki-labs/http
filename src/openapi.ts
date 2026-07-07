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

type JsonObject = Record<string, unknown>;

/**
 * Convert a contract schema to JSON Schema. Schema erasure seam:
 * {@link ContractLike} types schemas as `parse`-only, but contracts built
 * via `route.*` always hold zod schemas (see `SchemaLike` docs) — the
 * cast re-attaches what the erased view dropped.
 */
function toJsonSchema(schema: { parse(input: unknown): unknown }): JsonObject {
  const json = z.toJSONSchema(schema as z.ZodType) as JsonObject;
  // The dialect header is noise when embedding into OpenAPI 3.1.
  const { $schema: _dialect, ...rest } = json;
  return rest;
}

function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/:(\w+)/g)]
    .map(match => match[1])
    .filter((name): name is string => name !== undefined);
}

function openApiPath(path: string): string {
  return path.replaceAll(/:(\w+)/g, '{$1}');
}

function queryParameters(schema: { parse(input: unknown): unknown }): JsonObject[] {
  const json = toJsonSchema(schema);
  const properties = (json['properties'] ?? {}) as Readonly<Record<string, unknown>>;
  const required = new Set(json['required'] as readonly string[] | undefined);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: propertySchema,
  }));
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

/** The DOT `registerRoute` argument derived from a contract. */
export type RouteMeta = {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly transport: 'http';
  readonly description?: string;
  readonly input?: { readonly query?: JsonObject; readonly body?: JsonObject };
  readonly output?: JsonObject;
  readonly streaming?: boolean;
};

/**
 * Manifest metadata for a contract — what `registerRoutes` (from
 * `@arki/http/dot`) feeds into `ctx.registerRoute` so that
 * `dot explain --openapi` can render without booting. SSE contracts mark
 * `streaming` and carry the per-event schema as `output`.
 */
export function contractMeta(contract: ContractLike): RouteMeta {
  const input: { query?: JsonObject; body?: JsonObject } = {};
  if (contract.query !== undefined) input.query = toJsonSchema(contract.query);
  if (contract.body !== undefined) input.body = toJsonSchema(contract.body);

  const outputSchema = contract.kind === 'sse' ? contract.event : contract.output;

  return {
    id: contract.id,
    method: contract.method,
    path: contract.path,
    transport: 'http',
    ...(contract.summary === undefined ? {} : { description: contract.summary }),
    ...(Object.keys(input).length === 0 ? {} : { input }),
    ...(outputSchema === undefined ? {} : { output: toJsonSchema(outputSchema) }),
    ...(contract.kind === 'sse' ? { streaming: true } : {}),
  };
}
