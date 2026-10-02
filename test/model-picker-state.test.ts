import { describe, expect, test } from "bun:test";
import { initialModelSelection } from "../src/admin/model-selection.ts";
import { getCodexModelProfile } from "../src/admin/codex-model-profiles.ts";
import { allDiscoveredEnabled, bulkSelection, createDraft, draftErrors, draftsEqual, matchingModels, roleEligible, type AdminModel } from "../web/model-picker/state.ts";
import { modelCategories, modelCategoryBucket } from "../web/model-picker/model-categories.ts";
import { getModelPageWindow } from "../web/model-picker/model-pagination.ts";
import { formatModelDisplayName } from "../web/model-picker/model-display.ts";
import { compareEfforts, EFFORT_ORDER, orderFamilyVariants } from "../web/model-picker/effort-order.ts";

export function fixtureModel(id: string, displayName = id, available = true): AdminModel {
  const profile = getCodexModelProfile(id) ?? null;
  return { id, displayName, available, enabled: !!profile, ...(id === "swe-2-medium" ? { family: { id: "swe-2", displayName: "SWE-2", effort: "medium", provenance: "reviewed_fallback", upstreamDefaultEffort: null } } : {}), contextWindow: available ? 200_000 : null,
    maxOutputTokens: available ? 64_000 : null, supportsImages: available ? false : null, upstreamThinking: available ? true : null,
    metadataProvenance: available ? { id: "upstream" } : null,
    codex: { status: profile ? "validated" : "unvalidated", profile, exportEligible: available && !!profile } };
}
export function fixtureModels() {
  return [fixtureModel("glm-5-3-flash-low", "GLM-5.3 Flash Low"), fixtureModel("swe-2-medium", "SWE-2 Medium"),
    ...Array.from({ length: 520 }, (_, i) => fixtureModel(`${i % 3 === 0 ? "swe" : i % 3 === 1 ? "fusion" : "other"}-fixture-${i}`, `Named Alpha ${i}`)),
    fixtureModel("saved-removed", "Saved unavailable model", false)];
}
describe("Cody-adapted display helpers", () => {
  test("one display ordering preserves missing efforts and input immutability", () => {
    expect(EFFORT_ORDER).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(["max", "high", "low"].sort(compareEfforts)).toEqual(["low", "high", "max"]);
    expect(["medium"].sort(compareEfforts)).toEqual(["medium"]);
    expect(["high", "off"].sort(compareEfforts)).toEqual(["off", "high"]);
    const models = [
      { id: "high-member", family: { id: "family", effort: "high" } },
      { id: "standalone" }, { id: "low-member", family: { id: "family", effort: "low" } },
    ];
    expect(orderFamilyVariants(models).map((model) => model.id)).toEqual(["low-member", "high-member", "standalone"]);
    expect(models.map((model) => model.id)).toEqual(["high-member", "standalone", "low-member"]);
  });
  test("categories are exactly display buckets; overlap belongs to Fusion", () => {
    expect(modelCategories({ id: "swe-2-fusion", displayName: "SWE Fusion" })).toEqual(["SWE", "Fusion"]);
    expect(modelCategoryBucket({ id: "swe-2-fusion", displayName: "SWE Fusion" })).toBe("Fusion");
    expect(modelCategories({ id: "sweeper", displayName: "Standard" })).toEqual(["Other"]);
    expect(modelCategories({ id: "unknown-low", displayName: "Ordinary" })).toEqual(["Other"]);
  });
  test("display formatting does not lose GPT variant identity or alter IDs", () => {
    expect(formatModelDisplayName("gpt-6-luna-max", "GPT 6 Luna")).toBe("GPT-6 Luna Max");
    expect(formatModelDisplayName("exact/unknown", "Catalog label")).toBe("Catalog label");
  });
  test("500+ models paginate into at most 60 rows and clamp stale pages", () => {
    const page = getModelPageWindow(523, 999);
    expect(page).toEqual({ pageIndex: 8, pageCount: 9, start: 480, end: 523 });
    for (let i = 0; i < 9; i++) { const window = getModelPageWindow(523, i); expect(window.end - window.start).toBeLessThanOrEqual(60); }
    expect(getModelPageWindow(0, 3).pageCount).toBe(1);
    expect(getModelPageWindow(100, 0, 0.5).end).toBe(1);
  });
});
describe("single immutable selection draft", () => {
  const models = fixtureModels();
  test("opaque concrete IDs are searchable/filterable through authoritative family labels", () => {
    const opaque = { ...fixtureModel("opaque-wire-id", "Catalog member"), family: { id: "swe-2", displayName: "SWE-2", effort: "high", provenance: "upstream_family_metadata", upstreamDefaultEffort: "high" } };
    expect(matchingModels([opaque], initialModelSelection(), { query: "SWE-2", categories: new Set(["SWE"]), enabledOnly: false })).toEqual([opaque]);
    expect(matchingModels([opaque], initialModelSelection(), { query: "high", categories: new Set(), enabledOnly: false })).toEqual([opaque]);
  });
  test("case-insensitive ID/name search and category multi-filter union", () => {
    const draft = createDraft(initialModelSelection(), models);
    expect(matchingModels(models, draft, { query: "ALPHA 101", enabledOnly: false, categories: new Set() }).map((model) => model.id)).toEqual(["other-fixture-101"]);
    expect(matchingModels(models, draft, { query: "SWE-2-MEDIUM", enabledOnly: false, categories: new Set() }).length).toBe(1);
    const selected = matchingModels(models, draft, { query: "", enabledOnly: false, categories: new Set(["SWE", "Fusion"]) });
    expect(selected.length).toBeGreaterThan(300);
    expect(selected.every((model) => ["SWE", "Fusion"].includes(modelCategoryBucket(model)))).toBe(true);
  });
  test("enabled-only reads draft; bulk changes all matching pages without touching baseline", () => {
    const saved = initialModelSelection();
    let draft = createDraft(saved, models);
    const filters = { query: "fixture", enabledOnly: false, categories: new Set<"SWE">(["SWE"]) };
    const matches = matchingModels(models, draft, filters);
    draft = bulkSelection(draft, matches.map((model) => model.id), true);
    expect(matches.length).toBeGreaterThan(60);
    expect(matchingModels(models, draft, { ...filters, enabledOnly: true }).length).toBe(matches.length);
    expect(saved.enabledModels).toEqual(["glm-5-3-flash-low", "swe-2-medium"]);
    draft = bulkSelection(draft, matches.map((model) => model.id), false);
    expect(matchingModels(models, draft, { ...filters, enabledOnly: true })).toHaveLength(0);
    expect(draftsEqual(draft, createDraft(saved, models))).toBe(true);
  });
  test("only enabled, available, complete reviewed profiles can receive roles", () => {
    const draft = createDraft(initialModelSelection(), models);
    expect(roleEligible(models[0], draft)).toBe(true);
    expect(roleEligible(models[1], draft)).toBe(true);
    const unknown = { ...draft, enabledModels: [...draft.enabledModels, models[2].id] };
    expect(roleEligible(models[2], unknown)).toBe(false);
    expect(roleEligible(fixtureModel("swe-2-medium", "SWE", false), draft)).toBe(false);
    expect(roleEligible({ ...models[1], codex: { ...models[1].codex, exportEligible: false } }, draft)).toBe(false);
  });
  test("disabling an assigned model retains exact role and blocks save until reassigned/re-enabled", () => {
    const draft = bulkSelection(initialModelSelection(), ["swe-2-medium"], false);
    expect(draft.roles.swe_worker).toEqual({ modelId: "swe-2", effort: "medium" });
    expect(draftErrors(draft, models).join(" ")).toContain("swe_worker");
    expect(draftErrors({ ...draft, roles: { ...draft.roles, swe_worker: { modelId: "glm-5-3-flash-low", effort: "low" } } }, models)).toEqual([]);
    expect(draftErrors(bulkSelection(draft, ["swe-2-medium"], true), models)).toEqual([]);
  });
  test("unvalidated and unavailable models can remain enabled, but never substitute a role", () => {
    const draft = bulkSelection(initialModelSelection(), [models[2].id, "saved-removed"], true);
    expect(draftErrors(draft, models)).toEqual([]);
    expect(draftErrors({ ...draft, roles: { ...draft.roles, default: { modelId: "saved-removed", effort: "low" } } }, models).length).toBe(1);
  });
  test("future inclusion requires explicit all-model selection and disable exits future mode", () => {
    let draft = createDraft(initialModelSelection(), models);
    expect(allDiscoveredEnabled(draft, models)).toBe(false);
    expect(draftErrors({ ...draft, includeFutureModels: true }, models).join(" ")).toContain("every discovered");
    draft = { ...bulkSelection(draft, models.filter((model) => model.available).map((model) => model.id), true), includeFutureModels: true };
    expect(draftErrors(draft, models)).toEqual([]);
    const refreshed = createDraft(draft, [...models, fixtureModel("new-upstream")]);
    expect(refreshed.enabledModels).toContain("new-upstream");
    expect(refreshed.roles).toEqual(draft.roles);
    expect(bulkSelection(refreshed, ["new-upstream"], false).includeFutureModels).toBe(false);
  });
});
