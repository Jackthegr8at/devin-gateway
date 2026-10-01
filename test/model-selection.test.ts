import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCodexModelProfile } from "../src/admin/codex-model-profiles.ts";
import { initialModelSelection, selectionETag, validateModelSelection } from "../src/admin/model-selection.ts";
import { ModelSelectionStore } from "../src/admin/model-selection-store.ts";
import { adminModels, codexSelectionManifest } from "../src/admin/model-catalog.ts";
import type { DiscoveredModelMetadata } from "../src/devin.ts";

function discovered(id: string): DiscoveredModelMetadata {
  return {
    id, name: id, contextWindow: 200_000, maxTokens: 64_000, supportsImages: false, reasoning: true,
    upstreamThinking: true,
    metadataProvenance: { id: "upstream", displayName: "upstream", contextWindow: "upstream", maxOutputTokens: "upstream", imageSupport: "upstream", upstreamThinking: "upstream", reasoning: "upstream_indicator_and_label_heuristic" },
  };
}
async function temporaryStore(run: (store: ModelSelectionStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gateway-selection-test-"));
  try { await run(new ModelSelectionStore(join(root, "settings")), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("reviewed profiles and strict version-2 selection", () => {
  test("only exact GLM Low and SWE-2 Medium IDs have fixed singleton efforts", () => {
    for (const [id, effort] of [["glm-5-3-flash-low", "low"], ["swe-2-medium", "medium"]]) {
      const profile = getCodexModelProfile(id)!;
      expect(profile.defaultReasoningEffort).toBe(effort);
      expect(profile.supportedReasoningEfforts.map((row) => row.effort)).toEqual([effort]);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.supportedReasoningEfforts)).toBe(true);
    }
    for (const id of ["SWE-2-MEDIUM", "swe-2-high", "other-medium", "glm-5-3-flash-low "]) expect(getCodexModelProfile(id)).toBeUndefined();
  });
  test("initial migration matches validated roles without provider/permission fields", () => {
    expect(validateModelSelection(initialModelSelection())).toEqual(initialModelSelection());
    expect(initialModelSelection().roles).toEqual({ default: { modelId: "glm-5-3-flash-low", effort: "low" }, swe_worker: { modelId: "swe-2", effort: "medium" } });
    expect(initialModelSelection().includeFutureModels).toBe(false);
  });
  test("unknown exact IDs may be enabled without gaining a role/profile", () => {
    const state = initialModelSelection();
    state.enabledModels.push("UNKNOWN_medium", "future-model-low");
    expect(validateModelSelection(state).enabledModels).toEqual(state.enabledModels);
  });
  test("rejects invalid versions/revisions/fields/duplicates/IDs/roles and arbitrary payloads", () => {
    const invalid: unknown[] = [null, [], {}, { ...initialModelSelection(), schemaVersion: 3 },
      { ...initialModelSelection(), revision: 0 }, { ...initialModelSelection(), revision: 1.5 },
      { ...initialModelSelection(), includeFutureModels: "false" }, { ...initialModelSelection(), script: "synthetic" },
      { ...initialModelSelection(), enabledModels: ["swe-2-medium", "swe-2-medium"] },
      { ...initialModelSelection(), enabledModels: ["glm-5-3-flash-low ", "swe-2-medium"] },
      { ...initialModelSelection(), roles: { default: "GLM-5-3-flash-low", swe_worker: "swe-2-medium" } },
      { ...initialModelSelection(), roles: { default: "glm-5-3-flash-low", swe_worker: "absent" } },
      { ...initialModelSelection(), enabledModels: ["glm-5-3-flash-low", "swe-2-medium", "other-medium"], roles: { default: "glm-5-3-flash-low", swe_worker: "other-medium" } },
      { ...initialModelSelection(), roles: { ...initialModelSelection().roles, permissions: "synthetic" } }];
    for (const state of invalid) expect(() => validateModelSelection(state)).toThrow();
  });
  test("oversized library selections cannot create a file the reader would reject", () => {
    const state = initialModelSelection();
    state.enabledModels.push(...Array.from({ length: 1500 }, (_, index) => `synthetic-${index}-${"x".repeat(230)}`));
    expect(() => validateModelSelection(state)).toThrow();
  });
});

describe("private atomic selection storage", () => {
  test("initializes once; recreation reloads exact saved settings and revised roles", async () => temporaryStore(async (store) => {
    const initial = await store.initialize();
    const next = { ...initial, enabledModels: [...initial.enabledModels, "future-model"], roles: { default: { modelId: "swe-2", effort: "medium" }, swe_worker: { modelId: "glm-5-3-flash-low", effort: "low" } } };
    const saved = await store.update(next, selectionETag(initial));
    expect(saved.revision).toBe(2);
    expect(await new ModelSelectionStore(store.directory).initialize()).toEqual(saved);
    expect(JSON.parse(await readFile(store.file, "utf8"))).toEqual(saved);
    expect(await readdir(store.directory)).toEqual(["model-selection.json"]);
  }));
  test("corrupt existing file fails closed without rewriting bytes", async () => temporaryStore(async (store) => {
    await store.initialize();
    const corrupt = "{synthetic-invalid-selection";
    await writeFile(store.file, corrupt);
    await expect(store.read()).rejects.toThrow("unavailable");
    await expect(new ModelSelectionStore(store.directory).initialize()).rejects.toThrow("unavailable");
    expect(await readFile(store.file, "utf8")).toBe(corrupt);
  }));
  test("well-formed but invalid persisted roles also fail closed", async () => temporaryStore(async (store) => {
    await store.initialize();
    await writeFile(store.file, JSON.stringify({ ...initialModelSelection(), roles: { default: "unvalidated", swe_worker: "swe-2-medium" } }));
    await expect(store.read()).rejects.toThrow("unavailable");
  }));
  test("optimistic concurrency rejects stale ETags and mismatched body revisions", async () => temporaryStore(async (store) => {
    const initial = await store.initialize();
    await expect(store.update(initial, '"wrong"')).rejects.toThrow("changed");
    await expect(store.update({ ...initial, revision: 2 }, selectionETag(initial))).rejects.toThrow("changed");
    const two = new ModelSelectionStore(store.directory);
    const results = await Promise.allSettled([store.update(initial, selectionETag(initial)), two.update(initial, selectionETag(initial))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await store.read()).revision).toBe(2);
  }));
  test("atomic readers see complete old/new JSON and rejected writes leave no temporary data", async () => temporaryStore(async (store) => {
    const initial = await store.initialize();
    const reads = Array.from({ length: 20 }, () => store.read());
    const next = await store.update({ ...initial, enabledModels: [...initial.enabledModels, "synthetic-extra"] }, selectionETag(initial));
    for (const row of await Promise.all(reads)) expect([initial.revision, next.revision]).toContain(row.revision);
    const bytes = await readFile(store.file, "utf8");
    await expect(store.update({ ...next, roles: {} }, selectionETag(next))).rejects.toThrow();
    expect(await readFile(store.file, "utf8")).toBe(bytes);
    expect(await readdir(store.directory)).toEqual(["model-selection.json"]);
  }));
  test("stale writer lock stops within a bounded interval without stealing it", async () => temporaryStore(async (store) => {
    await store.initialize();
    await mkdir(join(store.directory, ".selection-write.lock"));
    const bounded = new ModelSelectionStore(store.directory, 30);
    await expect(bounded.update(initialModelSelection(), selectionETag(initialModelSelection()))).rejects.toThrow("unavailable");
    expect((await stat(join(store.directory, ".selection-write.lock"))).isDirectory()).toBe(true);
  }));
  test("settings cannot overlap the auth directory", () => {
    const auth = join(tmpdir(), "synthetic-auth-directory");
    expect(() => new ModelSelectionStore(auth, 10, auth)).toThrow();
    expect(() => new ModelSelectionStore(join(auth, "settings"), 10, auth)).toThrow();
    expect(() => new ModelSelectionStore(join(auth, "..hidden-settings"), 10, auth)).toThrow();
    expect(() => new ModelSelectionStore(dirnameForTest(auth), 10, auth)).toThrow();
  });
  test.skipIf(process.platform === "win32")("Linux directories/files remain 0700/0600 after replacement", async () => temporaryStore(async (store) => {
    const state = await store.initialize();
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    await store.update(state, selectionETag(state));
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    await chmod(store.file, 0o644);
    await expect(store.read()).rejects.toThrow("unavailable");
  }));
});
function dirnameForTest(path: string): string { return join(path, ".."); }

describe("discovery representation and Codex manifest", () => {
  test("removed selected models remain unavailable; role never silently substitutes", () => {
    const state = initialModelSelection();
    const rows = adminModels([discovered("glm-5-3-flash-low")], state);
    expect(rows.find((row) => row.id === "swe-2-medium")?.available).toBe(false);
    expect(() => codexSelectionManifest(state, rows)).toThrow("no model was substituted");
    expect(state.roles.swe_worker).toEqual({ modelId: "swe-2", effort: "medium" });
  });
  test("unknown thinking models gain no efforts; explicit profiles pass through unchanged", () => {
    const state = initialModelSelection(); state.enabledModels.push("unknown-high");
    const rows = adminModels(state.enabledModels.map(discovered), state);
    expect(rows.at(-1)?.codex).toEqual({ status: "unvalidated", profile: null, exportEligible: false });
    const manifest = codexSelectionManifest(state, rows);
    expect(manifest.models.map((model) => [model.id, model.defaultReasoningEffort, model.supportedReasoningEfforts.map((r) => r.effort)])).toEqual([
      ["glm-5-3-flash-low", "low", ["low"]], ["swe-2", "medium", ["medium"]],
    ]);
    expect(manifest.excludedModels).toEqual([{ id: "unknown-high", reason: "unvalidated_profile" }]);
    expect(manifest.roles).toEqual({ default: { modelId: "glm-5-3-flash-low", reasoningEffort: "low", concreteModelId: "glm-5-3-flash-low" }, swe_worker: { modelId: "swe-2", reasoningEffort: "medium", concreteModelId: "swe-2-medium" } });
  });
  test("fallback limits and missing upstream thinking remain distinguishable", () => {
    const model = discovered("swe-2-medium");
    model.metadataProvenance.contextWindow = "fallback";
    model.metadataProvenance.upstreamThinking = "omitted";
    model.upstreamThinking = null;
    const row = adminModels([model], initialModelSelection())[0];
    expect(row.contextWindow).toBeNull(); expect(row.upstreamThinking).toBeNull(); expect(row.codex.exportEligible).toBe(false);
  });
  test("includeFuture enables new discovered IDs without assigning roles or profiles", () => {
    const state = initialModelSelection(); state.includeFutureModels = true;
    const rows = adminModels([...state.enabledModels, "future-new-low"].map(discovered), state);
    expect(rows.at(-1)?.enabled).toBe(true); expect(rows.at(-1)?.codex.profile).toBeNull();
    expect(codexSelectionManifest(state, rows).roles.swe_worker.modelId).toBe("swe-2");
  });
  test("export reconstructs allowlisted fields rather than forwarding unknown discovery content", () => {
    const data = initialModelSelection().enabledModels.map(discovered);
    Object.assign(data[0], { token: "SYNTHETIC_SECRET_SENTINEL", script: "SYNTHETIC_SCRIPT_SENTINEL", permission: "SYNTHETIC_PERMISSION_SENTINEL" });
    const json = JSON.stringify(codexSelectionManifest(initialModelSelection(), adminModels(data, initialModelSelection())));
    expect(json).not.toContain("SYNTHETIC_"); expect(json).not.toContain("instructions");
  });
});
