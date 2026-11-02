# HTTP identity upgrade

This minor release changes HTTP identity types while preserving stored UUIDs
and supplied request-header strings.

- `BaseRequestCtx.requestId` is inferred `RequestId`. Import `requestId` from
  `@arki/http` and use its schema to validate/restore an existing value. Every
  present `x-request-id`, including an empty string, bypasses generation.
  Raw mounts and unmatched routes still do not construct a base request context.
- `ResponseCache.begin`, `finish` and `abandon` receive `IdempotencyOwnerId`.
  Import `idempotencyOwnerId` from `@arki/http/idempotency` for direct adapter
  fixtures. Infer method signatures from `ResponseCache`; do not copy the brand
  or change stored columns. The owner is distinct from the request ID and the
  caller's idempotency key.
- Keep using the whole `IDEMPOTENCY_FAILURES` tuple on protected routes. It now
  includes exact canonical ID generation failures. `HttpClientFailure` also
  includes `HTTP_SERVER_FAILURES`, so callers of any route can narrow framework
  request-setup refusals without redeclaring them on every route.
- Generation uses native UUIDs or secure fallback bytes. Missing providers return
  `RandomSourceUnavailable`; defective providers return `UnexpectedDefect`.
  An existing native provider fault never triggers a second entropy attempt.
  Bound request setup stops before steps/handlers/RPC context. Idempotency
  owner refusal stops before hashing, cache acquisition and handler execution.

The native middleware protocol still uses the existing validated HTTP exception
bridge internally. The client revives canonical values; private provider causes
stay off the wire. Successful responses remain unwrapped.

Default request and protected idempotency spans use the application's OTel
context. Libraries do not install or configure an SDK. These spans observe the
response boundary, not completion of a streamed response body. Failures in
instrumentation preserve the operation's result and cannot rerun it.

This change does not finish the broader failure migration: remaining provider
methods, request-body reads, fingerprinting/signature crypto, listener lifecycle
and stream completion still need their own precise boundary audit.

HTTP response-cache persistence now has a separate [migration guide](upgrade-idempotency.md).
