/**
 * Devin Gateway — public entry point.
 *
 * Re-exports the programmatic API for external consumers (GitHub Actions,
 * scripts, other packages) and starts the HTTP server when run directly:
 *
 *   bun run src/index.ts
 *
 * Library callers import from this module without triggering the server:
 *
 *   import { chat, startServer } from "devin-gateway";
 */

import { accountProfilesEnabled, startServer } from "./server.js";
import { readFallbackToken } from "./config.js";

export * from "./proto.js";
export * from "./models.js";
export * from "./convert.js";
export * from "./config.js";
export * from "./devin.js";
export * from "./client.js";
export { startServer, type ServerOptions, type ServerHandle } from "./server.js";

if (import.meta.main) {
  // With model selection (and so account profiles) enabled, the saved login token is an account credential,
  // managed by AccountRuntime, and must not become a static override. Without selection, keep the legacy fallback.
  const accountsEnabled = accountProfilesEnabled();
  if (accountsEnabled) {
    await startServer();
  } else {
    const token = await readFallbackToken();
    await startServer(token ? { token } : {});
  }
}
