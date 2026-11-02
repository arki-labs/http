import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { defineFailure, UnexpectedDefect } from '@arki/failure';

import { RequestCancelled } from './failures.js';

/** Required webhook signature headers or signed time are malformed.
 * @fix Send the signature headers and timestamp required by the configured scheme.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export const WebhookMalformed = defineFailure('http.webhook_malformed', {
  status: 401,
  message: 'Required webhook signature headers or signed time are malformed.',
  remediation: 'Send the signature headers and timestamp required by the configured scheme.',
});

/** No webhook signature authenticates the supplied body.
 * @fix Check the sender secret, scheme and original request bytes.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export const WebhookSignatureMismatch = defineFailure('http.webhook_signature_mismatch', {
  status: 401,
  message: 'No webhook signature authenticates the supplied body.',
  remediation: 'Check the sender secret, scheme and original request bytes.',
});

/** The authenticated webhook time is outside the allowed window.
 * @fix Check both clocks and request a fresh signed delivery.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export const WebhookStale = defineFailure('http.webhook_stale', {
  status: 401,
  message: 'The authenticated webhook time is outside the allowed window.',
  remediation: 'Check both clocks and request a fresh signed delivery.',
});

/** The webhook body exceeds the configured limit.
 * @fix Send a smaller body or increase the configured webhook body limit.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export const WebhookBodyTooLarge = defineFailure('http.webhook_body_too_large', {
  status: 413,
  message: 'The webhook body exceeds the configured limit.',
  remediation: 'Send a smaller body or increase the configured webhook body limit.',
});

/** The webhook request body could not be read.
 * @fix Send a fresh request with a readable body.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export const WebhookBodyUnreadable = defineFailure('http.webhook_body_unreadable', {
  status: 400,
  message: 'The webhook request body could not be read.',
  remediation: 'Send a fresh request with a readable body.',
});

/** Required Web Crypto operations are unavailable.
 * @fix Provide Web Crypto HMAC and SHA-256 before retrying.
 * @verify bun run test -- src/tests/webhooks.test.ts
 */
export const WebhookCryptoUnavailable = defineFailure('http.webhook_crypto_unavailable', {
  status: 503,
  message: 'Required Web Crypto operations are unavailable.',
  remediation: 'Provide Web Crypto HMAC and SHA-256 before retrying.',
});

export const WEBHOOK_VERIFY_FAILURES = [
  WebhookMalformed,
  WebhookSignatureMismatch,
  WebhookStale,
  WebhookCryptoUnavailable,
  UnexpectedDefect,
] as const;
export const WEBHOOK_SIGN_FAILURES = [WebhookCryptoUnavailable, ...ID_GENERATION_FAILURES] as const;
export const WEBHOOK_FAILURES = [
  ...WEBHOOK_VERIFY_FAILURES,
  WebhookBodyTooLarge,
  WebhookBodyUnreadable,
  RequestCancelled,
] as const;
export type WebhookVerifyFailure = ReturnType<(typeof WEBHOOK_VERIFY_FAILURES)[number]>;
export type WebhookSignFailure = ReturnType<(typeof WEBHOOK_SIGN_FAILURES)[number]>;
export type WebhookFailure = ReturnType<(typeof WEBHOOK_FAILURES)[number]>;
