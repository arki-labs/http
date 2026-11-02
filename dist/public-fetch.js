import ipaddr from 'ipaddr.js';
import { isFailure } from '@arki/failure';
import { NetworkFailure, RedirectLimit, RequestCancelled, RequestTimeout, ResponseTooLarge, UnsafeUrl, } from './failures.js';
export { NetworkFailure, PUBLIC_FETCH_FAILURES, RedirectLimit, RequestCancelled, RequestTimeout, ResponseTooLarge, UnsafeUrl, } from './failures.js';
/**
 * The system resolver and undici, loaded on first use: this module's top
 * level has no `node:` import, so the pure checks (`validatePublicURL`) also
 * load in a browser bundle that shares a schema with the server.
 */
export const systemTransport = {
    lookup: async (hostname) => {
        const dns = await import('node:dns/promises');
        return dns.lookup(hostname, { all: true });
    },
    fetch: async (input, init) => {
        const undici = await import('undici/index.js');
        return undici.fetch(input, init);
    },
};
/** The env variable that lists hosts the guard lets through even at a private address (tests only). */
export const FETCH_ALLOW_HOSTS_ENV = 'FETCH_ALLOW_HOSTS';
/**
 * Hosts (`host:port`, comma separated, from `FETCH_ALLOW_HOSTS`) that skip the private-address
 * checks. It exists so an end-to-end test can fetch from a feed server on the same machine. It
 * throws in production, so a misset variable can never open the guard; call it at boot to fail early.
 * Only the exact `host:port` listed is allowed; every other private address is still refused.
 */
export function fetchAllowedHosts(env = typeof process === 'undefined' ? {} : process.env) {
    const listed = (env[FETCH_ALLOW_HOSTS_ENV] ?? '')
        .split(',')
        .map(host => host.trim().toLowerCase())
        .filter(host => host !== '');
    if (listed.length > 0 && env['NODE_ENV'] === 'production')
        throw new Error(`${FETCH_ALLOW_HOSTS_ENV} is for tests only; refusing to run in production.`);
    return new Set(listed);
}
function isAllowedHost(url) {
    return fetchAllowedHosts().has(url.host.toLowerCase());
}
export function isPublicAddress(address) {
    try {
        return ipaddr.process(address).range() === 'unicast';
    }
    catch {
        return false;
    }
}
/**
 * The URL must be http(s) at a public address. `user:pass@` is refused unless
 * `allowCredentials` is set (private feeds use it; `safeFetchBytes` then sends
 * it as a Basic `Authorization` header). A refusal returns {@link UnsafeUrl}, whose message
 * never carries the URL itself.
 */
export function validatePublicURL(value, options = {}) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return UnsafeUrl({ reason: 'invalid_url' });
    }
    const hasCredentials = url.username !== '' || url.password !== '';
    if (!['http:', 'https:'].includes(url.protocol) || (hasCredentials && !options.allowCredentials))
        return UnsafeUrl({ reason: 'scheme_or_credentials' });
    const host = url.hostname.replaceAll(/^\[|\]$/g, '');
    if (ipaddr.isValid(host) && !isPublicAddress(host) && !isAllowedHost(url))
        return UnsafeUrl({ reason: 'private_address' });
    return url;
}
/** `user:pass@` from a URL as a Basic `Authorization` value (UTF-8, percent-decoding undone). */
function basicAuthorization(url) {
    const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    return `Basic ${btoa(String.fromCodePoint(...new TextEncoder().encode(pair)))}`;
}
/** Rejects once `signal` aborts (at once when it already has), with its reason when that is an error. */
function untilAborted(signal) {
    const reason = () => (signal.reason instanceof Error ? signal.reason : new Error('Fetch aborted.'));
    return new Promise((_, reject) => {
        if (signal.aborted)
            reject(reason());
        else
            signal.addEventListener('abort', () => reject(reason()), { once: true });
    });
}
/**
 * The guard itself, shared by {@link safeFetchBytes} and {@link publicFetch}: every hop resolves
 * the host, refuses any private answer, pins the connection to the checked address, and follows a
 * redirect only to another public URL; each refusal returns {@link UnsafeUrl}. The body is
 * read here, under `maxBytes`, because the pinned connection is closed before this returns.
 * Network, DNS and abort errors are outside outcomes: they return {@link NetworkFailure},
 * {@link RequestTimeout} or {@link RequestCancelled}, with the original error as the cause.
 */
async function fetchPinned(request) {
    try {
        return await fetchPinnedHops(request);
    }
    catch (error) {
        const { signal } = request;
        // The deadline and the caller's abort name themselves, whether the signal or the transport raised them.
        const name = signal?.aborted === true && signal.reason instanceof Error ? signal.reason.name : errorName(error);
        if (name === 'TimeoutError')
            return RequestTimeout({ cause: error });
        if (name === 'AbortError' || signal?.aborted === true)
            return RequestCancelled({ cause: error });
        return NetworkFailure({ cause: error });
    }
}
const errorName = (error) => (error instanceof Error ? error.name : '');
async function fetchPinnedHops(request) {
    const { transport, signal, maxBytes } = request;
    let { url, method, headers, body } = request;
    // Explicit package entry avoids Bun's undici shim, which drops dispatcher options.
    const { Agent } = await import('undici/index.js');
    for (let hop = 0; hop <= 5; hop++) {
        const host = url.hostname.replaceAll(/^\[|\]$/g, '');
        const addresses = await (signal === undefined
            ? transport.lookup(host)
            : Promise.race([transport.lookup(host), untilAborted(signal)]));
        const [address] = addresses;
        if (address === undefined || (!addresses.every(a => isPublicAddress(a.address)) && !isAllowedHost(url)))
            return UnsafeUrl({ reason: 'private_address' });
        // Resolve once and pin the connection; a second DNS answer must never select a private address.
        const agent = new Agent({
            connect: {
                autoSelectFamily: false,
                lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
            },
        });
        try {
            const response = await transport.fetch(url, {
                dispatcher: agent,
                method,
                body,
                headers,
                redirect: 'manual',
                signal,
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel();
                const location = response.headers.get('location');
                if (!location || hop === 5)
                    return RedirectLimit();
                const next = validatePublicURL(new URL(location, url).href);
                if (isFailure(next))
                    return next;
                if (next.origin !== url.origin)
                    headers = {};
                // Like a browser: 301/302/303 turn a POST into a GET and drop its body; 307/308 replay it.
                if ([301, 302, 303].includes(response.status) && method !== 'GET' && method !== 'HEAD') {
                    method = 'GET';
                    body = undefined;
                }
                url = next;
                continue;
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body ?? []) {
                size += chunk.length;
                if (size > maxBytes) {
                    return ResponseTooLarge();
                }
                chunks.push(chunk);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            return {
                bytes,
                status: response.status,
                headers: new Headers([...response.headers.entries()]),
                url: url.href,
            };
        }
        finally {
            await agent.destroy();
        }
    }
    return RedirectLimit();
}
/**
 * Fetch `value` through the guard and return the whole body, or a failure from
 * {@link PublicFetchFailure}: a refused URL, too many redirects, a body over `maxBytes`, a network
 * error, a timeout or a cancellation. It never throws for those outcomes.
 */
export async function safeFetchBytes(value, options = {}) {
    const checked = validatePublicURL(value, { allowCredentials: options.allowCredentials });
    if (isFailure(checked))
        return checked;
    let url = checked;
    let headers = options.headers ?? {};
    if (url.username !== '' || url.password !== '') {
        // The header travels with the other headers: a cross-origin redirect drops it.
        headers = { ...headers, authorization: basicAuthorization(url) };
        url = new URL(url.href);
        url.username = '';
        url.password = '';
    }
    return fetchPinned({
        url,
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        maxBytes: options.maxBytes ?? 10_000_000,
        transport: options.transport ?? systemTransport,
    });
}
/** The caller's signal, if any, bounded by a timeout. */
function withTimeout(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
/** Statuses whose response must have no body; `new Response(bytes, { status })` throws for them. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
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
export function publicFetch(options = {}) {
    return async (input, init = {}) => {
        const body = init.body === undefined || init.body === null || typeof init.body === 'string'
            ? (init.body ?? undefined)
            : new Uint8Array(await new Response(init.body).arrayBuffer());
        const url = validatePublicURL(input);
        const signal = withTimeout(init.signal ?? undefined, options.timeoutMs ?? 30_000);
        const result = isFailure(url)
            ? url
            : await fetchPinned({
                url,
                method: init.method ?? 'GET',
                headers: Object.fromEntries(new Headers(init.headers)),
                body,
                signal,
                maxBytes: options.maxBytes ?? 10_000_000,
                transport: options.transport ?? systemTransport,
            });
        if (isFailure(result)) {
            if (RequestCancelled.is(result))
                throw signal.reason;
            throw new TypeError(result.message, { cause: result });
        }
        return new Response(NULL_BODY_STATUSES.has(result.status) ? null : result.bytes, {
            status: result.status,
            headers: result.headers,
        });
    };
}
//# sourceMappingURL=public-fetch.js.map