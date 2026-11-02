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
import { withFallback, CircuitOpen, BulkheadRejected, Timeout } from '@arki/resilience';
import { InvalidEnvelope, InvalidInput, isFailure, REVIVAL_FAILURES, revive, UnexpectedDefect, UnexpectedFailure, ValidatorDefect, } from '@arki/failure';
import { formatIssues, is, parseAsync } from '@arki/schema';
import { HTTP_ERROR_CODES, HttpError } from './error.js';
import { HTTP_SERVER_FAILURES, NetworkFailure, RequestCancelled, RequestTimeout } from './failures.js';
import { isRawOutput } from './raw.js';
import { decoderOf, encoderOf, fieldParts, issuesOf, missingField, runJobs } from './wire.js';
export { HTTP_CLIENT_FAILURES, NetworkFailure, RequestCancelled, RequestTimeout } from './failures.js';
const RETRY_STATUSES = new Set([408, 429, 502, 503, 504]);
const REPEATABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
/**
 * The default `retryOn`: a network failure (`fetch` throws a `TypeError`) or a 408, 429, 502, 503
 * or 504, and only on a request that is safe to send twice. A POST without an idempotency key is
 * never retried: the first try may have done the work before the answer was lost.
 */
export function retryTransient(outcome) {
    if (!outcome.repeatable)
        return false;
    return outcome.response === undefined
        ? outcome.error instanceof TypeError
        : RETRY_STATUSES.has(outcome.response.status);
}
// The implementation works on erased contracts (`ErasedCall`); the overloads
// above carry the inferred types. TypeScript cannot relate a conditional type
// over a generic contract to the erased call, so the implementation's return
// is declared `unknown` — the same erasure boundary the engine uses.
export function createClient(contractOrContracts, options) {
    // Read once into a local: calling `fetch` as a method of another object
    // throws "Illegal invocation" in browsers.
    const transport = {
        baseUrl: options.baseUrl.replace(/\/+$/, ''),
        fetch: options.fetch ?? globalThis.fetch,
        timeoutMs: options.timeoutMs,
        policy: options.policy,
        retryOn: options.retryOn ?? retryTransient,
    };
    if (isRoute(contractOrContracts))
        return buildCall(contractOrContracts, transport);
    const calls = {};
    for (const [key, contract] of Object.entries(contractOrContracts)) {
        calls[key] = buildCall(contract, transport);
    }
    return calls;
}
function isRoute(value) {
    return value.kind === 'http' && typeof value.path === 'string';
}
function buildCall(contract, transport) {
    return async (input, init) => {
        try {
            return await call(contract, transport, input ?? {}, init ?? {});
        }
        catch (error) {
            if (error instanceof UnexpectedFailure && ValidatorDefect.is(error.failure))
                return error.failure;
            if (error instanceof HttpError && InvalidInput.is(error.cause))
                return error.cause;
            if (error instanceof HttpError && error.status === 400) {
                return InvalidInput({ issues: [{ message: error.message }] });
            }
            return UnexpectedDefect({ cause: error });
        }
    };
}
async function call(contract, transport, input, init) {
    // Sync schemas encode without an await, so `fetch` starts in the caller's tick.
    const pending = encodeInput(contract, input);
    const encoded = pending instanceof Promise ? await pending : pending;
    let url = transport.baseUrl + fillPath(contract.path, encoded.params);
    const search = Object.entries(encoded.query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    if (search !== '')
        url += `?${search}`;
    // A plain record, not `Headers`: Hermes has no `Headers` unless a polyfill adds it.
    const headers = { ...encoded.headers, ...init.headers };
    const request = { method: contract.method, headers };
    if (contract.body !== undefined) {
        if (!hasHeader(headers, 'content-type'))
            headers['content-type'] = 'application/json';
        request.body = JSON.stringify(encoded.body);
    }
    const repeatable = REPEATABLE_METHODS.has(contract.method) || hasHeader(headers, 'idempotency-key');
    // The route template, not the URL: the URL may carry tokens, and this text can reach a log or the wire.
    const response = await send(transport, url, request, init.signal, repeatable, `${contract.method} ${contract.path}`);
    if (isFailure(response))
        return response;
    // A status the contract lists answers with that schema's body, ok or not.
    const listed = isRawOutput(contract.output) ? undefined : contract.responses?.[response.status];
    if (listed !== undefined)
        return decodeBody(contract, listed, response);
    if (!response.ok)
        return await toListedFailure(contract, response);
    if (isRawOutput(contract.output))
        return response;
    if (contract.output === undefined || response.status === 204)
        return undefined;
    return decodeBody(contract, contract.output, response);
}
/** One encode job per field the caller gave (or a required one it left out, which then fails). */
function fieldJobs(where, fields, values) {
    const jobs = [];
    for (const [key, field] of Object.entries(fields)) {
        const { wire, optional } = fieldParts(field);
        const value = values?.[key];
        if (value === undefined && optional)
            continue;
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
function encodeInput(contract, input) {
    const jobs = [];
    if (contract.params !== undefined)
        jobs.push(...fieldJobs('params', contract.params, input.params));
    if (contract.query !== undefined)
        jobs.push(...fieldJobs('query', contract.query, input.query));
    if (contract.headers !== undefined)
        jobs.push(...fieldJobs('headers', contract.headers, input.headers));
    if (contract.body !== undefined)
        jobs.push({ at: ['body'], schema: encoderOf(contract.body), value: input.body });
    const ran = runJobs(jobs);
    return ran instanceof Promise ? ran.then(runs => collect(contract, input, runs)) : collect(contract, input, ran);
}
function collect(contract, input, runs) {
    const issues = issuesOf(runs);
    if (issues.length > 0) {
        throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `request validation failed: ${formatIssues(issues)}`, {
            cause: InvalidInput({ issues }),
        });
    }
    const strings = { params: {}, query: {}, headers: {} };
    // Undeclared path params pass through as the strings the caller gave.
    if (contract.params === undefined) {
        for (const [key, value] of Object.entries(input.params ?? {})) {
            if (value !== undefined)
                strings.params[key] = scalarString('params', key, value);
        }
    }
    let body;
    for (const { job, result } of runs) {
        const [where, key] = job.at;
        if (result.issues !== undefined)
            continue;
        if (where === 'body')
            body = result.value;
        else if (key !== undefined && result.value !== undefined)
            strings[where][key] = scalarString(where, key, result.value);
    }
    return { ...strings, body };
}
/** A response `retryOn` accepted, thrown so the policy retries. Unwrapped when the policy gives up. */
class RetryableResponse extends Error {
    response;
    constructor(response) {
        super(`retryable status ${response.status}`);
        this.response = response;
    }
}
const retryableResponseSchema = z.instanceof(RetryableResponse);
/** Own fetch exceptions without widening the public result to an arbitrary failure. */
async function send(...args) {
    try {
        return await sendOnceOrRetry(...args);
    }
    catch (error) {
        if (args[3]?.aborted === true)
            return RequestCancelled({ cause: error });
        if (error instanceof HttpError && error.code === HTTP_ERROR_CODES.requestTimeout) {
            return RequestTimeout({ cause: error });
        }
        if (error instanceof TypeError)
            return NetworkFailure({ cause: error });
        return UnexpectedDefect({ cause: error });
    }
}
/** Send once, or through the policy; either way under the deadline. */
async function sendOnceOrRetry(transport, url, request, signal, repeatable, routeName) {
    const { policy, retryOn } = transport;
    const method = request.method ?? 'GET';
    const deadline = withDeadline(signal, transport.timeoutMs, routeName);
    try {
        if (policy === undefined)
            return await transport.fetch(url, withSignal(request, deadline.signal));
        let previous;
        const attempt = async (context) => {
            // A retried response is dropped unread: free its connection before the next try.
            void previous?.body?.cancel().catch(() => null);
            let response;
            try {
                response = await transport.fetch(url, { ...request, signal: context.signal });
            }
            catch (error) {
                // Thrown back into the policy only when it may retry; anything else leaves it at once.
                if (retryOn({ method, repeatable, error }))
                    throw error;
                return { error };
            }
            if (!retryOn({ method, repeatable, response }))
                return { response };
            previous = response;
            throw new RetryableResponse(response);
        };
        // Explicit fallback sees only callback throws, before the public defect boundary.
        // Returned clock/engine failures retain their own identity and classification.
        const outcome = await withFallback(policy, (error) => is(error, retryableResponseSchema) ? { response: error.response } : { error }).execute(attempt, deadline.signal);
        if (isFailure(outcome)) {
            if (UnexpectedDefect.is(outcome) || CircuitOpen.is(outcome) || BulkheadRejected.is(outcome))
                return outcome;
            if (Timeout.is(outcome) || (deadline.signal?.reason instanceof HttpError && deadline.signal.reason.code === HTTP_ERROR_CODES.requestTimeout)) {
                return RequestTimeout({ cause: outcome });
            }
            return RequestCancelled({ cause: outcome });
        }
        if ('error' in outcome)
            throw outcome.error;
        return outcome.response;
    }
    catch (error) {
        // A timeout or the caller's abort may surface as the policy's own cancel error: report the cause.
        if (deadline.signal?.aborted === true && deadline.signal.reason !== undefined)
            throw deadline.signal.reason;
        throw error;
    }
    finally {
        deadline.clear();
    }
}
function withSignal(request, signal) {
    return signal === undefined ? request : { ...request, signal };
}
/** The caller's signal, plus an abort after `timeoutMs` with `HttpError` 408. */
function withDeadline(signal, timeoutMs, what) {
    if (timeoutMs === undefined)
        return { signal, clear: () => null };
    const controller = new AbortController();
    const follow = () => {
        controller.abort(signal?.reason);
    };
    if (signal?.aborted === true)
        follow();
    else
        signal?.addEventListener('abort', follow, { once: true });
    const timer = setTimeout(() => {
        controller.abort(new HttpError(408, HTTP_ERROR_CODES.requestTimeout, `${what} got no response within ${timeoutMs} ms`));
    }, timeoutMs);
    return {
        signal: controller.signal,
        clear: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', follow);
        },
    };
}
function hasHeader(headers, name) {
    return Object.keys(headers).some(key => key.toLowerCase() === name);
}
/** `/orders/:id` + `{ id: 'a b' }` → `/orders/a%20b`. A missing optional segment is dropped. */
function fillPath(path, params) {
    const filled = path
        .split('/')
        .map(segment => fillSegment(segment, params))
        .filter((segment) => segment !== undefined);
    return filled.join('/') || '/';
}
function fillSegment(segment, params) {
    if (!segment.startsWith(':'))
        return segment;
    const optional = segment.endsWith('?');
    const name = segment.slice(1, optional ? -1 : undefined);
    const value = params[name];
    if (value === undefined) {
        if (optional)
            return undefined;
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
function scalarString(where, key, value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
        return String(value);
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `${where} validation failed: ${key}: must encode to a string, number or boolean`, { remediation: `Give the ${where} field a codec that encodes to a string.` });
}
async function decodeBody(_contract, output, response) {
    let body;
    try {
        body = await response.json();
    }
    catch (error) {
        return InvalidEnvelope({ reason: 'invalid_json' }, { cause: error });
    }
    const parsed = await parseAsync(decoderOf(output), body);
    if (InvalidInput.is(parsed))
        return InvalidEnvelope({ reason: 'invalid_data' }, { cause: parsed });
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
async function toListedFailure(contract, response) {
    let body;
    try {
        body = await response.json();
    }
    catch (error) {
        return InvalidEnvelope({ reason: 'invalid_json' }, { cause: error });
    }
    const envelope = errorEnvelopeSchema.safeParse(body);
    if (!envelope.success)
        return InvalidEnvelope({ reason: 'malformed' });
    return revive(envelope.data.error, [
        InvalidInput,
        ...REVIVAL_FAILURES,
        ...HTTP_SERVER_FAILURES,
        ...(contract.failures ?? []),
    ]);
}
//# sourceMappingURL=client.js.map