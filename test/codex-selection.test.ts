import { expect, test } from "bun:test";
import { adminModels, codexSelectionManifest } from "../src/admin/model-catalog.js";
import { initialModelSelection } from "../src/admin/model-selection.js";
import type { DiscoveredModelMetadata } from "../src/devin.js";
import {
  EXPECTED_INSTRUCTION_SHA256,
  EXPECTED_INSTRUCTION_UTF8_BYTE_LENGTH,
  extractRuntimeInstructions,
  generateSelection,
  parseSelectionJson,
  REVIEWED_RUNTIME_INSTRUCTIONS,
  sha256,
  SUPPORTED_RUNTIME,
  validateSelection,
  type RuntimeCatalogRunner,
} from "../tools/codex-devin/CodexSelection.js";

export function selectionFixture() {
  const discovered = ["glm-5-3-flash-low", "swe-2-medium"].map((id): DiscoveredModelMetadata => ({
    id, name: id, contextWindow: 128000, maxTokens: 8192, supportsImages: false, reasoning: true, upstreamThinking: true,
    metadataProvenance: { id: "upstream", displayName: "upstream", contextWindow: "upstream", maxOutputTokens: "upstream", imageSupport: "upstream", upstreamThinking: "upstream", reasoning: "upstream_indicator_and_label_heuristic" },
  }));
  const selection = initialModelSelection();
  return codexSelectionManifest(selection, adminModels(discovered, selection));
}

const fixtureInstructions = "local runtime instruction fixture";
const fixtureRuntimeRecord = {
  ...REVIEWED_RUNTIME_INSTRUCTIONS,
  expectedInstructionSha256: sha256(fixtureInstructions),
  expectedInstructionUtf8ByteLength: Buffer.byteLength(fixtureInstructions, "utf8"),
};
const runtimePath = process.platform === "win32" ? "C:\\codex\\codex.exe" : "/codex/codex";
const runtimeOutput = (instructions = fixtureInstructions) => Buffer.from(JSON.stringify({ models: [{ base_instructions: instructions }] }), "utf8");
const fixtureRuntimeRunner: RuntimeCatalogRunner = (_path, _args) => ({ status: 0, stdout: runtimeOutput() });
const generate = (input: unknown, runtimeVersion = SUPPORTED_RUNTIME) => generateSelection(input, runtimeVersion, runtimePath, {
  runRuntime: fixtureRuntimeRunner,
  runtimeRecord: fixtureRuntimeRecord,
});

test("reviewed runtime instruction provenance pins only a hash and UTF-8 byte length", () => {
  expect(SUPPORTED_RUNTIME).toBe("0.159.2");
  expect(REVIEWED_RUNTIME_INSTRUCTIONS.runtimeVersion).toBe("0.159.2");
  expect(EXPECTED_INSTRUCTION_SHA256).toBe("B707476816BFE5E571A1BD2179F130FFF2B132DA5AB8E61063ACDB7FD24DAF12");
  expect(EXPECTED_INSTRUCTION_UTF8_BYTE_LENGTH).toBe(18043);
});

test("bundled runtime extraction selects the locally sourced instruction value", () => {
  let actualPath = "";
  let actualArgs: string[] = [];
  const extracted = extractRuntimeInstructions(SUPPORTED_RUNTIME, runtimePath, (path, args) => {
    actualPath = path;
    actualArgs = args;
    return { status: 0, stdout: runtimeOutput() };
  }, fixtureRuntimeRecord);
  expect(extracted).toBe(fixtureInstructions);
  expect(actualPath).toBe(runtimePath);
  expect(actualArgs).toEqual(["debug", "models", "--bundled"]);
});

test("bundled runtime extraction rejects an instruction hash mismatch", () => {
  expect(() => extractRuntimeInstructions(SUPPORTED_RUNTIME, runtimePath,
    () => ({ status: 0, stdout: runtimeOutput("modified local fixture") }), fixtureRuntimeRecord))
    .toThrow("reviewed SHA-256 and UTF-8 length");
});

test("bundled runtime extraction rejects a missing instruction template", () => {
  expect(() => extractRuntimeInstructions(SUPPORTED_RUNTIME, runtimePath,
    () => ({ status: 0, stdout: Buffer.from(JSON.stringify({ models: [{ slug: "missing" }] })) }), fixtureRuntimeRecord))
    .toThrow("reviewed SHA-256 and UTF-8 length");
});

test("unknown runtimes fail before the local catalog command runs", () => {
  let called = false;
  expect(() => extractRuntimeInstructions("0.159.3", runtimePath, () => {
    called = true;
    return { status: 0, stdout: runtimeOutput() };
  }, fixtureRuntimeRecord)).toThrow("No reviewed Codex catalog adapter");
  expect(called).toBe(false);
});

test("generated catalog receives the locally sourced instructions", () => {
  const result = generate(selectionFixture());
  const models = JSON.parse(result.catalogText).models;
  expect(models[0].base_instructions).toBe(fixtureInstructions);
  expect(result.instructionSha256).toBe(sha256(fixtureInstructions));
  expect(result.instructionUtf8ByteLength).toBe(Buffer.byteLength(fixtureInstructions, "utf8"));
});

test("schema-v2 saved roles generate deterministic logical catalog and exact efforts", () => {
  const fixture = selectionFixture();
  const result = generate(fixture);
  expect(result.roles.default).toEqual({ modelId: "glm-5-3-flash-low", reasoningEffort: "low", concreteModelId: "glm-5-3-flash-low" });
  expect(result.roles.swe_worker).toEqual({ modelId: "swe-2", reasoningEffort: "medium", concreteModelId: "swe-2-medium" });
  const models = JSON.parse(result.catalogText).models;
  expect(models.map((model: any) => model.slug)).toEqual(["glm-5-3-flash-low", "swe-2"]);
  expect(models[1].supported_reasoning_levels.map((row: any) => row.effort)).toEqual(["medium"]);
  expect(models[1].default_reasoning_level).toBe("medium");
  expect(sha256(models[0].base_instructions)).toBe(sha256(fixtureInstructions));
  expect(Buffer.byteLength(models[0].base_instructions, "utf8")).toBe(Buffer.byteLength(fixtureInstructions, "utf8"));
  expect(generate({ ...fixture, models: [...fixture.models].reverse() }).catalogText).toBe(result.catalogText);
  expect(sha256(result.catalogText)).toBe(result.catalogSha256);
});

test("saved roles are not fixed to parent GLM and worker SWE", () => {
  const fixture = selectionFixture();
  [fixture.roles.default, fixture.roles.swe_worker] = [fixture.roles.swe_worker, fixture.roles.default];
  const result = generate(fixture);
  expect(result.roles.default.modelId).toBe("swe-2");
  expect(result.roles.default.reasoningEffort).toBe("medium");
  expect(result.roles.swe_worker.modelId).toBe("glm-5-3-flash-low");
  expect(result.roles.swe_worker.reasoningEffort).toBe("low");
});
test("reviewed GLM 1M logical projection is accepted without conflating the standard lane", () => {
  const fixture = selectionFixture();
  const glm = fixture.models[0];
  glm.id = "glm-5-3-flash-1m";
  glm.contextWindow = 1_000_000;
  glm.familyProvenance = "upstream_family_metadata";
  fixture.roles.default.modelId = glm.id;
  expect(generate(fixture).roles.default.concreteModelId).toBe("glm-5-3-flash-low");
  glm.id = "glm-5-3-flash";
  fixture.roles.default.modelId = glm.id;
  expect(() => generate(fixture)).toThrow("no defaults");
});

const mutations: Record<string, (fixture: any) => void> = {
  "schema version": f => f.schemaVersion = 1,
  "profile version": f => f.compatibilityProfileVersion = 99,
  "missing roles": f => delete f.roles,
  "missing parent": f => delete f.roles.default,
  "missing effort": f => delete f.roles.swe_worker.reasoningEffort,
  "unknown model": f => f.roles.default.modelId = "unreviewed",
  "case mismatch": f => f.roles.swe_worker.modelId = "SWE-2",
  "unvalidated effort": f => f.roles.swe_worker.reasoningEffort = "high",
  "wrong concrete route": f => f.roles.swe_worker.concreteModelId = "swe-2-high",
  "missing metadata": f => delete f.models[0].contextWindow,
  "fallback metadata": f => f.models[0].metadataProvenance.contextWindow = "fallback",
  "invalid context": f => f.models[0].contextWindow = 0,
  "invented efforts": f => f.models[1].supportedReasoningEfforts.push({ effort: "high", description: "Synthetic" }),
  "duplicate models": f => f.models.push(f.models[0]),
  "duplicate effort": f => f.models[1].supportedReasoningEfforts.push(f.models[1].supportedReasoningEfforts[0]),
  "remote instructions": f => f.models[0].base_instructions = "synthetic-untrusted-instruction",
  "remote permission": f => f.sandbox_mode = "synthetic-untrusted-permission",
  "unavailable role": f => { f.models.pop(); f.excludedModels.push({ id: "swe-2-medium", reason: "unavailable" }); },
  "ETag mismatch": f => f.selectionETag = '"model-selection-v2-999"',
};
for (const [name, mutate] of Object.entries(mutations)) test(`selection fails closed: ${name}`, () => {
  const fixture = structuredClone(selectionFixture());
  mutate(fixture);
  expect(() => validateSelection(fixture)).toThrow("no defaults");
});
test("unsupported runtime does not generate a catalog", () => {
  expect(() => generate(selectionFixture(), "0.159.3")).toThrow("No reviewed");
});
test("duplicate JSON fields and malformed JSON fail closed", () => {
  expect(() => parseSelectionJson('{"schemaVersion":1,"schemaVersion":2}')).toThrow();
  expect(() => parseSelectionJson('{"a":{"role":1,"role":2}}')).toThrow();
  expect(() => parseSelectionJson('{"bad":')).toThrow();
  expect(parseSelectionJson(JSON.stringify(selectionFixture()))).toEqual(selectionFixture());
});
test("unvalidated enabled models may be excluded but never routed", () => {
  const fixture = selectionFixture();
  fixture.excludedModels.push({ id: "unreviewed-model", reason: "unvalidated_profile" });
  expect(validateSelection(fixture).models).toHaveLength(2);
  fixture.roles.default.modelId = "unreviewed-model";
  expect(() => validateSelection(fixture)).toThrow();
});
