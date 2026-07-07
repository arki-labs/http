# @arki/http

Typed HTTP for ARKI — route contracts as data, zod-validated handlers,
request-scope derivers, SSE streaming, and deterministic OpenAPI
generation. Ships a DOT adapter (`@arki/http/dot`) whose `http()` pip
turns a composed app into a running server with correct drain-on-shutdown
semantics.

No decorators, no controller scanning, no runtime DI container. Contracts
are plain values; wiring is checked at compile time.

## The model

A route is split in two:

- **Contract** — pure data at module scope: method + path + zod schemas +
  a stable id. Registerable in the DOT manifest (sync `configure`),
  renderable as OpenAPI without booting, and the source of the handler's
  inferred signature.
- **Binding** — the handler, attached inside a pip's `boot` where the
  pip's typed needs are already injected. Handlers close over real
  services; no service locator exists.

```ts
import { route, routes } from '@arki/http';
import { z } from 'zod';

export const listOrders = route.get('/orders', {
  id: 'orders.list',
  query: z.object({ status: z.enum(['open', 'shipped']).optional() }),
  output: z.array(Order),
});

export const createOrder = route.post('/orders', {
  id: 'orders.create',
  body: CreateOrder,
  output: Order,
});
```

Input validation (query/body) happens before your handler runs; output is
validated against the contract on the way out. Failures serialize as a
coded envelope: `{ "error": { "code", "message", "remediation?", "docsUrl?" } }`.

## Inside a DOT app

```ts
import { pip, provide, service, token } from '@arki/dot/pip';
import { routes, type RouteBundle } from '@arki/http';
import { registerRoutes } from '@arki/http/dot';

export const OrdersRoutes = token<RouteBundle>()('orders.routes');

export const ordersPip = pip({
  name: 'orders',
  needs: { db: service<Db>() },
  configure(ctx) {
    registerRoutes(ctx, [listOrders, createOrder]); // manifest + OpenAPI metadata
  },
  async boot({ db }) {
    return provide(
      OrdersRoutes,
      routes()
        .bind(listOrders, async ({ query }) => db.orders.list(query))
        .bind(createOrder, async ({ body }, ctx) => db.orders.create(body, ctx.requestId)),
    );
  },
});
```

Mount the `http()` pip **last**, naming the bundles it serves:

```ts
import { defineApp, hookSignals } from '@arki/dot';
import { http } from '@arki/http/dot';

const app = await defineApp('shop-api')
  .use(db({ url: DATABASE_URL }))
  .use(ordersPip)
  .use(http({ port: 3000, bundles: [OrdersRoutes] }))
  .start();

hookSignals(app);
```

`http()` derives its `needs` from the tokens you pass — forget to mount
`ordersPip` and the `.use(http(...))` line fails to typecheck. Because the
pip is declared last, reverse-order `stop` halts ingress FIRST: the server
stops accepting, drains in-flight requests (`drainTimeoutMs`, default
10 s, `ARKI_HTTP_E005` on overrun), and only then do feature pips tear
down. `boot` builds the router without listening; `start` listens;
`dispose` severs remaining connections and releases the port.

The published `httpServer` service carries the composed
`fetch: (Request) => Promise<Response>` — also the unit-test seam: call
your whole app without a socket.

## Request scope — derivers, not containers

Per-request values are typed context keys derived by plain functions.
Derivers run in declaration order; each adds a key later handlers (and
later derivers) see typed. A deriver that throws `HttpError` is the whole
"guard" story:

```ts
import { derive, HttpError, HTTP_ERROR_CODES } from '@arki/http';

// inside boot — `auth` is an injected singleton
const withPrincipal = derive('principal', async req => {
  const p = await auth.verify(req.headers.get('authorization'));
  if (!p) throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'missing or invalid credentials');
  return p;
});

routes()
  .derive(withPrincipal)
  .derive('db', (_req, ctx) => dbForTenant(ctx.principal.tenantId))
  .bind(listOrders, async (_input, ctx) => ctx.db.orders.list());
```

Request scope is function application over the compile-time-wired
singleton graph — no per-request container resolution, no infectious
scopes. For code deep in a call stack you don't control, the fenced-off
`@arki/http/context` entry exposes `requestContext()` (AsyncLocalStorage).
It is a last resort; prefer the explicit `ctx`.

## App-wide middleware

For cross-cutting concerns that must see or touch the raw
request/response — CORS, request logging — pass fetch-shaped middleware
to `http()` (first = outermost). A middleware that throws `HttpError`
short-circuits into the coded envelope:

```ts
http({ port: 3000, bundles: [OrdersRoutes], middleware: [requestLog(logger), cors(origins)] })
```

Middleware wraps the whole engine and is untyped by design; anything that
produces a per-request *value* belongs in a deriver instead. Standalone
users compose the same way with `composeMiddleware(engine.fetch, [...])`.

## Streaming

**Typed SSE.** `route.sse` declares a `text/event-stream` contract; the
binding is an async generator. Every yield is validated against the event
schema and framed as a `data:` message; client disconnect aborts
`ctx.signal` and runs the generator's `finally`:

```ts
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
routes().mount('/rpc', rpcHandler, { id: 'rpc', transport: 'orpc' });
```

## OpenAPI

```ts
import { toOpenApi } from '@arki/http';

const document = toOpenApi([listOrders, createOrder, progress], {
  title: 'shop-api',
  version: '1.0.0',
});
```

Deterministic — same contracts, byte-identical output. Inside a DOT app,
`registerRoutes` puts the JSON Schemas into the manifest, so
`dot explain --openapi` renders the document from the static manifest
without booting anything.

## Without DOT

The core is framework-agnostic:

```ts
import { buildEngine, listen, routes } from '@arki/http';

const engine = buildEngine([bundle]);
const handle = await listen(engine.fetch, { port: 3000 });
```

`listen` uses `Bun.serve` under Bun and `@hono/node-server` under Node.
Routing is Hono internally; no Hono type appears in the public API.

## Error codes

Stable API — match on codes, never parse messages.

| Code | Meaning |
| --- | --- |
| `ARKI_HTTP_E001` | `start` could not bind the port |
| `ARKI_HTTP_E002` | duplicate route: two bindings claim the same method+path (or a bundle token is listed twice) |
| `ARKI_HTTP_E005` | `stop` exceeded `drainTimeoutMs` with requests in flight |
| `ARKI_HTTP_E006` | malformed mount path |
| `ARKI_HTTP_E007` | deriver key duplicates an earlier deriver or a base context key |
| `ARKI_HTTP_E008` | a bundle token's service was missing at boot (erased composition only) |
| `ARKI_HTTP_E400` | request validation failed (query/body) or body is not valid JSON |
| `ARKI_HTTP_E401` / `E403` | credential / permission rejection (thrown by your derivers) |
| `ARKI_HTTP_E404` | no route matches |
| `ARKI_HTTP_E500` | handler crash or output-schema violation |

`E0NN` codes surface through the DOT lifecycle into `app.diagnostics`;
`E4xx`/`E5xx` codes surface on the wire in the error envelope. Unexpected
error messages are redacted when `NODE_ENV=production`.

## License

MIT
