import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerOptions } from "../src/server.ts";
import { ProtoEncoder } from "../src/proto.ts";
import { discoverModelMetadata, discoverModels } from "../src/devin.ts";
import { initialModelSelection } from "../src/admin/model-selection.ts";
import { managementRequestAllowed } from "../src/admin/routes.ts";

function payload(ids: string[], detailed = true): Uint8Array {
  const encoder = new ProtoEncoder();
  for (const id of ids) encoder.message(1, (model) => {
    model.string(1, id === "swe-2-medium" ? "SWE-2 Medium" : id);
    model.string(22, id);
    if (detailed) {
      model.bool(5, true); model.uint32(18, 262_000);
      model.message(23, (info) => { info.uint32(13, 64_000); info.message(6, (features) => features.bool(15, true)); });
    }
  });
  return encoder.finish();
}
async function offlineGateway(options: ServerOptions) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port; await probe.stop();
  const signals = ["SIGINT", "SIGTERM"] as const;
  const before = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
  const handle = await startServer({ ...options, port });
  return { ...handle, stop: async () => {
    try { await handle.stop(); }
    finally { for (const signal of signals) for (const listener of process.listeners(signal)) if (!before.get(signal)!.has(listener)) process.removeListener(signal, listener); }
  } };
}
async function fixture(run: (context: { gateway: string; admin: string; directory: string; setModels: (ids: string[]) => void; setFailure: () => void }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gateway-selection-api-"));
  let response = payload(initialModelSelection().enabledModels);
  let failure = false;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return failure ? new Response("SYNTHETIC_UPSTREAM_SECRET", { status: 503 }) : new Response(response);
  } });
  const directory = join(root, "settings");
  const gateway = await offlineGateway({ host: "127.0.0.1", token: "synthetic-selection-token", baseUrl: upstream.url.origin, modelSelection: { directory, adminPort: 0 } });
  try {
    await run({ gateway: `http://127.0.0.1:${gateway.port}`, admin: `http://127.0.0.1:${gateway.adminPort}`, directory,
      setModels: (ids) => { response = payload(ids); }, setFailure: () => { failure = true; } });
  } finally { await gateway.stop(); await upstream.stop(true); await rm(root, { recursive: true, force: true }); }
}
const putHeaders = (etag: string) => ({ "content-type": "application/json", "x-devin-management": "1", "if-match": etag });

describe("admin discovery facts without changing legacy discovery", () => {
  test("protobuf facts have exact provenance while legacy discovery has only its old fields", async () => {
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(payload(["swe-2-medium", "unknown-low"])) });
    try {
      const detailed = await discoverModelMetadata("synthetic-token", backend.url.origin);
      expect(detailed[0].upstreamThinking).toBe(true);
      expect(detailed[0].metadataProvenance).toEqual({ id: "upstream", displayName: "upstream", contextWindow: "upstream", maxOutputTokens: "upstream", imageSupport: "upstream", upstreamThinking: "upstream", reasoning: "upstream_indicator_and_label_heuristic" });
      const legacy = await discoverModels("synthetic-token", backend.url.origin);
      expect(Object.keys(legacy[0]).sort()).toEqual(["contextWindow", "id", "maxTokens", "name", "reasoning", "supportsImages"]);
      expect(legacy[0].contextWindow).toBe(detailed[0].contextWindow);
    } finally { await backend.stop(true); }
  });
  test("label reasoning is not an upstream thinking fact and fallbacks are explicit", async () => {
    const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(payload(["unknown-medium"], false)) });
    try {
      const [model] = await discoverModelMetadata("synthetic-token", backend.url.origin);
      expect(model.reasoning).toBe(true); expect(model.upstreamThinking).toBeNull();
      expect(model.metadataProvenance.contextWindow).toBe("fallback");
      expect(model.metadataProvenance.maxOutputTokens).toBe("fallback");
      expect(model.metadataProvenance.imageSupport).toBe("omitted");
      expect(model.metadataProvenance.upstreamThinking).toBe("omitted");
    } finally { await backend.stop(true); }
  });
});

describe("isolated management routes and read-only Codex export", () => {
  test("initial migration exposes schema v2 and ETag; PUT revises atomically", async () => fixture(async ({ admin }) => {
    const response = await fetch(`${admin}/admin/api/model-selection`);
    const state = await response.json(); const etag = response.headers.get("etag")!;
    expect(state).toEqual(initialModelSelection()); expect(etag).toBe('"model-selection-v2-1"');
    const next = { ...state, enabledModels: [...state.enabledModels, "unknown-enabled"] };
    const saved = await fetch(`${admin}/admin/api/model-selection`, { method: "PUT", headers: putHeaders(etag), body: JSON.stringify(next) });
    expect(saved.status).toBe(200); expect(saved.headers.get("etag")).toBe('"model-selection-v2-2"');
    expect((await saved.json()).revision).toBe(2);
    const stale = await fetch(`${admin}/admin/api/model-selection`, { method: "PUT", headers: putHeaders(etag), body: JSON.stringify(next) });
    expect(stale.status).toBe(412);
  }));
  test("Codex export is allowlisted, fixed effort, credential-free and read-only", async () => fixture(async ({ gateway }) => {
    const response = await fetch(`${gateway}/gateway/api/codex-selection`);
    expect(response.status).toBe(200); expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response.json();
    expect(body.models.map((m: any) => [m.id, m.defaultReasoningEffort])).toEqual([["glm-5-3-flash-low", "low"], ["swe-2", "medium"]]);
    expect(body.roles.swe_worker).toEqual({ modelId: "swe-2", reasoningEffort: "medium", concreteModelId: "swe-2-medium" });
    expect(JSON.stringify(body)).not.toContain("synthetic-selection-token");
    for (const key of ["instructions", "scripts", "sandbox", "approval", "authorization", "cookie", "token"]) expect(Object.keys(body)).not.toContain(key);
    expect((await fetch(`${gateway}/gateway/api/codex-selection`, { method: "PUT", body: "synthetic" })).status).toBe(405);
  }));
  test("selected removed models persist as unavailable and block role export", async () => fixture(async ({ gateway, admin, setModels }) => {
    setModels(["glm-5-3-flash-low"]);
    const body = await (await fetch(`${admin}/admin/api/models`)).json();
    expect(body.models.find((m: any) => m.id === "swe-2-medium").available).toBe(false);
    expect((await fetch(`${gateway}/gateway/api/codex-selection`)).status).toBe(409);
    expect(await (await fetch(`${admin}/admin/api/model-selection`)).json()).toEqual(initialModelSelection());
  }));
  test("future inclusion requires all current models and never validates an unknown role", async () => fixture(async ({ admin, setModels }) => {
    setModels([...initialModelSelection().enabledModels, "future-unknown"]);
    const state = initialModelSelection();
    const partial = await fetch(`${admin}/admin/api/model-selection`, { method: "PUT", headers: putHeaders('"model-selection-v2-1"'), body: JSON.stringify({ ...state, includeFutureModels: true }) });
    expect(partial.status).toBe(400);
    const all = { ...state, enabledModels: [...state.enabledModels, "future-unknown"], includeFutureModels: true };
    expect((await fetch(`${admin}/admin/api/model-selection`, { method: "PUT", headers: putHeaders('"model-selection-v2-1"'), body: JSON.stringify(all) })).status).toBe(200);
    const invalidRole = { ...all, revision: 2, roles: { ...all.roles, swe_worker: "future-unknown" } };
    expect((await fetch(`${admin}/admin/api/model-selection`, { method: "PUT", headers: putHeaders('"model-selection-v2-2"'), body: JSON.stringify(invalidRole) })).status).toBe(400);
  }));
  test("management API never inherits inference CORS or appears on inference listener", async () => fixture(async ({ gateway, admin }) => {
    const denied = await fetch(`${gateway}/admin/api/model-selection`, { headers: { origin: "https://example.com" } });
    expect(denied.status).toBe(404); expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${admin}/admin/api/model-selection`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${admin}/admin/api/model-selection`, { headers: { host: "example.com" } })).status).toBe(403);
    const health = await fetch(`${gateway}/health`, { headers: { origin: "https://example.com" } });
    expect(health.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect((await health.json()).fallback_token).toBe("set");
  }));
  test("writes require JSON, explicit management header and exact current revision", async () => fixture(async ({ admin }) => {
    const url = `${admin}/admin/api/model-selection`;
    const body = JSON.stringify(initialModelSelection());
    expect((await fetch(url, { method: "PUT", body })).status).toBe(415);
    expect((await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body })).status).toBe(403);
    expect((await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "x-devin-management": "1" }, body })).status).toBe(428);
    expect((await fetch(url, { method: "PUT", headers: putHeaders('"model-selection-v2-1"'), body: "{invalid" })).status).toBe(400);
    expect((await fetch(url, { method: "PUT", headers: putHeaders('"model-selection-v2-1"'), body: "x".repeat(256 * 1024 + 1) })).status).toBe(400);
  }));
  test("corrupt storage and discovery failures are sanitized and never seed/fallback", async () => fixture(async ({ gateway, admin, directory, setFailure }) => {
    setFailure();
    const failed = await fetch(`${gateway}/gateway/api/codex-selection`);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("SYNTHETIC_UPSTREAM_SECRET");
    await writeFile(join(directory, "model-selection.json"), "SYNTHETIC_CORRUPT_FILE");
    const corrupt = await fetch(`${admin}/admin/api/model-selection`);
    expect(corrupt.status).toBe(503); expect(await corrupt.text()).not.toContain("SYNTHETIC_CORRUPT_FILE");
    expect(await readFile(join(directory, "model-selection.json"), "utf8")).toBe("SYNTHETIC_CORRUPT_FILE");
  }));
  test("legacy /v1/models response fields are unchanged", async () => fixture(async ({ gateway }) => {
    const response = await fetch(`${gateway}/v1/models`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.data[0]).sort()).toEqual(["context_window", "created", "id", "max_tokens", "object", "owned_by", "reasoning", "supports_images"]);
  }));
  test("Host/Origin guard rejects DNS rebinding and cross-site fetch metadata", () => {
    expect(managementRequestAllowed(new Request("http://127.0.0.1:1234/admin/api/models", { headers: { host: "127.0.0.1:1234" } }), 1234)).toBe(true);
    expect(managementRequestAllowed(new Request("http://127.0.0.1:1234/admin/api/models", { headers: { host: "127.0.0.1:1234", origin: "http://127.0.0.1:1234", "sec-fetch-site": "same-origin" } }), 1234)).toBe(true);
    expect(managementRequestAllowed(new Request("http://127.0.0.1:1234/admin/api/models", { headers: { host: "example.com:1234" } }), 1234)).toBe(false);
    expect(managementRequestAllowed(new Request("http://127.0.0.1:1234/admin/api/models", { headers: { host: "127.0.0.1:1234", "sec-fetch-site": "cross-site" } }), 1234)).toBe(false);
  });
  test("Docker published loopback authority is explicit and never trusts LAN or forwarded hosts", () => {
    const req = (host: string, origin?: string) => new Request("http://127.0.0.1:3001/admin/api/models", { headers: { host, ...(origin ? { origin } : {}) } });
    expect(managementRequestAllowed(req("127.0.0.1:38644", "http://127.0.0.1:38644"), 3001, 38644)).toBe(true);
    expect(managementRequestAllowed(req("localhost:38644", "http://localhost:38644"), 3001, 38644)).toBe(true);
    expect(managementRequestAllowed(req("127.0.0.1:38644"), 3001)).toBe(false);
    expect(managementRequestAllowed(req("192.0.2.1:38644"), 3001, 38644)).toBe(false);
    expect(managementRequestAllowed(req("127.0.0.1:38644", "https://example.com"), 3001, 38644)).toBe(false);
  });
  test("selection/admin routes are disabled by default", async () => {
    const gateway = await offlineGateway({ host: "127.0.0.1", token: "" });
    try { expect((await fetch(`http://127.0.0.1:${gateway.port}/gateway/api/codex-selection`)).status).toBe(404); expect(gateway.adminPort).toBeUndefined(); }
    finally { await gateway.stop(); }
  });
  test("gateway recreation reloads the saved settings directory without OAuth or reseeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-selection-recreation-"));
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(payload(initialModelSelection().enabledModels)) });
    const options = { host: "127.0.0.1", token: "synthetic-recreation-token", baseUrl: upstream.url.origin, modelSelection: { directory: join(root, "settings"), adminPort: 0 } };
    let gateway = await offlineGateway(options);
    try {
      const url = `http://127.0.0.1:${gateway.adminPort}/admin/api/model-selection`;
      const next = { ...initialModelSelection(), enabledModels: [...initialModelSelection().enabledModels, "saved-unknown"] };
      expect((await fetch(url, { method: "PUT", headers: putHeaders('"model-selection-v2-1"'), body: JSON.stringify(next) })).status).toBe(200);
      const before = await readFile(join(root, "settings/model-selection.json"), "utf8");
      await gateway.stop();
      gateway = await offlineGateway(options);
      const saved = await (await fetch(`http://127.0.0.1:${gateway.adminPort}/admin/api/model-selection`)).json();
      expect(saved.revision).toBe(2); expect(saved.enabledModels).toContain("saved-unknown");
      expect(await readFile(join(root, "settings/model-selection.json"), "utf8")).toBe(before);
    } finally { await gateway.stop(); await upstream.stop(true); await rm(root, { recursive: true, force: true }); }
  });
});
