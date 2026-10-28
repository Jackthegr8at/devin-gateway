import { getCodexModelProfile } from "./codex-model-profiles.js";
import { FAMILY_EFFORTS, type FamilyEffort } from "../model-families.js";

export const MAX_SELECTION_BYTES = 256 * 1024;
export interface ModelSelection {
  schemaVersion: 2;
  revision: number;
  enabledModels: string[];
  roles: { default: ModelRole; swe_worker: ModelRole };
  includeFutureModels: boolean;
}
export interface ModelRole { modelId: string; effort: FamilyEffort }
export class ModelSelectionError extends Error {
  constructor(public readonly code: "invalid_selection" | "selection_unavailable" | "revision_conflict" | "discovery_unavailable" | "role_unavailable", message: string) { super(message); }
}
function invalid(): never {
  throw new ModelSelectionError("invalid_selection", "Invalid model selection configuration.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) invalid();
}
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}
/** Fresh allowlisted value, never the caller's object; no ID normalization. */
export function validateModelSelection(value: unknown): ModelSelection {
  const input = object(value);
  keys(input, ["schemaVersion", "revision", "enabledModels", "roles", "includeFutureModels"]);
  if (input.schemaVersion !== 2 || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1
    || typeof input.includeFutureModels !== "boolean" || !Array.isArray(input.enabledModels)
    || input.enabledModels.length > 2048 || input.enabledModels.some((id) => !isModelId(id))) invalid();
  const enabledModels = input.enabledModels as string[];
  if (new Set(enabledModels).size !== enabledModels.length) invalid();
  const roles = object(input.roles);
  keys(roles, ["default", "swe_worker"]);
  for (const role of ["default", "swe_worker"] as const) {
    const value = object(roles[role]);
    keys(value, ["modelId", "effort"]);
    if (!isModelId(value.modelId) || typeof value.effort !== "string") invalid();
    if (!FAMILY_EFFORTS.includes(value.effort as FamilyEffort) || !enabledModels.length) invalid();
    // Logical membership requires current authoritative discovery; save/export validates it.
  }
  const selection: ModelSelection = {
    schemaVersion: 2, revision: input.revision as number, enabledModels: [...enabledModels],
    roles: { default: { ...roles.default as ModelRole }, swe_worker: { ...roles.swe_worker as ModelRole } },
    includeFutureModels: input.includeFutureModels as boolean,
  };
  if (Buffer.byteLength(JSON.stringify(selection), "utf8") + 1 > MAX_SELECTION_BYTES) invalid();
  return selection;
}
export function initialModelSelection(): ModelSelection {
  return {
    schemaVersion: 2, revision: 1, enabledModels: ["glm-5-3-flash-low", "swe-2-medium"],
    roles: { default: { modelId: "glm-5-3-flash-low", effort: "low" }, swe_worker: { modelId: "swe-2", effort: "medium" } }, includeFutureModels: false,
  };
}
export function selectionETag(selection: ModelSelection): string { return `"model-selection-v2-${selection.revision}"`; }
/** Reject invalid v1 data before translating it; no upstream default is adopted. */
export function migrateModelSelection(value: unknown): ModelSelection {
  const input = object(value);
  if (input.schemaVersion === 2) return validateModelSelection(input);
  if (input.schemaVersion !== 1) invalid();
  const roles = object(input.roles);
  keys(roles, ["default", "swe_worker"]);
  const migratedRoles = Object.fromEntries((["default", "swe_worker"] as const).map((role) => {
    const id = roles[role];
    if (!isModelId(id)) invalid();
    if (!Array.isArray(input.enabledModels) || !input.enabledModels.includes(id)) invalid();
    const profile = getCodexModelProfile(id);
    if (!profile) invalid();
    return [role, { modelId: id === "swe-2-medium" ? "swe-2" : id, effort: profile.defaultReasoningEffort }];
  }));
  // Preserve validation of all original top-level fields, enabled IDs and role membership.
  return validateModelSelection({ ...input, schemaVersion: 2, roles: migratedRoles });
}
