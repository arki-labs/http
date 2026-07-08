/**
 * The request engine — builds one fetch handler from a list of bundles.
 *
 * Hono does the routing internally; no Hono type appears in the public
 * API, so the engine stays a swappable implementation detail. The route
 * table order is bundle order then binding order — declaration order,
 * deterministically, per DOT principle 3.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { MountBinding, RouteBinding, RouteBundle, RpcBinding } from './bundle.js';
import type { ContractLike } from './contract.js';
import { runWithRequestContext } from './context.js';
import type { BaseRequestCtx } from './derive.js';
import { describeInternalError, errorResponse, HTTP_ERROR_CODES, HttpConfigError, HttpError, toErrorResponse } from './error.js';
import { sseResponse } from './sse.js';

/** A built engine: the composed fetch handler plus its route inventory. */
export type Engine = {
  readonly fetch: (req: Request) => Promise<Response>;
  /** Contract ids + mount ids, in registration order. */
  readonly routeIds: readonly string[];
};

/**
 * Compose bundles into a single fetch handler. Throws
 * `ARKI_HTTP_E002`/`E006` on route collisions and malformed mounts —
 * callers (the `http()` plugin's `boot`) let these bubble as boot failures.
 */
export function buildEngine(bundles: readonly RouteBundle[]): Engine {
  const app = new Hono();
  const claimed = new Map<string, string>();
  const routeIds: string[] = [];

  for (const bundle of bundles) {
    for (const mount of bundle.mounts) {
      registerMount(app, claimed, mount);
      routeIds.push(mount.id);
    }
    for (const rpc of bundle.rpcs ?? []) {
      registerRpc(app, claimed, bundle, rpc);
      routeIds.push(rpc.id);
    }
    for (const binding of bundle.bindings) {
      registerBinding(app, claimed, bundle, binding);
      routeIds.push(binding.contract.id);
    }
  }

  app.notFound(c =>
    errorResponse(404, HTTP_ERROR_CODES.notFound, `no route for ${c.req.method} ${new URL(c.req.url).pathname}`),
  );
  app.onError((error, _c) => toErrorResponse(error));

  return {
    fetch: req => Promise.resolve(app.fetch(req)),
    routeIds,
  };
}

function registerMount(app: Hono, claimed: Map<string, string>, mount: MountBinding): void {
  const key = `MOUNT ${mount.path}`;
  const prior = claimed.get(key);
  if (prior !== undefined) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.duplicateRoute,
      message: `[http] duplicate mount at "${mount.path}": "${mount.id}" collides with "${prior}".`,
      remediation: 'Give each mounted handler a distinct path prefix.',
    });
  }
  claimed.set(key, mount.id);
  app.mount(mount.path, mount.handler);
}

function registerRpc(app: Hono, claimed: Map<string, string>, bundle: RouteBundle, rpc: RpcBinding): void {
  // Rpc mounts share the mount claim namespace: an rpc prefix colliding
  // with a raw mount (or another rpc) is the same routing bug.
  const key = `MOUNT ${rpc.path}`;
  const prior = claimed.get(key);
  if (prior !== undefined) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.duplicateRoute,
      message: `[http] duplicate mount at "${rpc.path}": "${rpc.id}" collides with "${prior}".`,
      remediation: 'Give each mounted handler a distinct path prefix.',
    });
  }
  claimed.set(key, rpc.id);
  // `replaceRequest: false` — the bound handler must see the ORIGINAL
  // request. oRPC/tRPC fetch adapters take the mount path as their own
  // `prefix`/`endpoint` option, and derivers/`context` read `req.url`;
  // Hono's default mount rewrite (prefix-stripped URL) breaks both.
  app.mount(rpc.path, req => executeRpc(bundle, rpc, req), { replaceRequest: false });
}

async function executeRpc(bundle: RouteBundle, rpc: RpcBinding, req: Request): Promise<Response> {
  const base: BaseRequestCtx = {
    req,
    url: new URL(req.url),
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    signal: req.signal,
  };
  return runWithRequestContext(base, async () => {
    try {
      let ctx: BaseRequestCtx & Record<string, unknown> = base;
      for (const deriver of bundle.derivers) {
        // Same erasure boundary as executeBinding.
        const value = await deriver.derive(req, ctx as never);
        ctx = { ...ctx, [deriver.key]: value };
      }
      const rpcCtx = await rpc.context(req, ctx as never);
      // The rpc handler owns its subtree's responses (including its own
      // error format); only THROWN errors fall through to the envelope.
      return await rpc.handle(req, rpcCtx as never);
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

function registerBinding(app: Hono, claimed: Map<string, string>, bundle: RouteBundle, binding: RouteBinding): void {
  const { contract } = binding;
  const key = `${contract.method} ${contract.path}`;
  const prior = claimed.get(key);
  if (prior !== undefined) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.duplicateRoute,
      message: `[http] duplicate route ${key}: "${contract.id}" collides with "${prior}".`,
      remediation:
        'Two bindings (possibly from different bundles) claim the same method and path. Change one path, or drop the duplicate binding.',
    });
  }
  claimed.set(key, contract.id);
  app.on(contract.method, contract.path, c => executeBinding(bundle, binding, c.req.raw, c.req.param()));
}

async function executeBinding(
  bundle: RouteBundle,
  binding: RouteBinding,
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const base: BaseRequestCtx = {
    req,
    url: new URL(req.url),
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    signal: req.signal,
  };
  return runWithRequestContext(base, async () => {
    try {
      let ctx: BaseRequestCtx & Record<string, unknown> = base;
      for (const deriver of bundle.derivers) {
        // Erasure boundary: derivers were stored with `never` context (see
        // ErasedDeriver); the accumulated ctx is the value they were typed
        // against at composition time.
        const value = await deriver.derive(req, ctx as never);
        ctx = { ...ctx, [deriver.key]: value };
      }

      const input = await validateInput(binding.contract, params, base.url, req);

      if (binding.contract.kind === 'sse') {
        // Erasure boundary, same as above — input/ctx match the handler's
        // composition-time types.
        const events = (binding.handler as (input: never, ctx: never) => AsyncIterable<unknown>)(
          input as never,
          ctx as never,
        );
        return sseResponse(events, binding.contract, base.signal);
      }

      const result = await (binding.handler as (input: never, ctx: never) => unknown)(input as never, ctx as never);
      if (result instanceof Response) return result;
      return serializeOutput(binding.contract, result);
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

type ValidatedInput = {
  readonly params: Record<string, string>;
  readonly query: unknown;
  readonly body: unknown;
};

async function validateInput(
  contract: ContractLike,
  params: Record<string, string>,
  url: URL,
  req: Request,
): Promise<ValidatedInput> {
  let query: unknown;
  if (contract.query !== undefined) {
    // Multi-valued query params collapse to their last value here; declare
    // arrays via a transform on the contract schema if you need them.
    query = parseWith(contract.query, Object.fromEntries(url.searchParams), 'query');
  }

  let body: unknown;
  if (contract.body !== undefined) {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new HttpError(400, HTTP_ERROR_CODES.badRequest, 'request body is not valid JSON', {
        remediation: 'Send a JSON body with content-type: application/json.',
      });
    }
    body = parseWith(contract.body, raw, 'body');
  }

  return { params, query, body };
}

function parseWith(schema: { parse(input: unknown): unknown }, value: unknown, where: 'query' | 'body'): unknown {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `${where} validation failed: ${zodMessage(error)}`, {
      cause: error,
    });
  }
}

function zodMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  }
  return describeInternalError(error);
}

function serializeOutput(contract: ContractLike, result: unknown): Response {
  if (contract.output === undefined) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.internal,
      `handler for "${contract.id}" returned a value but the contract declares no output schema`,
      { remediation: 'Return a Response, or declare an output schema on the contract.' },
    );
  }
  let validated: unknown;
  try {
    validated = contract.output.parse(result);
  } catch (error) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.internal,
      `handler output for "${contract.id}" violates the contract's output schema: ${zodMessage(error)}`,
      { cause: error },
    );
  }
  return Response.json(validated);
}

/**
 * App-wide middleware: a fetch-shaped wrapper. The first middleware in a
 * list runs outermost. Use for cross-cutting concerns that must see or
 * touch the raw request/response — CORS, request logging, compression.
 * For per-request *values* (auth principals, tenant handles), use
 * derivers — they are typed into handler contexts; middleware is not.
 */
export type HttpMiddleware = (req: Request, next: (req: Request) => Promise<Response>) => Response | Promise<Response>;

/**
 * Wrap a fetch handler in middleware (first = outermost). A middleware
 * that throws resolves to the coded error envelope — `HttpError` keeps
 * its status, anything else is a 500.
 */
export function composeMiddleware(
  fetch: (req: Request) => Promise<Response>,
  middleware: readonly HttpMiddleware[],
): (req: Request) => Promise<Response> {
  let composed = fetch;
  for (const layer of middleware.toReversed()) {
    const next = composed;
    composed = async req => await layer(req, next);
  }
  const outermost = composed;
  return async req => {
    try {
      return await outermost(req);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
