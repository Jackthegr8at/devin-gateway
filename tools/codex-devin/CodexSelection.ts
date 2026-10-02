import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_PROFILE_VERSION, getCodexModelProfile } from "../../src/admin/codex-model-profiles.js";
import { REVIEWED_FAMILY_ROUTES } from "../../src/model-families.js";

const fail = (): never => { throw new Error("Invalid or unsupported Codex selection; no defaults were substituted."); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, expected: readonly string[]) => {
  if (Object.keys(value).length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) fail();
};
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value)) return fail();
  return value;
};
const positive = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return fail();
  return value as number;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.length || value.length > 512 || /[\x00-\x1f]/.test(value)) return fail();
  return value;
};
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
export const SUPPORTED_RUNTIME = "0.159.2";
export interface RuntimeModelMetadata {
  multi_agent_version: string;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  support_verbosity: boolean;
  truncation_policy: { mode: string; limit: number };
  experimental_supported_tools: unknown[];
}
export interface RuntimeInstructionRecord {
  runtimeVersion: string;
  source: string;
  instructionField: string;
  expectedInstructionSha256: string;
  expectedInstructionUtf8ByteLength: number;
  modelMetadata: RuntimeModelMetadata;
}
export interface RuntimeCatalogRunnerResult {
  status: number | null;
  stdout: Uint8Array | string | null;
}
export type RuntimeCatalogRunner = (runtimePath: string, args: string[]) => RuntimeCatalogRunnerResult;
export interface RuntimeSelectionDependencies {
  runRuntime?: RuntimeCatalogRunner;
  runtimeRecord?: RuntimeInstructionRecord;
}

const loadRuntimeInstructionRecord = (): RuntimeInstructionRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(new URL("./templates/codex-0.159.2.json", import.meta.url), "utf8"));
  } catch {
    throw new Error("Reviewed Codex runtime metadata could not be loaded.");
  }
  const root = object(parsed);
  keys(root, ["runtimeVersion", "source", "instructionField", "expectedInstructionSha256", "expectedInstructionUtf8ByteLength", "modelMetadata"]);
  if (root.runtimeVersion !== SUPPORTED_RUNTIME || root.source !== "codex_debug_models_bundled" || root.instructionField !== "base_instructions") fail();
  const expectedInstructionSha256 = root.expectedInstructionSha256;
  if (typeof expectedInstructionSha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(expectedInstructionSha256)) fail();
  const expectedInstructionUtf8ByteLength = positive(root.expectedInstructionUtf8ByteLength);
  const metadata = object(root.modelMetadata);
  keys(metadata, ["multi_agent_version", "shell_type", "visibility", "supported_in_api", "support_verbosity", "truncation_policy", "experimental_supported_tools"]);
  if (typeof metadata.supported_in_api !== "boolean" || typeof metadata.support_verbosity !== "boolean"
    || !Array.isArray(metadata.experimental_supported_tools) || metadata.experimental_supported_tools.length !== 0) fail();
  const supportedInApi = metadata.supported_in_api as boolean;
  const supportVerbosity = metadata.support_verbosity as boolean;
  const truncationPolicy = object(metadata.truncation_policy);
  keys(truncationPolicy, ["mode", "limit"]);
  const modelMetadata: RuntimeModelMetadata = {
    multi_agent_version: text(metadata.multi_agent_version),
    shell_type: text(metadata.shell_type),
    visibility: text(metadata.visibility),
    supported_in_api: supportedInApi,
    support_verbosity: supportVerbosity,
    truncation_policy: { mode: text(truncationPolicy.mode), limit: positive(truncationPolicy.limit) },
    experimental_supported_tools: [],
  };
  return {
    runtimeVersion: SUPPORTED_RUNTIME,
    source: "codex_debug_models_bundled",
    instructionField: "base_instructions",
    expectedInstructionSha256: (expectedInstructionSha256 as string).toUpperCase(),
    expectedInstructionUtf8ByteLength,
    modelMetadata,
  };
};
export const REVIEWED_RUNTIME_INSTRUCTIONS = loadRuntimeInstructionRecord();
export const EXPECTED_INSTRUCTION_SHA256 = REVIEWED_RUNTIME_INSTRUCTIONS.expectedInstructionSha256;
export const EXPECTED_INSTRUCTION_UTF8_BYTE_LENGTH = REVIEWED_RUNTIME_INSTRUCTIONS.expectedInstructionUtf8ByteLength;

const runBundledRuntimeCatalog: RuntimeCatalogRunner = (runtimePath, args) => {
  const result = spawnSync(runtimePath, args, {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout };
};

/** Capture the installed runtime's bundled catalog in memory; never forward its output to diagnostics. */
export function extractRuntimeInstructions(
  runtimeVersion: string,
  runtimePath: string,
  runner: RuntimeCatalogRunner = runBundledRuntimeCatalog,
  record: RuntimeInstructionRecord = REVIEWED_RUNTIME_INSTRUCTIONS,
): string {
  if (runtimeVersion !== SUPPORTED_RUNTIME || record.runtimeVersion !== SUPPORTED_RUNTIME
    || record.instructionField !== "base_instructions" || record.source !== "codex_debug_models_bundled") {
    throw new Error("No reviewed Codex catalog adapter for the installed Desktop runtime.");
  }
  if (typeof runtimePath !== "string" || !isAbsolute(runtimePath)) throw new Error("The installed Desktop runtime path is invalid.");
  let result: RuntimeCatalogRunnerResult;
  try {
    result = runner(runtimePath, ["debug", "models", "--bundled"]);
  } catch {
    throw new Error("The installed Desktop bundled catalog could not be read.");
  }
  if (result.status !== 0 || result.stdout === null) throw new Error("The installed Desktop bundled catalog could not be read.");
  let catalog: unknown;
  try {
    const output = typeof result.stdout === "string"
      ? result.stdout
      : new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    catalog = JSON.parse(output);
  } catch {
    throw new Error("The installed Desktop bundled catalog was invalid.");
  }
  const root = object(catalog);
  if (!Array.isArray(root.models) || root.models.length > 1000) throw new Error("The installed Desktop bundled catalog was invalid.");
  const matches: string[] = [];
  for (const entry of root.models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const instructions = (entry as Record<string, unknown>)[record.instructionField];
    if (typeof instructions !== "string") continue;
    const bytes = Buffer.from(instructions, "utf8");
    if (bytes.length === record.expectedInstructionUtf8ByteLength
      && sha256(bytes) === record.expectedInstructionSha256.toUpperCase()) matches.push(instructions);
  }
  if (matches.length !== 1) throw new Error("Installed Desktop instructions did not match the reviewed SHA-256 and UTF-8 length.");
  return matches[0];
}

// Already-reviewed Phase 2.5 GLM 1M projection. This adds no concrete model profile.
const REVIEWED_CLIENT_ROUTES: Readonly<Record<string, Readonly<Record<string, string | undefined>>>> = {
  ...REVIEWED_FAMILY_ROUTES,
  "glm-5-3-flash-1m": { low: "glm-5-3-flash-low" },
};
interface Model {
  id: string; displayName: string; contextWindow: number; maxOutputTokens: number;
  inputModalities: string[]; defaultReasoningEffort: string;
  supportedReasoningEfforts: { effort: string; description: string }[];
  routing: Record<string, string>;
}
interface Role { modelId: string; reasoningEffort: string; concreteModelId: string }
export interface Selection {
  revision: number; selectionETag: string; models: Model[];
  roles: { default: Role; swe_worker: Role };
}

/** Strict allowlist: gateway content never becomes instructions, TOML, or permissions. */
export function validateSelection(input: unknown): Selection {
  const root = object(input);
  keys(root, ["schemaVersion", "revision", "selectionETag", "compatibilityProfileVersion", "includeFutureModels", "models", "roles", "excludedModels"]);
  if (root.schemaVersion !== 2 || root.compatibilityProfileVersion !== CODEX_PROFILE_VERSION || typeof root.includeFutureModels !== "boolean") fail();
  const revision = positive(root.revision);
  if (root.selectionETag !== `"model-selection-v2-${revision}"`) fail();
  if (!Array.isArray(root.models) || !root.models.length || root.models.length > 100 || !Array.isArray(root.excludedModels)) fail();
  const seen = new Set<string>();
  const concreteSeen = new Set<string>();
  const models: Model[] = (root.models as unknown[]).map((entry) => {
    const row = object(entry);
    keys(row, ["id", "displayName", "contextWindow", "maxOutputTokens", "inputModalities", "defaultReasoningEffort", "supportedReasoningEfforts", "multiAgentVersion", "shellType", "routing", "metadataProvenance", "familyProvenance", "upstreamDefaultEffort"]);
    const modelId = id(row.id);
    if (seen.has(modelId)) fail();
    seen.add(modelId);
    const routing = object(row.routing);
    const efforts = Object.keys(routing).sort();
    if (!efforts.length || !Array.isArray(row.supportedReasoningEfforts) || row.supportedReasoningEfforts.length !== efforts.length) fail();
    const supported = efforts.map((effort) => {
      const concrete = id(routing[effort]);
      const profile = getCodexModelProfile(concrete);
      const route = REVIEWED_CLIENT_ROUTES[modelId];
      if (!profile || concreteSeen.has(concrete) || (modelId !== concrete && (!route || route[effort] !== concrete))) fail();
      if (modelId === "glm-5-3-flash-1m" && (row.familyProvenance !== "upstream_family_metadata" || positive(row.contextWindow) < 1_000_000)) fail();
      concreteSeen.add(concrete);
      const reviewed = profile!.supportedReasoningEfforts.find((item) => item.effort === effort);
      if (!reviewed || row.multiAgentVersion !== profile!.multiAgentVersion || row.shellType !== profile!.shellType) fail();
      const supplied = (row.supportedReasoningEfforts as unknown[]).map(object).filter((item) => item.effort === effort);
      if (supplied.length !== 1) fail();
      keys(supplied[0], ["effort", "description"]);
      if (supplied[0].description !== reviewed!.description) fail();
      return { effort, description: reviewed!.description };
    });
    if (!efforts.includes(row.defaultReasoningEffort as string)) fail();
    const provenance = object(row.metadataProvenance);
    keys(provenance, ["id", "displayName", "contextWindow", "maxOutputTokens", "imageSupport", "upstreamThinking", "reasoning"]);
    if (provenance.id !== "upstream" || provenance.contextWindow !== "upstream" || provenance.maxOutputTokens !== "upstream" || provenance.imageSupport !== "upstream") fail();
    if (!["upstream", "id_fallback"].includes(provenance.displayName as string) || !["upstream", "omitted"].includes(provenance.upstreamThinking as string)
      || provenance.reasoning !== "upstream_indicator_and_label_heuristic") fail();
    if (![null, "upstream_family_metadata", "reviewed_fallback"].includes(row.familyProvenance as string | null)) fail();
    if (row.upstreamDefaultEffort !== null && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(row.upstreamDefaultEffort as string)) fail();
    if (!Array.isArray(row.inputModalities) || !["text", "text,image"].includes(row.inputModalities.join(","))) fail();
    return { id: modelId, displayName: text(row.displayName), contextWindow: positive(row.contextWindow), maxOutputTokens: positive(row.maxOutputTokens),
      inputModalities: [...row.inputModalities as string[]], defaultReasoningEffort: row.defaultReasoningEffort as string,
      supportedReasoningEfforts: supported, routing: Object.fromEntries(efforts.map((effort) => [effort, routing[effort] as string])) };
  });
  const excludedSeen = new Set<string>();
  for (const entry of root.excludedModels as unknown[]) {
    const excluded = object(entry);
    keys(excluded, ["id", "reason"]);
    const excludedId = id(excluded.id);
    if (excludedSeen.has(excludedId) || concreteSeen.has(excludedId) || seen.has(excludedId) || !["unavailable", "unvalidated_profile", "incomplete_metadata"].includes(excluded.reason as string)) fail();
    excludedSeen.add(excludedId);
  }
  const rolesObject = object(root.roles);
  keys(rolesObject, ["default", "swe_worker"]);
  const readRole = (name: string): Role => {
    const role = object(rolesObject[name]);
    keys(role, ["modelId", "reasoningEffort", "concreteModelId"]);
    const model = models.find((entry) => entry.id === role.modelId);
    if (!model || typeof role.reasoningEffort !== "string" || !Object.hasOwn(model.routing, role.reasoningEffort)
      || model.routing[role.reasoningEffort] !== role.concreteModelId || excludedSeen.has(role.concreteModelId as string)) fail();
    return { modelId: role.modelId as string, reasoningEffort: role.reasoningEffort as string, concreteModelId: role.concreteModelId as string };
  };
  return { revision, selectionETag: root.selectionETag as string, models: models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), roles: { default: readRole("default"), swe_worker: readRole("swe_worker") } };
}

export function generateSelection(input: unknown, runtimeVersion: string, runtimePath: string, dependencies: RuntimeSelectionDependencies = {}) {
  if (runtimeVersion !== SUPPORTED_RUNTIME) throw new Error("No reviewed Codex catalog adapter for the installed Desktop runtime.");
  const selection = validateSelection(input);
  const record = dependencies.runtimeRecord ?? REVIEWED_RUNTIME_INSTRUCTIONS;
  const instructions = extractRuntimeInstructions(runtimeVersion, runtimePath, dependencies.runRuntime, record);
  const metadata = record.modelMetadata;
  const models = selection.models.map((model, index) => ({
    slug: model.id,
    multi_agent_version: metadata.multi_agent_version,
    display_name: model.displayName,
    default_reasoning_level: model.defaultReasoningEffort,
    supported_reasoning_levels: model.supportedReasoningEfforts,
    shell_type: metadata.shell_type,
    visibility: metadata.visibility,
    supported_in_api: metadata.supported_in_api,
    priority: index,
    support_verbosity: metadata.support_verbosity,
    truncation_policy: metadata.truncation_policy,
    experimental_supported_tools: metadata.experimental_supported_tools,
    input_modalities: model.inputModalities,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    base_instructions: instructions,
  }));
  const catalogText = JSON.stringify({ models }, null, 2) + "\n";
  return { schemaVersion: 1, runtimeVersion, revision: selection.revision, selectionETag: selection.selectionETag,
    instructionSha256: record.expectedInstructionSha256.toUpperCase(), instructionUtf8ByteLength: record.expectedInstructionUtf8ByteLength,
    catalogSha256: sha256(catalogText), catalogText, roles: selection.roles };
}

/** JSON.parse alone silently accepts duplicate object keys. Reject those before validation. */
export function parseSelectionJson(json: string): unknown {
  const parsed = JSON.parse(json);
  const tokens = json.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  let index = 0;
  const value = (): void => {
    const token = tokens[index++];
    if (token === "{") {
      const names = new Set<string>();
      if (tokens[index] === "}") { index++; return; }
      do {
        const name = JSON.parse(tokens[index++]);
        if (names.has(name) || tokens[index++] !== ":") fail();
        names.add(name);
        value();
      } while (tokens[index++] === ",");
    } else if (token === "[") {
      if (tokens[index] === "]") { index++; return; }
      do { value(); } while (tokens[index++] === ",");
    }
  };
  value();
  return parsed;
}

// The CLI reads a bounded manifest from stdin; it performs no network or file writes.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = readFileSync(0);
    if (input.length > 262144) fail();
    process.stdout.write(JSON.stringify(generateSelection(parseSelectionJson(new TextDecoder("utf-8", { fatal: true }).decode(input)), process.argv[2], process.argv[3])));
  } catch {
    process.stderr.write("Codex selection preparation failed validation; no defaults or remote instructions were accepted.\n");
    process.exitCode = 1;
  }
}
