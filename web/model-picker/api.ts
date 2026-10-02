import type { AdminModel, ModelSelection, Snapshot } from "./state.js";
export class PickerApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface PickerApi { load(): Promise<Snapshot>; save(selection: ModelSelection, etag: string): Promise<{ selection: ModelSelection; etag: string }> }
const selectionPath = "/admin/api/model-selection";
function parseSelection(value: any): ModelSelection {
  if (!value || value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Array.isArray(value.enabledModels) || value.enabledModels.some((id: unknown) => typeof id !== "string")
    || !value.roles || ["default", "swe_worker"].some((role) => !value.roles[role] || typeof value.roles[role].modelId !== "string" || typeof value.roles[role].effort !== "string")
    || typeof value.includeFutureModels !== "boolean") throw new PickerApiError(0, "The gateway returned invalid selection data. Reload after checking the gateway.");
  return { schemaVersion: 2, revision: value.revision, enabledModels: [...value.enabledModels], roles: { default: { modelId: value.roles.default.modelId, effort: value.roles.default.effort }, swe_worker: { modelId: value.roles.swe_worker.modelId, effort: value.roles.swe_worker.effort } }, includeFutureModels: value.includeFutureModels };
}
export function createPickerApi(send: typeof fetch = fetch): PickerApi {
  async function json(path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await send(path, { ...init, mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new PickerApiError(0, "The management gateway could not be reached. Check your SSH tunnel, then retry."); }
    if (!response.ok) throw new PickerApiError(response.status, response.status === 412
      ? "Another client changed the selection. Your draft was not saved. Reload the latest state before editing again."
      : `The gateway rejected this request (HTTP ${response.status}). Your draft has not been discarded.`);
    try { return { body: await response.json(), response }; }
    catch { throw new PickerApiError(0, "The gateway returned invalid JSON. Reload after checking the gateway."); }
  }
  function selectionResult(result: { body: unknown; response: Response }) {
    const selection = parseSelection(result.body);
    const etag = result.response.headers.get("etag");
    if (etag !== `"model-selection-v2-${selection.revision}"`) throw new PickerApiError(0, "The gateway returned an invalid revision ETag. Reload before saving.");
    return { selection, etag };
  }
  return {
    async load() {
      const [catalog, saved] = await Promise.all([json("/admin/api/models"), json(selectionPath)]);
      const selection = selectionResult(saved);
      if (catalog.body.source !== "remote" || catalog.body.selectionRevision !== selection.selection.revision || !Array.isArray(catalog.body.models)) {
        throw new PickerApiError(0, "Selection changed while loading, or discovery is unavailable. Reload to obtain a consistent view.");
      }
      const models = catalog.body.models as AdminModel[];
      if (models.some((model) => !model || typeof model.id !== "string" || typeof model.displayName !== "string"
        || typeof model.available !== "boolean" || !model.codex || !["tested", "untested", "cannot_export"].includes(model.codex.status))) {
        throw new PickerApiError(0, "The gateway returned invalid model metadata. Reload after checking the gateway.");
      }
      return { ...selection, models };
    },
    async save(selection, etag) {
      return selectionResult(await json(selectionPath, { method: "PUT", headers: { "content-type": "application/json", "x-devin-management": "1", "if-match": etag }, body: JSON.stringify(selection) }));
    },
  };
}
