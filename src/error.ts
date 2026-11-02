/**
 * Error surface for `@arki/http`.
 *
 * Two families, mirroring the DOT diagnostics doctrine:
 *
 *  - {@link HttpConfigError} — composition/lifecycle failures (duplicate
 *    routes, listen failures, drain timeouts). Thrown from `boot`/`start`/
 *    `stop`; the kernel wraps them and their `code`/`remediation`/`docsUrl`
 *    propagate into `app.diagnostics.issues`.
 *  - {@link HttpError} — per-request failures. Thrown from handlers,
 *    steps, or validation; serialized onto the wire as the coded
 *    envelope `{ error: { code, message, remediation?, docsUrl?, data? } }`.
 *    A handler that returns an `@arki/failure` failure gets the same
 *    envelope, with the failure's status, code, message and data.
 *
 * Every code is stable API. Match on codes, never parse messages.
 */

import { trace } from '@opentelemetry/api';

import type { Failure } from '@arki/failure';
import { InvalidInput, isFailure, serialize } from '@arki/failure';

import type { FailureDefinitionLike } from './contract.js';

/**
 * Stable error codes for `@arki/http`. `E0NN` codes surface through the
 * DOT lifecycle (boot/start/stop failures); `E4xx`/`E5xx` codes surface
 * on the wire in the error envelope. The digits of a wire code name the
 * kind of failure; they are not always the HTTP status (`E510` and `E511`
 * answer 500).
 */
export const HTTP_ERROR_CODES = {
  /**
   * `start` could not bind the port.
   *
   * @fix Free the port, or pass another `port`. The error `cause` names the system error.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  listenFailed: 'ARKI_HTTP_E001',
  /**
   * Two bindings claim the same method and path, or a bundle token is listed twice.
   *
   * @fix Remove one binding. Each method and path is bound once.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  duplicateRoute: 'ARKI_HTTP_E002',
  /**
   * `stop` exceeded `drainTimeoutMs` with requests still in flight.
   *
   * @fix Raise `drainTimeoutMs`, or shorten the slow handlers. Check that handlers honour the abort signal.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  drainTimeout: 'ARKI_HTTP_E005',
  /**
   * A mount path is malformed.
   *
   * @fix Use a path that starts with `/` and has no query or fragment.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  invalidMount: 'ARKI_HTTP_E006',
  /**
   * `requestContext()` was called, but every engine in this process was built without `requestContext: true`.
   *
   * @fix Pass `{ requestContext: true }` to `buildEngine` or `buildHonoEngine` (or `requestContext: true` to `http()`), or read the explicit `ctx` instead.
   * @verify bun run test -- src/tests/context.test.ts
   */
  requestContextDisabled: 'ARKI_HTTP_E014',
  /**
   * A Dot HTTP action carries missing or incompatible projection metadata.
   *
   * @fix Build the action with the route helpers, not by hand, so its metadata is complete.
   * @verify bun run test -- src/tests/dot.test.ts
   */
  invalidActionMeta: 'ARKI_HTTP_E009',
  /**
   * A route contract is inconsistent: params, headers or responses do not fit its path or each other. Thrown at declaration.
   *
   * @fix Make the params schema match the `:name` segments of the path, and declare each response status once.
   * @verify bun run test -- src/tests/contract.test.ts
   */
  invalidContract: 'ARKI_HTTP_E011',
  /**
   * A webhook scheme has no secrets, an empty secret, or a secret it cannot decode. Thrown when the scheme is created.
   *
   * @fix Pass at least one non-empty secret in the format the scheme expects.
   * @verify bun run test -- src/tests/webhooks.test.ts
   */
  invalidWebhookScheme: 'ARKI_HTTP_E012',
  /**
   * A contract schema cannot describe itself as JSON Schema (OpenAPI, manifest). Thrown by `contractMeta` and `toOpenApi`.
   *
   * @fix Wrap the schema with `withJsonSchema`, or use a schema library that supports Standard JSON Schema.
   * @verify bun run test -- src/tests/openapi.test.ts
   */
  noJsonSchema: 'ARKI_HTTP_E013',
  /**
   * Request validation failed (params, headers, query or body), or the body is not valid JSON. Answers 400.
   *
   * @fix Send a request that matches the contract. The error `issues` list each failing field.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  badRequest: 'ARKI_HTTP_E400',
  /**
   * A route that needs an idempotency key got none, or an unusable one. Answers 400.
   *
   * @fix Send an `Idempotency-Key` header with a unique value per logical action.
   * @verify bun run test -- src/tests/idempotency.test.ts
   */
  idempotencyKeyMissing: 'ARKI_HTTP_E410',
  /**
   * An idempotency key was reused with a different method, path, query or body. Answers 422.
   *
   * @fix Use a new key for a new request. Reuse a key only to repeat the same request.
   * @verify bun run test -- src/tests/idempotency.test.ts
   */
  idempotencyKeyReused: 'ARKI_HTTP_E411',
  /**
   * A request with this idempotency key is still running. Answers 409 with `retry-after`.
   *
   * @fix Wait for `retry-after` seconds, then send the same request with the same key.
   * @verify bun run test -- src/tests/idempotency.test.ts
   */
  idempotencyInProgress: 'ARKI_HTTP_E412',
  /**
   * A request body is larger than the route allows. Answers 413.
   *
   * @fix Send a smaller body, or raise the body limit of the webhook scheme or route.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  payloadTooLarge: 'ARKI_HTTP_E413',
  /**
   * A client call ran past its `timeoutMs`. Thrown by `@arki/http/client`; never sent on the wire.
   *
   * @fix Raise `timeoutMs`, or retry. Retries are safe only for idempotent calls.
   * @verify bun run test -- src/tests/client-retry.test.ts
   */
  requestTimeout: 'ARKI_HTTP_E408',
  /**
   * A webhook signature header is missing or malformed. Answers 401.
   *
   * @fix Send the signature headers the scheme expects.
   * @verify bun run test -- src/tests/webhooks.test.ts
   */
  webhookMalformed: 'ARKI_HTTP_E420',
  /**
   * No webhook signature matches the body with any of the secrets. Answers 401.
   *
   * @fix Check the secret, and that the body reaches the handler unchanged.
   * @verify bun run test -- src/tests/webhooks.test.ts
   */
  webhookSignatureMismatch: 'ARKI_HTTP_E421',
  /**
   * A webhook signed time is too far from now: a replay, or a clock far off. Answers 401.
   *
   * @fix Fix the sender or server clock, or widen the time window.
   * @verify bun run test -- src/tests/webhooks.test.ts
   */
  webhookStale: 'ARKI_HTTP_E422',
  /**
   * A step rejected the request credentials.
   *
   * @fix Send valid credentials.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  unauthorized: 'ARKI_HTTP_E401',
  /**
   * A step rejected the request permissions.
   *
   * @fix Use an account that has the permission.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  forbidden: 'ARKI_HTTP_E403',
  /**
   * No route matches the request. Answers 404.
   *
   * @fix Check the method and path against the contract.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  notFound: 'ARKI_HTTP_E404',
  /**
   * Handler crash or output-schema violation. Answers 500.
   *
   * @fix Read the server log. Fix the handler, or make its output match the contract.
   * @verify bun run test -- src/tests/engine.test.ts
   */
  internal: 'ARKI_HTTP_E500',
  /**
   * A handler returned a `Response` without `output: raw()`, or a value from a `raw()` route. Answers 500.
   *
   * @fix Declare `output: raw()` for a handler that returns a `Response`, and return a `Response` from it.
   * @verify bun run test -- src/tests/failures.test.ts
   */
  rawResponseMismatch: 'ARKI_HTTP_E510',
  /**
   * A handler result does not fit its contract: undeclared status, malformed `reply`, or a value on a no-output route. Answers 500.
   *
   * @fix Return only the statuses the contract declares.
   * @verify bun run test -- src/tests/failures.test.ts
   */
  invalidResponse: 'ARKI_HTTP_E511',
} as const;

const docsUrlFor = (code: string): string => `https://arki.dev/http/errors/${code.toLowerCase().replaceAll('_', '-')}`;

/**
 * A per-request failure with an HTTP status and a stable code. Throw from
 * a handler or step to short-circuit into the wire envelope:
 *
 * ```ts
 * throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'missing or invalid credentials');
 * ```
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly remediation: string | undefined;
  readonly docsUrl: string | undefined;
  /** Extra response headers — e.g. `www-authenticate` on a 401, `retry-after` on a 429. */
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly data: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      readonly remediation?: string;
      readonly docsUrl?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly cause?: unknown;
      readonly data?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.remediation = options.remediation;
    this.docsUrl = options.docsUrl ?? docsUrlFor(code);
    this.headers = options.headers;
    this.data = options.data;
  }
}

/**
 * A composition or lifecycle failure. Carries the same code/remediation/
 * docsUrl fields the DOT kernel propagates into diagnostics when a hook
 * throws.
 */
export class HttpConfigError extends Error {
  readonly code: string;
  readonly remediation: string;
  readonly docsUrl: string;

  constructor(fields: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
    readonly docsUrl?: string;
    readonly cause?: unknown;
  }) {
    super(fields.message, fields.cause === undefined ? {} : { cause: fields.cause });
    this.name = 'HttpConfigError';
    this.code = fields.code;
    this.remediation = fields.remediation;
    this.docsUrl = fields.docsUrl ?? docsUrlFor(fields.code);
  }
}

/** The wire error envelope. Stable shape — agents parse this. */
export type HttpErrorEnvelope = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly remediation?: string;
    readonly docsUrl?: string;
    /** The failure's data, when a handler returned an `@arki/failure` failure that carries some. */
    readonly data?: unknown;
  };
};

/**
 * Message for an unexpected (non-{@link HttpError}) failure: full detail
 * in development, redacted in production — internals never leak onto the
 * wire of a deployed app.
 */
export function describeInternalError(error: unknown): string {
  if (process.env.NODE_ENV !== 'development') return 'internal error';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map any thrown value to its wire envelope: {@link HttpError} keeps its
 * status and fields; everything else is a redacted-in-production 500.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    if (error.status === 400 && InvalidInput.is(error.cause)) {
      const wire = serialize(error.cause, [InvalidInput]);
      if (!isFailure(wire))
        return errorResponse(400, InvalidInput.code, error.message, {
          ...('data' in wire ? { data: wire.data } : {}),
          ...(error.headers === undefined ? {} : { headers: error.headers }),
        });
    }
    return errorResponse(error.status, error.code, error.message, {
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
      ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
      ...(error.headers === undefined ? {} : { headers: error.headers }),
      ...(error.data === undefined ? {} : { data: error.data }),
    });
  }
  return errorResponse(500, HTTP_ERROR_CODES.internal, describeInternalError(error));
}

/** Build the envelope `Response` for a coded failure. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  options: {
    readonly remediation?: string;
    readonly docsUrl?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly data?: unknown;
  } = {},
): Response {
  try {
    trace.getActiveSpan()?.setAttribute('failure.code', code);
  } catch {
    // Application-owned reporting cannot replace an error response.
  }
  const envelope: HttpErrorEnvelope = {
    error: {
      code,
      message,
      ...(options.remediation === undefined ? {} : { remediation: options.remediation }),
      ...(options.docsUrl === undefined ? {} : { docsUrl: options.docsUrl }),
      ...(options.data === undefined ? {} : { data: options.data }),
    },
  };
  return Response.json(envelope, { status, ...(options.headers === undefined ? {} : { headers: options.headers }) });
}

/** Exception bridge for framework adapters; validate the boundary's exact declared definitions first. */
export function orThrowHttp<Value, const Definitions extends readonly FailureDefinitionLike[]>(
  value: Value & (Extract<Value, Failure> extends ReturnType<Definitions[number]> ? unknown : never),
  definitions: Definitions,
  options?: { readonly headers?: Readonly<Record<string, string>> },
): Exclude<Value, Failure>;
export function orThrowHttp(
  value: unknown,
  definitions: readonly FailureDefinitionLike[],
  options: { readonly headers?: Readonly<Record<string, string>> } = {},
): unknown {
  if (!isFailure(value)) return value;
  const wire = serialize(value, definitions);
  const outcome = isFailure(wire) ? wire : value;
  throw new HttpError(outcome.status, outcome.code, outcome.message, {
    ...options,
    ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
    ...(isFailure(wire)
      ? wire.data === undefined
        ? {}
        : { data: wire.data }
      : 'data' in wire
        ? { data: wire.data }
        : {}),
    cause: value.cause,
  });
}
