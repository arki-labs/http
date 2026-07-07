/**
 * The socket layer — runtime-adaptive listening.
 *
 * `Bun.serve` when the Bun global is present, `@hono/node-server`
 * otherwise. Neither runtime's types leak into the public surface; the
 * handle exposes exactly what the `http()` pip's lifecycle needs.
 */
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
export declare function listen(fetch: FetchLike, options: ListenOptions): Promise<ListenHandle>;
export {};
//# sourceMappingURL=listen.d.ts.map