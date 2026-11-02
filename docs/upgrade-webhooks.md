# Webhook outcomes

`scheme.sign()`, `scheme.verify()` and the `verifyWebhook()` step return
canonical failures. They no longer reject for ordinary verification refusals.
Successful values remain `Headers` and `VerifiedWebhook<TId>`.

Every caller must inspect the result. A fulfilled verification promise alone
does not authenticate a delivery. Payments' Stripe validation and Journal's
inbox fixture have migrated together.

```ts
import { isFailure } from '@arki/failure';
import { standardWebhooks } from '@arki/http/webhooks';

const scheme = standardWebhooks({ secrets: ['whsec_c2VjcmV0'] });
async function signedExample() {
  const signed = await scheme.sign('payload', { id: 'partner-event-1' });
  if (isFailure(signed)) return signed;
  return scheme.verify({
    headers: signed,
    body: new TextEncoder().encode('payload'),
  });
}
await signedExample();
```

For HTTP routes, declare `failures: WEBHOOK_FAILURES` on every contract using
the step (`routes().use(step(verifyWebhook({ scheme })))`). The existing route builder checks admission; the engine encodes
the matched route's exact definitions and stops the handler on refusal.
Direct callers can use `WEBHOOK_SIGN_FAILURES` and `WEBHOOK_VERIFY_FAILURES`.
All aliases are inferred from these original definition tuples.

| Outcome | Status |
| --- | --- |
| `WebhookMalformed`, `WebhookSignatureMismatch`, `WebhookStale` | 401 |
| `WebhookBodyUnreadable` | 400 |
| `WebhookBodyTooLarge` | 413 |
| `WebhookCryptoUnavailable` | 503 |
| `RequestCancelled` (request step) | 499 |
| `UnexpectedDefect` (broken provider/callback/protocol) | 500 |

Signing also returns the original ID-generation failures. Automatic IDs use
the canonical `webhookDeliveryId` UUID declaration. Explicit IDs bypass entropy.
Stripe and HMAC schemes without an ID header do not generate an unused ID.
Existing signed formats, supplied event IDs, secret rotation and digest bytes
are unchanged. External verified ID strings retain their existing types;
broader nominal event-ID migration remains separate.

Web Crypto calls preserve their receiver. Verification requires an actual
boolean; signing and hashing require correctly sized, attached ArrayBuffers.
Concurrent operations share key import; successful imports stay cached and a
failed attempt can be retried by a later operation. These APIs do not send a
webhook, retry delivery, or establish durable inbox deduplication.

Request cancellation is checked between awaited stages. Pending crypto and
custom scheme callbacks remain cooperative; no deadline is introduced.
Private causes are retained locally and excluded from failure envelopes and
telemetry. Static invalid scheme definitions still throw `HttpConfigError`
(`E012`); owned application boot supervises them under A-33.

The `@arki/http` tracer emits `http.webhook.sign`, `http.webhook.verify` and
`http.webhook.request`. Configure the SDK/context manager in the application.
Only `failure.code` and error status are recorded. Secrets, signatures, bodies,
IDs and private exception messages are excluded. Faulty instrumentation cannot
repeat work or replace its outcome.

Existing HTTP client runtime tests do not establish webhook execution support
on every engine. Webhook-specific runtime/artifact proof remains T11/T16 work.
