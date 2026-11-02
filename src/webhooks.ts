/**
 * Signed webhooks in: check that a request comes from the sender who holds the secret.
 *
 * Every scheme here works the same way. The sender computes an HMAC over `prefix + body` with a
 * shared secret and puts it in a header. The schemes differ only in which headers carry the
 * event id, the time and the signature, what the prefix is, and how the signature is written.
 *
 * ```ts
 * // stripeEvent declares failures: WEBHOOK_FAILURES in its route contract.
 * const stripeEvents = routes()
 *   .use(step(verifyWebhook({ scheme: stripe({ secrets: [env.STRIPE_WEBHOOK_SECRET] }) })))
 *   .bind(stripeEvent, async ({ body }, { webhook }) => {
 *     // The event id is the journal key: a resent event commits nothing the second time.
 *     await journal.run(recordStripeEvent, body, { idempotencyKey: webhook.id });
 *   });
 * ```
 *
 * Portable: Web Crypto only. `subtle.verify` compares in constant time, so no hand-written compare.
 * Several secrets are accepted at once, so a secret can be rotated without dropping events.
 */
import { z } from 'zod';

import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { WebhookFailure, WebhookSignFailure, WebhookVerifyFailure } from './webhook-failures.js';
import { fromBase64, readCapped, toBase64, toHex } from './bytes.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { RequestCancelled } from './failures.js';
import {
  WEBHOOK_VERIFY_FAILURES,
  WebhookBodyTooLarge,
  WebhookBodyUnreadable,
  WebhookCryptoUnavailable,
  WebhookMalformed,
  WebhookSignatureMismatch,
  WebhookStale,
} from './webhook-failures.js';
import { observeWebhook } from './webhook-telemetry.js';

export * from './webhook-failures.js';
export const webhookDeliveryId = defineId('', { kind: 'http.webhook.delivery', format: 'uuid' });
export type WebhookDeliveryId = IdOf<typeof webhookDeliveryId>;

// Re-exported so code that imports only this entry (not the server root) can match the codes.
export { HTTP_ERROR_CODES, HttpConfigError, HttpError } from './error.js';

/** A request to check: its headers and the exact bytes of its body. */
export type WebhookMessage = { readonly headers: Headers; readonly body: Uint8Array<ArrayBuffer> };

/** A webhook whose signature matched one of the secrets. `TId` is `string` for schemes that always carry an id. */
export type VerifiedWebhook<TId extends string | undefined = string | undefined> = {
  /** The sender's id for this event, when the scheme carries one. Use it as the journal idempotency key. */
  readonly id: TId;
  /** When the sender signed it, in Unix seconds, when the scheme signs a time. */
  readonly timestamp: number | undefined;
  /** The exact bytes that were signed. */
  readonly body: Uint8Array<ArrayBuffer>;
};

export type VerifyOptions = {
  /** How far the signed time may be from now, either way, in seconds. Default 300. */
  readonly tolerance?: number;
};

export type SignOptions = {
  /** The event id, for schemes that carry one. Default: a random UUID. */
  readonly id?: string;
  /** The send time in Unix seconds. Default: now. */
  readonly timestamp?: number;
};

/** One way of signing webhooks: how to check a request, and how a sender signs one. */
export type WebhookScheme<TId extends string | undefined = string | undefined> = {
  /** Resolves when a signature matches and the signed time is within tolerance. Returns the exact canonical verification failure otherwise. */
  readonly verify: (
    message: WebhookMessage,
    options?: VerifyOptions,
  ) => Promise<VerifiedWebhook<TId> | WebhookVerifyFailure>;
  /** The headers a sender adds to `body`, signed with the first secret. */
  readonly sign: (
    body: Uint8Array<ArrayBuffer> | string,
    options?: SignOptions,
  ) => Promise<Headers | WebhookSignFailure>;
};

/** The hash behind the HMAC. */
export type WebhookAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

/** How a signature is written in its header. */
export type WebhookEncoding = 'hex' | 'base64';

const cancelled = (req: Request): boolean => req.signal.aborted;

const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const UNIX_SECONDS = /^\d+$/;
const HEX = /^(?:[\da-f]{2})+$/i;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** What a scheme read from a request's headers. */
type Read<TId extends string | undefined> = {
  readonly id: TId;
  readonly timestamp: string | undefined;
  readonly signatures: readonly string[];
  /** The text signed before the body. */
  readonly prefix: string;
};

/** What a scheme writes when it signs. */
type Stamp = {
  readonly prefix: string;
  readonly headers: (signature: string) => Headers;
};

type SchemeParts<TId extends string | undefined> = {
  readonly name: string;
  readonly needsId: boolean;
  readonly keys: readonly Uint8Array<ArrayBuffer>[];
  readonly algorithm: WebhookAlgorithm;
  readonly encoding: WebhookEncoding;
  /** `undefined` when a header the scheme needs is missing or malformed. */
  readonly read: (
    message: WebhookMessage,
  ) => Read<TId> | WebhookVerifyFailure | undefined | Promise<Read<TId> | WebhookVerifyFailure | undefined>;
  readonly stamp: (id: string, timestamp: string) => Stamp;
};

const invalidScheme = (name: string, problem: string): HttpConfigError =>
  new HttpConfigError({
    code: HTTP_ERROR_CODES.invalidWebhookScheme,
    message: `[http] ${name}() ${problem}.`,
    remediation:
      'Pass at least one non-empty secret. During a rotation pass both, the new one first: it is the one `sign` uses.',
  });

const utf8Keys = (name: string, secrets: readonly string[]): Uint8Array<ArrayBuffer>[] => {
  if (secrets.length === 0) throw invalidScheme(name, 'got no secrets');
  // An HMAC keyed with an empty secret can be computed by anyone.
  if (secrets.includes('')) throw invalidScheme(name, 'got an empty secret');
  return secrets.map(secret => textEncoder.encode(secret));
};

const decodeSignature = (text: string, encoding: WebhookEncoding): Uint8Array<ArrayBuffer> | undefined => {
  if (encoding === 'hex') {
    if (!HEX.test(text)) return undefined;
    const bytes = new Uint8Array(text.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  try {
    return fromBase64(text);
  } catch {
    return undefined;
  }
};

const withPrefix = (prefix: string, body: Uint8Array): Uint8Array<ArrayBuffer> => {
  const head = textEncoder.encode(prefix);
  const signed = new Uint8Array(head.length + body.length);
  signed.set(head);
  signed.set(body, head.length);
  return signed;
};

/** Resolve a Web Crypto operation at its foreign boundary, retaining its receiver. */
const cryptoOperation = async (operation: 'importKey' | 'verify' | 'sign' | 'digest', args: readonly unknown[]) => {
  const provider: unknown = Reflect.get(globalThis, 'crypto');
  if (typeof provider !== 'object' || provider === null) return WebhookCryptoUnavailable();
  const subtle: unknown = Reflect.get(provider, 'subtle');
  if (typeof subtle !== 'object' || subtle === null) return WebhookCryptoUnavailable();
  const method: unknown = Reflect.get(subtle, operation);
  if (typeof method !== 'function') return WebhookCryptoUnavailable();
  const result: unknown = await Reflect.apply(method, subtle, args);
  return { result };
};

/** Constructing a view checks real buffer slots and rejects detached buffers. */
const cryptoBytes = (value: unknown, length: number): Uint8Array<ArrayBuffer> => {
  if (!(value instanceof ArrayBuffer)) throw new TypeError('Web Crypto returned an invalid buffer.');
  const bytes = new Uint8Array(value);
  if (bytes.length !== length) throw new TypeError('Web Crypto returned an invalid buffer length.');
  return bytes;
};

function defineScheme<TId extends string | undefined>(parts: SchemeParts<TId>): WebhookScheme<TId> {
  const importKeys = () =>
    Promise.resolve()
      .then(async () => {
        const result: CryptoKey[] = [];
        for (const key of parts.keys) {
          const outcome = await cryptoOperation('importKey', [
            'raw',
            key,
            { name: 'HMAC', hash: parts.algorithm },
            false,
            ['sign', 'verify'],
          ]);
          if (isFailure(outcome)) return outcome;
          if (typeof CryptoKey === 'undefined' || !(outcome.result instanceof CryptoKey))
            throw new TypeError('Web Crypto returned an invalid key.');
          result.push(outcome.result);
        }
        return result;
      })
      .catch((error: unknown) => UnexpectedDefect({ cause: error }));
  let imported: ReturnType<typeof importKeys> | undefined;
  const keys = () => {
    if (imported !== undefined) return imported;
    const attempt = importKeys();
    imported = attempt;
    void attempt.then(value => {
      if (isFailure(value) && imported === attempt) imported = undefined;
    });
    return attempt;
  };

  return {
    verify: (message, options = {}) =>
      observeWebhook('http.webhook.verify', async () => {
        const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
        if (!Number.isFinite(tolerance) || tolerance < 0) return WebhookMalformed();
        const read = await parts.read(message);
        if (isFailure(read)) return read;
        if (read === undefined || read.signatures.length === 0) return WebhookMalformed();
        const imported = await keys();
        if (isFailure(imported)) return imported;
        let matched = false;
        const signed = withPrefix(read.prefix, message.body);
        for (const signature of read.signatures) {
          const bytes = decodeSignature(signature, parts.encoding);
          if (bytes === undefined) continue;
          for (const key of imported) {
            const outcome = await cryptoOperation('verify', ['HMAC', key, bytes, signed]);
            if (isFailure(outcome)) return outcome;
            if (typeof outcome.result !== 'boolean')
              throw new TypeError('Web Crypto returned an invalid verification result.');
            if (outcome.result) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (!matched) return WebhookSignatureMismatch();
        let timestamp: number | undefined;
        if (read.timestamp !== undefined) {
          timestamp = Number(read.timestamp);
          if (!UNIX_SECONDS.test(read.timestamp) || !Number.isSafeInteger(timestamp)) return WebhookMalformed();
          if (Math.abs(Date.now() / 1000 - timestamp) > tolerance) return WebhookStale();
        }
        return { id: read.id, timestamp, body: message.body };
      }),
    sign: (body, options = {}) =>
      observeWebhook('http.webhook.sign', async () => {
        const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
        if (!Number.isSafeInteger(timestamp) || timestamp < 0)
          throw new TypeError('Webhook signing time must be Unix seconds.');
        const id = options.id ?? (parts.needsId ? webhookDeliveryId.create() : '');
        if (isFailure(id)) return id;
        const stamp = parts.stamp(id, String(timestamp));
        const bytes = typeof body === 'string' ? textEncoder.encode(body) : body;
        const imported = await keys();
        if (isFailure(imported)) return imported;
        const [key] = imported;
        if (key === undefined) throw new TypeError('Webhook signing key is missing.');
        const outcome = await cryptoOperation('sign', ['HMAC', key, withPrefix(stamp.prefix, bytes)]);
        if (isFailure(outcome)) return outcome;
        const mac = cryptoBytes(
          outcome.result,
          parts.algorithm === 'SHA-1' ? 20 : parts.algorithm === 'SHA-256' ? 32 : 64,
        );
        return stamp.headers(parts.encoding === 'hex' ? toHex(mac) : toBase64(mac));
      }),
  };
}

/**
 * [Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp` and
 * `webhook-signature: v1,<base64>` (several, space-separated). Secrets are base64, with or without
 * the `whsec_` prefix. Only `v1` (HMAC-SHA256) signatures are read.
 */
export function standardWebhooks(options: { readonly secrets: readonly string[] }): WebhookScheme<string> {
  const name = 'standardWebhooks';
  if (options.secrets.length === 0) throw invalidScheme(name, 'got no secrets');
  const keys = options.secrets.map(secret => {
    let key: Uint8Array<ArrayBuffer>;
    try {
      key = fromBase64(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret);
    } catch {
      throw invalidScheme(name, 'got a secret that is not base64');
    }
    if (key.length === 0) throw invalidScheme(name, 'got an empty secret');
    return key;
  });
  return defineScheme({
    name,
    needsId: true,
    keys,
    algorithm: 'SHA-256',
    encoding: 'base64',
    read: ({ headers }) => {
      const id = headers.get('webhook-id');
      const timestamp = headers.get('webhook-timestamp');
      const signature = headers.get('webhook-signature');
      if (id === null || timestamp === null || signature === null) return;
      const signatures = signature.split(' ').flatMap(part => (part.startsWith('v1,') ? [part.slice(3)] : []));
      return { id, timestamp, signatures, prefix: `${id}.${timestamp}.` };
    },
    stamp: (id, timestamp) => ({
      prefix: `${id}.${timestamp}.`,
      headers: signature =>
        new Headers({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }),
    }),
  });
}

const stripeEvent = z.object({ id: z.string() });

/** The `id` field of a Stripe event body, or `undefined` when the body is not one. */
const stripeEventId = (body: Uint8Array): string | undefined => {
  try {
    const parsed = stripeEvent.safeParse(JSON.parse(textDecoder.decode(body)));
    return parsed.success ? parsed.data.id : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Stripe: `stripe-signature: t=<seconds>,v1=<hex>[,v1=<hex>]` over `${t}.${body}`. Stripe sends one
 * `v1` per secret it holds while you roll a secret; any one may match. The id is the event's `id`
 * field, read from the body.
 */
export function stripe(options: { readonly secrets: readonly string[] }): WebhookScheme {
  return defineScheme({
    name: 'stripe',
    needsId: false,
    keys: utf8Keys('stripe', options.secrets),
    algorithm: 'SHA-256',
    encoding: 'hex',
    read: ({ headers, body }) => {
      const header = headers.get('stripe-signature');
      if (header === null) return;
      let timestamp: string | undefined;
      const signatures: string[] = [];
      for (const element of header.split(',')) {
        const at = element.indexOf('=');
        if (at <= 0) continue;
        const key = element.slice(0, at).trim();
        const value = element.slice(at + 1).trim();
        if (key === 't') timestamp = value;
        else if (key === 'v1' && value !== '') signatures.push(value);
      }
      if (timestamp === undefined) return;
      return { id: stripeEventId(body), timestamp, signatures, prefix: `${timestamp}.` };
    },
    stamp: (_id, timestamp) => ({
      prefix: `${timestamp}.`,
      headers: signature => new Headers({ 'stripe-signature': `t=${timestamp},v1=${signature}` }),
    }),
  });
}

export type HmacSchemeOptions = {
  readonly secrets: readonly string[];
  /** The header that carries the signature, such as `x-hub-signature-256`. */
  readonly header: string;
  /** Text before the signature in its header, such as GitHub's `sha256=`. Default none. */
  readonly headerPrefix?: string;
  /** Default `SHA-256`. */
  readonly algorithm?: WebhookAlgorithm;
  /** Default `hex`. */
  readonly encoding?: WebhookEncoding;
  /**
   * The header that carries the event id, for senders that sign it through `bodyPrefix`. Required on
   * the request when set. It never becomes `webhook.id`: see {@link hmac}.
   */
  readonly idHeader?: string;
  /**
   * The header that carries the send time in Unix seconds. Required on the request when set, and
   * checked against the tolerance. Only a signed time stops replays, so put it in `bodyPrefix`.
   */
  readonly timestampHeader?: string;
  /**
   * The text signed before the body, such as Slack's `({ timestamp }) => \`v0:${timestamp}:\``.
   * `id` and `timestamp` are empty strings when their header is not set. Default: the body alone.
   */
  readonly bodyPrefix?: (parts: { readonly id: string; readonly timestamp: string }) => string;
};

/**
 * Any HMAC scheme not covered above: GitHub, Slack, Shopify and most others.
 *
 * `webhook.id` is the SHA-256 (hex) of the body, never a header. These senders put their event id
 * in a header the signature does not cover (GitHub's `x-github-delivery`), so anyone who captured
 * one delivery could resend it under a new id and get it processed twice. The body is signed: a
 * resend has the same body, so the same id. Two different events with byte-identical bodies share
 * an id too; for a sender that sends those, key on an id inside the body instead.
 */
export function hmac(options: HmacSchemeOptions): WebhookScheme<string> {
  const { header, headerPrefix = '', idHeader, timestampHeader, bodyPrefix } = options;
  const prefixFor = (id: string, timestamp: string): string => bodyPrefix?.({ id, timestamp }) ?? '';
  return defineScheme({
    name: 'hmac',
    needsId: idHeader !== undefined,
    keys: utf8Keys('hmac', options.secrets),
    algorithm: options.algorithm ?? 'SHA-256',
    encoding: options.encoding ?? 'hex',
    read: async ({ headers, body }) => {
      const signature = headers.get(header);
      const id = idHeader === undefined ? undefined : headers.get(idHeader);
      const timestamp = timestampHeader === undefined ? undefined : headers.get(timestampHeader);
      if (signature === null || id === null || timestamp === null) return;
      if (!signature.startsWith(headerPrefix)) return;
      const digest = await cryptoOperation('digest', ['SHA-256', body]);
      if (isFailure(digest)) return digest;
      return {
        id: toHex(cryptoBytes(digest.result, 32)),
        timestamp,
        signatures: [signature.slice(headerPrefix.length)],
        prefix: prefixFor(id ?? '', timestamp ?? ''),
      };
    },
    stamp: (id, timestamp) => ({
      prefix: prefixFor(idHeader === undefined ? '' : id, timestampHeader === undefined ? '' : timestamp),
      headers: signature => {
        const signed = new Headers({ [header]: `${headerPrefix}${signature}` });
        if (idHeader !== undefined) signed.set(idHeader, id);
        if (timestampHeader !== undefined) signed.set(timestampHeader, timestamp);
        return signed;
      },
    }),
  });
}

export type VerifyWebhookOptions<TId extends string | undefined = string | undefined> = VerifyOptions & {
  readonly scheme: WebhookScheme<TId>;
  /** A body larger than this is refused with 413 before any check. Default 1 MiB. */
  readonly maxBodyBytes?: number;
};

/**
 * A step that checks the request's signature and adds `webhook` to the context:
 * `routes().use(step(verifyWebhook({ scheme })))`.
 * It reads a clone of the body, so the route's `body` schema still parses the same bytes after it.
 * A request that fails never reaches the handler: 401 (or 413 when the body is too large).
 */
export function verifyWebhook<TId extends string | undefined>(
  options: VerifyWebhookOptions<TId>,
): (ctx: { readonly req: Request }) => Promise<{ readonly webhook: VerifiedWebhook<TId> } | WebhookFailure> {
  const { scheme, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, tolerance } = options;
  return ({ req }) =>
    observeWebhook('http.webhook.request', async () => {
      if (cancelled(req)) return RequestCancelled();
      if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0)
        throw new TypeError('Webhook body limit must be a nonnegative integer.');
      let body: Uint8Array<ArrayBuffer> | undefined;
      try {
        body = await readCapped(req.clone().body, maxBodyBytes);
      } catch (error) {
        return cancelled(req) ? RequestCancelled() : WebhookBodyUnreadable({ cause: error });
      }
      if (cancelled(req)) return RequestCancelled();
      if (body === undefined) return WebhookBodyTooLarge();
      let verified: Awaited<ReturnType<typeof scheme.verify>>;
      try {
        verified = await scheme.verify({ headers: req.headers, body }, tolerance === undefined ? {} : { tolerance });
      } catch (error) {
        return cancelled(req) ? RequestCancelled() : UnexpectedDefect({ cause: error });
      }
      if (cancelled(req)) return RequestCancelled();
      if (isFailure(verified)) {
        if (WEBHOOK_VERIFY_FAILURES.some(definition => definition.is(verified))) return verified;
        throw new TypeError('Webhook scheme returned an undeclared failure.');
      }
      if (
        typeof verified !== 'object' ||
        // Foreign custom schemes can violate their TypeScript contract.
        Object.is(verified, null) ||
        (verified.id !== undefined && typeof verified.id !== 'string') ||
        (verified.timestamp !== undefined && (!Number.isSafeInteger(verified.timestamp) || verified.timestamp < 0)) ||
        !(verified.body instanceof Uint8Array)
      )
        throw new TypeError('Webhook scheme returned an invalid result.');
      return { webhook: verified };
    });
}
