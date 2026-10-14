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
import type { BaseRequestCtx } from './derive.js';
import { runWithRequestContext } from './context.js';
import {
  describeInternalError,
  errorResponse,
  HTTP_ERROR_CODES,
  HttpConfigError,
  HttpError,
  toErrorResponse,
} from './error.js';
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

function createBaseCtx(req: Request): BaseRequestCtx {
  return {
    req,
    url: new URL(req.url),
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    signal: req.signal,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

async function executeRpc(bundle: RouteBundle, rpc: RpcBinding, req: Request): Promise<Response> {
  const base = createBaseCtx(req);
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

/**
 * Run one bound route. A route with no derivers and no body has nothing to
 * await before its handler, so it runs synchronously and returns the Response
 * itself when the handler does — no promise, no extra microtask. Anything
 * that needs an await goes through `executeBindingAsync`. Both paths give the
 * same responses and the same error envelopes.
 */
function executeBinding(
  bundle: RouteBundle,
  binding: RouteBinding,
  req: Request,
  params: Record<string, string>,
): Response | Promise<Response> {
  const base = createBaseCtx(req);
  if (bundle.derivers.length > 0 || binding.contract.body !== undefined) {
    return runWithRequestContext(base, () => executeBindingAsync(bundle, binding, req, base, params));
  }
  return runWithRequestContext(base, () => {
    try {
      return respond(binding, validateInputSync(binding.contract, params, base), base);
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

async function executeBindingAsync(
  bundle: RouteBundle,
  binding: RouteBinding,
  req: Request,
  base: BaseRequestCtx,
  params: Record<string, string>,
): Promise<Response> {
  try {
    let ctx: BaseRequestCtx & Record<string, unknown> = base;
    for (const deriver of bundle.derivers) {
      // Erasure boundary: derivers were stored with `never` context (see
      // ErasedDeriver); the accumulated ctx is the value they were typed
      // against at composition time.
      const value = await deriver.derive(req, ctx as never);
      ctx = { ...ctx, [deriver.key]: value };
    }

    const input =
      binding.contract.body === undefined
        ? validateInputSync(binding.contract, params, base)
        : await validateInput(binding.contract, params, base, req);
    return await respond(binding, input, ctx);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Call the handler and turn what it returns into a Response. Throws on a bad output. */
function respond(binding: RouteBinding, input: ValidatedInput, ctx: BaseRequestCtx): Response | Promise<Response> {
  if (binding.contract.kind === 'sse') {
    // Erasure boundary, same as above — input/ctx match the handler's
    // composition-time types.
    const events = (binding.handler as (input: never, ctx: never) => AsyncIterable<unknown>)(
      input as never,
      ctx as never,
    );
    return sseResponse(events, binding.contract, ctx.signal);
  }

  const returned = binding.handler(input as never, ctx as never);
  if (isPromiseLike(returned)) return settle(binding.contract, returned);
  return toResponse(binding.contract, returned);
}

async function settle(contract: ContractLike, pending: PromiseLike<unknown>): Promise<Response> {
  try {
    return toResponse(contract, await pending);
  } catch (error) {
    return toErrorResponse(error);
  }
}

function toResponse(contract: ContractLike, result: unknown): Response {
  if (result instanceof Response) return result;
  return serializeOutput(contract, result);
}

type ValidatedInput = {
  readonly params: Record<string, string>;
  readonly query: unknown;
  readonly body: unknown;
};

function parseQuery(contract: ContractLike, base: BaseRequestCtx): unknown {
  if (contract.query === undefined) return undefined;
  // Multi-valued query params collapse to their last value here; declare
  // arrays via a transform on the contract schema if you need them.
  return parseWith(contract.query, Object.fromEntries(base.url.searchParams), 'query');
}

/** Params and query only: for contracts without a body. */
function validateInputSync(
  contract: ContractLike,
  params: Record<string, string>,
  base: BaseRequestCtx,
): ValidatedInput {
  return { params, query: parseQuery(contract, base), body: undefined };
}

async function validateInput(
  contract: ContractLike,
  params: Record<string, string>,
  base: BaseRequestCtx,
  req: Request,
): Promise<ValidatedInput> {
  const query = parseQuery(contract, base);

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
  return jsonResponse(validated);
}

/**
 * Same response as `Response.json(value)` — the body is `JSON.stringify(value)`
 * and the content type `application/json` — built from a string body, which
 * costs less per request than `Response.json` in undici.
 */
function jsonResponse(value: unknown): Response {
  const text = JSON.stringify(value);
  // `Response.json` refuses a value with no JSON form (undefined, a function).
  if (text === undefined) throw new TypeError('Value is not JSON serializable');
  return new Response(text, { headers: { 'content-type': 'application/json' } });
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
