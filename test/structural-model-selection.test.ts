import { expect, test } from "bun:test";
import { familyFixture } from "./fixtures/model-families.ts";
import { adminModels, codexSelectionManifest, validateDiscoveredRoles } from "../src/admin/model-catalog.ts";
import { initialModelSelection } from "../src/admin/model-selection.ts";
import { projectModelFamilies, resolveFamilyModelId } from "../src/model-families.ts";
import { validateSelection, generateSelection, REVIEWED_RUNTIME_INSTRUCTIONS, sha256 } from "../tools/codex-devin/CodexSelection.ts";

function fixture() {
  const discovered = [
    familyFixture("swe-2-medium", "SWE-2", "medium"),
    familyFixture("swe-2-high", "SWE-2", "high"),
    familyFixture("swe-2-max", "SWE-2", "max"),
    familyFixture("gpt-5-6-luna-max", "GPT-5.6 Luna", "max"),
    familyFixture("gpt-6-1-sol-low", "GPT-6.1 Sol", "low"),
    familyFixture("gpt-6-1-sol-medium", "GPT-6.1 Sol", "medium"),
    familyFixture("glm-5-3-flash-low", "GLM-5.3 Flash", "low", { context1m: true }),
  ];
  const selection = { ...initialModelSelection(), enabledModels: discovered.map(m => m.id) };
  return { discovered, selection };
}
test("seven enabled variants export four logical models without tested gating", () => {
  const { discovered, selection } = fixture();
  const rows = adminModels(discovered, selection);
  expect(rows.find(m => m.id === "swe-2-high")!.codex).toMatchObject({ tested: false, status: "untested", exportEligible: true });
  const manifest = codexSelectionManifest(selection, rows);
  expect(manifest.models.map(m => [m.id, m.supportedReasoningEfforts.map(e => e.effort)])).toEqual([
    ["glm-5-3-flash-1m", ["low"]], ["gpt-5-6-luna", ["max"]], ["gpt-6-1-sol", ["low", "medium"]], ["swe-2", ["medium", "high", "max"]],
  ]);
  expect(validateSelection(manifest).models).toHaveLength(4);
  expect(codexSelectionManifest(selection, adminModels([...discovered].reverse(), selection))).toEqual(manifest);
  expect(manifest.models.find(m => m.id === "swe-2")!.defaultReasoningEffort).toBe("medium");
  const synthetic = "synthetic local runtime fixture";
  const dependencies = {
    runRuntime: () => ({ status: 0, stdout: JSON.stringify({ models: [{ base_instructions: synthetic }] }) }),
    runtimeRecord: { ...REVIEWED_RUNTIME_INSTRUCTIONS, expectedInstructionSha256: sha256(synthetic), expectedInstructionUtf8ByteLength: Buffer.byteLength(synthetic) },
  };
  const runtime = process.platform === "win32" ? "C:\\synthetic-runtime\\codex.exe" : "/synthetic-runtime/codex";
  const generated = generateSelection(manifest, "0.159.2", runtime, dependencies);
  expect(generateSelection(manifest, "0.159.2", runtime, dependencies).catalogSha256).toBe(generated.catalogSha256);
  const catalog = JSON.parse(generated.catalogText);
  expect(catalog.models.find((m: any) => m.slug === "swe-2").supported_reasoning_levels.map((r: any) => r.effort)).toEqual(["medium", "high", "max"]);
  expect(catalog.models.find((m: any) => m.slug === "gpt-6-1-sol").supported_reasoning_levels.map((r: any) => r.effort)).toEqual(["low", "medium"]);
});
test("unselected siblings are absent; an enabled untested effort can be a role", () => {
  const { discovered, selection } = fixture();
  selection.enabledModels = selection.enabledModels.filter(id => id !== "swe-2-max" && id !== "gpt-6-1-sol-low");
  selection.roles.swe_worker = { modelId: "swe-2", effort: "high" };
  validateDiscoveredRoles(selection, discovered);
  const manifest = codexSelectionManifest(selection, adminModels(discovered, selection));
  expect(manifest.models.find(m => m.id === "swe-2")!.routing).toEqual({ medium: "swe-2-medium", high: "swe-2-high" });
  expect(manifest.models.find(m => m.id === "gpt-6-1-sol")!.supportedReasoningEfforts.map(e => e.effort)).toEqual(["medium"]);
  expect(manifest.roles.swe_worker.concreteModelId).toBe("swe-2-high");
  selection.roles.swe_worker.effort = "max";
  expect(() => validateDiscoveredRoles(selection, discovered)).toThrow("no model was substituted");
});
test("missing metadata and ambiguous routes are excluded with explicit reasons", () => {
  const { discovered, selection } = fixture();
  const missing = familyFixture("synthetic-missing", "Synthetic", "low");
  missing.metadataProvenance.contextWindow = "fallback";
  discovered.push(missing, familyFixture("synthetic-a", "Duplicate", "medium"), familyFixture("synthetic-b", "Duplicate", "medium"));
  selection.enabledModels.push("synthetic-missing", "synthetic-a", "synthetic-b");
  const manifest = codexSelectionManifest(selection, adminModels(discovered, selection));
  expect(manifest.excludedModels).toEqual([
    { id: "synthetic-missing", reason: "incomplete_metadata" },
    { id: "synthetic-a", reason: "ambiguous_family_metadata" },
    { id: "synthetic-b", reason: "ambiguous_family_metadata" },
  ]);
});
test("Off requires a genuine upstream route, not a missing reasoning flag", () => {
  const thinking = familyFixture("synthetic-thinking", "Synthetic", "high");
  const off = familyFixture("synthetic-off", "Synthetic", "off");
  const families = projectModelFamilies([thinking, off]);
  expect(resolveFamilyModelId("synthetic", "none", families)).toBe("synthetic-off");
  expect(() => resolveFamilyModelId("synthetic", "none", projectModelFamilies([thinking]))).toThrow();
});
