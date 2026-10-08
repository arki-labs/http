import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici/index.js';

export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function validatePublicURL(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only public HTTP feeds are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new Error('Private network addresses are not allowed.');
  return url;
}
export async function safeFetchBytes(
  value: string,
  options: {
    maxBytes?: number;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
) {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30000);
  let url = validatePublicURL(value);
  let headers = options.headers ?? {};
  for (let hop = 0; hop <= 5; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Fetch timed out.')), { once: true }),
      ),
    ]);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address)))
      throw new Error('Private network addresses are not allowed.');
    const address = addresses[0]!;
    // Resolve once and pin the connection; a second DNS answer must never select a private address.
    // Explicit package entry avoids Bun's undici shim, which drops dispatcher options.
    const agent = new Agent({
      connect: {
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
    });
    try {
      const response = await fetch(url, { dispatcher: agent, headers, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hop === 5) throw new Error('Feed redirect limit exceeded.');
        const next = validatePublicURL(new URL(location, url).href);
        if (next.origin !== url.origin) headers = {};
        url = next;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > (options.maxBytes ?? 10000000)) {
          throw new Error('Response size limit exceeded.');
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
        headers: new Headers(Array.from(response.headers.entries())),
        url: url.href,
      };
    } finally {
      await agent.destroy();
    }
  }
  throw new Error('Feed redirect limit exceeded.');
}
