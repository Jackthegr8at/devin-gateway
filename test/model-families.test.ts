import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModelMetadata, discoverModels } from "../src/devin.ts";
import { projectModelFamilies, resolveFamilyModelId } from "../src/model-families.ts";
import { migrateModelSelection, initialModelSelection, validateModelSelection, selectionETag } from "../src/admin/model-selection.ts";
import { ModelSelectionStore } from "../src/admin/model-selection-store.ts";
import { adminModels, codexSelectionManifest, validateDiscoveredRoles } from "../src/admin/model-catalog.ts";
import { getCodexModelProfile } from "../src/admin/codex-model-profiles.ts";

import { familyFixture, familyPayload } from "./fixtures/model-families.ts";
describe("authoritative family metadata and deterministic effort routing", () => {
  test("decodes field 30 nested entries and both default markers without changing legacy discovery", async () => {
    const fixture = familyFixture("swe-2-high", "SWE-2", "high", { fast: true }, true);
    fixture.isDefaultModelInFamily = true;
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(familyPayload([fixture])) });
    try {
      const [model] = await discoverModelMetadata("synthetic-family-token", backend.url.origin);
      expect(model.modelFamilyMetadata).toEqual(fixture.modelFamilyMetadata);
      expect(model.isDefaultModelInFamily).toBe(true);
      expect((await discoverModels("synthetic-family-token", backend.url.origin))[0]).not.toHaveProperty("modelFamilyMetadata");
    } finally { await backend.stop(true); }
  });
  test("SWE projection is stable, mandatory, exact, and upstream High does not change role Medium", () => {
    const models = [familyFixture("swe-2-medium", "SWE-2", "medium"), familyFixture("swe-2-high", "SWE-2", "high", {}, true), familyFixture("swe-2-max", "SWE-2", "max")];
    const families = projectModelFamilies(models);
    expect(projectModelFamilies([...models].reverse())).toEqual(families);
    expect(families[0]).toMatchObject({ id: "swe-2", upstreamDefaultEffort: "high", supportsOff: false, variants: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" } });
    for (const effort of [undefined, "off", "low", "Medium"]) expect(() => resolveFamilyModelId("swe-2", effort, families)).toThrow("explicit supported");
    expect(resolveFamilyModelId("swe-2", "medium", families)).toBe("swe-2-medium");
    expect(resolveFamilyModelId("swe-2", "high", families)).toBe("swe-2-high");
    expect(resolveFamilyModelId("swe-2-medium", "high", families)).toBe("swe-2-medium");
    expect(initialModelSelection().roles.swe_worker.effort).toBe("medium");
  });
  test("Sol standard/Fast/1M stay separate; mappings come from metadata, not suffix inference", () => {
    const models = [familyFixture("opaque-a", "GPT-6.1 Sol", "low"), familyFixture("opaque-b", "GPT-6.1 Sol", "medium", {}, true),
      familyFixture("opaque-c", "GPT-6.1 Sol", "max", { fast: true }), familyFixture("opaque-d", "GPT-6.1 Sol", "high", { context1m: true }),
      familyFixture("opaque-e", "GPT-6.1 Sol", "xhigh", { fast: true, context1m: true }), familyFixture("unknown-high")];
    const families = projectModelFamilies(models);
    expect(families.map((row) => row.id)).toEqual(["gpt-6-1-sol", "gpt-6-1-sol-1m", "gpt-6-1-sol-1m-fast", "gpt-6-1-sol-fast"]);
    expect(resolveFamilyModelId("gpt-6-1-sol-fast", "max", families)).toBe("opaque-c");
    expect(resolveFamilyModelId("gpt-6-1-sol", "medium", families)).toBe("opaque-b");
    for (const family of families) expect(family.supportsOff).toBe(false);
    expect(getCodexModelProfile("opaque-b")).toBeUndefined();
  });
  test("Off requires a genuine route, generic thinking never invents efforts", () => {
    const models = [familyFixture("plain", "Optional Thinking", "off"), familyFixture("think", "Optional Thinking", "medium"), familyFixture("unknown-medium")];
    const family = projectModelFamilies(models)[0];
    expect(family.supportsOff).toBe(true);
    expect(resolveFamilyModelId(family.id, "off", [family])).toBe("plain");
    expect(projectModelFamilies([familyFixture("unknown-medium")])).toEqual([]);
    const nonThinking = familyFixture("explicit-non-thinking", "Optional Thinking", "high");
    nonThinking.modelFamilyMetadata!.entries.push({ key: "thinking", value: { name: "Off", order: 0 } });
    expect(projectModelFamilies([nonThinking])[0].variants.off).toBe("explicit-non-thinking");
    const unknownAxis = familyFixture("unknown-axis", "Unsupported Effort", "medium");
    unknownAxis.modelFamilyMetadata!.entries[0].value!.name = "Synthetic unsupported effort";
    expect(projectModelFamilies([unknownAxis])).toEqual([]);
  });
  test("upstream metadata beats fallback; ambiguous routes/defaults fail closed", () => {
    const models = [familyFixture("upstream-wire-medium", "SWE-2", "medium"), familyFixture("swe-2-medium")];
    expect(projectModelFamilies(models)[0].variants.medium).toBe("upstream-wire-medium");
    expect(() => projectModelFamilies([familyFixture("a", "SWE-2", "medium"), familyFixture("b", "SWE-2", "medium")])).toThrow("Ambiguous");
    expect(() => projectModelFamilies([familyFixture("a", "SWE-2", "medium", {}, true), familyFixture("b", "SWE-2", "high", {}, true)])).toThrow("default");
    expect(() => resolveFamilyModelId("swe-2", "medium", [])).toThrow("unavailable");
  });
  test("reviewed fallback only groups exact SWE IDs and does not infer Sol", () => {
    expect(projectModelFamilies([familyFixture("swe-2-medium"), familyFixture("swe-2-max"), familyFixture("gpt-6-1-sol-high")])[0].variants).toEqual({ medium: "swe-2-medium", max: "swe-2-max" });
  });
  test("exports only reviewed enabled routes; unvalidated siblings never become role candidates", () => {
    const models = [familyFixture("glm-5-3-flash-low"), familyFixture("swe-2-medium", "SWE-2", "medium"), familyFixture("swe-2-high", "SWE-2", "high", {}, true), familyFixture("swe-2-max", "SWE-2", "max")];
    const selection = initialModelSelection(); selection.enabledModels.push("swe-2-high", "swe-2-max");
    validateDiscoveredRoles(selection, models);
    const manifest = codexSelectionManifest(selection, adminModels(models, selection));
    expect(manifest.models[1]).toMatchObject({ id: "swe-2", defaultReasoningEffort: "medium", routing: { medium: "swe-2-medium" }, upstreamDefaultEffort: "high" });
    expect(manifest.models[1].supportedReasoningEfforts.map((row) => row.effort)).toEqual(["medium"]);
    expect(manifest.excludedModels.map((row) => row.id)).toEqual(["swe-2-high", "swe-2-max"]);
    expect(() => validateModelSelection({ ...selection, roles: { ...selection.roles, swe_worker: { modelId: "swe-2", effort: "high" } } })).toThrow();
    expect(() => validateDiscoveredRoles(selection, [models[0], models[2]])).toThrow("unavailable");
  });
});
describe("v2 explicit roles and reversible v1 migration", () => {
  const v1 = { schemaVersion: 1, revision: 9, enabledModels: ["glm-5-3-flash-low", "swe-2-medium", "synthetic-unknown"], roles: { default: "glm-5-3-flash-low", swe_worker: "swe-2-medium" }, includeFutureModels: false };
  test("migration preserves revision, enabled IDs and exact Medium; malformed originals reject", () => {
    expect(migrateModelSelection(v1)).toEqual({ ...v1, schemaVersion: 2, roles: initialModelSelection().roles });
    for (const value of [{ ...v1, enabledModels: ["glm-5-3-flash-low"] }, { ...v1, revision: 0 }, { ...v1, roles: { ...v1.roles, swe_worker: "swe-2-high" } }, { ...v1, extra: true }]) expect(() => migrateModelSelection(value)).toThrow();
  });
  test("store preserves original bytes privately; recreation never remigrates/reseeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-migration-test-"));
    const store = new ModelSelectionStore(join(root, "settings"));
    try {
      await store.initialize(); const original = Buffer.from(JSON.stringify(v1, null, 2) + "\n");
      await writeFile(store.file, original, { mode: 0o600 });
      const migrated = await store.initialize();
      expect(await readFile(join(store.directory, "model-selection.v1.json"))).toEqual(original);
      expect(migrated.revision).toBe(9); expect(selectionETag(migrated)).toBe('"model-selection-v2-9"');
      const bytes = await readFile(store.file);
      expect(await new ModelSelectionStore(store.directory).initialize()).toEqual(migrated);
      expect(await readFile(store.file)).toEqual(bytes);
      await expect(store.update(migrated, '"model-selection-v1-9"')).rejects.toThrow("changed");
      // Simulate restoring the original after stopping writers; migration remains deterministic.
      await writeFile(store.file, await readFile(join(store.directory, "model-selection.v1.json")));
      expect(await store.initialize()).toEqual(migrated);
      expect(await readFile(store.file)).toEqual(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("conflicting migration backup fails closed and does not change v1 bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-migration-conflict-")); const store = new ModelSelectionStore(join(root, "settings"));
    try {
      await store.initialize(); const bytes = Buffer.from(JSON.stringify(v1)); await writeFile(store.file, bytes);
      await writeFile(join(store.directory, "model-selection.v1.json"), "synthetic-conflict", { mode: 0o600 });
      await expect(store.initialize()).rejects.toThrow("unavailable"); expect(await readFile(store.file)).toEqual(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
