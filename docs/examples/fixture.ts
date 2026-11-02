/**
 * The app pieces the README examples use but do not define: a small orders
 * app with its schemas, contracts, services and plugins. Every export is a
 * declaration; the README blocks that import it show how the package is used
 * with them.
 */
import { z } from 'zod';

import type { HttpMiddleware, RequestId, RouteBundle } from '@arki/http';
import { defineFeature } from '@arki/dot/feature';
import { infra, token } from '@arki/dot/unit';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import { optional, route, routes } from '@arki/http';
import { endpoints } from '@arki/http/dot';

export const OrderId = z.string();
export const Order = z.object({ id: OrderId, status: z.enum(['open', 'shipped']) });
export const CreateOrder = z.object({ status: z.enum(['open', 'shipped']) });
export const Conflict = z.object({ reason: z.string() });
export const Queued = z.object({ type: z.literal('queued') });
export const Shipped = z.object({ type: z.literal('shipped') });

type OrderValue = z.output<typeof Order>;
type OrderQuery = { readonly status?: 'open' | 'shipped' | undefined };

export type Db = {
  readonly orders: {
    list(query?: OrderQuery): Promise<OrderValue[]>;
    find(tenant: string, id: string): Promise<OrderValue | undefined>;
    create(body: z.output<typeof CreateOrder>, requestId: RequestId): Promise<OrderValue>;
  };
};

export const db: Db = {
  orders: {
    list: async query => [{ id: 'o1', status: query?.status ?? 'open' }],
    find: async (_tenant, id) => (id === 'o42' ? { id, status: 'open' } : undefined),
    create: async (body, requestId) => ({ id: `o-${requestId}`, status: body.status }),
  },
};

export const dbForTenant = (_tenantId: string): Db => db;

export const auth = {
  verify: async (authorization: string | null): Promise<{ readonly tenantId: string } | undefined> =>
    authorization === 'Bearer secret' ? { tenantId: 't1' } : undefined,
};

export const authorization = 'Bearer secret';

export const listOrders = route.get('/orders', {
  failures: [UnexpectedDefect],
  id: 'orders.list',
  query: { status: optional(z.enum(['open', 'shipped'])) },
  output: z.array(Order),
});

export const createOrder = route.post('/orders', {
  id: 'orders.create',
  body: CreateOrder,
  output: Order,
});

export const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: { id: OrderId },
  output: Order,
});

export const progress = route.sse('/orders/:id/progress', {
  id: 'orders.progress',
  event: z.discriminatedUnion('type', [Queued, Shipped]),
});

export const tracker = {
  watch: async function* (
    _id: string,
    _signal: AbortSignal,
  ): AsyncGenerator<z.output<typeof Queued> | z.output<typeof Shipped>> {
    yield { type: 'queued' };
    yield { type: 'shipped' };
  },
};

const NotFound = defineFailure('order.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no order {id}',
});

export const usecases = {
  find: async (id: string) => (await db.orders.find('t1', id)) ?? NotFound({ id }),
};

/** A `defineFeature` core, as `features/orders/feature.ts` would export it. */
export const core = defineFeature('orders').usecases({
  list: () => (query: OrderQuery) => db.orders.list(query),
});

export const orders = core.entrypoints(
  endpoints(core, ({ usecases }) => routes().bind(listOrders, ({ query }) => usecases.list(query)), {
    contracts: [listOrders],
  }),
);

export const adminPlugin = infra({
  name: 'admin',
  provides: { 'admin.routes': () => routes().bind(listOrders, () => db.orders.list()) },
});

export const OrdersRoutes = token<RouteBundle>()('orders.routes');

export const bundle: RouteBundle = routes().bind(listOrders, ({ query }) => db.orders.list(query));

export const logger = { info: (_message: string): void => undefined };
export const origins = ['https://app.example.com'];
export const requestLog =
  (_log: typeof logger): HttpMiddleware =>
  (req, next) =>
    next(req);
export const cors =
  (_allowed: readonly string[]): HttpMiddleware =>
  (req, next) =>
    next(req);

export const rpcHandler = async (_req: Request): Promise<Response> => new Response('ok');

export const partnerUrl = 'https://partner.example.com';
export const partnerRoutes = { listOrders, getOrder };
