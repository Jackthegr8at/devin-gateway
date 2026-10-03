import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  COMPATIBILITY_CONTRACT_VERSION,
  loadRuntimeInstructionRecord,
  validateSelection,
  probeGeneratedCatalog,
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
const SUPPORTED_RUNTIME = "0.159.2"; // Historical fixture, not a production version policy.
const runtimeOutput = (instructions = fixtureInstructions) => Buffer.from(JSON.stringify({ models: [{ base_instructions: instructions }] }), "utf8");
const fixtureRuntimeRunner: RuntimeCatalogRunner = (_path, _args, home) => {
  if (_args.includes("--bundled")) return { status: 0, stdout: runtimeOutput() };
  const catalog = JSON.parse(readFileSync(join(home, "catalog.json"), "utf8"));
  for (const model of catalog.models) if (model.shell_type === "shell_command") model.shell_type = "unified_exec";
  return { status: 0, stdout: JSON.stringify(catalog) };
};
const generate = (input: unknown, runtimeVersion = SUPPORTED_RUNTIME) => generateSelection(input, runtimeVersion, runtimePath, {
  runRuntime: fixtureRuntimeRunner,
  runtimeRecord: fixtureRuntimeRecord,
});

test("reviewed runtime instruction provenance pins only a hash and UTF-8 byte length", () => {
  expect(SUPPORTED_RUNTIME).toBe("0.159.2");
  expect(REVIEWED_RUNTIME_INSTRUCTIONS.compatibilityContractVersion).toBe(1);
  expect(EXPECTED_INSTRUCTION_SHA256).toBe("B707476816BFE5E571A1BD2179F130FFF2B132DA5AB8E61063ACDB7FD24DAF12");
  expect(EXPECTED_INSTRUCTION_UTF8_BYTE_LENGTH).toBe(18043);
});

test("version-independent contract preserves Devin metadata for known and unknown versions", () => {
  const version = "0.159.0-alpha.12.1";
  const record = loadRuntimeInstructionRecord();
  expect(COMPATIBILITY_CONTRACT_VERSION).toBe(1);
  expect(record.expectedInstructionSha256).toBe(EXPECTED_INSTRUCTION_SHA256);
  expect(record.expectedInstructionUtf8ByteLength).toBe(18043);
  expect(record.modelMetadata).toEqual(REVIEWED_RUNTIME_INSTRUCTIONS.modelMetadata);
  const fixture = { ...record, expectedInstructionSha256: sha256(fixtureInstructions), expectedInstructionUtf8ByteLength: Buffer.byteLength(fixtureInstructions) };
  const result = generateSelection(selectionFixture(), version, runtimePath, { runtimeRecord: fixture, runRuntime: fixtureRuntimeRunner });
  expect(result.runtimeVersion).toBe(version);
  for (const model of JSON.parse(result.catalogText).models) {
    expect(model.multi_agent_version).toBe("v1");
    expect(model.shell_type).toBe("shell_command");
  }
  expect(generate(selectionFixture(), "99.42.7").runtimeVersion).toBe("99.42.7");
  expect(() => extractRuntimeInstructions("__proto__", runtimePath, fixtureRuntimeRunner, fixtureRuntimeRecord)).toThrow("provenance");
  for (const output of [
    { models: [{ base_instructions: "wrong fixture" }] },
    { models: [] },
    { models: [{ base_instructions: fixtureInstructions }, { base_instructions: fixtureInstructions }] },
  ]) expect(() => extractRuntimeInstructions(version, runtimePath, () => ({ status: 0, stdout: JSON.stringify(output) }), fixture)).toThrow("reviewed SHA-256 and UTF-8 length");
  expect(() => extractRuntimeInstructions(version, runtimePath, () => ({ status: 0, stdout: JSON.stringify({ models: {} }) }), fixture)).toThrow("bundled catalog was invalid");
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

test("unknown compatible runtimes pass instruction provenance", () => {
  let called = false;
  expect(extractRuntimeInstructions("99.42.7", runtimePath, () => {
    called = true;
    return { status: 0, stdout: runtimeOutput() };
  }, fixtureRuntimeRecord)).toBe(fixtureInstructions);
  expect(called).toBe(true);
});

test("instruction source categories, malformed structures and output bounds fail closed", () => {
  const extract = (stdout: string | Uint8Array) => extractRuntimeInstructions("99.42.7", runtimePath, () => ({ status: 0, stdout }), fixtureRuntimeRecord);
  expect(() => extract(JSON.stringify({ models: [] }))).toThrow("instruction_source_unrecognized");
  expect(() => extract(JSON.stringify({ models: [{ base_instructions: fixtureInstructions }, { base_instructions: fixtureInstructions }] }))).toThrow("instruction_source_ambiguous");
  for (const root of [{}, { models: {} }, { models: [null] }, { models: [{ base_instructions: 42 }] }]) expect(() => extract(JSON.stringify(root))).toThrow();
  expect(() => extract(Buffer.from([0xff]))).toThrow();
  expect(() => extract(" ".repeat(2 * 1024 * 1024 + 1))).toThrow();
});

test("contract rejects backend rejection, field/effort/model/V1 changes and unknown shell normalization", () => {
  const result = generate(selectionFixture());
  const models = JSON.parse(result.catalogText).models;
  const mutations = [
    (c: any) => { c.models = []; },
    (c: any) => { c.models[0].slug = "different-model"; },
    (c: any) => { c.models[0].default_reasoning_level = "high"; },
    (c: any) => { c.models[0].supported_reasoning_levels = []; },
    (c: any) => { c.models[0].multi_agent_version = "v2"; },
    (c: any) => { c.models[0].supported_in_api = "true"; },
    (c: any) => { c.models[0].shell_type = "unknown"; },
    (c: any) => { delete c.models[0].context_window; },
  ];
  for (const mutate of mutations) {
    expect(() => probeGeneratedCatalog(runtimePath, models, result.roles, (path, args, home) => {
      const r = fixtureRuntimeRunner(path, args, home);
      const c = JSON.parse(r.stdout as string); mutate(c);
      return { status: 0, stdout: JSON.stringify(c) };
    })).toThrow();
  }
  expect(() => probeGeneratedCatalog(runtimePath, models, result.roles, () => ({ status: 1, stdout: null }))).toThrow("generated_catalog_rejected");
  for (const file of ["config.toml", "worker.toml"]) expect(() => probeGeneratedCatalog(runtimePath, models, result.roles, (path, args, home) => {
    const r = fixtureRuntimeRunner(path, args, home);
    writeFileSync(join(home!, file), "synthetic incompatible mutation");
    return r;
  })).toThrow("provider_security_or_role_mutation");
});

test("contract proves complete shell alias equality and disabled stays disabled", () => {
  const result = generate(selectionFixture(), "99.42.7");
  expect(result.compatibilityContractVersion).toBe(1);
  expect(() => probeGeneratedCatalog(runtimePath, JSON.parse(result.catalogText).models, result.roles, (path, args, home) => {
    const r = fixtureRuntimeRunner(path, args, home);
    const c = JSON.parse(r.stdout as string);
    if (c.models[0].shell_type === "disabled") c.models[0].shell_type = "unified_exec";
    return { status: 0, stdout: JSON.stringify(c) };
  })).toThrow("unsupported_shell_normalization");
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
  expect(generate(fixture).roles.default.modelId).toBe("glm-5-3-flash");
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
test("malformed runtime provenance does not generate a catalog", () => {
  expect(() => generate(selectionFixture(), "not-a-version")).toThrow("provenance");
});
test("duplicate JSON fields and malformed JSON fail closed", () => {
  expect(() => parseSelectionJson('{"schemaVersion":1,"schemaVersion":2}')).toThrow();
  expect(() => parseSelectionJson('{"a":{"role":1,"role":2}}')).toThrow();
  expect(() => parseSelectionJson('{"bad":')).toThrow();
  expect(parseSelectionJson(JSON.stringify(selectionFixture()))).toEqual(selectionFixture());
});
test("unvalidated enabled models may be excluded but never routed", () => {
  const fixture = selectionFixture();
  fixture.excludedModels.push({ id: "unreviewed-model", reason: "missing_effort_metadata" });
  expect(validateSelection(fixture).models).toHaveLength(2);
  fixture.roles.default.modelId = "unreviewed-model";
  expect(() => validateSelection(fixture)).toThrow();
});
