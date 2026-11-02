import type { IdOf } from '@arki/contracts';
import type { WebhookFailure, WebhookSignFailure, WebhookVerifyFailure } from './webhook-failures.js';
export * from './webhook-failures.js';
export declare const webhookDeliveryId: import("@arki/contracts").BrandedIdDeclaration<"", "http.webhook.delivery">;
export type WebhookDeliveryId = IdOf<typeof webhookDeliveryId>;
export { HTTP_ERROR_CODES, HttpConfigError, HttpError } from './error.js';
/** A request to check: its headers and the exact bytes of its body. */
export type WebhookMessage = {
    readonly headers: Headers;
    readonly body: Uint8Array<ArrayBuffer>;
};
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
    readonly verify: (message: WebhookMessage, options?: VerifyOptions) => Promise<VerifiedWebhook<TId> | WebhookVerifyFailure>;
    /** The headers a sender adds to `body`, signed with the first secret. */
    readonly sign: (body: Uint8Array<ArrayBuffer> | string, options?: SignOptions) => Promise<Headers | WebhookSignFailure>;
};
/** The hash behind the HMAC. */
export type WebhookAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';
/** How a signature is written in its header. */
export type WebhookEncoding = 'hex' | 'base64';
/**
 * [Standard Webhooks](https://www.standardwebhooks.com/): `webhook-id`, `webhook-timestamp` and
 * `webhook-signature: v1,<base64>` (several, space-separated). Secrets are base64, with or without
 * the `whsec_` prefix. Only `v1` (HMAC-SHA256) signatures are read.
 */
export declare function standardWebhooks(options: {
    readonly secrets: readonly string[];
}): WebhookScheme<string>;
/**
 * Stripe: `stripe-signature: t=<seconds>,v1=<hex>[,v1=<hex>]` over `${t}.${body}`. Stripe sends one
 * `v1` per secret it holds while you roll a secret; any one may match. The id is the event's `id`
 * field, read from the body.
 */
export declare function stripe(options: {
    readonly secrets: readonly string[];
}): WebhookScheme;
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
    readonly bodyPrefix?: (parts: {
        readonly id: string;
        readonly timestamp: string;
    }) => string;
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
export declare function hmac(options: HmacSchemeOptions): WebhookScheme<string>;
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
export declare function verifyWebhook<TId extends string | undefined>(options: VerifyWebhookOptions<TId>): (ctx: {
    readonly req: Request;
}) => Promise<{
    readonly webhook: VerifiedWebhook<TId>;
} | WebhookFailure>;
//# sourceMappingURL=webhooks.d.ts.map