export declare function isPublicAddress(address: string): boolean;
export declare function validatePublicURL(value: string): import("url").URL;
export declare function safeFetchBytes(value: string, options?: {
    maxBytes?: number;
    headers?: Record<string, string>;
    timeoutMs?: number;
}): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    status: number;
    headers: import("undici-types").Headers;
    url: string;
}>;
//# sourceMappingURL=public-fetch.d.ts.map