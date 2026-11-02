Read-only mirror of `@arki/http` v0.4.1. Source and issues: arki-labs/arki. Docs: https://arki.dev/packages/http. Published 2026-11-02 with provenance https://www.npmjs.com/package/@arki/http/v/0.4.1#provenance.

# @arki/http

Typed HTTP for ARKI — route contracts as data, handlers validated by any
Standard Schema (zod, valibot, arktype, your own),
request-scope steps, SSE streaming, and deterministic OpenAPI
generation. Ships a DOT adapter (`@arki/http/dot`) whose `http()` entrypoint unit
turns a composed app into a running server with correct drain-on-shutdown
semantics.

No decorators, no controller scanning, no runtime DI container. Contracts
are plain values; wiring is checked at compile time.

## Install

```sh
bun add @arki/http
# or
npm install @arki/http
```

Dependencies: `zod`, `hono`, `@hono/node-server`. `@arki/http/dot` has the peer `@arki/dot`. Install it only for the Dot adapter.

## Quick start

Declare a route, bind a handler, and call the engine. There is no socket in this example.

```ts run expect
import { buildEngine, route, routes } from '@arki/http';
import { z } from 'zod';

const Order = z.object({ id: z.string(), total: z.number() });

const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: { id: z.string() },
  output: Order,
});

const engine = buildEngine([routes().bind(getOrder, ({ params }) => ({ id: params.id, total: 12 }))]);

const response = await engine.fetch(new Request('http://localhost/orders/ord_1'));
console.log(response.status);
console.log(JSON.stringify(await response.json()));
```

```text
200
{"id":"ord_1","total":12}
```

To serve it, pass the engine to `listen`. See [Without DOT](#without-dot).

## When not to use this

- You want decorators, controller scanning or a runtime DI container. Routes here are plain values.
- You need a schema library that is not Standard Schema. Any Standard Schema works. Others do not.
- You need GraphQL, gRPC or WebSockets. This package serves HTTP request and response, and SSE.
- You want to expose a database to the browser. Handlers validate input, but access rules are yours to write.
- Your app already has oRPC contracts. Use oRPC for those procedures. Mount it here with [Mounting foreign handlers](#mounting-foreign-handlers).

## Runtime support

| Entry | Node | Bun | Deno | Browser | Hermes |
| --- | --- | --- | --- | --- | --- |
| `@arki/http/client` | yes | yes | yes | yes | yes (needs `AbortController` and `fetch`) |
| `@arki/http` (server) | yes | yes | no | no | no |
| `@arki/http/dot` | yes | yes | no | no | no |

`listen` uses `Bun.serve` under Bun (with the engine's route table, so Bun matches those routes natively) and `@hono/node-server` under Node. The server entry loads `node:async_hooks`. `bun run test:runtimes` runs the client smoke test on every runtime, and `scripts/server-smoke.mjs` runs the engine on Node and Bun.

## The model

A route is split in two:

- **Contract** — pure data at module scope: method + path + Standard Schemas +
  a stable id. Registerable in the DOT manifest (sync `configure`),
  renderable as OpenAPI without booting, and the source of the handler's
  inferred signature.
- **Binding** — the handler, attached inside a unit's `provides` factory (or `boot`) where the
  unit's typed needs are already injected. Handlers close over real
  services; no service locator exists.

App-shaped blocks import their schemas, contracts, services and units from [the docs fixture](docs/examples/fixture.ts): a small orders app (`Order`, `listOrders`, `db`, `auth`, a `defineFeature` core, and so on).

```ts
import { optional, route, routes } from '@arki/http';
import { z } from 'zod';

import { CreateOrder, Order } from './fixture.ts';

export const listOrders = route.get('/orders', {
  id: 'orders.list',
  query: { status: optional(z.enum(['open', 'shipped'])) },
  output: z.array(Order),
});

export const createOrder = route.post('/orders', {
  id: 'orders.create',
  body: CreateOrder,
  output: Order,
});
```

Input validation (params/headers/query/body) happens before your handler runs;
output is validated against the contract on the way out. Any schema that
implements [Standard Schema](https://standardschema.dev) works; an async one
too. Output is only as narrow as its schema: zod and valibot objects drop
keys they do not declare, an arktype object keeps them unless it declares
`'+': 'delete'`. A handler that returns a whole database row needs a schema
that drops undeclared keys, or must pick the fields itself. Failures
serialize as a coded envelope:
`{ "error": { "code", "message", "remediation?", "docsUrl?", "data?" } }`.

### Wire forms: a bare schema, or `codec(decode, encode)`

A bare schema means the wire form is the value form: the server decodes what
arrives with it and encodes what leaves with it. When the forms differ, pair
two schemas with `codec`. `decode` reads the wire, `encode` writes it, and the
pair must reverse each other's types or the call does not compile:

```ts
import { codec, route } from '@arki/http';
import { z } from 'zod';

const isoDate = codec(
  z.iso.datetime().transform(text => new Date(text)), // wire -> value
  z.date().transform(date => date.toISOString()), // value -> wire
);
const Shift = codec(z.object({ at: isoDate.decode }), z.object({ at: isoDate.encode }));

export const shift = route.post('/shift', { id: 'shift', query: { at: isoDate }, body: Shift, output: Shift });
// handler: query.at and body.at are Dates; the wire carries ISO strings both ways.
```

Request fields and the body run `decode`; `output`, `responses`, SSE events
and the typed client's inputs run `encode`. A zod `z.codec` inside a bare
schema only decodes (Standard Schema has no encode direction), so give a
two-way field a `codec()`.

### Params, headers and responses

The contract describes the whole request and response. `params`, `headers`
and `query` are records with one field per key: a schema, a `codec()`, or
`optional(...)` around either. `responses` lists the other statuses a handler
may answer with.

```ts run
import { buildEngine, optional, reply, route, routes } from '@arki/http';
import { z } from 'zod';

import { Conflict, Order, OrderId, db } from './fixture.ts';

export const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: { id: OrderId }, // keys must match the :placeholders
  headers: { 'x-tenant': z.string() }, // lower-case names
  query: { expand: optional(z.enum(['items'])) }, // may be left out
  output: Order,
  responses: { 409: Conflict },
});

const orderRoutes = routes().bind(getOrder, async ({ params, headers }) => {
  const order = await db.orders.find(headers['x-tenant'], params.id); // params.id is an OrderId
  return order ?? reply(409, { reason: 'moved' }, { headers: { 'retry-after': '1' } });
});
```

Call it with a request. An unknown order answers the `409` the contract lists:

```ts continue
const moved = await buildEngine([orderRoutes]).fetch(
  new Request('http://local/orders/o99', { headers: { 'x-tenant': 't1' } }),
);
if (moved.status !== 409 || moved.headers.get('retry-after') !== '1') throw new Error(`got ${moved.status}`);
```

- Each field schema gets one string, or `undefined` when the key is missing.
  A field marked `optional(...)` may be missing: the handler sees `undefined`,
  the key is typed `?:`, and its schema does not run. Any other missing field
  runs its schema with `undefined`, which usually fails. Multi-valued query keys
  give their last value. (`z.coerce.number()` turns an empty value into `0`;
  write the schema to refuse that.)
- `params` must have exactly one key per placeholder. Without `params` you get
  `Record<name, string>`. One optional placeholder is allowed, as the last
  segment (`/orders/:id?`): its field must be `optional(...)` (and an
  `optional(...)` param needs a `?` placeholder), the route serves both
  `/orders` and `/orders/x`, and OpenAPI lists both paths.
- `headers` names are lower-case. Only the declared names are read from the
  request, so transport headers (`host`, `accept`) never reach a schema.
- Every field, then the body, is decoded; all their issues answer one `400`
  (`request validation failed: query.page: …`) and the handler does not run.
  A schema that throws instead of returning issues answers `500`: that is a
  server bug, not a bad request. SSE routes take `params`, `headers` and `query`
  too.
- `check` runs after every field and the body decoded, with the same typed
  input the handler gets. Return issues to answer `400`; give each a path such
  as `['query', 'to']` and the message reads `query.to: …`:

  ```ts
  import { route } from '@arki/http';
  import { z } from 'zod';

  route.get('/range', {
    id: 'range',
    query: { from: z.coerce.number(), to: z.coerce.number() },
    check: ({ query }) => (query.to < query.from ? [{ message: 'must not be before from', path: ['query', 'to'] }] : undefined),
  });
  ```
- `reply(status, body, { headers? })` answers with a status listed in
  `responses`. The body is encoded with that status's schema. `responses` keys
  are integers from 200 to 599, never 204 or 304, and never 200 next to a schema
  `output`.
- **No `output` means 204.** The handler returns nothing and the route answers
  `204` with an empty body. Returning a value from such a handler is `E511`.
- **`output: raw()` is the only way to return a `Response`** (a redirect, a file,
  a stream, a handler that owns its error formats). The engine passes it
  through and never validates it. `raw({ contentType })` feeds OpenAPI, and
  `responses` may document the payload; both are documentation only. A
  `Response` without `raw()`, or a plain value from a `raw()` route, is `E510`.

### Returning failures

A contract lists the [`@arki/failure`](../failure) failures its handler may
return. The handler returns a failure like any value; the engine answers
with the failure's status and the same envelope (`code`, `message`,
`remediation`, `data`). The output schema never runs on a failure.

```ts
import { defineFailure } from '@arki/failure';
import { route, routes } from '@arki/http';
import { z } from 'zod';

import { Order, usecases } from './fixture.ts';

export const OrderNotFound = defineFailure('order.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no order {id}',
});

export const getOrder = route.get('/orders/:id', { id: 'orders.get', output: Order, failures: [OrderNotFound] });

routes().bind(getOrder, ({ params }) => usecases.find(params.id)); // Order | Failure<'order.not_found', …>
```

A handler that can return a failure the contract does not list is a compile
error. Add its definition to `failures`. `RouteFailure<typeof getOrder>` is
the union of the listed failures. Failure `data` is sent as plain JSON, so
its schema must be JSON-safe: a `Date` field fails `revive` on the client.

## Inside a DOT app

A feature declares its HTTP surface with `endpoints(core, build, { contracts })`
from `@arki/http/dot`, in `.entrypoints(...)`. `build` runs once at boot. It
gets what every entrypoint of the feature gets — needs, private infra and
`usecases` — typed from the core, so the routes file needs no annotation and no
runtime import of the feature. `contracts` are the feature's manifest actions
(a feature has no `actions` list of its own):

```ts
// features/orders/entrypoints/routes.ts
import { routes } from '@arki/http';
import { endpoints } from '@arki/http/dot';

import { core, listOrders } from './fixture.ts';

export const orderRoutes = (c: typeof core) =>
  endpoints(c, ({ usecases }) => routes().bind(listOrders, ({ query }) => usecases.list(query)), {
    contracts: [listOrders],
  });

// features/orders/feature.ts
export const orders = core.entrypoints(orderRoutes(core));
```

`http()` is an entrypoint unit: mount it with `.entrypoints()`, after the
features. It serves the routes of every mounted feature, in mount order —
the app lists its features once:

```ts skip="starts a server on port 3000 and hooks process signals"
import { defineApp, hookSignals } from '@arki/dot';
import { http } from '@arki/http/dot';

const app = await defineApp('shop-api')
  .infra(db({ url: DATABASE_URL }))
  .features([orders, billing])
  .entrypoints(http({ port: 3000 }))
  .start();

hookSignals(app);
```

A feature with no `endpoints()` entrypoint is skipped. Mount `http()` with
`.entrypoints()`, not `.infra()`: under `.infra()` it boots before the features, so
their routes do not exist yet and boot fails.

Route bundles published as plain token services (not by a feature) go in
`bundles`. Each token becomes a need, so the `.entrypoints(http(...))` line fails
to typecheck when no earlier unit provides it. Bundles come first in the
route table, then feature routes:

```ts
import { defineApp } from '@arki/dot';
import { token } from '@arki/dot/unit';
import type { RouteBundle } from '@arki/http';
import { http } from '@arki/http/dot';

import { adminPlugin, orders } from './fixture.ts';

export const AdminRoutes = token<RouteBundle>()('admin.routes');

defineApp('shop-api')
  .infra(adminPlugin) // provides: { [AdminRoutes.key]: () => routes().bind(...) }
  .features([orders])
  .entrypoints(http({ port: 3000, bundles: [AdminRoutes] }));
```

Because `.entrypoints()` mounts after every feature, reverse-order `stop` halts
ingress FIRST: the server stops accepting, drains in-flight requests
(`drainTimeoutMs`, default 10 s, `ARKI_HTTP_E005` on overrun), and only
then do features tear down. `boot` builds the router without listening;
`start` listens; `dispose` severs remaining connections and releases the
port. A feature whose routes are not a route bundle fails boot with
`ARKI_HTTP_E010`.

The published `httpServer` service carries the composed
`fetch: (Request) => Promise<Response>` — also the unit-test seam: call
your whole app without a socket.

Every route and `rpc()` mount a feature mounts this way also emits Dot handler
events (`transport: 'http'`, `feature`, `name: 'METHOD /path'`; a mount's name is
its path). A returned or step-refused `Failure` ends as `completed/refused`
with that Failure; a throw ends as `failed` while the client still gets the 500
envelope. Read them with `logHandlers()` or `reportErrors()` from `@arki/dot`,
or your own `app.subscribe`. A bundle served outside a feature, or without Dot,
emits nothing.

## Request scope — steps, not containers

Per-request values are typed context keys added by plain functions.
A step is `(ctx) => object | Failure`, attached with `routes().use(step(fn))`.
Steps run in declaration order; each adds the keys of the object it returns,
and later steps and handlers see them typed. A step that returns a failure
(or throws `HttpError`) is the whole "guard" story:

```ts run
import type { BaseRequestCtx } from '@arki/http';
import { buildEngine, route, routes, step } from '@arki/http';
import { defineFailure } from '@arki/failure';

import { auth, dbForTenant, listOrders } from './fixture.ts';

const SignIn = defineFailure('orders.sign_in', { status: 401 });
const securedOrders = route.get(listOrders.path, {
  id: 'orders.secured', query: listOrders.query, output: listOrders.output,
  failures: [...listOrders.failures, SignIn],
});

// inside a `provides` factory — `auth` is an injected singleton
const withPrincipal = step(async ({ req }: BaseRequestCtx) => {
  const p = await auth.verify(req.headers.get('authorization'));
  return p ? { principal: p } : SignIn();
}, { failureHeaders: () => ({ 'www-authenticate': 'Bearer' }) });
const withDb = (ctx: { readonly principal: { readonly tenantId: string } }) => ({
  db: dbForTenant(ctx.principal.tenantId),
});

const orderRoutes = routes()
  .use(withPrincipal)
  .use(step(withDb))
  .bind(securedOrders, async (_input, ctx) => ctx.db.orders.list());
```

A request with no credentials never reaches the handler:

```ts continue
const denied = await buildEngine([orderRoutes]).fetch(new Request('http://local/orders'));
if (denied.status !== 401) throw new Error(`got ${denied.status}`);
```

Request scope is function application over the compile-time-wired
singleton graph — no per-request container resolution, no infectious
scopes. For code deep in a call stack you don't control, the fenced-off
`@arki/http/context` entry exposes `requestContext()` (AsyncLocalStorage).
It is a last resort; prefer the explicit `ctx`. It is also opt-in: build
the engine with `buildEngine(bundles, { requestContext: true })` (or pass
`requestContext: true` to `http()`), because entering the store costs
every request. Calling `requestContext()` when engines exist but none
opted in throws `ARKI_HTTP_E014`.

## App-wide middleware

For cross-cutting concerns that must see or touch the raw
request/response — CORS, request logging — pass fetch-shaped middleware
to `http()` (first = outermost). A middleware that throws `HttpError`
short-circuits into the coded envelope:

```ts
import { http } from '@arki/http/dot';

import { OrdersRoutes, cors, logger, origins, requestLog } from './fixture.ts';

http({ port: 3000, bundles: [OrdersRoutes], middleware: [requestLog(logger), cors(origins)] })
```

Middleware wraps the whole engine and is untyped by design; anything that
produces a per-request *value* belongs in a step instead. Standalone
users compose the same way with `composeMiddleware(engine, [...])`, which returns an engine for `listen`.

## Idempotency keys

`idempotent(...)` from `@arki/http/idempotency` is an `HttpMiddleware`. It runs each listed request once per `Idempotency-Key` and answers a repeat with the stored response. It is portable (Web Crypto only). The store is a `ResponseCache`: `@arki/journal/http` (Postgres) or `@arki/kv/redis/idempotency` (Redis).

```ts skip="needs a Postgres journal (the @arki/journal package), which this package does not depend on"
import { idempotent, IDEMPOTENCY_FAILURES } from '@arki/http/idempotency';
import { route } from '@arki/http';
import { responseCache } from '@arki/journal/http';

http({
  middleware: [
    authenticate, // runs first: the principal in `scope` must already be trusted
    idempotent({
      cache: responseCache(db, tables),
      scope: req => principalOf(req)?.id, // undefined = unauthenticated: never cached, never replayed
      routes: [
        route.post('/orders', { id: 'orders.create', failures: IDEMPOTENCY_FAILURES }),
        route.post('/orders/:id/pay', { id: 'orders.pay', failures: IDEMPOTENCY_FAILURES }),
      ], // use the same descriptors the server binds; include any mount prefix
      ttl: 24 * 60 * 60 * 1000, // milliseconds, counted from confirmed response persistence
      replayHeaders: ['content-type', 'location'], // a replay carries only these
    }),
  ],
});
```

- The fingerprint is method + path + sorted query + a SHA-256 of the body. The cache key is the scope plus the header value.
- Scope callbacks may return canonical failures. Each protected route must declare those inferred failures alongside `IDEMPOTENCY_FAILURES`. `undefined` still delegates authentication to the handler without caching. Thrown scope errors become `UnexpectedDefect`; private messages stay off the wire.
- Unreadable request bodies return `IdempotencyRequestUnreadable`. Missing Web Crypto SHA-256 returns `IdempotencyHashUnavailable`; a broken hashing provider returns `UnexpectedDefect`. These stop before cache acquisition or the handler. Cancellation observed during preparation returns `RequestCancelled`. Scope callbacks should observe `req.signal` to stop pending work.
- No header on a listed route: 400 (`http.idempotency_key_required`). Same key, different request: 422 (`http.idempotency_key_reused`). Same key while the first is running: 409 with `Retry-After` (`http.idempotency_in_progress`). A replay has the stored status and body, the allowlisted headers, and `Idempotent-Replayed: true`.
- **What is stored.** Every bounded response, including 5xx, 409 and 429. A status or exception does not prove that application effects never happened. Pending reservations never expire automatically; replay retention (`ttl`, milliseconds) starts at confirmed `finish`.
- **Size.** Requests over `maxBodyBytes` (default 1 MiB) are refused with 413 before execution. Streaming, oversized or unreadable responses return `http.idempotency_response_unavailable` and retain the unresolved reservation. A thrown handler also retains its reservation.
- Cache acquisition failures stop execution. Unconfirmed response persistence never releases ownership. Query the same key or reconcile the application outcome; do not repeat with a new key. `abandon` is an explicit reconciliation operation, never an automatic response to a failed request.
- This caches responses for HTTP replay. It is not the journal's command receipt, which commits with the business write. Use both for a payment: the cache answers a repeat cheaply, the receipt keeps a repeat that reaches the handler from writing twice.

## Webhooks

`@arki/http/webhooks` checks that a webhook comes from the sender who holds the secret. It is portable (Web Crypto only), and `subtle.verify` compares in constant time.

```ts skip="needs a Postgres journal (the @arki/journal package), which this package does not depend on"
import { standardWebhooks, verifyWebhook, WEBHOOK_FAILURES } from '@arki/http/webhooks';

const partnerEvents = routes()
  .use(step(verifyWebhook({ scheme: standardWebhooks({ secrets: [env.PARTNER_WEBHOOK_SECRET] }) })))
  // orderShipped declares failures: WEBHOOK_FAILURES in its route contract.
  .bind(orderShipped, async ({ body }, { webhook }) => {
    // The event id is the journal key: a resent event commits nothing the second time,
    // and the receipt commits with the write, so there is no separate "seen" table.
    await journal.run(db, recordShipment, body, meta, { idempotencyKey: `partner:${webhook.id}` });
  });
```

- **Schemes.** `standardWebhooks({ secrets })` ([Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,…`). `stripe({ secrets })` (`stripe-signature: t=…,v1=…`; the id is the event's `id`). `hmac({ secrets, header, headerPrefix?, algorithm?, encoding?, idHeader?, timestampHeader?, bodyPrefix? })` for the rest: GitHub is `{ header: 'x-hub-signature-256', headerPrefix: 'sha256=', idHeader: 'x-github-delivery' }`; Slack adds `timestampHeader: 'x-slack-request-timestamp'` and `` bodyPrefix: ({ timestamp }) => `v0:${timestamp}:` ``.
- **`verifyWebhook` is a step.** It adds `webhook` to the context, or refuses. It reads a clone of the body. The route's `body` schema still parses the same bytes after the check. A body over `maxBodyBytes` (default 1 MiB) answers 413 before any check.
- **Rotation.** Pass several secrets, the new one first. Any one may match; `sign` uses the first.
- **Replays.** The signed time must be within `tolerance` seconds of now, either way (default 300). Only a signed time stops a replay, so with `hmac` put the time in `bodyPrefix`. Past the window, the journal key stops a resent event.
- **`webhook.id`** only ever comes from signed bytes, because it becomes the journal key. `standardWebhooks`: the signed `webhook-id`. `stripe`: the event's `id` in the body (`string | undefined`). `hmac`: the SHA-256 of the body, because those senders put their id in a header the signature does not cover (GitHub's `x-github-delivery`), and a resend under a forged id would otherwise run twice.
- Every scheme also has `verify({ headers, body })` for use outside a route, and `sign(body, { id?, timestamp? })` for senders and tests.
- `sign()` and `verify()` return their ordinary success value or exact canonical failures. Protected routes declare `WEBHOOK_FAILURES` so step failures are encoded and inferred by clients. Authentication refusals answer 401; unreadable/oversized bodies answer 400/413, unavailable crypto answers 503, and unexpected provider defects answer 500. See [migration guidance](docs/upgrade-webhooks.md). Static scheme definitions with no secret, an empty secret or invalid base64 still throw `E012`; owned application boot supervises definition defects.
- Default `http.webhook.sign`, `http.webhook.verify` and `http.webhook.request` spans inherit caller context and record only safe failure codes. Libraries do not configure an SDK; failed reporting cannot change outcomes or repeat work.

## Streaming

**Typed SSE.** `route.sse` declares a `text/event-stream` contract; the
binding is an async generator. Every yield is encoded with the event
schema and framed as a `data:` message; client disconnect aborts
`ctx.signal` and runs the generator's `finally`:

```ts
import { route, routes } from '@arki/http';
import { z } from 'zod';

import { Queued, Shipped, tracker } from './fixture.ts';

const progress = route.sse('/orders/:id/progress', {
  id: 'orders.progress',
  event: z.discriminatedUnion('type', [Queued, Shipped]),
  heartbeatMs: 15_000, // optional :keepalive comments
});

routes().bind(progress, async function* ({ params }, ctx) {
  for await (const step of tracker.watch(params.id, ctx.signal)) {
    yield step;
  }
});
```

**Raw streams.** Any handler may return a `Response` wrapping a
`ReadableStream` — file downloads, AI token streams. The engine is
fetch-native end to end.

## Mounting foreign handlers

An oRPC router, a tRPC fetch adapter, or any fetch-shaped handler mounts
as one manifest route — the migration on-ramp for existing backends:

```ts
import { routes } from '@arki/http';

import { rpcHandler } from './fixture.ts';

routes().mount('/rpc', rpcHandler, { id: 'rpc', transport: 'orpc' });
```

## OpenAPI

```ts run
import { toOpenApi } from '@arki/http';

import { createOrder, listOrders, progress } from './fixture.ts';

const document = toOpenApi([listOrders, createOrder, progress], {
  title: 'shop-api',
  version: '1.0.0',
});

if (!JSON.stringify(document).includes('"/orders/{id}/progress"')) throw new Error('missing the progress path');
```

Deterministic — same contracts, byte-identical output. Each `params`,
`headers` and `query` field is one parameter (`required` unless it is
`optional(...)`), every status in `responses` is listed, a no-output route
documents `204`, and a `raw()` route is marked `x-arki-raw: true`.

Each schema describes itself through its own `~standard.jsonSchema`
converter (zod and arktype have one), asked for `draft-2020-12`. What the
server receives is described by the schema's input side, what it sends by
the output side, and a `codec()` by its `decode` input, the wire string.
`$defs` become `components.schemas`, so references still resolve. A schema
with no converter (valibot, a hand-written one) or a failed conversion throws
`ARKI_HTTP_E013` naming the route and the field; give it one with
`withJsonSchema(schema, jsonSchema)` from `@arki/schema`. Inside a DOT app,
contract actions put the JSON Schemas into the manifest, so
`dot explain --as openapi` renders the document from the static manifest
without booting anything.

## Typed client

`createClient` builds a fetch client from the same contracts the server binds.
Pass one contract for one call, or an object of contracts for one call per key:

```ts
import { createClient } from '@arki/http/client';

import { authorization, getOrder, listOrders } from './fixture.ts';

const orders = createClient({ listOrders, getOrder }, { baseUrl: 'https://api.example.com' });

const open = await orders.listOrders({ query: { status: 'open' } });
const order = await orders.getOrder({ params: { id: 'o42' } }, { headers: { authorization } });
```

- Input (`params`, `query`, `headers`, `body`) and output are typed from the
  contract. A wrong input does not compile.
- Params, headers, query and body are encoded with their schemas (`encode` of a
  `codec()`) and the output is decoded, exactly mirroring the server, so
  codecs round-trip. A field that fails returns `InvalidInput` before anything is sent.
  A missing `optional(...)` field, and a missing optional path segment, are
  left out of the URL.
- A status listed in `responses` resolves to that schema's decoded body.
- A non-2xx answer whose code is one of the contract's `failures` resolves to
  that failure, revived with `revive` from `@arki/failure`, so the call's type
  is `Output | the listed failures | HttpClientFailure`. Data its definition
  rejects returns `InvalidEnvelope` with reason `invalid_data`.
- Unknown codes and malformed envelopes return `InvalidEnvelope`. A body that
  breaks the output schema returns `InvalidEnvelope` with reason `invalid_data`.
- A path param that is empty, `.` or `..` returns `InvalidInput` before sending: it
  would change which endpoint the URL points at.
- A contract with no `output` resolves `undefined` (it answers 204). One with `output: raw()` resolves the `Response`.
- It only needs `fetch`, so it runs in browsers, React Native, Deno, Bun and
  Node. Pass `fetch` to add auth. SSE contracts are not supported.

### Retries, timeouts, and calling URLs you do not control

```ts
import { backoff, createRetryPolicy } from '@arki/resilience';
import { createClient } from '@arki/http/client';
import { publicFetch } from '@arki/http/public-fetch';

import { partnerRoutes, partnerUrl } from './fixture.ts';

const partner = createClient(partnerRoutes, {
  baseUrl: partnerUrl, // set by a user: it must not reach your private network
  fetch: publicFetch(),
  policy: createRetryPolicy({ backoff: backoff.exponential({ base: 200 }).upTo(3) }),
  timeoutMs: 10_000,
});
```

- **`policy`** runs each attempt; any `@arki/resilience` policy fits (one with a
  fallback does not: its result may not be a response). The client, not the
  policy, decides what is retried: only an outcome `retryOn` accepts goes back
  into the policy. Anything else leaves it at once, even if the policy would
  retry every error. When the policy gives up, the last answer is decoded as
  usual: declared codes revive, and unknown codes return a protocol failure.
- **`retryOn`** defaults to `retryTransient`: a network failure (`fetch` throws a
  `TypeError`) or a 408, 429, 502, 503 or 504, and only on a request that is
  safe to send twice: GET, HEAD, OPTIONS, PUT, DELETE, or any request with an
  `idempotency-key` header. A POST without one is never retried, because the
  first try may have done the work before its answer was lost.
- **`timeoutMs`** covers the whole call, retries included, until the response
  arrives (reading the body is not timed). It returns `RequestTimeout` (408).
  A caller's `signal` returns `RequestCancelled` with its reason kept private. It needs
  `AbortController`, which React Native provides and bare Hermes does not.
- **`publicFetch()`** (Node and Bun) is the SSRF guard as a `fetch`: each hop
  resolves the host, refuses a private answer, pins the connection to the
  checked address, and follows a redirect only to another public URL. It
  buffers the body (at most `maxBytes`, default 10 MB), so a streaming answer
  arrives whole.
- **`UnsafeUrl`** is the failure the guard returns when it refuses a URL: not
  http(s), not a URL, or a private, loopback or link-local address, whether
  typed, in the DNS answer, or behind a redirect. No request reached that
  address, and the same URL is refused every time, so do not retry it.
  `safeFetchBytes` and `validatePublicURL` return it. `safeFetchBytes` also
  returns `RedirectLimit`, `ResponseTooLarge`, `NetworkFailure`,
  `RequestTimeout` and `RequestCancelled`; it does not throw for them. A
  `fetch` can only resolve or reject, so `publicFetch()` rejects with a
  `TypeError` whose `cause` is the failure (`createClient` returns it as
  `NetworkFailure`); a caller abort rejects with the signal's reason.
- **`systemTransport`** is the default `transport` of `publicFetch()` and
  `safeFetchBytes`: the system DNS resolver and undici, loaded on first use. A
  test passes its own `{ lookup, fetch }` as `transport`, and every address
  check still runs for real.

## Without DOT

The core is framework-agnostic:

```ts
import { buildEngine, listen } from '@arki/http';

import { bundle } from './fixture.ts';

const engine = buildEngine([bundle]);
const handle = await listen(engine, { port: 3000 });
```

`listen` uses `Bun.serve` under Bun and `@hono/node-server` under Node. It
takes the engine (so Bun gets the engine's native route table) or a bare
fetch handler.

### Engines

`buildEngine` is the compiled engine: a route whose path is static segments
and `:name` segments is matched by a `Map` or a segment trie built once, and
runs without any framework object in between. Mounts, rpc mounts, routes
under a mount prefix, optional placeholders (`:x?`) and wildcards go to Hono
behind it; the 404 is Hono's. Every route runs the same pipeline whichever
router matched it, so responses and error envelopes do not depend on the
engine. `buildHonoEngine` builds the Hono-only engine, for running the two
side by side. No Hono type appears in the public API.

`composeMiddleware(engine, middleware)` wraps an engine and returns one, so
Bun's natively matched routes run the same layers as `fetch`; the Dot
`http()` unit does this for its drain gauge and your middleware.

## Public imports

| Import | What it holds |
| --- | --- |
| `@arki/http` | `route`, `routes`, `buildEngine`, `buildHonoEngine`, `listen`, `composeMiddleware`, `step`, `around`, `HttpError`, `toOpenApi`, `raw`, `reply`, `codec`, `optional` |
| `@arki/http/dot` | `http()`, the Dot entrypoint unit, and `endpoints()` |
| `@arki/http/client` | the typed fetch client |
| `@arki/http/idempotency` | `idempotent(...)`, an idempotency-key middleware |
| `@arki/http/webhooks` | signature schemes for signed webhooks |
| `@arki/http/context` | the ambient request context, a last resort |
| `@arki/http/projection` | the `dot explain --as openapi` projection |
| `@arki/http/public-fetch` | a fetch that refuses private addresses |

## Error helpers

- `toErrorResponse(error)` turns any thrown value into the wire envelope. An `HttpError` keeps its status and fields. Anything else becomes a 500.
- `errorResponse` builds the envelope `Response` for a coded failure.
- `describeInternalError(error)` gives the message for an unexpected error. It shows full detail in development and hides it in production.
- `IdempotencyWriteUnconfirmed` is the failure for work that ran when saving its response is unconfirmed. Check what the work did before you release or replace its key.

## Failure behaviour

Handlers and steps fail with an `HttpError` or return a failure. The engine turns both into a coded envelope on the wire:

```text
{ "error": { "code", "message", "remediation?", "docsUrl?", "data?" } }
```

Rules:

- Match on `error.code`, never on the message.
- Schema validation failures answer 400 with `schema.invalid_input` and public issues in `data`.
- A handler that throws something else answers 500 with `ARKI_HTTP_E500`. The message is redacted unless `NODE_ENV=development`.
- Boot and shutdown problems (`E0NN`) do not reach the wire. They surface in `app.diagnostics`.
- `listen` and `stop` reject with a coded error you can catch.

See [Error codes](#error-codes) for the full list.

## Error codes

Stable API — match on codes, never parse messages.

| Code | Meaning |
| --- | --- |
| `ARKI_HTTP_E001` | `start` could not bind the port |
| `ARKI_HTTP_E002` | duplicate route: two bindings claim the same method+path (or a bundle token is listed twice) |
| `ARKI_HTTP_E005` | `stop` exceeded `drainTimeoutMs` with requests in flight |
| `ARKI_HTTP_E006` | malformed mount path |
| `ARKI_HTTP_E008` | a bundle token's service was missing at boot (erased composition only) |
| `ARKI_HTTP_E011` | a route contract is inconsistent (params vs path, headers, responses). Thrown by `route.*()` |
| `ARKI_HTTP_E012` | a webhook scheme has no secret, an empty one, or one it cannot decode. Thrown when the scheme is created |
| `ARKI_HTTP_E013` | a contract schema cannot describe itself as JSON Schema (no `~standard.jsonSchema`, or the conversion threw). Thrown by `toOpenApi` / `contractMeta`; fix with `withJsonSchema` |
| `ARKI_HTTP_E400` | request validation failed (params/headers/query/body) or body is not valid JSON |
| `ARKI_HTTP_E401` / `E403` | credential / permission rejection (thrown by your steps) |
| `ARKI_HTTP_E404` | no route matches |
| `http.request_timeout` | client request deadline exceeded (408); replaces the client exception E408 |
| `http.network_failure` / `http.request_cancelled` | client network failure (503) / caller cancellation (499) |
| `schema.invalid_input` | local or server input validation failed (400) |
| `failure.invalid_envelope` | unknown wire code, malformed envelope or invalid payload |
| `contracts.random_source_unavailable` / `failure.unexpected_defect` | request or idempotency owner generation lacks secure entropy or its provider is defective; answers 500 before protected execution |
| `http.idempotency_claim_unconfirmed` | ownership acquisition unconfirmed (503); handler does not run |
| `http.idempotency_write_unconfirmed` / `http.idempotency_ownership_lost` | response persistence unconfirmed (500) or ownership lost (409); reconcile before repetition |
| `http.idempotency_release_unconfirmed` | explicit reconciled release unconfirmed (503); query the reservation |
| `http.idempotency_replay_invalid` / `http.idempotency_response_unavailable` | invalid stored replay or completed response cannot be retained (500); reservation stays held |
| `http.idempotency_request_too_large` | body exceeds protection limit (413); handler does not run |
| `http.idempotency_request_unreadable` | request body cannot be read (400); no cache acquisition or handler execution |
| `http.idempotency_hash_unavailable` | runtime has no Web Crypto SHA-256 (503); no cache acquisition or handler execution |
| `http.idempotency_key_required` / `http.idempotency_key_reused` / `http.idempotency_in_progress` | idempotency: key missing (400), key reused (422), still running (409 with `Retry-After: 1`); replaces legacy E410/E411/E412 wire codes |
| `ARKI_HTTP_E413` | request body larger than the route allows (413) |
| `ARKI_HTTP_E420` / `E421` / `E422` | legacy diagnostic constants; migrated webhook operations return the canonical failures below |
| `http.webhook_malformed` / `http.webhook_signature_mismatch` / `http.webhook_stale` | malformed headers/time, invalid signature, authenticated time outside the window (401) |
| `http.webhook_body_unreadable` / `http.webhook_body_too_large` | request bytes unreadable (400) or above the configured cap (413) |
| `http.webhook_crypto_unavailable` | required Web Crypto operation unavailable (503); broken providers return `UnexpectedDefect` |
| `ARKI_HTTP_E500` | handler crash or output-schema violation |
| `ARKI_HTTP_E510` | a `Response` without `output: raw()`, or a plain value from a `raw()` route (answers 500) |
| `ARKI_HTTP_E511` | a result that does not fit the contract: undeclared `reply` status, or a value on a no-output route (answers 500) |

`E0NN` codes surface through the DOT lifecycle into `app.diagnostics`;
`E4xx`/`E5xx` codes surface on the wire in the error envelope (`E510` and
`E511` answer 500). Unexpected
error messages are redacted unless `NODE_ENV=development`.

## Limits

- **Request bodies.** A body larger than the route allows answers 413 (`ARKI_HTTP_E413`). A webhook route reads at most `maxBodyBytes`.
- **Idempotency.** A key is remembered by the store you give it. A key reused with a different body answers 422. A request still running answers 409.
- **Webhooks.** A signed time outside the window returns `WebhookStale` (401). Keep your clock in sync.
- **Drain.** `stop` waits `drainTimeoutMs` (10 s by default), then rejects with `ARKI_HTTP_E005`.
- **Output.** Output is validated against the schema. A schema that keeps undeclared keys lets them out. Pick the fields you return.
- **OpenAPI.** A schema without a JSON Schema form throws `ARKI_HTTP_E013`. Wrap it with `withJsonSchema`.
- **Outbound URLs.** `public-fetch` refuses private, loopback and link-local addresses, also after DNS and redirects.

## Documentation

The [agent guide](docs/agent-guide.md) has the model, a task map and the rules. The Dot docs (`packages/dot/docs/`) cover unit authoring and lifecycle.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, your runtime and the error `code`.

<!-- bench:start -->
## Benchmarks

Each router receives a real `Request` and returns a `Response`, in process, with no network. `@arki/http` is built on hono, so hono is the direct reference; itty-router is the small, hand-wired alternative. All three serve the same 20 routes and validate bodies with the same zod schema.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Static GET (one of 20 routes)

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 46.83 µs | 1.41× |
| hono (+ @hono/zod-validator for bodies) | 33.17 µs | fastest |
| itty-router v5 (hand-written validation) | 35.46 µs | 1.07× |

### GET with a path parameter

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 28.75 µs | 1.33× |
| hono (+ @hono/zod-validator for bodies) | 21.54 µs | fastest |
| itty-router v5 (hand-written validation) | 26.25 µs | 1.22× |

### POST with a valid JSON body

Body parsed and checked with the same zod schema in all three. `@arki/http` also checks the output.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 40.54 µs | 1.12× |
| hono (+ @hono/zod-validator for bodies) | 36.54 µs | 1.01× |
| itty-router v5 (hand-written validation) | 36.21 µs | fastest |

### POST with an invalid body (400)

The failure path. `@arki/http` builds its typed error envelope; hono returns its validator error; itty returns a hand-written JSON error.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/http (route contracts) | 55.17 µs | 1.23× |
| hono (+ @hono/zod-validator for bodies) | 53.08 µs | 1.18× |
| itty-router v5 (hand-written validation) | 44.96 µs | fastest |

Read the rows with the contracts in mind:

- `@arki/http` runs on hono. The gap to plain hono is the price of the contract layer: every handler input (params, query, body) is validated against its contract, and every handler output is validated against the contract output schema, so a wrong response fails loudly instead of leaving the process.
- The hono and itty-router rows do not validate handler output and have no route ids, no error envelope and no OpenAPI generation. Their `Request` and `Response` work is the same.
- itty-router has no validation hook, so its rows parse the JSON and run the zod schema by hand, the way its docs suggest.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

### Over a socket

`bun run bench:server` runs the same three routes end to end, on Bun and on Node, against hand-written `Bun.serve` and `node:http` ceilings and against hono, elysia, h3, srvx and fastify, and reports server CPU microseconds per request next to requests per second (see `bench/server/README.md`). On a 12-core M2 Max, Bun 1.4.2 and Node 26.11, the default engine costs about 0.5 µs of CPU per request over a bare `Response.json` on Bun (1.0 µs on a route with a path parameter, 1.0 µs on a validated POST) and about 1.3 µs over `@hono/node-server`'s own floor on Node 26; the Hono engine is 10 % to 20 % behind it on routes with parameters or a body.

## License

MIT

Client calls return success, exactly the failures in `route.failures`, or `HttpClientFailure`
(inferred from `HTTP_CLIENT_FAILURES` and `HTTP_SERVER_FAILURES`). They resolve canonical failures for network errors,
deadlines, cancellation, local validation and protocol drift. Unknown remote codes and invalid
known payloads return `InvalidEnvelope`; inspect its `data.reason`. Remote presentation fields
are ignored during revival.

List middleware-owned definitions explicitly on the route, for example
`failures: [...IDEMPOTENCY_FAILURES, OrderNotFound]`. Auth definitions belong on the
same boundary only when that route uses them. A handler or middleware adapter can call
`orThrowHttp(value, definitions, { headers })` when its framework requires an exception;
the bridge validates JSON data and preserves status and headers. Returned handler failures
also pass through `serialize` before crossing the wire. Private causes remain local.

Steps may return canonical failures instead of the object they add. The builder
accumulates these inferred failures and requires every later bound HTTP, SSE or typed RPC
contract to declare them. Successful context fields exclude failures. A returned failure stops
later steps and the handler; the matched contract validates its serialized data.
`step(fn, { failureHeaders })` preserves challenge or retry headers.
Handler-owned refusals use `bind(contract, handler, { failureHeaders })`.

Bindings snapshot their steps: adding a guard later in a chain cannot change a route bound
earlier. Typed RPC mounts declare their guard failures with `rpcMount(path, { id, failures })`.
Idempotency `routes` accepts canonical descriptors, not method/path strings, and checks all
definitions in `IDEMPOTENCY_FAILURES` on every descriptor. Foreign fetch middleware remains an untyped
transport edge.

### Request identities and tracing

`BaseRequestCtx.requestId` is `RequestId`, inferred from the exported `requestId`
definition. Every present `x-request-id` string, including an empty string, keeps
its bytes and bypasses entropy. Otherwise HTTP generates a UUID through
`@arki/contracts`: native `randomUUID`, or secure `getRandomValues` when the native
method is absent. Provider failures stop bound handlers, steps and RPC context
creation. Typed clients admit these framework failures automatically.

Idempotency cache owners use a separate `IdempotencyOwnerId`, exported with
`idempotencyOwnerId` from `@arki/http/idempotency`. Generate the owner before
hashing, cache acquisition or application execution. Use the canonical schema to
restore existing owner strings in adapters and fixtures. Storage bytes do not
change. `IDEMPOTENCY_FAILURES` includes generation failures; derive its union
instead of copying its members.

The engine creates an `http.request` span and protected idempotency middleware
creates an `http.idempotency` span through `@opentelemetry/api`. They inherit the
active context and record response status and canonical failure codes, without
request IDs, URLs, keys, bodies or private causes. Configure the SDK and context
manager in the application. Handlers and units can use the active span or
create their own children. Reporting failures cannot repeat or suppress the
owned execution. See the [identity upgrade guide](docs/upgrade-identities.md).
