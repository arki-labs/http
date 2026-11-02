/** Required webhook signature headers or signed time are malformed.
 * @fix Send the signature headers and timestamp required by the configured scheme.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export declare const WebhookMalformed: import("@arki/failure").FailureDefinition<"http.webhook_malformed", undefined>;
/** No webhook signature authenticates the supplied body.
 * @fix Check the sender secret, scheme and original request bytes.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export declare const WebhookSignatureMismatch: import("@arki/failure").FailureDefinition<"http.webhook_signature_mismatch", undefined>;
/** The authenticated webhook time is outside the allowed window.
 * @fix Check both clocks and request a fresh signed delivery.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export declare const WebhookStale: import("@arki/failure").FailureDefinition<"http.webhook_stale", undefined>;
/** The webhook body exceeds the configured limit.
 * @fix Send a smaller body or increase the configured webhook body limit.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export declare const WebhookBodyTooLarge: import("@arki/failure").FailureDefinition<"http.webhook_body_too_large", undefined>;
/** The webhook request body could not be read.
 * @fix Send a fresh request with a readable body.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export declare const WebhookBodyUnreadable: import("@arki/failure").FailureDefinition<"http.webhook_body_unreadable", undefined>;
/** Required Web Crypto operations are unavailable.
 * @fix Provide Web Crypto HMAC and SHA-256 before retrying.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export declare const WebhookCryptoUnavailable: import("@arki/failure").FailureDefinition<"http.webhook_crypto_unavailable", undefined>;
export declare const WEBHOOK_VERIFY_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.webhook_malformed", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_signature_mismatch", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_stale", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_crypto_unavailable", undefined>, import("@arki/failure").FailureDefinition<"failure.unexpected_defect", undefined>];
export declare const WEBHOOK_SIGN_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.webhook_crypto_unavailable", undefined>, import("@arki/failure").FailureDefinition<"contracts.random_source_unavailable", undefined>, import("@arki/failure").FailureDefinition<"failure.unexpected_defect", undefined>];
export declare const WEBHOOK_FAILURES: readonly [import("@arki/failure").FailureDefinition<"http.webhook_malformed", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_signature_mismatch", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_stale", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_crypto_unavailable", undefined>, import("@arki/failure").FailureDefinition<"failure.unexpected_defect", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_body_too_large", undefined>, import("@arki/failure").FailureDefinition<"http.webhook_body_unreadable", undefined>, import("@arki/failure").FailureDefinition<"http.request_cancelled", undefined>];
export type WebhookVerifyFailure = ReturnType<(typeof WEBHOOK_VERIFY_FAILURES)[number]>;
export type WebhookSignFailure = ReturnType<(typeof WEBHOOK_SIGN_FAILURES)[number]>;
export type WebhookFailure = ReturnType<(typeof WEBHOOK_FAILURES)[number]>;
//# sourceMappingURL=webhook-failures.d.ts.map