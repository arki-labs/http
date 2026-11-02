/**
 * A typed fetch client built from the same route contracts the server binds.
 *
 * ```ts
 * import { createClient } from '@arki/http/client';
 * import { getOrder, listOrders } from './contracts';
 *
 * const orders = createClient({ getOrder, listOrders }, { baseUrl: 'https://api.example.com' });
 * const order = await orders.getOrder({ params: { id: 'o42' } });
 * ```
 *
 * Inputs are typed from the contract and encoded the way the server decodes
 * them: each param, header and query field and the body run through their
 * schema in the encode direction (a `codec()` turns a `Date` into its ISO
 * string; a bare schema is its own encoder), and path params are
 * URL-escaped. A missing `optional(...)` field is left out.
 *
 * The result follows the contract: a status listed in `responses` decodes
 * with that schema, a success decodes with `output`, a route without `output`
 * resolves `undefined` (it answers 204), and a `raw()` route resolves the
 * `Response`. A failed call whose code is one of the contract's `failures`
 * resolves to that failure, revived and its data checked with the
 * definition's schema. Client-owned validation, network, cancellation and protocol
 * outcomes resolve to their canonical failures too.
 *
 * Uses only `fetch` — no Node APIs — so it runs in browsers, React Native,
 * Deno, Bun and Node. This is why it lives at its own subpath: the root entry
 * pulls in the server engine.
 */

import { z } from 'zod';
import type { PolicyExecution, ResilienceFailure } from '@arki/resilience';
import { withFallback, CircuitOpen, BulkheadRejected, Timeout } from '@arki/resilience';

import {
  InvalidEnvelope,
  InvalidInput,
  isFailure,
  REVIVAL_FAILURES,
  revive,
  UnexpectedDefect,
  UnexpectedFailure,
  ValidatorDefect,
} from '@arki/failure';
import { formatIssues, is, parseAsync } from '@arki/schema';

import type { PathParams, ResponseSchemas, RouteContract, RouteDef, RouteFailure, RouteInput } from './contract.js';
import type { HttpClientFailure } from './failures.js';
import type { RawOutput } from './raw.js';
import type { Fields, Job, Ran, Where, Wire, WireValue } from './wire.js';
import { HTTP_ERROR_CODES, HttpError } from './error.js';
import { HTTP_SERVER_FAILURES, NetworkFailure, RequestCancelled, RequestTimeout } from './failures.js';
import { isRawOutput } from './raw.js';
import { decoderOf, encoderOf, fieldParts, issuesOf, missingField, runJobs } from './wire.js';

export { HTTP_CLIENT_FAILURES, NetworkFailure, RequestCancelled, RequestTimeout } from './failures.js';
export type { HttpClientFailure } from './failures.js';

/** Any JSON route contract — what {@link createClient} accepts. */
type AnyRoute = RouteContract<string, RouteDef<string>>;

/** Nothing to pass: the identity for the input intersections below. */
type NoInput = Record<never, never>;

type ParamsInput<TPath extends string, TParams> = [PathParams<TPath>] extends [never]
  ? NoInput
  : NoInput extends TParams
    ? { readonly params?: TParams }
    : { readonly params: TParams };

/** An input the caller may leave out when every field of it is optional. */
type OptionalWhenEmpty<TName extends string, TValue> = [TValue] extends [undefined]
  ? NoInput
  : NoInput extends TValue
    ? Partial<Readonly<Record<TName, TValue>>>
    : Readonly<Record<TName, TValue>>;

type BodyInput<TBody> = [TBody] extends [undefined] ? NoInput : { readonly body: TBody };

/**
 * What one client call takes: `params` when the path has parameters, and
 * `query`, `headers` and `body` when the contract declares them. Each is the
 * value form — the same values the server handler receives; a field marked
 * `optional(...)` may be left out.
 */
export type ClientInput<TRoute> = TRoute extends { readonly path: infer TPath extends string }
  ? Flatten<
      ParamsInput<TPath, RouteInput<TPath, TRoute>['params']> &
        OptionalWhenEmpty<'query', RouteInput<TPath, TRoute>['query']> &
        OptionalWhenEmpty<'headers', RouteInput<TPath, TRoute>['headers']> &
        BodyInput<RouteInput<TPath, TRoute>['body']>
    >
  : never;

/** Merge an intersection into one object type, so editors show it plainly. */
type Flatten<T> = { [K in keyof T]: T[K] };

type SuccessOf<TRoute> = TRoute extends { readonly output: infer TOutput }
  ? TOutput extends Wire
    ? WireValue<TOutput>
    : never
  : undefined;

type StatusBodies<TRoute> = TRoute extends { readonly responses: infer TResponses extends ResponseSchemas }
  ? { [S in keyof TResponses & number]: WireValue<TResponses[S]> }[keyof TResponses & number]
  : never;

/**
 * What one client call resolves to: the output's value form
 * (`undefined` when the contract has no output, `Response` for `raw()`),
 * the body of a status listed in `responses`, or one of the failures the
 * contract lists.
 */
export type ClientOutput<TRoute> = TRoute extends { readonly output: RawOutput }
  ? Response | RouteFailure<TRoute> | HttpClientFailure
  : SuccessOf<TRoute> | StatusBodies<TRoute> | RouteFailure<TRoute> | HttpClientFailure;

/** Per-call options: an abort signal and extra request headers. */
type CallInit = {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
};

/** One typed call. The input argument may be left out when nothing is required. */
export type ClientCall<TRoute> =
  NoInput extends ClientInput<TRoute>
    ? (input?: ClientInput<TRoute>, init?: CallInit) => Promise<ClientOutput<TRoute>>
    : (input: ClientInput<TRoute>, init?: CallInit) => Promise<ClientOutput<TRoute>>;

/**
 * What the client needs from a retry policy: an `@arki/resilience` policy fits. A policy with a
 * fallback does not, because its result could be the fallback instead of a response.
 */
export type ClientPolicy = PolicyExecution<never, ResilienceFailure>;

/** One attempt's outcome, as `retryOn` sees it: the response, or the error `fetch` threw. */
export type RetryOutcome = {
  readonly method: string;
  /** True for GET, HEAD, OPTIONS, PUT and DELETE, and for any request with an `idempotency-key` header. */
  readonly repeatable: boolean;
} & ({ readonly response: Response; readonly error?: never } | { readonly error: unknown; readonly response?: never });

/** Options for {@link createClient}. */
export type ClientOptions = {
  /** Origin plus any path prefix, e.g. `https://api.example.com/v1`. A relative prefix (`/api`) works where fetch allows it. */
  readonly baseUrl: string;
  /**
   * The fetch to use. Defaults to the global `fetch`. Wrap it to add auth headers. On a server that
   * calls URLs it does not fully control, pass `publicFetch()` from `@arki/http/public-fetch`.
   */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /**
   * Gives up once the response has not arrived within this many milliseconds, retries included,
   * and returns `RequestTimeout` (408). Reading the body is not timed.
   */
  readonly timeoutMs?: number;
  /**
   * Runs each attempt, so it can retry and back off. Only an outcome `retryOn` accepts is retried;
   * any other answer or error leaves the policy at once, whatever the policy itself would retry.
   */
  readonly policy?: ClientPolicy;
  /** Which outcomes `policy` retries. Default {@link retryTransient}. */
  readonly retryOn?: (outcome: RetryOutcome) => boolean;
};

const RETRY_STATUSES = new Set([408, 429, 502, 503, 504]);
const REPEATABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * The default `retryOn`: a network failure (`fetch` throws a `TypeError`) or a 408, 429, 502, 503
 * or 504, and only on a request that is safe to send twice. A POST without an idempotency key is
 * never retried: the first try may have done the work before the answer was lost.
 */
export function retryTransient(outcome: RetryOutcome): boolean {
  if (!outcome.repeatable) return false;
  return outcome.response === undefined
    ? outcome.error instanceof TypeError
    : RETRY_STATUSES.has(outcome.response.status);
}

/** Build one typed call from a single contract. */
export function createClient<TRoute extends AnyRoute>(contract: TRoute, options: ClientOptions): ClientCall<TRoute>;
/** Build one typed call per contract, under the same keys. */
export function createClient<TRoutes extends Readonly<Record<string, AnyRoute>>>(
  contracts: TRoutes,
  options: ClientOptions,
): { readonly [K in keyof TRoutes]: ClientCall<TRoutes[K]> };
// The implementation works on erased contracts (`ErasedCall`); the overloads
// above carry the inferred types. TypeScript cannot relate a conditional type
// over a generic contract to the erased call, so the implementation's return
// is declared `unknown` — the same erasure boundary the engine uses.
export function createClient(
  contractOrContracts: AnyRoute | Readonly<Record<string, AnyRoute>>,
  options: ClientOptions,
): unknown {
  // Read once into a local: calling `fetch` as a method of another object
  // throws "Illegal invocation" in browsers.
  const transport: Transport = {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs,
    policy: options.policy,
    retryOn: options.retryOn ?? retryTransient,
  };
  if (isRoute(contractOrContracts)) return buildCall(contractOrContracts, transport);
  const calls: Record<string, ErasedCall> = {};
  for (const [key, contract] of Object.entries(contractOrContracts)) {
    calls[key] = buildCall(contract, transport);
  }
  return calls;
}

type ErasedInput = {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
};

/** A call with its contract's generics erased; the overloads restore them. */
type ErasedCall = (input?: ErasedInput, init?: CallInit) => Promise<unknown>;

type Transport = {
  readonly baseUrl: string;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs: number | undefined;
  readonly policy: ClientPolicy | undefined;
  readonly retryOn: (outcome: RetryOutcome) => boolean;
};

function isRoute(value: AnyRoute | Readonly<Record<string, AnyRoute>>): value is AnyRoute {
  return value.kind === 'http' && typeof value.path === 'string';
}

function buildCall(contract: AnyRoute, transport: Transport): ErasedCall {
  return async (input, init) => {
    try {
      return await call(contract, transport, input ?? {}, init ?? {});
    } catch (error) {
      if (error instanceof UnexpectedFailure && ValidatorDefect.is(error.failure)) return error.failure;
      if (error instanceof HttpError && InvalidInput.is(error.cause)) return error.cause;
      if (error instanceof HttpError && error.status === 400) {
        return InvalidInput({ issues: [{ message: error.message }] });
      }
      return UnexpectedDefect({ cause: error });
    }
  };
}

async function call(contract: AnyRoute, transport: Transport, input: ErasedInput, init: CallInit): Promise<unknown> {
  // Sync schemas encode without an await, so `fetch` starts in the caller's tick.
  const pending = encodeInput(contract, input);
  const encoded = pending instanceof Promise ? await pending : pending;
  let url = transport.baseUrl + fillPath(contract.path, encoded.params);
  const search = Object.entries(encoded.query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  if (search !== '') url += `?${search}`;

  // A plain record, not `Headers`: Hermes has no `Headers` unless a polyfill adds it.
  const headers: Record<string, string> = { ...encoded.headers, ...init.headers };
  const request: RequestInit = { method: contract.method, headers };
  if (contract.body !== undefined) {
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    request.body = JSON.stringify(encoded.body);
  }

  const repeatable = REPEATABLE_METHODS.has(contract.method) || hasHeader(headers, 'idempotency-key');
  // The route template, not the URL: the URL may carry tokens, and this text can reach a log or the wire.
  const response = await send(transport, url, request, init.signal, repeatable, `${contract.method} ${contract.path}`);
  if (isFailure(response)) return response;
  // A status the contract lists answers with that schema's body, ok or not.
  const listed = isRawOutput(contract.output) ? undefined : contract.responses?.[response.status];
  if (listed !== undefined) return decodeBody(contract, listed, response);
  if (!response.ok) return await toListedFailure(contract, response);
  if (isRawOutput(contract.output)) return response;
  if (contract.output === undefined || response.status === 204) return undefined;
  return decodeBody(contract, contract.output, response);
}

/** The request parts, encoded: one string per param, query key and header, and the body's wire value. */
type EncodedInput = {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
};

/** One encode job per field the caller gave (or a required one it left out, which then fails). */
function fieldJobs(
  where: Exclude<Where, 'body'>,
  fields: Fields,
  values: Readonly<Record<string, unknown>> | undefined,
): Job[] {
  const jobs: Job[] = [];
  for (const [key, field] of Object.entries(fields)) {
    const { wire, optional } = fieldParts(field);
    const value = values?.[key];
    if (value === undefined && optional) continue;
    // The `optional(...)` marker decides presence, even for a schema that accepts `undefined`.
    jobs.push({ at: [where, key], schema: value === undefined ? missingField : encoderOf(wire), value });
  }
  return jobs;
}

/**
 * Run every declared field and the body through its encoder. Issues throw
 * the 400 the server would answer, before anything is sent; a schema that
 * throws propagates.
 */
function encodeInput(contract: AnyRoute, input: ErasedInput): EncodedInput | Promise<EncodedInput> {
  const jobs: Job[] = [];
  if (contract.params !== undefined) jobs.push(...fieldJobs('params', contract.params, input.params));
  if (contract.query !== undefined) jobs.push(...fieldJobs('query', contract.query, input.query));
  if (contract.headers !== undefined) jobs.push(...fieldJobs('headers', contract.headers, input.headers));
  if (contract.body !== undefined) jobs.push({ at: ['body'], schema: encoderOf(contract.body), value: input.body });
  const ran = runJobs(jobs);
  return ran instanceof Promise ? ran.then(runs => collect(contract, input, runs)) : collect(contract, input, ran);
}

function collect(contract: AnyRoute, input: ErasedInput, runs: readonly Ran[]): EncodedInput {
  const issues = issuesOf(runs);
  if (issues.length > 0) {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `request validation failed: ${formatIssues(issues)}`, {
      cause: InvalidInput({ issues }),
    });
  }
  const strings: Record<Exclude<Where, 'body'>, Record<string, string>> = { params: {}, query: {}, headers: {} };
  // Undeclared path params pass through as the strings the caller gave.
  if (contract.params === undefined) {
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value !== undefined) strings.params[key] = scalarString('params', key, value);
    }
  }
  let body: unknown;
  for (const { job, result } of runs) {
    const [where, key] = job.at;
    if (result.issues !== undefined) continue;
    if (where === 'body') body = result.value;
    else if (key !== undefined && result.value !== undefined)
      strings[where][key] = scalarString(where, key, result.value);
  }
  return { ...strings, body };
}

/** A response `retryOn` accepted, thrown so the policy retries. Unwrapped when the policy gives up. */
class RetryableResponse extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super(`retryable status ${response.status}`);
    this.response = response;
  }
}

const retryableResponseSchema = z.instanceof(RetryableResponse);

type Attempt = { readonly response: Response } | { readonly error: unknown };

/** Own fetch exceptions without widening the public result to an arbitrary failure. */
async function send(...args: Parameters<typeof sendOnceOrRetry>): Promise<Response | HttpClientFailure> {
  try {
    return await sendOnceOrRetry(...args);
  } catch (error) {
    if (args[3]?.aborted === true) return RequestCancelled({ cause: error });
    if (error instanceof HttpError && error.code === HTTP_ERROR_CODES.requestTimeout) {
      return RequestTimeout({ cause: error });
    }
    if (error instanceof TypeError) return NetworkFailure({ cause: error });
    return UnexpectedDefect({ cause: error });
  }
}

/** Send once, or through the policy; either way under the deadline. */
async function sendOnceOrRetry(
  transport: Transport,
  url: string,
  request: RequestInit,
  signal: AbortSignal | undefined,
  repeatable: boolean,
  routeName: string,
): Promise<Response | HttpClientFailure> {
  const { policy, retryOn } = transport;
  const method = request.method ?? 'GET';
  const deadline = withDeadline(signal, transport.timeoutMs, routeName);
  try {
    if (policy === undefined) return await transport.fetch(url, withSignal(request, deadline.signal));
    let previous: Response | undefined;
    const attempt = async (context: { readonly signal: AbortSignal }): Promise<Attempt> => {
      // A retried response is dropped unread: free its connection before the next try.
      void previous?.body?.cancel().catch(() => null);
      let response: Response;
      try {
        response = await transport.fetch(url, { ...request, signal: context.signal });
      } catch (error) {
        // Thrown back into the policy only when it may retry; anything else leaves it at once.
        if (retryOn({ method, repeatable, error })) throw error;
        return { error };
      }
      if (!retryOn({ method, repeatable, response })) return { response };
      previous = response;
      throw new RetryableResponse(response);
    };
    // Explicit fallback sees only callback throws, before the public defect boundary.
    // Returned clock/engine failures retain their own identity and classification.
    const outcome = await withFallback(policy, (error: unknown): Attempt =>
      is(error, retryableResponseSchema) ? { response: error.response } : { error },
    ).execute(attempt, deadline.signal);
    if (isFailure(outcome)) {
      if (UnexpectedDefect.is(outcome) || CircuitOpen.is(outcome) || BulkheadRejected.is(outcome)) return outcome;
      if (Timeout.is(outcome) || (deadline.signal?.reason instanceof HttpError && deadline.signal.reason.code === HTTP_ERROR_CODES.requestTimeout)) {
        return RequestTimeout({ cause: outcome });
      }
      return RequestCancelled({ cause: outcome });
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  } catch (error) {
    // A timeout or the caller's abort may surface as the policy's own cancel error: report the cause.
    if (deadline.signal?.aborted === true && deadline.signal.reason !== undefined) throw deadline.signal.reason;
    throw error;
  } finally {
    deadline.clear();
  }
}

function withSignal(request: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? request : { ...request, signal };
}

type Deadline = { readonly signal: AbortSignal | undefined; readonly clear: () => void };

/** The caller's signal, plus an abort after `timeoutMs` with `HttpError` 408. */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number | undefined, what: string): Deadline {
  if (timeoutMs === undefined) return { signal, clear: () => null };
  const controller = new AbortController();
  const follow = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) follow();
  else signal?.addEventListener('abort', follow, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new HttpError(408, HTTP_ERROR_CODES.requestTimeout, `${what} got no response within ${timeoutMs} ms`),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', follow);
    },
  };
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

/** `/orders/:id` + `{ id: 'a b' }` → `/orders/a%20b`. A missing optional segment is dropped. */
function fillPath(path: string, params: Readonly<Record<string, string>>): string {
  const filled = path
    .split('/')
    .map(segment => fillSegment(segment, params))
    .filter((segment): segment is string => segment !== undefined);
  return filled.join('/') || '/';
}

function fillSegment(segment: string, params: Readonly<Record<string, string>>): string | undefined {
  if (!segment.startsWith(':')) return segment;
  const optional = segment.endsWith('?');
  const name = segment.slice(1, optional ? -1 : undefined);
  const value = params[name];
  if (value === undefined) {
    if (optional) return undefined;
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `path parameter "${name}" is missing`);
  }
  // encodeURIComponent keeps "." and "..", and fetch resolves them: `..` in
  // `/orders/:id/cancel` would call `/cancel`, another endpoint, with the
  // user's cookies. An empty value collapses the segment the same way.
  if (value === '' || value === '.' || value === '..') {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `path parameter "${name}" must not be empty, "." or ".."`, {
      remediation: 'A path parameter fills exactly one segment; pass a real id.',
    });
  }
  return encodeURIComponent(value);
}

/**
 * The server reads each param, header and query key as one string, so every
 * encoded field must be a string, number, boolean or bigint.
 */
function scalarString(where: string, key: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new HttpError(
    400,
    HTTP_ERROR_CODES.badRequest,
    `${where} validation failed: ${key}: must encode to a string, number or boolean`,
    { remediation: `Give the ${where} field a codec that encodes to a string.` },
  );
}

async function decodeBody(_contract: AnyRoute, output: Wire, response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return InvalidEnvelope({ reason: 'invalid_json' }, { cause: error });
  }
  const parsed = await parseAsync(decoderOf(output), body);
  if (InvalidInput.is(parsed)) return InvalidEnvelope({ reason: 'invalid_data' }, { cause: parsed });
  return parsed;
}

const errorEnvelopeSchema = z.object({
  error: z.object({
    version: z.unknown().optional(),
    code: z.string(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});

/** Remote metadata is never trusted; revive through the contract and canonical boundary definitions. */
async function toListedFailure(contract: AnyRoute, response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return InvalidEnvelope({ reason: 'invalid_json' }, { cause: error });
  }
  const envelope = errorEnvelopeSchema.safeParse(body);
  if (!envelope.success) return InvalidEnvelope({ reason: 'malformed' });
  return revive(envelope.data.error, [
    InvalidInput,
    ...REVIVAL_FAILURES,
    ...HTTP_SERVER_FAILURES,
    ...(contract.failures ?? []),
  ]);
}
