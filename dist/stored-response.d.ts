/** The Zod check behind `storedResponse`, apart so the `./idempotency` declarations stay free of Zod. */
import { z } from 'zod';
export declare const storedResponseSchema: z.ZodObject<{
    status: z.ZodInt;
    headers: z.ZodRecord<z.ZodString, z.ZodString>;
    body: z.ZodString;
}, z.core.$strip>;
//# sourceMappingURL=stored-response.d.ts.map