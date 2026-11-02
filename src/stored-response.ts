/** The Zod check behind `storedResponse`, apart so the `./idempotency` declarations stay free of Zod. */
import { z } from 'zod';

import { fromBase64 } from './bytes.js';

export const storedResponseSchema = z
  .object({
    status: z.int().min(200).max(599),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
  })
  .refine(value => {
    try {
      new Headers(value.headers);
      fromBase64(value.body);
      return true;
    } catch {
      return false;
    }
  }, 'Stored response headers and body must be valid HTTP/base64 values.');
