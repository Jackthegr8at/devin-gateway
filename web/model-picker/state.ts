import type { AdminModel, ModelSelection } from "./types.js";
import { modelMatchesCategories, type ModelCategory } from "./model-categories.js";
export type { AdminModel, ModelSelection };
export interface Snapshot { models: AdminModel[]; selection: ModelSelection; etag: string }
export interface Filters { query: string; categories: ReadonlySet<ModelCategory>; enabledOnly: boolean }
export const ROLES = ["default", "swe_worker"] as const;
export function createDraft(selection: ModelSelection, models: readonly AdminModel[]): ModelSelection {
  return { ...selection, roles: { ...selection.roles }, enabledModels: [...new Set([
    ...selection.enabledModels, ...(selection.includeFutureModels ? models.filter((model) => model.available).map((model) => model.id) : []),
  ])] };
}
export function matchingModels(models: readonly AdminModel[], draft: ModelSelection, filters: Filters): AdminModel[] {
  const enabled = new Set(draft.enabledModels);
  const needle = filters.query.trim().toLowerCase();
  return models.filter((model) => (!filters.enabledOnly || enabled.has(model.id))
    && modelMatchesCategories(model, filters.categories)
    && (!needle || model.id.toLowerCase().includes(needle) || model.displayName.toLowerCase().includes(needle)));
}
export function allDiscoveredEnabled(draft: ModelSelection, models: readonly AdminModel[]): boolean {
  const discovered = models.filter((model) => model.available);
  const enabled = new Set(draft.enabledModels);
  return discovered.length > 0 && discovered.every((model) => enabled.has(model.id));
}
export function bulkSelection(draft: ModelSelection, ids: readonly string[], enabled: boolean): ModelSelection {
  const next = new Set(draft.enabledModels);
  for (const id of ids) if (enabled) next.add(id); else next.delete(id);
  return { ...draft, enabledModels: [...next], includeFutureModels: enabled ? draft.includeFutureModels : false };
}
export function roleEligible(model: AdminModel, draft: ModelSelection): boolean {
  return draft.enabledModels.includes(model.id) && model.available && model.codex.status === "validated"
    && model.codex.profile !== null && model.codex.exportEligible;
}
export function draftErrors(draft: ModelSelection, models: readonly AdminModel[]): string[] {
  const errors: string[] = [];
  for (const role of ROLES) {
    const model = models.find((entry) => entry.id === draft.roles[role]);
    if (!model || !roleEligible(model, draft)) errors.push(`${role === "default" ? "Default / parent" : role}: re-enable its model or assign an enabled, available reviewed model before saving.`);
  }
  if (draft.includeFutureModels && !allDiscoveredEnabled(draft, models)) errors.push("Enable every discovered model before including future models.");
  return errors;
}
export function draftsEqual(a: ModelSelection, b: ModelSelection): boolean {
  return a.revision === b.revision && a.includeFutureModels === b.includeFutureModels
    && ROLES.every((role) => a.roles[role] === b.roles[role])
    && a.enabledModels.length === b.enabledModels.length && a.enabledModels.every((id) => b.enabledModels.includes(id));
}
