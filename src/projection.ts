/**
 * DOT projection entry point for `dot explain --as openapi`.
 *
 * The kernel imports this module by specifier from the app manifest. Keep it
 * pure: manifest in, JSON document out, no boot/runtime dependencies.
 */

import type { JsonObject } from './openapi.js';
import { toOpenApiFromManifest } from './openapi.js';

export function project(manifest: Parameters<typeof toOpenApiFromManifest>[0]): JsonObject {
  return toOpenApiFromManifest(manifest);
}
