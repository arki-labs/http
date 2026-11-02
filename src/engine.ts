/**
 * The Hono engine — builds one fetch handler from a list of bundles, with
 * Hono doing the routing — and the per-route pipeline every engine shares
 * (`executeBinding`: request context, input decoding, the handler, the
 * response, the error envelope).
 *
 * `buildEngine` (compiled.ts) is the default engine: its own router for the
 * routes it can match, this engine for the rest. No Hono type appears in
 * the public API, so routing stays a swappable implementation detail. The
 * route table order is bundle order then binding order — declaration
 * order, deterministically, per DOT principle 3.
 */

import { Hono } from 'hono';

import type { IdGenerationFailure } from '@arki/contracts';
import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, isFailure, serialize } from '@arki/failure';
import { formatIssues } from '@arki/schema';

import type { MountBinding, ObserveBinding, RouteBinding, RouteBundle, RpcBinding } from './bundle.js';
import type { ContractLike, ErasedInput } from './contract.js';
import type { BaseRequestCtx } from './derive.js';
import type { Field, Job, Ran, Where, Wire } from './wire.js';
import { isReply } from './bundle.js';
import { registerEngineContext, runWithRequestContext } from './context.js';
import { errorResponse, HTTP_ERROR_CODES, HttpConfigError, HttpError, toErrorResponse } from './error.js';
import { HTTP_SERVER_FAILURES } from './failures.js';
import { requestId } from './ids.js';
import { openApiPaths } from './path.js';
import { isRawOutput } from './raw.js';
import { sseResponse } from './sse.js';
import { observeHttp } from './telemetry.js';
import { decoderOf, encoderOf, fieldParts, issuesOf, missingField, runJobs, runSchema } from './wire.js';

type MaybePromise<T> = T | Promise<T>;

/** `next(value)`, after `value` settles when it is a promise. Sync in, sync out. */
function andThen<T, U>(value: MaybePromise<T>, next: (value: T) => MaybePromise<U>): MaybePromise<U> {
  return value instanceof Promise ? value.then(next) : next(value);
}

/** What `Bun.serve` passes a `routes` handler: the request with its matched path parameters. */
export type BunRequestLike = Request & { readonly params: Readonly<Record<string, string>> };

/** A `Bun.serve` `routes` table: path → method → handler. */
export type BunRoutes = Readonly<
  Record<string, Readonly<Record<string, (req: BunRequestLike) => Response | Promise<Response>>>>
>;

/** What `buildEngine` and `buildHonoEngine` take besides the bundles. */
export type EngineOptions = {
  /**
   * Run every request inside the ambient store, so `requestContext()`
   * (`@arki/http/context`) answers from anywhere in the call stack. Off by
   * default: entering the store costs every request, and the explicit `ctx`
   * parameter covers almost every need.
   */
  readonly requestContext?: boolean;
};

/** How an engine runs one request's work: inside the ambient store, or as is. */
export type RequestScope = <T>(ctx: BaseRequestCtx, fn: () => T) => T;
const noRequestScope: RequestScope = (_ctx, fn) => fn();

/** The scope the options ask for; records with the context module whether this engine opted in. */
export function requestScopeOf(options: EngineOptions | undefined): RequestScope {
  const enabled = options?.requestContext === true;
  registerEngineContext(enabled);
  return enabled ? runWithRequestContext : noRequestScope;
}

/** A built engine: the composed fetch handler plus its route inventory. */
export type Engine = {
  readonly fetch: (req: Request) => Promise<Response>;
  /**
   * The routes Bun can match natively, when the engine has any. `listen`
   * hands them to `Bun.serve({ routes })`; a request they match never
   * reaches `fetch`. Both answer the same.
   */
  readonly bunRoutes?: BunRoutes;
  /** Contract ids + mount ids, in registration order. */
  readonly routeIds: readonly string[];
};

/** The Hono app behind {@link buildHonoEngine}: its fetch without the request span, and the route ids. */
export function buildHonoApp(
  bundles: readonly RouteBundle[],
  options?: EngineOptions,
): {
  readonly fetch: (req: Request) => Response | Promise<Response>;
  readonly routeIds: readonly string[];
} {
  const scope = requestScopeOf(options);
  const app = new Hono();
  const claimed = new Map<string, string>();
  const routeIds: string[] = [];

  for (const bundle of bundles) {
    for (const mount of bundle.mounts) {
      registerMount(app, claimed, mount);
      routeIds.push(mount.id);
    }
    for (const rpc of bundle.rpcs ?? []) {
      registerRpc(app, claimed, bundle, rpc, scope);
      routeIds.push(rpc.id);
    }
    for (const binding of bundle.bindings) {
      registerBinding(app, claimed, bundle, binding, scope);
      routeIds.push(binding.contract.id);
    }
  }

  app.notFound(c =>
    errorResponse(404, HTTP_ERROR_CODES.notFound, `no route for ${c.req.method} ${new URL(c.req.url).pathname}`),
  );
  app.onError((error, _c) => toErrorResponse(error));

  return { fetch: req => app.fetch(req), routeIds };
}

/**
 * Compose bundles into a single fetch handler. Throws
 * `ARKI_HTTP_E002`/`E006` on route collisions and malformed mounts —
 * callers (the `http()` plugin's `boot`) let these bubble as boot failures.
 */
export function buildHonoEngine(bundles: readonly RouteBundle[], options?: EngineOptions): Engine {
  const { fetch, routeIds } = buildHonoApp(bundles, options);
  return {
    fetch: req => observeHttp('http.request', () => fetch(req)),
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

function registerRpc(
  app: Hono,
  claimed: Map<string, string>,
  bundle: RouteBundle,
  rpc: RpcBinding,
  scope: RequestScope,
): void {
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
  // `prefix`/`endpoint` option, and steps/`context` read `req.url`;
  // Hono's default mount rewrite (prefix-stripped URL) breaks both.
  app.mount(rpc.path, req => executeRpc(bundle, rpc, req, scope), { replaceRequest: false });
}

/** The request context; `url` is parsed on first read, so a route that never reads it never pays for it. */
class RequestCtx implements BaseRequestCtx {
  readonly req: Request;
  readonly requestId: BaseRequestCtx['requestId'];
  #url: URL | undefined;
  constructor(req: Request, id: BaseRequestCtx['requestId']) {
    this.req = req;
    this.requestId = id;
  }
  get url(): URL {
    return (this.#url ??= new URL(this.req.url));
  }
  get signal(): AbortSignal {
    return this.req.signal;
  }
}

/**
 * The context after a step. `RequestCtx` keeps `url` and `signal` as prototype getters, which a
 * spread drops, so they are copied as own keys (this reads `url`, so only routes with stages pay
 * for the URL parse).
 */
function extendCtx(ctx: BaseRequestCtx, added: object): BaseRequestCtx {
  return { ...ctx, url: ctx.url, signal: ctx.signal, ...added };
}

function createBaseCtx(req: Request): BaseRequestCtx | IdGenerationFailure {
  const supplied = req.headers.get('x-request-id');
  const id = requestId.is(supplied) ? supplied : requestId.create();
  if (isFailure(id)) return id;
  return new RequestCtx(req, id);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

async function executeRpc(
  bundle: RouteBundle,
  rpc: RpcBinding,
  req: Request,
  scope: RequestScope,
): Promise<Response> {
  const base = createBaseCtx(req);
  if (isFailure(base)) return failureResponse(base, HTTP_SERVER_FAILURES);
  const observe = rpc.observe;
  if (observe?.watching() !== true) return scope(base, () => runRpcFrom(bundle, rpc, req, 0, base));
  // Observed: the stages rethrow, so the observer sees the throw; the envelope is made here.
  return scope(base, () =>
    observe.run(() => runRpcFrom(bundle, rpc, req, 0, base, false), refusalOf).catch(toErrorResponse),
  );
}

/**
 * Run an rpc mount's stages from `from`, then its handler. The outer call
 * (`from === 0`) turns a thrown error into the envelope; a call made by an
 * around's `next` (`from > 0`) rethrows it, so the around sees it and can
 * roll back. One async frame per request, as before arounds existed.
 */
async function runRpcFrom(
  bundle: RouteBundle,
  rpc: RpcBinding,
  req: Request,
  from: number,
  start: BaseRequestCtx & Record<string, unknown>,
  envelope = true,
): Promise<Response> {
  try {
    let ctx = start;
    const stages = rpc.stages ?? bundle.stages;
    for (let i = from; i < stages.length; i++) {
      const stage = stages[i];
      if (stage === undefined) break; // unreachable: i < stages.length (indexed read is typed possibly undefined)
      if ('around' in stage) {
        const rest = i + 1;
        const here = ctx;
        return await stage.around(here as never, () => runRpcFrom(bundle, rpc, req, rest, here));
      }
      // Same erasure boundary as runBindingFrom.
      const added = await stage.step(ctx as never);
      if (isFailure(added))
        return refusalResponse(rpc, added, rpc.contract?.failures ?? [], stage.failureHeaders?.(added));
      ctx = extendCtx(ctx, added);
    }
    const rpcCtx = await rpc.context(req, ctx as never);
    // The rpc handler owns its subtree's responses (including its own
    // error format); only THROWN errors fall through to the envelope.
    return await rpc.handle(req, rpcCtx as never);
  } catch (error) {
    if (from > 0 || !envelope) throw error;
    return toErrorResponse(error);
  }
}

/**
 * Claim a route's method and path(s) for its contract id; a second claim
 * on the same key is a duplicate route. An optional placeholder ("/a/:x?")
 * serves two paths and claims both.
 */
export function claimRoute(claimed: Map<string, string>, contract: ContractLike): void {
  const keys = openApiPaths(contract.path).map(({ path }) => `${contract.method} ${path}`);
  for (const key of keys) {
    const prior = claimed.get(key);
    if (prior !== undefined) {
      throw new HttpConfigError({
        code: HTTP_ERROR_CODES.duplicateRoute,
        message: `[http] duplicate route ${contract.method} ${contract.path}: "${contract.id}" collides with "${prior}".`,
        remediation:
          'Two bindings (possibly from different bundles) claim the same method and path. Change one path, or drop the duplicate binding.',
      });
    }
  }
  for (const key of keys) claimed.set(key, contract.id);
}

function registerBinding(
  app: Hono,
  claimed: Map<string, string>,
  bundle: RouteBundle,
  binding: RouteBinding,
  scope: RequestScope,
): void {
  const { contract } = binding;
  claimRoute(claimed, contract);
  app.on(contract.method, contract.path, c => executeBinding(bundle, binding, c.req.raw, c.req.param(), scope));
}

/**
 * Run one bound route. A route with no stages and no body has nothing to
 * await before its handler, so when its schemas answer synchronously it runs
 * synchronously and returns the Response itself when the handler does — no
 * promise, no extra microtask. Anything that needs an await goes through
 * `executeBindingAsync`. Both paths give the same responses and the same
 * error envelopes. Every engine calls this once per matched route; only
 * the match (and so `params`) and the `scope` are the engine's own.
 */
export function executeBinding(
  bundle: RouteBundle,
  binding: RouteBinding,
  req: Request,
  params: Readonly<Record<string, string>>,
  scope: RequestScope,
): Response | Promise<Response> {
  const base = createBaseCtx(req);
  if (isFailure(base)) return failureResponse(base, HTTP_SERVER_FAILURES);
  const staged = (binding.stages ?? bundle.stages).length > 0 || binding.contract.body !== undefined;
  const observe = binding.observe;
  if (observe?.watching() === true) {
    // Observed: nothing below envelopes a throw, so the observer sees it; the envelope is made here.
    return scope(base, () => {
      try {
        const response = observe.run(
          () =>
            staged
              ? runBindingFrom(bundle, binding, req, base, params, 0, base, false)
              : andThen(decodeInput(binding.contract, params, base), input => respond(binding, input, base)),
          refusalOf,
        );
        return response instanceof Promise ? response.catch(toErrorResponse) : response;
      } catch (error) {
        return toErrorResponse(error);
      }
    });
  }
  if (staged) {
    return scope(base, () => runBindingFrom(bundle, binding, req, base, params, 0, base));
  }
  return scope(base, () => {
    try {
      const response = andThen(decodeInput(binding.contract, params, base), input => respond(binding, input, base));
      return response instanceof Promise ? response.catch(toErrorResponse) : response;
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

/**
 * Run a route's stages from `from`, then read the body and call the handler.
 * The outer call (`from === 0`) turns a thrown error into the envelope; a
 * call made by an around's `next` (`from > 0`) rethrows it, so the around sees
 * it and can roll back. One async frame per request, and a closure only when
 * an around is met, so a route with none costs what it did before arounds.
 */
async function runBindingFrom(
  bundle: RouteBundle,
  binding: RouteBinding,
  req: Request,
  base: BaseRequestCtx,
  params: Readonly<Record<string, string>>,
  from: number,
  start: BaseRequestCtx & Record<string, unknown>,
  envelope = true,
): Promise<Response> {
  try {
    let ctx = start;
    const stages = binding.stages ?? bundle.stages;
    for (let i = from; i < stages.length; i++) {
      const stage = stages[i];
      if (stage === undefined) break; // unreachable: i < stages.length (indexed read is typed possibly undefined)
      if ('around' in stage) {
        const rest = i + 1;
        const here = ctx;
        return await stage.around(here as never, () => runBindingFrom(bundle, binding, req, base, params, rest, here));
      }
      // Erasure boundary: steps were stored with `never` context (see
      // ErasedStep); the accumulated ctx is the value they were typed
      // against at composition time.
      const added = await stage.step(ctx as never);
      if (isFailure(added))
        return refusalResponse(binding, added, binding.contract.failures ?? [], stage.failureHeaders?.(added));
      ctx = extendCtx(ctx, added);
    }

    const body = binding.contract.body === undefined ? undefined : await readJson(req);
    const input = await decodeInput(binding.contract, params, base, body);
    return await respond(binding, input, ctx);
  } catch (error) {
    if (from > 0 || !envelope) throw error;
    return toErrorResponse(error);
  }
}

/** Call the handler and turn what it returns into a Response. Throws on a bad output. */
function respond(binding: RouteBinding, input: ErasedInput, ctx: BaseRequestCtx): Response | Promise<Response> {
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
  if (isPromiseLike(returned)) return settle(binding, returned);
  return toResponse(binding, returned);
}

// Errors propagate: every caller makes the envelope itself (`.catch(toErrorResponse)`),
// and an around must see a handler error to roll back.
async function settle(binding: RouteBinding, pending: PromiseLike<unknown>): Promise<Response> {
  return toResponse(binding, await pending);
}

/**
 * Which Failure each refusal Response was built from. Only an observed
 * route writes here: by the time a refusal is a Response, an observer can no
 * longer see the Failure, so `refusalOf` reads it back from this map.
 */
const refusals = new WeakMap<Response, Failure>();

/** `failureResponse` for a route or mount; an observed one also remembers the Failure. */
function refusalResponse(
  watched: { readonly observe?: ObserveBinding },
  failure: Failure,
  definitions: NonNullable<ContractLike['failures']>,
  headers?: Readonly<Record<string, string>>,
): Response {
  const response = failureResponse(failure, definitions, headers);
  if (watched.observe !== undefined) refusals.set(response, failure);
  return response;
}

/** The Failure a refusal Response was built from, for an observer; `undefined` for any other value. */
function refusalOf(value: unknown): Failure | undefined {
  return value instanceof Response ? refusals.get(value) : undefined;
}

function failureResponse(
  failure: Failure,
  definitions: NonNullable<ContractLike['failures']>,
  headers?: Readonly<Record<string, string>>,
): Response {
  const wire = serialize(failure, definitions);
  const outcome = isFailure(wire) ? wire : failure;
  return errorResponse(outcome.status, outcome.code, outcome.message, {
    ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
    ...(headers === undefined ? {} : { headers }),
    ...(isFailure(wire)
      ? wire.data === undefined
        ? {}
        : { data: wire.data }
      : 'data' in wire
        ? { data: wire.data }
        : {}),
  });
}

function toResponse(binding: RouteBinding, result: unknown): Response | Promise<Response> {
  const { contract } = binding;
  if (isFailure(result)) {
    return refusalResponse(binding, result, contract.failures ?? [], binding.failureHeaders?.(result));
  }
  // `raw()` is the only way to send a Response, and the only way to skip the
  // schemas: in raw mode the handler owns the bytes, so nothing is checked.
  const rawMode = isRawOutput(contract.output);
  if (result instanceof Response) {
    if (rawMode) return result;
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.rawResponseMismatch,
      `handler for "${contract.id}" returned a Response but the contract does not declare output: raw()`,
      { remediation: 'Declare output: raw() on the contract, or return the output value.' },
    );
  }
  if (rawMode) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.rawResponseMismatch,
      `handler for "${contract.id}" declares output: raw() but did not return a Response`,
      { remediation: 'Return a Response from the handler, or declare an output schema.' },
    );
  }
  if (isReply(result)) return serializeReply(contract, result);
  if (contract.output === undefined) {
    if (result === undefined) return new Response(null, { status: 204 });
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.invalidResponse,
      `handler for "${contract.id}" returned a value but the contract declares no output schema`,
      { remediation: 'Declare an output schema on the contract, or return nothing to answer 204.' },
    );
  }
  return andThen(encodeOutput(contract, contract.output, result), encoded => jsonResponse(encoded));
}

function serializeReply(
  contract: ContractLike,
  result: { readonly status: number; readonly body: unknown; readonly headers?: Readonly<Record<string, string>> },
): Response | Promise<Response> {
  const schema = contract.responses?.[result.status];
  if (schema === undefined) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.invalidResponse,
      `handler for "${contract.id}" replied ${result.status}, which the contract does not declare in responses`,
      { remediation: 'Add the status to "responses" on the contract, or reply with a declared status.' },
    );
  }
  return andThen(encodeOutput(contract, schema, result.body), encoded =>
    jsonResponse(encoded, result.status, result.headers),
  );
}

/** The body as JSON; a body that is not JSON answers 400. */
async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, 'request body is not valid JSON', {
      remediation: 'Send a JSON body with content-type: application/json.',
      cause: InvalidInput({ issues: [{ path: ['body'], message: 'must be valid JSON' }] }),
    });
  }
}

/** A field record's entries, split once: the same record is read on every request. */
const fieldEntries = new WeakMap<Readonly<Record<string, Field>>, readonly (readonly [string, Wire, boolean])[]>();
function entriesOf(fields: Readonly<Record<string, Field>>): readonly (readonly [string, Wire, boolean])[] {
  let entries = fieldEntries.get(fields);
  if (entries === undefined) {
    entries = Object.entries(fields).map(([key, field]) => {
      const { wire, optional } = fieldParts(field);
      return [key, wire, optional] as const;
    });
    fieldEntries.set(fields, entries);
  }
  return entries;
}

/** One decode job per declared field. A missing optional field gets no job: it stays `undefined`. */
function fieldJobs(
  where: Where,
  fields: Readonly<Record<string, Field>>,
  read: (key: string) => string | undefined,
): Job[] {
  const jobs: Job[] = [];
  for (const [key, wire, optional] of entriesOf(fields)) {
    const value = read(key);
    if (value === undefined && optional) continue;
    // The `optional(...)` marker decides presence, even for a schema that accepts `undefined`.
    jobs.push({ at: [where, key], schema: value === undefined ? missingField : decoderOf(wire), value });
  }
  return jobs;
}

/** Multi-valued query keys collapse to their last value. */
function lastQueryValue(base: BaseRequestCtx, key: string): string | undefined {
  return base.url.searchParams.getAll(key).at(-1);
}

/**
 * Decode the request: each declared field from its one string (or
 * `undefined`), then the body, then the contract's `check`. Every field and
 * body issue answers one 400; a schema that throws answers 500.
 */
function decodeInput(
  contract: ContractLike,
  params: Readonly<Record<string, string>>,
  base: BaseRequestCtx,
  body?: unknown,
): MaybePromise<ErasedInput> {
  const jobs: Job[] = [];
  if (contract.params !== undefined) jobs.push(...fieldJobs('params', contract.params, key => params[key]));
  if (contract.headers !== undefined) {
    jobs.push(...fieldJobs('headers', contract.headers, key => base.req.headers.get(key) ?? undefined));
  }
  if (contract.query !== undefined) jobs.push(...fieldJobs('query', contract.query, key => lastQueryValue(base, key)));
  if (contract.body !== undefined) jobs.push({ at: ['body'], schema: decoderOf(contract.body), value: body });
  // Nothing declared at all: the raw params are the input. No jobs, no runs, no issues to collect.
  // (A declared group whose fields are all optional and absent still becomes `{}`, through assemble.)
  if (jobs.length === 0 && contract.params === undefined && contract.headers === undefined && contract.query === undefined) {
    return checked(contract, { params, headers: undefined, query: undefined, body: undefined });
  }
  return andThen(runJobs(jobs), runs => assemble(contract, params, runs));
}

function assemble(contract: ContractLike, params: Readonly<Record<string, string>>, runs: readonly Ran[]): ErasedInput {
  rejectIssues(issuesOf(runs));
  // One fresh record per declared group; an undeclared group stays `undefined` (params: the raw ones).
  const decodedParams: Record<string, unknown> | undefined = contract.params === undefined ? undefined : {};
  const headers: Record<string, unknown> | undefined = contract.headers === undefined ? undefined : {};
  const query: Record<string, unknown> | undefined = contract.query === undefined ? undefined : {};
  let body: unknown;
  for (const { job, result } of runs) {
    if (result.issues !== undefined) continue;
    const [where, key] = job.at;
    if (where === 'body') body = result.value;
    else if (key !== undefined) {
      const group = where === 'params' ? decodedParams : where === 'headers' ? headers : query;
      if (group !== undefined) group[key] = result.value;
    }
  }
  return checked(contract, { params: decodedParams ?? params, headers, query, body });
}

/** The contract's own `check`, after every field and the body decoded. */
function checked(contract: ContractLike, input: ErasedInput): ErasedInput {
  if (contract.check !== undefined) rejectIssues(contract.check(input) ?? []);
  return input;
}

/** Throw the 400 for any issue: `request validation failed: query.page: …`. */
function rejectIssues(issues: readonly StandardSchemaV1.Issue[]): void {
  if (issues.length === 0) return;
  throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `request validation failed: ${formatIssues(issues)}`, {
    cause: InvalidInput({ issues }),
  });
}

/**
 * Encode, not decode: output leaves the server, so a codec runs its
 * `encode` side (a `Date` goes out as an ISO string). Issues answer 500.
 */
function encodeOutput(contract: ContractLike, wire: Wire, result: unknown): MaybePromise<unknown> {
  return andThen(runSchema(encoderOf(wire), result), outcome => {
    if (outcome.issues === undefined) return outcome.value;
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.internal,
      `handler output for "${contract.id}" violates the contract's output schema: ${formatIssues(outcome.issues)}`,
      { cause: InvalidInput({ issues: outcome.issues }) },
    );
  });
}

/**
 * `Response.json(value)` with the status and extra headers. Measured on Bun
 * 1.4 and Node 26 (undici 8): cheaper than `new Response(JSON.stringify(value))`
 * on both, the reverse of older undici. `Response.json` throws a `TypeError`
 * for a value with no JSON form (undefined, a function).
 */
function jsonResponse(value: unknown, status = 200, headers?: Readonly<Record<string, string>>): Response {
  return Response.json(value, {
    status,
    ...(headers === undefined ? {} : { headers: { ...headers, 'content-type': 'application/json' } }),
  });
}

/**
 * App-wide middleware: a fetch-shaped wrapper. The first middleware in a
 * list runs outermost. Use for cross-cutting concerns that must see or
 * touch the raw request/response — CORS, request logging, compression.
 * For per-request *values* (auth principals, tenant handles), use
 * bundle steps — they are typed into handler contexts; middleware is not.
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
): (req: Request) => Promise<Response>;
/**
 * Wrap a whole engine: its `fetch` and, when it has them, every Bun route
 * handler, so a request Bun matches natively still runs the same layers.
 * A layer that forwards a different `Request` loses the native match; the
 * engine then routes that request itself.
 */
export function composeMiddleware(engine: Engine, middleware: readonly HttpMiddleware[]): Engine;
export function composeMiddleware(
  target: Engine | ((req: Request) => Promise<Response>),
  middleware: readonly HttpMiddleware[],
): Engine | ((req: Request) => Promise<Response>) {
  if (typeof target === 'function') return composeFetch(target, middleware);
  const fetch = composeFetch(target.fetch, middleware);
  if (target.bunRoutes === undefined) return { ...target, fetch };
  const bunRoutes: Record<string, Record<string, (req: BunRequestLike) => Promise<Response>>> = {};
  for (const [path, byMethod] of Object.entries(target.bunRoutes)) {
    bunRoutes[path] = {};
    for (const [method, handler] of Object.entries(byMethod)) {
      const composed = composeFetch(async req => await handler(req as BunRequestLike), middleware);
      bunRoutes[path][method] = composed;
    }
  }
  return { ...target, fetch, bunRoutes };
}

function composeFetch(
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
