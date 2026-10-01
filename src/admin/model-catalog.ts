import type { DiscoveredModelMetadata } from "../devin.js";
import { CODEX_PROFILE_VERSION, getCodexModelProfile } from "./codex-model-profiles.js";
import { isModelId, ModelSelectionError, selectionETag, type ModelSelection } from "./model-selection.js";
import { projectModelFamilies, resolveFamilyModelId, REVIEWED_FAMILY_ROUTES, type ModelFamily, type FamilyEffort } from "../model-families.js";

export interface AdminModel {
  id: string;
  displayName: string;
  available: boolean;
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsImages: boolean | null;
  upstreamThinking: boolean | null;
  metadataProvenance: DiscoveredModelMetadata["metadataProvenance"] | null;
  codex: { status: "validated" | "unvalidated"; profile: ReturnType<typeof getCodexModelProfile> | null; exportEligible: boolean };
  family?: { id: string; displayName: string; effort: FamilyEffort; provenance: ModelFamily["provenance"]; upstreamDefaultEffort: FamilyEffort | null };
}

/** No cache/fallback hides discovery failures. Missing selected IDs remain visible. */
export function adminModels(discovered: readonly DiscoveredModelMetadata[], selection: ModelSelection): AdminModel[] {
  const families = projectModelFamilies(discovered);
  const ids = new Set<string>();
  const rows: AdminModel[] = [];
  for (const model of discovered) {
    if (!isModelId(model.id) || ids.has(model.id) || typeof model.name !== "string"
      || model.name.length > 512 || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
      || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
      throw new ModelSelectionError("discovery_unavailable", "Model discovery metadata is invalid.");
    }
    ids.add(model.id);
    const profile = getCodexModelProfile(model.id) ?? null;
    const provenance = model.metadataProvenance;
    const contextWindow = provenance.contextWindow === "upstream" ? model.contextWindow : null;
    const maxOutputTokens = provenance.maxOutputTokens === "upstream" ? model.maxTokens : null;
    const supportsImages = provenance.imageSupport === "upstream" ? model.supportsImages : null;
    rows.push({
      id: model.id, displayName: model.name, available: true,
      enabled: selection.includeFutureModels || selection.enabledModels.includes(model.id),
      contextWindow, maxOutputTokens, supportsImages, upstreamThinking: model.upstreamThinking,
      metadataProvenance: {
        id: provenance.id, displayName: provenance.displayName, contextWindow: provenance.contextWindow,
        maxOutputTokens: provenance.maxOutputTokens, imageSupport: provenance.imageSupport,
        upstreamThinking: provenance.upstreamThinking, reasoning: provenance.reasoning,
      },
      codex: { status: profile ? "validated" : "unvalidated", profile, exportEligible: !!profile && contextWindow !== null && maxOutputTokens !== null && supportsImages !== null },
    });
  }
  for (const id of selection.enabledModels) {
    if (ids.has(id)) continue;
    const profile = getCodexModelProfile(id) ?? null;
    rows.push({
      id, displayName: id, available: false, enabled: true,
      contextWindow: null, maxOutputTokens: null, supportsImages: null, upstreamThinking: null,
      metadataProvenance: null,
      codex: { status: profile ? "validated" : "unvalidated", profile, exportEligible: false },
    });
  }
  for (const row of rows) {
    const family = families.find((entry) => Object.values(entry.variants).includes(row.id));
    if (family) row.family = { id: family.id, displayName: family.displayName,
      effort: Object.keys(family.variants).find((effort) => family.variants[effort as FamilyEffort] === row.id) as FamilyEffort,
      provenance: family.provenance, upstreamDefaultEffort: family.upstreamDefaultEffort };
    else if (!row.available) for (const [id, routes] of Object.entries(REVIEWED_FAMILY_ROUTES)) {
      const effort = Object.keys(routes).find((effort) => routes[effort as FamilyEffort] === row.id) as FamilyEffort | undefined;
      if (effort) row.family = { id, displayName: "SWE-2", effort, provenance: "reviewed_fallback", upstreamDefaultEffort: families.find((entry) => entry.id === id)?.upstreamDefaultEffort ?? null };
    }
  }
  return rows;
}

/** Allowlisted manifest, not a complete Codex catalog or downloadable TOML/script. */
export function codexSelectionManifest(selection: ModelSelection, rows: readonly AdminModel[]) {
  const concrete = rows.filter((row) => row.enabled && row.codex.exportEligible).map((row) => ({
    id: row.id, displayName: row.displayName, contextWindow: row.contextWindow!, maxOutputTokens: row.maxOutputTokens!,
    inputModalities: row.supportsImages ? ["text", "image"] : ["text"],
    defaultReasoningEffort: row.codex.profile!.defaultReasoningEffort,
    supportedReasoningEfforts: row.codex.profile!.supportedReasoningEfforts,
    multiAgentVersion: row.codex.profile!.multiAgentVersion, shellType: row.codex.profile!.shellType,
  }));
  const models = concrete.map((model) => {
    const row = rows.find((row) => row.id === model.id)!;
    const useConcreteId = Object.values(selection.roles).some((role) => role.modelId === model.id);
    return { ...model, id: useConcreteId ? model.id : row.family?.id ?? model.id, displayName: row.family?.displayName ?? model.displayName,
      routing: { [model.defaultReasoningEffort]: model.id },
      metadataProvenance: row.metadataProvenance, familyProvenance: row.family?.provenance ?? null,
      upstreamDefaultEffort: row.family?.upstreamDefaultEffort ?? null };
  });
  const roles = Object.fromEntries((["default", "swe_worker"] as const).map((role) => {
    const assignment = selection.roles[role];
    const model = models.find((model) => model.id === assignment.modelId && Object.hasOwn(model.routing, assignment.effort));
    if (!model) throw new ModelSelectionError("role_unavailable", "A role model is unavailable or lacks validated upstream metadata; no model was substituted.");
    return [role, { modelId: model.id, reasoningEffort: assignment.effort, concreteModelId: model.routing[assignment.effort] }];
  }));
  return {
    schemaVersion: 2, revision: selection.revision, selectionETag: selectionETag(selection),
    compatibilityProfileVersion: CODEX_PROFILE_VERSION, includeFutureModels: selection.includeFutureModels,
    models, roles,
    excludedModels: rows.filter((row) => row.enabled && !row.codex.exportEligible).map((row) => ({
      id: row.id, reason: !row.available ? "unavailable" : !row.codex.profile ? "unvalidated_profile" : "incomplete_metadata",
    })),
  };
}

/** Validate available reviewed role routes against current authoritative discovery, not fallback guesses. */
export function validateDiscoveredRoles(selection: ModelSelection, discovered: readonly DiscoveredModelMetadata[]): void {
  const families = projectModelFamilies(discovered);
  const rows = adminModels(discovered, selection);
  for (const role of Object.values(selection.roles)) {
    let concrete: string;
    try { concrete = resolveFamilyModelId(role.modelId, role.effort, families); }
    catch { throw new ModelSelectionError("role_unavailable", "Selected role route is unavailable; no model was substituted."); }
    const row = rows.find((entry) => entry.id === concrete);
    if (!row?.enabled || !row.available || !row.codex.exportEligible || !row.codex.profile?.supportedReasoningEfforts.some((entry) => entry.effort === role.effort)) {
      throw new ModelSelectionError("role_unavailable", "Selected role route is unavailable or unvalidated; no model was substituted.");
    }
  }
}
