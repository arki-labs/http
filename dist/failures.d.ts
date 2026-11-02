/** Framework request setup can refuse before a route handler or step runs. */
export declare const HTTP_SERVER_FAILURES: readonly [import("@arki/failure").FailureDefinition<"contracts.random_source_unavailable", undefined>, import("@arki/failure").FailureDefinition<"failure.unexpected_defect", undefined>];
/** A fetch attempt failed to reach its destination.
 * @fix Check connectivity and retry only repeatable requests.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export declare const NetworkFailure: import("@arki/failure").FailureDefinition<"http.network_failure", undefined>;
/** The request did not receive a response before its deadline.
 * @fix Retry only repeatable requests or increase the deadline.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export declare const RequestTimeout: import("@arki/failure").FailureDefinition<"http.request_timeout", undefined>;
/** The caller cancelled the request.
 * @fix Start a new request if the result is still needed.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export declare const RequestCancelled: import("@arki/failure").FailureDefinition<"http.request_cancelled", undefined>;
/** A protected write has no valid idempotency key.
 * @fix Supply one key per logical request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export declare const IdempotencyKeyRequired: import("@arki/failure").FailureDefinition<"http.idempotency_key_required", undefined>;
/** The key identifies a different request.
 * @fix Use a new key for the different request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export declare const IdempotencyKeyReused: import("@arki/failure").FailureDefinition<"http.idempotency_key_reused", undefined>;
/** The original protected write is still running.
 * @fix Wait for Retry-After before retrying the same request.
 * @verify bun run test -- src/tests/boundary-outcomes.test.ts src/tests/idempotency.test.ts
 */
export declare const IdempotencyInProgress: import("@arki/failure").FailureDefinition<"http.idempotency_in_progress", undefined>;
/** Cache acquisition did not confirm whether this request owns the key.
 * @fix Retry the same key; never execute without confirmed ownership.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export declare const IdempotencyClaimUnconfirmed: import("@arki/failure").FailureDefinition<"http.idempotency_claim_unconfirmed", undefined>;
/** Application work ran but persistence of its response is unconfirmed.
 * @fix Reconcile the application outcome before releasing or replacing its key.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export declare const IdempotencyWriteUnconfirmed: import("@arki/failure").FailureDefinition<"http.idempotency_write_unconfirmed", undefined>;
/** Release of a reconciled reservation was not confirmed.
 * @fix Check the reservation before executing or releasing again.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export declare const IdempotencyReleaseUnconfirmed: import("@arki/failure").FailureDefinition<"http.idempotency_release_unconfirmed", undefined>;
/** The expected owner cannot persist a response.
 * @fix Reconcile the operation; never treat lost ownership as permission to repeat it.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export declare const IdempotencyOwnershipLost: import("@arki/failure").FailureDefinition<"http.idempotency_ownership_lost", undefined>;
/** Persisted replay data cannot be safely reconstructed.
 * @fix Repair the stored response after reconciling the application outcome.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export declare const IdempotencyReplayInvalid: import("@arki/failure").FailureDefinition<"http.idempotency_replay_invalid", undefined>;
/** Application work ran but its response cannot be stored for replay.
 * @fix Use a bounded, nonstreaming response and reconcile this operation.
 * @verify bun run test -- src/tests/idempotency-outcomes.test.ts
 */
export declare const IdempotencyResponseUnavailable: import("@arki/failure").FailureDefinition<"http.idempotency_response_unavailable", undefined>;
/** The request cannot be fingerprinted within the configured bound.
 * @fix Reduce the body size or raise the configured limit.
 * @verify bun run test -- src/tests/idempotency.test.ts
 */
export declare const IdempotencyRequestTooLarge: import("@arki/failure").FailureDefinition<"http.idempotency_request_too_large", undefined>;
/** Request bytes could not be read before idempotency ownership or application work.
 * @fix Send a fresh request with a readable body.
 * @verify bun run test -- src/tests/idempotency-preparation.test.ts
 */
export declare const IdempotencyRequestUnreadable: import("@arki/failure").FailureDefinition<"http.idempotency_request_unreadable", undefined>;
/** The runtime cannot securely fingerprint a protected request.
 * @fix Provide Web Crypto SHA-256 before retrying the same request.
 * @verify bun run test -- src/tests/idempotency-preparation.test.ts
 */
export declare const IdempotencyHashUnavailable: import("@arki/failure").FailureDefinition<"http.idempotency_hash_unavailable", undefined>;
/** Why the guard refused a URL. */
export declare const UNSAFE_URL_REASONS: readonly ['invalid_url', 'scheme_or_credentials', 'private_address'];
/** `@arki/http/public-fetch` refused a URL: a bad scheme, refused credentials, or a private, loopback or link-local address (also after DNS or a redirect). The message never carries the URL.
 * @fix Call only public `http` or `https` hosts. Do not follow redirects to internal addresses. A refused URL is refused every time: do not retry it.
 * @verify bun run test -- src/tests/public-fetch.test.ts
 */
export declare const UnsafeUrl: import("@arki/failure").FailureDefinition<"http.unsafe_url", import("@standard-schema/spec").StandardSchemaV1<{
    reason: "invalid_url" | "private_address" | "scheme_or_credentials";
}, {
    reason: "invalid_url" | "private_address" | "scheme_or_credentials";
}>>;
/** A public fetch followed more redirects than it allows (five).
 * @fix Fetch the final URL directly, or fix the redirect loop at the server.
 * @verify bun run test -- src/tests/public-fetch.test.ts
 */
export declare const RedirectLimit: import("@arki/failure").FailureDefinition<"http.redirect_limit", undefined>;
/** A public fetch response body was larger than `maxBytes`.
 * @fix Raise `maxBytes` or fetch a smaller resource.
 * @verify bun run test -- src/tests/public-fetch.test.ts
 */
export declare const ResponseTooLarge: import("@arki/failure").FailureDefinition<"http.response_too_large", undefined>;
/** Every outcome of a public fetch except success. */
export declare const PUBLIC_FETCH_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.unsafe_url", import("@standard-schema/spec").StandardSchemaV1<{
    reason: "invalid_url" | "private_address" | "scheme_or_credentials";
}, {
    reason: "invalid_url" | "private_address" | "scheme_or_credentials";
}>>, import("@arki/failure").FailureDefinition<"http.redirect_limit", undefined>, import("@arki/failure").FailureDefinition<"http.response_too_large", undefined>, import("@arki/failure").FailureDefinition<"http.network_failure", undefined>, import("@arki/failure").FailureDefinition<"http.request_timeout", undefined>, import("@arki/failure").FailureDefinition<"http.request_cancelled", undefined>];
export declare const RESPONSE_CACHE_BEGIN_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.idempotency_claim_unconfirmed", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_replay_invalid", undefined>];
export declare const RESPONSE_CACHE_FINISH_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.idempotency_write_unconfirmed", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_ownership_lost", undefined>];
export declare const RESPONSE_CACHE_ABANDON_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.idempotency_release_unconfirmed", undefined>];
export declare const IDEMPOTENCY_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.idempotency_key_required", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_key_reused", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_in_progress", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_claim_unconfirmed", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_replay_invalid", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_write_unconfirmed", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_ownership_lost", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_response_unavailable", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_request_too_large", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_request_unreadable", undefined>, import("@arki/failure").FailureDefinition<"http.idempotency_hash_unavailable", undefined>, import("@arki/failure").FailureDefinition<"http.request_cancelled", undefined>, import("@arki/failure").FailureDefinition<"contracts.random_source_unavailable", undefined>, import("@arki/failure").FailureDefinition<"failure.unexpected_defect", undefined>];
export declare const HTTP_CLIENT_FAILURES: readonly [import("@arki/failure").FailureDefinition<"schema.invalid_input", import("@standard-schema/spec").StandardSchemaV1<unknown, {
    issues: readonly import("@standard-schema/spec").StandardSchemaV1.Issue[];
}>>, import("@arki/failure").FailureDefinition<"failure.invalid_envelope", import("@standard-schema/spec").StandardSchemaV1<unknown, {
    reason: (readonly ["malformed", "unknown_code", "unsupported_version", "invalid_data", "non_json_data", "unstable_schema", "invalid_json"])[number];
}>>, import("@arki/failure").FailureDefinition<"schema.async_required", undefined>, import("@arki/failure").FailureDefinition<"schema.validator_defect", undefined>, import("@arki/failure").FailureDefinition<"failure.unexpected_defect", undefined>, import("@arki/failure").FailureDefinition<"contracts.random_source_unavailable", undefined>, import("@arki/failure").FailureDefinition<"failure.unexpected_defect", undefined>, import("@arki/failure").FailureDefinition<"resilience.circuit_open", undefined>, import("@arki/failure").FailureDefinition<"resilience.bulkhead_rejected", undefined>, import("@arki/failure").FailureDefinition<"http.network_failure", undefined>, import("@arki/failure").FailureDefinition<"http.request_timeout", undefined>, import("@arki/failure").FailureDefinition<"http.request_cancelled", undefined>];
export type HttpClientFailure = ReturnType<(typeof HTTP_CLIENT_FAILURES)[number]>;
//# sourceMappingURL=failures.d.ts.map