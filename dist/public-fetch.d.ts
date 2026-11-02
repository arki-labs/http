import type { fetch as undiciFetch } from 'undici/index.js';
import { NetworkFailure, RedirectLimit, RequestCancelled, RequestTimeout, ResponseTooLarge, UnsafeUrl } from './failures.js';
export { NetworkFailure, PUBLIC_FETCH_FAILURES, RedirectLimit, RequestCancelled, RequestTimeout, ResponseTooLarge, UnsafeUrl, } from './failures.js';
/**
 * The two network calls a public fetch makes. Production uses the system
 * resolver and undici; a test passes fakes here and every address check
 * (literal IP, DNS answer, each redirect hop) still runs for real.
 */
export type PublicFetchTransport = {
    lookup: (hostname: string) => Promise<readonly {
        address: string;
        family: number;
    }[]>;
    fetch: typeof undiciFetch;
};
/**
 * The system resolver and undici, loaded on first use: this module's top
 * level has no `node:` import, so the pure checks (`validatePublicURL`) also
 * load in a browser bundle that shares a schema with the server.
 */
export declare const systemTransport: PublicFetchTransport;
/** The env variable that lists hosts the guard lets through even at a private address (tests only). */
export declare const FETCH_ALLOW_HOSTS_ENV = "FETCH_ALLOW_HOSTS";
/**
 * Hosts (`host:port`, comma separated, from `FETCH_ALLOW_HOSTS`) that skip the private-address
 * checks. It exists so an end-to-end test can fetch from a feed server on the same machine. It
 * throws in production, so a misset variable can never open the guard; call it at boot to fail early.
 * Only the exact `host:port` listed is allowed; every other private address is still refused.
 */
export declare function fetchAllowedHosts(env?: Readonly<Record<string, string | undefined>>): ReadonlySet<string>;
export declare function isPublicAddress(address: string): boolean;
/**
 * The URL must be http(s) at a public address. `user:pass@` is refused unless
 * `allowCredentials` is set (private feeds use it; `safeFetchBytes` then sends
 * it as a Basic `Authorization` header). A refusal returns {@link UnsafeUrl}, whose message
 * never carries the URL itself.
 */
export declare function validatePublicURL(value: string, options?: {
    allowCredentials?: boolean;
}): URL | ReturnType<typeof UnsafeUrl>;
/** A completed public fetch: the whole body, the final status and headers, and the final URL. */
export type PublicFetchResult = {
    readonly bytes: Uint8Array;
    readonly status: number;
    readonly headers: Headers;
    readonly url: string;
};
/** Every outcome of a public fetch except success. */
export type PublicFetchFailure = ReturnType<typeof UnsafeUrl> | ReturnType<typeof RedirectLimit> | ReturnType<typeof ResponseTooLarge> | ReturnType<typeof NetworkFailure> | ReturnType<typeof RequestTimeout> | ReturnType<typeof RequestCancelled>;
/**
 * Fetch `value` through the guard and return the whole body, or a failure from
 * {@link PublicFetchFailure}: a refused URL, too many redirects, a body over `maxBytes`, a network
 * error, a timeout or a cancellation. It never throws for those outcomes.
 */
export declare function safeFetchBytes(value: string, options?: {
    maxBytes?: number;
    headers?: Record<string, string>;
    timeoutMs?: number;
    method?: string;
    body?: string;
    /** Accept `user:pass@` in `value`; it is stripped from the request URL and sent as a Basic `Authorization` header. */
    allowCredentials?: boolean;
    transport?: PublicFetchTransport;
}): Promise<PublicFetchResult | PublicFetchFailure>;
/**
 * A `fetch` that reaches public addresses only, for server code that calls URLs it does not fully
 * control: `createClient(contracts, { baseUrl, fetch: publicFetch() })`. Each hop is resolved,
 * checked and pinned, as in {@link safeFetchBytes}; a private address or a redirect to one is refused.
 *
 * A `fetch` must return a `Response` or reject, so a refusal rejects the way `fetch` does for a
 * network error: with a `TypeError` whose `cause` is the failure ({@link UnsafeUrl},
 * {@link RedirectLimit}, {@link ResponseTooLarge}, {@link NetworkFailure} or {@link RequestTimeout}).
 * `createClient` turns it into a returned `NetworkFailure`; find the reason with `findCause`.
 * A caller abort rejects with the signal's reason, as `fetch` does.
 *
 * The response is buffered (at most `maxBytes`, default 10 MB) before it is returned, so a
 * streaming body arrives whole. Every request, body included, must finish within `timeoutMs`
 * (default 30 s), so a slow server cannot hold a connection open. Credentials in the URL are
 * refused; send them as a header.
 */
export declare function publicFetch(options?: {
    maxBytes?: number;
    timeoutMs?: number;
    transport?: PublicFetchTransport;
}): (input: string, init?: RequestInit) => Promise<Response>;
//# sourceMappingURL=public-fetch.d.ts.map