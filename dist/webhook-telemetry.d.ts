import { UnexpectedDefect } from '@arki/failure';
/** Own execution before entering application instrumentation, including reentrant context managers. */
export declare function observeWebhook<Value>(name: string, run: () => Value | Promise<Value>): Promise<Value | ReturnType<typeof UnexpectedDefect>>;
//# sourceMappingURL=webhook-telemetry.d.ts.map