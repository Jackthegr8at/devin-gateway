import type { DiscoveredModelMetadata } from "../devin.js";
import { adminModels, codexSelectionManifest, validateDiscoveredRoles } from "./model-catalog.js";
import { projectModelFamilies } from "../model-families.js";
import { MAX_SELECTION_BYTES, ModelSelectionError, selectionETag, validateModelSelection } from "./model-selection.js";
import type { ModelSelectionStore } from "./model-selection-store.js";

export const CODEX_SELECTION_PATH = "/gateway/api/codex-selection";
export interface ModelSelectionRoutesOptions {
  store: ModelSelectionStore;
  discover: (request: Request) => Promise<DiscoveredModelMetadata[]>;
}
const json = (body: unknown, status = 200, etag?: string): Response => Response.json(body, {
  status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...(etag ? { etag } : {}) },
});
const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

async function selectionBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new ModelSelectionError("invalid_selection", "A JSON model selection is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_SELECTION_BYTES) throw new ModelSelectionError("invalid_selection", "Model selection exceeds the request limit.");
      chunks.push(next.value);
    }
    if (timedOut) throw new ModelSelectionError("invalid_selection", "Model selection body timed out.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (err) {
    if (err instanceof ModelSelectionError) throw err;
    throw new ModelSelectionError("invalid_selection", "A valid JSON model selection is required.");
  } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createModelSelectionRoutes(options: ModelSelectionRoutesOptions) {
  const guarded = async (operation: () => Promise<Response>): Promise<Response> => {
    try { return await operation(); }
    catch (err) {
      if (err instanceof ModelSelectionError) {
        const status = err.code === "invalid_selection" ? 400 : err.code === "revision_conflict" ? 412 : err.code === "role_unavailable" ? 409 : 503;
        return error(status, err.code, err.message);
      }
      // Never reflect upstream/filesystem exceptions or run general raw tracing.
      return error(503, "selection_unavailable", "Model selection is unavailable; no defaults were substituted.");
    }
  };
  const discover = async (req: Request): Promise<DiscoveredModelMetadata[]> => {
    try {
      const models = await options.discover(req);
      if (!models.length) throw new Error("empty discovery");
      return models;
    } catch { throw new ModelSelectionError("discovery_unavailable", "Devin model discovery is unavailable; no local catalog was substituted."); }
  };
  return {
    /** Called only on the separate management listener; strict Host/Origin checks precede this. */
    admin: (req: Request): Promise<Response> => guarded(async () => {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/admin/api/model-selection") {
        const selection = await options.store.read();
        return json(selection, 200, selectionETag(selection));
      }
      if (req.method === "GET" && path === "/admin/api/models") {
        const selection = await options.store.read();
        const discovered = await discover(req);
        return json({ source: "remote", selectionRevision: selection.revision, models: adminModels(discovered, selection), families: projectModelFamilies(discovered) });
      }
      if (req.method === "PUT" && path === "/admin/api/model-selection") {
        if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
          return error(415, "invalid_content_type", "Management writes require application/json.");
        }
        if (req.headers.get("x-devin-management") !== "1") return error(403, "management_header_required", "Management writes require the explicit management header.");
        const expected = req.headers.get("if-match");
        if (!expected) return error(428, "revision_required", "If-Match is required for model selection writes.");
        const proposed = validateModelSelection(await selectionBody(req));
        const available = await discover(req);
        validateDiscoveredRoles(proposed, available);
        if (proposed.includeFutureModels) {
          const models = available;
          if (models.some((model) => !proposed.enabledModels.includes(model.id))) {
            return error(400, "invalid_future_selection", "Include future models requires selecting all currently discovered models.");
          }
        }
        const selection = await options.store.update(proposed, expected);
        return json(selection, 200, selectionETag(selection));
      }
      return error(404, "not_found", "Management endpoint not found.");
    }),
    codex: (req: Request): Promise<Response> => guarded(async () => {
      if (req.method !== "GET" || new URL(req.url).pathname !== CODEX_SELECTION_PATH) return error(405, "method_not_allowed", "This endpoint is read-only.");
      const selection = await options.store.read();
      return json(codexSelectionManifest(selection, adminModels(await discover(req), selection)));
    }),
  };
}

/** No inference CORS, forwarded-host trust, browser cross-origin writes, or UI. */
export function managementRequestAllowed(req: Request, port: number, publicPort?: number): boolean {
  const host = req.headers.get("host");
  const ports = publicPort === undefined ? [port] : [port, publicPort];
  if (!ports.some((allowed) => host === `127.0.0.1:${allowed}` || host === `localhost:${allowed}`)) return false;
  const origin = req.headers.get("origin");
  if (origin && origin !== `http://${host}`) return false;
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}
