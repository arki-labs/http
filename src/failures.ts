/** Canonical client-owned outcomes; route-owned failures stay on each contract. */
import { CircuitOpen, BulkheadRejected } from '@arki/resilience';
import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { z } from 'zod';

import { defineFailure, InvalidInput, REVIVAL_FAILURES } from '@arki/failure';

/** Framework request setup can refuse before a route handler or step runs. */
export const HTTP_SERVER_FAILURES = ID_GENERATION_FAILURES;

/** A fetch attempt failed to reach its destination.
 * @fix Check connectivity and retry only repeatable requests.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const NetworkFailure = defineFailure('http.network_failure', {
  status: 503,
  message: 'The HTTP request could not reach the server.',
  remediation: 'Check connectivity before retrying a repeatable request.',
});
/** The request did not receive a response before its deadline.
 * @fix Retry only repeatable requests or increase the deadline.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const RequestTimeout = defineFailure('http.request_timeout', {
  status: 408,
  message: 'The HTTP request exceeded its deadline.',
  remediation: 'Retry only if the request is safe to repeat.',
});
/** The caller cancelled the request.
 * @fix Start a new request if the result is still needed.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const RequestCancelled = defineFailure('http.request_cancelled', {
  status: 499,
  message: 'The HTTP request was cancelled.',
});
/** A protected write has no valid idempotency key.
 * @fix Supply one key per logical request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const IdempotencyKeyRequired = defineFailure('http.idempotency_key_required', {
  status: 400,
  message: 'A valid idempotency key is required.',
  remediation: 'Send a unique Idempotency-Key and reuse it only for the same request.',
});
/** The key identifies a different request.
 * @fix Use a new key for the different request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const IdempotencyKeyReused = defineFailure('http.idempotency_key_reused', {
  status: 422,
  message: 'The idempotency key was used for a different request.',
  remediation: 'Use a new key for a different request.',
});
/** The original protected write is still running.
 * @fix Wait for Retry-After before retrying the same request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export const IdempotencyInProgress = defineFailure('http.idempotency_in_progress', {
  status: 409,
  message: 'A request with this idempotency key is running or awaiting reconciliation.',
  remediation: 'Poll with the same key. Reconcile an unresolved operation before releasing its reservation.',
});

/** Cache acquisition did not confirm whether this request owns the key.
 * @fix Retry the same key; never execute without confirmed ownership.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export const IdempotencyClaimUnconfirmed = defineFailure('http.idempotency_claim_unconfirmed', {
  status: 503,
  message: 'Idempotency ownership could not be confirmed.',
  remediation: 'Retry with the same key. Do not execute the operation without confirmed ownership.',
});
/** Application work ran but persistence of its response is unconfirmed.
 * @fix Reconcile the application outcome before releasing or replacing its key.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export const IdempotencyWriteUnconfirmed = defineFailure('http.idempotency_write_unconfirmed', {
  status: 500,
  message: 'The operation ran but persistence of its response could not be confirmed.',
  remediation: 'Query the same key or reconcile the application outcome. Do not repeat with a new key.',
});
/** Release of a reconciled reservation was not confirmed.
 * @fix Check the reservation before executing or releasing again.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export const IdempotencyReleaseUnconfirmed = defineFailure('http.idempotency_release_unconfirmed', {
  status: 503,
  message: 'Release of the idempotency reservation could not be confirmed.',
  remediation: 'Check the reservation and reconcile the operation before retrying.',
});
/** The expected owner cannot persist a response.
 * @fix Reconcile the operation; never treat lost ownership as permission to repeat it.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export const IdempotencyOwnershipLost = defineFailure('http.idempotency_ownership_lost', {
  status: 409,
  message: 'The operation no longer owns its idempotency reservation.',
  remediation: 'Reconcile the application outcome. Do not repeat with a new key.',
});
/** Persisted replay data cannot be safely reconstructed.
 * @fix Repair the stored response after reconciling the application outcome.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export const IdempotencyReplayInvalid = defineFailure('http.idempotency_replay_invalid', {
  status: 500,
  message: 'The stored idempotency response is invalid.',
  remediation: 'Reconcile the application outcome before repairing or releasing the reservation.',
});
/** Application work ran but its response cannot be stored for replay.
 * @fix Use a bounded, nonstreaming response and reconcile this operation.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export const IdempotencyResponseUnavailable = defineFailure('http.idempotency_response_unavailable', {
  status: 500,
  message: 'The operation ran but its response could not be retained for replay.',
  remediation: 'Reconcile the application outcome. Use a bounded, nonstreaming response for protected routes.',
});
/** The request cannot be fingerprinted within the configured bound.
 * @fix Reduce the body size or raise the configured limit.
 * @verify bun run test -- src/tests/idempotency.test.ts
 */
export const IdempotencyRequestTooLarge = defineFailure('http.idempotency_request_too_large', {
  status: 413,
  message: 'The request is too large for idempotency protection.',
  remediation: 'Reduce the request body size or raise the configured limit before retrying.',
});

/** Request bytes could not be read before idempotency ownership or application work.
 * @fix Send a fresh request with a readable body.
 * @verify bun run test -- src/tests/idempotency-preparation.test.ts
 */
export const IdempotencyRequestUnreadable = defineFailure('http.idempotency_request_unreadable', {
  status: 400,
  message: 'The request body could not be read for idempotency protection.',
  remediation: 'Send a fresh request with a readable body and the same idempotency key.',
});
/** The runtime cannot securely fingerprint a protected request.
 * @fix Provide Web Crypto SHA-256 before retrying the same request.
 * @verify bun run test -- src/tests/idempotency-preparation.test.ts
 */
export const IdempotencyHashUnavailable = defineFailure('http.idempotency_hash_unavailable', {
  status: 503,
  message: 'Secure request hashing is unavailable.',
  remediation: 'Provide Web Crypto SHA-256 before retrying the same request and key.',
});

/** Why the guard refused a URL. */
export const UNSAFE_URL_REASONS = ['invalid_url', 'scheme_or_credentials', 'private_address'] as const;
const UNSAFE_URL_MESSAGES = {
  invalid_url: 'Invalid URL.',
  scheme_or_credentials: 'Only public HTTP feeds are supported.',
  private_address: 'Private network addresses are not allowed.',
} as const satisfies Record<(typeof UNSAFE_URL_REASONS)[number], string>;

/** `@arki/http/public-fetch` refused a URL: a bad scheme, refused credentials, or a private, loopback or link-local address (also after DNS or a redirect). The message never carries the URL.
 * @fix Call only public `http` or `https` hosts. Do not follow redirects to internal addresses. A refused URL is refused every time: do not retry it.
 * @verify bun run test -- src/tests/public-fetch.test.ts
 */
export const UnsafeUrl = /* @__PURE__ */ defineFailure('http.unsafe_url', {
  status: 400,
  data: z.object({ reason: z.enum(UNSAFE_URL_REASONS) }),
  message: data => UNSAFE_URL_MESSAGES[data.reason],
  remediation:
    'Use an http(s) URL whose host resolves only to public addresses; private, loopback and link-local targets, and redirects to them, are refused.',
});
/** A public fetch followed more redirects than it allows (five).
 * @fix Fetch the final URL directly, or fix the redirect loop at the server.
 * @verify bun run test -- src/tests/public-fetch.test.ts
 */
export const RedirectLimit = /* @__PURE__ */ defineFailure('http.redirect_limit', {
  status: 502,
  message: 'The server redirected too many times.',
  remediation: 'Fetch the final URL directly or fix the redirect loop.',
});
/** A public fetch response body was larger than `maxBytes`.
 * @fix Raise `maxBytes` or fetch a smaller resource.
 * @verify bun run test -- src/tests/public-fetch.test.ts
 */
export const ResponseTooLarge = /* @__PURE__ */ defineFailure('http.response_too_large', {
  status: 502,
  message: 'The response is larger than the size limit.',
  remediation: 'Raise maxBytes or fetch a smaller resource.',
});
/** Every outcome of a public fetch except success. */
export const PUBLIC_FETCH_FAILURES = [
  UnsafeUrl,
  RedirectLimit,
  ResponseTooLarge,
  NetworkFailure,
  RequestTimeout,
  RequestCancelled,
] as const;

export const RESPONSE_CACHE_BEGIN_FAILURES = [IdempotencyClaimUnconfirmed, IdempotencyReplayInvalid] as const;
export const RESPONSE_CACHE_FINISH_FAILURES = [IdempotencyWriteUnconfirmed, IdempotencyOwnershipLost] as const;
export const RESPONSE_CACHE_ABANDON_FAILURES = [IdempotencyReleaseUnconfirmed] as const;

export const IDEMPOTENCY_FAILURES = [
  IdempotencyKeyRequired,
  IdempotencyKeyReused,
  IdempotencyInProgress,
  ...RESPONSE_CACHE_BEGIN_FAILURES,
  ...RESPONSE_CACHE_FINISH_FAILURES,
  IdempotencyResponseUnavailable,
  IdempotencyRequestTooLarge,
  IdempotencyRequestUnreadable,
  IdempotencyHashUnavailable,
  RequestCancelled,
  ...ID_GENERATION_FAILURES,
] as const;

export const HTTP_CLIENT_FAILURES = [
  InvalidInput,
  ...REVIVAL_FAILURES,
  ...HTTP_SERVER_FAILURES,
  CircuitOpen,
  BulkheadRejected,
  NetworkFailure,
  RequestTimeout,
  RequestCancelled,
] as const;
export type HttpClientFailure = ReturnType<(typeof HTTP_CLIENT_FAILURES)[number]>;
