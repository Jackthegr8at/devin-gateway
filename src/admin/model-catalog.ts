import type { DiscoveredModelMetadata } from "../devin.js";
import { CODEX_PROFILE_VERSION, getCodexModelProfile, type CodexModelProfile } from "./codex-model-profiles.js";
import { isModelId, ModelSelectionError, selectionETag, type ModelSelection } from "./model-selection.js";
import { FAMILY_EFFORTS, inspectModelFamilies, type ModelFamily, type FamilyEffort } from "../model-families.js";

export interface AdminModel {
  id: string; displayName: string; available: boolean; enabled: boolean;
  contextWindow: number | null; maxOutputTokens: number | null; supportsImages: boolean | null;
  upstreamThinking: boolean | null; metadataProvenance: DiscoveredModelMetadata["metadataProvenance"] | null;
  codex: { status: "tested" | "untested" | "cannot_export"; tested: boolean; exclusionReason: string | null;
    profile: CodexModelProfile | null; exportEligible: boolean };
  family?: { id: string; displayName: string; effort: FamilyEffort; provenance: ModelFamily["provenance"]; upstreamDefaultEffort: FamilyEffort | null };
}

/** Trusted upstream facts, not suffix heuristics or successful-inference approval records. */
export function adminModels(discovered: readonly DiscoveredModelMetadata[], selection: ModelSelection): AdminModel[] {
  const { families, excluded } = inspectModelFamilies(discovered);
  const ids = new Set<string>();
  const rows: AdminModel[] = discovered.map((model) => {
    if (!isModelId(model.id) || ids.has(model.id) || typeof model.name !== "string" || model.name.length > 512) {
      throw new ModelSelectionError("discovery_unavailable", "Model discovery identifiers are invalid.");
    }
    ids.add(model.id);
    const p = model.metadataProvenance;
    const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
    const contextWindow = p.contextWindow === "upstream" && positive(model.contextWindow) ? model.contextWindow : null;
    const maxOutputTokens = p.maxOutputTokens === "upstream" && positive(model.maxTokens) ? model.maxTokens : null;
    const supportsImages = p.imageSupport === "upstream" && typeof model.supportsImages === "boolean" ? model.supportsImages : null;
    const family = families.find((entry) => Object.values(entry.variants).includes(model.id));
    const effort = family ? FAMILY_EFFORTS.find((effort) => family.variants[effort] === model.id)!
      : !model.modelFamilyMetadata ? getCodexModelProfile(model.id)?.defaultReasoningEffort
        ?? (p.upstreamThinking === "upstream" && model.upstreamThinking === false ? "off" : undefined) : undefined;
    const reason = excluded.get(model.id) ?? (contextWindow === null || maxOutputTokens === null || supportsImages === null ? "incomplete_metadata" : !effort ? "missing_effort_metadata" : null);
    const profile: CodexModelProfile | null = !reason && effort ? {
      modelId: model.id, defaultReasoningEffort: effort,
      supportedReasoningEfforts: [{ effort, description: effort === "off" ? "Explicit non-thinking upstream route." : `Upstream ${effort} reasoning variant.` }],
      multiAgentVersion: "v1", shellType: "shell_command",
    } : null;
    const tested = !!getCodexModelProfile(model.id);
    return { id: model.id, displayName: model.name, available: true, enabled: selection.includeFutureModels || selection.enabledModels.includes(model.id),
      contextWindow, maxOutputTokens, supportsImages, upstreamThinking: model.upstreamThinking, metadataProvenance: {
        id: p.id, displayName: p.displayName, contextWindow: p.contextWindow, maxOutputTokens: p.maxOutputTokens,
        imageSupport: p.imageSupport, upstreamThinking: p.upstreamThinking, reasoning: p.reasoning,
      },
      codex: { status: reason ? "cannot_export" : tested ? "tested" : "untested", tested, exclusionReason: reason, profile, exportEligible: !!profile },
      ...(family ? { family: { id: family.id, displayName: family.displayName, effort: effort!, provenance: family.provenance, upstreamDefaultEffort: family.upstreamDefaultEffort } } : {}) };
  });
  for (const id of selection.enabledModels) if (!ids.has(id)) rows.push({ id, displayName: id, available: false, enabled: true,
    contextWindow: null, maxOutputTokens: null, supportsImages: null, upstreamThinking: null, metadataProvenance: null,
    codex: { status: "cannot_export", tested: !!getCodexModelProfile(id), exclusionReason: "unavailable", profile: null, exportEligible: false } });
  return rows;
}

const codexEffort = (effort: string) => effort === "off" ? "none" : effort;
function roleRow(selection: ModelSelection, rows: readonly AdminModel[], name: "default" | "swe_worker") {
  const role = selection.roles[name];
  const matches = rows.filter((row) => row.enabled && row.available && row.codex.exportEligible
    && (row.id === role.modelId || row.family?.id === role.modelId)
    && row.codex.profile?.defaultReasoningEffort === role.effort);
  if (matches.length !== 1) throw new ModelSelectionError("role_unavailable", "Selected role is unavailable or structurally incompatible; no model was substituted.");
  return matches[0];
}

/** Only enabled compatible variants; strict data-only projection. No inference occurs. */
export function codexSelectionManifest(selection: ModelSelection, rows: readonly AdminModel[]) {
  const groups = new Map<string, AdminModel[]>();
  for (const row of rows.filter((row) => row.enabled && row.available && row.codex.exportEligible)) {
    const id = row.family?.id ?? row.id;
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  const models = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([id, members]) => {
    members.sort((a, b) => FAMILY_EFFORTS.indexOf(a.codex.profile!.defaultReasoningEffort) - FAMILY_EFFORTS.indexOf(b.codex.profile!.defaultReasoningEffort));
    const routing = Object.fromEntries(members.map((row) => [codexEffort(row.codex.profile!.defaultReasoningEffort), row.id]));
    if (Object.keys(routing).length !== members.length) throw new ModelSelectionError("discovery_unavailable", "Ambiguous selected effort routes.");
    const worker = members.find((row) => row.id === selection.roles.swe_worker.modelId || row.family?.id === selection.roles.swe_worker.modelId && row.family?.effort === selection.roles.swe_worker.effort);
    const parent = members.find((row) => row.id === selection.roles.default.modelId || row.family?.id === selection.roles.default.modelId && row.family?.effort === selection.roles.default.effort);
    const first = worker ?? parent ?? members[0]; // Deterministic, enabled-only default; saved roles remain authoritative.
    return { id, displayName: first.family?.displayName ?? first.displayName,
      contextWindow: Math.min(...members.map((row) => row.contextWindow!)), maxOutputTokens: Math.min(...members.map((row) => row.maxOutputTokens!)),
      inputModalities: members.every((row) => row.supportsImages) ? ["text", "image"] : ["text"],
      defaultReasoningEffort: codexEffort(first.codex.profile!.defaultReasoningEffort),
      supportedReasoningEfforts: members.map((row) => ({ effort: codexEffort(row.codex.profile!.defaultReasoningEffort), description: row.codex.profile!.supportedReasoningEfforts[0].description })),
      multiAgentVersion: "v1", shellType: "shell_command", routing,
      metadataProvenance: first.metadataProvenance, familyProvenance: first.family?.provenance ?? null,
      upstreamDefaultEffort: first.family?.upstreamDefaultEffort ?? null };
  });
  const roles = Object.fromEntries((["default", "swe_worker"] as const).map((name) => {
    const row = roleRow(selection, rows, name);
    return [name, { modelId: row.family?.id ?? row.id, reasoningEffort: codexEffort(selection.roles[name].effort), concreteModelId: row.id }];
  }));
  return { schemaVersion: 2, revision: selection.revision, selectionETag: selectionETag(selection),
    compatibilityProfileVersion: CODEX_PROFILE_VERSION, includeFutureModels: selection.includeFutureModels, models, roles,
    excludedModels: rows.filter((row) => row.enabled && !row.codex.exportEligible).map((row) => ({ id: row.id, reason: row.codex.exclusionReason! })) };
}
export function validateDiscoveredRoles(selection: ModelSelection, discovered: readonly DiscoveredModelMetadata[]): void {
  const rows = adminModels(discovered, selection);
  roleRow(selection, rows, "default"); roleRow(selection, rows, "swe_worker");
}
