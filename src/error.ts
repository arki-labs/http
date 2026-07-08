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
 *    derivers, or validation; serialized onto the wire as the coded
 *    envelope `{ error: { code, message, remediation?, docsUrl? } }`.
 *
 * Every code is stable API. Match on codes, never parse messages.
 */

/**
 * Stable error codes for `@arki/http`. `E0NN` codes surface through the
 * DOT lifecycle (boot/start/stop failures); `E4xx`/`E5xx` codes surface
 * on the wire in the error envelope.
 */
export const HTTP_ERROR_CODES = {
  /** `start` could not bind the port. */
  listenFailed: 'ARKI_HTTP_E001',
  /** Two bindings claim the same method + path. */
  duplicateRoute: 'ARKI_HTTP_E002',
  /** `stop` exceeded `drainTimeoutMs` with requests still in flight. */
  drainTimeout: 'ARKI_HTTP_E005',
  /** A mount path is malformed. */
  invalidMount: 'ARKI_HTTP_E006',
  /** A deriver key duplicates an earlier deriver or a base context key. */
  duplicateDeriverKey: 'ARKI_HTTP_E007',
  /** A DOT HTTP action carries missing or incompatible projection metadata. */
  invalidActionMeta: 'ARKI_HTTP_E009',
  /** Request validation failed (query/body) or the body is not valid JSON. */
  badRequest: 'ARKI_HTTP_E400',
  /** A deriver rejected the request's credentials. */
  unauthorized: 'ARKI_HTTP_E401',
  /** A deriver rejected the request's permissions. */
  forbidden: 'ARKI_HTTP_E403',
  /** No route matches the request. */
  notFound: 'ARKI_HTTP_E404',
  /** Handler crash or output-schema violation. */
  internal: 'ARKI_HTTP_E500',
} as const;

const docsUrlFor = (code: string): string => `https://arki.dev/http/errors/${code.toLowerCase().replaceAll('_', '-')}`;

/**
 * A per-request failure with an HTTP status and a stable code. Throw from
 * a handler or deriver to short-circuit into the wire envelope:
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

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      readonly remediation?: string;
      readonly docsUrl?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.remediation = options.remediation;
    this.docsUrl = options.docsUrl ?? docsUrlFor(code);
    this.headers = options.headers;
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

  constructor(fields: { readonly code: string; readonly message: string; readonly remediation: string; readonly docsUrl?: string }) {
    super(fields.message);
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
  };
};

/**
 * Message for an unexpected (non-{@link HttpError}) failure: full detail
 * in development, redacted in production — internals never leak onto the
 * wire of a deployed app.
 */
export function describeInternalError(error: unknown): string {
  if (process.env.NODE_ENV === 'production') return 'internal error';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map any thrown value to its wire envelope: {@link HttpError} keeps its
 * status and fields; everything else is a redacted-in-production 500.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message, {
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
      ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
      ...(error.headers === undefined ? {} : { headers: error.headers }),
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
  } = {},
): Response {
  const envelope: HttpErrorEnvelope = {
    error: {
      code,
      message,
      ...(options.remediation === undefined ? {} : { remediation: options.remediation }),
      ...(options.docsUrl === undefined ? {} : { docsUrl: options.docsUrl }),
    },
  };
  return Response.json(envelope, { status, ...(options.headers === undefined ? {} : { headers: options.headers }) });
}
