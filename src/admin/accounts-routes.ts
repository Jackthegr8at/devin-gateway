/**
 * Admin API for Devin account profiles: GET and PUT /admin/api/accounts.
 *
 * Mounted only on the management listener. Every write needs the same
 * protections as the model-selection writes: a JSON content type, the
 * `X-Devin-Management: 1` header, and an `If-Match` revision. Browser
 * cross-origin writes are already rejected by `managementRequestAllowed`
 * before this handler runs.
 *
 * Responses never include tokens, token lengths, prefixes, or suffixes.
 */
import { AccountError, accountsETag, type AccountSelection } from "../accounts/account-store.js";
import type { AccountRuntime } from "../accounts/runtime.js";
import { ACCOUNT_PROFILE_IDS, profileCredentialState, type CredentialState } from "../accounts/profiles.js";
import { MAX_SELECTION_BYTES, ModelSelectionError } from "./model-selection.js";
import { ADMIN_PROXY_HEADER, type AdminProxySecret } from "./proxy-secret.js";

export const ACCOUNTS_PATH = "/admin/api/accounts";

const json = (body: unknown, status = 200, etag?: string): Response => Response.json(body, {
  status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...(etag ? { etag } : {}) },
});
const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

async function bodyText(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new ModelSelectionError("invalid_selection", "A JSON account update is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_SELECTION_BYTES) throw new ModelSelectionError("invalid_selection", "Account update exceeds the request limit.");
      chunks.push(next.value);
    }
    if (timedOut) throw new ModelSelectionError("invalid_selection", "Account update body timed out.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (err) {
    if (err instanceof ModelSelectionError) throw err;
    throw new ModelSelectionError("invalid_selection", "A valid JSON account update is required.");
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Public view of the store plus per-profile credential state. No credential detail. */
async function view(selection: AccountSelection, configDirectory: string, staticOverride: boolean): Promise<Record<string, unknown>> {
  const profiles = await Promise.all(ACCOUNT_PROFILE_IDS.map(async (id) => {
    const profile = selection.profiles.find((entry) => entry.id === id);
    const credentialState: CredentialState = await profileCredentialState(configDirectory, id);
    return { id, name: profile?.name ?? id, credentialState };
  }));
  // staticOverride is true when DEVIN_API_KEY or ServerOptions.token is set. Switching is then refused, so the page must say so.
  return { schemaVersion: 1, revision: selection.revision, activeProfileId: selection.activeProfileId, staticOverride, profiles };
}

export interface AccountRoutesOptions {
  runtime: AccountRuntime;
  /** Required for every account write when set. */
  proxySecret?: AdminProxySecret;
  configDirectory: string;
}

/** Returns a handler for `/admin/api/accounts`, or undefined when the path does not match. */
export function createAccountRoutes(options: AccountRoutesOptions) {
  const { runtime, configDirectory, proxySecret } = options;
  const guarded = async (operation: () => Promise<Response>): Promise<Response> => {
    try { return await operation(); }
    catch (err) {
      if (err instanceof ModelSelectionError) return error(400, err.code, err.message);
      if (err instanceof AccountError) {
        const status = err.code === "invalid_accounts" ? 400
          : err.code === "account_unconfigured" ? 409
          : err.code === "revision_conflict" ? 412
          : 503;
        return error(status, err.code, err.message);
      }
      if (isSwitchingDisabled(err)) return error(409, "switching_disabled", err.message);
      return error(503, "accounts_unavailable", "Account selection is unavailable; no defaults were substituted.");
    }
  };
  return {
    handle: (req: Request): Promise<Response> => guarded(async () => {
      if (req.method === "GET") {
        const selection = await runtime.read();
        return json(await view(selection, configDirectory, runtime.hasStaticFallback), 200, accountsETag(selection));
      }
      if (req.method === "PUT") {
        if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
          return error(415, "invalid_content_type", "Management writes require application/json.");
        }
        if (!proxySecret?.matches(req.headers.get(ADMIN_PROXY_HEADER))) {
          return error(403, "admin_proxy_required", "Management writes must come through the authenticated admin proxy.");
        }
        if (req.headers.get("x-devin-management") !== "1") {
          return error(403, "management_header_required", "Management writes require the explicit management header.");
        }
        const expected = req.headers.get("if-match");
        if (!expected) return error(428, "revision_required", "If-Match is required for account writes.");
        const selection = await runtime.update(await bodyText(req), expected);
        return json(await view(selection, configDirectory, runtime.hasStaticFallback), 200, accountsETag(selection));
      }
      return error(405, "method_not_allowed", "Use GET or PUT for account profiles.");
    }),
  };
}

function isSwitchingDisabled(value: unknown): value is Error {
  return value instanceof Error && (value as { code?: unknown }).code === "switching_disabled";
}