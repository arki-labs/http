/**
 * The socket layer — runtime-adaptive listening.
 *
 * `Bun.serve` when the Bun global is present (with the engine's native
 * route table, when it has one), `@hono/node-server` otherwise. Neither runtime's types leak into the public surface; the
 * handle exposes exactly what the `http()` plugin's lifecycle needs.
 */
import type { Engine } from './engine.js';
export type ListenOptions = {
    readonly port: number;
    readonly hostname?: string;
};
export type ListenHandle = {
    readonly port: number;
    readonly hostname: string;
    /** Stop accepting new connections; in-flight requests continue. */
    stopAccepting(): void;
    /** Sever remaining connections and release the port. */
    forceClose(): void;
};
type FetchLike = (req: Request) => Response | Promise<Response>;
/**
 * Serve an engine, or a bare fetch handler. Under Bun an engine's
 * `bunRoutes` go to `Bun.serve({ routes })`, so those routes are matched
 * natively; everything else reaches `fetch`.
 */
export declare function listen(target: Engine | FetchLike, options: ListenOptions): Promise<ListenHandle>;
export {};
//# sourceMappingURL=listen.d.ts.map