# Idempotency persistence migration

Pending reservations no longer expire. Elapsed time, a handler exception or an HTTP error status cannot prove that application work did not happen. Every bounded response is stored, including 5xx, 409 and 429. Replay retention starts only when the store confirms persistence.

- Implement `ResponseCache.begin(key, fingerprint, owner)` without a TTL.
- Implement `finish(key, owner, response, ttl)` atomically: confirm ownership, persist the response and start replay expiry. Return the canonical ownership/write failure on refusal or uncertainty. Do not report success after an unmatched update.
- Infer operation failure unions from `RESPONSE_CACHE_BEGIN_FAILURES`, `RESPONSE_CACHE_FINISH_FAILURES` and `RESPONSE_CACHE_ABANDON_FAILURES`. All instances carry private provider causes; no keys, owners, bodies or provider messages belong on the wire.
- Keep the complete `IDEMPOTENCY_FAILURES` tuple on protected routes. It now includes cache acquisition, persistence, replay and body-limit outcomes. Clients infer them from that descriptor.
- `abandon` is an explicit reconciliation operation. Only release a pending reservation when authoritative application state proves repeating the operation safe. The middleware never releases a reservation after starting the handler; completed replay records cannot be abandoned.

A request body over the configured limit now returns 413 without invoking the handler. A stream, oversized response or response read failure returns `IdempotencyResponseUnavailable`. The original operation may have completed; its reservation remains held. A handler exception likewise keeps its reservation. Query the same key or reconcile business state; using a new key can duplicate the operation.

Postgres uses the existing nullable expiry column for unresolved claims. Journal pruning preserves pending claims and unexpired replays. Redis processing keys have no expiry; the replay TTL is set atomically by `finish`. Use durable Redis persistence and an appropriate no-eviction policy for this workload. Missing/evicted data cannot prove an operation never ran.

Upgrade all writers together. Stop old writers and drain in-flight operations before migration. Reconcile legacy pending records, especially Redis keys whose old TTL can still expire. Do not change the cache namespace to bypass unresolved work. A reservation that expired before the upgrade cannot be reconstructed from this cache alone.

This response cache does not commit with the business transaction. After replay expiry, storage loss or operator deletion the key can run again. For durable business idempotency, persist an application receipt in the same transaction as its effects. Recovery must use that authoritative receipt before releasing an uncertain HTTP reservation.

## Request preparation

Keep `IDEMPOTENCY_FAILURES` on every protected descriptor. It now includes
`IdempotencyRequestUnreadable`, `IdempotencyHashUnavailable` and
`RequestCancelled`. Existing `UnexpectedDefect` admission also covers scope
throws/rejections and malformed or rejecting crypto providers. All these
failures stop before cache acquisition and application execution; their fixed
public messages do not disclose the scope, key, request bytes or private cause.
This does not prove that an earlier request with the same key never ran.

Scope callbacks can return an exact canonical failure union. List the original
definitions on each protected route alongside `IDEMPOTENCY_FAILURES`; no
separate failure union or callback error map is needed. The matched route's
definitions control serialization. Clients infer these failures from the same
descriptor. Existing string scopes and `undefined` bypass keep their meaning.

Request body bytes, scope/key encoding, SHA-256 fingerprints and stored records
remain compatible. Supply Web Crypto SHA-256 in every server runtime. No
noncryptographic fallback is used. A broken provider is a defect, not permission
to retry automatically. Preparation checks cancellation before and after
awaited work; asynchronous scopes must use `req.signal` to stop their own
pending work. Native `fetch` middleware still exposes responses through its
explicit HTTP exception bridge.
